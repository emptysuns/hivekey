'use strict';
const path = require('path');

const env = process.env;

module.exports = {
  port: parseInt(env.PORT || '3000', 10),
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
  adminUsername: env.ADMIN_USERNAME || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '', // if empty, a random one is generated and persisted
  sessionSecret: env.SESSION_SECRET || '', // if empty, a random one is generated and persisted
  sessionTtlMs: parseInt(env.SESSION_TTL_MS || String(24 * 3600 * 1000), 10),
  bodyLimitBytes: parseInt(env.BODY_LIMIT_BYTES || String(25 * 1024 * 1024), 10),
  // number of reverse-proxy hops to trust for client IPs (0 = none).
  // Trusting a hop count (not `true`) keeps X-Forwarded-For unspoofable.
  trustProxy: (() => {
    const v = env.TRUST_PROXY;
    if (!v || v === '0' || v === 'false') return 0;
    if (v === 'true') return 1;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  })(),
  // Global fallback outbound proxy for channels that don't set their own.
  globalProxy: env.OUTBOUND_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '',
};
