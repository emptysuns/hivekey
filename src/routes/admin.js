'use strict';
const express = require('express');
const { request: undiciRequest } = require('undici');
const { getDispatcher, normalizeBaseUrl } = require('../proxy');

function createAdminRouter({ pool, store, stats, events, auth, config }) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  // Secure is appended when the request arrived over TLS (req.secure honors
  // X-Forwarded-Proto when TRUST_PROXY is set)
  const cookieOpts = (req) => `Path=/; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`;

  // ---------- auth ----------
  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const result = auth.login(username, password, req.ip || 'unknown');
    if (result === 'rate_limited') return res.status(429).json({ error: 'too many login attempts, try again later' });
    if (!result) return res.status(401).json({ error: 'invalid username or password' });
    res.setHeader('Set-Cookie', `pool_session=${encodeURIComponent(result.token)}; ${cookieOpts(req)}; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`);
    return res.json({ token: result.token, expiresAt: result.expiresAt, username: auth.adminUsername });
  });

  router.post('/auth/logout', (req, res) => {
    // bump the session generation so every outstanding token is invalidated,
    // not just this browser's cookie
    auth.revokeSessions();
    res.setHeader('Set-Cookie', `pool_session=; ${cookieOpts(req)}; Max-Age=0`);
    res.json({ ok: true });
  });

  // everything below requires an admin session
  router.use(auth.adminMiddleware());

  router.get('/auth/me', (req, res) => res.json({ username: req.adminUser }));

  // ---------- overview ----------
  router.get('/overview', (req, res) => {
    res.json({
      uptimeMs: Date.now() - stats.startedAt,
      totals: { ...stats.totals, inflight: stats.live.size },
      rpm: stats.rpm(),
      avgLatencyMs: stats.avgLatencyMs(),
      channelCount: store.data.channels.length,
      keyCounts: pool.keyCounts(),
      history: stats.history(),
    });
  });

  // ---------- channels ----------
  router.get('/channels', (req, res) => {
    res.json(store.data.channels.map((ch) => pool.serializeChannel(ch)));
  });

  router.post('/channels', (req, res) => {
    const ch = pool.createChannel(req.body || {});
    if (req.body?.keys) pool.addKeys(ch.id, req.body.keys);
    res.status(201).json(pool.serializeChannel(ch));
  });

  router.put('/channels/:id', (req, res) => {
    const ch = pool.updateChannel(req.params.id, req.body || {});
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    if (req.body?.keys) pool.addKeys(ch.id, req.body.keys);
    return res.json(pool.serializeChannel(ch));
  });

  router.delete('/channels/:id', (req, res) => {
    if (!pool.deleteChannel(req.params.id)) return res.status(404).json({ error: 'channel not found' });
    return res.json({ ok: true });
  });

  // ---------- keys ----------
  router.get('/channels/:id/keys', (req, res) => {
    if (!pool.channelsById.has(req.params.id)) return res.status(404).json({ error: 'channel not found' });
    const reveal = req.query.reveal === '1' || req.query.reveal === 'true';
    const keys = pool.keysByChannel.get(req.params.id) || [];
    return res.json(keys.map((k) => pool.serializeKey(k, reveal)));
  });

  router.post('/channels/:id/keys', (req, res) => {
    const result = pool.addKeys(req.params.id, req.body?.keys);
    if (!result) return res.status(404).json({ error: 'channel not found' });
    return res.json(result);
  });

  router.patch('/keys/:id', (req, res) => {
    const key = pool.setKeyEnabled(req.params.id, !!req.body?.enabled);
    if (!key) return res.status(404).json({ error: 'key not found' });
    return res.json(pool.serializeKey(key));
  });

  router.post('/keys/:id/reset', (req, res) => {
    const key = pool.resetKey(req.params.id);
    if (!key) return res.status(404).json({ error: 'key not found' });
    return res.json(pool.serializeKey(key));
  });

  router.post('/keys/:id/test', async (req, res) => {
    const key = pool.keysById.get(req.params.id);
    if (!key) return res.status(404).json({ error: 'key not found' });
    const channel = pool.channelsById.get(key.channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    const started = Date.now();
    try {
      const upstream = await undiciRequest(`${normalizeBaseUrl(channel.baseUrl)}/v1/models`, {
        method: 'GET',
        headers: {
          [(channel.keyHeader || 'Authorization').toLowerCase()]: `${channel.keyPrefix ?? 'Bearer '}${key.key}`,
          'accept-encoding': 'identity',
        },
        dispatcher: getDispatcher(channel.proxy || config.globalProxy, store.settings.connectTimeoutMs),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
      let snippet = '';
      for await (const chunk of upstream.body) {
        if (snippet.length < 500) snippet += chunk.toString('utf8');
      }
      const ok = upstream.statusCode >= 200 && upstream.statusCode < 300;
      return res.json({
        ok,
        statusCode: upstream.statusCode,
        latencyMs: Date.now() - started,
        error: ok ? undefined : snippet.slice(0, 300),
      });
    } catch (err) {
      return res.json({
        ok: false,
        statusCode: 0,
        latencyMs: Date.now() - started,
        error: `network error: ${err?.cause?.code || err?.code || err?.message || 'unknown'}`,
      });
    }
  });

  router.delete('/keys/:id', (req, res) => {
    if (!pool.deleteKey(req.params.id)) return res.status(404).json({ error: 'key not found' });
    return res.json({ ok: true });
  });

  router.post('/keys/batch-delete', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let deleted = 0;
    for (const id of ids) {
      if (pool.deleteKey(id)) deleted += 1;
    }
    return res.json({ deleted });
  });

  // ---------- access tokens ----------
  router.get('/tokens', (req, res) => res.json(store.data.tokens));

  router.post('/tokens', (req, res) => {
    res.status(201).json(auth.createAccessToken(req.body?.name));
  });

  router.patch('/tokens/:id', (req, res) => {
    const token = store.data.tokens.find((t) => t.id === req.params.id);
    if (!token) return res.status(404).json({ error: 'token not found' });
    token.enabled = !!req.body?.enabled;
    store.save();
    return res.json(token);
  });

  router.delete('/tokens/:id', (req, res) => {
    const before = store.data.tokens.length;
    store.data.tokens = store.data.tokens.filter((t) => t.id !== req.params.id);
    if (store.data.tokens.length === before) return res.status(404).json({ error: 'token not found' });
    store.save();
    return res.json({ ok: true });
  });

  // ---------- logs & live requests ----------
  router.get('/logs', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const { channelId, status } = req.query;
    const q = String(req.query.q || '').toLowerCase();
    let out = stats.logs;
    if (channelId) out = out.filter((l) => l.channelId === channelId);
    if (status === 'success' || status === 'error') out = out.filter((l) => l.status === status);
    if (q) {
      out = out.filter((l) =>
        [l.model, l.path, l.channelName, l.keyMasked, l.error]
          .some((f) => f && String(f).toLowerCase().includes(q)),
      );
    }
    res.json(out.slice(0, limit));
  });

  router.get('/requests/live', (req, res) => res.json(stats.liveList()));

  // ---------- settings ----------
  router.get('/settings', (req, res) => res.json(store.settings));
  router.put('/settings', (req, res) => res.json(store.updateSettings(req.body || {})));

  // ---------- SSE ----------
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify({
      overview: {
        uptimeMs: Date.now() - stats.startedAt,
        totals: { ...stats.totals, inflight: stats.live.size },
        rpm: stats.rpm(),
        avgLatencyMs: stats.avgLatencyMs(),
        channelCount: store.data.channels.length,
        keyCounts: pool.keyCounts(),
        history: stats.history(),
      },
      live: stats.liveList(),
    })}\n\n`);
    events.addClient(res);
  });

  // error handler (validation errors from pool sanitizers, bad JSON, etc.)
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    res.status(status).json({ error: err.message || 'internal error' });
  });

  return router;
}

module.exports = { createAdminRouter };
