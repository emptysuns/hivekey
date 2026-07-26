'use strict';

const HISTORY_MINUTES = 60;

/**
 * In-memory runtime metrics: totals, per-minute history buckets,
 * live (in-flight) request table and a finished-request ring buffer.
 */
class Stats {
  constructor(getLogLimit) {
    this.startedAt = Date.now();
    this.getLogLimit = typeof getLogLimit === 'function' ? getLogLimit : () => 1000;
    this.totals = {
      requests: 0,
      success: 0,
      failed: 0,
      retries: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
    this.live = new Map(); // requestId -> live entry
    this.logs = []; // newest first
    this.buckets = new Map(); // minuteTs -> {ts, requests, success, failed, latencySum, latencyCount}
    this.recentTs = []; // timestamps of finished requests in the last 5 minutes (for RPM)
  }

  _bucket(ts) {
    const minute = Math.floor(ts / 60_000) * 60_000;
    let b = this.buckets.get(minute);
    if (!b) {
      b = {
        ts: minute,
        requests: 0,
        success: 0,
        failed: 0,
        latencySum: 0,
        latencyCount: 0,
        ttftSum: 0,
        ttftCount: 0,
        tpsSum: 0,
        tpsCount: 0,
      };
      this.buckets.set(minute, b);
      // prune old buckets
      const cutoff = minute - HISTORY_MINUTES * 60_000;
      for (const k of this.buckets.keys()) {
        if (k < cutoff) this.buckets.delete(k);
      }
    }
    return b;
  }

  requestStarted(entry) {
    this.live.set(entry.id, entry);
  }

  requestFinished(logEntry) {
    this.live.delete(logEntry.id);
    const now = Date.now();
    this.totals.requests += 1;
    const ok = logEntry.status === 'success';
    if (ok) this.totals.success += 1;
    else this.totals.failed += 1;
    this.totals.retries += Math.max(0, (logEntry.attempts || 1) - 1);
    this.totals.promptTokens += logEntry.promptTokens || 0;
    this.totals.completionTokens += logEntry.completionTokens || 0;

    const b = this._bucket(now);
    b.requests += 1;
    if (ok) b.success += 1;
    else b.failed += 1;
    if (Number.isFinite(logEntry.latencyMs)) {
      b.latencySum += logEntry.latencyMs;
      b.latencyCount += 1;
    }
    if (ok && Number.isFinite(logEntry.ttftMs)) {
      b.ttftSum += logEntry.ttftMs;
      b.ttftCount += 1;
    }
    if (ok && Number.isFinite(logEntry.tokensPerSec) && logEntry.tokensPerSec > 0) {
      b.tpsSum += logEntry.tokensPerSec;
      b.tpsCount += 1;
    }

    this.recentTs.push(now);
    const cutoff = now - 300_000;
    while (this.recentTs.length && this.recentTs[0] < cutoff) this.recentTs.shift();

    this.logs.unshift(logEntry);
    const limit = Math.max(50, this.getLogLimit());
    if (this.logs.length > limit) this.logs.length = limit;
  }

  rpm() {
    const cutoff = Date.now() - 60_000;
    let i = this.recentTs.length - 1;
    let n = 0;
    while (i >= 0 && this.recentTs[i] >= cutoff) {
      n += 1;
      i -= 1;
    }
    return n;
  }

  _recentAvg(sumField, countField, round = (v) => Math.round(v)) {
    // weighted average over the last 5 minute-buckets
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    let sum = 0;
    let count = 0;
    for (let m = now - 4 * 60_000; m <= now; m += 60_000) {
      const b = this.buckets.get(m);
      if (b) {
        sum += b[sumField] || 0;
        count += b[countField] || 0;
      }
    }
    return count ? round(sum / count) : 0;
  }

  avgLatencyMs() {
    return this._recentAvg('latencySum', 'latencyCount');
  }

  avgTtftMs() {
    return this._recentAvg('ttftSum', 'ttftCount');
  }

  avgTps() {
    return this._recentAvg('tpsSum', 'tpsCount', (v) => Math.round(v * 10) / 10);
  }

  history() {
    const out = [];
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    for (let m = now - (HISTORY_MINUTES - 1) * 60_000; m <= now; m += 60_000) {
      const b = this.buckets.get(m);
      out.push({
        ts: m,
        requests: b ? b.requests : 0,
        success: b ? b.success : 0,
        failed: b ? b.failed : 0,
      });
    }
    return out;
  }

  liveList() {
    const now = Date.now();
    return [...this.live.values()].map((e) => ({ ...e, elapsedMs: now - e.ts }));
  }
}

module.exports = { Stats };
