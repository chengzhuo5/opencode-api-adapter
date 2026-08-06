# DeepSeek 前缀缓存安全的路由改造建议

> 日期：2026-08-06  
> 性质：给当前路由重构会话的独立审阅建议，不直接修改正在重构的代码。  
> 最高约束：任何路由、协议转换、上下文压缩和工具处理都不能以降低 DeepSeek 前缀缓存命中率为代价。

## 结论

当前路由已经具备模型路由、Provider fallback、健康检查、熔断、Responses/Chat/Anthropic 协议转换、上下文压缩和 usage 日志，不建议再叠加 LiteLLM 等第二层代理。

本轮重构最值得补齐的不是更多路由策略，而是：

1. DeepSeek 缓存 hit/miss 指标端到端保真。
2. 同一会话稳定落到同一 Provider。
3. 模型可见前缀保持 append-only、确定性和可观测。
4. 压缩收益按“最终费用”评估，而不是只看减少了多少 Token。

DeepSeek 官方缓存说明：

- [上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache)
- [Chat Completion usage 字段](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)

## P0：补齐 DeepSeek 缓存指标

审计时 `src/usageLog.js::extractUsage()` 已兼容 OpenAI/Anthropic 风格的：

- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- `input_tokens_details.cached_tokens`
- `prompt_tokens_details.cached_tokens`

但还应显式兼容 DeepSeek 原生字段：

- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`

建议内部统一为：

```text
input_tokens
output_tokens
cache_hit_tokens
cache_miss_tokens
cache_write_tokens
```

兼容旧字段时可以继续输出 `cache_read_tokens`，但它应明确等价于 `cache_hit_tokens`，不能把 miss 或普通 input 混进去。

缓存命中率应计算为：

```text
cache_hit_tokens / (cache_hit_tokens + cache_miss_tokens)
```

注意：

- 上游没有返回 usage 时使用 `null`，不要写成 0；否则会把“未知”统计成“未命中”。
- 流式路径从最终 completion event 提取 usage。
- 非流式、Responses passthrough、Responses→Chat fallback、Chat→Responses 重放都必须保留缓存字段。
- 每次 Provider attempt 单独记录 usage，最终请求汇总不能用 fallback 的空值覆盖主请求的真实值。

## P0：增加缓存诊断指纹

不要记录完整 Prompt。建议每个请求记录以下不可逆指纹：

```text
conversation_key_hash
model_visible_prefix_hash
tool_schema_hash
route_policy_version
translator_version
compression_checkpoint_id
provider_endpoint_hash
```

建议使用本地 HMAC，而不是裸 SHA-256，避免对短 Prompt 做字典猜测。

`model_visible_prefix_hash` 的输入应包括模型真正能看到的：

- instructions / system / developer 内容
- 历史 input items
- tools 的名称、描述、schema 和顺序
- 影响模型输入的协议转换结果

不要把以下内容放进模型前缀：

- 当前时间
- 请求 ID
- 随机 nonce
- 运行次数
- 动态健康状态说明
- 日志或追踪 metadata

这些信息应只存在于 HTTP header、日志或本地 tracker 中。

## P0：路由必须具备会话粘性

DeepSeek 缓存不能假设在不同 Provider、账号或兼容代理之间共享。

对于包含长历史的缓存敏感请求，不建议每轮执行随机、轮询或纯延迟优先路由。建议：

```text
sticky_key = HMAC(session_id + requested_model)
sticky_key -> provider
```

行为要求：

1. 同一会话、同一模型默认持续使用同一 Provider。
2. 仅在明确失败、熔断或能力不兼容时切换。
3. fallback 成功后，在一个有界 TTL 内更新会话粘性。
4. Provider 恢复后不要在会话中途自动切回；新会话再使用恢复后的首选 Provider。

健康检查可以决定“新会话优先级”，不应持续打散已有长会话。

## P0：协议转换必须确定性

相同输入经过转换后，应生成稳定的模型可见结构。

重点约束：

- 保持 messages/input items 的相对顺序。
- 保持 tools 数组的顺序。
- 不要根据运行时 Map、Set、对象遍历或健康状态动态重排工具。
- 如果必须去重，采用稳定的 first-wins 或 last-wins 规则，并写测试固定行为。
- 修复错位 tool call 时，生成的占位内容必须是固定常量，不能包含时间、随机 ID 或错误堆栈。
- 上游 item ID 只在协议要求时生成；不得把随机 ID 写入后续模型可见历史。

建议为关键转换函数增加确定性测试：

```text
same input -> byte-equivalent normalized model-visible payload
```

测试时应忽略 HTTP header、日志时间等模型不可见 metadata。

## P0：重新审视上下文压缩

DeepSeek 缓存要求相同前缀。即使压缩减少了输入 Token，只要每轮重新生成历史摘要，也可能造成缓存 miss，最终费用反而上升。

建议采用“稳定压缩检查点”：

1. 未达到固定阈值时保持历史 append-only，不压缩。
2. 达到阈值时生成一次 checkpoint。
3. checkpoint 内容和 ID 在后续多轮保持完全不变。
4. 只有再次达到下一个阈值才生成新 checkpoint。
5. 不要每轮对同一段旧历史重新摘要或重新排序。

每次压缩都记录：

```text
tokens_before
tokens_after
cache_hit_before
cache_hit_after
estimated_uncached_cost
estimated_cached_cost
checkpoint_reused
prefix_changed
```

上线判断使用实际净费用和延迟：

```text
net_cost = cache_hit_tokens * cached_price
         + cache_miss_tokens * uncached_price
         + output_tokens * output_price
```

不要仅以 `tokens_saved` 作为成功指标。

压缩服务故障时应 fail-open，原请求透传；不要用不确定或非确定性的临时摘要兜底。

## P1：Provider 执行层的边界

当前正在抽取 `providerExecution` 一类统一执行层，这个方向适合承载：

- attempt 生命周期
- timeout / abort
- tracker.record
- breaker success/failure
- provider health 反馈
- fallback 分类
- usage 提取

但不要让执行层隐式修改模型输入。建议明确分成：

```text
route decision
  -> immutable normalized request
  -> protocol adapter
  -> provider attempt
  -> response normalization
```

每个 attempt 接收不可变请求，避免第一个 Provider 的兼容性修复污染第二个 Provider 的输入。

如果某 Provider 必须剥离字段或转换工具 schema，应创建该 attempt 的副本，并记录：

```text
request_mutation_reason
before_prefix_hash
after_prefix_hash
```

## P1：观测面板

建议管理页至少增加：

- cache hit tokens
- cache miss tokens
- cache hit ratio
- 按模型 / Provider / route version 分组
- fallback 后的缓存命中变化
- 压缩 checkpoint 复用率
- prefix_changed 请求占比
- TTFT、总延迟、错误率

发布新版本、修改工具转换或启用压缩后，应能从时间轴看到缓存命中率是否发生结构性下降。

阈值不要写死为拍脑袋常量。用历史稳定版本的滚动中位数、IQR 或分位数形成告警基线。

## P1：必须补的回归测试

### usage 字段

- DeepSeek 非流式 hit/miss 字段解析。
- DeepSeek 流式最终 event 字段解析。
- fallback 不用 null/0 覆盖真实 usage。
- Chat→Responses 后缓存字段仍存在。

### 前缀稳定

- 相同历史 + 相同工具定义，重复转换结果一致。
- 仅追加最新用户消息时，旧前缀 hash 不变。
- 工具 schema 没变时，tools 顺序不变。
- 修复异常 tool history 后结果可重复。

### 路由粘性

- 同 session/model 连续请求落同一 Provider。
- Provider 失败后切换并更新有界粘性。
- 健康检查恢复不会把进行中的会话自动切回。

### 压缩

- checkpoint 在阈值之间重复复用。
- 同一输入不会重复生成不同摘要。
- 压缩失败时完整透传。
- prefix_changed 会被准确记录。

## 验收标准

本轮路由重构建议至少满足：

- [ ] DeepSeek hit/miss Token 在所有协议路径端到端保真。
- [ ] 同一缓存敏感会话默认保持 Provider 粘性。
- [ ] 没有动态时间、随机 ID 或健康信息进入模型可见前缀。
- [ ] 相同输入的规范化与协议转换结果具有确定性。
- [ ] 压缩采用稳定 checkpoint，不每轮重写旧历史。
- [ ] 管理页可定位某次发布是否造成缓存命中率下降。
- [ ] 日志不包含 API key、完整 Prompt、图片内容或原始工具输出。
- [ ] 不在现有路由前后继续叠加第二套路由代理。

## 非目标

本建议不要求：

- 替换现有路由器。
- 引入 LiteLLM。
- 修改 Codex profile。
- 增加新的模型 Provider。
- 为了指标采集记录完整 Prompt。

优先保证缓存正确性、可观测性和确定性，再考虑复杂的成本/延迟路由策略。
