import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  outputFingerprint,
  compressOutput,
  compressInput,
  maybeCompressInput,
  estimateTokens,
  storeOutput,
  loadOutput
} from '../src/compression.js';

function tmpdir() {
  return mkdtempSync(path.join(os.tmpdir(), 'ctx-store-'));
}

test('outputFingerprint is deterministic and content-sensitive', () => {
  const o = { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'hello' };
  assert.equal(outputFingerprint(o), outputFingerprint(o));
  assert.notEqual(outputFingerprint(o), outputFingerprint({ ...o, output: 'world' }));
});

test('compressOutput calls client with the raw output text', async () => {
  let calledModel;
  let calledMessages;
  const client = {
    compress: async (messages, model) => {
      calledMessages = messages;
      calledModel = model;
      return { messages: [{ role: 'user', content: 'tiny' }], stats: { saved_tokens: 100 } };
    }
  };
  const result = await compressOutput({ output: 'big payload', model: 'deepseek-v4-flash', client });
  assert.equal(calledModel, 'deepseek-v4-flash');
  assert.equal(calledMessages[0].content, 'big payload');
  assert.equal(result.text, 'tiny');
  assert.equal(result.stats.saved_tokens, 100);
});

test('compressInput compresses every function_call_output and keeps all other items intact', async () => {
  let calls = 0;
  const client = { compress: async () => { calls++; return { messages: [{ role: 'user', content: 'tiny' }], stats: {} }; } };
  const ctx = { client, model: 'x', storeDir: null, cache: new Map(), log: () => {} };
  const input = [
    { type: 'message', role: 'developer', id: 'd1', content: [{ type: 'input_text', text: 'sys' }] },
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'run it' }] },
    { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'tiny output' },
    { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'b', annotations: [] }] },
    { type: 'function_call', id: 'fc2', call_id: 'c2', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco2', call_id: 'c2', output: 'A'.repeat(10000) },
    { type: 'message', role: 'user', id: 'u2', content: [{ type: 'input_text', text: 'next' }] }
  ];
  const out = await compressInput(input, ctx);
  assert.equal(calls, 2, 'every function_call_output should be compressed regardless of size');
  assert.equal(out[0].id, 'd1');
  assert.equal(out[1].id, 'u1');
  assert.equal(out[2].id, 'fc1');
  assert.equal(out[3].id, 'fco1');
  assert.equal(out[3].output, 'tiny');
  assert.equal(out[4].id, 'a1');
  assert.equal(out[5].id, 'fc2');
  assert.equal(out[6].id, 'fco2');
  assert.equal(out[6].output, 'tiny');
  assert.equal(out[7].id, 'u2');
  assert.equal(out[7].content[0].text, 'next');
  assert.equal(ctx.meta.overall.outputs_total, 2);
  assert.equal(ctx.meta.overall.outputs_compressed, 2);
  assert.equal(ctx.meta.overall.outputs_cached, 0);
});

test('compressInput caches repeated outputs and only compresses new ones', async () => {
  let calls = 0;
  const client = { compress: async () => { calls++; return { messages: [{ role: 'user', content: `AC${calls}` }], stats: {} }; } };
  const ctx = { client, model: 'x', storeDir: null, cache: new Map(), log: () => {} };
  const output1 = { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'same' };
  const output2 = { type: 'function_call_output', id: 'fco2', call_id: 'c2', output: 'new' };
  const out1 = await compressInput([output1], ctx);
  const out2 = await compressInput([output1, output2], ctx);
  assert.equal(calls, 2, 'second request should only compress the new output');
  assert.equal(out2[0].output, 'AC1');
  assert.equal(out2[1].output, 'AC2');
});

test('compressInput archives originals and leaves explicit ctx markers for retrieval', async () => {
  const client = { compress: async () => ({ messages: [{ role: 'user', content: 'tiny' }], stats: {} }) };
  const ctx = { client, model: 'x', storeDir: tmpdir(), cache: new Map(), log: () => {} };
  const input = [{ type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'secret output' }];
  const out = await compressInput(input, ctx);
  const text = out[0].output;
  assert.match(text, /^tiny \[\[ctx:[a-f0-9]{64}\|.+\]\]$/);
  const match = text.match(/\[\[ctx:([a-f0-9]{64})\|(.+)\]\]/);
  assert.ok(match, 'explicit ctx marker should include sha256 and file path');
  const file = match[2];
  assert.equal(existsSync(file), true, 'archived file should exist for shell retrieval');
  const archived = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(archived.id, 'fco1');
  assert.equal(archived.output, 'secret output');
});

test('compressInput logs saved percentage per output and overall meta', async () => {
  const logs = [];
  const client = { compress: async () => ({ messages: [{ role: 'user', content: 'tiny' }], stats: {} }) };
  const ctx = { client, model: 'x', storeDir: null, cache: new Map(), log: (e) => logs.push(e) };
  const input = [{ type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'A'.repeat(1000) }];
  await compressInput(input, ctx);
  const log = logs.find((e) => e.event === 'context_compression');
  assert.ok(typeof log.saved_pct === 'number', 'per-output log should include saved_pct');
  assert.ok(log.chars_before > 0);
  assert.ok(ctx.meta.overall.saved_pct > 0, 'overall meta should include saved_pct');
  assert.equal(ctx.meta.outputs[0].cached, false);
  assert.ok(ctx.meta.outputs[0].textHash);
});

test('maybeCompressInput emits cache safety check and detects prefix drift', async () => {
  let calls = 0;
  const client = { compress: async () => { calls++; return { messages: [{ role: 'user', content: `AC${calls}` }], stats: {} }; } };
  const logs = [];
  const config = { compress: { enabled: true, backend: 'lean-ctx' }, logger: (e) => logs.push(e) };
  const cache = new Map();
  const safety = new Map();
  const output1 = { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'hello' };
  const output2 = { type: 'function_call_output', id: 'fco2', call_id: 'c2', output: 'world' };
  const body1 = { model: 'deepseek-v4-flash', input: [output1] };
  const body2 = { model: 'deepseek-v4-flash', input: [output1, output2] };
  await maybeCompressInput(body1, config, client, null, cache, safety);
  await maybeCompressInput(body2, config, client, null, cache, safety);
  const okLog = logs.find((e) => e.event === 'cache_safety_check' && e.ok === true);
  assert.ok(okLog, 'expected a passing cache safety check');

  logs.length = 0;
  cache.clear();
  safety.clear();
  const client2 = { compress: async () => ({ messages: [{ role: 'user', content: 'BROKEN' }], stats: {} }) };
  await maybeCompressInput(body1, { ...config, logger: (e) => logs.push(e) }, client2, null, cache, safety);
  cache.clear();
  const client3 = { compress: async () => ({ messages: [{ role: 'user', content: 'DIFFERENT' }], stats: {} }) };
  await maybeCompressInput(body1, { ...config, logger: (e) => logs.push(e) }, client3, null, cache, safety);
  const failLog = logs.find((e) => e.event === 'cache_safety_check' && e.ok === false);
  assert.ok(failLog, 'expected a failing cache safety check on prefix drift');
});

test('maybeCompressInput falls back to original body when daemon is unreachable', async () => {
  const logs = [];
  const client = { compress: async () => { throw new Error('unreachable'); } };
  const config = { compress: { enabled: true, backend: 'lean-ctx' }, logger: (e) => logs.push(e) };
  const body = { model: 'deepseek-v4-flash', input: [{ type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'x' }] };
  const result = await maybeCompressInput(body, config, client, null, new Map(), new Map());
  assert.equal(result, body);
  assert.ok(logs.some((e) => e.event === 'context_compression' && e.reason === 'backend_unavailable'));
});

test('cache safety check does not report prefix drift across different sessions', async () => {
  const logs = [];
  const client = {
    compress: async (messages) => {
      const content = messages[0].content;
      return { messages: [{ role: 'user', content: content.startsWith('session A') ? 'compressed-A' : 'compressed-B' }], stats: {} };
    }
  };
  const config = { compress: { enabled: true, backend: 'lean-ctx' }, logger: (e) => logs.push(e) };
  const cache = new Map();
  const safety = new Map();
  const outA = { type: 'function_call_output', id: 'fco_a1', call_id: 'a1', output: 'session A output' };
  const outB = { type: 'function_call_output', id: 'fco_b1', call_id: 'b1', output: 'session B output' };
  await maybeCompressInput({ model: 'deepseek-v4-flash', input: [outA] }, config, client, null, cache, safety);
  await maybeCompressInput({ model: 'deepseek-v4-flash', input: [outB] }, config, client, null, cache, safety);
  const checks = logs.filter((e) => e.event === 'cache_safety_check');
  assert.equal(checks.length, 2);
  assert.equal(checks[1].ok, true, 'different session must not be reported as prefix drift');
  assert.equal(checks[1].reason, undefined);
});

test('compressInput skips per-output logs when output is cached', async () => {
  const logs = [];
  const client = { compress: async () => ({ messages: [{ role: 'user', content: 'tiny' }], stats: {} }) };
  const ctx = { client, model: 'x', storeDir: null, cache: new Map(), log: (e) => logs.push(e) };
  const output1 = { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'same' };
  await compressInput([output1], ctx);
  await compressInput([output1], ctx);
  const perOutput = logs.filter((e) => e.event === 'context_compression' && e.call_id);
  assert.equal(perOutput.length, 1, 'cached outputs should not emit per-output logs');
});

test('quiet log level skips cache safety check but keeps summary', async () => {
  const logs = [];
  const client = { compress: async () => ({ messages: [{ role: 'user', content: 'tiny' }], stats: {} }) };
  const config = { compress: { enabled: true, backend: 'lean-ctx', logLevel: 'quiet' }, logger: (e) => logs.push(e) };
  const cache = new Map();
  const safety = new Map();
  await maybeCompressInput({ model: 'deepseek-v4-flash', input: [{ type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'x' }] }, config, client, null, cache, safety);
  assert.ok(logs.some((e) => e.event === 'context_compression' && e.reason === 'ok'), 'summary should still be logged');
  assert.equal(logs.some((e) => e.event === 'cache_safety_check'), false, 'quiet mode should skip cache safety check');
});

test('estimateTokens approximates ASCII, CJK and mixed text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('hello'), 2, '5 ASCII chars round to ceil(5/4) tokens');
  assert.equal(estimateTokens('你好'), 2, 'each CJK char counts as one token');
  assert.equal(estimateTokens('hello世界'), 4, 'CJK chars plus ceil of ASCII/4');
  assert.equal(estimateTokens('A'.repeat(1000)), 250);
});

test('maybeCompressInput accumulates token totals and logs cumulative ratio', async () => {
  let calls = 0;
  const client = { compress: async () => { calls++; return { messages: [{ role: 'user', content: 'tiny' }], stats: {} }; } };
  const logs = [];
  const config = { compress: { enabled: true, backend: 'lean-ctx' }, logger: (e) => logs.push(e) };
  const cache = new Map();
  const safety = new Map();
  const stats = { total_chars_before: 0, total_chars_after: 0, total_tokens_before: 0, total_tokens_after: 0, requests: 0 };
  const big = { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'A'.repeat(1000) };

  await maybeCompressInput({ model: 'deepseek-v4-flash', input: [big] }, config, client, null, cache, safety, stats);
  await maybeCompressInput({ model: 'deepseek-v4-flash', input: [big] }, config, client, null, cache, safety, stats);

  const first = logs.find((e) => e.event === 'context_compression');
  assert.ok(first.tokens_before > 0, 'request log should include estimated tokens_before');
  assert.ok(first.tokens_after > 0, 'request log should include estimated tokens_after');
  assert.equal(first.tokens_saved, first.tokens_before - first.tokens_after, 'request log should include tokens_saved');

  const last = logs.filter((e) => e.event === 'context_compression').at(-1);
  assert.ok(last.total_tokens_before > 0, 'cumulative total_tokens_before should accumulate');
  assert.ok(last.total_tokens_after > 0, 'cumulative total_tokens_after should accumulate');
  assert.equal(last.total_tokens_saved, last.total_tokens_before - last.total_tokens_after);
  assert.ok(last.total_tokens_saved > 0, 'cumulative tokens saved should be positive');
  assert.ok(last.total_saved_pct > 0, 'cumulative ratio should be positive');
  assert.equal(stats.requests, 2, 'stats accumulator should count requests');
  assert.equal(last.total_tokens_before, first.tokens_before * 2, 'cached reuse still counts forwarded size');
});

test('loadOutput retrieves archived output and rejects bad hashes', () => {
  const dir = tmpdir();
  const item = { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'secret' };
  storeOutput(item, dir);
  const hash = outputFingerprint(item);
  assert.deepEqual(loadOutput(hash, dir), item, 'should return the archived original JSON');
  assert.equal(loadOutput('zzz-not-a-hash', dir), null, 'bad hash must be rejected');
  assert.equal(loadOutput(hash, null), null, 'no store dir must yield null');
});
