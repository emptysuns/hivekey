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

  // ---------- the LLM passthrough endpoint ----------
  const proxyHandler = createProxyHandler({ pool, store, stats, events, config: cfg });
  app.use(
    '/v1',
    (req, res, next) => {
      // permissive CORS so browser-based clients can call the pool directly
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    },
    auth.clientMiddleware(),
    express.raw({ type: () => true, limit: cfg.bodyLimitBytes }),
    (req, res, next) => {
      // synthesize /v1/models from configured channel model lists, if any
      if (req.method === 'GET' && (req.path === '/models' || req.path === '/models/')) {
        const configured = new Set();
        for (const ch of store.data.channels) {
          if (ch.enabled) for (const m of ch.models || []) configured.add(m);
        }
        if (configured.size) {
          return res.json({
            object: 'list',
            data: [...configured].sort().map((id) => ({ id, object: 'model', owned_by: 'hivekey' })),
          });
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
      keyCounts: pool.keyCounts(),
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
