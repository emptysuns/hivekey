'use strict';
const crypto = require('crypto');
const { timingSafeEqual, signSession, verifySession, genSecret, genId, genAccessToken } = require('./util');

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;

class Auth {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.loginAttempts = new Map(); // ip -> {count, resetAt}

    // resolve secrets/credentials, generating + persisting where needed
    const meta = store.data.meta;
    this.sessionSecret = config.sessionSecret || meta.sessionSecret;
    if (!this.sessionSecret) {
      this.sessionSecret = genSecret();
      meta.sessionSecret = this.sessionSecret;
      store.save();
    }
    this.adminUsername = config.adminUsername;
    this.adminPassword = config.adminPassword;
    this.generatedPassword = false;
    if (!this.adminPassword) {
      if (!meta.generatedAdminPassword) {
        meta.generatedAdminPassword = crypto.randomBytes(9).toString('base64url');
        store.save();
      }
      this.adminPassword = meta.generatedAdminPassword;
      this.generatedPassword = true;
    }

    // sessions carry a generation number; bumping it (logout, credential
    // change) invalidates every previously issued session token
    if (typeof meta.sessionGen !== 'number') meta.sessionGen = 0;
    const credHash = crypto
      .createHmac('sha256', this.sessionSecret)
      .update(`${this.adminUsername}\n${this.adminPassword}`)
      .digest('hex');
    if (meta.credHash !== credHash) {
      meta.credHash = credHash;
      meta.sessionGen += 1;
      store.save();
    }
  }

  revokeSessions() {
    this.store.data.meta.sessionGen += 1;
    this.store.save();
  }

  _pruneAttempts(now) {
    for (const [ip, rec] of this.loginAttempts) {
      if (rec.resetAt <= now) this.loginAttempts.delete(ip);
    }
  }

  /** Returns {token, expiresAt} or null (bad credentials) / 'rate_limited'. */
  login(username, password, ip) {
    const now = Date.now();
    this._pruneAttempts(now);
    let rec = this.loginAttempts.get(ip);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      this.loginAttempts.set(ip, rec);
    }
    if (rec.count >= LOGIN_MAX_ATTEMPTS) return 'rate_limited';
    rec.count += 1;

    const userOk = timingSafeEqual(username ?? '', this.adminUsername);
    const passOk = timingSafeEqual(password ?? '', this.adminPassword);
    if (!userOk || !passOk) return null;

    rec.count = 0;
    const expiresAt = now + this.config.sessionTtlMs;
    const token = signSession(
      { u: this.adminUsername, iat: now, exp: expiresAt, gen: this.store.data.meta.sessionGen },
      this.sessionSecret,
    );
    return { token, expiresAt };
  }

  sessionFromRequest(req, { allowQueryToken = false } = {}) {
    let token = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) token = header.slice(7);
    // query-string tokens end up in access logs/history — only EventSource
    // (which cannot set headers) is allowed to use them
    if (!token && allowQueryToken && req.query && typeof req.query.token === 'string') token = req.query.token;
    if (!token) {
      const cookie = req.headers.cookie;
      if (cookie) {
        for (const part of cookie.split(';')) {
          const [name, ...rest] = part.trim().split('=');
          if (name === 'pool_session') {
            token = decodeURIComponent(rest.join('='));
            break;
          }
        }
      }
    }
    if (!token) return null;
    const payload = verifySession(token, this.sessionSecret);
    if (!payload || payload.gen !== this.store.data.meta.sessionGen) return null;
    return payload;
  }

  /** Express middleware guarding admin APIs. */
  adminMiddleware() {
    return (req, res, next) => {
      const session = this.sessionFromRequest(req, { allowQueryToken: req.path === '/events' });
      if (!session) return res.status(401).json({ error: 'unauthorized' });
      req.adminUser = session.u;
      return next();
    };
  }

  // ---------- client access tokens (for the /v1 endpoint) ----------

  createAccessToken(name) {
    const token = {
      id: genId('tok'),
      name: String(name ?? '').trim() || 'unnamed',
      token: genAccessToken(),
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: 0,
      requests: 0,
    };
    this.store.data.tokens.push(token);
    this.store.save();
    return token;
  }

  /**
   * Middleware for the LLM endpoints: validates the pool access token unless
   * anonymous access is on. Tokens are accepted the way each SDK sends them:
   * Authorization: Bearer (OpenAI), x-api-key (Anthropic), x-goog-api-key /
   * ?key= (Gemini — query only where `allowQueryKey` is set).
   */
  clientMiddleware({ allowQueryKey = false } = {}) {
    return (req, res, next) => {
      if (this.store.settings.allowAnonymous) return next();
      let presented = null;
      const header = req.headers.authorization;
      if (header && header.startsWith('Bearer ')) presented = header.slice(7);
      if (!presented && typeof req.headers['x-api-key'] === 'string') presented = req.headers['x-api-key'];
      if (!presented && typeof req.headers['x-goog-api-key'] === 'string') presented = req.headers['x-goog-api-key'];
      if (!presented && allowQueryKey && req.query && typeof req.query.key === 'string') presented = req.query.key;
      if (!presented) {
        return res.status(401).json({
          error: { message: 'missing pool access token (Authorization: Bearer sk-pool-…)', type: 'invalid_request_error' },
        });
      }
      const record = this.store.data.tokens.find((t) => t.enabled && timingSafeEqual(t.token, presented));
      if (!record) {
        return res.status(401).json({
          error: { message: 'invalid or disabled pool access token', type: 'invalid_request_error' },
        });
      }
      record.lastUsedAt = Date.now();
      record.requests += 1;
      this.store.save();
      req.poolToken = record;
      return next();
    };
  }
}

module.exports = { Auth };
