# Context Compression Layer (lean-ctx Backend) Design

Date: 2026-08-03
Status: Approved design (user confirmed: turn-incremental compression, unified intensity, CCR, lean-ctx backend, switchable interface)

## Goal

在路由层新增“上下文压缩层”：把 Codex 发来的 Responses 请求按对话轮次做确定性增量压缩，压缩后端为本地 lean-ctx daemon，同时保证 DeepSeek KV 前缀缓存不被破坏，并支持原文可逆取回（CCR）。

## 背景与约束

- 当前路由为纯 Node/ESM，已有 Responses→Chat→Responses 转换、fallback、多模态降级、结构化日志。
- 外部依赖形态核实：lean-ctx 是“Rust daemon + 7KB JS SDK（HTTP 客户端）”；headroom 是 Python 代理；两者都不是可内嵌 JS 压缩库；headroom 已移除 lean-ctx 集成。因此选 lean-ctx daemon 作为唯一压缩后端，路由侧做状态与缓存对齐。
- DeepSeek KV 缓存：前缀单元完整匹配才命中；每轮压缩结果必须字节稳定。

## 架构

```
Codex ──> 路由 (Node)
            │  1. 切轮（user 消息起始）
            │  2. 逐轮查压缩缓存；新增轮次调 lean-ctx daemon
            │     （POST /v1/compress {messages, model}，压缩为旁路服务，
            │      不在请求转发链路上）
            │  3. 拼装 AC1+AC2+…+ACn（标准 Responses input）
            ▼
        OpenCode Go 上游（responses / chat fallback）
```

## 组件与职责

### src/compression.js（新增）

- `splitTurns(input)`：按 user 消息起始把 Responses input 切成轮次；轮次内包含 assistant/function_call/function_call_output/reasoning。
- `turnToMessages(turn)`：把单轮转成 chat messages 数组（user 文本 + 工具输出文本），供 lean-ctx 压缩。
- `turnFingerprint(turn)`：确定性 SHA-256 指纹。
- `compressTurn(turn, {model, client})`：调用 lean-ctx `POST /v1/compress`，返回压缩文本 + 统计。
- `compressInput(input, ctx)`：逐轮处理；命中缓存复用，未命中压缩并缓存；输出压缩后的 Responses input（每条为 `message/role=user` 内容，含 `[compressed turn #N]` 标记与 CCR 引用）。
- CCR：原文写入 `compress.storeDir`（SHA-256 内容寻址），压缩文本留 `[[ctx:<sha256>|<相对路径>]]`；Codex 可用 shell 读取。
- 缓存：LRU（默认 1000 条），key=轮次指纹，value=压缩文本；重启丢失但压缩为纯函数可重算。
- 降级：lean-ctx 不可达/超时/返回非 2xx → 不压缩，原样转发，日志记录。

### lean-ctx 客户端（npm 依赖 lean-ctx-sdk）

- 引入 `lean-ctx-sdk`（7KB、无传递依赖）作为依赖，使用其 `compress` / `ProxyClient`；
- 配置：`compress.baseUrl`（默认探测，可用 `LEAN_CTX_PROXY_URL`）、`compress.token`、超时；
- daemon 需另行安装运行（`npm i -g lean-ctx-bin` 或官方 install 脚本）；路由启动时探测 daemon 可用性，缺失则降级不压缩。

### 集成点

- server/fallback 转发前调用 `compressInput`（responses 直连与 chat fallback 共用；Anthropic messages 不压缩）。
- 压缩发生在 normalize / 转换之前，输入为原始 Responses input。

## 缓存安全规则

- 每轮压缩结果只取决于该轮原文（确定性）；
- 历史轮次压缩后不再变化；新轮次只追加在末尾；
- 输出顺序 = 轮次顺序；每条输出为独立 message，保持结构稳定；
- 压缩后内容仍为标准 Responses 格式，下游转换器不需改动。

## 配置

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

- `backend: "none"` 关闭压缩。
- daemon 缺失时自动降级（不压缩）并输出 `context_compression` 日志（`reason: backend_unavailable`）。

## 日志

- `context_compression`：model、turns_total、turns_compressed、turns_cached、chars_before/after、saved_pct、backend_status。不含 prompt/原文。

## 测试

- splitTurns：轮次切分与工具消息归属；
- turnFingerprint：确定性；
- compressInput：mock lean-ctx HTTP 服务，验证：新增轮次被压缩、旧轮次缓存复用、AC1 字节不变；
- CCR：原文落盘、标记格式、取回路径存在；
- 降级：daemon 不可达时原样转发 + 日志；
- 回归：fallback、多模态、切换脚本、全量测试。

## 验收标准

- 第二轮请求发出 AC1+AC2，AC1 与第一轮完全一致（字节级）；
- DeepSeek 请求前缀缓存可命中（AC1 不变）；
- lean-ctx 未运行时路由功能不受影响；
- 全部测试通过。
