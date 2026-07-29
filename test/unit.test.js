'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { selectCandidate } = require('../src/scheduler');
const { normalizeBaseUrl, createUsageScanner, describeThinking } = require('../src/proxy');
const { maskKey, parseRetryAfterMs, signSession, verifySession } = require('../src/util');

function cand(id, { weight = 1, inflight = 0, ewma = 0, requests = 0, success = 0 } = {}) {
  return {
    channel: { id: `ch_${id}`, name: id, weight },
    key: { id: `key_${id}`, inflight, ewmaLatencyMs: ewma, stats: { requests, success } },
  };
}

test('selectCandidate returns null for empty candidates', () => {
  assert.strictEqual(selectCandidate([], 'adaptive', { nextRoundRobin: () => 0 }), null);
});

test('round_robin cycles deterministically over sorted keys', () => {
  const cs = [cand('a'), cand('b'), cand('c')];
  let counter = 0;
  const pool = { nextRoundRobin: () => (counter += 1) };
  const picks = [1, 2, 3, 4, 5, 6].map(() => selectCandidate(cs, 'round_robin', pool).key.id);
  assert.deepStrictEqual(picks.slice(0, 3), picks.slice(3, 6));
  assert.strictEqual(new Set(picks).size, 3);
});

test('least_inflight picks the least busy key', () => {
  const cs = [cand('a', { inflight: 5 }), cand('b', { inflight: 1 }), cand('c', { inflight: 3 })];
  assert.strictEqual(selectCandidate(cs, 'least_inflight', {}).key.id, 'key_b');
});

test('lowest_latency picks lowest EWMA (unused keys first)', () => {
  const cs = [cand('a', { ewma: 900 }), cand('b', { ewma: 100 }), cand('c', { ewma: 500 })];
  assert.strictEqual(selectCandidate(cs, 'lowest_latency', {}).key.id, 'key_b');
  const withNew = [...cs, cand('new', { ewma: 0 })];
  assert.strictEqual(selectCandidate(withNew, 'lowest_latency', {}).key.id, 'key_new');
});

test('weighted respects channel weights statistically', () => {
  const cs = [cand('heavy', { weight: 9 }), cand('light', { weight: 1 })];
  let heavy = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (selectCandidate(cs, 'weighted', {}).key.id === 'key_heavy') heavy += 1;
  }
  assert.ok(heavy > 1600 && heavy < 1980, `expected ~90% heavy, got ${heavy / 2000}`);
});

test('adaptive strongly prefers healthy fast keys over failing slow ones', () => {
  const cs = [
    cand('good', { requests: 100, success: 99, ewma: 300 }),
    cand('bad', { requests: 100, success: 10, ewma: 4000 }),
  ];
  let good = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (selectCandidate(cs, 'adaptive', {}).key.id === 'key_good') good += 1;
  }
  assert.ok(good > 1700, `expected adaptive to mostly pick the good key, got ${good / 2000}`);
});

test('normalizeBaseUrl strips trailing slashes and /v1 suffix', () => {
  assert.strictEqual(normalizeBaseUrl('https://api.openai.com'), 'https://api.openai.com');
  assert.strictEqual(normalizeBaseUrl('https://api.openai.com/'), 'https://api.openai.com');
  assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com');
  assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com');
  assert.strictEqual(normalizeBaseUrl('https://host/openai/v1'), 'https://host/openai');
});

test('usage scanner parses JSON response usage', () => {
  const s = createUsageScanner('application/json; charset=utf-8');
  const body = JSON.stringify({ id: 'x', usage: { prompt_tokens: 12, completion_tokens: 34 } });
  s.feed(Buffer.from(body.slice(0, 10)));
  s.feed(Buffer.from(body.slice(10)));
  const u = s.result();
  assert.strictEqual(u.promptTokens, 12);
  assert.strictEqual(u.completionTokens, 34);
});

test('usage scanner parses SSE usage split across chunk boundaries', () => {
  const s = createUsageScanner('text/event-stream');
  const frames =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5}}\n\n' +
    'data: [DONE]\n\n';
  // feed in awkward 7-byte chunks to exercise line reassembly
  for (let i = 0; i < frames.length; i += 7) s.feed(Buffer.from(frames.slice(i, i + 7)));
  const u = s.result();
  assert.strictEqual(u.promptTokens, 7);
  assert.strictEqual(u.completionTokens, 5);
});

test('usage scanner handles anthropic-style input/output tokens', () => {
  const s = createUsageScanner('application/json');
  s.feed(Buffer.from(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 9 } })));
  const u = s.result();
  assert.strictEqual(u.promptTokens, 3);
  assert.strictEqual(u.completionTokens, 9);
});

test('describeThinking summarizes common effort knobs', () => {
  assert.strictEqual(describeThinking(null), null);
  assert.strictEqual(describeThinking({}), null);
  assert.strictEqual(describeThinking({ reasoning_effort: 'high' }), 'on effort=high');
  assert.strictEqual(describeThinking({ reasoning: { effort: 'low' } }), 'on effort=low');
  assert.strictEqual(describeThinking({ thinking: { type: 'enabled', budget_tokens: 2048 } }), 'on budget=2048');
  assert.strictEqual(describeThinking({ thinking: { type: 'disabled' } }), 'off');
  assert.strictEqual(describeThinking({ enable_thinking: true }), 'on');
  assert.strictEqual(describeThinking({ chat_template_kwargs: { enable_thinking: false } }), 'off');
  assert.strictEqual(
    describeThinking({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }),
    'off',
  );
  assert.strictEqual(
    describeThinking({ generation_config: { thinking_config: { thinking_level: 'high' } } }),
    'on level=high',
  );
});

test('maskKey hides the middle of keys', () => {
  assert.strictEqual(maskKey('sk-abcdefghijklmnop'), 'sk-abc…mnop');
  assert.ok(!maskKey('sk-abcdefghijklmnop').includes('defghijkl'));
  assert.strictEqual(maskKey(''), '');
});

test('parseRetryAfterMs handles seconds and dates', () => {
  assert.strictEqual(parseRetryAfterMs('30'), 30_000);
  assert.strictEqual(parseRetryAfterMs(undefined), null);
  assert.strictEqual(parseRetryAfterMs('nonsense'), null);
  const inTen = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfterMs(inTen);
  assert.ok(ms > 7000 && ms <= 11_000, `got ${ms}`);
});

test('session sign/verify round-trips and rejects tampering', () => {
  const token = signSession({ u: 'admin', exp: Date.now() + 10_000 }, 'secret');
  assert.strictEqual(verifySession(token, 'secret').u, 'admin');
  assert.strictEqual(verifySession(token, 'other-secret'), null);
  assert.strictEqual(verifySession(`${token}x`, 'secret'), null);
  const expired = signSession({ u: 'admin', exp: Date.now() - 1 }, 'secret');
  assert.strictEqual(verifySession(expired, 'secret'), null);
});
