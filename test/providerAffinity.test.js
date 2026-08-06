import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderAffinity } from '../src/providerAffinity.js';

const config = {
  providerStickiness: {
    enabled: true,
    ttlMs: 1_000,
    maxEntries: 2
  }
};

function route(endpoints = ['https://a/v1/responses', 'https://b/v1/responses']) {
  return {
    model: 'deepseek-v4-flash',
    providers: endpoints.map((endpoint) => ({ endpoint, apiKey: endpoint }))
  };
}

test('same explicit session and model produces the same opaque affinity key', () => {
  const affinity = createProviderAffinity(config, { secret: Buffer.alloc(32, 1) });
  const a = affinity.keyFor({
    model: 'deepseek-v4-flash',
    metadata: { session_id: 'session-1', unrelated: 'a' }
  });
  const b = affinity.keyFor({
    model: 'deepseek-v4-flash',
    metadata: { unrelated: 'b', session_id: 'session-1' }
  });
  const otherModel = affinity.keyFor({
    model: 'deepseek-v4-pro',
    metadata: { session_id: 'session-1' }
  });
  assert.equal(a, b);
  assert.notEqual(a, otherModel);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('full-history inference keeps the same key when only new items are appended', () => {
  const affinity = createProviderAffinity(config, { secret: Buffer.alloc(32, 4) });
  const first = {
    model: 'deepseek-v4-flash',
    instructions: 'Be useful.',
    tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
  };
  const next = {
    ...first,
    input: [
      {
        ...first.input[0],
        id: 'provider-generated-id',
        status: 'completed'
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
    ]
  };
  assert.equal(affinity.keyFor(first), affinity.keyFor(next));
});

test('successful fallback becomes sticky without adding model-visible fields', () => {
  const affinity = createProviderAffinity(config, { secret: Buffer.alloc(32, 2) });
  const body = {
    model: 'deepseek-v4-flash',
    metadata: { session_id: 'session-1' },
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
  };
  const before = JSON.stringify(body);
  const key = affinity.keyFor(body);
  affinity.recordSuccess(key, {
    endpoint: 'https://b/v1/responses',
    apiKey: 'https://b/v1/responses'
  });
  const resolved = route();
  assert.equal(affinity.apply(resolved, key), true);
  assert.deepEqual(resolved.providers.map((provider) => provider.endpoint), [
    'https://b/v1/responses',
    'https://a/v1/responses'
  ]);
  assert.equal(JSON.stringify(body), before, 'affinity must not mutate the model-visible request');
});

test('affinity distinguishes backup credentials that share one endpoint', () => {
  const affinity = createProviderAffinity(config, { secret: Buffer.alloc(32, 5) });
  const key = affinity.keyFor({
    model: 'deepseek-v4-flash',
    metadata: { session_id: 'same-endpoint-session' }
  });
  affinity.recordSuccess(key, {
    endpoint: 'https://same/v1/responses',
    apiKey: 'backup-key'
  });
  const resolved = {
    model: 'deepseek-v4-flash',
    providers: [
      { endpoint: 'https://same/v1/responses', apiKey: 'primary-key' },
      { endpoint: 'https://same/v1/responses', apiKey: 'backup-key' }
    ]
  };
  assert.equal(affinity.apply(resolved, key), true);
  assert.equal(resolved.providers[0].apiKey, 'backup-key');
  assert.equal(resolved.providers[1].apiKey, 'primary-key');
});

test('health-order changes do not switch an active binding before TTL expiry', () => {
  let now = 10_000;
  const affinity = createProviderAffinity(config, {
    secret: Buffer.alloc(32, 3),
    now: () => now
  });
  const key = affinity.keyFor({ model: 'deepseek-v4-flash', session_id: 'session-1' });
  affinity.recordSuccess(key, {
    endpoint: 'https://b/v1/responses',
    apiKey: 'https://b/v1/responses'
  });

  const healthRecoveredOrder = route(['https://a/v1/responses', 'https://b/v1/responses']);
  assert.equal(affinity.apply(healthRecoveredOrder, key), true);
  assert.equal(healthRecoveredOrder.providers[0].endpoint, 'https://b/v1/responses');

  now += 1_001;
  const expired = route(['https://a/v1/responses', 'https://b/v1/responses']);
  assert.equal(affinity.apply(expired, key), false);
  assert.equal(expired.providers[0].endpoint, 'https://a/v1/responses');
});
