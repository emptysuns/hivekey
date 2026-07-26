'use strict';
const { genId, maskKey, clamp } = require('./util');

/**
 * The pool: channels + keys registry, runtime key health state
 * (cooldowns, failure streaks, EWMA latency, in-flight counters).
 *
 * Key status model:
 *   - disabled: manually disabled, or auto-disabled after repeated failures
 *               (autoDisabled=true) — never selected until re-enabled/reset.
 *   - cooldown: temporarily benched (429 / errors), selected again after expiry.
 *   - active:   selectable.
 */
class Pool {
  constructor(store, events) {
    this.store = store;
    this.events = events;
    this.channelsById = new Map();
    this.keysById = new Map();
    this.keysByChannel = new Map(); // channelId -> Key[]
    this._rrCounter = 0;
    this._reindex();
    // runtime-only fields are not persisted; reset them on boot
    for (const key of this.store.data.keys) {
      key.inflight = 0;
      if (!key.stats) key.stats = this._emptyStats();
    }
  }

  _emptyStats() {
    return {
      requests: 0,
      success: 0,
      failed: 0,
      count429: 0,
      promptTokens: 0,
      completionTokens: 0,
      lastUsedAt: 0,
      lastError: null,
    };
  }

  _reindex() {
    this.channelsById.clear();
    this.keysById.clear();
    this.keysByChannel.clear();
    for (const ch of this.store.data.channels) this.channelsById.set(ch.id, ch);
    for (const key of this.store.data.keys) {
      this.keysById.set(key.id, key);
      let list = this.keysByChannel.get(key.channelId);
      if (!list) {
        list = [];
        this.keysByChannel.set(key.channelId, list);
      }
      list.push(key);
    }
  }

  // ---------- channels ----------

  createChannel(input) {
    const ch = this._sanitizeChannel(input, {
      id: genId('ch'),
      createdAt: Date.now(),
    });
    this.store.data.channels.push(ch);
    this.channelsById.set(ch.id, ch);
    this.keysByChannel.set(ch.id, []);
    this.store.save();
    return ch;
  }

  updateChannel(id, patch) {
    const ch = this.channelsById.get(id);
    if (!ch) return null;
    // sanitize into a copy first so a validation error can't leave the live
    // channel half-updated
    const updated = this._sanitizeChannel(patch, { ...ch }, true);
    Object.assign(ch, updated);
    this.store.save();
    return ch;
  }

  deleteChannel(id) {
    const ch = this.channelsById.get(id);
    if (!ch) return false;
    this.store.data.channels = this.store.data.channels.filter((c) => c.id !== id);
    this.store.data.keys = this.store.data.keys.filter((k) => k.channelId !== id);
    this._reindex();
    this.store.save();
    return true;
  }

  _sanitizeChannel(input, target = {}, isPatch = false) {
    const setIf = (field, fn) => {
      if (input[field] !== undefined) target[field] = fn(input[field]);
      else if (!isPatch && target[field] === undefined) target[field] = fn(undefined);
    };
    setIf('name', (v) => String(v ?? '').trim() || 'unnamed');
    setIf('baseUrl', (v) => {
      const s = String(v ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(s)) throw Object.assign(new Error('baseUrl must start with http:// or https://'), { status: 400 });
      return s;
    });
    setIf('proxy', (v) => {
      const s = String(v ?? '').trim();
      if (s && !/^https?:\/\//i.test(s)) {
        throw Object.assign(new Error('proxy must be an http(s):// URL (SOCKS is not supported)'), { status: 400 });
      }
      return s;
    });
    setIf('priority', (v) => clamp(parseInt(v, 10) || 0, -1000, 1000));
    setIf('weight', (v) => {
      const n = Number(v);
      return clamp(Number.isFinite(n) ? n : 1, 0.01, 1000);
    });
    setIf('models', (v) => {
      if (Array.isArray(v)) return v.map((m) => String(m).trim()).filter(Boolean);
      if (typeof v === 'string') return v.split(',').map((m) => m.trim()).filter(Boolean);
      return [];
    });
    setIf('modelMapping', (v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out = {};
        for (const [from, to] of Object.entries(v)) {
          if (typeof to === 'string' && to.trim()) out[String(from).trim()] = to.trim();
        }
        return out;
      }
      return {};
    });
    setIf('keyHeader', (v) => {
      const s = String(v ?? 'Authorization').trim() || 'Authorization';
      if (!/^[a-zA-Z0-9-]+$/.test(s)) throw Object.assign(new Error('invalid keyHeader'), { status: 400 });
      return s;
    });
    setIf('keyPrefix', (v) => (v === undefined ? 'Bearer ' : String(v ?? '')));
    setIf('enabled', (v) => (v === undefined ? true : !!v));
    return target;
  }

  // ---------- keys ----------

  /** Batch import. Accepts an array or a newline-separated string. */
  addKeys(channelId, keysInput) {
    const ch = this.channelsById.get(channelId);
    if (!ch) return null;
    let list = keysInput;
    if (typeof list === 'string') list = list.split(/\r?\n/);
    if (!Array.isArray(list)) list = [];
    const existing = new Set((this.keysByChannel.get(channelId) || []).map((k) => k.key));
    let added = 0;
    let skipped = 0;
    const seen = new Set();
    for (const raw of list) {
      const value = String(raw ?? '').trim();
      if (!value) continue;
      if (existing.has(value) || seen.has(value)) {
        skipped += 1;
        continue;
      }
      seen.add(value);
      const key = {
        id: genId('key'),
        channelId,
        key: value,
        enabled: true,
        autoDisabled: false,
        createdAt: Date.now(),
        cooldownUntil: 0,
        consecutiveFailures: 0,
        consecutive429: 0,
        consecutiveHard: 0,
        ewmaLatencyMs: 0,
        inflight: 0,
        stats: this._emptyStats(),
      };
      this.store.data.keys.push(key);
      this.keysById.set(key.id, key);
      let arr = this.keysByChannel.get(channelId);
      if (!arr) {
        arr = [];
        this.keysByChannel.set(channelId, arr);
      }
      arr.push(key);
      added += 1;
    }
    if (added) this.store.save();
    return { added, skipped };
  }

  deleteKey(id) {
    const key = this.keysById.get(id);
    if (!key) return false;
    this.store.data.keys = this.store.data.keys.filter((k) => k.id !== id);
    this._reindex();
    this.store.save();
    return true;
  }

  setKeyEnabled(id, enabled) {
    const key = this.keysById.get(id);
    if (!key) return null;
    key.enabled = !!enabled;
    if (enabled) key.autoDisabled = false;
    this.store.save();
    this._emitKey(key);
    return key;
  }

  resetKey(id) {
    const key = this.keysById.get(id);
    if (!key) return null;
    key.cooldownUntil = 0;
    key.consecutiveFailures = 0;
    key.consecutive429 = 0;
    key.consecutiveHard = 0;
    if (key.autoDisabled) {
      key.autoDisabled = false;
      key.enabled = true;
    }
    key.stats.lastError = null;
    this.store.save();
    this._emitKey(key);
    return key;
  }

  keyStatus(key, now = Date.now()) {
    if (!key.enabled) return 'disabled';
    if (key.cooldownUntil > now) return 'cooldown';
    return 'active';
  }

  // ---------- selection candidates ----------

  /**
   * Available (channel, key) pairs for a model, honoring channel priority tiers:
   * only the highest-priority tier that has any available key is returned.
   * `excludeKeyIds` removes keys already tried in this request.
   */
  candidates(model, excludeKeyIds = new Set()) {
    const now = Date.now();
    const channels = this.store.data.channels
      .filter((ch) => ch.enabled)
      .filter((ch) => !model || !ch.models?.length || ch.models.includes(model))
      .sort((a, b) => b.priority - a.priority);

    const tiers = new Map(); // priority -> [{channel, key}]
    for (const ch of channels) {
      const keys = this.keysByChannel.get(ch.id) || [];
      for (const key of keys) {
        if (excludeKeyIds.has(key.id)) continue;
        if (this.keyStatus(key, now) !== 'active') continue;
        let tier = tiers.get(ch.priority);
        if (!tier) {
          tier = [];
          tiers.set(ch.priority, tier);
        }
        tier.push({ channel: ch, key });
      }
    }
    const priorities = [...tiers.keys()].sort((a, b) => b - a);
    return priorities.length ? tiers.get(priorities[0]) : [];
  }

  nextRoundRobin() {
    this._rrCounter = (this._rrCounter + 1) % Number.MAX_SAFE_INTEGER;
    return this._rrCounter;
  }

  // ---------- outcome accounting ----------

  markSuccess(key, latencyMs, usage) {
    key.consecutiveFailures = 0;
    key.consecutive429 = 0;
    key.consecutiveHard = 0;
    key.stats.requests += 1;
    key.stats.success += 1;
    key.stats.lastUsedAt = Date.now();
    key.stats.lastError = null;
    if (usage) {
      key.stats.promptTokens += usage.promptTokens || 0;
      key.stats.completionTokens += usage.completionTokens || 0;
    }
    if (Number.isFinite(latencyMs)) {
      key.ewmaLatencyMs = key.ewmaLatencyMs
        ? Math.round(key.ewmaLatencyMs * 0.7 + latencyMs * 0.3)
        : Math.round(latencyMs);
    }
    if (key.cooldownUntil) {
      key.cooldownUntil = 0;
      this._emitKey(key);
    }
    this.store.save();
  }

  mark429(key, retryAfterMs) {
    const s = this.store.settings;
    key.consecutive429 += 1;
    key.stats.requests += 1;
    key.stats.failed += 1;
    key.stats.count429 += 1;
    key.stats.lastUsedAt = Date.now();
    key.stats.lastError = '429 rate limited';
    const backoff = s.cooldown429BaseMs * 2 ** Math.min(key.consecutive429 - 1, 5);
    // 1s floor wins over a misconfigured cooldownMaxMs below it
    const wait = Math.max(1000, Math.min(retryAfterMs ?? backoff, s.cooldownMaxMs));
    key.cooldownUntil = Date.now() + wait;
    this.store.save();
    this._emitKey(key);
  }

  /**
   * Non-429 failure. `hard` marks auth-style failures (401/403) that indicate
   * a bad key: two consecutive hard failures auto-disable it.
   */
  markError(key, message, { hard = false } = {}) {
    const s = this.store.settings;
    key.consecutiveFailures += 1;
    if (hard) key.consecutiveHard += 1;
    else key.consecutiveHard = 0;
    key.stats.requests += 1;
    key.stats.failed += 1;
    key.stats.lastUsedAt = Date.now();
    key.stats.lastError = String(message).slice(0, 300);
    if (hard && key.consecutiveHard >= 2) {
      key.enabled = false;
      key.autoDisabled = true;
    } else if (
      s.disableAfterConsecutiveFailures > 0 &&
      key.consecutiveFailures >= s.disableAfterConsecutiveFailures
    ) {
      key.enabled = false;
      key.autoDisabled = true;
    } else {
      const backoff = s.cooldownErrorBaseMs * 2 ** Math.min(key.consecutiveFailures - 1, 7);
      key.cooldownUntil = Date.now() + Math.max(1000, Math.min(backoff, s.cooldownMaxMs));
    }
    this.store.save();
    this._emitKey(key);
  }

  /**
   * Upstream returned a non-retryable client error (400/404/422…): the fault
   * is the caller's, so record the request but leave key health untouched.
   */
  markNeutralFailure(key, message) {
    key.stats.requests += 1;
    key.stats.failed += 1;
    key.stats.lastUsedAt = Date.now();
    key.stats.lastError = String(message).slice(0, 300);
    this.store.save();
  }

  _emitKey(key) {
    this.events.broadcast('keys', {
      channelId: key.channelId,
      keyId: key.id,
      status: this.keyStatus(key),
      cooldownUntil: key.cooldownUntil || 0,
      enabled: key.enabled,
    });
  }

  /** Emit `keys` events for cooldowns that expired since the last sweep. */
  sweepCooldowns() {
    const now = Date.now();
    for (const key of this.keysById.values()) {
      if (key.cooldownUntil && key.cooldownUntil <= now) {
        key.cooldownUntil = 0;
        this._emitKey(key);
      }
    }
  }

  // ---------- serialization ----------

  keyCounts() {
    const counts = { active: 0, cooldown: 0, disabled: 0 };
    const now = Date.now();
    for (const key of this.keysById.values()) counts[this.keyStatus(key, now)] += 1;
    return counts;
  }

  serializeChannel(ch) {
    const keys = this.keysByChannel.get(ch.id) || [];
    const now = Date.now();
    let requests = 0;
    let success = 0;
    let failed = 0;
    let latencySum = 0;
    let latencyN = 0;
    let active = 0;
    for (const k of keys) {
      requests += k.stats.requests;
      success += k.stats.success;
      failed += k.stats.failed;
      if (k.ewmaLatencyMs) {
        latencySum += k.ewmaLatencyMs;
        latencyN += 1;
      }
      if (this.keyStatus(k, now) === 'active') active += 1;
    }
    return {
      ...ch,
      keyCount: keys.length,
      activeKeyCount: active,
      stats: {
        requests,
        success,
        failed,
        avgLatencyMs: latencyN ? Math.round(latencySum / latencyN) : 0,
      },
    };
  }

  serializeKey(key, reveal = false) {
    return {
      id: key.id,
      channelId: key.channelId,
      key: reveal ? key.key : maskKey(key.key),
      enabled: key.enabled,
      autoDisabled: !!key.autoDisabled,
      status: this.keyStatus(key),
      cooldownUntil: key.cooldownUntil || 0,
      inflight: key.inflight || 0,
      createdAt: key.createdAt,
      stats: {
        ...key.stats,
        consecutiveFailures: key.consecutiveFailures,
        ewmaLatencyMs: key.ewmaLatencyMs,
      },
    };
  }
}

module.exports = { Pool };
