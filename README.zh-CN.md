# OpenCode API Adapter

`@minar-kotonoha/opencode-api-adapter` 是一个零依赖 Node.js 本地 API 适配器。它向 Codex 暴露统一的 OpenAI Responses API，同时把不同模型路由到 OpenCode Go 的 Responses、Chat Completions 或 Anthropic Messages 端点。

## 特性

- 统一入口：`POST /v1/responses`。
- 非 Anthropic 模型优先请求 `/responses`，网络错误、超时或任何非 2xx 自动降级到 `/chat/completions`。
- Chat Completions 响应和 SSE 会转换回 Responses 格式。
- MiniMax/Qwen 的 Anthropic Messages 路由保持独立，不参与 Responses→Chat fallback。
- DeepSeek V4 Pro/Flash 在最新用户消息中检测到 `input_image`、`image_url` 或 `file_id` 时自动切换到 `gpt-5.6-luna`；旧历史消息中的图片不会触发降级。
- 跨协议上下文规范化：工具调用（含旧会话中的 `custom_tool_call`/`custom_tool_call_output`）、`reasoning_content`、旧的重复工具名和历史内部字段都会被清理或转换；对中断或错位的工具轮次自动修复，保证上游要求的 tool_calls ↔ tool 消息配对；重放时丢弃不兼容的历史条目 id（旧会话的 `resp_..._msg` 前缀会被部分上游拒绝）。
- 被动熔断器：真实请求连续失败或错误率超阈值后自动跳过该 provider，熔断期结束后放行半开探测，成功达到阈值自动恢复；与主动健康探测互补。
- 模型级上下文窗口：catalog 按模型声明 `context_window`（ergou 的 GPT 系列为 353K，其余沿用模板 1M），Codex 据此提前压缩，避免上游上下文超限。
- 通配符模型配置：`modelPatterns` 用 `gpt-*` 这类模式统一管理一批模型，精确模型条目优先于通配符。
- 请求日志与用量统计：每次请求追加 JSONL（模型/provider/状态/token/缓存/延迟），`GET /v1/usage` 返回汇总、按模型/provider/天分组的统计。
- 内置管理页面与桌面 App：浏览器访问 `http://127.0.0.1:15722/admin` 或运行 ewvjs 打包的桌面壳，支持查看状态、编辑配置、用量统计与热重启。
- Codex 配置管理：一键在 `~/.codex/config.toml` 中加入 `minar_route` provider 并切换 model_provider/model，注释保留原值、每次修改前时间戳备份、还原优先用注释字段，失败才提示从备份恢复。
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

### 自定义服务商（模型级端点与通配符）

默认所有模型都路由到 `apiBaseUrl`（OpenCode Go）。任何模型都可以覆盖为其他服务商。**模型配置了自定义 `endpoint` 后只使用该服务商（数组按序逐个尝试），不再自动追加全局 `apiBaseUrl` 兜底**——例如 gpt 系列只走 ergou，opencode 不支持 gpt-5.6-sol 时也不会误降级过去。多个模型使用同一服务商时用 `modelPatterns` 通配（`*` 匹配任意串，`?` 匹配单字符）：

```json
{
  "modelPatterns": {
    "gpt-*": {
      "upstream": "responses",
      "endpoint": "https://ergouapi.com/v1",
      "apiKeyEnv": "ERGOUAPI_API_KEY",
      "maxHistoryMessages": 10,
      "contextWindow": 353000
    }
  }
}
```

- 优先级：精确 `models` 条目 > `modelPatterns` 通配（多个通配命中时取更长的模式）> 默认路由。
- `endpoint`：自定义服务商的 base URL（路由会自动拼接 `/responses` 或 `/messages`）
- `apiKeyEnv`：该服务商 API key 对应的环境变量名；不设置则复用全局 `apiKeyEnv`
- `maxHistoryMessages`：可选，转发前只保留最近 N 条消息（自定义服务商上下文窗口较小时使用，如 ergou 的 luna）；默认不截断
- `contextWindow`：可选，覆盖该模型在 catalog 中声明的上下文窗口（Codex 用它决定何时压缩）。ergou 的 GPT 系列实际窗口为 353K，已内置为默认值
- 优先级：自定义服务商（存在时独占）→ `apiBaseUrl`（仅未配置自定义端点的模型）→ 协议降级（chat/completions，仅当 `apiBaseUrl` 存在时可用；`apiBaseUrl` 可设为 `null` 彻底关闭全局兜底）

`endpoint` 和全局 `apiBaseUrl` 都支持**字符串或数组**：数组时按顺序逐个尝试，第一个成功响应的生效。每个元素可以是字符串（用模型/全局默认 key）或对象 `{ "url": "...", "apiKeyEnv": "..." }`（为该端点指定独立 key）：

```json
{
  "endpoint": [
    { "url": "https://ergouapi.com/v1", "apiKeyEnv": "ERGOUAPI_API_KEY" },
    "https://backup.example/v1"
  ]
}
```

也可以通过环境变量或命令行指定配置：

```powershell
$env:OPENCODE_ROUTER_CONFIG = "C:\path\to\config.json"
opencode-api-adapter

opencode-api-adapter --config "C:\path\to\config.json"
```

### 健康检查与熔断器

```json
{
  "healthCheck": {
    "enabled": true,
    "intervalMs": 300000,
    "timeoutMs": 20000
  },
  "circuitBreaker": {
    "enabled": true,
    "failureThreshold": 3,
    "successThreshold": 2,
    "timeoutMs": 60000,
    "errorRateThreshold": 0.6,
    "minRequests": 5
  }
}
```

两层机制互补：

- `healthCheck`：每 `intervalMs` 主动发一次流式探针，探测失败的 provider 被排到末尾，恢复后自动切回（日志事件 `provider_health`）。
- `circuitBreaker`：由真实请求成败驱动，按 `model::endpoint` 独立统计。连续失败达到 `failureThreshold`，或请求数达到 `minRequests` 后错误率超过 `errorRateThreshold`，即熔断跳过该 provider；`timeoutMs` 后放行一次半开探测，连续成功达到 `successThreshold` 后恢复。状态变化输出 `provider_circuit` 日志事件。

### 请求日志与用量统计

```json
{
  "usageLog": {
    "enabled": true,
    "file": "usage/requests.jsonl"
  }
}
```

启用后，每次 `/v1/responses` 请求会追加一行 JSON 到日志文件：时间、模型、实际使用的 provider、HTTP 状态、成功与否、输入/输出/缓存读/缓存写 token、总延迟、是否流式、错误信息。token 从上游响应的 `usage`（兼容 Responses 与 Chat 两种字段格式）提取；上游不返回 usage 时记为 0。

查询统计：

```text
GET /v1/usage?days=7
GET /v1/usage?days=7&model=gpt-5.6-luna
GET /v1/usage?days=7&provider=https://ergouapi.com/v1/responses
```

返回总请求数、成功率、各类 token 总量、缓存命中率、平均延迟，以及按模型/provider/天的分组统计。`usage/` 目录已加入 `.gitignore`。

### 管理页面与桌面 App

路由内置一个零依赖的浅色主题管理页面（`admin/`），浏览器打开 `http://127.0.0.1:15722/admin` 即可使用：

- **总览**：服务状态、PID/运行时长、Provider 健康（主动探测）、熔断器状态（真实请求驱动）；
- **用量**：请求数/成功率/Token/缓存命中率/平均延迟，按天柱状图与按模型/Provider 明细；
- **配置**：直接编辑 `config.json`，支持「保存并热加载」（校验后写文件，进程内重启 HTTP 服务，Codex 无需重连）与「重启服务」。

管理 API：`GET /api/status`、`GET /api/config`、`POST /api/reload`（body 为配置原文）、`POST /api/restart`。

桌面壳在 `desktop/`（ewvjs = Node + Windows 自带 WebView2）：

```powershell
cd desktop
npm install
npm start              # 源码模式：直接用仓库 config.json，端口被占用时只开窗口
npm run package        # 打包：dist/CodexRouter.exe + assets/（便携目录）
```

打包后的 exe 首次运行会把资源种子到 `%LOCALAPPDATA%\CodexRouter`（config/admin/catalog/usage/logs 都在该目录），路由在 App 进程内运行，关闭窗口即停止；若 15722 已被占用（如 watchdog 在跑）则只打开窗口接管，不重复启动。

### 注册为 Windows 服务（可选）

想开机即起、登录前就可用、崩溃自动重启，可以把路由注册成 Windows 服务（基于 [NSSM](https://nssm.cc)，单 exe 包装器）：

```powershell
# 右键“以管理员身份运行”：
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Code\AI\opencode-api-adapter\scripts\install-service.ps1
```

安装脚本会：

- 下载 NSSM 到 `%LOCALAPPDATA%\CodexRouter\nssm`（不污染仓库）；
- 创建自启服务 `CodexRouter`（`node src/main.js`），崩溃后 5 秒自动重启，stdout/stderr 轮转写入 `logs\`；
- 从 `HKCU\Environment` 读取三个 API key 注入服务环境（服务以 LocalSystem 运行，读不到用户环境变量；key 存在服务配置中，仅管理员可读）；
- 自动禁用 `opencode-router-watchdog` 计划任务，避免与路由抢 15722。

服务安装后管理页照常可用（`http://127.0.0.1:15722/admin`），网页里的「热加载/重启」仍是进程内操作，不受服务管理影响。服务级操作：

```powershell
sc.exe stop CodexRouter      # 停止
sc.exe start CodexRouter     # 启动
sc.exe query CodexRouter     # 查看状态
```

卸载并恢复 watchdog：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Code\AI\opencode-api-adapter\scripts\uninstall-service.ps1
```

### Codex 配置管理（minar_route）

管理页「Codex 配置」标签（或 `POST /api/codex/apply`）可以把 Codex 切换到路由接管：

- 新增 `[model_providers.minar_route]`（`name = "米纳尔"`，base_url 指向路由、`wire_api = "responses"`、`requires_openai_auth = true`、`experimental_bearer_token = "PROXY_MANAGED"`）；
- 顶层 `model_provider` / `model` 替换为 `minar_route` / 目标模型（默认 `gpt-5.6-luna`），**原值以 `# minar_route_original: ...` 注释保留**，其余配置（MCP、features、model_catalog_json、profiles 等）一律不动；
- 每次修改前把当前文件备份为 `config.toml.<时间戳>.minar_route.bak`；
- 还原优先按注释字段恢复原值；注释被破坏时返回备份列表，**用户确认后才**从备份文件覆盖。

配置项（`config.json` 的 `codex` 块，默认关闭）：

```json
{
  "codex": {
    "enabled": true,
    "configPath": "C:/Users/29302/.codex/config.toml",
    "providerName": "minar_route",
    "providerDisplayName": "米纳尔",
    "model": "gpt-5.6-luna",
    "baseUrl": "http://127.0.0.1:15722/v1",
    "wireApi": "responses",
    "authToken": "PROXY_MANAGED"
  }
}
```

改动会在 Codex 下次启动/新会话生效，当前会话不受影响。管理 API：`GET /api/codex`（状态与备份列表）、`POST /api/codex/apply`、`POST /api/codex/restore`（可选 `{ "file": "...", "confirm": true }` 从备份还原）。

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
