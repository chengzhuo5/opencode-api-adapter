# OpenCode API Adapter

`@minar-kotonoha/opencode-api-adapter` 是一个零依赖 Node.js 本地 API 适配器。它向 Codex 暴露统一的 OpenAI Responses API，同时把不同模型路由到 OpenCode Go 的 Responses、Chat Completions 或 Anthropic Messages 端点。

## 特性

- 统一入口：`POST /v1/responses`。
- 非 Anthropic 模型优先请求 `/responses`，网络错误、超时或任何非 2xx 自动降级到 `/chat/completions`。
- Chat Completions 响应和 SSE 会转换回 Responses 格式。
- MiniMax/Qwen 的 Anthropic Messages 路由保持独立，不参与 Responses→Chat fallback。
- DeepSeek V4 Pro/Flash 在最新用户消息中检测到 `input_image`、`image_url` 或 `file_id` 时自动切换到 `gpt-5.6-luna`；旧历史消息中的图片不会触发降级。
- 跨协议上下文规范化：工具调用、`reasoning_content`、旧的重复工具名和历史内部字段都会被清理或转换。
- 结构化控制台日志：记录多模态降级和 API fallback，不记录 API key、完整 prompt 或图片内容。
- 支持作为 CLI 启动，也可以导入 `createRouter` 构建自己的 Node HTTP 服务。

## 工作原理

```text
Codex Responses request
        |
        +-- DeepSeek + image --> gpt-5.6-luna
        |
        +-- /responses
        |      |
        |      +-- 2xx ----------------------> relay Responses
        |      |
        |      `-- error/timeout/network -----> /chat/completions
        |                                            |
        |                                            `--> convert Chat response to Responses
        |
        `-- Anthropic model ------------------> /messages
```

路由器不会把 API key 写入配置文件。所有上游请求使用环境变量 `OPENCODE_GO_API_KEY`。

## 安装

```powershell
npm install -g @minar-kotonoha/opencode-api-adapter
```

Node.js 18 或更高版本。

## 配置

复制示例配置：

```powershell
Copy-Item (npm root -g)\@minar-kotonoha\opencode-api-adapter\config.example.json .\config.json
$env:OPENCODE_GO_API_KEY = "your OpenCode Go API key"
```

最小配置：

```json
{
  "host": "127.0.0.1",
  "port": 15722,
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

也可以通过环境变量或命令行指定配置：

```powershell
$env:OPENCODE_ROUTER_CONFIG = "C:\path\to\config.json"
opencode-api-adapter

opencode-api-adapter --config "C:\path\to\config.json"
```

## 上下文压缩（lean-ctx）

路由只对历史中的 `function_call_output`（工具输出）做确定性压缩，消息结构与用户/助手指令保持原样，避免语义丢失。后端为本地 [lean-ctx](https://github.com/yvgude/lean-ctx) daemon。

- 安装 daemon：`npm i -g lean-ctx-bin` 后运行 `lean-ctx proxy enable`（或按官方脚本安装）。
- 配置：

```json
{
  "compress": {
    "enabled": true,
    "backend": "lean-ctx",
    "baseUrl": "http://127.0.0.1:4444",
    "token": "",
    "storeDir": "ctx-store",
    "cacheSize": 1000,
    "timeoutMs": 30000
  }
}
```

- 压缩粒度：每个 `function_call_output` 独立压缩（无论大小）；其余 input 项原样透传。
- 缓存安全：同一输出指纹对应同一压缩结果，历史前缀字节稳定，DeepSeek 前缀缓存可命中；每次请求输出 `cache_safety_check` 校验前缀漂移。
- CCR 显式取回：被压缩项的输出格式为 `<压缩文本> [[ctx:<sha256>|<绝对路径>]]`，其中 `<绝对路径>` 是原文 JSON 存档（SHA-256 内容寻址，位于 `storeDir`）。需要完整原文时，用 shell 读取该文件即可：

```powershell
Get-Content -Raw "<绝对路径>"
```

```bash
cat "<绝对路径>"
```

- 日志：`context_compression` 汇总事件记录整体压缩率；缓存命中不再逐条打日志。`compress.logLevel` 可设 `"verbose"`（默认，含 `cache_safety_check`）或 `"quiet"`（只保留汇总与错误日志）；daemon 不可用时自动降级为不压缩，不影响路由功能。


## 启动

```powershell
opencode-api-adapter
```

或在源码目录：

```powershell
npm start
```

健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:15722/healthz
```

## Codex 配置

```toml
model_provider = "custom"
model = "gpt-5.6-luna"
model_catalog_json = "C:/path/to/catalog.json"

[model_providers.custom]
name = "opencode_go"
base_url = "http://127.0.0.1:15722/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "PROXY_MANAGED"
```

启动时会生成 `catalog.json`。DeepSeek 的 catalog 能力声明包含 `text` 和 `image`；只有最新用户消息中真的出现图片时，路由器才会把请求交给 Luna。

## 结构化日志

默认写入路由进程的控制台，每行一个 JSON 事件：

```json
{"event":"multimodal_fallback","model":"deepseek-v4-flash","fallback_model":"gpt-5.6-luna","reason":"image_input"}
{"event":"api_fallback","model":"deepseek-v4-flash","reason":"http_error","primary_status":503,"fallback_endpoint":"chat/completions"}
{"event":"api_fallback_result","model":"deepseek-v4-flash","success":true,"status":200}
```

测试或嵌入使用时，可以传入 `config.logger = (event) => { ... }` 捕获结构化事件。

## 测试

```powershell
npm test
npm run smoke
npm run switch:gpt-ds-gpt-ds
npm run switch:ds-gpt-ds-gpt
```

两个切换脚本都支持 `--mock`，也支持传入真实运行中的 adapter：

```powershell
node scripts/switch-gpt-deepseek-gpt-deepseek.mjs --base http://127.0.0.1:15722
node scripts/switch-deepseek-gpt-deepseek-gpt.mjs --base http://127.0.0.1:15722
```

## 作为库使用

```js
import { createRouter } from "@minar-kotonoha/opencode-api-adapter";

const server = createRouter({
  apiKey: process.env.OPENCODE_GO_API_KEY,
  apiBaseUrl: "https://opencode.ai/zen/go/v1",
  models: {}
});

server.listen(15722, "127.0.0.1");
```

## 安全说明

- 不要把 API key 写进 `config.json`、README 或 Git 历史。
- 图片会随请求发送到实际处理模型；不要上传不应离开本机的数据。
- fallback 日志只记录路由元数据，不记录完整请求内容。

## 许可证

MIT
