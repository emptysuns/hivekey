'use strict';

/**
 * Key-selection strategies. Each receives the candidate list produced by
 * Pool.candidates() — [{channel, key}] from the best available priority tier —
 * and returns one entry (or null).
 */

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function weightedRandom(list, weightOf) {
  let total = 0;
  const weights = list.map((c) => {
    const w = Math.max(weightOf(c), 0.0001);
    total += w;
    return w;
  });
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

function minBy(list, valueOf) {
  let best = [];
  let bestVal = Infinity;
  for (const c of list) {
    const v = valueOf(c);
    if (v < bestVal) {
      bestVal = v;
      best = [c];
    } else if (v === bestVal) {
      best.push(c);
    }
  }
  return best.length ? pickRandom(best) : null;
}

/**
 * Composite score for the adaptive strategy:
 *   success-rate (Laplace-smoothed, squared to punish flaky keys)
 * × speed factor (1 / (1 + first-token-latency/1s); falls back to headers ewma)
 * × throughput factor (1..3, rewards higher observed tokens/sec)
 * × in-flight penalty (1 / (1 + inflight))
 * × channel weight
 * Selection is weighted-random over scores, so newer/idle keys keep getting
 * explored instead of the single best key absorbing all traffic.
 */
function adaptiveScore({ channel, key }) {
  const req = key.stats.requests;
  const successRate = (key.stats.success + 1) / (req + 2);
  const firstTokenMs = key.ewmaTtftMs || key.ewmaLatencyMs || 0;
  const speedFactor = 1 / (1 + firstTokenMs / 1000);
  const throughputFactor = 1 + Math.min(key.ewmaTps || 0, 150) / 75;
  const inflightPenalty = 1 / (1 + (key.inflight || 0));
  return successRate * successRate * speedFactor * throughputFactor * inflightPenalty * (channel.weight || 1);
}

const strategies = {
  round_robin(candidates, pool) {
    const sorted = [...candidates].sort((a, b) => (a.key.id < b.key.id ? -1 : 1));
    return sorted[pool.nextRoundRobin() % sorted.length];
  },
  random(candidates) {
    return pickRandom(candidates);
  },
  weighted(candidates) {
    return weightedRandom(candidates, (c) => c.channel.weight || 1);
  },
  least_inflight(candidates) {
    return minBy(candidates, (c) => c.key.inflight || 0);
  },
  lowest_latency(candidates) {
    // unused keys have ewma 0 → they get tried first (built-in exploration)
    return minBy(candidates, (c) => c.key.ewmaLatencyMs || 0);
  },
  lowest_ttft(candidates) {
    // time-to-first-token; unused keys (0) explored first, headers ewma as fallback
    return minBy(candidates, (c) => c.key.ewmaTtftMs || c.key.ewmaLatencyMs || 0);
  },
  highest_throughput(candidates) {
    // max tokens/sec; keys with no throughput data yet explored first
    return minBy(candidates, (c) => -(c.key.ewmaTps || Infinity));
  },
  adaptive(candidates) {
    return weightedRandom(candidates, adaptiveScore);
  },
};

function selectCandidate(candidates, strategyName, pool) {
  if (!candidates.length) return null;
  const strategy = strategies[strategyName] || strategies.adaptive;
  return strategy(candidates, pool) || null;
}

module.exports = { selectCandidate, strategies, adaptiveScore };
