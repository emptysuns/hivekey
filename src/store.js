'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  strategy: 'adaptive', // adaptive | round_robin | random | weighted | least_inflight | lowest_latency
  maxAttempts: 3,
  requestTimeoutMs: 300_000,
  connectTimeoutMs: 10_000,
  cooldown429BaseMs: 30_000,
  cooldownErrorBaseMs: 5_000,
  cooldownMaxMs: 900_000,
  disableAfterConsecutiveFailures: 8, // 0 = never auto-disable
  retryOn: [429, 401, 403, 500, 502, 503, 504],
  allowAnonymous: false,
  logLimit: 1000,
};

/**
 * JSON-file persistence with debounced atomic writes.
 * Holds channels, keys, access tokens, settings and meta (generated secrets).
 */
class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'data.json');
    this.data = {
      channels: [],
      keys: [],
      tokens: [],
      settings: { ...DEFAULT_SETTINGS },
      meta: {},
    };
    this._saveTimer = null;
    this._dirty = false;
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) return this;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('root is not an object');
      for (const k of ['channels', 'keys', 'tokens']) {
        if (raw[k] !== undefined && !Array.isArray(raw[k])) throw new Error(`"${k}" is not an array`);
      }
      for (const k of ['settings', 'meta']) {
        if (raw[k] !== undefined && (typeof raw[k] !== 'object' || raw[k] === null || Array.isArray(raw[k]))) {
          throw new Error(`"${k}" is not an object`);
        }
      }
    } catch (err) {
      // never silently overwrite a damaged file on the next save — back it up
      // and refuse to start
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        /* best effort */
      }
      throw new Error(
        `cannot load ${this.file}: ${err.message}. ` +
          `The damaged file was copied to ${backup}; fix or remove ${this.file} and restart.`,
      );
    }
    this.data.channels = raw.channels || [];
    this.data.keys = raw.keys || [];
    this.data.tokens = raw.tokens || [];
    this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
    this.data.meta = raw.meta || {};
    return this;
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    const MIN = {
      maxAttempts: 1,
      requestTimeoutMs: 1000,
      connectTimeoutMs: 100,
      cooldown429BaseMs: 1000,
      cooldownErrorBaseMs: 1000,
      cooldownMaxMs: 1000,
      disableAfterConsecutiveFailures: 0,
      logLimit: 50,
    };
    const s = this.data.settings;
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[k] === undefined) continue;
      if (k === 'strategy') {
        const allowed = ['adaptive', 'round_robin', 'random', 'weighted', 'least_inflight', 'lowest_latency'];
        if (allowed.includes(patch[k])) s[k] = patch[k];
      } else if (k === 'retryOn') {
        const arr = Array.isArray(patch[k]) ? patch[k] : String(patch[k]).split(',');
        s[k] = arr.map((v) => parseInt(v, 10)).filter((v) => v >= 400 && v <= 599);
      } else if (k === 'allowAnonymous') {
        s[k] = !!patch[k];
      } else {
        const n = parseInt(patch[k], 10);
        if (Number.isFinite(n) && n >= (MIN[k] ?? 0)) s[k] = n;
      }
    }
    this.save();
    return s;
  }

  /** Debounced save (atomic write via tmp file + rename). */
  save() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this.saveNow();
      } catch (err) {
        // a transient fs error (disk full, volume perms) must not crash the pool
        console.error(`failed to persist ${this.file}: ${err.message}`);
      }
    }, 1000);
    this._saveTimer.unref?.();
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirty) return;
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this._dirty = false; // only clear after a successful write so retries happen
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
