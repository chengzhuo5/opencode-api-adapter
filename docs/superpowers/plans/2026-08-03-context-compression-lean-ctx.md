# Context Compression Layer (lean-ctx) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在路由中按对话轮次做确定性增量上下文压缩，后端为本地 lean-ctx daemon，保持 DeepSeek 前缀缓存命中并提供 CCR 原文取回。

**Architecture:** 路由新增 `src/compression.js`（切轮、指纹、LRU 缓存、CCR 存档、增量拼装）和 `src/leanCtxClient.js`（封装 npm 依赖 lean-ctx-sdk）；转发前调用 `compressInput`，压缩结果仍是标准 Responses input；lean-ctx 不可达时降级不压缩。

**Tech Stack:** Node ESM、node:test、lean-ctx-sdk（HTTP 客户端）、node:crypto。

**Note:** 项目已有 Git（origin=GitHub chengzhuo5/opencode-api-adapter），每任务完成后 commit + push。

---

## File Structure

- Create: `src/leanCtxClient.js` — lean-ctx-sdk 封装（可注入 fetch、错误归一化）。
- Create: `src/compression.js` — splitTurns / turnFingerprint / compressTurn / compressInput / CCR。
- Modify: `src/config.js` — DEFAULT_CONFIG 增加 compress。
- Modify: `src/server.js` / `src/fallback.js` — 转发前调用 compressInput。
- Modify: `src/logger.js`（无需改，事件由调用方传入）。
- Create: `test/leanCtxClient.test.js`、`test/compression.test.js`。
- Modify: `test/config.test.js`、`test/server.test.js`（配置与集成回归）。
- Docs: README.md / README.zh-CN.md 压缩说明。

---

### Task 1: 安装依赖 + lean-ctx 客户端封装

**Files:**
- Modify: `package.json`（新增 lean-ctx-sdk）
- Create: `src/leanCtxClient.js`
- Create: `test/leanCtxClient.test.js`

- [ ] **Step 1: 安装依赖**

Run: `npm install lean-ctx-sdk@0.3.0 --save`
Expected: package.json 出现 `"lean-ctx-sdk": "^0.3.0"`。

- [ ] **Step 2: 写失败测试（客户端封装）**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createLeanCtxClient } from '../src/leanCtxClient.js';

async function mockServer(handler) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    await handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('compress posts messages and returns compressed text + stats', async () => {
  const mock = await mockServer(async (req, res, body) => {
    assert.equal(req.url, '/v1/compress');
    const payload = JSON.parse(body);
    assert.equal(payload.messages[0].content, 'big payload');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ role: 'user', content: 'tiny' }], stats: { saved_tokens: 100 } }));
  });
  try {
    const client = createLeanCtxClient({ baseUrl: mock.base, token: '' });
    const result = await client.compress([{ role: 'user', content: 'big payload' }], 'deepseek-v4-flash');
    assert.equal(result.messages[0].content, 'tiny');
    assert.equal(result.stats.saved_tokens, 100);
  } finally {
    mock.close();
  }
});

test('compress rejects when daemon is unreachable', async () => {
  const client = createLeanCtxClient({ baseUrl: 'http://127.0.0.1:1', token: '', timeoutMs: 500 });
  await assert.rejects(() => client.compress([{ role: 'user', content: 'x' }], 'deepseek-v4-flash'));
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/leanCtxClient.test.js`
Expected: FAIL（Cannot find module '../src/leanCtxClient.js'）

- [ ] **Step 4: 实现 src/leanCtxClient.js**

```js
import { ProxyClient } from 'lean-ctx-sdk';

export function createLeanCtxClient(options = {}) {
  const client = new ProxyClient({
    baseUrl: options.baseUrl,
    token: options.token,
    timeoutMs: options.timeoutMs ?? 30000
  });
  return {
    async compress(messages, model) {
      const result = await client.compress(messages, model);
      return { messages: result.messages, stats: result.stats || {} };
    },
    _client: client
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/leanCtxClient.test.js`
Expected: PASS（2 个）

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/leanCtxClient.js test/leanCtxClient.test.js
git commit -m "feat: add lean-ctx client wrapper"
git push origin master
```

---

### Task 2: 轮次切分与指纹

**Files:**
- Create: `src/compression.js`（先实现 splitTurns / turnFingerprint）
- Create: `test/compression.test.js`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTurns, turnFingerprint } from '../src/compression.js';

test('splitTurns keeps pre-user developer prefix and splits on user messages', () => {
  const input = [
    { type: 'message', role: 'developer', id: 'd1', content: [{ type: 'input_text', text: 'sys' }] },
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'a' }] },
    { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'b', annotations: [] }] },
    { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'ok' },
    { type: 'message', role: 'user', id: 'u2', content: [{ type: 'input_text', text: 'c' }] }
  ];
  const { prefix, turns } = splitTurns(input);
  assert.equal(prefix.length, 1);
  assert.equal(prefix[0].role, 'developer');
  assert.equal(turns.length, 2);
  assert.equal(turns[0][0].id, 'u1');
  assert.equal(turns[0].length, 4);
  assert.equal(turns[1][0].id, 'u2');
});

test('turnFingerprint is deterministic and content-sensitive', () => {
  const t = [{ role: 'user', content: 'hello' }];
  assert.equal(turnFingerprint(t), turnFingerprint(t));
  assert.notEqual(turnFingerprint(t), turnFingerprint([{ role: 'user', content: 'world' }]));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/compression.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

在 `src/compression.js` 写入：

```js
import { createHash } from 'node:crypto';

export function splitTurns(input) {
  const items = Array.isArray(input) ? input : [];
  const prefix = [];
  const turns = [];
  let current = null;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const isUser = item.type === 'message' && item.role === 'user';
    if (isUser) {
      current = [item];
      turns.push(current);
      continue;
    }
    if (current) {
      current.push(item);
    } else {
      prefix.push(item);
    }
  }
  return { prefix, turns };
}

export function turnFingerprint(turn) {
  return createHash('sha256').update(JSON.stringify(turn)).digest('hex');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/compression.test.js`
Expected: PASS（2 个）

- [ ] **Step 5: Commit**

```bash
git add src/compression.js test/compression.test.js
git commit -m "feat: add turn splitting and fingerprint"
git push origin master
```

---

### Task 3: 单轮转 chat messages + 压缩调用

**Files:**
- Modify: `src/compression.js`（turnToMessages、compressTurn）
- Modify: `test/compression.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { turnToMessages, compressTurn } from '../src/compression.js';

test('turnToMessages flattens a turn into one user message with tool outputs', () => {
  const turn = [
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'run it' }] },
    { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'ok' }
  ];
  const messages = turnToMessages(turn);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].content.includes('run it'));
  assert.ok(messages[0].content.includes('sh'));
  assert.ok(messages[0].content.includes('ok'));
});

test('compressTurn calls client and returns compressed text', async () => {
  let calledModel;
  const client = {
    compress: async (messages, model) => {
      calledModel = model;
      return { messages: [{ role: 'user', content: 'tiny' }], stats: { saved_tokens: 10 } };
    }
  };
  const result = await compressTurn({ turn: [{ role: 'user', content: 'big' }], model: 'deepseek-v4-flash', client });
  assert.equal(calledModel, 'deepseek-v4-flash');
  assert.equal(result.text, 'tiny');
  assert.equal(result.stats.saved_tokens, 10);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/compression.test.js`
Expected: FAIL（turnToMessages / compressTurn 未定义）

- [ ] **Step 3: 实现**

在 `src/compression.js` 追加：

```js
export function turnToMessages(turn) {
  const parts = [];
  for (const item of turn) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      const text = (Array.isArray(item.content) ? item.content : [])
        .map((p) => (p && typeof p === 'object' ? p.text ?? '' : ''))
        .join('\n');
      if (text) parts.push(item.role === 'user' ? `user: ${text}` : `assistant: ${text}`);
    } else if (item.type === 'function_call') {
      parts.push(`tool_call ${item.name}: ${item.arguments || ''}`);
    } else if (item.type === 'function_call_output') {
      parts.push(`tool_output: ${typeof item.output === 'string' ? item.output : JSON.stringify(item.output)}`);
    }
  }
  return [{ role: 'user', content: parts.join('\n') || '[empty turn]' }];
}

export async function compressTurn({ turn, model, client }) {
  const messages = turnToMessages(turn);
  const result = await client.compress(messages, model);
  const text = result.messages?.[0]?.content;
  if (typeof text !== 'string') throw new Error('lean-ctx returned non-string compressed content');
  return { text, stats: result.stats || {} };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/compression.test.js`
Expected: PASS（4 个）

- [ ] **Step 5: Commit**

```bash
git add src/compression.js test/compression.test.js
git commit -m "feat: add turn compression helpers"
git push origin master
```

---

### Task 4: 增量拼装 + LRU 缓存 + CCR

**Files:**
- Modify: `src/compression.js`（compressInput、storeTurn、LRU）
- Modify: `test/compression.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { compressInput } from '../src/compression.js';

test('compressInput reuses cached turns and compresses only new turns', async () => {
  let calls = 0;
  const client = {
    compress: async (messages) => { calls++; return { messages: [{ role: 'user', content: `AC${calls}` }], stats: {} }; }
  };
  const ctx = { client, model: 'deepseek-v4-flash', storeDir: null, cache: new Map(), log: () => {} };
  const input1 = [{ type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'a' }] }];
  const out1 = await compressInput(input1, ctx);
  const input2 = [
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'a' }] },
    { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'b', annotations: [] }] },
    { type: 'message', role: 'user', id: 'u2', content: [{ type: 'input_text', text: 'c' }] }
  ];
  const out2 = await compressInput(input2, ctx);
  assert.equal(calls, 2, 'second request should only compress the new turn');
  assert.equal(out2[0].content[0].text, 'AC1');
  assert.equal(out2[1].content[0].text, 'AC2');
});

test('compressInput archives originals and leaves ctx markers', async () => {
  const client = { compress: async () => ({ messages: [{ role: 'user', content: 'tiny' }], stats: {} }) };
  const ctx = { client, model: 'x', storeDir: tmpdir(), cache: new Map(), log: () => {} };
  const input = [{ type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'secret' }] }];
  const out = await compressInput(input, ctx);
  const text = out[0].content[0].text;
  assert.match(text, /\[compressed turn #1\]/);
  assert.match(text, /\[\[ctx:[a-f0-9]{64}\|.+\]\]/);
  const match = text.match(/ctx:[a-f0-9]{64}/);
  const file = `${ctx.storeDir}/${match[0].slice(4)}.json`;
  assert.equal(existsSync(file), true);
  const archived = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(archived[0].content[0].text, 'secret');
});
```

（测试文件顶部需导入 `tmpdir`、`existsSync`、`readFileSync`。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/compression.test.js`
Expected: FAIL（compressInput 未定义）

- [ ] **Step 3: 实现**

在 `src/compression.js` 追加：

```js
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_SIZE = 1000;

export function storeTurn(turn, storeDir) {
  if (!storeDir) return null;
  const hash = turnFingerprint(turn);
  const dir = storeDir;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(turn));
  return file;
}

export async function compressInput(input, ctx) {
  const { prefix, turns } = splitTurns(input);
  const compressed = [...prefix];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const fingerprint = turnFingerprint(turn);
    let text = ctx.cache.get(fingerprint);
    let cached = true;
    if (text === undefined) {
      const result = await compressTurn({ turn, model: ctx.model, client: ctx.client });
      text = result.text;
      ctx.cache.set(fingerprint, text);
      if (ctx.cache.size > (ctx.cacheSize ?? DEFAULT_CACHE_SIZE)) {
        const first = ctx.cache.keys().next().value;
        ctx.cache.delete(first);
      }
      cached = false;
    }
    const archiveFile = storeTurn(turn, ctx.storeDir);
    const marker = archiveFile ? ` [[ctx:${fingerprint}|${archiveFile}]]` : '';
    compressed.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `[compressed turn #${i + 1}] ${text}${marker}` }]
    });
    ctx.log?.({
      event: 'context_compression',
      model: ctx.model,
      turn_index: i + 1,
      cached,
      chars_before: JSON.stringify(turn).length,
      chars_after: text.length
    });
  }
  return compressed;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/compression.test.js`
Expected: PASS（6 个）

- [ ] **Step 5: Commit**

```bash
git add src/compression.js test/compression.test.js
git commit -m "feat: incremental turn compression with CCR archive"
git push origin master
```

---

### Task 5: 配置 + 转发集成 + 降级

**Files:**
- Modify: `src/config.js`、`src/server.js`、`src/fallback.js`
- Modify: `test/config.test.js`、`test/server.test.js`、`test/fallback.test.js`

- [ ] **Step 1: 更新配置默认值与测试**

在 `src/config.js` 的 DEFAULT_CONFIG 增加：

```js
compress: {
  enabled: true,
  backend: 'lean-ctx',
  baseUrl: undefined,
  token: '',
  storeDir: 'ctx-store',
  cacheSize: 1000,
  timeoutMs: 30000
}
```

并在 loadConfig 合并：`compress: { ...DEFAULT_CONFIG.compress, ...(raw.compress || {}) }`。

更新 `test/config.test.js`：断言默认 `cfg.compress.backend === 'lean-ctx'` 且 `cfg.compress.enabled === true`。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL（compress 未定义）

- [ ] **Step 3: 实现配置**

按 Step 1 修改 `src/config.js`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/config.test.js`
Expected: PASS

- [ ] **Step 5: 写转发集成测试（fallback）**

在 `test/fallback.test.js` 追加：

```js
test('compression is applied before forwarding and falls back when daemon is down', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'x' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // 不可达 daemon：压缩层应降级为原样转发
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}, compress: { enabled: true, baseUrl: 'http://127.0.0.1:1', token: '', storeDir: null, timeoutMs: 200 } }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }) });
    assert.equal(res.status, 200);
  });
  assert.equal(calls[0].body.input[0].role, 'user');
});
```

（需要 `compressInput` 在 daemon 不可达时返回原 input，且不抛错。）

- [ ] **Step 6: 实现转发集成**

在 `src/compression.js` 增加入口：

```js
export async function maybeCompressInput(body, config, client, storeDir, cache) {
  if (!config?.compress?.enabled || config.compress.backend !== 'lean-ctx') return body;
  try {
    const ctx = { client, model: body.model, storeDir, cache, log: (e) => logEvent(config, e) };
    const input = await compressInput(body.input, ctx);
    return { ...body, input };
  } catch {
    logEvent(config, { event: 'context_compression', model: body.model, reason: 'backend_unavailable' });
    return body;
  }
}
```

在 `src/fallback.js` 的 `forwardWithFallback` 开头（缓存命中分支之前）与 `src/server.js` messages 分支之外调用：

- `src/server.js`：在 `forward` 非 messages 分支里：`const upgraded = maybeUpgradeModel(body); const compressed = await maybeCompressInput(upgraded, config, config._leanCtxClient, config._ctxStoreDir, config._ctxCache); await forwardWithFallback(res, compressed, route, config, fetchImpl, body.model);`
- 压缩 client/cache/storeDir 由 `createRouter` 初始化：`config._leanCtxClient = createLeanCtxClient({ baseUrl: config.compress.baseUrl, token: config.compress.token, timeoutMs: config.compress.timeoutMs }); config._ctxCache = new Map(); config._ctxStoreDir = config.compress.storeDir ? path.resolve(rootDir, config.compress.storeDir) : null;`
- `src/server.js` 顶部 import `maybeCompressInput`、`createLeanCtxClient`、`path`。

- [ ] **Step 7: 运行全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/compression.js src/server.js src/fallback.js test/config.test.js test/fallback.test.js test/server.test.js
git commit -m "feat: integrate turn compression into forwarding with graceful degradation"
git push origin master
```

---

### Task 6: 回归 + 文档

**Files:**
- Modify: `README.md`、`README.zh-CN.md`

- [ ] **Step 1: 全量回归**

Run: `npm test`、`npm run smoke`、`npm run switch:gpt-ds-gpt-ds`、`npm run switch:ds-gpt-ds-gpt`
Expected: 全部 PASS（压缩关闭/daemon 缺失场景已覆盖）

- [ ] **Step 2: 更新 README**

增加“上下文压缩”章节：依赖 lean-ctx daemon（安装命令）、config.compress 配置、轮次增量原理、CCR 标记与取回、降级行为。

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: document context compression layer"
git push origin master
```

- [ ] **Step 4: 记录变更清单（含未提交文件检查）**

Run: `git status --short`，确认干净。
