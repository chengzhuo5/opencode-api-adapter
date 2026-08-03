import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTurns, turnFingerprint } from '../src/compression.js';

test('splitTurns keeps pre-user developer prefix and splits on user messages', () => {
  const input = [
    { type: 'message', role: 'developer', id: 'd1', content: [{ type: 'input_text', text: 'sys' }] },
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'a' }] },
    { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'b', annotations: [] }] },
    { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'ok' },
    { type: 'message', role: 'user', id: 'u2', content: [{ type: 'input_text', text: 'c' }] }
  ];
  const { prefix, turns } = splitTurns(input);
  assert.equal(prefix.length, 1);
  assert.equal(prefix[0].role, 'developer');
  assert.equal(turns.length, 2);
  assert.equal(turns[0][0].id, 'u1');
  assert.equal(turns[0].length, 1);
  assert.equal(turns[1][0].id, 'a1');
  assert.equal(turns[1].some((x) => x.id === 'u2'), true);
});

test('turnFingerprint is deterministic and content-sensitive', () => {
  const t = [{ role: 'user', content: 'hello' }];
  assert.equal(turnFingerprint(t), turnFingerprint(t));
  assert.notEqual(turnFingerprint(t), turnFingerprint([{ role: 'user', content: 'world' }]));
});

import { turnToMessages, compressTurn } from '../src/compression.js';

test('turnToMessages flattens a turn into one user message with tool outputs', () => {
  const turn = [
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'run it' }] },
    { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'ok' }
  ];
  const messages = turnToMessages(turn);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].content.includes('run it'));
  assert.ok(messages[0].content.includes('sh'));
  assert.ok(messages[0].content.includes('ok'));
});

test('compressTurn calls client and returns compressed text', async () => {
  let calledModel;
  const client = {
    compress: async (messages, model) => {
      calledModel = model;
      return { messages: [{ role: 'user', content: 'tiny' }], stats: { saved_tokens: 10 } };
    }
  };
  const result = await compressTurn({ turn: [{ role: 'user', content: 'big' }], model: 'deepseek-v4-flash', client });
  assert.equal(calledModel, 'deepseek-v4-flash');
  assert.equal(result.text, 'tiny');
  assert.equal(result.stats.saved_tokens, 10);
});

import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressInput } from '../src/compression.js';

function tmpdir() {
  return mkdtempSync(path.join(os.tmpdir(), 'ctx-store-'));
}

test('compressInput reuses cached turns and compresses only new turns', async () => {
  let calls = 0;
  const client = {
    compress: async () => { calls++; return { messages: [{ role: 'user', content: `AC${calls}` }], stats: {} }; }
  };
  const ctx = { client, model: 'deepseek-v4-flash', storeDir: null, cache: new Map(), log: () => {} };
  const input1 = [{ type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'a' }] }];
  const out1 = await compressInput(input1, ctx);
  const input2 = [
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'a' }] },
    { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'b', annotations: [] }] },
    { type: 'message', role: 'user', id: 'u2', content: [{ type: 'input_text', text: 'c' }] }
  ];
  const out2 = await compressInput(input2, ctx);
  assert.equal(calls, 2, 'second request should only compress the new turn');
  assert.match(out2[0].content[0].text, /^\[compressed turn #1\] AC1/);
  assert.match(out2[1].content[0].text, /^\[compressed turn #2\] AC2/);
});

test('compressInput archives originals and leaves ctx markers', async () => {
  const client = { compress: async () => ({ messages: [{ role: 'user', content: 'tiny' }], stats: {} }) };
  const ctx = { client, model: 'x', storeDir: tmpdir(), cache: new Map(), log: () => {} };
  const input = [{ type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'secret' }] }];
  const out = await compressInput(input, ctx);
  const text = out[0].content[0].text;
  assert.match(text, /\[compressed turn #1\]/);
  assert.match(text, /\[\[ctx:[a-f0-9]{64}\|.+\]\]/);
  const match = text.match(/ctx:([a-f0-9]{64})/);
  const file = `${ctx.storeDir}/${match[1]}.json`;
  assert.equal(existsSync(file), true);
  const archived = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(archived[0].content[0].text, 'secret');
});

import { maybeCompressInput } from '../src/compression.js';

test('compressInput logs saved percentage per turn and overall meta', async () => {
  const logs = [];
  const client = { compress: async () => ({ messages: [{ role: 'user', content: 'tiny' }], stats: {} }) };
  const ctx = { client, model: 'x', storeDir: null, cache: new Map(), log: (e) => logs.push(e) };
  const input = [{ type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'A'.repeat(1000) }] }];
  await compressInput(input, ctx);
  const turnLog = logs.find((e) => e.event === 'context_compression' && e.turn_index === 1);
  assert.ok(typeof turnLog.saved_pct === 'number', 'turn log should include saved_pct');
  assert.ok(turnLog.chars_before > 0);
  assert.ok(ctx.meta.overall.saved_pct > 0, 'overall meta should include saved_pct');
  assert.equal(ctx.meta.turns[0].cached, false);
  assert.ok(ctx.meta.turns[0].textHash);
});

test('maybeCompressInput emits cache safety check and detects prefix drift', async () => {
  let calls = 0;
  const client = { compress: async () => { calls++; return { messages: [{ role: 'user', content: `AC${calls}` }], stats: {} }; } };
  const config = { compress: { enabled: true, backend: 'lean-ctx' }, logger: (e) => logs.push(e) };
  const logs = [];
  const cache = new Map();
  const safety = new Map();
  const mk = (id) => ({ type: 'message', role: 'user', id, content: [{ type: 'input_text', text: 'hello' }] });
  const body1 = { model: 'deepseek-v4-flash', input: [mk('u1')] };
  const body2 = { model: 'deepseek-v4-flash', input: [mk('u1'), { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }, mk('u2')] };
  await maybeCompressInput(body1, config, client, null, cache, safety);
  await maybeCompressInput(body2, config, client, null, cache, safety);
  const okLog = logs.find((e) => e.event === 'cache_safety_check' && e.ok === true);
  assert.ok(okLog, 'expected a passing cache safety check');

  // Simulate determinism break: same turn fingerprint produces different text after cache eviction
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

