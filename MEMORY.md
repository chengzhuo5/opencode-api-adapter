# 项目记忆

记录值得留存的排查结论与运维要点（按时间追加）。

## 2026-08-04：deepseek reasoning_content 偶发报错

**现象**：`Error from provider (Console Go): Upstream request failed: [invalid_request_error] The reasoning_content in the thinking mode must be passed back to the API.` 偶发出现，重试即恢复。

**根因**：responses→chat 转换时，Codex 的 `function_call` 是独立 input 项；当它被追加到"纯文本 assistant 消息"上时，该 assistant 带 `tool_calls` 但没有 `reasoning_content` 字段，DeepSeek thinking 模式校验失败。

**修复**：`responsesToChat.js` 的 `appendChatToolCall` 对 deepseek 模型确保每个带 `tool_calls` 的 assistant 都有 `reasoning_content`（无思考时为空字符串，已实测 DeepSeek 接受空串）。

**排查要点**：
- Codex 图片在 `function_call_output.output` 数组里（不是 user message）
- input 里 `reasoning` 项在 OpenAI 兼容端点（ergou）会当存储引用导致 404/400，必须丢弃；但 chat 路径要转 `reasoning_content` 保留
- ergou 的 `/v1/responses` 只支持流式；`phase: 'final'` 是版本差异字段（normalize 时已处理）

## 2026-08-04：deepseek 上下文超限（查看截图场景）

**现象**：`This model's maximum context length is 1048576 tokens... requested 1569013 tokens`。Codex 客户端上下文显示占用很小，但路由转发报超限。

**根因**：截图以 base64 存在 `function_call_output.output` 数组里（`[{type:'input_image', image_url:'data:...'}]`）。deepseek 无图请求也会把历史/当前截图 fco **原样透传**（压缩层为保护图片跳过数组 fco），巨大 base64 直接爆掉上下文；客户端不把工具输出计入显示，所以看着占用很小。

**修复**：`fallback.js` 新增 `stripAllImages`——非升级请求（deepseek 无视觉）转发前把所有**含内容的图片**（data URL）替换为 `[image omitted]`；`file_id` 引用保留（无 token 负担且 file_id 兼容需要）。升级到 luna 的路径仍保留最新图（`minimizeHistoryImages`）。

**排查要点**：
- 图片 fco 数组：升级路径保留最新图给 luna；非升级路径全部剥离
- `file_id` 图片不能被 strip（file_id_compat 检测依赖它）

## 2026-08-04：view_image 后跟其他工具导致图片被剥离

**现象**：agent 调用 view_image 看图后，若紧接着跑了其他命令（最后一条 fco 是文本），多模态升级不触发，图片走 stripAllImages 被替换成 `[image omitted]`，模型拿不到图。

**修复**：`hasImageInput` 从"只查最后一条 fco"扩展为"查最后一条 user 消息之后的所有项（含 user 本身）"——view_image 输出图片后即使再跑其他工具，图片仍属当前轮次，触发升级到 luna 保留图片。同时保留最后 fco 检查兼容旧结构。

**要点**：剥离（stripAllImages）只对无视觉模型（deepseek）生效；luna 直连和升级路径都保留图片。

## 2026-08-04：同一轮多次 view_image 对比场景丢图

**现象**：同一轮连续两次 view_image（对比两张截图）时，`minimizeHistoryImages` 只保留最后一张，第一张变 `[image omitted]`。

**修复**：`minimizeHistoryImages` 改为保留"最后一条 user 消息之后的所有图片"（含该消息本身），同一轮的多张截图全部保留；仅剥离更早历史轮次的图片。注意 Codex 真实请求结构是 user 消息在工具调用之前、fco 在末尾。

## 运维：lean-ctx 4444 未自启导致压缩静默失效

**现象**：`tokens_saved` 变 0。根因是 lean-ctx proxy（4444）没运行（机器重启后未自启），压缩请求全部 `backend_unavailable` 降级。

**恢复**：`Start-Process lean-ctx.exe proxy start --port=4444`。本机 exe 由 `where.exe lean-ctx` 定位（实际在 `C:\Users\29302\.local\bin\lean-ctx.exe`），不要写死 npm 安装路径。

**注意**：`scripts/start-router-watchdog.ps1` 是另一台机器的路径（C:\Code\AI、用户 29302），本机需适配后使用。

## 2026-08-04：Codex 上下文显示长度不更新

**现象**：走路由后 Codex 客户端显示的上下文长度一直不变。

**根因**：deepseek 走 opencode **chat 流式**（responses 不支持），`translateChatStreamToResponses` 只解析 `delta`、忽略流式最后一个 chunk 的 `usage` 字段 → `response.completed` 无 usage → 客户端（靠 usage 更新上下文显示）拿不到数据。

**修复**：流式循环里解析 `chunk.usage` 附加到 response，随 `response.completed` 透传。注意：显示的是压缩/截断后实际发给上游的 token 数，比 Codex 本地上下文小属正常。

## 运维注意

- **改 key 后必须重启路由**：进程启动时固化环境变量；`scripts/restart-router.ps1` 会从注册表注入
- 路由进程被停会切断 Codex 会话，重启由用户手动执行
- `logs/` 已 gitignore；`config.json`、`test.py` 也忽略不提交


## 2026-08-04：Responses completed 顶层 input_tokens

- 现象：Codex 报 `stream disconnected before completion: failed to parse ResponseCompleted: missing field input_tokens`。
- 根因：opencode.ai 的 /responses 直通流返回精简 completed（仅 id/model/usage）；chat 降级与 anthropic 转换生成的 completed 也缺顶层 input_tokens/output_tokens。Codex 客户端严格反序列化要求顶层字段。
- 修复：fallback.js relayUpstream 对直通 SSE/JSON 规范化（normalizeResponsesObject 补 object/created_at/status/input_tokens/output_tokens/output/error/incomplete_details，值取自 usage 或缺省 0）；chatToResponses.js / anthropicToResponses.js 生成的 completed 同样补顶层 token 字段（tokensFromUsage 兼容 prompt_tokens/completion_tokens 与 input_tokens/output_tokens）。
- 教训：直通上游的响应格式不可信，客户端要求的顶层字段必须在路由侧兜底补全。

## 2026-08-05：cc-switch 源码对比（路由差距清单）

**来源**：`C:\Code\AI\cc-switch`（farion1231/cc-switch v3.19.1，Tauri/Rust 桌面应用，本地代理端口 15721）。

**我们的路由已具备**：Responses/chat/messages 多协议转发与转换、多 provider 数组按序 failover、5 分钟主动健康探测（unhealthy 排末尾、恢复自动切回）、流保活/卡死切非流式重试、响应字段规范化、图片多模态升级/剥离、历史裁剪、lean-ctx 压缩、watchdog 自启。

**cc-switch 有而我们没有（按价值排序）**：
1. 熔断器（Closed/Open/HalfOpen 状态机，连续失败/错误率/最小请求数阈值，半开探测限流，按应用+供应商独立，真实流量被动驱动）——我们只有主动健康排序。
2. 用量/计费：SQLite 请求日志（token/缓存读/写/延迟/首 token/状态）、供应商与模型统计、趋势、缓存命中率、内置+自定义价格表、费用估算；会话 JSONL 用量导入（Codex/OpenCode/Gemini）；DeepSeek 等余额与订阅额度查询。
3. 可配置超时/重试：流首字节超时、流静默超时、最大重试次数、TTFB 降级阈值（我们只有 requestMs/streamIdleMs + 卡死切非流式）。
4. 模型映射（haiku/sonnet/opus/default → 供应商模型名改写）与官方模型目录镜像（DeepSeek models.json 原样下发，保留 freeform apply_patch/base_instructions）。
5. cache_control 断点注入（Bedrock/Anthropic prompt caching）、thinking 签名/预算整流、content-encoding、tool_media 清洗。
6. 桌面应用范畴：MCP/Skills/Prompts/会话管理、S3/WebDAV 云同步、deep link、OAuth/auth.json 快照切换、UI 热切换。

**结论**：路由最值得补的是熔断器（被动失败驱动）与请求日志/用量统计；其余多为桌面应用能力，不必并入纯 Node 路由。tokens_saved=0 仍是 lean-ctx 未启用/daemon 未跑的问题，与 cc-switch 无关。

## 2026-08-05：ergou GPT 上下文 353K + 被动熔断器

- **ergou GPT 上下文窗口只有 353K**（用户确认，ergou /v1/models 不返回 context 字段，51cto 文章被 WAF 拦未能读到）。catalog 模板默认 1M，之前 Codex 会以为 ergou 能装 1M 历史，接近上限才压缩，容易撞上游超限。
  - 实现：`modelMeta.js` 给 6 个 gpt-*（ergou）模型加 `contextWindow: 353000`；`catalog.js` 支持 `config.models[id].contextWindow` 覆盖；`catalog.json` 重新生成后 gpt 系列 context_window/max_context_window=353000，deepseek 仍 1M。
- **被动熔断器**（`src/circuitBreaker.js`）：closed→open→half_open 状态机，按 `model::endpoint` 统计；连续失败 ≥ failureThreshold 或（请求数 ≥ minRequests 且错误率 ≥ errorRateThreshold）→ open；timeoutMs 后放行 1 个半开探测，连续成功 ≥ successThreshold → closed。由真实请求驱动，与 health.js 主动探测互补。
  - 接入：`fallback.js` forwardWithFallback 循环内 allow/record；`relayUpstream*`/`pipeSseWithNormalization` 改为返回成功与否，流中断补发 failed 也会记为失败；`server.js` 创建 breaker 并传参。
  - 坑：open 超时切 half_open 时，当前探测请求必须消耗唯一的 permit（halfOpenPermits 置 0），否则并发请求都能放行。
  - 配置：`circuitBreaker.enabled` 等见 config.example.json；本地 config.json 已启用（3/2/60s/0.6/5）。
- **watchdog 路径 bug**：commit a7d29b8 把 `scripts/start-router-watchdog.ps1` 的 `$routerDir` 错改成 `C:\Users\cheng\Documents\...`（另一台机器路径），而任务计划程序 `opencode-router-watchdog` 执行的是本仓库脚本——路由挂掉会被拉到错误目录。已改回 `C:\Code\AI\opencode-api-adapter`，并给 watchdog/restart 脚本补注入 `DEEPSEEK_API_KEY`（原来只注入 ERGOU/OPENCODE）。
- **watchdog 的 lean-ctx 路径**：脚本里写死的 `C:\ProgramData\npm\npm\node_modules\lean-ctx-bin\bin\lean-ctx.exe` 在本机不存在，导致 `Start-Process` 每 10 秒报「系统找不到指定的文件」。已改为 `where.exe lean-ctx` 动态解析（取第一个 `.exe` 结果，当前命中 `C:\Users\29302\.local\bin\lean-ctx.exe`），找不到时只记 WARN 不报错。
- **watchdog 黑框问题**：任务计划程序直接跑 `powershell.exe -WindowStyle Hidden -File start-router-watchdog.ps1`，在本机会创建一个可见的 `PseudoConsoleWindow`（空标题黑框）。已改为任务执行 `wscript.exe scripts\start-router-watchdog.vbs`，VBS 用 `WScript.Shell.Run(..., 0, False)` 以完全隐藏方式拉起 powershell，控制台窗口根本不创建。验证：桌面可见控制台窗口数 = 0。
  - 桌面壳开发模式同理：`desktop/start-app.vbs` 双击启动 `node app.js` 无黑框；正式使用建议直接跑打包的 `CodexRouter.exe`（GUI 子系统，无控制台）。

## 2026-08-05：路由注册为 Windows 服务（NSSM）成功

- **现状**：服务 `CodexRouter` 已安装并 RUNNING，`node src/main.js` 由 NSSM 2.24 托管（nssm.exe 下载在 `%LOCALAPPDATA%\CodexRouter\nssm`）。LocalSystem 运行，AUTO_START，崩溃 5 秒自动重启，stdout/stderr 轮转 10MB 写入 `logs\`，停止时 AppStopMethodConsole 发 Ctrl+C（main.js 已补 SIGINT 优雅停止）。15722 端口 owner 的父进程 = nssm 服务进程（验证过）。
- **API key**：LocalSystem 读不到 HKCU 环境变量，安装脚本把 `OPENCODE_GO_API_KEY/ERGOUAPI_API_KEY/DEEPSEEK_API_KEY` 从 HKCU\Environment 注入服务环境（存在服务配置 Parameters，仅管理员可读）。
- **watchdog 关系**：`opencode-router-watchdog` 计划任务已禁用（服务接管保活）；服务不管理 lean-ctx（compress.enabled=false，不需要）。卸载：`scripts\uninstall-service.ps1`（管理员）会删服务并恢复计划任务。
- **坑（重要）**：
  - PowerShell 5.1 解析**无 BOM 的 UTF-8 中文 .ps1** 会按 ANSI 误读，字符串引号错乱 → 解析失败，sudo 窗口一闪而过且不留任何日志。所有中文 .ps1 必须存成 UTF-8 with BOM（`install-service.ps1`/`uninstall-service.ps1`/`start-router-watchdog.ps1`/`restart-router.ps1` 已转）。
  - Windows sudo 默认 forceNewWindow，stdout 看不到 → 安装脚本用 try/catch + `logs\service-install.log` 记录每一步。
  - 安装顺序必须先停 watchdog 再停路由：否则 watchdog 的 10s 循环会在停路由后抢拉起新实例，服务 node 绑定 15722 失败（sc 显示 PAUSED，healthz 实际来自孤儿路由）。现脚本已按「禁用任务 → 杀 watchdog → 停路由并等端口释放 → 起服务 → 校验端口 owner 是服务子进程」执行。
  - 管理页热加载/重启仍是进程内操作，服务不受影响；服务级操作 `sc.exe stop/start/query CodexRouter`。

## 2026-08-05：模型通配符配置 + 请求日志/用量统计

- **`modelPatterns` 通配配置**（用户要求不要每个 gpt 模型单独写）：`routes.js` 新增 `matchModelPattern`/`getModelEntry`——`*` 匹配任意串、`?` 匹配单字符，多个模式命中取更长者；优先级：精确 `models` 条目 > 通配 > 默认路由。`config.js` 对 patterns 同样归一化 apiKey/endpoint；`catalog.js` 的 contextWindow 也走 `getModelEntry`。本地 config.json 已把 6 个 gpt 条目收敛成 `"gpt-*"` 一条（ergou + 353K + maxHistory 10），deepseek-v4-flash 仍是精确条目。
- **请求日志 + 用量统计**（`src/usageLog.js`，零依赖 JSONL）：
  - `createRequestTracker`：每次请求一个 tracker，各 provider 尝试都 record，结束时 finalize 成一行（model/endpoint/status/ok/input/output/cache_read/cache_creation/latency/streamed/error）。
  - `extractUsage`：兼容 `input_tokens/prompt_tokens`、`cache_read_input_tokens`、`input_tokens_details.cached_tokens/cache_write_tokens` 等字段；全 0 返回 null 不覆盖真实 usage。
  - 接入点：fallback.js 的 forwardWithFallback/forwardChat 和各 relay 函数（`relayUpstream*`/`pipeSseWithNormalization` 增加 onUsage 回调，流式 `response.completed` 里提取 usage）；server.js 的 messages/chat 路由也 record。
  - `GET /v1/usage?days=&model=&provider=` 聚合：总请求/成功率/各类 token/缓存命中率/平均延迟 + perModel/perProvider/perDay。
  - 配置 `usageLog.enabled/file`，`usage/` 已 gitignore。
  - 坑：server.js 调 forwardWithFallback 时最初漏传 `tracker`（只传了 breaker），日志全变成 502/无记录；已修并加 server 集成测试。
- 测试：154 个全过（新增 routes 通配、config patterns 归一化、usageLog 单测、/v1/usage 集成）。

## 2026-08-05：管理页面 + ewvjs 桌面 App

- **管理 API + admin 页面**（路由内置，零依赖）：
  - `GET /api/status`（pid/uptime/config 摘要/health.status()/circuit.statuses()/7 天用量汇总）、`GET /api/config`（返回 config.json 原文）、`POST /api/reload`（body 为配置原文，先校验后写文件，再进程内热重启）、`POST /api/restart`。
  - admin 静态页：`admin/index.html` + `style.css` + `app.js`，浅色主题，总览/用量/配置三视图；`server.js` 的 `serveAdmin` 做路径穿越防护；管理 API 不暴露任何 API key（key 本来就在环境变量里）。
  - **热重启**：`main.js` 重构为 `startRouter()`（CLI 与桌面壳共用），进程内 stop 旧 server → 重建 catalog/config → listen 新 server；旧 server 的 health 定时器通过 `__routerCleanup` 停止。重启窗口极小，watchdog 若抢拉起重复实例会 bind 失败自行退出。
- **ewvjs 桌面壳**（`desktop/`，Node + WebView2）：
  - 源码模式 `npm start`：直接 `startRouter` 用仓库 config.json，15722 已被 watchdog 占用时只开窗口。
  - 打包模式 `npm run package`（`ewvjs-cli package --target node22-win-x64 --assets assets`）：`dist/CodexRouter.exe` + `dist/assets/`（admin、catalog-template、config.example）。首次运行种子到 `%LOCALAPPDATA%\CodexRouter`（config/catalog/admin/usage/ctx-store 全在该目录），路由在 App 进程内，关窗即停。
  - 已验证：打包 exe 内嵌路由成功启动、healthz 200、`/admin` 200、`POST /api/restart` 热重启后同 PID 健康（pkg 里 pid 不变，uptime 是进程级不重置）、窗口标题 "Codex Router 控制台" 正常。
- **坑与注意**：
  - `create_window` 是 async 的（返回 Promise<Window>），必须 `await`；文档示例没写会踩 `win.run is not a function`。
  - pkg 默认 target node18-win-x64 的基础镜像 404，必须显式 `--target node22-win-x64`。
  - main.js 不能有顶层 await + export 组合（pkg ESM 转换警告），CLI 启动改用 IIFE；桌面壳 import startRouter 无副作用。
  - PowerShell 5.1 的 `Start-Process` 没有 `-Environment` 参数（PS7 才有）；测试脚本用 `$env:LOCALAPPDATA` 继承。
  - 打包/测试脚本：`desktop/scripts/prep-assets.mjs`（同步资源）、`desktop/scripts/test-packaged.ps1`（临时 LOCALAPPDATA 跑 exe 看 stdout/stderr + healthz）。`desktop/dist`、`desktop/assets` 已 gitignore。
- 测试：159 个全过（新增 admin 静态页、路径穿越、api/status、api/reload 校验/提交、api/restart）。

## 2026-08-05：Codex config.toml 动态管理（minar_route）

- **功能**（`src/codexConfig.js`，行级编辑零依赖）：
  - `POST /api/codex/apply`：新增 `[model_providers.minar_route]`（name=米纳尔，base_url=路由 15722，wire_api=responses，requires_openai_auth=true，experimental_bearer_token=PROXY_MANAGED）；顶层 `model_provider`/`model` 替换为 minar_route/gpt-5.6-luna，**原值以 `# minar_route_original: ...` 注释保留**；其余配置（MCP/features/model_catalog_json/profiles 等）一律不动。
  - 每次修改前备份 `config.toml.<时间戳>.minar_route.bak`（毫秒级时间戳 + 冲突后缀，避免同一秒覆盖）。
  - 还原两级：优先按注释标记恢复原值并删除 minar_route 块；标记缺失时返回备份列表，**必须用户 `confirm:true` 才从备份覆盖**（覆盖前再备份一次当前状态）。
  - `GET /api/codex` 只返回脱敏字段（不返回文件原文，不泄露 experimental_bearer_token/CONTEXT7 key）。
- **已应用到真实配置**：`C:\Users\29302\.codex\config.toml` 现为 minar_route + gpt-5.6-luna，原始 deepseek/deepseek-v4-flash 已注释保留，备份 `config.toml.20260805-200002185.minar_route.bak` 在 `.codex` 目录。Codex 下次启动生效；当前会话不受影响。用户原注释（`# model_provider = "ergou"` 等）未动。
- **坑**：
  - 备份文件名秒级时间戳同秒覆盖 → 改用毫秒 + 序号。
  - `POST /api/codex/restore` 空 body 会 `JSON.parse('')` 抛错 → 接口容错为空对象。
  - 服务进程热重启只重载配置不重载代码；新增代码必须 `Restart-Service CodexRouter`（sudo）。
  - 真实 config.toml 里有 secret（experimental_bearer_token、CONTEXT7_API_KEY），任何日志/API/文档都不得输出原文。

## 2026-08-05：压缩启用 + LEAN_CTX_PROXY_TOKEN 服务注入

- **现象**：`compress.enabled=false` 时路由只有 context_truncation/image_stripped，没有任何压缩。daemon 4444 在跑但 `/healthz` 超时（lean-ctx 无该端点，属正常）；`POST /v1/compress` 手动测试可通（约 29s，首调慢），但路由热加载启用后全报 `context_compression reason=backend_unavailable`。
- **根因**：NSSM 服务以 LocalSystem 运行，读不到 `C:\Users\29302\.local\share\lean-ctx\session_token`（SDK 的 resolveToken 在 token 为空时按用户目录探测），压缩请求 401 → 被 catch 记成 backend_unavailable。
- **修复**：`scripts/update-service-leanctx-token.ps1` 把 `LEAN_CTX_PROXY_TOKEN=<session_token>` 与三个 API key 一起重写进 NSSM `AppEnvironmentExtra` 并重启服务（sudo 执行）。config.json `compress.token` 保持空字符串即可，非服务模式 SDK 会自动读 token 文件。
- **验证**：服务重启后真实流量 deepseek-v4-flash `context_compression reason=ok`，单次 tokens_saved≈100K（66%），累计 total_tokens_saved≈757K；构造 gpt-5.6-luna 小请求也 outputs_compressed=1。
- **注意**：`nssm get AppEnvironmentExtra` 会把服务环境里所有 key 明文打到终端/会话记录，排查时避免直接输出；若担心泄露需轮换 key。
- **其他观察**：gpt-5.6-sol 正大量 502/500（ergou）与 401（opencode），熔断器已 open opencode 端点；与压缩无关，待排查。
