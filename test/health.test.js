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
  await monitor.probeAll();
  const key = monitor.status().find((entry) => entry.endpoint.includes('opencode.test')).key;
  assert.equal(
    monitor.isUnhealthy('deepseek-v4-flash', 'https://opencode.test/v1/responses', 'opencode-key'),
    false
  );

  ok = false;
  await monitor.probe(key);
  assert.equal(
    monitor.isUnhealthy('deepseek-v4-flash', 'https://opencode.test/v1/responses', 'opencode-key'),
    true,
    'should be marked down after failed probe'
  );
  assert.equal(statuses[0].healthy, false);

  ok = true;
  await monitor.probe(key);
  assert.equal(
    monitor.isUnhealthy('deepseek-v4-flash', 'https://opencode.test/v1/responses', 'opencode-key'),
    false,
    'should recover after successful probe'
  );
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
  assert.equal(result.length, 1);
  assert.equal(result[0].healthy, true);
  assert.match(result[0].key, /^deepseek-v4-flash::https:\/\/deepseek\.test\/v1\/responses::credential:/);
  assert.equal(bodies[0].max_output_tokens, undefined, 'health probes must not force an incomplete response');
});

test('health monitor only treats SSE event names as terminal states', async () => {
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
        intervalMs: 60_000,
        timeoutMs: 5_000
      }
    },
    fetchImpl: async () => new Response(
      'event: response.output_text.delta\n'
      + 'data: {"type":"response.output_text.delta","delta":"literal response.failed text"}\n\n'
      + 'event: response.completed\n'
      + 'data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  });
  const result = await monitor.probeAll();
  assert.equal(result.length, 1);
  assert.equal(result[0].healthy, true);
});

test('health monitor keeps separate state for credentials sharing one endpoint', async () => {
  const seenKeys = [];
  const monitor = createHealthMonitor({
    config: {
      apiKey: 'global-key',
      apiBaseUrl: null,
      healthCheck: {
        enabled: true,
        models: ['gpt-5.6-luna'],
        intervalMs: 60_000,
        timeoutMs: 5_000
      },
      models: {
        'gpt-5.6-luna': {
          upstream: 'responses',
          endpoint: [
            { url: 'https://same.test/v1', apiKey: 'primary-key' },
            { url: 'https://same.test/v1', apiKey: 'backup-key' }
          ]
        }
      }
    },
    fetchImpl: async (_url, init) => {
      const key = init.headers.authorization.replace(/^Bearer\s+/i, '');
      seenKeys.push(key);
      if (key === 'primary-key') {
        return new Response(JSON.stringify({ error: { message: 'down' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ id: 'r1', model: 'gpt-5.6-luna' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await monitor.probeAll();
  assert.equal(monitor.watchedCount(), 2);
  assert.deepEqual(seenKeys.sort(), ['backup-key', 'primary-key']);
  assert.equal(result.filter((entry) => entry.healthy).length, 1);
  assert.equal(monitor.status().filter((entry) => entry.unhealthy).length, 1);
});

test('health monitor scans single custom endpoints without an explicit model list', async () => {
  const calls = [];
  const monitor = createHealthMonitor({
    config: {
      models: {
        'gpt-5.6-luna': {
          upstream: 'responses',
          endpoint: 'https://single.test/v1',
          apiKey: 'key'
        }
      },
      healthCheck: {
        enabled: true,
        intervalMs: 60_000,
        timeoutMs: 5_000
      }
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ id: 'r1', model: 'gpt-5.6-luna' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await monitor.probeAll();
  assert.equal(calls.length, 1);
  assert.equal(result[0].healthy, true);
  assert.equal(monitor.status()[0].endpoint, 'https://single.test/v1/responses');
});

test('health monitor discovers custom endpoints declared by model patterns', async () => {
  const calls = [];
  const monitor = createHealthMonitor({
    config: {
      apiBaseUrl: null,
      modelPatterns: {
        'gpt-*': {
          upstream: 'responses',
          endpoint: 'https://pattern.test/v1',
          apiKey: 'pattern-key'
        }
      },
      healthCheck: {
        enabled: true,
        intervalMs: 60_000,
        timeoutMs: 5_000
      }
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, model: JSON.parse(init.body).model });
      return new Response(JSON.stringify({ id: 'r1', model: JSON.parse(init.body).model }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await monitor.probeAll();
  assert.ok(result.length > 0, 'pattern providers must produce probe targets');
  assert.ok(calls.every((call) => call.url === 'https://pattern.test/v1/responses'));
  assert.ok(calls.every((call) => call.model !== 'gpt-*'), 'wildcard syntax must not be sent upstream');
  assert.ok(monitor.status().some((entry) => entry.endpoint === 'https://pattern.test/v1/responses'));
});

test('health monitor cancels non-stream response bodies after probing', async () => {
  let cancelled = false;
  const monitor = createHealthMonitor({
    config: {
      models: {
        'minimax-m3': {
          upstream: 'messages',
          endpoint: [{ url: 'https://messages.test/v1', apiKey: 'key' }]
        }
      },
      healthCheck: {
        enabled: true,
        models: ['minimax-m3'],
        intervalMs: 60_000,
        timeoutMs: 5_000
      }
    },
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"m1"}'));
      },
      cancel() {
        cancelled = true;
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  });
  await monitor.probeAll();
  assert.equal(cancelled, true, 'non-stream probe bodies must be released');
});

test('health monitor does not overlap slow scheduled probe cycles', async () => {
  let active = 0;
  let maxActive = 0;
  const monitor = createHealthMonitor({
    config: {
      models: {
        'minimax-m3': {
          upstream: 'messages',
          endpoint: [{ url: 'https://messages.test/v1', apiKey: 'key' }]
        }
      },
      healthCheck: {
        enabled: true,
        models: ['minimax-m3'],
        intervalMs: 15,
        timeoutMs: 500
      }
    },
    fetchImpl: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active -= 1;
      return new Response(JSON.stringify({ id: 'm1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  monitor.stop();
  assert.equal(maxActive, 1, 'scheduled health probes must be single-flight');
});

test('health monitor stop aborts in-flight probes and ignores retired results', async () => {
  let started;
  const statuses = [];
  const monitor = createHealthMonitor({
    config: {
      models: {
        'minimax-m3': {
          upstream: 'messages',
          endpoint: [{ url: 'https://messages.test/v1', apiKey: 'key' }]
        }
      },
      healthCheck: {
        enabled: true,
        models: ['minimax-m3'],
        intervalMs: 60_000,
        timeoutMs: 500
      }
    },
    onStatusChange: (key, healthy) => statuses.push({ key, healthy }),
    fetchImpl: async (_url, init) => {
      started?.();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 120);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('probe aborted'));
        }, { once: true });
      });
      return new Response(JSON.stringify({ error: { message: 'retired' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const startedPromise = new Promise((resolve) => { started = resolve; });
  monitor.start();
  await startedPromise;
  monitor.stop();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(statuses, [], 'retired probe results must not mutate health state');
});
