'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store');
const { Pool } = require('../src/pool');

const noopEvents = { broadcast() {} };

function freshPool(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-pool-test-'));
  const store = new Store(dir).load();
  Object.assign(store.data.settings, settings);
  return { pool: new Pool(store, noopEvents), store, dir };
}

let ctx;
beforeEach(() => {
  ctx = freshPool();
});

test('channel CRUD and validation', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'main', baseUrl: 'https://api.example.com/' });
  assert.strictEqual(ch.baseUrl, 'https://api.example.com');
  assert.strictEqual(ch.enabled, true);
  assert.strictEqual(ch.priority, 0);

  assert.throws(() => pool.createChannel({ name: 'bad', baseUrl: 'ftp://x' }), /baseUrl/);
  assert.throws(() => pool.createChannel({ name: 'bad', baseUrl: 'https://x', proxy: 'socks5://h:1' }), /proxy/);

  pool.updateChannel(ch.id, { priority: 5, models: 'gpt-4o, gpt-4o-mini' });
  assert.strictEqual(ch.priority, 5);
  assert.deepStrictEqual(ch.models, ['gpt-4o', 'gpt-4o-mini']);

  assert.ok(pool.deleteChannel(ch.id));
  assert.strictEqual(pool.candidates(null).length, 0);
});

test('batch key import trims, dedupes and skips blanks', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'c', baseUrl: 'https://x.test' });
  const r1 = pool.addKeys(ch.id, 'sk-a\n  sk-b  \n\nsk-a\r\nsk-c');
  assert.deepStrictEqual(r1, { added: 3, skipped: 1 });
  const r2 = pool.addKeys(ch.id, ['sk-b', 'sk-d']);
  assert.deepStrictEqual(r2, { added: 1, skipped: 1 });
});

test('candidates honors enabled flags, model whitelist and priority tiers', () => {
  const { pool } = ctx;
  const high = pool.createChannel({ name: 'high', baseUrl: 'https://h.test', priority: 10 });
  const low = pool.createChannel({ name: 'low', baseUrl: 'https://l.test', priority: 0 });
  const scoped = pool.createChannel({ name: 'scoped', baseUrl: 'https://s.test', priority: 10, models: ['special'] });
  pool.addKeys(high.id, 'hk1\nhk2');
  pool.addKeys(low.id, 'lk1');
  pool.addKeys(scoped.id, 'sk1');

  // top tier only: high + scoped are priority 10, but scoped only serves "special"
  assert.deepStrictEqual(pool.candidates('gpt-4o').map((c) => c.channel.name).sort(), ['high', 'high']);
  const special = pool.candidates('special').map((c) => c.channel.name).sort();
  assert.deepStrictEqual(special, ['high', 'high', 'scoped']);

  // when the whole top tier is excluded, fall through to lower priority
  const highKeys = pool.keysByChannel.get(high.id).map((k) => k.id);
  const excluded = new Set(highKeys);
  assert.deepStrictEqual(pool.candidates('gpt-4o', excluded).map((c) => c.channel.name), ['low']);

  // disabled channel disappears
  pool.updateChannel(high.id, { enabled: false });
  assert.deepStrictEqual(pool.candidates('gpt-4o').map((c) => c.channel.name), ['low']);
});

test('mark429 applies exponential cooldown and honors retry-after', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'c', baseUrl: 'https://x.test' });
  pool.addKeys(ch.id, 'k1');
  const key = pool.keysByChannel.get(ch.id)[0];

  pool.mark429(key, null);
  const first = key.cooldownUntil - Date.now();
  assert.ok(first > 25_000 && first <= 31_000, `first backoff ${first}`);
  assert.strictEqual(pool.keyStatus(key), 'cooldown');
  assert.strictEqual(pool.candidates(null).length, 0);

  pool.mark429(key, null);
  const second = key.cooldownUntil - Date.now();
  assert.ok(second > first * 1.5, `second backoff ${second} should be ~2x first`);

  pool.mark429(key, 5000);
  const explicit = key.cooldownUntil - Date.now();
  assert.ok(explicit > 3000 && explicit <= 5100, `explicit retry-after ${explicit}`);

  pool.markSuccess(key, 100);
  assert.strictEqual(key.consecutive429, 0);
  assert.strictEqual(pool.keyStatus(key), 'active');
});

test('markError backs off and auto-disables after the configured threshold', () => {
  const p2 = freshPool({ disableAfterConsecutiveFailures: 3 });
  const ch = p2.pool.createChannel({ name: 'c', baseUrl: 'https://x.test' });
  p2.pool.addKeys(ch.id, 'k1');
  const key = p2.pool.keysByChannel.get(ch.id)[0];

  p2.pool.markError(key, 'boom');
  assert.strictEqual(p2.pool.keyStatus(key), 'cooldown');
  key.cooldownUntil = 0;
  p2.pool.markError(key, 'boom');
  key.cooldownUntil = 0;
  p2.pool.markError(key, 'boom');
  assert.strictEqual(key.enabled, false);
  assert.strictEqual(key.autoDisabled, true);
  assert.strictEqual(p2.pool.keyStatus(key), 'disabled');

  const reset = p2.pool.resetKey(key.id);
  assert.strictEqual(reset.enabled, true);
  assert.strictEqual(p2.pool.keyStatus(key), 'active');
});

test('two consecutive hard failures (401/403) auto-disable a key', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'c', baseUrl: 'https://x.test' });
  pool.addKeys(ch.id, 'k1');
  const key = pool.keysByChannel.get(ch.id)[0];

  pool.markError(key, '401 invalid key', { hard: true });
  assert.strictEqual(key.enabled, true);
  pool.markError(key, '401 invalid key', { hard: true });
  assert.strictEqual(key.enabled, false);
  assert.strictEqual(key.autoDisabled, true);
});

test('store persists and reloads channels, keys and settings', () => {
  const { pool, store, dir } = ctx;
  const ch = pool.createChannel({ name: 'persisted', baseUrl: 'https://x.test' });
  pool.addKeys(ch.id, 'sk-persist');
  store.updateSettings({ strategy: 'round_robin', maxAttempts: 5 });
  store.saveNow();

  const store2 = new Store(dir).load();
  const pool2 = new Pool(store2, noopEvents);
  assert.strictEqual(store2.data.channels[0].name, 'persisted');
  assert.strictEqual(store2.data.keys[0].key, 'sk-persist');
  assert.strictEqual(store2.settings.strategy, 'round_robin');
  assert.strictEqual(store2.settings.maxAttempts, 5);
  assert.strictEqual(pool2.keysByChannel.get(ch.id).length, 1);
  // runtime state reset on reload
  assert.strictEqual(store2.data.keys[0].inflight, 0);
});

test('updateSettings rejects invalid values', () => {
  const { store } = ctx;
  store.updateSettings({ strategy: 'nonsense', maxAttempts: -5, retryOn: '429,500,999,abc' });
  assert.strictEqual(store.settings.strategy, 'adaptive');
  assert.strictEqual(store.settings.maxAttempts, 3);
  assert.deepStrictEqual(store.settings.retryOn, [429, 500]);
});

test('failed channel updates leave the channel untouched (atomicity)', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'atomic', baseUrl: 'https://x.test', priority: 3 });
  assert.throws(() => pool.updateChannel(ch.id, { priority: 9, baseUrl: 'ftp://bad' }), /baseUrl/);
  assert.strictEqual(ch.priority, 3, 'priority must not be applied when a later field fails validation');
  assert.strictEqual(ch.baseUrl, 'https://x.test');
});

test('weight 0 clamps to the 0.01 floor; keyPrefix null clears the prefix', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'w', baseUrl: 'https://x.test', weight: 0, keyPrefix: null });
  assert.strictEqual(ch.weight, 0.01);
  assert.strictEqual(ch.keyPrefix, '');
  pool.updateChannel(ch.id, { keyPrefix: 'Token ' });
  assert.strictEqual(ch.keyPrefix, 'Token ');
});

test('updateSettings enforces per-field minimums', () => {
  const { store } = ctx;
  store.updateSettings({ cooldownMaxMs: 0, maxAttempts: 0, requestTimeoutMs: 5 });
  assert.strictEqual(store.settings.cooldownMaxMs, 900_000, 'cooldownMaxMs below floor must be rejected');
  assert.strictEqual(store.settings.maxAttempts, 3);
  assert.strictEqual(store.settings.requestTimeoutMs, 300_000);
});

test('cooldown floor survives a hand-edited tiny cooldownMaxMs', () => {
  const p2 = freshPool();
  p2.store.data.settings.cooldownMaxMs = 0; // bypass validation, e.g. hand-edited data.json
  const ch = p2.pool.createChannel({ name: 'c', baseUrl: 'https://x.test' });
  p2.pool.addKeys(ch.id, 'k1');
  const key = p2.pool.keysByChannel.get(ch.id)[0];
  p2.pool.mark429(key, null);
  assert.ok(key.cooldownUntil - Date.now() >= 900, 'the 1s floor must win over cooldownMaxMs=0');
});

test('corrupted data.json is backed up and load() throws instead of wiping it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-pool-corrupt-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{"channels": [truncated');
  assert.throws(() => new Store(dir).load(), /cannot load .*data\.json/);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('data.json.corrupt-'));
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"channels": [truncated');

  // wrong-shape sections also refuse to load rather than silently resetting
  fs.writeFileSync(file, JSON.stringify({ channels: { not: 'an array' } }));
  assert.throws(() => new Store(dir).load(), /"channels" is not an array/);
});

test('problemKeys flags auto-disabled, failing and high-error-rate keys', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'c', baseUrl: 'https://x.test' });
  pool.addKeys(ch.id, 'sk-healthy\nsk-autodisabled\nsk-streak\nsk-errorrate');
  const [healthy, autoDis, streak, errRate] = pool.keysByChannel.get(ch.id);

  healthy.stats.requests = 100;
  healthy.stats.success = 99;
  healthy.stats.failed = 1;

  pool.markError(autoDis, '401 bad key', { hard: true });
  pool.markError(autoDis, '401 bad key', { hard: true });

  streak.consecutiveFailures = 4;

  errRate.stats.requests = 20;
  errRate.stats.failed = 12;

  const problems = pool.problemKeys();
  assert.deepStrictEqual(problems.map((p) => p.reason), ['auto_disabled', 'failing', 'high_error_rate']);
  assert.ok(!problems.some((p) => p.keyId === healthy.id));
  assert.ok(problems.every((p) => p.channelName === 'c'));
  assert.ok(!JSON.stringify(problems).includes('sk-autodisabled'), 'must not leak raw key material');

  // resetting the streaky key clears it from the report
  pool.resetKey(streak.id);
  assert.ok(!pool.problemKeys().some((p) => p.keyId === streak.id));
});

test('serializeKey masks key material by default', () => {
  const { pool } = ctx;
  const ch = pool.createChannel({ name: 'c', baseUrl: 'https://x.test' });
  pool.addKeys(ch.id, 'sk-supersecretvalue123');
  const key = pool.keysByChannel.get(ch.id)[0];
  assert.ok(!JSON.stringify(pool.serializeKey(key)).includes('supersecretvalue'));
  assert.strictEqual(pool.serializeKey(key, true).key, 'sk-supersecretvalue123');
});
