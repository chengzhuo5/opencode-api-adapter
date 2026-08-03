import test from 'node:test';
import assert from 'node:assert/strict';
import { hasImageInput, maybeUpgradeModel } from '../src/fallback.js';

test('hasImageInput detects input_image blocks', () => {
  const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'https://x/1.png' }] }] };
  assert.equal(hasImageInput(body), true);
});

test('hasImageInput detects image_url and file_id variants', () => {
  const a = { input: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/1.png' } }] }] };
  const b = { input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] };
  assert.equal(hasImageInput(a), true);
  assert.equal(hasImageInput(b), true);
});

test('hasImageInput returns false without images', () => {
  assert.equal(hasImageInput({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }), false);
  assert.equal(hasImageInput({ input: 'hi' }), false);
  assert.equal(hasImageInput({}), false);
});

test('hasImageInput ignores images from older history turns', () => {
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://x/old.png' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new text only' }] }
    ]
  };
  assert.equal(hasImageInput(body), false);
});

test('maybeUpgradeModel upgrades deepseek with image to luna', () => {
  const body = { model: 'deepseek-v4-flash', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/1.png' }] }] };
  const upgraded = maybeUpgradeModel(body);
  assert.equal(upgraded.model, 'gpt-5.6-luna');
  assert.deepEqual(upgraded.input, body.input);
});

test('maybeUpgradeModel keeps deepseek without image', () => {
  const body = { model: 'deepseek-v4-flash', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
  assert.equal(maybeUpgradeModel(body), body);
});

test('maybeUpgradeModel keeps other models with image', () => {
  const body = { model: 'kimi-k3', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/1.png' }] }] };
  assert.equal(maybeUpgradeModel(body), body);
});

import { once } from 'node:events';
import { createRouter } from '../src/server.js';

async function withServer(config, fetchImpl, fn) {
  const server = createRouter(config, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

test('fallback retries chat when responses returns 500', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.object, 'response');
    assert.equal(data.output[0].content[0].text, 'ok');
  });
  assert.equal(calls[0].url, 'https://x/v1/responses');
  assert.equal(calls[1].url, 'https://x/v1/chat/completions');
});

test('fallback retries chat on network error', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/responses')) throw new Error('network down');
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(data.object, 'response');
  });
  assert.equal(calls.length, 2);
});

test('fallback relays responses when it succeeds', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }) });
    const data = await res.json();
    assert.equal(data.id, 'resp_1');
  });
  assert.equal(calls, 1);
});

test('fallback relays chat error when both fail', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/responses')) return new Response(JSON.stringify({ error: { message: 'resp fail' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: 'chat fail' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error.message, 'chat fail');
  });
});


test('deepseek image request is upgraded to luna and response keeps original model', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen = body;
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'https://x/1.png' }] }]
      })
    });
    const data = await res.json();
    assert.equal(data.id, 'resp_1');
  });
  assert.equal(seen.model, 'gpt-5.6-luna');
  assert.equal(seen.input[0].content[1].type, 'input_image');
});

test('deepseek image request falls back to chat when luna responses fails', async () => {
  let chatSeen;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'resp fail' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    chatSeen = body;
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'gpt-5.6-luna', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://x/1.png' }] }]
      })
    });
    const data = await res.json();
    assert.equal(data.object, 'response');
    assert.equal(data.output[0].content[0].text, 'ok');
  });
  assert.equal(chatSeen.model, 'gpt-5.6-luna');
});

test('logs multimodal fallback without logging secrets or prompt content', async () => {
  const events = [];
  const fetchImpl = async () => new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

  await withServer({ apiKey: 'secret-key', logger: (event) => events.push(event), apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        instructions: 'private prompt',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,secret-image' }] }]
      })
    });
    assert.equal(res.status, 200);
  });

  assert.equal(events[0].event, 'multimodal_fallback');
  assert.equal(events[0].model, 'deepseek-v4-flash');
  assert.equal(events[0].fallback_model, 'gpt-5.6-luna');
  assert.equal(JSON.stringify(events).includes('secret-key'), false);
  assert.equal(JSON.stringify(events).includes('private prompt'), false);
});

test('logs API fallback trigger and result without request contents', async () => {
  const events = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'primary failed' } }), {
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

  await withServer({ apiKey: 'secret-key', logger: (event) => events.push(event), apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', instructions: 'private prompt', input: [] })
    });
    assert.equal(res.status, 200);
  });

  assert.equal(events[0].event, 'api_fallback');
  assert.equal(events[0].model, 'deepseek-v4-flash');
  assert.equal(events[0].primary_status, 503);
  assert.equal(events[0].fallback_endpoint, 'chat/completions');
  assert.equal(events[1].event, 'api_fallback_result');
  assert.equal(events[1].status, 200);
  assert.equal(events[1].success, true);
  assert.equal(JSON.stringify(events).includes('secret-key'), false);
  assert.equal(JSON.stringify(events).includes('private prompt'), false);
});

import { clearUnsupportedCache } from '../src/fallback.js';

test('remembers unsupported responses endpoint for subsequent requests', async () => {
  clearUnsupportedCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { code: 'invalid_prompt', message: 'unsupported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const make = () => fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    const r1 = await make();
    assert.equal(r1.status, 200);
    const r2 = await make();
    assert.equal(r2.status, 200);
  });
  assert.equal(calls.length, 3, 'expected responses+chat then direct chat');
  assert.equal(calls[0].url, 'https://x/v1/responses');
  assert.equal(calls[1].url, 'https://x/v1/chat/completions');
  assert.equal(calls[2].url, 'https://x/v1/chat/completions');
});

test('does not cache transient responses failures like 500', async () => {
  clearUnsupportedCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const make = () => fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    await make();
    await make();
  });
  assert.equal(calls.length, 4, 'expected responses+chat for each request');
  assert.equal(calls[0], 'https://x/v1/responses');
  assert.equal(calls[2], 'https://x/v1/responses');
});


test('logs responses_unsupported only once per model', async () => {
  clearUnsupportedCache();
  const events = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { code: 'invalid_prompt', message: 'unsupported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', logger: (event) => events.push(event), apiBaseUrl: 'https://x/v1', models: {} }, fetchImpl, async (base) => {
    const make = () => fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [] }) });
    await make();
    await make();
    await make();
  });
  const unsupported = events.filter((e) => e.event === 'api_fallback' && e.reason === 'responses_unsupported');
  assert.equal(unsupported.length, 1, 'expected exactly one responses_unsupported log');
});


test('compression is applied before forwarding and falls back when daemon is down', async () => {
  clearUnsupportedCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'x' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({ apiKey: 'k', apiBaseUrl: 'https://x/v1', models: {}, compress: { enabled: true, backend: 'lean-ctx', baseUrl: 'http://127.0.0.1:1', token: '', storeDir: null, timeoutMs: 200 } }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }) });
    assert.equal(res.status, 200);
  });
  assert.equal(calls[0].body.input[0].role, 'user');
});

