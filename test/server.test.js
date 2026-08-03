import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/server.js';

async function withServer(config, fetchImpl, fn) {
  const server = createRouter(config, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
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
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok' }
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
      tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'sh', arguments: '{}' } }]
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
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'run it' }] },
    { type: 'message', role: 'user', id: 'a1', content: [{ type: 'input_text', text: 'done' }] },
    { type: 'function_call', call_id: 'call_1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
  ]);
});
