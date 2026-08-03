# Codex OpenCode Go Router: API Fallback + DeepSeek Multimodal Fallback Design

Date: 2026-08-03
Status: Approved by user (2026-08-03)

## Goal

1. 让非 Anthropic 模型无需区分 responses/chat：优先使用 Responses 端点，请求阶段失败（网络错误、超时、任何非 2xx）时自动降级到 Chat Completions，并把 Chat 响应转回 Responses 格式。
2. DeepSeek（`deepseek-v4-pro` / `deepseek-v4-flash`）请求携带图片时，自动把模型替换为 `gpt-5.6-luna` 再走统一 fallback 流程。

非目标：
- Anthropic `messages` 端点模型（MiniMax/Qwen）不纳入 fallback，维持现状。
- 不做配置驱动的自定义 fallback 列表。
- 不改动 Codex 侧配置。

## 现状

- `src/routes.js` 把模型硬编码为 `responses` / `chat` / `messages` 三档，`resolveRoute` 返回单一 endpoint。
- `src/server.js` 按 `route.upstream` 分支转发；responses 直连（仅 normalize），chat 转换后转发并转回。
- 图片输入目前没有任何处理。

## 功能 1：Response -> Chat Fallback

### 路由语义

- 除 `messages` 端点模型外，其余模型统一视为 `responses`（默认 primary），并隐式带 `chat` fallback。
- `DEFAULT_MODEL_ROUTES` 中所有 `chat` 类模型改为 `responses`（fallback 到 chat/completions 由转发层隐式处理，不再显式区分 chat 主路由）。
- `config.models` 覆盖中的 `upstream: 'chat'` 也按“responses→chat fallback”语义处理（不再作为纯 chat 主路由）；`upstream: 'messages'` 维持 Anthropic 直连。

### 触发条件

请求阶段失败即降级：

- `fetchImpl` 抛错（网络错误）；
- `AbortSignal.timeout` 超时（AbortError）；
- 上游返回任何非 2xx 状态。

已开始成功响应（2xx 后流中断）不触发降级。

### 降级流程

1. 请求 `/responses`（现有 `normalizeResponsesRequest`）。
2. 若失败：
   - 用 `responsesToChatRequest(body)` 转换原请求；
   - POST `/chat/completions`（现有 Bearer headers）；
   - 成功：流式用 `translateChatStreamToResponses`，非流式用 `chatToResponsesObject`，转回 Responses 输出给 Codex；
   - 失败：把 chat 上游错误原样返回（不再继续降级）。
3. 若 `/responses` 成功：维持现有透传/relay 行为。

### 错误处理

- 降级后的 chat 错误透传上游状态码与错误体（沿用 `relayError`）。
- 网络错误/超时若无响应体，构造可读错误消息返回 502。

## 功能 2：DeepSeek 多模态降级

### 图片检测

检测 `body.input`（数组）中任意 message 项的 `content` 块：

- `type === 'input_image'`（Responses 风格）；
- `type === 'image_url'`（Chat 风格兼容）；
- 或块包含 `image_url` / `file_id` 字段。

### 触发与替换

- 仅当 `body.model` 为 `deepseek-v4-pro` 或 `deepseek-v4-flash` 且检测到图片时，把请求模型替换为 `gpt-5.6-luna`。
- 替换发生在 fallback 流程之前；替换后的请求按功能 1 的统一流程转发（luna 也会享受 response→chat fallback）。
- 响应 `model` 字段保留原请求模型名（deepseek），避免 Codex 元数据错乱；实际上游请求模型为 `gpt-5.6-luna`。

## 架构与组件

- `src/server.js`：转发层增加 fallback 包装与图片降级调用。
- 新增 `src/fallback.js`（或等价模块）：
  - `hasImageInput(body)`：检测图片；
  - `maybeUpgradeModel(body)`：deepseek + 图片 → 替换模型（返回新 body / 原 body）；
  - `forwardWithFallback(res, body, config, fetchImpl)`：response→chat 降级逻辑。
- 保持现有转换器不变（复用）。

## 数据流

```
Codex POST /v1/responses
  -> maybeUpgradeModel(body)          # deepseek+image -> gpt-5.6-luna
  -> resolveRoute(model)              # messages 直连；其余 responses
  -> POST /responses
       |-- 2xx -> relay
       `-- fail -> POST /chat/completions (responsesToChatRequest)
                   |-- 2xx -> chatToResponses* 回给 Codex
                   `-- fail -> relay chat error
```

## 测试

- 单元测试：
  - `hasImageInput`：input_image / image_url / file_id / 无图 / 字符串输入。
  - `maybeUpgradeModel`：deepseek+图 → luna；deepseek 无图不变；其他模型带图不变。
  - fallback：mock fetch 第一次 `/responses` 500/抛错，断言第二次走 `/chat/completions` 且返回 Responses 格式（流式与非流式）。
- 集成测试（server.test.js）：
  - `/responses` 失败 → chat 成功 → 客户端收到 Responses 对象/流。
  - `/responses` 成功 → 不透传错误。
  - deepseek + 图片 → 上游收到 model=gpt-5.6-luna。
- 回归：现有 40 个测试 + 两个切换脚本继续通过。

## 验收标准

- 任意非 messages 模型请求，在 `/responses` 失败时可自动通过 chat/completions 完成，且 Codex 侧仍收到 Responses 格式。
- deepseek 请求带图片时实际调用 `gpt-5.6-luna`，无图时仍走 deepseek。
- 全部测试通过；切换脚本通过。