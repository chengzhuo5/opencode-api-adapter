import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHealthMonitor } from '../src/health.js';
import { createRouter } from '../src/server.js';

const baseConfig = {
  models: {
    'deepseek-v4-flash': {
      upstream: 'responses',
      endpoint: [
        { url: 'https://opencode.test/v1', apiKey: 'opencode-key' },
        { url: 'https://deepseek.test/v1', apiKey: 'deepseek-key' }
      ]
    }
  },
  healthCheck: { enabled: true, intervalMs: 60000, timeoutMs: 5000 }
};

test('health monitor marks provider down on failure and recovered on success', async () => {
  let ok = true;
  const statuses = [];
  const monitor = createHealthMonitor({
    config: baseConfig,
    fetchImpl: async (url, init) => {
      if (!ok) throw new Error('probe failed');
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","model":"x"}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    onStatusChange: (key, healthy) => statuses.push({ key, healthy })
  });
  const key = 'deepseek-v4-flash::https://opencode.test/v1/responses';
  assert.equal(monitor.isUnhealthy('deepseek-v4-flash', 'https://opencode.test/v1/responses'), false);

  ok = false;
  await monitor.probe(key);
  assert.equal(monitor.isUnhealthy('deepseek-v4-flash', 'https://opencode.test/v1/responses'), true, 'should be marked down after failed probe');
  assert.equal(statuses[0].healthy, false);

  ok = true;
  await monitor.probe(key);
  assert.equal(monitor.isUnhealthy('deepseek-v4-flash', 'https://opencode.test/v1/responses'), false, 'should recover after successful probe');
  assert.equal(statuses[1].healthy, true);
});

test('router skips unhealthy opencode provider and falls back to deepseek official', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('opencode.test')) {
      throw new Error('opencode down');
    }
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response', model: 'deepseek-v4-flash', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // 先让监控探针把 opencode 标记为 down
  const server = createRouter({ ...baseConfig, apiKey: 'k', apiBaseUrl: 'https://x/v1', healthCheck: { enabled: true, intervalMs: 60000, timeoutMs: 5000 } }, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 触发一次探针（直接对 opencode 探测失败）
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })
    });
    assert.equal(res.status, 200);
    // 第二次请求：opencode 仍失败但已被标记 down → 应跳过 opencode，只打 deepseek
    const callsBefore = calls.length;
    const res2 = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })
    });
    assert.equal(res2.status, 200);
    const newCalls = calls.slice(callsBefore);
    assert.ok(newCalls.some((u) => u.includes('deepseek.test')), 'deepseek official should be called');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('health monitor probes messages providers with their protocol and credentials', async () => {
  const calls = [];
  const monitor = createHealthMonitor({
    config: {
      models: {
        'minimax-m3': {
          upstream: 'messages',
          endpoint: [
            { url: 'https://messages-a/v1/', apiKey: 'a-key' },
            { url: 'https://messages-b/v1/messages', apiKey: 'b-key' }
          ]
        }
      },
      healthCheck: {
        enabled: true,
        models: ['minimax-m3'],
        intervalMs: 60000,
        timeoutMs: 5000
      }
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await monitor.probeAll();
  assert.equal(result.every((item) => item.healthy), true);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://messages-a/v1/messages',
    'https://messages-b/v1/messages'
  ]);
  assert.deepEqual(calls.map((call) => call.init.headers['x-api-key']), ['a-key', 'b-key']);
  assert.equal(calls.every((call) => call.init.headers['anthropic-version'] === '2023-06-01'), true);
  assert.equal(calls.every((call) => call.body.max_tokens === 1), true);
});

test('health monitor accepts response.incomplete as a healthy Responses terminal', async () => {
  const bodies = [];
  const monitor = createHealthMonitor({
    config: {
      models: {
        'deepseek-v4-flash': {
          upstream: 'responses',
          endpoint: [{ url: 'https://deepseek.test/v1', apiKey: 'deepseek-key' }]
        }
      },
      healthCheck: {
        enabled: true,
        models: ['deepseek-v4-flash'],
        intervalMs: 60000,
        timeoutMs: 5000
      }
    },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        'event: response.incomplete\n'
        + 'data: {"type":"response.incomplete","response":{"id":"r1","status":"incomplete"}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }
  });
  const result = await monitor.probeAll();
  assert.deepEqual(result, [{
    key: 'deepseek-v4-flash::https://deepseek.test/v1/responses',
    healthy: true
  }]);
  assert.equal(bodies[0].max_output_tokens, undefined, 'health probes must not force an incomplete response');
});
