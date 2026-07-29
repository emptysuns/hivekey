'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Raw http.request helper for headers fetch() forbids (Expect, Content-Encoding…). */
function rawRequest({ port, method = 'POST', reqPath = '/v1/chat/completions', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const { createApp } = require('../src/index');
const { closeDispatchers } = require('../src/proxy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// mock upstream: behavior driven by the request's `model` field / API key
// ---------------------------------------------------------------------------
const upstreamState = { flakyCalls: 0 };

function sseWrite(res, frames) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let i = 0;
  const tick = () => {
    if (i >= frames.length) return res.end();
    res.write(frames[i]);
    i += 1;
    return setTimeout(tick, 5);
  };
  tick();
}

function createMockUpstream() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const key = auth.replace(/^Bearer\s+/i, '');
      const url = new URL(req.url, 'http://x');

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        if (key === 'invalid-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'bad key' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* ignore */
        }
        const { model } = body;

        if (key === 'invalid-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        }
        if (key === 'no-model-key') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'model not available for this key' } }));
        }
        if (model === 'always-429') {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' });
          return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
        }
        if (model === 'flaky') {
          upstreamState.flakyCalls += 1;
          if (upstreamState.flakyCalls % 2 === 1) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'flaky internal error' } }));
          }
        }
        if (body.stream) {
          return sseWrite(res, [
            'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5}}\n\n',
            'data: [DONE]\n\n',
          ]);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            model,
            servedByKey: key,
            gotContentEncoding: req.headers['content-encoding'] || null,
            gotExpect: req.headers.expect || null,
            usage: { prompt_tokens: 7, completion_tokens: 5 },
          }),
        );
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
let mockServer;
let appServer;
let appCtx;
let base; // pool base url
let mockBase;
let adminToken;
let poolToken; // client access token
let mainChannelId;

async function api(pathname, { method = 'GET', body, token = adminToken, raw = false } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  mockServer = createMockUpstream();
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${mockServer.address().port}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-pool-itest-'));
  appCtx = createApp({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'test-password-123',
    sessionSecret: 'integration-test-secret',
    bodyLimitBytes: 10_000,
  });
  appServer = appCtx.app.listen(0, '127.0.0.1');
  await new Promise((r) => appServer.on('listening', r));
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  appCtx.shutdown();
  mockServer.closeAllConnections?.();
  appServer.closeAllConnections?.();
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
  await closeDispatchers();
});

// ---------------------------------------------------------------------------
// tests (sequential, shared state)
// ---------------------------------------------------------------------------

test('health endpoint is public', async () => {
  const { status, json } = await api('/health', { token: null });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
});

test('admin API rejects unauthenticated and bad-credential requests', async () => {
  const noAuth = await api('/api/channels', { token: null });
  assert.strictEqual(noAuth.status, 401);

  const badLogin = await api('/api/auth/login', {
    method: 'POST',
    token: null,
    body: { username: 'admin', password: 'wrong' },
  });
  assert.strictEqual(badLogin.status, 401);
});

test('admin can log in', async () => {
  const { status, json } = await api('/api/auth/login', {
    method: 'POST',
    token: null,
    body: { username: 'admin', password: 'test-password-123' },
  });
  assert.strictEqual(status, 200);
  assert.ok(json.token);
  assert.strictEqual(json.username, 'admin');
  adminToken = json.token;

  const me = await api('/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.username, 'admin');
});

test('/v1 requires a pool access token by default', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'echo' }),
  });
  assert.strictEqual(res.status, 401);
});

test('admin can create an access token', async () => {
  const { status, json } = await api('/api/tokens', { method: 'POST', body: { name: 'itest' } });
  assert.strictEqual(status, 201);
  assert.ok(json.token.startsWith('sk-pool-'));
  poolToken = json.token;
});

test('channel creation with inline batch keys', async () => {
  const { status, json } = await api('/api/channels', {
    method: 'POST',
    body: {
      name: 'mock-main',
      baseUrl: `${mockBase}/v1/`,
      models: ['echo', 'flaky', 'stream-echo', 'big-model'],
      keys: 'good-key-1',
    },
  });
  assert.strictEqual(status, 201);
  assert.strictEqual(json.baseUrl, `${mockBase}/v1`); // trailing slash trimmed; /v1 suffix is stripped at request time
  assert.strictEqual(json.keyCount, 1);
  mainChannelId = json.id;

  const settings = await api('/api/settings', {
    method: 'PUT',
    body: { strategy: 'round_robin', maxAttempts: 2, cooldownErrorBaseMs: 1000 },
  });
  assert.strictEqual(settings.json.strategy, 'round_robin');
  assert.strictEqual(settings.json.maxAttempts, 2);
});

test('fetch-models: explicit baseUrl+key, channelId fallback, auth failure, bad url', async () => {
  const explicit = await api('/api/channels/fetch-models', {
    method: 'POST',
    body: { baseUrl: mockBase, key: 'good-key-1' },
  });
  assert.strictEqual(explicit.status, 200);
  assert.strictEqual(explicit.json.ok, true);
  assert.deepStrictEqual(explicit.json.models, ['mock-model']);

  // channelId only — server borrows the channel's baseUrl and one of its keys
  const viaChannel = await api('/api/channels/fetch-models', {
    method: 'POST',
    body: { channelId: mainChannelId },
  });
  assert.strictEqual(viaChannel.json.ok, true);
  assert.deepStrictEqual(viaChannel.json.models, ['mock-model']);

  const badKey = await api('/api/channels/fetch-models', {
    method: 'POST',
    body: { baseUrl: mockBase, key: 'invalid-key' },
  });
  assert.strictEqual(badKey.json.ok, false);
  assert.strictEqual(badKey.json.statusCode, 401);

  const badUrl = await api('/api/channels/fetch-models', {
    method: 'POST',
    body: { baseUrl: 'ftp://nope' },
  });
  assert.strictEqual(badUrl.status, 400);
});

test('proxies a simple completion and records usage', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'echo', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-pool-attempts'), '1');
  assert.strictEqual(res.headers.get('x-pool-channel'), 'mock-main');
  const body = await res.json();
  assert.strictEqual(body.servedByKey, 'good-key-1'); // upstream saw the real key
  assert.strictEqual(body.usage.completion_tokens, 5);

  const logs = await api('/api/logs?limit=5');
  const entry = logs.json[0];
  assert.strictEqual(entry.status, 'success');
  assert.strictEqual(entry.model, 'echo');
  assert.strictEqual(entry.promptTokens, 7);
  assert.strictEqual(entry.completionTokens, 5);
  assert.ok(!JSON.stringify(logs.json).includes('good-key-1'), 'logs must not leak full keys');
});

test('retries on 500 with a different key and succeeds', async () => {
  const imp = await api(`/api/channels/${mainChannelId}/keys`, {
    method: 'POST',
    body: { keys: 'good-key-2\ngood-key-1\n\n' },
  });
  assert.deepStrictEqual(imp.json, { added: 1, skipped: 1 });

  upstreamState.flakyCalls = 0;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'flaky' }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-pool-attempts'), '2');
  await res.json();

  const logs = await api('/api/logs?limit=1');
  const entry = logs.json[0];
  assert.strictEqual(entry.status, 'success');
  assert.strictEqual(entry.attempts, 2);
  assert.strictEqual(entry.retriesDetail.length, 1);
  assert.strictEqual(entry.retriesDetail[0].statusCode, 500);

  // the key that ate the 500 is cooling down
  const keys = await api(`/api/channels/${mainChannelId}/keys`);
  const cooling = keys.json.filter((k) => k.status === 'cooldown');
  assert.strictEqual(cooling.length, 1);
  assert.strictEqual(cooling[0].stats.consecutiveFailures, 1);
});

test('retries on 404 with a different key without cooling the first key down', async () => {
  const ch = await api('/api/channels', {
    method: 'POST',
    body: {
      name: 'mock-404-failover',
      baseUrl: mockBase,
      models: ['model-404-failover'],
      keys: 'no-model-key\ngood-key-404',
    },
  });
  await api('/api/settings', {
    method: 'PUT',
    body: { strategy: 'round_robin', maxAttempts: 3 },
  });

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'model-404-failover' }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-pool-attempts'), '2');
  await res.json();

  const logs = await api('/api/logs?limit=1');
  const entry = logs.json[0];
  assert.strictEqual(entry.status, 'success');
  assert.strictEqual(entry.attempts, 2);
  assert.strictEqual(entry.retriesDetail.length, 1);
  const keys = await api(`/api/channels/${ch.json.id}/keys?reveal=1`);
  const bad = keys.json.find((k) => k.key === 'no-model-key');
  assert.ok(bad);
  assert.strictEqual(bad.status, 'active', '404 must not put the key on cooldown');
  assert.strictEqual(bad.stats.consecutiveFailures || 0, 0);
  assert.strictEqual(bad.stats.failed, 1);
});

test('429 is passed through when no other key is available, and cools the key down', async () => {
  const ch = await api('/api/channels', {
    method: 'POST',
    body: { name: 'mock-429', baseUrl: mockBase, models: ['always-429'], keys: 'k429-only' },
  });
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'always-429' }),
  });
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get('x-pool-attempts'), '1');
  await res.json();

  const keys = await api(`/api/channels/${ch.json.id}/keys`);
  assert.strictEqual(keys.json[0].status, 'cooldown');
  assert.strictEqual(keys.json[0].stats.count429, 1);
  // upstream sent Retry-After: 2 → cooldown ≈ 2s, not the 30s default backoff
  const remaining = keys.json[0].cooldownUntil - Date.now();
  assert.ok(remaining > 500 && remaining < 3000, `retry-after honored, got ${remaining}ms`);

  // with the only matching key cooling down there is nothing to serve
  const res2 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'always-429' }),
  });
  assert.strictEqual(res2.status, 503);
  const err = await res2.json();
  assert.match(err.error.message, /no available upstream keys/);
});

test('keys returning 401 twice in a row are auto-disabled', async () => {
  const ch = await api('/api/channels', {
    method: 'POST',
    body: { name: 'mock-401', baseUrl: mockBase, models: ['auth-test'], keys: 'invalid-key' },
  });
  const hit = () =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
      body: JSON.stringify({ model: 'auth-test' }),
    });

  const r1 = await hit();
  assert.strictEqual(r1.status, 401);
  await r1.json();

  await sleep(1100); // wait out the 1s error cooldown so the key is selectable again
  const r2 = await hit();
  assert.strictEqual(r2.status, 401);
  await r2.json();

  const keys = await api(`/api/channels/${ch.json.id}/keys`);
  assert.strictEqual(keys.json[0].status, 'disabled');
  assert.strictEqual(keys.json[0].autoDisabled, true);

  // reset re-enables it
  const reset = await api(`/api/keys/${keys.json[0].id}/reset`, { method: 'POST' });
  assert.strictEqual(reset.json.status, 'active');
});

test('streams SSE responses through and extracts usage', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'stream-echo', stream: true }),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('"content":"hel"'));
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));

  const logs = await api('/api/logs?limit=1');
  assert.strictEqual(logs.json[0].stream, true);
  assert.strictEqual(logs.json[0].status, 'success');
  assert.strictEqual(logs.json[0].promptTokens, 7);
  assert.strictEqual(logs.json[0].completionTokens, 5);
});

test('GET /v1/models synthesizes the configured model list', async () => {
  const res = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${poolToken}` },
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes('echo'));
  assert.ok(ids.includes('always-429'));
});

test('per-key connectivity test endpoint', async () => {
  const keys = await api(`/api/channels/${mainChannelId}/keys`);
  const good = keys.json[0];
  const result = await api(`/api/keys/${good.id}/test`, { method: 'POST' });
  assert.strictEqual(result.json.ok, true);
  assert.strictEqual(result.json.statusCode, 200);
});

test('disabled access tokens are rejected; anonymous mode bypasses token auth', async () => {
  const tokens = await api('/api/tokens');
  const tok = tokens.json.find((t) => t.token === poolToken);
  await api(`/api/tokens/${tok.id}`, { method: 'PATCH', body: { enabled: false } });

  const rejected = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'echo' }),
  });
  assert.strictEqual(rejected.status, 401);

  await api('/api/settings', { method: 'PUT', body: { allowAnonymous: true } });
  const anon = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'echo' }),
  });
  assert.strictEqual(anon.status, 200);
  await anon.json();

  await api('/api/settings', { method: 'PUT', body: { allowAnonymous: false } });
  await api(`/api/tokens/${tok.id}`, { method: 'PATCH', body: { enabled: true } });
});

test('oversized bodies are rejected with 413', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'echo', padding: 'x'.repeat(20_000) }),
  });
  assert.strictEqual(res.status, 413);
});

test('SSE event stream requires auth and sends a snapshot', async () => {
  const unauth = await fetch(`${base}/api/events`);
  assert.strictEqual(unauth.status, 401);

  const controller = new AbortController();
  const res = await fetch(`${base}/api/events?token=${encodeURIComponent(adminToken)}`, {
    signal: controller.signal,
  });
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = Buffer.from(value).toString('utf8');
  assert.ok(text.startsWith('event: snapshot'), `got: ${text.slice(0, 40)}`);
  controller.abort();
});

test('overview reflects traffic', async () => {
  const { json } = await api('/api/overview');
  assert.ok(json.totals.requests >= 5);
  assert.ok(json.totals.success >= 3);
  assert.ok(json.totals.retries >= 1);
  assert.strictEqual(json.history.length, 60);
  assert.ok(json.keyCounts.active >= 1);
});

test('Expect: 100-continue is not forwarded upstream (undici rejects it)', async () => {
  const body = JSON.stringify({ model: 'echo', padding: 'x'.repeat(2000) });
  const res = await rawRequest({
    port: appServer.address().port,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      authorization: `Bearer ${poolToken}`,
      expect: '100-continue',
    },
    body,
  });
  assert.strictEqual(res.status, 200, `expected success, got ${res.status}: ${res.text.slice(0, 200)}`);
  assert.strictEqual(JSON.parse(res.text).gotExpect, null);
});

test('gzipped request bodies are inflated and the stale Content-Encoding is dropped', async () => {
  const gz = zlib.gzipSync(JSON.stringify({ model: 'echo', messages: [] }));
  const res = await rawRequest({
    port: appServer.address().port,
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': gz.length,
      authorization: `Bearer ${poolToken}`,
    },
    body: gz,
  });
  assert.strictEqual(res.status, 200, `expected success, got ${res.status}: ${res.text.slice(0, 200)}`);
  const parsed = JSON.parse(res.text);
  assert.strictEqual(parsed.model, 'echo'); // upstream could parse the body
  assert.strictEqual(parsed.gotContentEncoding, null);
});

test('absolute-form request targets are reduced to origin-form, not concatenated', async () => {
  const body = JSON.stringify({ model: 'echo' });
  const res = await rawRequest({
    port: appServer.address().port,
    reqPath: 'http://evil.example/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      authorization: `Bearer ${poolToken}`,
    },
    body,
  });
  // before the fix this produced a 502 and benched healthy keys
  assert.strictEqual(res.status, 200, `expected success, got ${res.status}: ${res.text.slice(0, 200)}`);
});

test('model names colliding with Object.prototype members pass through intact', async () => {
  // serve "constructor" from the main channel so the modelMapping code path runs
  await api(`/api/channels/${mainChannelId}`, {
    method: 'PUT',
    body: { models: ['echo', 'flaky', 'stream-echo', 'big-model', 'constructor'] },
  });
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'constructor' }),
  });
  assert.strictEqual(res.status, 200);
  const parsed = await res.json();
  // before the own-property guard, the model field was silently mangled to a
  // serialized Object.prototype member before reaching the upstream
  assert.strictEqual(parsed.model, 'constructor');
});

test('logout invalidates all outstanding admin sessions', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    token: null,
    body: { username: 'admin', password: 'test-password-123' },
  });
  const tempToken = login.json.token;
  const ok = await api('/api/auth/me', { token: tempToken });
  assert.strictEqual(ok.status, 200);

  await api('/api/auth/logout', { method: 'POST', token: tempToken });
  const afterLogout = await api('/api/auth/me', { token: tempToken });
  assert.strictEqual(afterLogout.status, 401, 'old session token must be rejected after logout');

  // log back in for any later tests
  const relogin = await api('/api/auth/login', {
    method: 'POST',
    token: null,
    body: { username: 'admin', password: 'test-password-123' },
  });
  adminToken = relogin.json.token;
});

test('query-string session tokens are only honored for the SSE endpoint', async () => {
  const viaQuery = await fetch(`${base}/api/channels?token=${encodeURIComponent(adminToken)}`);
  assert.strictEqual(viaQuery.status, 401);
  const sse = await fetch(`${base}/api/events?token=${encodeURIComponent(adminToken)}`, {
    signal: AbortSignal.timeout(2000),
  }).catch((e) => e);
  // events endpoint accepts it (stream opens, then our timeout aborts it)
  assert.ok(sse.status === 200 || sse.name === 'TimeoutError');
});

test('login rate limiting kicks in after repeated failures', async () => {
  let limited = false;
  for (let i = 0; i < 25; i += 1) {
    const r = await api('/api/auth/login', {
      method: 'POST',
      token: null,
      body: { username: 'admin', password: 'nope' },
    });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  assert.ok(limited, 'expected a 429 after repeated failed logins');
});
