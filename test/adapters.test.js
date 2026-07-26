'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  detectRoute,
  anthropicToChat,
  chatToAnthropic,
  responsesToChat,
  chatToResponses,
  geminiToChat,
  chatToGemini,
  anthropicAdapter,
  responsesAdapter,
  geminiAdapter,
  estimateAnthropicTokens,
  createSseParser,
  simulateStream,
  upstreamErrorMessage,
} = require('../src/adapters');
const { selectCandidate } = require('../src/scheduler');
const { Pool } = require('../src/pool');

/** Collect stream-translator output and split it into parsed SSE events. */
function sseCollector() {
  const chunks = [];
  return {
    write: (s) => chunks.push(s),
    text: () => chunks.join(''),
    events() {
      return chunks
        .join('')
        .split('\n\n')
        .filter((f) => f.trim())
        .map((frame) => {
          const ev = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7).trim();
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          return ev;
        });
    },
  };
}

// ---------------------------------------------------------------------------
// route detection
// ---------------------------------------------------------------------------

test('detectRoute maps protocol paths to adapters', () => {
  assert.strictEqual(detectRoute('/v1/messages').adapter.name, 'anthropic');
  assert.strictEqual(detectRoute('/v1/messages/count_tokens').action, 'count_tokens');
  assert.strictEqual(detectRoute('/v1/responses').adapter.name, 'responses');
  const g = detectRoute('/v1beta/models/gemini-2.0-flash:generateContent');
  assert.strictEqual(g.adapter.name, 'gemini');
  assert.strictEqual(g.model, 'gemini-2.0-flash');
  assert.strictEqual(g.action, 'generateContent');
  assert.strictEqual(detectRoute('/v1/models/gemini-pro:streamGenerateContent').action, 'streamGenerateContent');
  assert.strictEqual(detectRoute('/v1beta/models/gemini-pro:countTokens').action, 'countTokens');
  assert.strictEqual(detectRoute('/v1/chat/completions'), null);
  assert.strictEqual(detectRoute('/v1/models'), null);
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

test('anthropicToChat converts system, blocks, tools and params', () => {
  const out = anthropicToChat({
    model: 'claude-x',
    max_tokens: 100,
    temperature: 0.5,
    stop_sequences: ['END'],
    system: [{ type: 'text', text: 'be nice' }],
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'sunny' }] },
          { type: 'text', text: 'and tomorrow?' },
        ],
      },
    ],
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  });
  assert.strictEqual(out.model, 'claude-x');
  assert.strictEqual(out.max_tokens, 100);
  assert.strictEqual(out.temperature, 0.5);
  assert.deepStrictEqual(out.stop, ['END']);
  assert.deepStrictEqual(out.messages[0], { role: 'system', content: 'be nice' });
  assert.deepStrictEqual(out.messages[1], { role: 'user', content: 'hello' });
  assert.strictEqual(out.messages[2].role, 'assistant');
  assert.strictEqual(out.messages[2].content, 'let me check');
  assert.strictEqual(out.messages[2].tool_calls[0].function.name, 'get_weather');
  assert.deepStrictEqual(JSON.parse(out.messages[2].tool_calls[0].function.arguments), { city: 'SF' });
  assert.deepStrictEqual(out.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'sunny' });
  assert.deepStrictEqual(out.messages[4], { role: 'user', content: 'and tomorrow?' });
  assert.strictEqual(out.tools[0].function.name, 'get_weather');
  assert.strictEqual(out.tool_choice, 'required');
});

test('anthropicToChat validates required fields', () => {
  assert.throws(() => anthropicToChat({ messages: [] }), /"model" is required/);
  assert.throws(() => anthropicToChat({ model: 'x' }), /"messages" must be an array/);
});

test('chatToAnthropic maps text, tool calls, stop reason and usage', () => {
  const msg = chatToAnthropic(
    {
      choices: [{
        message: {
          content: 'hi there',
          tool_calls: [{ id: 'call_9', function: { name: 'sum', arguments: '{"a":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 22 },
    },
    { model: 'claude-x' },
  );
  assert.strictEqual(msg.type, 'message');
  assert.strictEqual(msg.model, 'claude-x');
  assert.deepStrictEqual(msg.content[0], { type: 'text', text: 'hi there' });
  assert.strictEqual(msg.content[1].type, 'tool_use');
  assert.strictEqual(msg.content[1].id, 'call_9');
  assert.deepStrictEqual(msg.content[1].input, { a: 1 });
  assert.strictEqual(msg.stop_reason, 'tool_use');
  assert.deepStrictEqual(msg.usage, { input_tokens: 11, output_tokens: 22 });
});

test('anthropic stream translator emits the canonical event sequence', () => {
  const col = sseCollector();
  const tr = anthropicAdapter.createStream({ model: 'claude-x' }, col.write);
  tr.feed({ choices: [{ delta: { content: 'hel' } }] });
  tr.feed({ choices: [{ delta: { content: 'lo' } }] });
  tr.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'sum', arguments: '{"a"' } }] } }] });
  tr.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] });
  tr.feed({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 9 } });
  tr.done();

  const events = col.events();
  const types = events.map((e) => e.event);
  assert.deepStrictEqual(types, [
    'message_start', 'ping',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  const textDeltas = events.filter((e) => e.data && e.data.delta && e.data.delta.type === 'text_delta');
  assert.strictEqual(textDeltas.map((e) => e.data.delta.text).join(''), 'hello');
  const toolStart = events.find((e) => e.data && e.data.content_block && e.data.content_block.type === 'tool_use');
  assert.strictEqual(toolStart.data.content_block.name, 'sum');
  const jsonDeltas = events.filter((e) => e.data && e.data.delta && e.data.delta.type === 'input_json_delta');
  assert.strictEqual(jsonDeltas.map((e) => e.data.delta.partial_json).join(''), '{"a":1}');
  const md = events.find((e) => e.event === 'message_delta');
  assert.strictEqual(md.data.delta.stop_reason, 'tool_use');
  assert.strictEqual(md.data.usage.output_tokens, 9);
});

test('estimateAnthropicTokens scales with content length', () => {
  const small = estimateAnthropicTokens({ messages: [{ role: 'user', content: 'hi' }] });
  const big = estimateAnthropicTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
  assert.ok(small.input_tokens >= 1);
  assert.ok(big.input_tokens > 900 && big.input_tokens < 1100);
});

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

test('responsesToChat converts string input, items and tools', () => {
  const out = responsesToChat({
    model: 'gpt-x',
    instructions: 'be terse',
    max_output_tokens: 64,
    input: [
      { role: 'user', content: 'question' },
      { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"q":1}' },
      { type: 'function_call_output', call_id: 'call_a', output: '42' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
    ],
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    tool_choice: 'auto',
  });
  assert.deepStrictEqual(out.messages[0], { role: 'system', content: 'be terse' });
  assert.deepStrictEqual(out.messages[1], { role: 'user', content: 'question' });
  assert.strictEqual(out.messages[2].tool_calls[0].id, 'call_a');
  assert.deepStrictEqual(out.messages[3], { role: 'tool', tool_call_id: 'call_a', content: '42' });
  assert.deepStrictEqual(out.messages[4], { role: 'user', content: 'thanks' });
  assert.strictEqual(out.max_tokens, 64);
  assert.strictEqual(out.tools[0].function.name, 'lookup');
});

test('responsesToChat rejects hosted tools and previous_response_id', () => {
  assert.throws(
    () => responsesToChat({ model: 'x', input: 'q', tools: [{ type: 'web_search' }] }),
    /only "function" tools/,
  );
  assert.throws(
    () => responsesToChat({ model: 'x', input: 'q', previous_response_id: 'resp_1' }),
    /previous_response_id/,
  );
});

test('chatToResponses builds a completed response object', () => {
  const resp = chatToResponses(
    {
      choices: [{ message: { content: 'answer', tool_calls: [{ id: 'call_z', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
    },
    { model: 'gpt-x' },
  );
  assert.strictEqual(resp.object, 'response');
  assert.strictEqual(resp.status, 'completed');
  assert.strictEqual(resp.model, 'gpt-x');
  const fc = resp.output.find((o) => o.type === 'function_call');
  assert.strictEqual(fc.call_id, 'call_z');
  const m = resp.output.find((o) => o.type === 'message');
  assert.strictEqual(m.content[0].type, 'output_text');
  assert.strictEqual(m.content[0].text, 'answer');
  assert.strictEqual(resp.usage.input_tokens, 3);
  assert.strictEqual(resp.usage.output_tokens, 7);
  assert.strictEqual(resp.usage.total_tokens, 10);
});

test('responses stream translator emits typed events with sequence numbers', () => {
  const col = sseCollector();
  const tr = responsesAdapter.createStream({ model: 'gpt-x' }, col.write);
  tr.feed({ choices: [{ delta: { content: 'par' } }] });
  tr.feed({ choices: [{ delta: { content: 'is' } }] });
  tr.feed({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 4 } });
  tr.done();

  const events = col.events();
  const types = events.map((e) => e.event);
  assert.deepStrictEqual(types, [
    'response.created', 'response.in_progress',
    'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.completed',
  ]);
  events.forEach((e, i) => assert.strictEqual(e.data.sequence_number, i));
  const done = events.find((e) => e.event === 'response.output_text.done');
  assert.strictEqual(done.data.text, 'paris');
  const completed = events.find((e) => e.event === 'response.completed');
  assert.strictEqual(completed.data.response.status, 'completed');
  assert.strictEqual(completed.data.response.output[0].content[0].text, 'paris');
  assert.strictEqual(completed.data.response.usage.output_tokens, 4);
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

test('geminiToChat converts contents, config, tools and function responses', () => {
  const out = geminiToChat(
    {
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ functionCall: { name: 'ping', args: { n: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'ping', response: { ok: true } } }] },
      ],
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 50, stopSequences: ['x'] },
      tools: [{ functionDeclarations: [{ name: 'ping', parameters: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    },
    { model: 'gemini-flash', stream: false },
  );
  assert.strictEqual(out.model, 'gemini-flash');
  assert.deepStrictEqual(out.messages[0], { role: 'system', content: 'sys' });
  assert.deepStrictEqual(out.messages[1], { role: 'user', content: 'hi' });
  assert.strictEqual(out.messages[2].tool_calls[0].function.name, 'ping');
  assert.strictEqual(out.messages[3].role, 'tool');
  assert.strictEqual(out.messages[3].tool_call_id, out.messages[2].tool_calls[0].id);
  assert.strictEqual(out.max_tokens, 50);
  assert.strictEqual(out.top_p, 0.9);
  assert.deepStrictEqual(out.stop, ['x']);
  assert.strictEqual(out.tools[0].function.name, 'ping');
  assert.strictEqual(out.tool_choice, 'required');
});

test('chatToGemini maps candidates, function calls and usage metadata', () => {
  const out = chatToGemini(
    {
      choices: [{ message: { content: 'bonjour', tool_calls: [{ function: { name: 'f', arguments: '{"k":2}' } }] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    },
    { model: 'gemini-flash' },
  );
  assert.strictEqual(out.candidates[0].content.role, 'model');
  assert.deepStrictEqual(out.candidates[0].content.parts[0], { text: 'bonjour' });
  assert.deepStrictEqual(out.candidates[0].content.parts[1].functionCall, { name: 'f', args: { k: 2 } });
  assert.strictEqual(out.candidates[0].finishReason, 'STOP');
  assert.strictEqual(out.usageMetadata.promptTokenCount, 5);
  assert.strictEqual(out.usageMetadata.candidatesTokenCount, 6);
  assert.strictEqual(out.usageMetadata.totalTokenCount, 11);
});

test('gemini stream translator: SSE frames and JSON-array mode both parse', () => {
  // alt=sse
  const sse = sseCollector();
  const tr1 = geminiAdapter.createStream({ model: 'g', sse: true }, sse.write);
  tr1.feed({ choices: [{ delta: { content: 'a' } }] });
  tr1.feed({ choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
  tr1.done();
  const frames = sse.text().split('\r\n\r\n').filter((f) => f.trim()).map((f) => JSON.parse(f.replace(/^data: /, '')));
  assert.strictEqual(frames.length, 3);
  assert.strictEqual(frames[0].candidates[0].content.parts[0].text, 'a');
  assert.strictEqual(frames[2].candidates[0].finishReason, 'STOP');
  assert.strictEqual(frames[2].usageMetadata.candidatesTokenCount, 2);

  // REST default: progressive JSON array
  const chunks = [];
  const tr2 = geminiAdapter.createStream({ model: 'g', sse: false }, (s) => chunks.push(s));
  tr2.feed({ choices: [{ delta: { content: 'x' } }] });
  tr2.done();
  const arr = JSON.parse(chunks.join(''));
  assert.ok(Array.isArray(arr));
  assert.strictEqual(arr[0].candidates[0].content.parts[0].text, 'x');
});

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

test('createSseParser reassembles data lines across chunk boundaries', () => {
  const seen = [];
  const p = createSseParser((o) => seen.push(o));
  const frames = 'data: {"a":1}\n\ndata: {"b"' + '';
  p.feed(Buffer.from(frames));
  p.feed(Buffer.from(':2}\n\ndata: [DONE]\n\n'));
  p.end();
  assert.deepStrictEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test('simulateStream replays a full completion through a translator', () => {
  const col = sseCollector();
  const tr = anthropicAdapter.createStream({ model: 'm' }, col.write);
  simulateStream(
    { choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } },
    tr,
  );
  const events = col.events();
  assert.strictEqual(events[0].event, 'message_start');
  assert.strictEqual(events.at(-1).event, 'message_stop');
  const text = events
    .filter((e) => e.data && e.data.delta && e.data.delta.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
  assert.strictEqual(text, 'whole');
});

test('upstreamErrorMessage prefers the parsed error.message', () => {
  assert.strictEqual(upstreamErrorMessage('{"error":{"message":"boom"}}'), 'boom');
  assert.strictEqual(upstreamErrorMessage('plain text'), 'plain text');
  assert.strictEqual(upstreamErrorMessage('', 'fallback'), 'fallback');
});

test('protocol error bodies use each protocol shape', () => {
  assert.deepStrictEqual(anthropicAdapter.errorBody(429, 'slow down'), {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'slow down' },
  });
  assert.strictEqual(responsesAdapter.errorBody(500, 'x').error.type, 'server_error');
  const g = geminiAdapter.errorBody(429, 'q');
  assert.deepStrictEqual(g, { error: { code: 429, message: 'q', status: 'RESOURCE_EXHAUSTED' } });
});

// ---------------------------------------------------------------------------
// scheduler additions + wildcard matching
// ---------------------------------------------------------------------------

function cand(id, { ttft = 0, tps = 0, ewma = 0 } = {}) {
  return {
    channel: { id: `ch_${id}`, name: id, weight: 1 },
    key: { id: `key_${id}`, inflight: 0, ewmaLatencyMs: ewma, ewmaTtftMs: ttft, ewmaTps: tps, stats: { requests: 0, success: 0 } },
  };
}

test('lowest_ttft picks the fastest first token (unused keys first)', () => {
  const cs = [cand('slow', { ttft: 900 }), cand('fast', { ttft: 120 }), cand('mid', { ttft: 500 })];
  assert.strictEqual(selectCandidate(cs, 'lowest_ttft', {}).key.id, 'key_fast');
  const withNew = [...cs, cand('new')];
  assert.strictEqual(selectCandidate(withNew, 'lowest_ttft', {}).key.id, 'key_new');
});

test('highest_throughput picks the highest tokens/sec (unused keys first)', () => {
  const cs = [cand('a', { tps: 12 }), cand('b', { tps: 55 }), cand('c', { tps: 30 })];
  assert.strictEqual(selectCandidate(cs, 'highest_throughput', {}).key.id, 'key_b');
  const withNew = [...cs, cand('new')];
  assert.strictEqual(selectCandidate(withNew, 'highest_throughput', {}).key.id, 'key_new');
});

test('Pool.modelMatches supports trailing-* wildcards', () => {
  assert.ok(Pool.modelMatches(['gpt-4o'], 'gpt-4o'));
  assert.ok(Pool.modelMatches(['gpt-4*'], 'gpt-4o-mini'));
  assert.ok(Pool.modelMatches(['*'], 'anything'));
  assert.ok(!Pool.modelMatches(['gpt-4*'], 'gpt-3.5'));
  assert.ok(!Pool.modelMatches(['gpt-4o'], 'gpt-4o-mini'));
});
