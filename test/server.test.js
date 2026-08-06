import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/server.js';
import { normalizeResponsesRequest } from '../src/translate/responsesContext.js';

async function withServer(config, fetchImpl, fn, options = {}) {
  const server = createRouter(config, { fetchImpl, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, server);
  } finally {
    await server.__routerCleanup?.();
    server.close();
  }
}

test('healthz returns ok', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}, catalog: { models: [] } }, async () => {}, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });
});

test('models endpoint returns catalog', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}, catalog: { models: [{ slug: 'x' }] } }, async () => {}, async (base) => {
    const res = await fetch(`${base}/v1/models`);
    const data = await res.json();
    assert.equal(data.models[0].slug, 'x');
  });
});

test('ctx endpoint returns archived output by hash', async () => {
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'ctx-http-'));
  const hash = 'a'.repeat(64);
  writeFileSync(path.join(storeDir, `${hash}.json`), JSON.stringify({
    type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'original payload'
  }));
  await withServer({
    apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {},
    compress: { enabled: true, backend: 'lean-ctx', storeDir }
  }, async () => {}, async (base) => {
    const res = await fetch(`${base}/v1/ctx/${hash}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.output, 'original payload');
  });
});

test('usage endpoint reports logged request', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-http-'));
  const file = path.join(dir, 'requests.jsonl');
  const fetchImpl = async (url) => {
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({
        id: 'resp_1',
        object: 'response',
        model: 'deepseek-v4-flash',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 3
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected upstream: ' + url);
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {},
    usageLog: { enabled: true, file }
  }, fetchImpl, async (base, server) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        metadata: { session_id: 'usage-test-session' },
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'private text must never enter usage logs' }]
        }]
      })
    });
    assert.equal(res.status, 200);
    await server.__routerFlushUsage();
    const rawLog = readFileSync(file, 'utf8');
    const entry = JSON.parse(rawLog.trim());
    assert.match(entry.conversation_key_hash, /^[a-f0-9]{64}$/);
    assert.match(entry.model_visible_prefix_hash, /^[a-f0-9]{64}$/);
    assert.match(entry.tool_schema_hash, /^[a-f0-9]{64}$/);
    assert.match(entry.provider_endpoint_hash, /^[a-f0-9]{64}$/);
    assert.equal(rawLog.includes('private text'), false);
    const statsRes = await fetch(base + '/v1/usage?days=7');
    const stats = await statsRes.json();
    assert.equal(stats.totalRequests, 1);
    assert.equal(stats.successRate, 1);
    assert.equal(stats.totalInputTokens, 10);
    assert.equal(stats.totalOutputTokens, 5);
    assert.equal(stats.totalCacheHitTokens, 7);
    assert.equal(stats.totalCacheMissTokens, 3);
    assert.equal(stats.cacheHitRate, 0.7);
    assert.equal(stats.perModel['deepseek-v4-flash'].requests, 1);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('admin page is served from adminDir', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-http-'));
  writeFileSync(path.join(dir, 'index.html'), '<h1>admin</h1>');
  await withServer({
    apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}
  }, async () => {}, async (base) => {
    const res = await fetch(base + '/admin');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<h1>admin<\/h1>/);
  }, { adminDir: dir });
  rmSync(dir, { recursive: true, force: true });
});

test('admin path traversal is blocked', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-http2-'));
  writeFileSync(path.join(dir, 'index.html'), 'ok');
  writeFileSync(path.join(path.dirname(dir), 'secret.txt'), 'secret');
  await withServer({
    apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}
  }, async () => {}, async (base) => {
    const res = await fetch(base + '/admin/%2e%2e/secret.txt');
    assert.equal(res.status, 404, 'traversal must not escape adminDir');
  }, { adminDir: dir });
  rmSync(dir, { recursive: true, force: true });
});

test('api/status exposes health and circuit state', async () => {
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {},
    healthCheck: { enabled: true, intervalMs: 60000, timeoutMs: 5000 },
    circuitBreaker: { enabled: true }
  }, async () => new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }), async (base) => {
    const res = await fetch(base + '/api/status');
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(typeof data.pid, 'number');
    assert.ok(Array.isArray(data.health));
    assert.ok(Array.isArray(data.circuit));
  });
});

test('api/reload validates, saves, and schedules commit', async () => {
  let committed = false;
  let validated = '';
  const cfg = {
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {}
  };
  await withServer(cfg, async () => {}, async (base) => {
    const bad = await fetch(base + '/api/reload', { method: 'POST', body: '{bad json' });
    assert.equal(bad.status, 400);
    assert.equal(committed, false, 'invalid config must not commit');

    const ok = await fetch(base + '/api/reload', { method: 'POST', body: '{"port":12345}' });
    assert.equal(ok.status, 200);
    assert.equal(validated, '{"port":12345}');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(committed, true, 'valid config schedules commit');
  }, {
    onReloadValidate: (text) => {
      validated = text;
      try { JSON.parse(text); return null; } catch (error) { return error.message; }
    },
    onReloadCommit: async () => { committed = true; }
  });
});

test('api/restart schedules commit', async () => {
  let committed = false;
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, async () => {}, async (base) => {
    const res = await fetch(base + '/api/restart', { method: 'POST' });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(committed, true);
  }, { onRestartCommit: async () => { committed = true; } });
});

test('ctx endpoint 400s bad hashes and 404s unknown or disabled compression', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, async () => {}, async (base) => {
    const res = await fetch(`${base}/v1/ctx/${'b'.repeat(64)}`);
    assert.equal(res.status, 404, 'compression disabled should 404');
  });
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'ctx-http2-'));
  await withServer({
    apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {},
    compress: { enabled: true, backend: 'lean-ctx', storeDir }
  }, async () => {}, async (base) => {
    const bad = await fetch(`${base}/v1/ctx/not-a-hash`);
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/v1/ctx/${'c'.repeat(64)}`);
    assert.equal(missing.status, 404);
  });
});

test('unknown model returns 400', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, async () => {}, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope' })
    });
    assert.equal(res.status, 400);
  });
});

test('malformed JSON and missing model return 400', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, async () => {}, async (base) => {
    const malformed = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json'
    });
    assert.equal(malformed.status, 400);

    const missing = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: [] })
    });
    assert.equal(missing.status, 400);
  });
});

test('request body limit returns 413 before calling upstream', async () => {
  let upstreamCalls = 0;
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {},
    limits: { maxRequestBodyBytes: 128, requestBodyIdleMs: 1_000 }
  }, async () => {
    upstreamCalls += 1;
    return new Response('{}', { status: 200 });
  }, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: [{ type: 'message', role: 'user', content: 'x'.repeat(512) }]
      })
    });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error.message, /request body exceeds 128 bytes/i);
  });
  assert.equal(upstreamCalls, 0);
});

test('chunked request body limit is enforced while streaming', async () => {
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {},
    limits: { maxRequestBodyBytes: 64, requestBodyIdleMs: 1_000 }
  }, async () => new Response('{}', { status: 200 }), async (base) => {
    const url = new URL('/v1/responses', base);
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked'
        }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      });
      request.on('error', reject);
      request.write('{"model":"deepseek-v4-flash",');
      request.write('"input":"');
      request.write('x'.repeat(128));
      request.end('"}');
    });
    assert.equal(result.status, 413);
    assert.match(JSON.parse(result.body).error.message, /request body exceeds 64 bytes/i);
  });
});

test('stalled request body returns 408 after the configured idle timeout', async () => {
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {},
    limits: { maxRequestBodyBytes: 1024, requestBodyIdleMs: 30 }
  }, async () => new Response('{}', { status: 200 }), async (base) => {
    const url = new URL('/v1/responses', base);
    const result = await new Promise((resolve, reject) => {
      let guard;
      const request = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked'
        }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(guard);
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      });
      request.on('error', reject);
      request.write('{"model":"deepseek-v4-flash","input":[');
      guard = setTimeout(() => {
        request.destroy();
        reject(new Error('timed out waiting for router 408 response'));
      }, 500);
      guard.unref?.();
    });
    assert.equal(result.status, 408);
    assert.match(JSON.parse(result.body).error.message, /idle timeout/i);
  });
});

test('configured model without providers returns 503', async () => {
  await withServer({ apiKey: 'k', apiBaseUrl: null, models: {} }, async () => {}, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] })
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /no provider configured/i);
  });
});

test('chat route falls back to chat completions when responses fails', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'resp fail' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] })
    });
    const data = await res.json();
    assert.equal(data.object, 'response');
    assert.equal(data.output[0].content[0].text, 'ok');
  });
});

test('messages route converts anthropic response', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    id: 'msg_1',
    model: 'minimax-m3',
    content: [{ type: 'text', text: 'ok' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'minimax-m3', stream: false, input: [] })
    });
    const data = await res.json();
    assert.equal(data.object, 'response');
    assert.equal(data.output[0].content[0].text, 'ok');
  });
});

test('messages route sends x-api-key header', async () => {
  let seenHeaders;
  const fetchImpl = async (url, init) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({
      id: 'msg_1',
      model: 'minimax-m3',
      content: [{ type: 'text', text: 'ok' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'minimax-m3', stream: false, input: [] })
    });
  });
  assert.equal(seenHeaders['x-api-key'], 'k');
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
});

test('messages route uses the selected provider key', async () => {
  let seenHeaders;
  const fetchImpl = async (url, init) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({
      id: 'msg_1',
      model: 'minimax-m3',
      content: [{ type: 'text', text: 'ok' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'global-key',
    apiBaseUrl: 'https://global/v1',
    models: {
      'minimax-m3': {
        upstream: 'messages',
        endpoint: 'https://messages.test/v1',
        apiKey: 'model-key'
      }
    }
  }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'minimax-m3', stream: false, input: [] })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(seenHeaders['x-api-key'], 'model-key');
});

test('messages route fails over across configured providers', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('messages-a')) {
      return new Response(JSON.stringify({ error: { message: 'down' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: 'msg_1',
      model: 'minimax-m3',
      content: [{ type: 'text', text: 'ok' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'global-key',
    apiBaseUrl: null,
    models: {
      'minimax-m3': {
        upstream: 'messages',
        endpoint: [
          { url: 'https://messages-a/v1', apiKey: 'a-key' },
          { url: 'https://messages-b/v1', apiKey: 'b-key' }
        ]
      }
    }
  }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'minimax-m3', stream: false, input: [] })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).output[0].content[0].text, 'ok');
  });
  assert.deepEqual(calls, [
    'https://messages-a/v1/messages',
    'https://messages-b/v1/messages'
  ]);
});

test('messages route skips a provider opened by the shared circuit breaker', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('messages-a')) {
      return new Response(JSON.stringify({ error: { message: 'down' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: 'msg_1',
      model: 'minimax-m3',
      content: [{ type: 'text', text: 'ok' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'global-key',
    apiBaseUrl: null,
    circuitBreaker: {
      enabled: true,
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 60_000,
      errorRateThreshold: 1,
      minRequests: 100
    },
    models: {
      'minimax-m3': {
        upstream: 'messages',
        endpoint: [
          { url: 'https://messages-a/v1', apiKey: 'a-key' },
          { url: 'https://messages-b/v1', apiKey: 'b-key' }
        ]
      }
    }
  }, fetchImpl, async (base) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'minimax-m3', stream: false, input: [] })
      });
      assert.equal(res.status, 200);
    }
  });
  assert.deepEqual(calls, [
    'https://messages-a/v1/messages',
    'https://messages-b/v1/messages',
    'https://messages-b/v1/messages'
  ]);
});

test('chat route fails over across configured providers', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('chat-a')) {
      return new Response(JSON.stringify({ error: { message: 'down' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'global-key',
    apiBaseUrl: null,
    models: {
      'deepseek-v4-flash': {
        upstream: 'chat',
        endpoint: [
          { url: 'https://chat-a/v1', apiKey: 'a-key' },
          { url: 'https://chat-b/v1', apiKey: 'b-key' }
        ]
      }
    }
  }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).output[0].content[0].text, 'ok');
  });
  assert.deepEqual(calls, [
    'https://chat-a/v1/chat/completions',
    'https://chat-b/v1/chat/completions'
  ]);
});

test('provider failover cancels the discarded upstream response body', async () => {
  let cancelled = 0;
  const fetchImpl = async (url) => {
    if (url.includes('chat-a')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('temporary failure'));
        },
        cancel() {
          cancelled += 1;
        }
      }), { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await withServer({
    apiKey: 'global-key',
    apiBaseUrl: null,
    models: {
      'deepseek-v4-flash': {
        upstream: 'chat',
        endpoint: [
          { url: 'https://chat-a/v1', apiKey: 'a-key' },
          { url: 'https://chat-b/v1', apiKey: 'b-key' }
        ]
      }
    }
  }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] })
    });
    assert.equal(res.status, 200);
  });

  assert.equal(cancelled, 1);
});

test('provider failover updates bounded session affinity', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('responses-a')) {
      return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: 'resp_1',
      object: 'response',
      model: 'deepseek-v4-flash',
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        prompt_cache_hit_tokens: 8,
        prompt_cache_miss_tokens: 2
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await withServer({
    apiKey: 'global-key',
    apiBaseUrl: null,
    providerStickiness: { enabled: true, ttlMs: 60_000, maxEntries: 100 },
    models: {
      'deepseek-v4-flash': {
        upstream: 'responses',
        endpoint: [
          { url: 'https://responses-a/v1', apiKey: 'a-key' },
          { url: 'https://responses-b/v1', apiKey: 'b-key' }
        ]
      }
    }
  }, fetchImpl, async (base) => {
    for (const sessionId of ['session-1', 'session-1', 'session-2']) {
      const res = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream: false,
          metadata: { session_id: sessionId },
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
        })
      });
      assert.equal(res.status, 200);
    }
  });

  assert.deepEqual(calls, [
    'https://responses-a/v1/responses',
    'https://responses-b/v1/responses',
    'https://responses-b/v1/responses',
    'https://responses-a/v1/responses',
    'https://responses-b/v1/responses'
  ]);
});

test('chat route skips a provider opened by the shared circuit breaker', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('chat-a')) {
      return new Response(JSON.stringify({ error: { message: 'down' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'global-key',
    apiBaseUrl: null,
    circuitBreaker: {
      enabled: true,
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 60_000,
      errorRateThreshold: 1,
      minRequests: 100
    },
    models: {
      'deepseek-v4-flash': {
        upstream: 'chat',
        endpoint: [
          { url: 'https://chat-a/v1', apiKey: 'a-key' },
          { url: 'https://chat-b/v1', apiKey: 'b-key' }
        ]
      }
    }
  }, fetchImpl, async (base) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] })
      });
      assert.equal(res.status, 200);
    }
  });
  assert.deepEqual(calls, [
    'https://chat-a/v1/chat/completions',
    'https://chat-b/v1/chat/completions',
    'https://chat-b/v1/chat/completions'
  ]);
});

test('chat stream failure is recorded as a failed provider attempt', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-stream-usage-'));
  const file = path.join(dir, 'requests.jsonl');
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
      ));
      controller.error(new Error('chat stream broke'));
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  try {
    await withServer({
      apiKey: 'global-key',
      apiBaseUrl: null,
      usageLog: { enabled: true, file },
      models: {
        'deepseek-v4-flash': {
          upstream: 'chat',
          endpoint: 'https://chat.test/v1',
          apiKey: 'chat-key'
        }
      }
    }, fetchImpl, async (base) => {
      const res = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, input: [] })
      });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /event: response\.failed/);

      const stats = await fetch(`${base}/v1/usage?days=7`).then((response) => response.json());
      assert.equal(stats.totalRequests, 1);
      assert.equal(stats.successRate, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('responses route relays upstream body', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] })
    });
    const data = await res.json();
    assert.equal(data.id, 'resp_1');
  });
});

test('responses passthrough normalizes cross-protocol history items', async () => {
  let forwarded;
  const fetchImpl = async (url, init) => {
    forwarded = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        previous_response_id: 'chatcmpl-legacy',
        input: [
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'sh', arguments: '{}', status: 'completed', outputIndex: 1 },
          { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok', outputIndex: 2 }
        ]
      })
    });
    assert.equal(res.status, 200);
  });

  assert.equal(forwarded.previous_response_id, undefined);
  assert.deepEqual(forwarded.input, [
    { type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
  ]);
});

test('round-trips context when switching between chat and responses routes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, request });
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'resp fail' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({
        id: 'chatcmpl-1',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{
          message: {
            role: 'assistant',
            content: 'done',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sh', arguments: '{}' } }]
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const deepseek = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] }]
      })
    });
    const deepseekResponse = await deepseek.json();

    await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        previous_response_id: deepseekResponse.id,
        input: deepseekResponse.output
      })
    });

    await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
          { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
          { type: 'function_call', call_id: 'call_2', name: 'sh', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_2', output: 'done' }
        ]
      })
    });
  });

  assert.equal(calls[0].url, 'https://x/v1/responses');
  assert.equal(calls[1].url, 'https://x/v1/chat/completions');
  assert.deepEqual(calls[1].request.messages, [
    { role: 'user', content: 'run it' }
  ]);
  assert.equal(calls[2].url, 'https://x/v1/responses');
  assert.equal(calls[2].request.previous_response_id, undefined);
  assert.equal(calls[2].request.input[0].role, 'user');
  assert.equal(calls[2].request.input[0].phase, undefined);
  assert.deepEqual(calls[2].request.input[0].content, [{ type: 'input_text', text: 'done' }]);
  assert.equal(calls[2].request.input[1].status, undefined);
  assert.equal(calls[3].url, 'https://x/v1/chat/completions');
  assert.equal(calls[4].url, 'https://x/v1/responses');
  assert.equal(calls[5].url, 'https://x/v1/chat/completions');
  assert.deepEqual(calls[5].request.messages, [
    { role: 'user', content: 'continue' },
    {
      role: 'assistant',
      content: 'ok',
      tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'sh', arguments: '{}' } }],
      reasoning_content: ''
    },
    { role: 'tool', tool_call_id: 'call_2', content: 'done' }
  ]);
});


test('responses passthrough repairs duplicated tool names in history', async () => {
  let forwarded;
  const fetchImpl = async (url, init) => {
    forwarded = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'shell_commandshell_command', arguments: '{}' },
          { type: 'function_call', call_id: 'call_2', name: 'get_goalget_goalget_goalget_goal', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
          { type: 'function_call_output', call_id: 'call_2', output: 'ok' }
        ]
      })
    });
    assert.equal(res.status, 200);
  });

  assert.equal(forwarded.input[0].name, 'shell_command');
  assert.equal(forwarded.input[1].name, 'get_goal');
});


test('responses passthrough flattens assistant history for upstream', async () => {
  let forwarded;
  const fetchImpl = async (url, init) => {
    forwarded = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        input: [
          { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'run it' }] },
          { type: 'message', role: 'assistant', id: 'a1', phase: 'final', content: [{ type: 'output_text', text: 'done', annotations: [] }] },
          { type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
        ]
      })
    });
    assert.equal(res.status, 200);
  });

  assert.deepEqual(forwarded.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'done' }] },
    { type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
  ]);
});

test('normalizeResponsesRequest drops reasoning items from input', () => {
  const request = normalizeResponsesRequest({
    model: 'gpt-5.6-luna',
    input: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'rs_2', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
    ]
  });
  assert.equal(request.input.some((item) => item.type === 'reasoning'), false, 'reasoning items must not be forwarded');
  assert.deepEqual(request.input.map((i) => i.type), ['message', 'function_call', 'function_call_output']);
});

test('normalizeResponsesRequest maps custom tool items to function items', () => {
  const request = normalizeResponsesRequest({
    model: 'gpt-5.6-luna',
    input: [
      { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', input: { patch: 'x' } },
      { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_1', output: 'ok' }
    ]
  });
  assert.deepEqual(request.input, [
    { type: 'function_call', call_id: 'call_1', name: 'apply_patch', arguments: '{"patch":"x"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
  ]);
});

test('normalizeResponsesRequest drops orphan tool outputs and keeps unanswered calls', () => {
  const request = normalizeResponsesRequest({
    model: 'gpt-5.6-sol',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
      { type: 'function_call', call_id: 'call_pending', name: 'shell_command', arguments: '{}' },
      { type: 'function_call', call_id: 'call_ok', name: 'shell_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_orphan', output: 'no matching call' },
      { type: 'function_call_output', call_id: 'call_ok', output: 'ok' }
    ]
  });
  assert.deepEqual(request.input.map((i) => i.type), ['message', 'function_call', 'function_call', 'function_call_output']);
  assert.deepEqual(request.input.map((i) => i.call_id || '').filter(Boolean), ['call_pending', 'call_ok', 'call_ok']);
});

test('normalizeResponsesRequest repairs truncation that split a tool round', () => {
  const truncated = {
    input: [
      { type: 'function_call', call_id: 'call_b', name: 'shell_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'orphan a' },
      { type: 'function_call_output', call_id: 'call_b', output: 'ok b' },
      { type: 'function_call', call_id: 'call_c', name: 'shell_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_c', output: 'ok c' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
    ]
  };
  const request = normalizeResponsesRequest({ model: 'gpt-5.6-sol', input: truncated.input });
  const callIds = request.input.filter((i) => i.type === 'function_call').map((i) => i.call_id);
  const outputIds = request.input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id);
  assert.deepEqual(callIds, ['call_b', 'call_c']);
  assert.deepEqual(outputIds, ['call_b', 'call_c']);
});

test('normalizeResponsesRequest strips legacy item ids before forwarding', () => {
  const request = normalizeResponsesRequest({
    model: 'gpt-5.6-luna',
    input: [
      { type: 'message', role: 'user', id: 'resp_abc_msg', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', id: 'resp_abc_fc', call_id: 'call_1', name: 'sh', arguments: '{}' },
      { type: 'function_call_output', id: 'resp_abc_fco', call_id: 'call_1', output: 'ok' }
    ]
  });
  assert.equal(request.input.some((item) => Object.hasOwn(item, 'id')), false);
});

test('history truncation drops orphan tool_search outputs', async () => {
  let forwarded;
  const fetchImpl = async (url, init) => {
    forwarded = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const input = [
    {
      type: 'tool_search_call',
      call_id: 'call_search',
      status: 'completed',
      execution: 'client',
      arguments: { query: 'code graph' }
    },
    {
      type: 'tool_search_output',
      call_id: 'call_search',
      status: 'completed',
      execution: 'client',
      tools: []
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `message-${index}` }]
    }))
  ];
  await withServer({
    apiKey: 'k',
    apiBaseUrl: null,
    models: {
      'gpt-5.6-sol': {
        upstream: 'responses',
        endpoint: 'https://ergou.test/v1',
        apiKey: 'ergou-key',
        maxHistoryMessages: 10
      }
    }
  }, fetchImpl, async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: false, input })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(
    forwarded.input.some((item) => item.type === 'tool_search_output'),
    false,
    'truncation must not leave a tool_search_output without its matching call'
  );
});

test('normalizeResponsesRequest preserves paired tool_search items', () => {
  const request = normalizeResponsesRequest({
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'tool_search_call',
        call_id: 'call_search',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'code graph' }
      },
      {
        type: 'tool_search_output',
        call_id: 'call_search',
        status: 'completed',
        execution: 'client',
        tools: []
      }
    ]
  });
  assert.deepEqual(request.input.map((item) => item.type), [
    'tool_search_call',
    'tool_search_output'
  ]);
});
