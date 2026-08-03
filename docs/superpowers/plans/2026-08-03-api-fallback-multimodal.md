# API Fallback + DeepSeek Multimodal Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让非 Anthropic 模型统一“先 Responses、失败自动降级 Chat Completions”，并让 DeepSeek 携带图片时自动改用 gpt-5.6-luna。

**Architecture:** 转发层增加 fallback 模块 `src/fallback.js`，负责图片检测、模型升级、responses→chat 降级和共享响应管道；`src/routes.js` 把 chat 主路由归并为 responses（messages 维持）；`src/server.js` 只保留 messages 直连，其余统一走 fallback。

**Tech Stack:** Node.js 内置 http/fetch、node:test、ESM。

**Note:** 本项目目录无 Git 仓库，所有 “Commit” 步骤改为记录变更清单，不执行 git。

---

## File Structure

- Create: `src/fallback.js` — 图片检测、deepseek 模型升级、responses→chat 降级、共享 relay/sendJson/pipeBody。
- Modify: `src/routes.js` — DEFAULT_MODEL_ROUTES chat→responses；resolveRoute 对非 messages 归一 responses。
- Modify: `src/server.js` — messages 分支保留；其余调用 fallback。
- Create: `test/fallback.test.js` — fallback 与图片降级测试。
- Modify: `test/routes.test.js` — 路由断言更新。
- Modify: `test/server.test.js` — chat 相关测试改为 fallback 语义。
- Docs: `docs/superpowers/specs/2026-08-03-api-fallback-multimodal-design.md`（已存在）。

---

### Task 1: fallback 模块（图片检测 + 模型升级）

**Files:**
- Create: `src/fallback.js`
- Test: `test/fallback.test.js`

- [ ] **Step 1: 写失败测试（hasImageInput / maybeUpgradeModel）**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasImageInput, maybeUpgradeModel } from '../src/fallback.js';

test('hasImageInput detects input_image blocks', () => {
  const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'https://x/1.png' }] }] };
  assert.equal(hasImageInput(body), true);
});

test('hasImageInput detects image_url and file_id variants', () => {
  const a = { input: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/1.png' } }] }] };
  const b = { input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] };
  assert.equal(hasImageInput(a), true);
  assert.equal(hasImageInput(b), true);
});

test('hasImageInput returns false without images', () => {
  assert.equal(hasImageInput({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }), false);
  assert.equal(hasImageInput({ input: 'hi' }), false);
  assert.equal(hasImageInput({}), false);
});

test('maybeUpgradeModel upgrades deepseek with image to luna', () => {
  const body = { model: 'deepseek-v4-flash', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/1.png' }] }] };
  const upgraded = maybeUpgradeModel(body);
  assert.equal(upgraded.model, 'gpt-5.6-luna');
  assert.deepEqual(upgraded.input, body.input);
});

test('maybeUpgradeModel keeps deepseek without image', () => {
  const body = { model: 'deepseek-v4-flash', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
  assert.equal(maybeUpgradeModel(body), body);
});

test('maybeUpgradeModel keeps other models with image', () => {
  const body = { model: 'kimi-k3', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/1.png' }] }] };
  assert.equal(maybeUpgradeModel(body), body);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/fallback.test.js`
Expected: FAIL（Cannot find module '../src/fallback.js'）

- [ ] **Step 3: 实现 hasImageInput / maybeUpgradeModel**

在 `src/fallback.js` 写入：

```js
const DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);
const MULTIMODAL_FALLBACK_MODEL = 'gpt-5.6-luna';

export function hasImageInput(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return false;
  return input.some((item) => {
    if (typeof item === 'string' || !item || typeof item !== 'object') return false;
    const content = item.content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      return part.type === 'input_image'
        || part.type === 'image_url'
        || Object.hasOwn(part, 'image_url')
        || Object.hasOwn(part, 'file_id');
    });
  });
}

export function maybeUpgradeModel(body) {
  if (!body || !DEEPSEEK_MODELS.has(body.model)) return body;
  if (!hasImageInput(body)) return body;
  return { ...body, model: MULTIMODAL_FALLBACK_MODEL };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/fallback.test.js`
Expected: PASS（5 个测试）

- [ ] **Step 5: 记录变更（无 git）**

变更：新增 `src/fallback.js`、`test/fallback.test.js`。

---

### Task 2: fallback 转发（responses → chat）

**Files:**
- Modify: `src/fallback.js`（追加转发与 relay 辅助）
- Test: `test/fallback.test.js`（追加）

- [ ] **Step 1: 写失败测试（非流式降级、网络错误降级、成功不透传、双失败透传）**

```js
import { once } from 'node:events';
import { createRouter } from '../src/server.js';

async function withServer(config, fetchImpl, fn) {
  const server = createRouter(config, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

test('fallback retries chat when responses returns 500', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.object, 'response');
    assert.equal(data.output[0].content[0].text, 'ok');
  });
  assert.equal(calls[0].url, 'https://x/v1/responses');
  assert.equal(calls[1].url, 'https://x/v1/chat/completions');
});

test('fallback retries chat on network error', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/responses')) throw new Error('network down');
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(data.object, 'response');
  });
  assert.equal(calls.length, 2);
});

test('fallback relays responses when it succeeds', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }) });
    const data = await res.json();
    assert.equal(data.id, 'resp_1');
  });
  assert.equal(calls, 1);
});

test('fallback relays chat error when both fail', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/responses')) return new Response(JSON.stringify({ error: { message: 'resp fail' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: 'chat fail' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error.message, 'chat fail');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/fallback.test.js`
Expected: 前 5 个通过，新增 4 个中“fallback retries”类失败（server 尚未接入 fallback，responses 500 会被原样 relay）。

- [ ] **Step 3: 实现 forwardWithFallback 与 relay 辅助**

在 `src/fallback.js` 追加：

```js
import { responsesToChatRequest } from './translate/responsesToChat.js';
import { chatToResponsesObject, translateChatStreamToResponses } from './translate/chatToResponses.js';
import { normalizeResponsesRequest } from './translate/responsesContext.js';

export async function forwardWithFallback(res, body, route, config, fetchImpl, displayModel = body.model) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
  const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
  const requestBody = normalizeResponsesRequest(body);
  let upstream;
  try {
    upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal });
  } catch {
    await forwardChat(res, body, config, fetchImpl, displayModel);
    return;
  }
  if (upstream.ok) {
    await relayUpstream(res, upstream);
    return;
  }
  await forwardChat(res, body, config, fetchImpl, displayModel);
}

async function forwardChat(res, body, config, fetchImpl, displayModel) {
  const chatBody = responsesToChatRequest(body);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
  const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
  const endpoint = `${config.apiBaseUrl}/chat/completions`;
  let upstream;
  try {
    upstream = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(chatBody), signal });
  } catch (error) {
    sendJson(res, 502, { error: { message: error.message || 'chat fallback failed' } });
    return;
  }
  if (!upstream.ok) {
    await relayError(res, upstream);
    return;
  }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await translateChatStreamToResponses(upstream.body, displayModel, (event, data) => res.write(sseEncode(event, data)));
    res.end();
    return;
  }
  const chat = await upstream.json();
  sendJson(res, upstream.status, chatToResponsesObject(chat, displayModel));
}

export async function relayUpstream(res, upstream) {
  if (!upstream.ok) {
    await relayError(res, upstream);
    return;
  }
  const contentType = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, { 'content-type': contentType });
  await pipeBody(upstream.body, res);
  res.end();
}

export async function relayError(res, upstream) {
  const text = await upstream.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: { message: text.slice(0, 500) } }; }
  sendJson(res, upstream.status, parsed);
}

export async function pipeBody(body, res) {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
```

同时给 `src/fallback.js` 顶部加：`import { sseEncode } from './sse.js';`

- [ ] **Step 4: 运行测试确认预期状态**

Run: `node --test test/fallback.test.js`
Expected: 前 5 个（hasImageInput/maybeUpgradeModel）PASS；新增 4 个 server 集成测试 FAIL（server 尚未接入 fallback，responses 500 被原样 relay）。这些集成测试在 Task 3 接入后转绿。

- [ ] **Step 5: 记录变更（无 git）**

变更：`src/fallback.js` 追加转发逻辑。

---

### Task 3: 路由归并 + server 接入

**Files:**
- Modify: `src/routes.js`
- Modify: `test/routes.test.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: 更新路由测试（先改断言）**

把 `test/routes.test.js` 中：

```js
test('routes deepseek to chat completions', () => {
  const route = resolveRoute(config, 'deepseek-v4-flash');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/chat/completions');
});
```

改为：

```js
test('routes deepseek to responses with chat fallback', () => {
  const route = resolveRoute(config, 'deepseek-v4-flash');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/responses');
});

test('config chat override is normalized to responses', () => {
  const cfg = { apiBaseUrl: 'https://x/v1', models: { 'deepseek-v4-flash': { upstream: 'chat' } } };
  const route = resolveRoute(cfg, 'deepseek-v4-flash');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://x/v1/responses');
});
```

- [ ] **Step 2: 运行路由测试确认失败**

Run: `node --test test/routes.test.js`
Expected: “routes deepseek to chat completions” FAIL（endpoint 仍 chat/completions）。

- [ ] **Step 3: 修改 src/routes.js**

把 DEFAULT_MODEL_ROUTES 中所有非 messages 模型的值从 `chat` 改为 `responses`：

```js
export const DEFAULT_MODEL_ROUTES = {
  'gpt-5.6-luna': 'responses',
  'grok-4.5': 'responses',
  'glm-5.2': 'responses',
  'glm-5.1': 'responses',
  'kimi-k3': 'responses',
  'kimi-k2.7-code': 'responses',
  'kimi-k2.6': 'responses',
  'deepseek-v4-pro': 'responses',
  'deepseek-v4-flash': 'responses',
  'mimo-v2.5': 'responses',
  'mimo-v2.5-pro': 'responses',
  'hy3': 'responses',
  'minimax-m3': 'messages',
  'minimax-m2.7': 'messages',
  'minimax-m2.5': 'messages',
  'qwen3.7-max': 'messages',
  'qwen3.7-plus': 'messages',
  'qwen3.6-plus': 'messages'
};
```

把 resolveRoute 改为对非 messages 归一：

```js
export function resolveRoute(config, model) {
  const upstream = config.models?.[model]?.upstream ?? DEFAULT_MODEL_ROUTES[model];
  if (!upstream) throw new UnknownModelError(model);
  const effective = upstream === 'messages' ? 'messages' : 'responses';
  const suffix = effective === 'messages' ? 'messages' : 'responses';
  return { model, upstream: effective, endpoint: `${config.apiBaseUrl}/${suffix}` };
}
```

- [ ] **Step 4: 运行路由测试确认通过**

Run: `node --test test/routes.test.js`
Expected: PASS

- [ ] **Step 5: 修改 src/server.js**

- 顶部 import 改为：

```js
import http from 'node:http';
import { resolveRoute, UnknownModelError } from './routes.js';
import { responsesToAnthropicRequest } from './translate/responsesToAnthropic.js';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from './translate/anthropicToResponses.js';
import { maybeUpgradeModel, forwardWithFallback, relayUpstream, relayError, sendJson } from './fallback.js';
```

- forward 函数替换为：

```js
async function forward(res, body, route, config, fetchImpl) {
  if (route.upstream === 'messages') {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    };
    const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
    const requestBody = responsesToAnthropicRequest(body);
    const upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal });
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
    return;
  }
  const upgraded = maybeUpgradeModel(body);
  await forwardWithFallback(res, upgraded, route, config, fetchImpl, body.model);
}
```

- 删除 server.js 中的 `relayUpstream`、`relayError`、`pipeBody`、`sendJson` 私有函数（已移到 fallback.js 导出）；保留 `readJson`；顶部补回 `import { sseEncode } from './sse.js';`（messages 流式使用）。

- [ ] **Step 6: 更新 server.test.js 的 chat/round-trip 测试**

把 “chat route converts response” 测试改为 fallback 语义（responses 500 → chat 成功）：

```js
test('chat route falls back to chat completions when responses fails', async () => {
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'resp fail' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] })
    });
    const data = await res.json();
    assert.equal(data.object, 'response');
    assert.equal(data.output[0].content[0].text, 'ok');
  });
});
```

把 “round-trips context when switching between chat and responses routes” 中 fetchImpl 改为：对 `/responses` 返回 500，对 `/chat/completions` 返回 chat completion，对 `/messages` 返回 anthropic。原测试里 `calls[0].url` 现在应等于 `https://x/v1/responses`（deepseek 先打 responses），`calls[1]` 才是 `/chat/completions`；同步调整断言索引。

- [ ] **Step 7: 运行全量测试**

Run: `npm test`
Expected: 全部通过（含 fallback.test.js 9 个）。

- [ ] **Step 8: 记录变更（无 git）**

变更：`src/routes.js`、`src/server.js`、`test/routes.test.js`、`test/server.test.js`。

---

### Task 4: DeepSeek 图片降级集成测试

**Files:**
- Test: `test/fallback.test.js`（追加）

- [ ] **Step 1: 写失败测试（deepseek+图片 → 上游收到 luna，响应 model 保持 deepseek）**

```js
test('deepseek image request is upgraded to luna and response keeps original model', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen = body;
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'https://x/1.png' }] }]
      })
    });
    const data = await res.json();
    assert.equal(data.id, 'resp_1');
  });
  assert.equal(seen.model, 'gpt-5.6-luna');
  assert.equal(seen.input[0].content[1].type, 'input_image');
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `node --test test/fallback.test.js`
Expected: PASS

- [ ] **Step 3: 记录变更（无 git）**

变更：`test/fallback.test.js` 追加集成测试。

---

### Task 5: 回归与验收

**Files:**
- Run: `npm test`
- Run: `npm run smoke`
- Run: `npm run switch:gpt-ds-gpt-ds`
- Run: `npm run switch:ds-gpt-ds-gpt`

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 2: smoke + 两个切换脚本**

Run: `npm run smoke`、`npm run switch:gpt-ds-gpt-ds`、`npm run switch:ds-gpt-ds-gpt`
Expected: 均 PASS。

- [ ] **Step 3: 更新 spec/README 说明 fallback 与多模态降级行为（简短）**

在 README 路由表部分补充：非 messages 模型统一先 responses、失败自动降级 chat；deepseek 带图自动换 gpt-5.6-luna。

- [ ] **Step 4: 记录变更（无 git）**

变更：README.md（如适用）。
