'use strict';
const crypto = require('crypto');

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function genAccessToken() {
  return `sk-pool-${crypto.randomBytes(24).toString('hex')}`;
}

function genSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 10) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // burn comparable time even on length mismatch
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySession(token, secret) {
  if (typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!timingSafeEqual(mac, expect)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a Retry-After header value into milliseconds, or null. */
function parseRetryAfterMs(value) {
  if (!value) return null;
  const s = Array.isArray(value) ? value[0] : String(value);
  const secs = Number(s);
  if (Number.isFinite(secs)) return clamp(secs, 0, 3600) * 1000;
  const date = Date.parse(s);
  if (!Number.isNaN(date)) return clamp(date - Date.now(), 0, 3600_000);
  return null;
}

module.exports = {
  genId,
  genAccessToken,
  genSecret,
  maskKey,
  timingSafeEqual,
  signSession,
  verifySession,
  clamp,
  toInt,
  parseRetryAfterMs,
};
