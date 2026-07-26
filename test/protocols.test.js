'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/index');
const { closeDispatchers } = require('../src/proxy');

// ---------------------------------------------------------------------------
// mock OpenAI-compatible upstream
// ---------------------------------------------------------------------------

function createMockUpstream() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const key = auth.replace(/^Bearer\s+/i, '');
      const url = new URL(req.url, 'http://x');

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        if (key === 'bad-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'bad key' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* ignore */
        }
        if (key === 'bad-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        }
        const wantTools = Array.isArray(body.tools) && body.tools.length > 0;

        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const frames = [
            'data: {"choices":[{"delta":{"role":"assistant","content":"hel"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          ];
          if (wantTools) {
            frames.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_t1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n');
            frames.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]}}]}\n\n');
          }
          frames.push(`data: {"choices":[{"delta":{},"finish_reason":"${wantTools ? 'tool_calls' : 'stop'}"}]}\n\n`);
          frames.push('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5}}\n\n');
          frames.push('data: [DONE]\n\n');
          let i = 0;
          const tick = () => {
            if (i >= frames.length) return res.end();
            res.write(frames[i]);
            i += 1;
            return setTimeout(tick, 4);
          };
          return tick();
        }

        const message = wantTools
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_t1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] }
          : { role: 'assistant', content: `echo:${JSON.stringify(body.messages)}` };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message, finish_reason: wantTools ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let mockServer;
let appServer;
let appCtx;
let base;
let mockBase;
let adminToken;
let poolToken;
let channelId;

async function api(pathname, { method = 'GET', body, token = adminToken } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  mockServer = createMockUpstream();
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${mockServer.address().port}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-pool-ptest-'));
  appCtx = createApp({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'test-password-123',
    sessionSecret: 'protocol-test-secret',
  });
  appServer = appCtx.app.listen(0, '127.0.0.1');
  await new Promise((r) => appServer.on('listening', r));
  base = `http://127.0.0.1:${appServer.address().port}`;

  const login = await api('/api/auth/login', {
    method: 'POST',
    token: null,
    body: { username: 'admin', password: 'test-password-123' },
  });
  adminToken = login.json.token;
  poolToken = (await api('/api/tokens', { method: 'POST', body: { name: 'ptest' } })).json.token;
  const ch = await api('/api/channels', {
    method: 'POST',
    body: {
      name: 'mock-upstream',
      baseUrl: mockBase,
      models: ['claude-test', 'gpt-test', 'gemini-test', 'wild-*'],
      keys: 'good-key-1',
    },
  });
  channelId = ch.json.id;
});

after(async () => {
  appCtx.shutdown();
  mockServer.closeAllConnections?.();
  appServer.closeAllConnections?.();
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
  await closeDispatchers();
});

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

test('POST /v1/messages (non-stream) answers in Anthropic shape', async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': poolToken, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      system: 'be nice',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.type, 'message');
  assert.strictEqual(body.role, 'assistant');
  assert.strictEqual(body.model, 'claude-test');
  assert.strictEqual(body.content[0].type, 'text');
  assert.match(body.content[0].text, /^echo:/);
  assert.match(body.content[0].text, /be nice/); // system made it upstream
  assert.strictEqual(body.stop_reason, 'end_turn');
  assert.deepStrictEqual(body.usage, { input_tokens: 7, output_tokens: 5 });

  const logs = await api('/api/logs?limit=1');
  assert.strictEqual(logs.json[0].api, 'anthropic');
  assert.strictEqual(logs.json[0].path, '/v1/messages');
  assert.strictEqual(logs.json[0].status, 'success');
  assert.strictEqual(logs.json[0].promptTokens, 7);
  assert.ok(Number.isFinite(logs.json[0].ttftMs), 'ttft recorded');
  assert.ok(logs.json[0].tokensPerSec > 0, 'throughput recorded');
});

test('POST /v1/messages (stream) emits Anthropic SSE events', async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': poolToken },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('event: message_start'));
  assert.ok(text.includes('"type":"text_delta","text":"hel"'));
  assert.ok(text.includes('"type":"text_delta","text":"lo"'));
  assert.ok(text.includes('event: message_delta'));
  assert.ok(text.includes('"output_tokens":5'));
  assert.ok(text.trimEnd().endsWith('data: {"type":"message_stop"}'));
});

test('POST /v1/messages with tools returns tool_use blocks', async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': poolToken },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }],
    }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const tool = body.content.find((b) => b.type === 'tool_use');
  assert.ok(tool, 'tool_use block present');
  assert.strictEqual(tool.name, 'get_weather');
  assert.deepStrictEqual(tool.input, { city: 'SF' });
  assert.strictEqual(body.stop_reason, 'tool_use');
});

test('POST /v1/messages/count_tokens answers locally', async () => {
  const res = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': poolToken },
    body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'x'.repeat(400) }] }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.input_tokens > 50 && body.input_tokens < 200, `got ${body.input_tokens}`);
});

test('Anthropic-shaped errors come back for bad requests', async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': poolToken },
    body: JSON.stringify({ messages: [] }), // model missing
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.type, 'error');
  assert.strictEqual(body.error.type, 'invalid_request_error');
});

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

test('POST /v1/responses (non-stream) answers in Responses shape', async () => {
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'gpt-test', input: 'ping', instructions: 'be terse' }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.object, 'response');
  assert.strictEqual(body.status, 'completed');
  const msg = body.output.find((o) => o.type === 'message');
  assert.strictEqual(msg.content[0].type, 'output_text');
  assert.match(msg.content[0].text, /^echo:/);
  assert.strictEqual(body.usage.input_tokens, 7);
  assert.strictEqual(body.usage.output_tokens, 5);
});

test('POST /v1/responses (stream) emits typed Responses events', async () => {
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'gpt-test', input: 'ping', stream: true }),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('event: response.created'));
  assert.ok(text.includes('event: response.output_text.delta'));
  assert.ok(text.includes('event: response.completed'));
  assert.ok(text.includes('"sequence_number":0'));
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

test('POST /v1beta …:generateContent with ?key= auth answers in Gemini shape', async () => {
  const res = await fetch(`${base}/v1beta/models/gemini-test:generateContent?key=${encodeURIComponent(poolToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hola' }] }] }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.candidates[0].content.role, 'model');
  assert.match(body.candidates[0].content.parts[0].text, /^echo:/);
  assert.strictEqual(body.candidates[0].finishReason, 'STOP');
  assert.strictEqual(body.usageMetadata.promptTokenCount, 7);
  assert.strictEqual(body.usageMetadata.candidatesTokenCount, 5);
});

test('POST /v1beta …:streamGenerateContent?alt=sse streams Gemini frames', async () => {
  const res = await fetch(`${base}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': poolToken },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hola' }] }] }),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  const frames = text.split('\r\n\r\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
  assert.ok(frames.length >= 2);
  const joined = frames.map((f) => f.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '').join('');
  assert.ok(joined.includes('hello'));
  assert.strictEqual(frames.at(-1).candidates[0].finishReason, 'STOP');
  assert.strictEqual(frames.at(-1).usageMetadata.candidatesTokenCount, 5);
});

test('GET /v1beta/models lists configured models in Gemini shape', async () => {
  const res = await fetch(`${base}/v1beta/models?key=${encodeURIComponent(poolToken)}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const names = body.models.map((m) => m.name);
  assert.ok(names.includes('models/gemini-test'));
  assert.ok(!names.some((n) => n.includes('*')), 'wildcard patterns are not listed');
});

// ---------------------------------------------------------------------------
// wildcard models, metrics, admin extensions
// ---------------------------------------------------------------------------

test('wildcard channel models serve prefixed model names', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'wild-777', messages: [] }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.model, 'wild-777');
});

test('key stats gain TTFT and throughput EWMAs; overview exposes averages and daily usage', async () => {
  const keys = await api(`/api/channels/${channelId}/keys`);
  const k = keys.json[0];
  assert.ok(k.stats.ewmaTtftMs > 0, `ewmaTtftMs ${k.stats.ewmaTtftMs}`);
  assert.ok(k.stats.ewmaTps > 0, `ewmaTps ${k.stats.ewmaTps}`);

  const ov = await api('/api/overview');
  assert.ok(ov.json.avgTtftMs >= 0);
  assert.ok(ov.json.avgTps > 0);
  assert.strictEqual(ov.json.daily.length, 14);
  const today = ov.json.daily.at(-1);
  assert.ok(today.requests >= 5);
  assert.ok(today.promptTokens > 0);
});

test('settings accept the new scheduling strategies', async () => {
  for (const strategy of ['lowest_ttft', 'highest_throughput', 'adaptive']) {
    const r = await api('/api/settings', { method: 'PUT', body: { strategy } });
    assert.strictEqual(r.json.strategy, strategy);
  }
});

test('bulk key test reports per-key results without mutating state', async () => {
  await api(`/api/channels/${channelId}/keys`, { method: 'POST', body: { keys: 'bad-key' } });
  const r = await api(`/api/channels/${channelId}/test-keys`, { method: 'POST', body: {} });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.total, 2);
  assert.strictEqual(r.json.ok, 1);
  assert.strictEqual(r.json.failed, 1);
  const bad = r.json.results.find((x) => !x.ok);
  assert.strictEqual(bad.statusCode, 401);
  assert.ok(!JSON.stringify(r.json).includes('bad-key"'), 'raw key material must not leak (masked only)');

  // testing must not change enabled/cooldown state
  const keys = await api(`/api/channels/${channelId}/keys`);
  assert.ok(keys.json.every((k) => k.status === 'active'));
});

test('export → delete → import(merge) restores channels, keys and tokens', async () => {
  const exported = await api('/api/export');
  assert.strictEqual(exported.status, 200);
  assert.strictEqual(exported.json.version, 1);
  assert.ok(exported.json.keys.length >= 2);
  assert.ok(exported.json.keys.every((k) => k.inflight === undefined), 'runtime fields stripped');

  await api(`/api/channels/${channelId}`, { method: 'DELETE' });
  assert.strictEqual((await api('/api/channels')).json.length, 0);

  const imported = await api('/api/import', { method: 'POST', body: { data: exported.json, mode: 'merge' } });
  assert.strictEqual(imported.status, 200);
  assert.strictEqual(imported.json.channels, 1);
  assert.ok(imported.json.keys >= 2);

  const channels = await api('/api/channels');
  assert.strictEqual(channels.json.length, 1);
  assert.strictEqual(channels.json[0].id, channelId, 'channel id survives the round-trip');
  const keys = await api(`/api/channels/${channelId}/keys?reveal=1`);
  assert.ok(keys.json.some((k) => k.key === 'good-key-1'));

  // re-import is a no-op (all dupes)
  const again = await api('/api/import', { method: 'POST', body: { data: exported.json, mode: 'merge' } });
  assert.strictEqual(again.json.channels, 0);
  assert.strictEqual(again.json.keys, 0);

  // the pool still works after import (indexes rebuilt correctly)
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${poolToken}` },
    body: JSON.stringify({ model: 'gpt-test', messages: [] }),
  });
  assert.strictEqual(res.status, 200);
  await res.json();
});
