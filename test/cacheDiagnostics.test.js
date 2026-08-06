import test from 'node:test';
import assert from 'node:assert/strict';
import { createCacheDiagnostics } from '../src/cacheDiagnostics.js';

const secret = Buffer.alloc(32, 7);

test('cache diagnostics are deterministic and contain no raw model-visible text', () => {
  const diagnostics = createCacheDiagnostics({}, { secret });
  const request = {
    model: 'deepseek-v4-flash',
    instructions: 'private system prompt',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private user text' }] }],
    tools: [{ type: 'function', name: 'shell_command', description: 'private tool description' }]
  };
  const first = diagnostics.request('responses', request);
  const second = diagnostics.request('responses', request);
  assert.deepEqual(first, second);
  assert.match(first.model_visible_prefix_hash, /^[a-f0-9]{64}$/);
  assert.match(first.tool_schema_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes('private'), false);
});

test('tool order changes the tool schema fingerprint', () => {
  const diagnostics = createCacheDiagnostics({}, { secret });
  const a = {
    model: 'deepseek-v4-flash',
    input: [],
    tools: [{ name: 'a' }, { name: 'b' }]
  };
  const b = { ...a, tools: [...a.tools].reverse() };
  assert.notEqual(
    diagnostics.request('responses', a).tool_schema_hash,
    diagnostics.request('responses', b).tool_schema_hash
  );
});

test('provider endpoint fingerprint is deterministic and opaque', () => {
  const diagnostics = createCacheDiagnostics({}, { secret });
  const hash = diagnostics.endpoint('https://api.deepseek.com/v1/responses');
  assert.equal(hash, diagnostics.endpoint('https://api.deepseek.com/v1/responses'));
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes('deepseek'), false);
});
