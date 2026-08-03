# Codex OpenCode Go Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cc-switch for Codex with a local Node.js router that routes OpenCode Go models by endpoint and translates Responses to Chat Completions or Anthropic Messages.

**Architecture:** A zero-dependency Node HTTP server exposes `/v1/responses` and `/v1/models`. A route table maps model IDs to `responses`, `chat`, or `messages` upstream protocols. Protocol translators convert request/response payloads and SSE streams.

**Tech Stack:** Node.js 18+ built-ins: `node:http`, global `fetch`, `node:test`, CommonJS-free ESM.

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `config.example.json`
- Create: `config.json`
- Create: `.gitignore`

```json
{
  "name": "codex-opencode-go-router",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/main.js",
    "test": "node --test test/*.test.js"
  }
}
```

```json
{
  "host": "127.0.0.1",
  "port": 15721,
  "apiBaseUrl": "https://opencode.ai/zen/go/v1",
  "apiKeyEnv": "OPENCODE_GO_API_KEY",
  "catalogFile": "catalog.json",
  "timeouts": {
    "requestMs": 600000,
    "streamIdleMs": 180000
  },
  "models": {}
}
```

`config.json` starts as a copy of `config.example.json`. `.gitignore` contains `node_modules/`, `catalog.json`, `.env`.

- [ ] Create the four files above.
- [ ] Verify with `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('ok')"`.

## Task 2: Config Loader

**Files:**
- Create: `src/config.js`
- Create: `test/config.test.js`

```js
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 15721,
  apiBaseUrl: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  catalogFile: 'catalog.json',
  timeouts: { requestMs: 600000, streamIdleMs: 180000 },
  models: {}
};

export function loadConfig({ configPath = 'config.json', env = process.env, cwd = process.cwd() } = {}) {
  const abs = path.resolve(cwd, configPath);
  if (!existsSync(abs)) throw new Error(`config file not found: ${abs}`);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...(raw.timeouts || {}) },
    models: raw.models || {}
  };
  const apiKey = env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`missing ${config.apiKeyEnv} environment variable`);
  return { ...config, apiKey };
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

function makeConfig(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-config-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ port: 12345, ...extra }));
  return { dir, file };
}

test('loads config and api key from env', () => {
  const { dir, file } = makeConfig();
  const cfg = loadConfig({ configPath: file, env: { OPENCODE_GO_API_KEY: 'k' } });
  assert.equal(cfg.port, 12345);
  assert.equal(cfg.apiKey, 'k');
  rmSync(dir, { recursive: true, force: true });
});

test('throws when api key env is missing', () => {
  const { dir, file } = makeConfig();
  assert.throws(() => loadConfig({ configPath: file, env: {} }), /missing OPENCODE_GO_API_KEY/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] Write tests, run `npm test` or `node --test test/config.test.js`, verify RED.
- [ ] Implement `src/config.js`, verify GREEN.

## Task 3: Route Table

**Files:**
- Create: `src/routes.js`
- Create: `test/routes.test.js`

```js
export const DEFAULT_MODEL_ROUTES = {
  'gpt-5.6-luna': 'responses',
  'grok-4.5': 'chat',
  'glm-5.2': 'chat',
  'glm-5.1': 'chat',
  'kimi-k3': 'chat',
  'kimi-k2.7-code': 'chat',
  'kimi-k2.6': 'chat',
  'deepseek-v4-pro': 'chat',
  'deepseek-v4-flash': 'chat',
  'mimo-v2.5': 'chat',
  'mimo-v2.5-pro': 'chat',
  'hy3': 'chat',
  'minimax-m3': 'messages',
  'minimax-m2.7': 'messages',
  'minimax-m2.5': 'messages',
  'qwen3.7-max': 'messages',
  'qwen3.7-plus': 'messages',
  'qwen3.6-plus': 'messages'
};

export class UnknownModelError extends Error {
  constructor(model) {
    super(`unknown model: ${model}`);
    this.name = 'UnknownModelError';
    this.model = model;
  }
}

export function resolveRoute(config, model) {
  const upstream = config.models?.[model]?.upstream ?? DEFAULT_MODEL_ROUTES[model];
  if (!upstream) throw new UnknownModelError(model);
  const suffix = upstream === 'responses' ? 'responses' : upstream === 'chat' ? 'chat/completions' : 'messages';
  return { model, upstream, endpoint: `${config.apiBaseUrl}/${suffix}` };
}

export function listRoutedModels(config) {
  const ids = new Set([...Object.keys(DEFAULT_MODEL_ROUTES), ...Object.keys(config.models || {})]);
  return [...ids].filter((id) => {
    const upstream = config.models?.[id]?.upstream ?? DEFAULT_MODEL_ROUTES[id];
    return upstream === 'responses' || upstream === 'chat' || upstream === 'messages';
  });
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, UnknownModelError, listRoutedModels } from '../src/routes.js';

const config = { apiBaseUrl: 'https://opencode.ai/zen/go/v1', models: {} };

test('routes luna to responses', () => {
  const route = resolveRoute(config, 'gpt-5.6-luna');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/responses');
});

test('routes deepseek to chat completions', () => {
  const route = resolveRoute(config, 'deepseek-v4-flash');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/chat/completions');
});

test('routes minimax to messages', () => {
  const route = resolveRoute(config, 'minimax-m3');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/messages');
});

test('throws for unknown model', () => {
  assert.throws(() => resolveRoute(config, 'nope'), UnknownModelError);
});

test('lists routed models', () => {
  assert.ok(listRoutedModels(config).includes('gpt-5.6-luna'));
  assert.ok(listRoutedModels(config).includes('qwen3.6-plus'));
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/routes.js`, verify GREEN.

## Task 4: SSE Helpers

**Files:**
- Create: `src/sse.js`
- Create: `test/sse.test.js`

```js
export function parseSseEvent(part) {
  let event = 'message';
  const dataLines = [];
  for (const line of part.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export function sseEncode(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const parsed = parseSseEvent(part);
      if (parsed) yield parsed;
    }
  }
  const parsed = parseSseEvent(buffer);
  if (parsed) yield parsed;
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseEvent, sseEncode } from '../src/sse.js';

test('parses event and data', () => {
  const parsed = parseSseEvent('event: response.created\ndata: {"ok":true}');
  assert.deepEqual(parsed, { event: 'response.created', data: '{"ok":true}' });
});

test('encodes sse', () => {
  assert.equal(sseEncode('x', { a: 1 }), 'event: x\ndata: {"a":1}\n\n');
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/sse.js`, verify GREEN.

## Task 5: Responses to Chat

**Files:**
- Create: `src/translate/responsesToChat.js`
- Create: `test/responsesToChat.test.js`

```js
export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') ? part.text ?? '' : '')
    .join('');
}

export function responsesToolsToChat(tools) {
  return (tools || [])
    .filter((tool) => tool?.type === 'function')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} }
      }
    }));
}

export function responsesToChatRequest(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  for (const item of body.input || []) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    const role = item.role || 'user';
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      });
      continue;
    }
    if (role === 'assistant') {
      const toolCalls = (item.content || [])
        .filter((part) => part?.type === 'function_call')
        .map((part) => ({
          id: part.call_id,
          type: 'function',
          function: { name: part.name, arguments: part.arguments || '' }
        }));
      messages.push({
        role: 'assistant',
        content: textFromContent(item.content) || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      });
      continue;
    }
    messages.push({
      role: role === 'developer' ? 'system' : role,
      content: textFromContent(item.content)
    });
  }
  const request = {
    model: body.model,
    messages,
    stream: body.stream ?? false
  };
  const tools = responsesToolsToChat(body.tools);
  if (tools.length) request.tools = tools;
  if (body.tool_choice) request.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) request.parallel_tool_calls = body.parallel_tool_calls;
  if (body.max_output_tokens) request.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  return request;
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChatRequest, textFromContent } from '../src/translate/responsesToChat.js';

test('converts responses input to chat messages', () => {
  const request = responsesToChatRequest({
    model: 'deepseek-v4-flash',
    instructions: 'Be brief.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' }] },
      { role: 'tool', call_id: 'call_1', output: 'ok' }
    ]
  });
  assert.equal(request.messages[0].content, 'Be brief.');
  assert.equal(request.messages[1].content, 'hi');
  assert.equal(request.messages[2].tool_calls[0].function.name, 'sh');
  assert.equal(request.messages[3].role, 'tool');
});

test('converts function tools', () => {
  const request = responsesToChatRequest({
    model: 'x',
    tools: [{ type: 'function', name: 'shell_command', description: 'run', parameters: { type: 'object' } }]
  });
  assert.equal(request.tools[0].function.name, 'shell_command');
});

test('textFromContent handles string and blocks', () => {
  assert.equal(textFromContent('abc'), 'abc');
  assert.equal(textFromContent([{ type: 'input_text', text: 'a' }, { type: 'output_text', text: 'b' }]), 'ab');
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/translate/responsesToChat.js`, verify GREEN.

## Task 6: Chat to Responses

**Files:**
- Create: `src/translate/chatToResponses.js`
- Create: `test/chatToResponses.test.js`

```js
import { randomUUID } from 'node:crypto';
import { sseEvents } from '../sse.js';

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function chatToResponsesObject(chat, requestModel) {
  const choice = chat.choices?.[0] || {};
  const message = choice.message || {};
  const text = typeof message.content === 'string' ? message.content : '';
  const output = [];
  if (text) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
      logprobs: []
    });
  }
  for (const toolCall of message.tool_calls || []) {
    output.push({
      type: 'function_call',
      id: newId('fc'),
      call_id: toolCall.id,
      name: toolCall.function?.name || '',
      arguments: toolCall.function?.arguments || '',
      status: 'completed'
    });
  }
  return {
    id: chat.id || newId('resp'),
    object: 'response',
    created_at: chat.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chat.model || requestModel,
    output,
    error: null,
    incomplete_details: null,
    ...(chat.usage ? { usage: chat.usage } : {})
  };
}

export async function translateChatStreamToResponses(body, requestModel, writeEvent) {
  const response = {
    id: newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: requestModel,
    output: [],
    error: null,
    incomplete_details: null
  };
  writeEvent('response.created', { type: 'response.created', response });
  writeEvent('response.in_progress', { type: 'response.in_progress', response });

  let text = '';
  let messageItem = null;
  let messageIndex = -1;
  const toolItems = new Map();

  for await (const { data } of sseEvents(body)) {
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta || {};
    if (delta.content) {
      if (!messageItem) {
        messageItem = {
          id: newId('msg'),
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: []
        };
        messageIndex = response.output.length;
        response.output.push(messageItem);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: messageIndex, item: messageItem });
        const part = { type: 'output_text', text: '', annotations: [] };
        writeEvent('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: messageItem.id,
          output_index: messageIndex,
          content_index: 0,
          part
        });
      }
      text += delta.content;
      writeEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: messageItem.id,
        output_index: messageIndex,
        content_index: 0,
        delta: delta.content
      });
    }
    for (const toolCall of delta.tool_calls || []) {
      let item = toolItems.get(toolCall.index);
      if (!item) {
        item = {
          id: newId('fc'),
          type: 'function_call',
          call_id: toolCall.id || newId('call'),
          name: toolCall.function?.name || '',
          arguments: '',
          status: 'in_progress',
          outputIndex: response.output.length
        };
        toolItems.set(toolCall.index, item);
        response.output.push(item);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: item.outputIndex, item });
      }
      if (toolCall.function?.name) item.name += toolCall.function.name;
      if (toolCall.function?.arguments) {
        item.arguments += toolCall.function.arguments;
        writeEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: item.outputIndex,
          delta: toolCall.function.arguments
        });
      }
    }
  }

  if (messageItem) {
    const part = { type: 'output_text', text, annotations: [] };
    messageItem.content = [part];
    writeEvent('response.output_text.done', { type: 'response.output_text.done', item_id: messageItem.id, output_index: messageIndex, content_index: 0, text });
    writeEvent('response.content_part.done', { type: 'response.content_part.done', item_id: messageItem.id, output_index: messageIndex, content_index: 0, part });
    messageItem.status = 'completed';
    writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: messageIndex, item: messageItem });
  }
  for (const item of toolItems.values()) {
    writeEvent('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: item.outputIndex,
      arguments: item.arguments
    });
    item.status = 'completed';
    writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: item.outputIndex, item });
  }

  response.status = 'completed';
  writeEvent('response.completed', { type: 'response.completed', response });
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { chatToResponsesObject, translateChatStreamToResponses } from '../src/translate/chatToResponses.js';

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });
}

test('converts chat completion to responses object', () => {
  const response = chatToResponsesObject({
    id: 'chatcmpl-1',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sh', arguments: '{}' } }] } }]
  }, 'deepseek-v4-flash');
  assert.equal(response.object, 'response');
  assert.equal(response.output[0].content[0].text, 'hi');
  assert.equal(response.output[1].name, 'sh');
});

test('translates chat stream to responses events', async () => {
  const body = streamFromChunks([
    'data: {"choices":[{"delta":{"role":"assistant","content":"he"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const events = [];
  await translateChatStreamToResponses(body, 'deepseek-v4-flash', (event, data) => events.push({ event, data }));
  const types = events.map((item) => item.event);
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.completed'));
  const delta = events.find((item) => item.event === 'response.output_text.delta').data;
  assert.equal(delta.delta, 'he');
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/translate/chatToResponses.js`, verify GREEN.

## Task 7: Responses to Anthropic

**Files:**
- Create: `src/translate/responsesToAnthropic.js`
- Create: `test/responsesToAnthropic.test.js`

```js
import { textFromContent } from './responsesToChat.js';

export function responsesToolsToAnthropic(tools) {
  return (tools || [])
    .filter((tool) => tool?.type === 'function')
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.parameters || { type: 'object', properties: {} }
    }));
}

export function responsesToAnthropicRequest(body) {
  const system = [];
  const messages = [];
  if (body.instructions) system.push({ type: 'text', text: body.instructions });
  for (const item of body.input || []) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: [{ type: 'text', text: item }] });
      continue;
    }
    const role = item.role || 'user';
    if (role === 'developer' || role === 'system') {
      const text = textFromContent(item.content);
      if (text) system.push({ type: 'text', text });
      continue;
    }
    if (role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      };
      const last = messages[messages.length - 1];
      if (last?.role === 'user') last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (role === 'assistant') {
      const content = [];
      const text = textFromContent(item.content);
      if (text) content.push({ type: 'text', text });
      for (const part of item.content || []) {
        if (part?.type === 'function_call') {
          content.push({
            type: 'tool_use',
            id: part.call_id,
            name: part.name,
            input: safeJsonParse(part.arguments || '{}')
          });
        }
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: textFromContent(item.content) }] });
  }
  const request = {
    model: body.model,
    max_tokens: body.max_output_tokens || 8192,
    messages,
    stream: body.stream ?? false
  };
  if (system.length) request.system = system.length === 1 ? system[0].text : system;
  const tools = responsesToolsToAnthropic(body.tools);
  if (tools.length) request.tools = tools;
  if (body.tool_choice) request.tool_choice = body.tool_choice === 'required' ? { type: 'any' } : { type: 'auto' };
  return request;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToAnthropicRequest } from '../src/translate/responsesToAnthropic.js';

test('converts responses input to anthropic messages', () => {
  const request = responsesToAnthropicRequest({
    model: 'minimax-m3',
    instructions: 'Be brief.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' }] },
      { role: 'tool', call_id: 'call_1', output: 'ok' }
    ]
  });
  assert.equal(request.system, 'Be brief.');
  assert.equal(request.messages[0].content[0].text, 'hi');
  assert.equal(request.messages[1].content[0].type, 'tool_use');
  assert.equal(request.messages[2].content[0].type, 'tool_result');
});

test('converts function tools to anthropic tools', () => {
  const request = responsesToAnthropicRequest({
    model: 'x',
    tools: [{ type: 'function', name: 'shell_command', description: 'run', parameters: { type: 'object' } }]
  });
  assert.equal(request.tools[0].name, 'shell_command');
  assert.equal(request.tools[0].input_schema.type, 'object');
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/translate/responsesToAnthropic.js`, verify GREEN.

## Task 8: Anthropic to Responses

**Files:**
- Create: `src/translate/anthropicToResponses.js`
- Create: `test/anthropicToResponses.test.js`

```js
import { sseEvents } from '../sse.js';
import { newId } from './chatToResponses.js';

export function anthropicToResponsesObject(message, requestModel) {
  const output = [];
  for (const block of message.content || []) {
    if (block.type === 'text') {
      output.push({
        type: 'message',
        id: newId('msg'),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: block.text, annotations: [] }],
        logprobs: []
      });
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: newId('fc'),
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
        status: 'completed'
      });
    }
  }
  return {
    id: message.id || newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: message.model || requestModel,
    output,
    error: null,
    incomplete_details: null,
    ...(message.usage ? { usage: message.usage } : {})
  };
}

export async function translateAnthropicStreamToResponses(body, requestModel, writeEvent) {
  const response = {
    id: newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: requestModel,
    output: [],
    error: null,
    incomplete_details: null
  };
  writeEvent('response.created', { type: 'response.created', response });
  writeEvent('response.in_progress', { type: 'response.in_progress', response });

  let currentItem = null;
  let currentIndex = -1;
  let currentText = '';

  for await (const { data } of sseEvents(body)) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block.type === 'text') {
        currentItem = {
          id: newId('msg'),
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: []
        };
        currentIndex = response.output.length;
        response.output.push(currentItem);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: currentIndex, item: currentItem });
        const part = { type: 'output_text', text: '', annotations: [] };
        writeEvent('response.content_part.added', { type: 'response.content_part.added', item_id: currentItem.id, output_index: currentIndex, content_index: 0, part });
      } else if (block.type === 'tool_use') {
        currentItem = {
          id: newId('fc'),
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: '',
          status: 'in_progress',
          outputIndex: response.output.length
        };
        currentIndex = currentItem.outputIndex;
        response.output.push(currentItem);
        writeEvent('response.output_item.added', { type: 'response.output_item.added', output_index: currentIndex, item: currentItem });
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta || {};
      if (delta.type === 'text_delta' && currentItem?.type === 'message') {
        currentText += delta.text || '';
        writeEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: currentItem.id,
          output_index: currentIndex,
          content_index: 0,
          delta: delta.text
        });
      } else if (delta.type === 'input_json_delta' && currentItem?.type === 'function_call') {
        currentItem.arguments += delta.partial_json || '';
        writeEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: currentItem.id,
          output_index: currentIndex,
          delta: delta.partial_json || ''
        });
      }
    } else if (event.type === 'content_block_stop' && currentItem) {
      if (currentItem.type === 'message') {
        const text = currentText;
        currentItem.content = [{ type: 'output_text', text, annotations: [] }];
        const part = { type: 'output_text', text, annotations: [] };
        writeEvent('response.output_text.done', { type: 'response.output_text.done', item_id: currentItem.id, output_index: currentIndex, content_index: 0, text });
        writeEvent('response.content_part.done', { type: 'response.content_part.done', item_id: currentItem.id, output_index: currentIndex, content_index: 0, part });
      } else {
        writeEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: currentItem.id,
          output_index: currentIndex,
          arguments: currentItem.arguments
        });
      }
      currentItem.status = 'completed';
      writeEvent('response.output_item.done', { type: 'response.output_item.done', output_index: currentIndex, item: currentItem });
      currentItem = null;
      currentText = '';
    }
  }

  response.status = 'completed';
  writeEvent('response.completed', { type: 'response.completed', response });
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from '../src/translate/anthropicToResponses.js';

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });
}

test('converts anthropic message to responses object', () => {
  const response = anthropicToResponsesObject({
    id: 'msg_1',
    model: 'minimax-m3',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'toolu_1', name: 'sh', input: { cmd: 'pwd' } }
    ]
  }, 'minimax-m3');
  assert.equal(response.output[0].content[0].text, 'hi');
  assert.equal(response.output[1].name, 'sh');
  assert.equal(response.output[1].arguments, '{"cmd":"pwd"}');
});

test('translates anthropic stream to responses events', async () => {
  const body = streamFromChunks([
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]);
  const events = [];
  await translateAnthropicStreamToResponses(body, 'minimax-m3', (event, data) => events.push({ event, data }));
  assert.ok(events.some((item) => item.event === 'response.output_text.delta'));
  assert.ok(events.some((item) => item.event === 'response.completed'));
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/translate/anthropicToResponses.js`, verify GREEN.

## Task 9: Model Catalog

**Files:**
- Create: `src/catalog.js`
- Create: `test/catalog.test.js`

`src/catalog.js` builds Codex catalog entries from a compact template. The template mirrors the current Codex catalog fields; production code copies the real template from the existing `~/.codex/models.json` entry when generating the initial `catalog.json`.

```js
import { writeFileSync } from 'node:fs';
import { listRoutedModels } from './routes.js';

export function buildCatalog(config, template, modelMeta) {
  const models = listRoutedModels(config)
    .map((id, index) => ({
      ...template,
      slug: id,
      display_name: modelMeta[id]?.displayName || id,
      description: modelMeta[id]?.description || id,
      priority: 1000 + index,
      input_modalities: modelMeta[id]?.inputModalities || ['text']
    }));
  return { models };
}

export function writeCatalog(config, catalog) {
  writeFileSync(config.catalogFile, JSON.stringify(catalog, null, 2));
}
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalog, writeCatalog } from '../src/catalog.js';

const config = { apiBaseUrl: 'https://x/v1', models: {}, catalogFile: 'x.json' };
const template = { base_instructions: 'You are Codex.', context_window: 1048576 };
const meta = {
  'gpt-5.6-luna': { displayName: 'GPT 5.6 Luna', description: 'Luna', inputModalities: ['text', 'image'] },
  'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', description: 'Flash' }
};

test('builds catalog for routed models', () => {
  const catalog = buildCatalog(config, template, meta);
  assert.ok(catalog.models.some((m) => m.slug === 'gpt-5.6-luna'));
  assert.ok(catalog.models.some((m) => m.slug === 'deepseek-v4-flash'));
});

test('writes catalog file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-catalog-'));
  const file = path.join(dir, 'catalog.json');
  writeCatalog({ ...config, catalogFile: file }, buildCatalog(config, template, meta));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(parsed.models.length > 0);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/catalog.js`, verify GREEN.

## Task 10: HTTP Server

**Files:**
- Create: `src/modelMeta.js`
- Create: `src/server.js`
- Create: `src/main.js`
- Create: `test/server.test.js`

```js
import http from 'node:http';
import { resolveRoute, UnknownModelError } from './routes.js';
import { sseEncode } from './sse.js';
import { responsesToChatRequest } from './translate/responsesToChat.js';
import { chatToResponsesObject, translateChatStreamToResponses } from './translate/chatToResponses.js';
import { responsesToAnthropicRequest } from './translate/responsesToAnthropic.js';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from './translate/anthropicToResponses.js';

export function createRouter(config, { fetchImpl = globalThis.fetch } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, 200, config.catalog || { models: [] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJson(req);
        const route = resolveRoute(config, body.model);
        await forward(req, res, body, route, config, fetchImpl);
        return;
      }
      sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
    } catch (error) {
      if (error instanceof UnknownModelError) sendJson(res, 400, { error: { message: error.message } });
      else sendJson(res, 500, { error: { message: error.message || 'internal error' } });
    }
  });
}

async function forward(req, res, body, route, config, fetchImpl) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`
  };
  if (route.upstream === 'responses') {
    const upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    await relayUpstream(res, upstream);
    return;
  }
  if (route.upstream === 'chat') {
    const requestBody = responsesToChatRequest(body);
    const upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody) });
    if (!upstream.ok) {
      await relayError(res, upstream);
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      await translateChatStreamToResponses(upstream.body, body.model, (event, data) => res.write(sseEncode(event, data)));
      res.end();
    } else {
      const chat = await upstream.json();
      sendJson(res, upstream.status, chatToResponsesObject(chat, body.model));
    }
    return;
  }
  const requestBody = responsesToAnthropicRequest(body);
  const upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody) });
  if (!upstream.ok) {
    await relayError(res, upstream);
    return;
  }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await translateAnthropicStreamToResponses(upstream.body, body.model, (event, data) => res.write(sseEncode(event, data)));
    res.end();
  } else {
    const message = await upstream.json();
    sendJson(res, upstream.status, anthropicToResponsesObject(message, body.model));
  }
}

async function relayUpstream(res, upstream) {
  if (!upstream.ok) {
    await relayError(res, upstream);
    return;
  }
  const contentType = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, { 'content-type': contentType });
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(chunk);
  }
  res.end();
}

async function relayError(res, upstream) {
  const text = await upstream.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: { message: text.slice(0, 500) } };
  }
  sendJson(res, upstream.status, parsed);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

```

`src/modelMeta.js`:

```js
export const MODEL_META = {
  'gpt-5.6-luna': { displayName: 'GPT 5.6 Luna', description: 'GPT 5.6 Luna via OpenCode Go', inputModalities: ['text', 'image'] },
  'grok-4.5': { displayName: 'Grok 4.5', description: 'Grok 4.5 via OpenCode Go', inputModalities: ['text'] },
  'glm-5.2': { displayName: 'GLM-5.2', description: 'GLM-5.2 via OpenCode Go', inputModalities: ['text'] },
  'glm-5.1': { displayName: 'GLM-5.1', description: 'GLM-5.1 via OpenCode Go', inputModalities: ['text'] },
  'kimi-k3': { displayName: 'Kimi K3', description: 'Kimi K3 via OpenCode Go', inputModalities: ['text'] },
  'kimi-k2.7-code': { displayName: 'Kimi K2.7 Code', description: 'Kimi K2.7 Code via OpenCode Go', inputModalities: ['text'] },
  'kimi-k2.6': { displayName: 'Kimi K2.6', description: 'Kimi K2.6 via OpenCode Go', inputModalities: ['text'] },
  'deepseek-v4-pro': { displayName: 'DeepSeek V4 Pro', description: 'DeepSeek V4 Pro via OpenCode Go', inputModalities: ['text'] },
  'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', description: 'DeepSeek V4 Flash via OpenCode Go', inputModalities: ['text'] },
  'mimo-v2.5': { displayName: 'MiMo-V2.5', description: 'MiMo-V2.5 via OpenCode Go', inputModalities: ['text'] },
  'mimo-v2.5-pro': { displayName: 'MiMo-V2.5-Pro', description: 'MiMo-V2.5-Pro via OpenCode Go', inputModalities: ['text'] },
  'hy3': { displayName: 'Hy3', description: 'Hy3 via OpenCode Go', inputModalities: ['text'] },
  'minimax-m3': { displayName: 'MiniMax M3', description: 'MiniMax M3 via OpenCode Go', inputModalities: ['text'] },
  'minimax-m2.7': { displayName: 'MiniMax M2.7', description: 'MiniMax M2.7 via OpenCode Go', inputModalities: ['text'] },
  'minimax-m2.5': { displayName: 'MiniMax M2.5', description: 'MiniMax M2.5 via OpenCode Go', inputModalities: ['text'] },
  'qwen3.7-max': { displayName: 'Qwen3.7 Max', description: 'Qwen3.7 Max via OpenCode Go', inputModalities: ['text'] },
  'qwen3.7-plus': { displayName: 'Qwen3.7 Plus', description: 'Qwen3.7 Plus via OpenCode Go', inputModalities: ['text'] },
  'qwen3.6-plus': { displayName: 'Qwen3.6 Plus', description: 'Qwen3.6 Plus via OpenCode Go', inputModalities: ['text'] }
};
```

`src/main.js`:

```js
import { loadConfig } from './config.js';
import { createRouter } from './server.js';
import { buildCatalog, writeCatalog } from './catalog.js';
import { MODEL_META } from './modelMeta.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const template = JSON.parse(readFileSync(path.join(rootDir, 'catalog-template.json'), 'utf8'));
const catalog = buildCatalog(config, template, MODEL_META);
writeCatalog(config, catalog);
config.catalog = catalog;
const server = createRouter(config);
server.listen(config.port, config.host, () => {
  console.log(`codex-opencode-go-router listening on http://${config.host}:${config.port}`);
});
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRouter } from '../src/server.js';

async function withServer(config, fetchImpl, fn) {
  const server = createRouter(config, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('healthz returns ok', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}, catalog: { models: [] } }, async () => {}, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });
});

test('models endpoint returns catalog', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}, catalog: { models: [{ slug: 'x' }] } }, async () => {}, async (base) => {
    const res = await fetch(`${base}/v1/models`);
    const data = await res.json();
    assert.equal(data.models[0].slug, 'x');
  });
});

test('unknown model returns 400', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, async () => {}, async (base) => {
    const res = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nope' }) });
    assert.equal(res.status, 400);
  });
});

test('chat route converts response', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    id: 'chatcmpl-1',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ message: { role: 'assistant', content: 'ok' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(data.object, 'response');
    assert.equal(data.output[0].content[0].text, 'ok');
  });
});
```

- [ ] Write tests, verify RED.
- [ ] Implement `src/server.js`, verify GREEN.

## Task 11: Template, Smoke Test, README

**Files:**
- Create: `catalog-template.json` (generated from `~/.codex/models.json` deepseek-v4-flash entry)
- Create: `scripts/smoke.mjs`
- Create: `README.md`

`scripts/smoke.mjs` starts the router with a fake key, calls `/healthz` and `/v1/models`, and prints results.

- [ ] Generate template with a Node script, verify `catalog-template.json` has `slug`, `base_instructions`, and `model_messages`.
- [ ] Run `npm test`; all tests pass.
- [ ] Run `node scripts/smoke.mjs`; smoke test passes.
- [ ] Update `~/.codex/config.toml` `model_catalog_json` to `C:/Users/cheng/Documents/Codex/2026-08-03/new-chat-2/outputs/codex-router/catalog.json`.
- [ ] Write README with start command, env var, and cc-switch shutdown instructions.

## Self-Review

- All spec sections map to a task: endpoints (Task 10), route table (Task 3), config/key (Task 2), translation (Tasks 5-8), catalog (Tasks 9/11), testing (all tasks), non-goals preserved.
- Placeholder scan: `MODEL_META` is defined in `src/modelMeta.js` in Task 10; `catalog-template.json` is generated in Task 11.
- Type consistency: `resolveRoute`, `responsesToChatRequest`, `chatToResponsesObject`, `responsesToAnthropicRequest`, `anthropicToResponsesObject`, `buildCatalog`, and `createRouter` are used consistently across tasks.
