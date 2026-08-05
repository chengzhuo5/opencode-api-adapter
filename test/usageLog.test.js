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
  aggregateUsage
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

test('extractUsage returns null when all tokens are zero', () => {
  assert.equal(extractUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), null);
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
  const now = Date.now();
  const DAY = 86400000;
  const entries = [
    { ts: new Date(now - 2 * DAY).toISOString(), model: 'gpt-5.6-luna', endpoint: 'https://e/v1/responses', ok: true, input_tokens: 100, output_tokens: 50, cache_read_tokens: 20, cache_creation_tokens: 30, latency_ms: 1000 },
    { ts: new Date(now - 2 * DAY + 3600000).toISOString(), model: 'gpt-5.6-luna', endpoint: 'https://e/v1/responses', ok: false, input_tokens: 0, output_tokens: 0, latency_ms: 500 },
    { ts: new Date(now - 3600000).toISOString(), model: 'deepseek-v4-flash', endpoint: 'https://d/v1/responses', ok: true, input_tokens: 10, output_tokens: 5, latency_ms: 200 }
  ];
  const stats = aggregateUsage(entries);
  assert.equal(stats.totalRequests, 3);
  assert.equal(stats.successRate, 2 / 3);
  assert.equal(stats.totalInputTokens, 110);
  assert.equal(stats.totalOutputTokens, 55);
  assert.equal(stats.perModel['gpt-5.6-luna'].requests, 2);
  assert.equal(stats.perProvider['https://d/v1/responses'].requests, 1);
  assert.equal(Object.values(stats.perDay)[0].requests, 2);
  const filtered = aggregateUsage(entries, { days: 1 });
  assert.equal(filtered.totalRequests, 1, 'days filter keeps only last 24h');
});
