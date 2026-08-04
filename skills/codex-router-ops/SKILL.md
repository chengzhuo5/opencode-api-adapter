---
name: codex-router-ops
description: 维护 Codex OpenCode API 路由（codex-router / opencode-api-adapter）的运维技能。当用户提到部署/启动/重启路由、修改 API key（OPENCODE_GO_API_KEY / ERGOUAPI_API_KEY）、配置模型或服务商（gpt-5.6-luna / ergouapi）、查看路由日志、排查图片/多模态降级/403/400/429 报错、跑测试或验证脚本时，必须使用此技能。
---

# codex-router 运维指南

## 项目信息

- 项目根目录：`C:\Code\AI\opencode-api-adapter`
- 路由监听：`http://127.0.0.1:15722`（config.json 的 host/port）
- Git 远端：`https://github.com/chengzhuo5/opencode-api-adapter.git`（master）
- 启动命令：`node src/main.js`（读取 `config.json`）
- 健康检查：`GET /healthz`（返回 200 ok）
- 模型目录：`GET /v1/models`；压缩存档取回：`GET /v1/ctx/<sha256>`

## 铁律：不要自己停/启路由进程

Codex 会话本身是通过路由（15722）运行的。**停止路由进程会切断当前会话**。

- 需要重启时，**让用户手动运行**一键脚本，或请用户在新终端执行启动命令
- 永远不要对 15722 的监听进程执行 Stop-Process
- 只读诊断（healthz、日志读取、端口查询）不受限制

## 常用命令速查

```powershell
# 健康检查
Invoke-WebRequest http://127.0.0.1:15722/healthz

# 一键重启路由（从注册表注入 key；需要用户运行）
powershell -ExecutionPolicy Bypass -File scripts\restart-router.ps1

# 全量测试
npm test

# 冒烟测试
npm run smoke

# ergou 连通性验证（真实请求，消耗少量额度）
node scripts\verify-ergou.mjs

# 发图测试（流式，模拟 Codex；真实请求）
node scripts\send-image.mjs

# 图片多模态链路调试（真实请求 + 日志事件）
node scripts\debug-image-ergou.mjs
```

## 修改 API Key

两个 key 都存为**用户级环境变量**（不是配置文件）：

| Key | 用途 |
| --- | --- |
| `OPENCODE_GO_API_KEY` | OpenCode Go 上游（默认服务商） |
| `ERGOUAPI_API_KEY` | ergouapi.com（gpt-5.6-luna 自定义服务商） |

修改步骤（PowerShell）：

```powershell
[Environment]::SetEnvironmentVariable("ERGOUAPI_API_KEY", "新key值", "User")
[Environment]::SetEnvironmentVariable("OPENCODE_GO_API_KEY", "新key值", "User")
```

**改完必须重启路由才生效**（进程环境变量在启动时固化）：

1. 请用户运行 `powershell -ExecutionPolicy Bypass -File scripts\restart-router.ps1`（脚本会自动从注册表读 key 并注入）
2. 或者让用户**新开终端**执行 `node src/main.js`（旧终端不会继承新设置的用户变量）

注意：`scripts\restart-router.ps1` 中的 `restart-router.ps1` 是从注册表 `HKCU:\Environment` 读取 key。读取 key 时只验证存在，不要把 key 值打印到对话里。

## 配置模型 / 服务商

配置文件：`config.json`（已 gitignore，不提交；示例见 `config.example.json`）。

```json
{
  "models": {
    "gpt-5.6-luna": {
      "upstream": "responses",
      "endpoint": "https://ergouapi.com/v1",
      "apiKeyEnv": "ERGOUAPI_API_KEY",
      "maxHistoryMessages": 10
    }
  }
}
```

- `endpoint`：自定义服务商 base URL（自动拼接 `/responses` 或 `/messages`），优先级高于全局 `apiBaseUrl`（OpenCode）
- `apiKeyEnv`：该服务商 key 的环境变量名
- `maxHistoryMessages`：转发前只保留最近 N 条消息（小上下文窗口服务商用）

`endpoint` 和全局 `apiBaseUrl` 都支持字符串或**数组**：数组按顺序逐个尝试，第一个成功响应的生效（多服务商冗余）。数组元素可以是字符串（用默认 key）或对象 `{ "url": "...", "apiKeyEnv": "..." }`（每个端点独立 key）。服务商降级链：自定义服务商列表 → OpenCode 列表 → chat/completions。

## 日志

- 一键脚本启动时：`logs\router.out.log`（stdout）和 `logs\router.err.log`（stderr）
- 手动终端启动时：日志输出到该终端
- 关键事件：`multimodal_fallback`、`api_fallback`（含 primary_url/primary_status）、`context_truncation`、`file_id_compat`、`context_compression`

排查请求去向：看 `api_fallback` 的 `primary_url` 是 ergouapi 还是 opencode。

## 多模态 / 图片链路

Codex 发图的真实形态：图片在 **`function_call_output.output` 数组**里（`[{"type":"input_image","image_url":"data:..."}]`），不在 user message。

链路：deepseek 带图 → `multimodal_fallback` 升级 gpt-5.6-luna → 剥离历史图片 → 截断到 maxHistoryMessages → 丢弃 reasoning 项 → 发 ergou（流式）。

- ergou 只支持流式（`stream:true`），非流式请求会 400 后降级
- input 里的 `reasoning` 项必须丢弃（ergou 当存储引用，404/400）
- `file_id` 图片走 opencode 兜底（ergou 403）

## 常见报错排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `chatcmpl_xxx` + 空 message（403） | opencode 对 luna 地区 403 | 确认请求为何走了 opencode（key 未生效 / file_id / ergou 失败降级） |
| ergou 404 "Item with id 'rs_...' not found" | reasoning 项未丢弃（旧代码） | 升级代码并重启 |
| ergou 400 "Invalid value: 'final'" | phase 字段版本差异 | 已由 normalize 处理，确认进程为新代码 |
| ergou 429 usage limit | ergou 账号额度用完 | 去 ergou 后台查余额 |
| `EADDRINUSE` | 端口被占（重复启动） | 确认当前活跃实例，勿重复启动 |
| 图片识别失败但无报错 | file_id 走 opencode 被忽略 | 检查 `file_id_compat` 日志 |

## 发布流程（npm / GitHub）

1. `npm test` 全绿
2. `git add -A && git commit -m "..." && git push origin master`
3. 发 npm 新版本：bump `package.json` version，`npm publish --registry https://registry.npmjs.org`（需要用户提供 OTP）

## 安全提示

- 日志、调试输出中**不要打印 API key 明文**（脱敏：只显示后 4 位）
- 读取注册表 key 用于验证/注入时，只判断存在性，不回显值

## 开机自启与保活（watchdog）

- 脚本：`scripts\start-router-watchdog.ps1`，同时守护路由（15722）和 lean-ctx daemon（4444），每 10 秒检查端口，缺失即拉起。
- 注册开机任务（任务计划程序，登录时启动）：
```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Code\AI\opencode-api-adapter\scripts\start-router-watchdog.ps1"'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'opencode-router-watchdog' -Action $action -Trigger $trigger -Settings $settings -Force
```
- 取消注册：`Unregister-ScheduledTask -TaskName 'opencode-router-watchdog' -Confirm:$false`
- 注意：`ExecutionTimeLimit` 必须为 0（无限），否则任务计划程序默认 3 天后会杀掉看门狗。
