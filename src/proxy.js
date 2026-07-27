'use strict';
const { request: undiciRequest, Agent, ProxyAgent } = require('undici');
const { genId, maskKey, parseRetryAfterMs } = require('./util');
const { selectCandidate } = require('./scheduler');
const {
  detectRoute,
  estimateAnthropicTokens,
  estimateGeminiTokens,
  upstreamErrorMessage,
  createSseParser,
  simulateStream,
} = require('./adapters');
const log = require('./log');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const REQUEST_SKIP = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'authorization', // replaced with the upstream key
  'x-api-key',
  'x-goog-api-key',
  'anthropic-version', // inbound-protocol headers are meaningless upstream
  'anthropic-beta',
  'cookie',
  'accept-encoding', // forced to identity so usage can be parsed from responses
  'expect', // Node already answered the 100-continue handshake; undici rejects this header
  'content-encoding', // express.raw inflates gzip/deflate bodies, so the original header is stale
]);

const MAX_TRANSLATED_BODY = 16 * 1024 * 1024; // buffered-response cap for protocol translation

const dispatcherCache = new Map(); // `${proxy}|${connectTimeout}` -> dispatcher (LRU, bounded)
const MAX_DISPATCHERS = 16;

function getDispatcher(proxyUrl, connectTimeoutMs) {
  const cacheKey = `${proxyUrl || ''}|${connectTimeoutMs}`;
  let d = dispatcherCache.get(cacheKey);
  if (d) {
    // LRU bump
    dispatcherCache.delete(cacheKey);
    dispatcherCache.set(cacheKey, d);
    return d;
  }
  const opts = { connect: { timeout: connectTimeoutMs } };
  d = proxyUrl ? new ProxyAgent({ uri: proxyUrl, ...opts }) : new Agent(opts);
  dispatcherCache.set(cacheKey, d);
  if (dispatcherCache.size > MAX_DISPATCHERS) {
    const [oldKey, oldDispatcher] = dispatcherCache.entries().next().value;
    dispatcherCache.delete(oldKey);
    oldDispatcher.close().catch(() => {});
  }
  return d;
}

/** "https://host/v1/" and "https://host" both mean upstream root "https://host". */
function normalizeBaseUrl(baseUrl) {
  let s = String(baseUrl).trim().replace(/\/+$/, '');
  if (s.toLowerCase().endsWith('/v1')) s = s.slice(0, -3).replace(/\/+$/, '');
  return s;
}

function sanitizeHeaderValue(v) {
  return String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

/** Best-effort usage extraction from JSON bodies and SSE streams. */
function createUsageScanner(contentType) {
  const usage = { promptTokens: 0, completionTokens: 0, found: false };
  const ct = String(contentType || '').toLowerCase();
  const record = (u) => {
    if (!u || typeof u !== 'object') return;
    const p = u.prompt_tokens ?? u.input_tokens;
    const c = u.completion_tokens ?? u.output_tokens;
    if (Number.isFinite(p) || Number.isFinite(c)) {
      usage.promptTokens = Number.isFinite(p) ? p : usage.promptTokens;
      usage.completionTokens = Number.isFinite(c) ? c : usage.completionTokens;
      usage.found = true;
    }
  };

  if (ct.includes('application/json')) {
    const chunks = [];
    let size = 0;
    return {
      feed(chunk) {
        if (size > 1_048_576) return; // cap buffered JSON at 1 MB
        chunks.push(chunk);
        size += chunk.length;
      },
      result() {
        if (!chunks.length || size > 1_048_576) return usage;
        try {
          record(JSON.parse(Buffer.concat(chunks).toString('utf8')).usage);
        } catch {
          /* not parseable — fine */
        }
        return usage;
      },
    };
  }

  if (ct.includes('text/event-stream')) {
    let carry = '';
    return {
      feed(chunk) {
        carry += chunk.toString('utf8');
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        if (carry.length > 262_144) carry = ''; // pathological line, give up on it
        for (const line of lines) {
          if (!line.includes('"usage"') || !line.startsWith('data:')) continue;
          try {
            record(JSON.parse(line.slice(5).trim()).usage);
          } catch {
            /* partial or non-JSON data line */
          }
        }
      },
      result() {
        if (carry.includes('"usage"') && carry.startsWith('data:')) {
          try {
            record(JSON.parse(carry.slice(5).trim()).usage);
          } catch {
            /* ignore */
          }
        }
        return usage;
      },
    };
  }

  return { feed() {}, result: () => usage };
}

/** Read up to `limit` bytes of an error body for diagnostics, then discard the rest. */
async function readSnippet(body, limit = 2048) {
  let out = '';
  try {
    for await (const chunk of body) {
      if (out.length < limit) out += chunk.toString('utf8', 0, limit - out.length);
      // keep consuming to let the connection be reused
      if (out.length >= limit) {
        body.destroy?.();
        break;
      }
    }
  } catch {
    /* ignore */
  }
  return out.trim();
}

function jsonError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error: { message, type: 'pool_error' } });
}

function createProxyHandler({ pool, store, stats, events, config }) {
  return async function handleProxyRequest(req, res) {
    const settings = store.settings;
    const started = Date.now();
    let rawBody = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;

    // extract model / stream flag from JSON bodies for routing + logs
    let parsedBody = null;
    let model = null;
    let streamRequested = false;
    if (rawBody && String(req.headers['content-type'] || '').includes('json')) {
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
        if (typeof parsedBody?.model === 'string') model = parsedBody.model;
        streamRequested = !!parsedBody?.stream;
      } catch {
        /* non-JSON body, forward as-is */
      }
    }

    // req.originalUrl may be an absolute-form target (RFC 9112 §3.2.2); reduce it
    // to origin-form so a hostile target can't corrupt the outbound URL and get
    // the resulting failure charged against a key's health.
    let targetPath;
    let clientPathname;
    let clientQuery;
    try {
      const u = new URL(req.originalUrl || req.url, 'http://pool.invalid');
      targetPath = u.pathname + u.search;
      clientPathname = u.pathname;
      clientQuery = u.searchParams;
      if (!targetPath.startsWith('/v1')) throw new Error('outside /v1');
    } catch {
      return jsonError(res, 400, 'invalid request target');
    }

    // ----- inbound protocol translation (Anthropic / Responses / Gemini) -----
    const route = detectRoute(clientPathname);
    let adapter = null;
    let adapterCtx = null;

    const sendError = (status, message) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(status).json(adapter ? adapter.errorBody(status, message) : { error: { message, type: 'pool_error' } });
    };

    if (route) {
      adapter = route.adapter;
      // token counting is answered locally — no upstream call, no key spent
      if (route.action === 'count_tokens') {
        return res.json(estimateAnthropicTokens(parsedBody || {}));
      }
      if (route.action === 'countTokens') {
        return res.json(estimateGeminiTokens(parsedBody || {}));
      }
      if (!parsedBody) {
        return sendError(400, 'request body must be JSON');
      }
      try {
        const converted = adapter.name === 'gemini'
          ? adapter.toChat(parsedBody, { model: route.model, stream: route.action === 'streamGenerateContent' })
          : adapter.toChat(parsedBody);
        adapterCtx = {
          model: converted.model,
          stream: !!converted.stream,
          sse: adapter.name === 'gemini'
            ? String(clientQuery.get('alt') || '').toLowerCase() === 'sse'
            : true,
        };
        if (converted.stream) converted.stream_options = { include_usage: true };
        parsedBody = converted;
        model = converted.model;
        streamRequested = !!converted.stream;
        rawBody = Buffer.from(JSON.stringify(converted));
        targetPath = '/v1/chat/completions';
      } catch (err) {
        return sendError(err.status || 400, err.message || 'invalid request');
      }
    }

    const id = genId('req');
    const live = {
      id,
      ts: started,
      method: req.method,
      path: clientPathname,
      api: adapter ? adapter.name : 'openai',
      model,
      stream: streamRequested,
      channelId: null,
      channelName: null,
      keyId: null,
      keyMasked: null,
      attempts: 0,
    };
    stats.requestStarted(live);
    events.broadcast('request', { phase: 'start', entry: live });

    const tried = new Set();
    const retriesDetail = [];
    let clientGone = false;
    let finished = false;

    const finish = (fields) => {
      if (finished) return;
      finished = true;
      const entry = {
        id,
        ts: started,
        method: req.method,
        path: clientPathname,
        api: adapter ? adapter.name : 'openai',
        model,
        stream: streamRequested,
        channelId: live.channelId,
        channelName: live.channelName,
        keyId: live.keyId,
        keyMasked: live.keyMasked,
        attempts: live.attempts,
        latencyMs: Date.now() - started,
        ttftMs: null,
        tokensPerSec: null,
        retriesDetail,
        promptTokens: 0,
        completionTokens: 0,
        error: null,
        statusCode: 0,
        ...fields,
      };
      stats.requestFinished(entry);
      store.recordDaily(entry);
      events.broadcast('request', { phase: 'end', entry });
      const tag = `${entry.method} ${entry.path} model=${entry.model || '-'} ch=${entry.channelName || '-'} key=${entry.keyMasked || '-'} ${entry.latencyMs}ms #${entry.attempts}`;
      if (entry.status === 'success') {
        log.info(`ok  ${tag} ${entry.statusCode}${entry.stream ? ' stream' : ''}`);
      } else {
        log.error(`fail ${tag} ${entry.statusCode || ''} ${entry.error || 'error'}`.trim());
      }
    };

    res.on('close', () => {
      if (!res.writableEnded) clientGone = true;
    });

    const maxAttempts = Math.max(1, settings.maxAttempts);
    let lastFailure = null; // {statusCode, message}

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (clientGone) {
        finish({ status: 'error', error: 'client disconnected before completion' });
        return;
      }

      const candidates = pool.candidates(model, tried);
      const picked = selectCandidate(candidates, settings.strategy, pool);
      if (!picked) {
        const detail = lastFailure
          ? `last upstream failure: ${lastFailure.statusCode || ''} ${lastFailure.message || ''}`.trim()
          : 'no enabled channel/key matches this request';
        finish({ status: 'error', statusCode: 503, error: `no available upstream keys (${detail})` });
        sendError(503, `no available upstream keys for model "${model ?? 'unknown'}" — ${detail}`);
        return;
      }

      const { channel, key } = picked;
      tried.add(key.id);
      key.inflight = (key.inflight || 0) + 1;
      let inflightReleased = false;
      const release = () => {
        if (!inflightReleased) {
          inflightReleased = true;
          key.inflight = Math.max(0, (key.inflight || 1) - 1);
        }
      };

      live.attempts = attempt;
      live.channelId = channel.id;
      live.channelName = channel.name;
      live.keyId = key.id;
      live.keyMasked = maskKey(key.key);
      if (attempt > 1) events.broadcast('request', { phase: 'retry', entry: { ...live, elapsedMs: Date.now() - started } });

      // ----- build the outbound request -----
      const url = normalizeBaseUrl(channel.baseUrl) + targetPath;
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!REQUEST_SKIP.has(name.toLowerCase())) headers[name] = value;
      }
      headers['accept-encoding'] = 'identity';
      if (adapter) headers['content-type'] = 'application/json';
      headers[(channel.keyHeader || 'Authorization').toLowerCase()] = `${channel.keyPrefix ?? 'Bearer '}${key.key}`;

      let body = rawBody;
      // own-property guard: model names like "constructor" must not resolve
      // through Object.prototype
      const mappedModel =
        model &&
        channel.modelMapping &&
        Object.prototype.hasOwnProperty.call(channel.modelMapping, model) &&
        typeof channel.modelMapping[model] === 'string'
          ? channel.modelMapping[model]
          : null;
      if (mappedModel && parsedBody) {
        body = Buffer.from(JSON.stringify({ ...parsedBody, model: mappedModel }));
      }
      if (body) headers['content-length'] = String(body.length);

      const controller = new AbortController();
      const onClientClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClientClose);

      const attemptStarted = Date.now();
      let upstream;
      try {
        upstream = await undiciRequest(url, {
          method: adapter ? 'POST' : req.method,
          headers,
          body: body ?? undefined,
          dispatcher: getDispatcher(channel.proxy || config.globalProxy, settings.connectTimeoutMs),
          headersTimeout: settings.requestTimeoutMs,
          bodyTimeout: settings.requestTimeoutMs,
          maxRedirections: 0,
          signal: controller.signal,
        });
      } catch (err) {
        release();
        res.removeListener('close', onClientClose);
        if (clientGone) {
          finish({ status: 'error', error: 'client disconnected before completion' });
          return;
        }
        const message = `network error: ${err?.cause?.code || err?.code || err?.message || 'unknown'}`;
        pool.markError(key, message);
        lastFailure = { statusCode: 0, message };
        retriesDetail.push({ channelName: channel.name, keyMasked: live.keyMasked, statusCode: 0, error: message });
        if (attempt < maxAttempts) continue;
        finish({ status: 'error', statusCode: 502, error: message });
        sendError(502, `upstream request failed after ${attempt} attempt(s): ${message}`);
        return;
      }

      const { statusCode } = upstream;
      const headersLatency = Date.now() - attemptStarted;
      const retryable = settings.retryOn.includes(statusCode);
      const canRetryMore = attempt < maxAttempts && pool.candidates(model, tried).length > 0;

      const markFailureFor = (code, snippet) => {
        const message = `${code} ${snippet || ''}`.trim().slice(0, 300);
        if (code === 429) pool.mark429(key, parseRetryAfterMs(upstream.headers['retry-after']));
        else if (code === 401 || code === 403) pool.markError(key, message, { hard: true });
        else pool.markError(key, message);
        return message;
      };

      if (retryable && canRetryMore && !clientGone) {
        const snippet = await readSnippet(upstream.body);
        release();
        res.removeListener('close', onClientClose);
        const message = markFailureFor(statusCode, snippet);
        lastFailure = { statusCode, message };
        retriesDetail.push({ channelName: channel.name, keyMasked: live.keyMasked, statusCode, error: message });
        continue;
      }

      // ----- forward this response (success, non-retryable, or out of retries) -----
      const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
      const upstreamIsSse = contentType.includes('text/event-stream');
      const scanner = createUsageScanner(upstream.headers['content-type']);
      let firstByteAt = 0;
      const feedScanner = (chunk) => {
        if (!firstByteAt) firstByteAt = Date.now();
        scanner.feed(chunk);
      };

      let settled = false;
      const settle = (kind, errMessage) => {
        if (settled) return;
        settled = true;
        release();
        res.removeListener('close', onClientClose);
        const usage = scanner.result();
        if (kind === 'complete') {
          if (statusCode < 400) {
            const durationMs = Date.now() - attemptStarted;
            const ttftMs = firstByteAt ? firstByteAt - attemptStarted : headersLatency;
            const tps = usage.completionTokens > 0 && durationMs > 0
              ? Math.round((usage.completionTokens / (durationMs / 1000)) * 10) / 10
              : null;
            pool.markSuccess(key, { latencyMs: headersLatency, ttftMs, tps }, usage);
            finish({
              status: 'success',
              statusCode,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              ttftMs,
              tokensPerSec: tps,
            });
          } else {
            const snippet = errMessage || `upstream responded ${statusCode}`;
            let message;
            if (retryable) message = markFailureFor(statusCode, snippet);
            else {
              message = snippet;
              pool.markNeutralFailure(key, message);
            }
            lastFailure = { statusCode, message };
            finish({ status: 'error', statusCode, error: message });
          }
        } else if (kind === 'client_gone') {
          controller.abort();
          finish({ status: 'error', statusCode, error: 'client disconnected mid-response' });
        } else {
          pool.markError(key, errMessage || 'upstream stream error');
          finish({ status: 'error', statusCode, error: errMessage || 'upstream stream error' });
          if (res.headersSent) res.destroy();
          else sendError(502, errMessage || 'upstream stream error');
        }
      };

      if (!adapter) {
        // plain OpenAI passthrough — pipe bytes through untouched
        if (!res.headersSent) {
          res.status(statusCode);
          for (const [name, value] of Object.entries(upstream.headers)) {
            if (!HOP_BY_HOP.has(name.toLowerCase())) res.setHeader(name, value);
          }
          res.setHeader('x-pool-attempts', String(attempt));
          res.setHeader('x-pool-channel', sanitizeHeaderValue(channel.name));
          res.flushHeaders?.();
        }
        upstream.body.on('data', feedScanner);
        upstream.body.on('end', () => settle('complete'));
        upstream.body.on('error', (err) => settle('stream_error', `upstream stream error: ${err?.message || err}`));
        res.on('close', () => {
          if (!res.writableEnded) settle('client_gone');
        });
        upstream.body.pipe(res);
        return;
      }

      // ----- adapter: translate the upstream response into the caller's protocol -----
      if (!res.headersSent) {
        res.setHeader('x-pool-attempts', String(attempt));
        res.setHeader('x-pool-channel', sanitizeHeaderValue(channel.name));
      }

      const bufferBody = async () => {
        const chunks = [];
        let size = 0;
        for await (const chunk of upstream.body) {
          feedScanner(chunk);
          size += chunk.length;
          if (size > MAX_TRANSLATED_BODY) {
            upstream.body.destroy?.();
            throw new Error('upstream response too large to translate');
          }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
      };

      if (statusCode >= 400) {
        // error → protocol-shaped error body
        const snippet = await readSnippet(upstream.body, 4096);
        const message = upstreamErrorMessage(snippet, `upstream responded ${statusCode}`);
        if (!res.headersSent) res.status(statusCode).json(adapter.errorBody(statusCode, message));
        settle('complete', `${statusCode} ${message}`.slice(0, 300));
        return;
      }

      if (adapterCtx.stream) {
        const translator = adapter.createStream(adapterCtx, (s) => {
          if (!res.writableEnded) res.write(s);
        });
        if (!res.headersSent) {
          res.status(200);
          if (adapterCtx.sse) {
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('x-accel-buffering', 'no');
          } else {
            res.setHeader('content-type', 'application/json; charset=utf-8');
          }
          res.flushHeaders?.();
        }
        res.on('close', () => {
          if (!res.writableEnded) settle('client_gone');
        });
        if (upstreamIsSse) {
          const parser = createSseParser((obj) => translator.feed(obj));
          upstream.body.on('data', (chunk) => {
            feedScanner(chunk);
            try {
              parser.feed(chunk);
            } catch {
              /* a malformed frame must not kill the stream */
            }
          });
          upstream.body.on('end', () => {
            try {
              parser.end();
              translator.done();
            } catch {
              /* ignore */
            }
            if (!res.writableEnded) res.end();
            settle('complete');
          });
          upstream.body.on('error', (err) => settle('stream_error', `upstream stream error: ${err?.message || err}`));
        } else {
          // upstream ignored stream:true and answered with JSON — replay it as a stream
          let raw;
          try {
            raw = await bufferBody();
          } catch (err) {
            settle(clientGone ? 'client_gone' : 'stream_error', `upstream stream error: ${err?.message || err}`);
            return;
          }
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* handled below */
          }
          if (!parsed || typeof parsed !== 'object') {
            settle('stream_error', 'upstream returned invalid JSON');
            return;
          }
          try {
            simulateStream(parsed, translator);
          } catch {
            /* partial output is still better than a dead socket */
          }
          if (!res.writableEnded) res.end();
          settle('complete');
        }
        return;
      }

      // non-streaming: buffer the chat completion, convert, reply
      let raw;
      try {
        raw = await bufferBody();
      } catch (err) {
        settle(clientGone ? 'client_gone' : 'stream_error', `upstream stream error: ${err?.message || err}`);
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* handled below */
      }
      if (!parsed || typeof parsed !== 'object') {
        settle('stream_error', 'upstream returned invalid JSON');
        return;
      }
      if (!res.headersSent) res.status(200).json(adapter.fromChat(parsed, adapterCtx));
      settle('complete');
      return;
    }
  };
}

async function closeDispatchers() {
  for (const d of dispatcherCache.values()) {
    try {
      await d.close();
    } catch {
      /* ignore */
    }
  }
  dispatcherCache.clear();
}

module.exports = { createProxyHandler, normalizeBaseUrl, createUsageScanner, getDispatcher, readSnippet, closeDispatchers };
