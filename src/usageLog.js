import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 轻量请求日志 + 用量统计（零依赖，JSONL 追加写入）。
 *
 * 每条请求一行 JSON：
 * {
 *   ts, model, endpoint, status, ok,
 *   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
 *   latency_ms, streamed, error
 * }
 *
 * GET /v1/usage 时按需聚合，不做定时 rollup；文件过大时可后续加轮转。
 */

/** 从 Responses / Chat 响应里提取 token 用量（兼容多种上报字段）。 */
export function extractUsage(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const usage = resp.usage || {};
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? details.cached_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? details.cache_write_tokens ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) return null;
  return {
    model: resp.model || usage.model || null,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation
  };
}

export function createUsageLogger(config = {}) {
  const uc = config?.usageLog || {};
  if (!uc.enabled || !uc.file) return null;
  const file = path.resolve(uc.file);
  mkdirSync(path.dirname(file), { recursive: true });
  return {
    file,
    log(entry) {
      if (!entry) return;
      try {
        appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        // 日志失败不能影响路由主流程
      }
    }
  };
}

/** 单次请求追踪器：记录各 provider 尝试，结束时汇总为一条日志。 */
export function createRequestTracker(model, { streamed = false } = {}) {
  const started = Date.now();
  const records = [];
  return {
    record(attempt) {
      records.push(attempt);
    },
    finalize() {
      const last = records[records.length - 1] || {};
      const usage = last.usage || {};
      return {
        ts: new Date(started).toISOString(),
        model,
        endpoint: last.endpoint || null,
        status: last.status ?? (last.ok ? 200 : 502),
        ok: Boolean(last.ok),
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_tokens: usage.cache_read_tokens || 0,
        cache_creation_tokens: usage.cache_creation_tokens || 0,
        latency_ms: Date.now() - started,
        streamed,
        error: last.error || null
      };
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
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    latency_sum_ms: 0,
    latency_count: 0
  };
}

function addBucket(bucket, entry) {
  bucket.requests += 1;
  if (entry.ok) bucket.success += 1;
  bucket.input_tokens += entry.input_tokens || 0;
  bucket.output_tokens += entry.output_tokens || 0;
  bucket.cache_read_tokens += entry.cache_read_tokens || 0;
  bucket.cache_creation_tokens += entry.cache_creation_tokens || 0;
  if (Number.isFinite(entry.latency_ms)) {
    bucket.latency_sum_ms += entry.latency_ms;
    bucket.latency_count += 1;
  }
}

function finalizeBucket(bucket) {
  const totalTokens = bucket.input_tokens + bucket.output_tokens + bucket.cache_read_tokens + bucket.cache_creation_tokens;
  const cacheable = bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_creation_tokens;
  return {
    requests: bucket.requests,
    successRate: bucket.requests ? bucket.success / bucket.requests : 0,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    cache_read_tokens: bucket.cache_read_tokens,
    cache_creation_tokens: bucket.cache_creation_tokens,
    total_tokens: totalTokens,
    cacheHitRate: cacheable ? bucket.cache_read_tokens / cacheable : 0,
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
  return {
    totalRequests: total.requests,
    successRate: total.requests ? total.success / total.requests : 0,
    totalInputTokens: total.input_tokens,
    totalOutputTokens: total.output_tokens,
    totalCacheReadTokens: total.cache_read_tokens,
    totalCacheCreationTokens: total.cache_creation_tokens,
    totalTokens: finalizeBucket(total).total_tokens,
    cacheHitRate: finalizeBucket(total).cacheHitRate,
    avgLatencyMs: finalizeBucket(total).avgLatencyMs,
    perModel: toObj(byModel),
    perProvider: toObj(byEndpoint),
    perDay: toObj(byDay)
  };
}
