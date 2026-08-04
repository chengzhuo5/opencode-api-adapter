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

## 运维注意

- **改 key 后必须重启路由**：进程启动时固化环境变量；`scripts/restart-router.ps1` 会从注册表注入
- 路由进程被停会切断 Codex 会话，重启由用户手动执行
- `logs/` 已 gitignore；`config.json`、`test.py` 也忽略不提交
