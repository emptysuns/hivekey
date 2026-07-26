'use strict';
const crypto = require('crypto');

/**
 * Inbound protocol adapters.
 *
 * Upstream channels speak the OpenAI chat-completions dialect. These adapters
 * let clients talk to the pool with other SDK protocols:
 *   - Anthropic Messages   POST /v1/messages          (+ /count_tokens)
 *   - OpenAI Responses     POST /v1/responses
 *   - Google Gemini        POST /v1beta/models/{m}:generateContent
 *                          POST /v1beta/models/{m}:streamGenerateContent
 *                          POST /v1beta/models/{m}:countTokens
 *
 * Each adapter converts the inbound request into a chat-completions body
 * (toChat), converts the upstream JSON reply back (fromChat), and translates
 * upstream SSE chunks into the protocol's own streaming frames (createStream).
 */

function rid(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function tryParseJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** Flatten any rich content (block arrays, objects) into plain text. */
function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        return JSON.stringify(b);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

/* ============================================================
 * Anthropic Messages
 * ============================================================ */

function anthropicToChat(a) {
  if (!a || typeof a !== 'object') throw badRequest('invalid JSON body');
  if (typeof a.model !== 'string' || !a.model) throw badRequest('"model" is required');
  if (!Array.isArray(a.messages)) throw badRequest('"messages" must be an array');

  const messages = [];
  if (a.system != null && a.system !== '') {
    const sys = asText(a.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  for (const m of a.messages) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = m ? m.content : '';
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      messages.push({ role, content: asText(content) });
      continue;
    }
    if (role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') text += (text ? '\n' : '') + (block.text || '');
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: String(block.id || rid('call')),
            type: 'function',
            function: { name: String(block.name || ''), arguments: JSON.stringify(block.input ?? {}) },
          });
        }
        // thinking / redacted_thinking blocks are dropped
      }
      if (text || toolCalls.length) {
        const msg = { role: 'assistant', content: text || null };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        messages.push(msg);
      }
    } else {
      // user turn: tool_result blocks become role:"tool" messages, the rest
      // collapses into one user message
      const parts = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: String(block.tool_use_id || ''),
            content: asText(block.content),
          });
        } else if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text || '' });
        } else if (block.type === 'image' && block.source) {
          const src = block.source;
          const url = src.type === 'url'
            ? String(src.url || '')
            : `data:${src.media_type || 'image/png'};base64,${src.data || ''}`;
          parts.push({ type: 'image_url', image_url: { url } });
        } else if (block.type === 'document') {
          parts.push({ type: 'text', text: '[unsupported document attachment]' });
        }
      }
      if (parts.length) {
        const onlyText = parts.every((p) => p.type === 'text');
        messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
      }
    }
  }

  const out = { model: a.model, messages, stream: !!a.stream };
  if (Number.isFinite(a.max_tokens)) out.max_tokens = a.max_tokens;
  if (Number.isFinite(a.temperature)) out.temperature = a.temperature;
  if (Number.isFinite(a.top_p)) out.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) out.stop = a.stop_sequences;
  if (a.metadata && typeof a.metadata.user_id === 'string') out.user = a.metadata.user_id;

  if (Array.isArray(a.tools) && a.tools.length) {
    // custom tools carry input_schema; server tools (web_search…) are dropped
    const tools = a.tools
      .filter((t) => t && t.name && (t.input_schema || !t.type || t.type === 'custom'))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }));
    if (tools.length) out.tools = tools;
  }
  if (a.tool_choice && typeof a.tool_choice === 'object') {
    const tc = a.tool_choice;
    if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc.type === 'none') out.tool_choice = 'none';
    else out.tool_choice = 'auto';
  }
  return out;
}

function anthropicStopReason(finish) {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  return 'end_turn';
}

function chatToAnthropic(oai, ctx) {
  const choice = (oai && Array.isArray(oai.choices) && oai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  const text = typeof msg.content === 'string' ? msg.content : asText(msg.content);
  if (text) content.push({ type: 'text', text });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: String(tc.id || rid('toolu')),
        name: (tc.function && tc.function.name) || '',
        input: tryParseJson(tc.function && tc.function.arguments, {}) ?? {},
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const u = (oai && oai.usage) || {};
  return {
    id: rid('msg'),
    type: 'message',
    role: 'assistant',
    model: ctx.model,
    content,
    stop_reason: anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
  };
}

function anthropicErrorType(status) {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}

function anthropicStream(ctx, write) {
  const emit = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgId = rid('msg');
  let started = false;
  let blockIndex = -1;
  let blockType = null; // 'text' | 'tool'
  let toolStreamIndex = null; // upstream tool_calls[].index currently open
  let finishReason = null;
  let usage = null;
  let outputChars = 0;

  const start = () => {
    if (started) return;
    started = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: ctx.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    emit('ping', { type: 'ping' });
  };
  const closeBlock = () => {
    if (blockType == null) return;
    emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockType = null;
    toolStreamIndex = null;
  };
  const openText = () => {
    if (blockType === 'text') return;
    closeBlock();
    blockIndex += 1;
    blockType = 'text';
    emit('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
  };

  return {
    feed(chunk) {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) return;
      start();
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        openText();
        outputChars += delta.content.length;
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tIdx = Number.isFinite(tc.index) ? tc.index : 0;
          if (blockType !== 'tool' || toolStreamIndex !== tIdx) {
            closeBlock();
            blockIndex += 1;
            blockType = 'tool';
            toolStreamIndex = tIdx;
            emit('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: String(tc.id || rid('toolu')),
                name: (tc.function && tc.function.name) || '',
                input: {},
              },
            });
          }
          const args = tc.function && tc.function.arguments;
          if (typeof args === 'string' && args) {
            emit('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: args },
            });
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    },
    done() {
      start();
      closeBlock();
      const outTokens = usage && Number.isFinite(usage.completion_tokens)
        ? usage.completion_tokens
        : Math.ceil(outputChars / 4);
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
        usage: { output_tokens: outTokens },
      });
      emit('message_stop', { type: 'message_stop' });
    },
  };
}

/** Cheap local estimate for /v1/messages/count_tokens (~4 chars per token). */
function estimateAnthropicTokens(body) {
  let chars = 0;
  const add = (v) => {
    if (typeof v === 'string') chars += v.length;
    else if (v != null) chars += JSON.stringify(v).length;
  };
  if (body && typeof body === 'object') {
    add(body.system);
    for (const m of Array.isArray(body.messages) ? body.messages : []) add(m && m.content);
    if (body.tools) add(body.tools);
  }
  return { input_tokens: Math.max(1, Math.round(chars / 4)) };
}

/* ============================================================
 * OpenAI Responses
 * ============================================================ */

function responsesToChat(r) {
  if (!r || typeof r !== 'object') throw badRequest('invalid JSON body');
  if (typeof r.model !== 'string' || !r.model) throw badRequest('"model" is required');
  if (r.previous_response_id) throw badRequest('"previous_response_id" is not supported by this pool — send the full conversation in "input"');

  const messages = [];
  if (typeof r.instructions === 'string' && r.instructions) {
    messages.push({ role: 'system', content: r.instructions });
  }
  const input = r.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const type = item.type || (item.role ? 'message' : null);
      if (type === 'message') {
        const role = item.role === 'assistant' ? 'assistant'
          : item.role === 'system' || item.role === 'developer' ? 'system'
          : 'user';
        const c = item.content;
        if (typeof c === 'string') {
          messages.push({ role, content: c });
        } else if (Array.isArray(c)) {
          const parts = [];
          for (const p of c) {
            if (!p || typeof p !== 'object') continue;
            if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text' || p.type === 'summary_text') {
              parts.push({ type: 'text', text: p.text || '' });
            } else if (p.type === 'refusal') {
              parts.push({ type: 'text', text: p.refusal || '' });
            } else if (p.type === 'input_image' && p.image_url) {
              parts.push({ type: 'image_url', image_url: { url: String(p.image_url) } });
            }
          }
          if (parts.length) {
            const onlyText = parts.every((p) => p.type === 'text');
            messages.push({ role, content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
          }
        }
      } else if (type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: String(item.call_id || item.id || rid('call')),
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
            },
          }],
        });
      } else if (type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: String(item.call_id || ''), content: asText(item.output) });
      }
      // reasoning items are dropped
    }
  }

  const out = { model: r.model, messages, stream: !!r.stream };
  if (Number.isFinite(r.max_output_tokens)) out.max_tokens = r.max_output_tokens;
  if (Number.isFinite(r.temperature)) out.temperature = r.temperature;
  if (Number.isFinite(r.top_p)) out.top_p = r.top_p;
  if (typeof r.parallel_tool_calls === 'boolean') out.parallel_tool_calls = r.parallel_tool_calls;

  if (Array.isArray(r.tools) && r.tools.length) {
    const fns = r.tools.filter((t) => t && t.type === 'function' && t.name);
    if (fns.length !== r.tools.length) {
      throw badRequest('only "function" tools are supported by this pool (hosted tools like web_search are not)');
    }
    out.tools = fns.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
    }));
  }
  if (r.tool_choice) {
    if (typeof r.tool_choice === 'string') out.tool_choice = r.tool_choice;
    else if (r.tool_choice.type === 'function' && r.tool_choice.name) {
      out.tool_choice = { type: 'function', function: { name: r.tool_choice.name } };
    }
  }
  const fmt = r.text && r.text.format;
  if (fmt && fmt.type === 'json_object') out.response_format = { type: 'json_object' };
  else if (fmt && fmt.type === 'json_schema') {
    out.response_format = {
      type: 'json_schema',
      json_schema: { name: fmt.name || 'schema', schema: fmt.schema || {}, strict: fmt.strict !== false },
    };
  }
  return out;
}

function responsesBase(ctx, id, status) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: ctx.model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {},
  };
}

function responsesUsage(u) {
  u = u || {};
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
  };
}

function chatToResponses(oai, ctx) {
  const resp = responsesBase(ctx, rid('resp'), 'completed');
  const choice = (oai && Array.isArray(oai.choices) && oai.choices[0]) || {};
  const msg = choice.message || {};
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      resp.output.push({
        type: 'function_call',
        id: rid('fc'),
        call_id: String(tc.id || rid('call')),
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || '{}',
        status: 'completed',
      });
    }
  }
  const text = typeof msg.content === 'string' ? msg.content : asText(msg.content);
  if (text || !resp.output.length) {
    resp.output.push({
      type: 'message',
      id: rid('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: text || '', annotations: [] }],
    });
  }
  if (choice.finish_reason === 'length') {
    resp.status = 'incomplete';
    resp.incomplete_details = { reason: 'max_output_tokens' };
  }
  resp.usage = responsesUsage(oai && oai.usage);
  return resp;
}

function responsesStream(ctx, write) {
  const respId = rid('resp');
  let seq = 0;
  const emit = (type, data) => write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: (seq += 1) - 1, ...data })}\n\n`);
  let started = false;
  let outputIndex = -1;
  let itemType = null; // 'message' | 'function_call'
  let itemId = null;
  let text = '';
  let args = '';
  let callMeta = null;
  let toolStreamIndex = null;
  const output = [];
  let finishReason = null;
  let usage = null;

  const start = () => {
    if (started) return;
    started = true;
    const base = responsesBase(ctx, respId, 'in_progress');
    emit('response.created', { response: base });
    emit('response.in_progress', { response: base });
  };
  const closeItem = () => {
    if (itemType === 'message') {
      emit('response.output_text.done', { item_id: itemId, output_index: outputIndex, content_index: 0, text });
      const part = { type: 'output_text', text, annotations: [] };
      emit('response.content_part.done', { item_id: itemId, output_index: outputIndex, content_index: 0, part });
      const item = { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [part] };
      emit('response.output_item.done', { output_index: outputIndex, item });
      output.push(item);
    } else if (itemType === 'function_call') {
      emit('response.function_call_arguments.done', { item_id: itemId, output_index: outputIndex, arguments: args });
      const item = {
        type: 'function_call', id: itemId, call_id: callMeta.call_id, name: callMeta.name, arguments: args, status: 'completed',
      };
      emit('response.output_item.done', { output_index: outputIndex, item });
      output.push(item);
    }
    itemType = null;
    itemId = null;
    text = '';
    args = '';
    callMeta = null;
    toolStreamIndex = null;
  };
  const openMessage = () => {
    if (itemType === 'message') return;
    closeItem();
    outputIndex += 1;
    itemType = 'message';
    itemId = rid('msg');
    emit('response.output_item.added', {
      output_index: outputIndex,
      item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] },
    });
    emit('response.content_part.added', {
      item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  return {
    feed(chunk) {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) return;
      start();
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        openMessage();
        text += delta.content;
        emit('response.output_text.delta', { item_id: itemId, output_index: outputIndex, content_index: 0, delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tIdx = Number.isFinite(tc.index) ? tc.index : 0;
          if (itemType !== 'function_call' || toolStreamIndex !== tIdx) {
            closeItem();
            outputIndex += 1;
            itemType = 'function_call';
            itemId = rid('fc');
            toolStreamIndex = tIdx;
            callMeta = { call_id: String(tc.id || rid('call')), name: (tc.function && tc.function.name) || '' };
            emit('response.output_item.added', {
              output_index: outputIndex,
              item: { type: 'function_call', id: itemId, call_id: callMeta.call_id, name: callMeta.name, arguments: '', status: 'in_progress' },
            });
          } else if (tc.function && tc.function.name && !callMeta.name) {
            callMeta.name = tc.function.name;
          }
          const a = tc.function && tc.function.arguments;
          if (typeof a === 'string' && a) {
            args += a;
            emit('response.function_call_arguments.delta', { item_id: itemId, output_index: outputIndex, delta: a });
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    },
    done() {
      start();
      closeItem();
      const resp = responsesBase(ctx, respId, finishReason === 'length' ? 'incomplete' : 'completed');
      if (finishReason === 'length') resp.incomplete_details = { reason: 'max_output_tokens' };
      resp.output = output;
      resp.usage = responsesUsage(usage);
      emit(resp.status === 'completed' ? 'response.completed' : 'response.incomplete', { response: resp });
    },
  };
}

/* ============================================================
 * Google Gemini
 * ============================================================ */

function geminiPartsText(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function geminiToChat(g, ctx) {
  if (!g || typeof g !== 'object') throw badRequest('invalid JSON body');
  const messages = [];

  const sys = g.systemInstruction || g.system_instruction;
  if (sys) {
    const sysText = typeof sys === 'string' ? sys : geminiPartsText(sys.parts);
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  let contents = g.contents;
  if (typeof contents === 'string') contents = [{ role: 'user', parts: [{ text: contents }] }];
  if (contents && !Array.isArray(contents)) contents = [contents];
  if (!Array.isArray(contents) || !contents.length) throw badRequest('"contents" is required');

  const toolIds = new Map(); // function name -> synthesized call id (Gemini has no call ids)
  for (const c of contents) {
    if (!c || typeof c !== 'object') continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(c.parts) ? c.parts : [];
    if (role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string' && p.text) text += (text ? '\n' : '') + p.text;
        const fc = p.functionCall || p.function_call;
        if (fc && fc.name) {
          const id = rid('call');
          toolIds.set(fc.name, id);
          toolCalls.push({ id, type: 'function', function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) } });
        }
      }
      if (text || toolCalls.length) {
        const msg = { role: 'assistant', content: text || null };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        messages.push(msg);
      }
    } else {
      const rich = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        const fr = p.functionResponse || p.function_response;
        if (fr && fr.name) {
          messages.push({
            role: 'tool',
            tool_call_id: toolIds.get(fr.name) || `call_${fr.name}`,
            content: asText(fr.response),
          });
          continue;
        }
        if (typeof p.text === 'string') {
          rich.push({ type: 'text', text: p.text });
          continue;
        }
        const inline = p.inlineData || p.inline_data;
        if (inline && inline.data) {
          rich.push({
            type: 'image_url',
            image_url: { url: `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}` },
          });
        }
      }
      if (rich.length) {
        const onlyText = rich.every((p) => p.type === 'text');
        messages.push({ role: 'user', content: onlyText ? rich.map((p) => p.text).join('\n') : rich });
      }
    }
  }

  const out = { model: ctx.model, messages, stream: !!ctx.stream };
  const gc = g.generationConfig || g.generation_config || {};
  const maxTok = gc.maxOutputTokens ?? gc.max_output_tokens;
  if (Number.isFinite(maxTok)) out.max_tokens = maxTok;
  if (Number.isFinite(gc.temperature)) out.temperature = gc.temperature;
  const topP = gc.topP ?? gc.top_p;
  if (Number.isFinite(topP)) out.top_p = topP;
  const stops = gc.stopSequences || gc.stop_sequences;
  if (Array.isArray(stops) && stops.length) out.stop = stops;
  if ((gc.responseMimeType || gc.response_mime_type) === 'application/json') {
    out.response_format = { type: 'json_object' };
  }

  if (Array.isArray(g.tools)) {
    const fns = [];
    for (const t of g.tools) {
      const decls = (t && (t.functionDeclarations || t.function_declarations)) || [];
      for (const d of decls) {
        if (d && d.name) {
          fns.push({
            type: 'function',
            function: { name: d.name, description: d.description || '', parameters: d.parameters || { type: 'object', properties: {} } },
          });
        }
      }
      // built-in tools (googleSearch, codeExecution…) are dropped
    }
    if (fns.length) out.tools = fns;
  }
  const mode = (g.toolConfig && g.toolConfig.functionCallingConfig && g.toolConfig.functionCallingConfig.mode)
    || (g.tool_config && g.tool_config.function_calling_config && g.tool_config.function_calling_config.mode);
  if (mode === 'ANY') out.tool_choice = 'required';
  else if (mode === 'NONE') out.tool_choice = 'none';
  else if (mode === 'AUTO') out.tool_choice = 'auto';
  return out;
}

function geminiFinishReason(finish) {
  if (finish === 'length') return 'MAX_TOKENS';
  if (finish === 'content_filter') return 'SAFETY';
  return 'STOP';
}

function geminiUsage(u) {
  u = u || {};
  return {
    promptTokenCount: u.prompt_tokens || 0,
    candidatesTokenCount: u.completion_tokens || 0,
    totalTokenCount: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
  };
}

function chatToGemini(oai, ctx) {
  const choice = (oai && Array.isArray(oai.choices) && oai.choices[0]) || {};
  const msg = choice.message || {};
  const parts = [];
  const text = typeof msg.content === 'string' ? msg.content : asText(msg.content);
  if (text) parts.push({ text });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push({
        functionCall: {
          name: (tc.function && tc.function.name) || '',
          args: tryParseJson(tc.function && tc.function.arguments, {}) ?? {},
        },
      });
    }
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{
      content: { parts, role: 'model' },
      finishReason: geminiFinishReason(choice.finish_reason),
      index: 0,
    }],
    usageMetadata: geminiUsage(oai && oai.usage),
    modelVersion: ctx.model,
  };
}

function geminiStream(ctx, write) {
  let first = true;
  const frame = (obj) => {
    if (ctx.sse) {
      write(`data: ${JSON.stringify(obj)}\r\n\r\n`);
    } else {
      // REST default: a progressively streamed JSON array of chunks
      write((first ? '[' : ',\n') + JSON.stringify(obj));
      first = false;
    }
  };
  let finishReason = null;
  let usage = null;
  let sawText = false;
  const calls = new Map(); // upstream tool index -> {name, args}

  return {
    feed(chunk) {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        sawText = true;
        frame({
          candidates: [{ content: { parts: [{ text: delta.content }], role: 'model' }, index: 0 }],
          modelVersion: ctx.model,
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tIdx = Number.isFinite(tc.index) ? tc.index : 0;
          let rec = calls.get(tIdx);
          if (!rec) {
            rec = { name: '', args: '' };
            calls.set(tIdx, rec);
          }
          if (tc.function && tc.function.name && !rec.name) rec.name = tc.function.name;
          if (tc.function && typeof tc.function.arguments === 'string') rec.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    },
    done() {
      const parts = [];
      for (const rec of calls.values()) {
        parts.push({ functionCall: { name: rec.name, args: tryParseJson(rec.args, {}) ?? {} } });
      }
      if (!parts.length) parts.push({ text: '' });
      frame({
        candidates: [{
          content: { parts, role: 'model' },
          finishReason: geminiFinishReason(finishReason || (sawText ? 'stop' : null)),
          index: 0,
        }],
        usageMetadata: geminiUsage(usage),
        modelVersion: ctx.model,
      });
      if (!ctx.sse) write(first ? '[]' : ']');
    },
  };
}

function geminiStatusWord(status) {
  if (status === 400) return 'INVALID_ARGUMENT';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RESOURCE_EXHAUSTED';
  if (status === 503) return 'UNAVAILABLE';
  if (status === 504) return 'DEADLINE_EXCEEDED';
  return 'INTERNAL';
}

/** Rough countTokens for Gemini clients. */
function estimateGeminiTokens(body) {
  let chars = 0;
  if (body && typeof body === 'object') {
    if (body.contents) chars += JSON.stringify(body.contents).length;
    const sys = body.systemInstruction || body.system_instruction;
    if (sys) chars += JSON.stringify(sys).length;
  }
  return { totalTokens: Math.max(1, Math.round(chars / 4)) };
}

/* ============================================================
 * Shared plumbing
 * ============================================================ */

/** Pull a human message out of an upstream (OpenAI-shaped) error body. */
function upstreamErrorMessage(snippet, fallback) {
  const parsed = tryParseJson(snippet, null);
  const m = parsed && parsed.error && (typeof parsed.error === 'string' ? parsed.error : parsed.error.message);
  if (typeof m === 'string' && m) return m.slice(0, 500);
  const s = String(snippet || '').trim();
  return s ? s.slice(0, 500) : (fallback || 'upstream error');
}

/** Incremental parser for upstream SSE: emits parsed `data:` JSON objects. */
function createSseParser(onEvent) {
  let carry = '';
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const obj = tryParseJson(payload, null);
    if (obj) onEvent(obj);
  };
  return {
    feed(chunk) {
      carry += chunk.toString('utf8');
      if (carry.length > 2_097_152) {
        // pathological unbroken line — drop it rather than growing forever
        carry = '';
        return;
      }
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) handleLine(line.replace(/\r$/, ''));
    },
    end() {
      if (carry) handleLine(carry.replace(/\r$/, ''));
      carry = '';
    },
  };
}

/** Replay a complete chat completion through a stream translator (for clients
 *  that asked to stream when the upstream answered with plain JSON). */
function simulateStream(oai, translator) {
  const choice = (oai && Array.isArray(oai.choices) && oai.choices[0]) || {};
  const msg = choice.message || {};
  const delta = {};
  const text = typeof msg.content === 'string' ? msg.content : asText(msg.content);
  if (text) delta.content = text;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    delta.tool_calls = msg.tool_calls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.function && tc.function.name, arguments: (tc.function && tc.function.arguments) || '' },
    }));
  }
  translator.feed({ choices: [{ delta, finish_reason: choice.finish_reason || 'stop' }], usage: oai && oai.usage });
  translator.done();
}

/* ============================================================
 * Adapter registry
 * ============================================================ */

const anthropicAdapter = {
  name: 'anthropic',
  toChat: anthropicToChat,
  fromChat: chatToAnthropic,
  createStream: anthropicStream,
  errorBody: (status, message) => ({ type: 'error', error: { type: anthropicErrorType(status), message } }),
};

const responsesAdapter = {
  name: 'responses',
  toChat: responsesToChat,
  fromChat: chatToResponses,
  createStream: responsesStream,
  errorBody: (status, message) => ({
    error: {
      message,
      type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error',
      param: null,
      code: null,
    },
  }),
};

const geminiAdapter = {
  name: 'gemini',
  toChat: geminiToChat,
  fromChat: chatToGemini,
  createStream: geminiStream,
  errorBody: (status, message) => ({ error: { code: status, message, status: geminiStatusWord(status) } }),
};

const GEMINI_ROUTE = /^\/v1(?:beta)?\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

/**
 * Map a request path to an adapter route, or null for plain OpenAI passthrough.
 * Returns { adapter, action?, model? }.
 */
function detectRoute(pathname) {
  if (pathname === '/v1/messages') return { adapter: anthropicAdapter };
  if (pathname === '/v1/messages/count_tokens') return { adapter: anthropicAdapter, action: 'count_tokens' };
  if (pathname === '/v1/responses') return { adapter: responsesAdapter };
  const m = GEMINI_ROUTE.exec(pathname);
  if (m) {
    let model;
    try {
      model = decodeURIComponent(m[1]);
    } catch {
      model = m[1];
    }
    return { adapter: geminiAdapter, model: model.replace(/^models\//, ''), action: m[2] };
  }
  return null;
}

module.exports = {
  detectRoute,
  anthropicAdapter,
  responsesAdapter,
  geminiAdapter,
  anthropicToChat,
  chatToAnthropic,
  responsesToChat,
  chatToResponses,
  geminiToChat,
  chatToGemini,
  estimateAnthropicTokens,
  estimateGeminiTokens,
  upstreamErrorMessage,
  createSseParser,
  simulateStream,
};
