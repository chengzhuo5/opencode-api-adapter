import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 轻量请求日志 + 用量统计（零依赖，JSONL 追加写入）。
 *
 * 每条请求一行 JSON：
 * {
 *   ts, model, endpoint, status, ok,
 *   input_tokens, output_tokens,
 *   cache_hit_tokens, cache_miss_tokens, cache_write_tokens,
 *   cache_read_tokens, cache_creation_tokens,
 *   latency_ms, streamed, error
 * }
 *
 * GET /v1/usage 时按需聚合，不做定时 rollup；文件过大时可后续加轮转。
 */

function tokenValue(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function hasTokenField(object, fields) {
  return Boolean(object && fields.some((field) => Object.hasOwn(object, field)));
}

/**
 * 从 Responses / Chat 响应里提取 token 用量。
 *
 * 内部以 hit/miss/write 为主语义；cache_read/cache_creation 仅作为兼容别名。
 * 上游没有提供某个维度时保留 null，避免把“未知”错误统计成 0。
 */
export function extractUsage(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const usage = resp.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details
    : {};
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details
    : {};
  const topLevelFields = [
    'input_tokens',
    'prompt_tokens',
    'output_tokens',
    'completion_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens'
  ];
  const detailFields = ['cached_tokens', 'cache_write_tokens', 'uncached_tokens'];
  if (
    !hasTokenField(usage, topLevelFields)
    && !hasTokenField(inputDetails, detailFields)
    && !hasTokenField(promptDetails, detailFields)
  ) {
    return null;
  }

  const input = tokenValue(usage.input_tokens, usage.prompt_tokens);
  const output = tokenValue(usage.output_tokens, usage.completion_tokens);
  const cacheHit = tokenValue(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    inputDetails.cached_tokens,
    promptDetails.cached_tokens
  );
  let cacheMiss = tokenValue(
    usage.prompt_cache_miss_tokens,
    usage.cache_miss_input_tokens,
    inputDetails.uncached_tokens,
    promptDetails.uncached_tokens
  );
  // OpenAI-compatible input/prompt token totals include cached tokens. When the
  // provider exposes cached_tokens in details, the uncached portion is known.
  const hasCompatibleCachedDetails =
    hasTokenField(inputDetails, ['cached_tokens'])
    || hasTokenField(promptDetails, ['cached_tokens']);
  if (cacheMiss === null && hasCompatibleCachedDetails && input !== null && cacheHit !== null) {
    cacheMiss = Math.max(0, input - cacheHit);
  }
  const cacheWrite = tokenValue(
    usage.cache_creation_input_tokens,
    inputDetails.cache_write_tokens,
    promptDetails.cache_write_tokens
  );
  return {
    model: resp.model || usage.model || null,
    input_tokens: input,
    output_tokens: output,
    cache_hit_tokens: cacheHit,
    cache_miss_tokens: cacheMiss,
    cache_write_tokens: cacheWrite,
    cache_read_tokens: cacheHit,
    cache_creation_tokens: cacheWrite
  };
}

function pricingValue(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function roundUsd(value) {
  return Number(value.toFixed(12));
}

export function estimateUsageCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const cacheHit = tokenValue(usage.cache_hit_tokens, usage.cache_read_tokens);
  const cacheMiss = tokenValue(usage.cache_miss_tokens);
  const output = tokenValue(usage.output_tokens);
  const cachedRate = pricingValue(pricing.cachedInputUsdPerMillion);
  const uncachedRate = pricingValue(pricing.uncachedInputUsdPerMillion);
  const outputRate = pricingValue(pricing.outputUsdPerMillion);
  if (
    cacheHit === null
    || cacheMiss === null
    || output === null
    || cachedRate === null
    || uncachedRate === null
    || outputRate === null
  ) {
    return null;
  }
  const estimatedCost =
    (cacheHit * cachedRate + cacheMiss * uncachedRate + output * outputRate) / 1_000_000;
  const uncachedCost =
    ((cacheHit + cacheMiss) * uncachedRate + output * outputRate) / 1_000_000;
  return {
    estimated_cost_usd: roundUsd(estimatedCost),
    estimated_uncached_cost_usd: roundUsd(uncachedCost),
    estimated_cache_savings_usd: roundUsd(uncachedCost - estimatedCost)
  };
}

export function createUsageLogger(config = {}) {
  const uc = config?.usageLog || {};
  if (!uc.enabled || !uc.file) return null;
  const file = path.resolve(uc.file);
  mkdirSync(path.dirname(file), { recursive: true });
  const entries = readUsageLines(file);
  const aggregateCache = new Map();
  const flushDelayMs = Number.isFinite(uc.flushDelayMs) && uc.flushDelayMs >= 0
    ? uc.flushDelayMs
    : 10;
  let pending = [];
  let flushTimer = null;
  let writeChain = Promise.resolve();
  let closed = false;

  function drainPending() {
    if (!pending.length) return writeChain;
    const batch = pending;
    pending = [];
    const text = batch.join('');
    writeChain = writeChain
      .then(() => appendFile(file, text, 'utf8'))
      .catch(() => {
        // 日志失败不能影响路由主流程；后续 batch 仍继续尝试写入。
      });
    return writeChain;
  }

  function scheduleFlush() {
    if (flushTimer || closed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      drainPending();
    }, flushDelayMs);
    flushTimer.unref?.();
  }

  async function flush() {
    while (true) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      drainPending();
      const observedChain = writeChain;
      await observedChain;
      if (!pending.length && observedChain === writeChain) break;
    }
  }

  return {
    file,
    log(entry) {
      if (!entry || closed) return;
      entries.push(entry);
      aggregateCache.clear();
      pending.push(JSON.stringify(entry) + '\n');
      scheduleFlush();
    },
    aggregate(filters = {}) {
      const timeBucket = filters.days ? Math.floor(Date.now() / 60_000) : 0;
      const key = JSON.stringify({
        model: filters.model || null,
        endpoint: filters.endpoint || null,
        days: filters.days || 0,
        timeBucket
      });
      const cached = aggregateCache.get(key);
      if (cached) return cached;
      const stats = aggregateUsage(entries, filters);
      aggregateCache.set(key, stats);
      return stats;
    },
    flush,
    async close() {
      await flush();
      closed = true;
    }
  };
}

/** 单次请求追踪器：记录各 provider 尝试，结束时汇总为一条日志。 */
export function createRequestTracker(model, { streamed = false, pricing = null } = {}) {
  const started = Date.now();
  const records = [];
  const annotations = {};
  return {
    record(attempt) {
      records.push(attempt);
    },
    annotate(values) {
      if (values && typeof values === 'object') Object.assign(annotations, values);
    },
    finalize() {
      const last = records[records.length - 1] || {};
      const usageRecord = records.findLast((record) => record?.usage)?.usage || {};
      const cacheHit = tokenValue(usageRecord.cache_hit_tokens, usageRecord.cache_read_tokens);
      const cacheMiss = tokenValue(usageRecord.cache_miss_tokens);
      const cacheWrite = tokenValue(usageRecord.cache_write_tokens, usageRecord.cache_creation_tokens);
      const entry = {
        ts: new Date(started).toISOString(),
        usage_schema_version: 2,
        model,
        endpoint: last.endpoint || null,
        provider_endpoint_hash: last.provider_endpoint_hash || null,
        status: last.status ?? (last.ok ? 200 : 502),
        ok: Boolean(last.ok),
        input_tokens: tokenValue(usageRecord.input_tokens),
        output_tokens: tokenValue(usageRecord.output_tokens),
        cache_hit_tokens: cacheHit,
        cache_miss_tokens: cacheMiss,
        cache_write_tokens: cacheWrite,
        cache_read_tokens: cacheHit,
        cache_creation_tokens: cacheWrite,
        latency_ms: Date.now() - started,
        streamed,
        error: last.error || null,
        ...annotations
      };
      const cost = estimateUsageCost({
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_hit_tokens: entry.cache_hit_tokens,
        cache_miss_tokens: entry.cache_miss_tokens,
        cache_write_tokens: entry.cache_write_tokens
      }, pricing);
      if (cost) Object.assign(entry, cost);
      if (records.length > 1) {
        entry.attempts = records.map((record) => {
          const usage = record?.usage || {};
          const attemptCacheHit = tokenValue(usage.cache_hit_tokens, usage.cache_read_tokens);
          const attemptCacheWrite = tokenValue(usage.cache_write_tokens, usage.cache_creation_tokens);
          return {
            endpoint: record?.endpoint || null,
            provider_endpoint_hash: record?.provider_endpoint_hash || null,
            status: record?.status ?? (record?.ok ? 200 : 502),
            ok: Boolean(record?.ok),
            error: record?.error || null,
            input_tokens: tokenValue(usage.input_tokens),
            output_tokens: tokenValue(usage.output_tokens),
            cache_hit_tokens: attemptCacheHit,
            cache_miss_tokens: tokenValue(usage.cache_miss_tokens),
            cache_write_tokens: attemptCacheWrite
          };
        });
      }
      return entry;
    }
  };
}

export function readUsageLines(file) {
  if (!file || !existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localDay(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyBucket() {
  return {
    requests: 0,
    success: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    cache_write_tokens: 0,
    cache_ratio_hit_tokens: 0,
    cache_ratio_miss_tokens: 0,
    known: {
      input_tokens: false,
      output_tokens: false,
      cache_hit_tokens: false,
      cache_miss_tokens: false,
      cache_write_tokens: false
    },
    estimated_cost_usd: 0,
    estimated_uncached_cost_usd: 0,
    estimated_cache_savings_usd: 0,
    cost_known_requests: 0,
    compression_requests: 0,
    compression_checkpoint_reused: 0,
    compression_prefix_changed: 0,
    compression_prefix_known: 0,
    compression_tokens_before: 0,
    compression_tokens_after: 0,
    compression_tokens_saved: 0,
    compression_estimated_cost_usd: 0,
    compression_estimated_uncached_cost_usd: 0,
    compression_estimated_cache_savings_usd: 0,
    compression_cost_known_requests: 0,
    latency_sum_ms: 0,
    latency_count: 0
  };
}

function addKnownToken(bucket, field, value) {
  if (!Number.isFinite(value) || value < 0) return;
  bucket[field] += value;
  bucket.known[field] = true;
}

function addBucket(bucket, entry) {
  bucket.requests += 1;
  if (entry.ok) bucket.success += 1;
  const input = tokenValue(entry.input_tokens);
  const cacheHit = tokenValue(entry.cache_hit_tokens, entry.cache_read_tokens);
  const cacheMiss = tokenValue(entry.cache_miss_tokens);
  addKnownToken(bucket, 'input_tokens', input);
  addKnownToken(bucket, 'output_tokens', tokenValue(entry.output_tokens));
  addKnownToken(bucket, 'cache_hit_tokens', cacheHit);
  addKnownToken(bucket, 'cache_miss_tokens', cacheMiss);
  if (cacheHit !== null && cacheMiss !== null) {
    bucket.cache_ratio_hit_tokens += cacheHit;
    bucket.cache_ratio_miss_tokens += cacheMiss;
  }
  addKnownToken(
    bucket,
    'cache_write_tokens',
    tokenValue(entry.cache_write_tokens, entry.cache_creation_tokens)
  );
  if (Number.isFinite(entry.estimated_cost_usd)) {
    bucket.estimated_cost_usd += entry.estimated_cost_usd;
    bucket.estimated_uncached_cost_usd += entry.estimated_uncached_cost_usd || 0;
    bucket.estimated_cache_savings_usd += entry.estimated_cache_savings_usd || 0;
    bucket.cost_known_requests += 1;
  }
  if (entry.compression_checkpoint_id) {
    bucket.compression_requests += 1;
    if (entry.compression_checkpoint_reused === true) bucket.compression_checkpoint_reused += 1;
    if (entry.compression_prefix_changed !== null && entry.compression_prefix_changed !== undefined) {
      bucket.compression_prefix_known += 1;
      if (entry.compression_prefix_changed === true) bucket.compression_prefix_changed += 1;
    }
    bucket.compression_tokens_before += entry.compression_tokens_before || 0;
    bucket.compression_tokens_after += entry.compression_tokens_after || 0;
    bucket.compression_tokens_saved += entry.compression_tokens_saved || 0;
    if (Number.isFinite(entry.estimated_cost_usd)) {
      bucket.compression_estimated_cost_usd += entry.estimated_cost_usd;
      bucket.compression_estimated_uncached_cost_usd += entry.estimated_uncached_cost_usd || 0;
      bucket.compression_estimated_cache_savings_usd += entry.estimated_cache_savings_usd || 0;
      bucket.compression_cost_known_requests += 1;
    }
  }
  if (Number.isFinite(entry.latency_ms)) {
    bucket.latency_sum_ms += entry.latency_ms;
    bucket.latency_count += 1;
  }
}

function finalizeBucket(bucket) {
  const totalTokens = bucket.input_tokens + bucket.output_tokens;
  const cacheable = bucket.cache_ratio_hit_tokens + bucket.cache_ratio_miss_tokens;
  const cacheHitRate =
    cacheable > 0
      ? bucket.cache_ratio_hit_tokens / cacheable
      : null;
  return {
    requests: bucket.requests,
    successRate: bucket.requests ? bucket.success / bucket.requests : 0,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    cache_hit_tokens: bucket.known.cache_hit_tokens ? bucket.cache_hit_tokens : null,
    cache_miss_tokens: bucket.known.cache_miss_tokens ? bucket.cache_miss_tokens : null,
    cache_write_tokens: bucket.known.cache_write_tokens ? bucket.cache_write_tokens : null,
    cache_read_tokens: bucket.known.cache_hit_tokens ? bucket.cache_hit_tokens : null,
    cache_creation_tokens: bucket.known.cache_write_tokens ? bucket.cache_write_tokens : null,
    total_tokens: totalTokens,
    cacheHitRate,
    estimatedCostUsd:
      bucket.cost_known_requests > 0 ? roundUsd(bucket.estimated_cost_usd) : null,
    estimatedUncachedCostUsd:
      bucket.cost_known_requests > 0 ? roundUsd(bucket.estimated_uncached_cost_usd) : null,
    estimatedCacheSavingsUsd:
      bucket.cost_known_requests > 0 ? roundUsd(bucket.estimated_cache_savings_usd) : null,
    costCoverageRate: bucket.requests ? bucket.cost_known_requests / bucket.requests : 0,
    compression: {
      requests: bucket.compression_requests,
      checkpointReuseRate: bucket.compression_requests
        ? bucket.compression_checkpoint_reused / bucket.compression_requests
        : null,
      prefixChangedRate: bucket.compression_prefix_known
        ? bucket.compression_prefix_changed / bucket.compression_prefix_known
        : null,
      tokensBefore: bucket.compression_tokens_before,
      tokensAfter: bucket.compression_tokens_after,
      tokensSaved: bucket.compression_tokens_saved,
      estimatedCostUsd: bucket.compression_cost_known_requests
        ? roundUsd(bucket.compression_estimated_cost_usd)
        : null,
      estimatedUncachedCostUsd: bucket.compression_cost_known_requests
        ? roundUsd(bucket.compression_estimated_uncached_cost_usd)
        : null,
      estimatedCacheSavingsUsd: bucket.compression_cost_known_requests
        ? roundUsd(bucket.compression_estimated_cache_savings_usd)
        : null,
      costCoverageRate: bucket.compression_requests
        ? bucket.compression_cost_known_requests / bucket.compression_requests
        : 0
    },
    avgLatencyMs: bucket.latency_count ? Math.round(bucket.latency_sum_ms / bucket.latency_count) : null
  };
}

/** 聚合请求日志。filters: { model, endpoint, days }。 */
export function aggregateUsage(entries, filters = {}) {
  const { model, endpoint, days } = filters;
  const since = days ? Date.now() - days * DAY_MS : 0;
  const total = emptyBucket();
  const byModel = new Map();
  const byEndpoint = new Map();
  const byDay = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = Date.parse(entry.ts || '');
    if (!Number.isFinite(ts)) continue;
    if (since && ts < since) continue;
    if (model && entry.model !== model) continue;
    if (endpoint && entry.endpoint !== endpoint) continue;
    const day = localDay(ts);
    addBucket(total, entry);
    let m = byModel.get(entry.model || 'unknown');
    if (!m) { m = emptyBucket(); byModel.set(entry.model || 'unknown', m); }
    addBucket(m, entry);
    let e = byEndpoint.get(entry.endpoint || 'unknown');
    if (!e) { e = emptyBucket(); byEndpoint.set(entry.endpoint || 'unknown', e); }
    addBucket(e, entry);
    let d = byDay.get(day);
    if (!d) { d = emptyBucket(); byDay.set(day, d); }
    addBucket(d, entry);
  }
  const toObj = (map) => Object.fromEntries([...map.entries()].map(([k, v]) => [k, finalizeBucket(v)]));
  const finalizedTotal = finalizeBucket(total);
  return {
    totalRequests: total.requests,
    successRate: total.requests ? total.success / total.requests : 0,
    totalInputTokens: total.input_tokens,
    totalOutputTokens: total.output_tokens,
    totalCacheHitTokens: finalizedTotal.cache_hit_tokens,
    totalCacheMissTokens: finalizedTotal.cache_miss_tokens,
    totalCacheWriteTokens: finalizedTotal.cache_write_tokens,
    totalCacheReadTokens: finalizedTotal.cache_read_tokens,
    totalCacheCreationTokens: finalizedTotal.cache_creation_tokens,
    totalTokens: finalizedTotal.total_tokens,
    cacheHitRate: finalizedTotal.cacheHitRate,
    estimatedCostUsd: finalizedTotal.estimatedCostUsd,
    estimatedUncachedCostUsd: finalizedTotal.estimatedUncachedCostUsd,
    estimatedCacheSavingsUsd: finalizedTotal.estimatedCacheSavingsUsd,
    costCoverageRate: finalizedTotal.costCoverageRate,
    compression: finalizedTotal.compression,
    avgLatencyMs: finalizedTotal.avgLatencyMs,
    perModel: toObj(byModel),
    perProvider: toObj(byEndpoint),
    perDay: toObj(byDay)
  };
}
