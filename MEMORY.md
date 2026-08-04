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

## 运维注意

- **改 key 后必须重启路由**：进程启动时固化环境变量；`scripts/restart-router.ps1` 会从注册表注入
- 路由进程被停会切断 Codex 会话，重启由用户手动执行
- `logs/` 已 gitignore；`config.json`、`test.py` 也忽略不提交
