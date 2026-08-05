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

**恢复**：`Start-Process lean-ctx.exe proxy start --port=4444`（本机 exe：`C:\ProgramData\npm\npm\node_modules\lean-ctx-bin\bin\lean-ctx.exe`）。

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
