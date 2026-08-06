import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractUsage,
  createUsageLogger,
  createRequestTracker,
  readUsageLines,
  aggregateUsage,
  estimateUsageCost
} from '../src/usageLog.js';

test('extractUsage handles responses usage fields', () => {
  const u = extractUsage({
    model: 'gpt-5.6-luna',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }
    }
  });
  assert.deepEqual(u, {
    model: 'gpt-5.6-luna',
    input_tokens: 10,
    output_tokens: 5,
    cache_hit_tokens: 3,
    cache_miss_tokens: 7,
    cache_write_tokens: 2,
    cache_read_tokens: 3,
    cache_creation_tokens: 2
  });
});

test('extractUsage handles chat prompt/completion fields', () => {
  const u = extractUsage({
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 7, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1 } }
  });
  assert.equal(u.input_tokens, 7);
  assert.equal(u.output_tokens, 4);
  assert.equal(u.cache_read_tokens, 1);
});

test('extractUsage preserves DeepSeek native cache hit and miss fields', () => {
  const u = extractUsage({
    model: 'deepseek-v4-flash',
    usage: {
      prompt_tokens: 11,
      completion_tokens: 4,
      prompt_cache_hit_tokens: 8,
      prompt_cache_miss_tokens: 3
    }
  });
  assert.deepEqual(u, {
    model: 'deepseek-v4-flash',
    input_tokens: 11,
    output_tokens: 4,
    cache_hit_tokens: 8,
    cache_miss_tokens: 3,
    cache_write_tokens: null,
    cache_read_tokens: 8,
    cache_creation_tokens: null
  });
});

test('extractUsage distinguishes known zero usage from missing usage', () => {
  assert.deepEqual(extractUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), {
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_hit_tokens: null,
    cache_miss_tokens: null,
    cache_write_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null
  });
  assert.equal(extractUsage({ usage: {} }), null);
  assert.equal(extractUsage(null), null);
});

test('request tracker finalizes from last attempt', () => {
  const tracker = createRequestTracker('gpt-5.6-luna', { streamed: true });
  tracker.record({ endpoint: 'https://a/v1/responses', ok: false, status: 502, error: 'network_error' });
  tracker.record({
    endpoint: 'https://b/v1/responses',
    ok: true,
    status: 200,
    usage: { input_tokens: 3, output_tokens: 4, cache_read_tokens: 1, cache_creation_tokens: 0 }
  });
  const entry = tracker.finalize();
  assert.equal(entry.model, 'gpt-5.6-luna');
  assert.equal(entry.endpoint, 'https://b/v1/responses');
  assert.equal(entry.ok, true);
  assert.equal(entry.input_tokens, 3);
  assert.equal(entry.output_tokens, 4);
  assert.equal(entry.cache_read_tokens, 1);
  assert.equal(entry.streamed, true);
  assert.ok(entry.latency_ms >= 0);
});

test('request tracker does not let fallback without usage erase earlier real usage', () => {
  const tracker = createRequestTracker('deepseek-v4-flash');
  tracker.record({
    endpoint: 'https://a/v1/responses',
    ok: false,
    status: 502,
    error: 'stream_interrupted',
    usage: {
      input_tokens: 11,
      output_tokens: 4,
      cache_hit_tokens: 8,
      cache_miss_tokens: 3,
      cache_write_tokens: null,
      cache_read_tokens: 8,
      cache_creation_tokens: null
    }
  });
  tracker.record({ endpoint: 'https://b/v1/chat/completions', ok: true, status: 200 });
  const entry = tracker.finalize();
  assert.equal(entry.endpoint, 'https://b/v1/chat/completions');
  assert.equal(entry.ok, true);
  assert.equal(entry.input_tokens, 11);
  assert.equal(entry.output_tokens, 4);
  assert.equal(entry.cache_hit_tokens, 8);
  assert.equal(entry.cache_miss_tokens, 3);
  assert.equal(entry.cache_read_tokens, 8);
});

test('estimateUsageCost uses actual cache hit/miss pricing instead of tokens saved', () => {
  const cost = estimateUsageCost({
    cache_hit_tokens: 800,
    cache_miss_tokens: 200,
    output_tokens: 100
  }, {
    cachedInputUsdPerMillion: 0.1,
    uncachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 2
  });
  assert.deepEqual(cost, {
    estimated_cost_usd: 0.00048,
    estimated_uncached_cost_usd: 0.0012,
    estimated_cache_savings_usd: 0.00072
  });
  assert.equal(estimateUsageCost({
    cache_hit_tokens: 800,
    cache_miss_tokens: null,
    output_tokens: 100
  }, {
    cachedInputUsdPerMillion: 0.1,
    uncachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 2
  }), null, 'unknown miss tokens must not be treated as zero');
});

test('request tracker joins compression checkpoint metadata with actual usage cost', () => {
  const tracker = createRequestTracker('deepseek-v4-flash', {
    pricing: {
      cachedInputUsdPerMillion: 0.1,
      uncachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 2
    }
  });
  tracker.annotate({
    compression_checkpoint_id: 'a'.repeat(64),
    compression_checkpoint_reused: true,
    compression_prefix_changed: false,
    compression_tokens_before: 1500,
    compression_tokens_after: 900
  });
  tracker.record({
    endpoint: 'https://a/v1/responses',
    ok: true,
    status: 200,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_hit_tokens: 800,
      cache_miss_tokens: 200
    }
  });
  const entry = tracker.finalize();
  assert.equal(entry.compression_checkpoint_reused, true);
  assert.equal(entry.compression_tokens_before, 1500);
  assert.equal(entry.estimated_cost_usd, 0.00048);
  assert.equal(entry.estimated_uncached_cost_usd, 0.0012);
  assert.equal(entry.estimated_cache_savings_usd, 0.00072);
});

test('usage logger writes JSONL and reads it back', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-log-'));
  const file = path.join(dir, 'requests.jsonl');
  const logger = createUsageLogger({ usageLog: { enabled: true, file } });
  logger.log({ ts: '2026-08-05T00:00:00.000Z', model: 'gpt-5.6-luna', ok: true });
  logger.log({ ts: '2026-08-05T00:00:01.000Z', model: 'gpt-5.6-luna', ok: false });
  const lines = readUsageLines(file);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test('aggregateUsage computes totals, rates and breakdowns', () => {
  const anchor = new Date();
  anchor.setHours(12, 0, 0, 0);
  const now = anchor.getTime();
  const DAY = 86400000;
  const entries = [
    {
      ts: new Date(now - 2 * DAY).toISOString(),
      model: 'gpt-5.6-luna',
      endpoint: 'https://e/v1/responses',
      ok: true,
      input_tokens: 100,
      output_tokens: 50,
      cache_hit_tokens: 20,
      cache_miss_tokens: 80,
      cache_read_tokens: 20,
      cache_creation_tokens: 30,
      estimated_cost_usd: 0.001,
      estimated_uncached_cost_usd: 0.002,
      estimated_cache_savings_usd: 0.001,
      compression_checkpoint_id: 'a'.repeat(64),
      compression_checkpoint_reused: true,
      compression_prefix_changed: false,
      compression_tokens_before: 200,
      compression_tokens_after: 100,
      compression_tokens_saved: 100,
      latency_ms: 1000
    },
    { ts: new Date(now - 2 * DAY + 3600000).toISOString(), model: 'gpt-5.6-luna', endpoint: 'https://e/v1/responses', ok: false, input_tokens: 0, output_tokens: 0, latency_ms: 500 },
    { ts: new Date(now - 3600000).toISOString(), model: 'deepseek-v4-flash', endpoint: 'https://d/v1/responses', ok: true, input_tokens: 10, output_tokens: 5, latency_ms: 200 }
  ];
  const stats = aggregateUsage(entries);
  assert.equal(stats.totalRequests, 3);
  assert.equal(stats.successRate, 2 / 3);
  assert.equal(stats.totalInputTokens, 110);
  assert.equal(stats.totalOutputTokens, 55);
  assert.equal(stats.totalTokens, 165, 'cached tokens are already part of input_tokens and must not be double-counted');
  assert.equal(stats.totalCacheHitTokens, 20);
  assert.equal(stats.totalCacheMissTokens, 80);
  assert.equal(stats.totalCacheWriteTokens, 30);
  assert.equal(stats.cacheHitRate, 20 / 100);
  assert.equal(stats.estimatedCostUsd, 0.001);
  assert.equal(stats.estimatedUncachedCostUsd, 0.002);
  assert.equal(stats.estimatedCacheSavingsUsd, 0.001);
  assert.equal(stats.costCoverageRate, 1 / 3);
  assert.equal(stats.compression.requests, 1);
  assert.equal(stats.compression.checkpointReuseRate, 1);
  assert.equal(stats.compression.prefixChangedRate, 0);
  assert.equal(stats.compression.tokensSaved, 100);
  assert.equal(stats.compression.estimatedCostUsd, 0.001);
  assert.equal(stats.perModel['gpt-5.6-luna'].requests, 2);
  assert.equal(stats.perProvider['https://d/v1/responses'].requests, 1);
  assert.equal(Object.values(stats.perDay)[0].requests, 2);
  const filtered = aggregateUsage(entries, { days: 1 });
  assert.equal(filtered.totalRequests, 1, 'days filter keeps only last 24h');
});

test('aggregateUsage excludes legacy unknown cache zeros from hit-rate math', () => {
  const ts = new Date().toISOString();
  const stats = aggregateUsage([
    {
      ts,
      model: 'legacy',
      endpoint: 'https://legacy/v1/responses',
      ok: true,
      input_tokens: 100,
      output_tokens: 1,
      cache_read_tokens: 0
    },
    {
      ts,
      usage_schema_version: 2,
      model: 'current',
      endpoint: 'https://current/v1/responses',
      ok: true,
      input_tokens: 10,
      output_tokens: 1,
      cache_hit_tokens: 5,
      cache_miss_tokens: 5
    }
  ]);
  assert.equal(stats.cacheHitRate, 0.5);
  assert.equal(stats.totalCacheHitTokens, 5);
  assert.equal(stats.totalCacheMissTokens, 5);
});
