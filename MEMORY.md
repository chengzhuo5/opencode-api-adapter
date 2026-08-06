# 项目记忆

记录值得留存的排查结论与运维要点（按时间追加）。

## 2026-08-05：function_call_output requires previous_response_id / item_reference（gpt 会话 400）

**现象**：deepseek 会话切到 gpt（ergou /v1/responses）后，Codex 报
`function_call_output requires previous_response_id or item_reference ids matching each call_id`，
日志里 ergou 返回 400（usage/requests.jsonl 中 status=400、error=http_error）。

**根因**：gpt-* 配置了 `maxHistoryMessages: 10`，`truncateHistory` 只保证截断后开头不是
孤立的 `function_call_output`，但一轮并行工具可能被从中间切掉：窗口内保留了后面的
`function_call_output`，却丢掉了它对应的 `function_call`。ergou 对完整重放的
Responses 历史要求每个 `function_call_output.call_id` 都能匹配到输入里的
`function_call`，否则报上述错误。chat 适配层（sanitizeChatToolMessages）早就修过同类
问题，但 Responses 直通路径没有等价清理。

**修复**：`src/translate/responsesContext.js` 新增 `sanitizeResponsesToolPairs`，
在 `normalizeResponsesRequest` 里按 call_id 配对：只剔除没有可匹配 function_call 的
孤立 function_call_output（含 custom_tool_call_output）；未收到输出的 function_call
保留（chat→responses 历史往返依赖它）。截断造成的“输出还在、调用被切掉”的孤儿项不再
转发。

**验证**：从真实会话 rollout 提取了出错前的最后 10 项复现；新增 2 个回归测试
（test/server.test.js），全套 174 测试通过。

**运维**：改代码后需**重启进程**才能生效（in-process /api/restart 不会重新加载源码）；
当前 shell 无法提权重启 CodexRouter 服务，需用户执行
`sudo powershell -NoProfile -Command "Restart-Service CodexRouter"`（或 NSSM 重启）。

## 2026-08-06：路由全面排查——tool_search 截断 400 + 三协议 provider 一致性

**真实失败证据**：服务进程已加载 2026-08-05 23:48 的最新代码，但 2026-08-06
11:22:55、11:25:35 两个 gpt-5.6-sol 任务仍稳定报 400：
`No tool call found for tool search output with call_id ...`。对应 rollout 中原本同时存在
`tool_search_call` 与 `tool_search_output`；`maxHistoryMessages: 10` 从二者中间截断后，
只把 output 发给 ergou。近 3 小时另外 6 个 DeepSeek 最终 502，日志证实链路是官方
Responses 先 400，再尝试 OpenCode Responses 时网络失败；同类非法工具历史会放大成
“备用端点网络 502”。

**根因与修复**：

1. `sanitizeResponsesToolPairs` 过去只配对 `function_call(_output)` /
   `custom_tool_call(_output)`，没有覆盖 Codex 的 `tool_search_call/output` 及其他
   `*_call` / `*_output`。现统一按 `call_id` 配对所有工具项：孤立 output 删除，
   完整 call+output 保留。真实截断形状已写入 server 集成回归测试。
2. 三种上游协议的 provider 行为不一致：Responses 会遍历数组，Chat/Messages 只请求
   第一个；Messages 还错误使用全局 `config.apiKey`，忽略模型/端点 key；全局
   `apiBaseUrl` 为数组时 Chat fallback 会拼成
   `[object Object],[object Object]/chat/completions`。现 Chat、Messages、Responses
   都按序 failover，使用实际 provider key，且每次尝试创建独立 timeout signal。
3. URL 过去直接字符串拼接，尾斜杠会生成 `//responses`，已带 `/messages` 等完整路径
   会重复追加。`routes.js` 现统一规范化三种协议后缀；同 URL 不同 key 会作为备用凭据
   保留；非法 upstream、URL 或空 provider 返回明确配置错误（HTTP 503）。
4. 健康探测过去硬编码 `/responses` + Bearer + Responses 请求体，Chat/Messages 会被
   误判。现通过实际解析后的 route 构造协议正确的路径、鉴权头与最小请求体，并用
   `Promise.all` 并行探测，避免 provider 数量增加后探测时间线性累积。
5. 请求入口现把非法 JSON/缺失 model 返回 400；模型或端点显式声明的 `apiKeyEnv`
   缺失时启动直接失败，不再静默发送 `undefined` key。
6. 首次部署烟测发现 DeepSeek 在 `max_output_tokens` 用尽时会返回合法终态
   `response.incomplete`。旧 relay 只把 `response.completed` 视为成功，因此把 200 +
   usage 的完整 incomplete 流误记成 `stream_interrupted`；新健康探针又曾用
   `max_output_tokens: 1` 并只认 completed，导致两个可用 provider 启动后都被误判
   down。现 relay 把 completed/incomplete 都视为成功终态并立即取消剩余上游流；
   健康探针不再强制极小输出上限，增量读取 SSE，遇到 completed/incomplete 立即判定
   healthy，failed 才判定失败。

**验证**：新增真实 tool_search 截断、三协议 provider failover/key、全局 Chat 数组、
URL 规范化、独立 timeout、协议健康探针、`response.incomplete` 终态、请求/配置错误
分类等回归；全套测试通过。

**部署注意**：`/api/restart` 只热加载配置，不会重载源码。本次代码必须重启
Windows 服务 `CodexRouter` 后才生效；重启后应检查 `/healthz`、`/api/status`，
并用最小 Responses 请求确认实际 provider。

## 2026-08-06：全面优化阶段的架构审计基线

**结构证据**：对 `src/` 的 21 个代码文件做了确定性 AST 有向图分析，得到 167 个
节点、430 条边、7 个社区；最高连接点是 `createRouter()`（21 edges）、
`forwardWithFallback()`（19）、`forwardChatRoute()` / `forwardMessagesRoute()`
（各 13）和 `forwardChat()`（12）。`src/server.js` 516 行、`src/fallback.js`
815 行，二者属于不同低 cohesion 社区，却重复持有 provider 遍历、鉴权、超时、
failover、usage、错误映射与流/非流响应政策。上一轮三协议行为漂移正是该结构的实际
故障表现。

**确定性性能/可靠性问题**：

1. `usageLog.log()` 在请求收尾热路径使用 `appendFileSync`；`/api/status` 与
   `/v1/usage` 每次使用 `readFileSync` 读取、切分、JSON.parse 并重新聚合完整 JSONL。
   当前日志已 748,440 bytes，管理页又每 3 秒轮询 `/api/status`，所以仅打开控制台就会
   持续阻塞 Node 事件循环，成本随历史无限增长。
2. `readJson` / `readRawBody` 把全部 chunk 放进数组再 `Buffer.concat`，没有请求体字节
   上限、入站 idle deadline 或客户端 abort 分类；恶意/误配置请求可造成无界内存增长和
   长时间占用连接。
3. SSE 终态、usage、keepalive、reader cancel、first-event retry 分散在
   `fallback.js`、`health.js` 与两套协议 translator 中；本次
   `response.incomplete` 线上误判说明该政策仍需要集中。
4. 管理 mutation 接口（reload/restart/codex apply/restore）没有在非 loopback bind
   时增加控制面鉴权/origin 防护；`admin/app.js` 对 `{ error: { message } }` 直接构造
   `Error(object)`，界面会显示 `[object Object]`。
5. 桌面管理页存在发布漂移：仓库 `admin/index.html`、`admin/app.js` 与
   `desktop/assets/admin` / `desktop/dist/assets/admin` 哈希已不同；打包 App 的
   `seedDataDir()` 又只在 `%LOCALAPPDATA%\CodexRouter\admin` 不存在时复制，已有安装
   永远不会获得新版 UI。

**候选顺序**：优先把三协议 provider 执行政策收进一个 deep module（协议 adapter
只负责转换）；随后把 usage 持久化/索引/轮转收进一个 deep module、增加有界请求入口、
统一 stream lifecycle、保护控制面并修复桌面资源版本迁移。可视化评审报告生成在系统
临时目录 `architecture-review-20260806-131500.html`，不进入仓库。

## 2026-08-06：Provider Execution deep module（第一阶段完成）

**结构重构**：新增 `src/providerExecution.js`，对 Router 暴露单一 `forwardRoute`
Interface；Responses、Chat Completions、Anthropic Messages 都从这里进入。Module 内部
保留一个 Responses 执行路径（含 unsupported TTL、file_id、stream retry、Chat
Fallback）和一个 Chat/Messages 共用的 Protocol Adapter 路径。原来散落在
`server.js`、`fallback.js` 的 4 套 provider loop 已收敛；`server.js` 从 516 行降到
344 行，`fallback.js` 从 815 行降到 468 行，后者只保留 Request Preparation 与
Responses stream relay。

**同时修复的确定性问题**：

1. 显式启用 circuit breaker 时，Chat/Messages 过去完全绕过 breaker；现三协议统一
   allow/recordSuccess/recordFailure，第二次请求会跳过已 open 的 provider。默认
   `circuitBreaker.enabled=false` 未改变。
2. Chat/Anthropic stream translator 遇到上游断流会发 `response.failed`，但过去调用方
   仍把 provider 和 usage 记为成功。translator 现返回明确 boolean；失败流记录
   `ok:false / stream_interrupted`，也不会错误重置 breaker。
3. failover 过去直接丢下非最终 provider 的 HTTP error body，真实连接池可能积累未释放
   body。现切换下一个 Provider 或转 Chat Fallback 前主动 cancel 被丢弃的响应体。
4. 迁移时曾误删 stream non-streaming retry 对 `normalizeResponsesRequest` 的依赖，
   tracer test 立即复现为只有 `response.failed`、没有 completed；已恢复依赖并保持回归。

**验证**：全套 196/196；smoke 200/200；GPT→DeepSeek→GPT→DeepSeek 与反向四跳 mock
均通过；`npm pack --dry-run` 确认新 Module 进入发布包；语法与 `git diff --check`
通过。此次不改变 Request Preparation 顺序、请求体内容、KV Cache 前缀、
`compress.enabled=false` 或默认 breaker 配置。

**独立缓存安全审阅对齐**：工作区出现用户/其他会话生成但未跟踪的
`docs/superpowers/specs/2026-08-06-deepseek-cache-safe-router-recommendations.md`，
本次只读核对、未修改未提交。其 P1 要求 Provider Execution 只接收 immutable
normalized request、不得按 attempt 隐式修改模型输入；当前实现每个协议只生成一次
request body，Provider attempt 仅重复序列化读取，符合要求。后续 P0 优先级需纳入
DeepSeek `prompt_cache_hit_tokens/prompt_cache_miss_tokens` 端到端保真、同会话 Provider
粘性和确定性 prefix regression。

## 2026-08-06：DeepSeek 缓存安全 P0 验收补齐

**usage 保真与统计语义**：

1. `extractUsage()` 现显式识别 DeepSeek 原生
   `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，内部统一为
   `cache_hit_tokens` / `cache_miss_tokens` / `cache_write_tokens`，同时保留旧
   `cache_read_tokens` / `cache_creation_tokens` 别名。
2. 上游未返回的 usage 维度保持 `null`，明确返回 0 才记 0；fallback 的空 usage
   不再覆盖前一次 attempt 的真实 usage。多 attempt 请求只在发生 failover 时附带精简
   attempt 元数据，不记录请求正文。
3. 缓存命中率统一为 `hit / (hit + miss)`；`total_tokens` 修复为 input + output，
   不再把已包含在 input 中的 cache-read token 重复相加。
4. 模型条目可配置 `pricing.cachedInputUsdPerMillion` /
   `uncachedInputUsdPerMillion` / `outputUsdPerMillion`。只有价格齐全且 hit/miss/output
   均明确时才计算 `estimated_cost_usd`、全未缓存基线和缓存节省；未知不按 0 估算。

**Provider 粘性与前缀确定性**：

1. 新增 `providerAffinity.js`：同 session/model 使用本地 HMAC key 做有界 TTL 绑定；
   首次会话服从健康排序，成功 failover 后更新绑定，Provider 恢复不会把进行中会话
   自动切回。无显式 session 时，用 instructions + tools + 第一条历史项做 append-stable
   最佳努力锚点，且剔除随机 item id/status。
2. Provider Affinity 只重排 route.providers，不修改 Router Request，也不向模型前缀
   注入时间、随机 ID、健康信息或 session 字段。
3. 新增三协议确定性回归：同输入 byte-equivalent；追加新消息时旧转换前缀不变；
   tools 数组顺序保持；异常 tool history 修复结果可重复。
4. 新增 `cacheDiagnostics.js`：以 API key 派生的本地 HMAC 记录
   `conversation_key_hash`、`model_visible_prefix_hash`、`tool_schema_hash`、
   `provider_endpoint_hash`、route/translator 版本；不落完整 Prompt、API key、图片或
   原始工具输出。

**稳定压缩 checkpoint**：

1. `compress.minOutputTokens` 默认 2048；阈值以下保持原历史 append-only。
2. 压缩结果按输出指纹持久化为磁盘 checkpoint，服务重启或内存淘汰后仍逐字复用；
   同指纹并发请求使用 in-flight Promise 合并，只调用一次压缩后端，避免并发生成不同摘要。
3. prefix drift safety map 改为按会话隔离；usage 日志关联 checkpoint id、是否复用、
   prefix_changed、tokens_before/after/saved，并在配置 pricing 后用真实 usage 评估费用。
4. 压缩后端故障仍 fail-open。当前本机 `compress.enabled=false` 是用户明确决定，
   本轮没有开启。

**管理页与验证**：管理页增加 cache hit/miss、命中率、费用/覆盖率、checkpoint
复用率与前缀变化率。最终全套 216/216、smoke 200/200、双向四跳 mock 均通过；
`npm pack --dry-run` 确认新增诊断与亲和 Module 进入发布包。

**部署验证**：commit `bd75e5d` 已推送并重启 `CodexRouter`，Node PID
`12232 → 37556`；`/healthz` 200，管理页已包含 Cache Miss、费用与 checkpoint 指标。
真实 DeepSeek 流式请求 200 completed，最新 schema v2 usage 为 hit=0、miss=116，
conversation/prefix/tool/provider 四类 HMAC 指纹齐全、`ok:true / error:null`；GPT 的
11 项 tool_search 截断边界请求 200 completed。最近的 `stream_interrupted` 仍是部署前
`2026-08-06T04:54:12.493Z` 的旧记录，新版本未新增。

## 2026-08-06：Usage Store 移出事件循环同步 I/O 热路径

**基线**：`usage/requests.jsonl` 为 751,399 bytes / 2,775 行。旧实现每次
`/api/status` 或 `/v1/usage` 都 `readFileSync + split + JSON.parse + aggregate`：
40 次本地读盘聚合中位 5.92 ms、p95 10.73 ms；线上 `/api/status` 20 次中位
11.52 ms、p95 49.04 ms。管理页每 3 秒轮询会持续阻塞 Node 事件循环，且日志越大越慢。

**修复**：

1. `createUsageLogger` 启动时只加载 JSONL 一次；`log()` 先写内存快照，统计立即可见，
   不再在请求 finalize 热路径调用 `appendFileSync`。
2. JSONL 以 `usageLog.flushDelayMs`（默认 10 ms）异步批量 append；`flush()` 覆盖写入
   期间新到的记录，热重启/优雅停止先停止接收请求，再 flush，避免尾记录丢失。
3. `/api/status` 与 `/v1/usage` 改用内存聚合；相同 filter + 分钟时间桶按日志版本缓存，
   新记录自动失效缓存。当前文件首次聚合约 6.90 ms，随后 1,000 次缓存聚合中位
   0.0005 ms、p95 0.0012 ms。
4. 新增即时可见、异步持久化、显式 flush、聚合对象复用和写入失效回归。全套
   217/217、smoke 200/200、pack dry-run 通过。

**部署复测**：commit `671a6ad` 已推送并重启服务，Node PID
`37556 → 22648`。同样 20 次线上 `/api/status`：中位 1.52 ms（原 11.52 ms，约
下降 87%），p95 28.74 ms（原 49.04 ms）。真实 DeepSeek 请求 completed 后，
`/v1/usage` 在下一次查询立即从 2,775 增到 2,776；JSONL 文件由 751,399 增到
752,220 bytes，异步持久化成功。

## 2026-08-06：Request Ingress 有界化

**根因**：`readJson` / `readRawBody` 过去把所有 chunk 无上限放进数组再
`Buffer.concat`，也没有入站 idle deadline。伪造超大 `Content-Length`、持续 chunked
灌入或写半截后长期停顿，都能在进入路由前无界占用内存/连接。

**修复**：

1. 新增 `limits.maxRequestBodyBytes`（默认 64 MiB）与 `requestBodyIdleMs`（默认 120s）。
2. `Content-Length` 超限在读取前立即 413；无长度 chunked 请求逐块累计字节，跨块超限
   同样 413；每次 `iterator.next()` 使用独立 idle timer，停顿超时返回 408 并关闭连接。
3. JSON 语法/字段错误继续 400，模型/Provider 配置错误保持原分类；读取结果本身不改写，
   不影响 DeepSeek 模型可见前缀。
4. 新增 declared length、chunked overflow、stalled body 三个真实 HTTP 回归。最终全套
   220/220、smoke 200/200、`npm pack --dry-run`、语法检查与 `git diff --check` 均通过。

**部署验证**：commit `71a0a92` 已推送并重启 `CodexRouter`，Node PID
`22648 → 40936`；`/healthz` 200，`compress.enabled=false` 与 circuit breaker 默认关闭
均保持。真实 DeepSeek 非流式请求 200 completed；原始 TCP 只声明
`Content-Length: 67108865`、不发送 body，8.4 ms 即收到 413 且 `Connection: close`，
证明默认 64 MiB 快速拒绝路径在线生效。

## 2026-08-06：管理面访问控制与桌面资源迁移

**根因**：

1. `/admin`、`/api/*`、`/v1/usage` 与 `/v1/ctx/*` 过去不检查监听地址、身份或浏览器
   Origin；把 `host` 改为非 loopback 后会直接暴露配置读取、热加载、重启和原始压缩
   存档读取能力。
2. 管理页把 `{ error: { message } }` 的整个 `error` 对象传给 `Error`，最终显示
   `[object Object]`。
3. 打包桌面壳只在 admin 目录不存在时复制资源，已安装版本永远收不到新页面文件；桌面
   初始配置还错误地默认开启 circuit breaker。

**修复**：

1. 新增独立 `Management Access` 策略，在路由分派和读取 body 前统一判定。loopback
   保持免 token；非 loopback 默认 403，显式 `management.allowRemote=true` 后必须从
   `management.tokenEnv` 注入 Bearer token，使用 SHA-256 + `timingSafeEqual` 比较。
2. 所有浏览器状态变更同时校验可信 Origin 与 `Sec-Fetch-Site`；无 Origin 的 CLI/自动化
   仍兼容。管理响应 `no-store`，静态页增加 CSP、DENY frame、nosniff 与 no-referrer。
3. 管理页 API client 正确展开嵌套错误；远程 token 只存当前标签页 `sessionStorage`，
   错误 token 停止重复弹窗，不进入 config、响应或日志。
4. npm 发布包显式包含 `admin/`。桌面打包生成 SHA-256 asset manifest，启动时升级并校验
   应用自带 admin 文件、清理陈旧资源，同时保留既有 config/数据；新桌面配置的压缩和
   circuit breaker 均默认关闭。

**验证**：新增远程拒绝、Bearer、Origin/Fetch Metadata、错误展开、token header、桌面
资源升级/篡改修复/配置保留回归。全套 229/229、smoke 200/200、pack dry-run 确认
`admin/apiClient.js` 与 `src/managementAccess.js` 入包；desktop prep manifest schema=1、
packageVersion=0.2.0、包含 6 个资源且含 API client。此访问层不读取或改写 Router Request，
不影响 DeepSeek 模型可见前缀、tools 顺序、Provider Affinity 或 cache usage 保真。

**部署验证**：commit `adc1336` 已推送并重启 `CodexRouter`，Node PID
`40936 → 51716`；线上仍为 loopback、无管理 token、`compress.enabled=false`、circuit
breaker 关闭。`/admin` 与 `apiClient.js` 均 200，CSP/no-store/DENY frame 生效；带
`Origin: https://evil.example` 的 `POST /api/restart` 返回 403，PID 保持 51716。
真实 DeepSeek 请求 200 completed。实际浏览器加载 ES module 后显示 6 张总览卡、
v0.2.0 与已连接状态，控制台无错误。

## 2026-08-06：Request Lifecycle 与 SSE 首事件

**根因**：

1. server 已创建客户端断开 signal，但 `forward()` 重新组装 Provider Execution options
   时静默漏传，导致客户端关闭后上游 fetch/reader 继续运行。
2. `relayUpstreamSmart` 预读到第一个完整 SSE 事件后把它放在 `initial.buffer`，
   `pipeSseWithNormalization` 却先等下一块才 flush；首事件后停顿时，客户端只能等到
   10 秒 keep-alive 才看到任何字节。
3. Provider attempt 只有超时 signal，没有父请求 signal；SSE generator/reader 缺少统一
   abort/cancel/release，首事件等待的 `Promise.race` timer 也不会在 chunk 提前到达时清理。

**修复**：

1. 新增 `Request Lifecycle`：TCP/response close 与 request aborted 产生父 signal，
   每个 Provider attempt 再叠加独立 deadline；Responses、Chat、Messages、非流重试与
   SSE reader 全链路传播。
2. 客户端取消立即 cancel 锁定 reader、释放 lock、停止 keep-alive，不做 failover，
   usage 记 499/client_disconnected，但不调用 breaker failure/success。
3. 已预读的完整 SSE part 在进入 read loop 前立即 flush；首事件 deadline timer 每次
   读取后清理并 `unref`，正常 terminal、abort 与 response destroy 都统一 cancel/cleanup。

**验证**：真实 TCP 客户端收到 `response.created` 后断开，约 100 ms 内 attempt signal
aborted、reader cancel=1；threshold=1 的 breaker 仍 closed，total/failed 均为 0。
Chat 转换流 abort 同样安静返回 false，不生成伪 `response.failed`。全套 231/231、
smoke 200/200、pack dry-run 38 个文件且包含 `src/requestLifecycle.js`；所有临时
`[DEBUG-*]` 已清除。生命周期只控制 I/O，不读取或改写 Router Request，因此不影响
DeepSeek 前缀、tools 顺序、cache usage 与 Provider Affinity。

**部署验证**：commit `8dbfc37` 已推送并重启 `CodexRouter`，Node PID
`51716 → 61096`，压缩与 circuit breaker 仍关闭。真实 DeepSeek 流在客户端收到首批
2,010 bytes 后主动断开，usage 最终为 `status=499 / ok=false /
error=client_disconnected`；随后完整 DeepSeek 非流请求 200 completed，PID 保持不变。

## 2026-08-06：路由热加载事务与 Provider 身份修复

**真实回归**：

1. `/api/reload` 的候选校验会在确认端口等运行时约束前直接覆盖 `catalog.json`；候选
   最终 400 或新端口 bind 失败时，配置仍是旧版但 catalog 已变成候选版。
2. 热重启过去 `closeAllConnections()`，会直接切断正在生成的 SSE；初版 drain 修复又
   没有持续回收生成完成后的 keep-alive socket，单次替换会额外拖约 5 秒。
3. Request Lifecycle 在 Responses/Chat 已传播，但 `route.upstream === messages` 分支
   漏传父 signal，客户端关闭后 Anthropic reader 仍占用上游连接。
4. Route 明确保留“同 URL、不同 key”的备用凭据，但 Provider Affinity、Health 与
   Circuit Breaker 过去只按 endpoint 建状态：备用凭据成功后下一轮仍回主 key，一个
   key 的失败也会污染另一个 key。
5. `catalog.json` 过去列出全部内置模型，即使 `apiBaseUrl:null` 且模型没有自定义
   Provider；客户端可选择这些必然返回 503 的幽灵模型。

**修复**：

1. `resolveConfig()` 从文件读取解耦；热加载 `prepareConfig()` 只解析/校验/构建内存
   catalog，不写文件。替换操作串行执行：旧 listener 停止接新请求但保留活动连接，
   新 listener bind 成功后才用同目录临时文件原子发布 config/catalog；写盘失败恢复
   原文件，bind 失败恢复旧 listener。
2. retiring Router 持续关闭已转 idle 的 keep-alive 连接；`stop()` 同时等待当前与所有
   retiring Router，并在 15 秒后才强制断开，正常 SSE 不再被热加载取消。
3. Messages Provider Execution 补传 Request Lifecycle signal；客户端断开会 abort
   attempt、cancel reader，行为与 Responses/Chat 一致。
4. Provider Affinity 绑定完整 endpoint/credential HMAC；Health 与 Circuit Breaker
   同样按凭据隔离状态，status/log 只暴露不可逆短指纹，不落 API key。成功 hook 传递
   immutable Provider 描述，不修改 Router Request。
5. `listRoutedModels()` 现在实际调用 Route 解析，只把当前存在 Provider 的模型写进
   catalog。本机配置的有效目录收敛为 6 个 GPT 模型和 `deepseek-v4-flash`。

**缓存安全验收**：本轮没有改变 Request Preparation、Protocol Adapter 请求结构、
tools 顺序、usage 提取或压缩 checkpoint。DeepSeek hit/miss、确定性前缀、真实费用评估
相关回归继续通过；同 URL 备用凭据现在也能保持同会话 Provider/账号粘性。

**验证**：热加载无副作用、端口冲突自动回滚、活动 SSE drain、Messages 客户端取消、
同端点多凭据 affinity/health/breaker、catalog 可路由性均有回归；全套 241/241，
smoke 200/200，双向四跳 mock、pack dry-run、语法检查与 `git diff --check` 均通过。

**部署验证**：commit `211bdf1` 已推送并重启 `CodexRouter`，Node PID
`61096 → 18820`；`/healthz` 与 `/api/status` 正常，压缩和 circuit breaker 继续保持
关闭。线上 catalog 从全部内置默认模型收敛为 7 个真实可路由模型（6 个 GPT +
`deepseek-v4-flash`）。真实 DeepSeek 非流请求 200（合法 `response.incomplete`），
上游 Responses usage 的 `input_tokens_details.cached_tokens=0` 被 schema v2 日志正确
归一为 `cache_hit_tokens=0 / cache_miss_tokens=90`，四类 HMAC 指纹齐全且
`ok:true / error:null`。用当前 config 调 `/api/reload` 后 PID 不变、服务健康、
config/catalog SHA-256 不变，管理页加载到“配置已校验并开始热加载”新版文案。

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


## 2026-08-05：路由语义变更（custom 独占）+ gpt-5.6-sol 排查 + 测试污染坑

- **新路由语义**（用户要求"gpt 系列优先 ergou 而不是 opencode"）：
  - `resolveRoute`：模型配置了自定义 `endpoint` 后，providers **只含自定义端点（数组按序）**，不再追加全局 `apiBaseUrl`。未配置自定义端点的模型才用全局。
  - `config.json` 的 `apiBaseUrl` 可设为 `null`：彻底关闭全局/chat 兜底。`fallback.js` 新增 `hasChatFallback()`，`apiBaseUrl` 为空时不再拼 `null/chat/completions`，而是透传最后一个 provider 的真实错误（http_error 用 relayError 原样返回，网络错误返回 502）。
  - file_id 跳过逻辑改为：仅当"自定义 provider 之外还存在全局 provider"时才跳过自定义端。
- **gpt-5.6-sol 排查结论**：ergou 有 sol 且流式 200；**opencode 模型列表无 sol**（`Model gpt-5.6-sol is not supported` 401），所以旧语义下 ergou 一失败就 fallback 到 opencode 必然报"不支持该模型"。opencode 对 gpt-5.6-luna 还会 fetch 断连；deepseek-v4-flash 在 opencode /responses 200、/chat/completions 401（同一 key）。新语义后 gpt 只走 ergou，不再碰 opencode。
- **测试污染坑（重要）**：`fallback.js` 模块级 `unsupportedResponses` 缓存跨测试共享。语义变更后"custom 400 → lastProvider"会把模型永久缓存为 unsupported，且旧的 unsupported 测试结束不清缓存，导致后续所有同模型测试直接走 chat（表现为 calls=[chat]、Cannot read 'includes' 等怪错）。修复：相关测试结束加 `clearUnsupportedCache()`；400 用例改 500 避免入缓存。
- **服务加载**：服务进程需 Restart-Service 才加载新代码（热加载只换配置）。重启后实测：deepseek→opencode 200、gpt-5.6-luna→ergou 200，无 chat 兜底。165 测试全过。
- config.toml 当前是 deepseek（用户因报错切回）；gpt 系列要恢复可在 admin「Codex 配置」一键 apply minar_route。

## 2026-08-05：sol 高并发 401 最终根因 + fallback 缓存治理（已修复）

- **现象**：用户切 luna 后仍在报 `unexpected status 401 Unauthorized: Model gpt-5.6-sol is not supported, url: http://127.0.0.1:15722/v1/responses`，高并发时明显。
- **铁证**（usage/requests.jsonl）：同一时段 sol 既有 `ergouapi.com/v1/responses` 200，也有 `opencode.ai/zen/go/v1/chat/completions` 401；路由把 sol 请求导到了 opencode chat 兜底。
- **根因（两层）**：
  1. `config.json` 当时**缺 `apiBaseUrl` 字段**，loadConfig 合并默认值 `https://opencode.ai/zen/go/v1` → `hasChatFallback()` 恒 true。ergou 一旦 4xx/瞬时失败，最后兜底就会打到 opencode chat（key 不支持该模型 → 401）。上一轮记录写了“apiBaseUrl 可设为 null”但实际未落盘。**已补 `apiBaseUrl: null` 落盘**（config.json 被 gitignore，改动只在本机生效）。
  2. `fallback.js` 的 unsupported 缓存是**按模型全局 Set、永不过期、且任何 400/404/405 都缓存**。一次瞬时失败就把整个模型标记为 unsupported，后续请求全部短路到 chat；多个并发请求还会放大污染。
- **修复（src/fallback.js）**：
  - 缓存改为 `Map`，key = `model::endpoint`（**per-provider**），TTL 5 分钟（`UNSUPPORTED_CACHE_TTL_MS`），过期自动删除并重试上游。
  - 只有**明确表示模型不存在/不支持**的错误文本才入缓存（正则匹配 not supported / unknown model / model not found 等），瞬时 401（鉴权）、500、网络错误一律不缓存。
  - 缓存命中时只跳过该 provider；最后一个 provider 命中且无 chat 兜底时返回 502，不会污染其他模型/provider。
  - 提供 `__setUnsupportedCacheNowForTest` / `__resetUnsupportedCacheNowForTest` 供测试注入时钟。
- **验证**：`test/fallback.test.js` 新增 3 个用例（401 不缓存、per-provider 不污染其他模型、TTL 过期重试）；全套 **168 测试全过**；`loadConfig` 实测 `apiBaseUrl:null` → `hasChatFallback=false`，sol/luna → `https://ergouapi.com/v1/responses` 唯一 provider；Restart-Service 后真实流式请求 `gpt-5.6-sol` → ergou `/responses` 200（usage 确认，不再 401）。
- **注意**：`compress.enabled=false` 是用户**故意关闭**（说稍后排查），不要擅自改回 true。`catalog-template.json` 的 `truncation_policy.limit 10000→100000` 也是用户已有改动，保留未提交。

## 2026-08-05：唯一 provider 熔断导致 502（已修复）

- **现象**：上轮修复后出现 `unexpected status 502 Bad Gateway: all providers skipped and no chat fallback configured for gpt-5.6-sol`。
- **根因**：熔断器对 `gpt-5.6-sol::ergou /responses` open（5 次请求 4 次失败），而 gpt-* 只有 ergou 一个 provider 且 apiBaseUrl=null 无 chat 兜底 → `allow()` 拒绝后直接 502，60 秒内完全不可用。
- **修复**：
  - `src/circuitBreaker.js`：`allow(key, options)` 支持 `forceProbe`；open 状态下即使未到 timeout 也立即转 half_open 放行一个探测请求（语义与超时后的半开探测一致，并发时仍只有一个 permit）。
  - `src/fallback.js`：`breaker.allow(breakerKey, { forceProbe: lastProvider })`——**仅最后一个 provider 且无后续兜底时**强制探测，多 provider 场景维持原短路行为。
- **验证**：`test/circuitBreaker.test.js` 新增 forceProbe 用例；`test/fallback.test.js` 新增“单 provider 熔断仍探测上游”用例；**170 测试全过**。顺带修复 `test/usageLog.test.js` 的按墙钟跨午夜脆弱断言（锚点改本地中午）。服务重启后真实 sol 请求 200。

## 2026-08-05：熔断器按用户决定关闭（默认 disabled）

- **决定**：用户在 forceProbe 修复后又表示“熔断加了以后问题很多，要不关了算了”，已照办。
- **改动**：`config.json`（gitignored，本机生效）与 `config.example.json` 的 `circuitBreaker.enabled` 均设为 `false`；README.zh-CN/README.en 同步说明“默认关闭，可在配置开启”。服务重启后 `api/status` 确认 `circuitEnabled=false`、熔断器实例数为 0，sol 真实请求 200。
- **代码保留**：`circuitBreaker.js` 的 forceProbe 逻辑与相关测试仍然保留，未来开启时可复用；熔断代码在 `enabled:false` 时完全旁路（allow 恒 true、record 为 no-op）。
- **注意**：`catalog-template.json` 的 truncation_policy.limit 改动与 `src/compression.js.bak-20260805` 都是用户已有文件，未提交未动。

## 会话工具坑：apply_patch 参数嵌套导致反复失败

- **症状**：报 `invalid patch: The first line of the patch must be '*** Begin Patch'`，重试多轮仍失败。
- **根因**：把补丁文本多包了一层 JSON 对象字符串传进 `arguments`，工具解析后第一行变成 `{...}` 而非 `*** Begin Patch`。正确用法是 `arguments` 的值等于补丁文本本身（仅 JSON 转义），`*** Begin Patch` 必须是第一行。
- **应对**：确认格式后已恢复 apply_patch；万一再次失败，小改动可用精确字符串替换脚本（Node readFileSync/writeFileSync + 唯一锚点校验），并用 `git diff` 全量审计。

## 2026-08-05：apply_patch 从 chat/completions 还原为 custom_tool_call（已修复）

- **现象**：Codex 会话报 `apply_patch invoked with incompatible payload`。
- **根因**：`apply_patch` 是 freeform 工具，请求方向以 `custom_tool_call` 发出；但 chat/completions 上游把 input 转义成 `function.arguments` 字符串返回，路由直接转成 `function_call`，Codex handler 收到不兼容 payload。
- **修复**（`src/translate/chatToResponses.js`）：非流式 `chatToResponsesObject` 与流式 `translateChatStreamToResponses` 两条路径都检测 `name === 'apply_patch'`，把 `function.arguments` 里 JSON 转义的字符串反转义为 `input`，输出 `custom_tool_call`（保留 call_id），并发出 `response.custom_tool_call.done`。其他工具维持 `function_call`。
- **测试**：`test/chatToResponses.test.js` 新增 2 个用例（非流式/流式 apply_patch 还原）；**172 测试全过**。已提交 `744c6b3` 并推送，服务重启（PID 41804）验证转换正确。
- **注意**：该修复是用户手动写的代码（工作区未提交时我确认后补了测试），不是路由自动生成的。

## 2026-08-06：Provider 取消路径与稳定 checkpoint 并发写入（本阶段）

- **半开熔断取消死锁**：半开状态唯一 probe 在客户端断开后过去不会归还 permit，后续请求会永久得到 502。`src/circuitBreaker.js` 新增 `releasePermit()`；`src/providerExecution.js` 的所有 Responses/Chat/Messages 客户端取消分支都传递 `breakerKey + permit`，中性释放，不增加 `totalRequests` / `failedRequests`，也不污染 provider 健康统计。
- **Converted Route Provider 身份**：Chat/Messages 非流成功现在把完整 immutable Provider 交给 `recordSuccess()`，同 URL 的备用凭据会正确更新会话粘性和 provider endpoint 观测，不再降级成 endpoint 字符串。
- **压缩热路径**：`src/compression.js` 的 checkpoint、原文归档和读取改为 `node:fs/promises`；单个大 item 只做一次 `JSON.stringify`，复用序列化结果计算 hash/字符数/token/归档。磁盘发布采用同目录临时文件 + hard link 的 first-writer-wins；独立并发 writer 若生成不同摘要，会读取磁盘 canonical checkpoint，保证模型可见前缀收敛且不每轮重写历史。
- **性能证据**：本地 mock 的 4 × 4 MiB 工具输出基线为总耗时 318 ms、最大事件循环延迟 283 ms；优化后为 174 ms、31 ms。线上 `compress.enabled=false` 仍按用户决定保持关闭。
- **验证**：新增独立 writer 收敛、半开取消 HTTP/TCP 回归与 Chat 同 URL 双凭据粘性回归；定向和全套测试均为 **245/245**，`npm run smoke`、GPT→DeepSeek→GPT→DeepSeek 与反向四跳 mock、`npm pack --dry-run`、全部 `node --check`、`git diff --check` 均通过。
- **约束复核**：已阅读并纳入 `docs/superpowers/specs/2026-08-06-deepseek-cache-safe-router-recommendations.md`（commit `45839bc`）；本阶段未改变 DeepSeek hit/miss usage、Provider 粘性、确定性工具顺序/模型前缀、稳定 checkpoint 或按实际费用评估逻辑，也未记录 API key、完整 Prompt、图片或原始工具输出。

## 2026-08-06：Usage Store 有界化（本阶段）

- **根因**：`usageLog.js` 启动同步读取并解析完整 `requests.jsonl`，`entries` 进程内无限增长；管理页虽然已使用内存聚合，但日志历史越大，启动和内存成本仍线性增长，活动文件也没有轮转。
- **修复**：新增 `usageLog.maxFileBytes`（默认 8 MiB）、`maxFiles`（默认 3）、`maxEntries`（默认 50,000）与 `startupMaxBytes`（默认 8 MiB）。写入链按 JSONL 行切分批次，超过活动文件上限后串行轮转 `.1`…`.N`，删除过期后缀；独立写入仍由原有 Promise 链串行化。
- **启动成本**：启动只从活动/轮转文件尾部读取有界字节，并丢弃截断的首行；保留的记录按时间顺序合并后再进入有界 ring snapshot。内存淘汰只影响进程内 `/v1/usage` 聚合，不删除已持久化 JSONL。
- **验证**：新增轮转批量写入、旧后缀清理、内存上限、启动 tail 完整行回归；Usage Store/配置定向测试 **24/24** 通过。当前线上日志约 759 KiB，低于默认 8 MiB 上限，未主动轮转/删除已有日志。
- **缓存约束**：此阶段只限于本地 usage 观测与持久化，不改变模型可见请求、DeepSeek hit/miss 字段、Provider 粘性、工具顺序或压缩 checkpoint。
- **部署复测**：commit `7577bbe` 已推送并通过服务级重启加载；PID `37648 → 49600`，`/healthz` 200，`api/status` 显示 `maxFileBytes=8388608`、`maxFiles=3`、`maxEntries=50000`、`startupMaxBytes=8388608`。真实 Responses 探针返回 200/合法 `incomplete`，`/v1/usage` 请求数 `923 → 924`，异步 JSONL 持久化正常；`compress.enabled=false` 与 `circuitBreaker.enabled=false` 保持不变。

## 2026-08-06：健康探测生命周期与连接池治理（本阶段）

- **复现**：慢探针在 `intervalMs` 小于请求耗时时会叠加并发；Chat/Messages 非流探针返回后不 cancel body；Router 热加载/停止只清理定时器，不取消已发出的探针，旧 generation 仍可能在退役后写入 `provider_health`。
- **修复**（`src/health.js`）：调度周期 single-flight；每个探针使用可取消的 `createAbortScope`，stop 时 abort 所有 in-flight probes；非 SSE body 在判断健康后主动 cancel；退役信号下不再更新 unhealthy 集合或触发状态回调；Responses SSE 读取也响应 abort；无显式模型列表时同时扫描单 endpoint 和 endpoint 数组。
- **验证**：新增单 endpoint 覆盖、非流 body 释放、慢周期不重叠、stop abort/忽略 retired result 四个回归；health 定向 9/9、全套 **251/251**、smoke、双向四跳 mock、`node --check` 与 `git diff --check` 均通过。
- **缓存约束**：健康探针仍只发送固定最小 probe，不注入会话/时间/随机字段；本阶段未改变 DeepSeek 模型可见前缀、usage hit/miss、Provider 粘性或协议转换顺序。
- **部署坑**：commit `e525b5e`、`552953c` 已推送，但本次 `sudo Restart-Service CodexRouter` 在 Windows 强制新窗口/UAC 模式下挂起；`sudo --inline` 明确被系统策略拒绝。当前服务 PID `49600` 仍是旧代次，端口健康但尚未加载本阶段源码。下一次需用户在可见的管理员 PowerShell 执行 `Restart-Service CodexRouter -Force`，再核对 `/api/status` 与进程启动时间。

## 2026-08-06：Messages usage 合并、unsupported Provider 缓存与管理页轮询（本阶段）

- **Anthropic 流式 usage 根因**：Messages `message_start` 先给输入 token，末尾 `message_delta` 可能只给输出 token；旧转换器只在 `message_delta` 写入 usage，导致 completed 顶层 `input_tokens` 丢失。现在按事件顺序合并 usage，后续非空字段覆盖同名字段，保留早期输入与缓存维度。
- **Responses unsupported 缓存根因**：`providerExecution` 只在最后一个 Responses Provider 上缓存明确的 `model not supported`，多 Provider 路由会每轮重复尝试永久不兼容的首个端点。现在对任何明确 unsupported 的 Provider 按 `model::endpoint` 缓存，仍保持 5 分钟 TTL、严格错误文本匹配，不缓存瞬时 401/500/网络失败。
- **管理页轮询**：新增 `admin/polling.js` 的 `createPollGate`；状态、用量、Codex、配置请求共享 single-flight promise，标签页隐藏时暂停后台状态/用量刷新，重新可见后立即刷新，避免服务重启期间请求堆积。
- **回归证据**：新增 Anthropic `message_start`/`message_delta` usage 回归、unsupported 非末 Provider 回归及 3 个 poll gate 单测；全套测试 **256/256**，`node --check admin/app.js admin/polling.js`、`git diff --check` 均通过。
- **缓存约束**：这些改动只修复 usage 观测、Provider 尝试选择和管理面轮询，不改变 DeepSeek 模型可见前缀、工具顺序、Provider 粘性、稳定压缩 checkpoint 或 hit/miss 字段。

## 2026-08-06：热加载旧 generation 有界 drain（本阶段）

- **根因**：`replaceServer()` 过去只调用 `server.close()`，旧 generation 的活动 SSE 永不结束时，热加载会把旧 server、health/usage 资源和连接永久留在 `retiring` 集合；`stop()` 的 force-close 只覆盖最终停止，不能治理连续 reload。
- **修复**：`timeouts.drainMs`（默认 15 秒）现在同时用于热加载和停止 drain；到期调用 `closeAllConnections()`，清理 `__routerCleanup` 并释放 generation。保留活动请求在窗口内自然完成，超过窗口才强制结束。
- **验证**：新增永不结束 SSE 的热加载回归（`drainMs=40`），确认 replacement listener 接管后旧上游 body 被 cancel、客户端流结束；`test/main.test.js` 4/4 通过。
- **缓存约束**：只改变旧 generation 的资源生命周期，不改变新请求模型可见内容、DeepSeek hit/miss usage、Provider 粘性或工具顺序。

## 2026-08-06：管理页移动端与键盘可访问性收口（本阶段）

- **修复**：`admin/style.css` 为 topbar、按钮组和小屏布局增加换行；600px 以下收窄侧栏、把操作区堆叠到可点击宽度、保留表格横向滚动，并给导航/按钮/select/config editor 增加 `:focus-visible` 焦点环。
- **约束**：纯静态 UI 改动，不改变管理 API、轮询 single-flight 或任何模型可见请求。

## 2026-08-06：升级模型的 unsupported / breaker 隔离（本阶段）

- **根因**：图片触发 DeepSeek→Luna 后，Provider Execution 仍用客户端 `displayModel` 作为 unsupported 缓存和 breaker key；Luna 的明确不支持错误会污染 `deepseek-v4-flash` 的后续普通文本请求。
- **修复**：Responses 与 converted route 都以实际发送的 `requestBody.model` 作为 Provider 能力/熔断身份；tracker、日志和客户端响应继续使用原始 display model。unsupported 缓存仍按 `effective_model::endpoint`、5 分钟 TTL、严格错误文本隔离。
- **验证**：新增“Luna 图片失败后 DeepSeek 文本仍成功”回归，且启用 breaker 验证不会共享错误状态；fallback 定向测试 **54/54** 通过。
- **缓存约束**：此修复只隔离 Provider 能力状态，不改变升级后的请求内容、图片保留策略、DeepSeek 前缀或 usage hit/miss 字段。

## 2026-08-06：本轮全面排查验收与部署状态

- **源码 HEAD**：`5240fe4`，工作树干净并已推送 `origin/master`。
- **验证**：全套测试 **259/259**；`npm run smoke` 通过；`npm pack --dry-run` 通过；`src/` 与 `admin/` 全量 `node --check` 通过；`git diff --check` 通过。
- **本轮修复汇总**：Anthropic 流式 usage 合并、unsupported 非末 Provider 缓存、管理页 single-flight/隐藏暂停、热加载有界 drain、升级模型的 unsupported/breaker 隔离，以及管理页小屏/focus 可访问性。
- **线上部署**：Windows `CodexRouter` 服务仍运行旧 Node PID `49600`，`/api/status` 显示 `healthCount=2`、`compress.enabled=false`、`circuitBreaker.enabled=false`；新健康探测生命周期、drain 和升级模型隔离代码需管理员执行 `Restart-Service CodexRouter -Force` 后再核验。

## 2026-08-06：健康探测覆盖 modelPatterns（本阶段）

- **根因**：自动健康探测只扫描 `config.models` exact entries；`modelPatterns.gpt-*` 虽然实际路由到自定义 Provider，却没有任何主动探针和 `provider_health` 状态。
- **修复**：`health.js` 通过 `listRoutedModels()` + `getModelEntry()` 展开已知模型元数据/目录中的 pattern 命中项；只发送真实模型名，不会把 `gpt-*` 配置语法发给上游；显式 `healthCheck.models` 仍保持最高优先级。
- **验证**：新增 pattern Provider 探针回归，health 定向测试 **10/10** 通过。
- **缓存约束**：探针仍使用固定最小请求，不注入会话、时间、随机字段，不改变 DeepSeek 模型可见前缀或正式请求路由。
