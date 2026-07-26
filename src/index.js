'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const { Store } = require('./store');
const { Stats } = require('./stats');
const { EventHub } = require('./events');
const { Pool } = require('./pool');
const { Auth } = require('./auth');
const { createProxyHandler, closeDispatchers } = require('./proxy');
const { createAdminRouter } = require('./routes/admin');

function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const store = new Store(cfg.dataDir).load();
  const events = new EventHub();
  const stats = new Stats(() => store.settings.logLimit);
  const pool = new Pool(store, events);
  const auth = new Auth(store, cfg);

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

  app.get('/health', (req, res) => res.json({ ok: true, uptimeMs: Date.now() - stats.startedAt }));

  // ---------- the LLM endpoints (OpenAI passthrough + protocol adapters) ----------
  const proxyHandler = createProxyHandler({ pool, store, stats, events, config: cfg });

  // permissive CORS so browser-based clients can call the pool directly
  const corsMiddleware = (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || 'Authorization, Content-Type, X-Api-Key, X-Goog-Api-Key, Anthropic-Version',
    );
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };

  // model ids configured across enabled channels (wildcard patterns excluded)
  const configuredModels = () => {
    const configured = new Set();
    for (const ch of store.data.channels) {
      if (ch.enabled) {
        for (const m of ch.models || []) {
          if (!String(m).includes('*')) configured.add(m);
        }
      }
    }
    return [...configured].sort();
  };

  app.use(
    '/v1',
    corsMiddleware,
    auth.clientMiddleware(),
    express.raw({ type: () => true, limit: cfg.bodyLimitBytes }),
    (req, res, next) => {
      // synthesize /v1/models from configured channel model lists, if any
      if (req.method === 'GET' && (req.path === '/models' || req.path === '/models/')) {
        const models = configuredModels();
        if (models.length) {
          return res.json({
            object: 'list',
            data: models.map((id) => ({ id, object: 'model', owned_by: 'hivekey' })),
          });
        }
      }
      return next();
    },
    (req, res) => proxyHandler(req, res),
  );

  // Gemini-style endpoint (generateContent / streamGenerateContent / countTokens)
  app.use(
    '/v1beta',
    corsMiddleware,
    auth.clientMiddleware({ allowQueryKey: true }),
    express.raw({ type: () => true, limit: cfg.bodyLimitBytes }),
    (req, res, next) => {
      if (req.method === 'GET') {
        const geminiModel = (id) => ({
          name: `models/${id}`,
          displayName: id,
          description: 'served by hivekey',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        });
        if (req.path === '/models' || req.path === '/models/') {
          return res.json({ models: configuredModels().map(geminiModel) });
        }
        const single = /^\/models\/([^/:]+)$/.exec(req.path);
        if (single) {
          let id;
          try {
            id = decodeURIComponent(single[1]);
          } catch {
            id = single[1];
          }
          return res.json(geminiModel(id));
        }
      }
      return next();
    },
    (req, res) => proxyHandler(req, res),
  );

  // ---------- admin API + dashboard ----------
  app.use('/api', createAdminRouter({ pool, store, stats, events, auth, config: cfg }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // JSON error handler (body limit, etc.)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.destroy();
    const status = err.status || err.statusCode || 500;
    return res.status(status).json({ error: { message: err.message || 'internal error', type: 'pool_error' } });
  });

  // periodic housekeeping: cooldown expiry sweep + overview broadcast
  const sweepTimer = setInterval(() => {
    pool.sweepCooldowns();
    events.broadcast('overview', {
      totals: { ...stats.totals, inflight: stats.live.size },
      rpm: stats.rpm(),
      avgLatencyMs: stats.avgLatencyMs(),
      avgTtftMs: stats.avgTtftMs(),
      avgTps: stats.avgTps(),
      keyCounts: pool.keyCounts(),
      problemKeys: pool.problemKeys(),
    });
  }, 5000);
  sweepTimer.unref?.();

  const shutdown = () => {
    clearInterval(sweepTimer);
    events.close();
    try {
      store.saveNow();
    } catch (err) {
      console.error(`failed to persist on shutdown: ${err.message}`);
    }
    closeDispatchers();
  };

  return { app, store, stats, events, pool, auth, config: cfg, shutdown };
}

function main() {
  const { app, auth, shutdown } = createApp();

  const server = app.listen(config.port, config.host, () => {
    console.log(`hivekey listening on http://${config.host}:${config.port}`);
    console.log(`dashboard:     http://localhost:${config.port}/`);
    console.log(`llm endpoint:  http://localhost:${config.port}/v1`);
    console.log(`admin user:    ${auth.adminUsername}`);
    if (auth.generatedPassword) {
      console.log('');
      console.log('  ⚠ ADMIN_PASSWORD is not set. A random password was generated and persisted:');
      console.log(`  ⚠ admin password: ${auth.adminPassword}`);
      console.log('  ⚠ Set ADMIN_PASSWORD (and ADMIN_USERNAME) in the environment to override.');
      console.log('');
    }
  });

  const stop = (signal) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      shutdown();
      process.exit(0);
    });
    // force-exit if connections (e.g. SSE) keep the server open
    setTimeout(() => {
      shutdown();
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) main();

module.exports = { createApp };
