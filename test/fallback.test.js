import test from 'node:test';
import assert from 'node:assert/strict';
import { hasImageInput, maybeUpgradeModel, minimizeHistoryImages, truncateHistory, stripAllImages, relayError } from '../src/fallback.js';

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

test('hasImageInput detects images inside function_call_output', () => {
  const body = {
    input: [
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
      { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is this?' }] }
    ]
  };
  assert.equal(hasImageInput(body), true, 'image inside function_call_output.output must be detected');
});

test('hasImageInput detects images in tool outputs after the latest user message', () => {
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look at the screenshot' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
      { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'shell_command', arguments: '{}' },
      { type: 'function_call_output', id: 'fco_2', call_id: 'call_2', output: 'ran a command' }
    ]
  };
  assert.equal(hasImageInput(body), true, 'image in current turn tool outputs must be detected even if not the last item');
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

test('provider fallback tries custom endpoint first, then opencode responses', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (url === 'https://ergouapi.com/v1/responses') {
      return new Response(JSON.stringify({ error: { message: 'bad model' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://x/v1/responses') {
      return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected url: ${url}`);
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', stream: false, input: [] }) });
    assert.equal(res.status, 200);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://ergouapi.com/v1/responses');
  assert.equal(calls[0].auth, 'Bearer ergou-key');
  assert.equal(calls[1].url, 'https://x/v1/responses');
  assert.equal(calls[1].auth, 'Bearer k');
});

test('provider fallback goes to chat when both providers fail', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (url.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'gpt-5.6-luna', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', stream: false, input: [] }) });
    const data = await res.json();
    assert.equal(data.object, 'response');
  });
  assert.deepEqual(calls.map((c) => c.url), [
    'https://ergouapi.com/v1/responses',
    'https://x/v1/responses',
    'https://x/v1/chat/completions'
  ]);
});

test('deepseek image request routes upgraded luna through its custom provider', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url === 'https://ergouapi.com/v1/responses') {
      return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected url: ${url}`);
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is this' }, { type: 'input_image', image_url: 'https://x/1.png' }] }]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(calls, ['https://ergouapi.com/v1/responses'], 'upgraded luna must use its custom provider endpoint');
});

test('logs include full endpoint URLs on fallback and multimodal events', async () => {
  const events = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'chatcmpl-1', created: 1, model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    logger: (e) => events.push(e),
    apiBaseUrl: 'https://opencode.example/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'https://x/1.png' }] }]
      })
    });
    assert.equal(res.status, 200);
  });

  const multimodal = events.find((e) => e.event === 'multimodal_fallback');
  assert.equal(multimodal.endpoint, 'https://ergouapi.com/v1/responses', 'multimodal log should carry the upgraded endpoint');
  const fallback = events.find((e) => e.event === 'api_fallback' && e.primary_url);
  assert.equal(fallback.primary_url, 'https://ergouapi.com/v1/responses', 'api_fallback should carry the primary full URL');
  const result = events.find((e) => e.event === 'api_fallback_result' && e.success === true);
  assert.equal(result.fallback_url, 'https://opencode.example/v1/chat/completions', 'api_fallback_result should carry the chat full URL');
});

test('file_id image requests skip custom provider and go to opencode', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', file_id: 'file_abc' }] }]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(calls.map((c) => c.url), ['https://x/v1/responses'], 'file_id image must route to opencode, not ergou');
  assert.equal(calls[0].auth, 'Bearer k');
});

test('minimizeHistoryImages keeps latest image and strips historical ones', () => {
  const img = 'data:image/png;base64,AAAA';
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }, { type: 'input_image', image_url: img }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }, { type: 'input_image', file_id: 'file_old' }] },
    { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'x' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'third' }, { type: 'input_image', image_url: img }] }
  ];
  const { input: out, removedImages } = minimizeHistoryImages(input);
  assert.equal(removedImages, 2, 'historical images should be stripped');
  assert.equal(out[0].content[1].type, 'input_text', 'historical image becomes placeholder text');
  assert.equal(out[0].content[1].text, '[image omitted]');
  assert.equal(out[2].content[1].type, 'input_text', 'file_id image in history is stripped too');
  assert.deepEqual(out[4], input[4], 'latest user message keeps its image untouched');
  assert.equal(out[3], input[3], 'non-message items pass through');
});

test('multimodal upgrade strips historical file_id images so ergou is not hit with them', async () => {
  const calls = [];
  const img = 'data:image/png;base64,AAAA';
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: true,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }, { type: 'input_image', file_id: 'file_old' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is this' }, { type: 'input_image', image_url: img }] }
        ]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ergouapi.com/v1/responses', 'current data-url image should still go to ergou');
  const sent = calls[0].body.input;
  assert.ok(sent.every((item) => !JSON.stringify(item).includes('file_old')), 'historical file_id must not reach ergou');
  assert.equal(sent[0].content[1].text, '[image omitted]');
  assert.equal(sent[2].content[1].type, 'input_image', 'current image kept');
});

test('minimizeHistoryImages strips historical images inside function_call_output', () => {
  const img = 'data:image/png;base64,AAAA';
  const input = [
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: img }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
    { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', id: 'fco_2', call_id: 'call_2', output: [{ type: 'input_image', image_url: img }, { type: 'input_text', text: 'note' }] }
  ];
  const { input: out, removedImages } = minimizeHistoryImages(input);
  assert.equal(removedImages, 1, 'historical fco image should be stripped');
  assert.equal(out[1].output[0].type, 'input_text', 'historical fco image becomes placeholder');
  assert.equal(out[1].output[0].text, '[image omitted]');
  assert.deepEqual(out[4], input[4], 'latest fco keeps its image');
  assert.equal(out[4].output[0].type, 'input_image');
});

test('minimizeHistoryImages keeps every image of the current turn (compare scenario)', () => {
  const img = 'data:image/png;base64,AAAA';
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compare these two screenshots' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: img }] },
    { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', id: 'fco_2', call_id: 'call_2', output: [{ type: 'input_image', image_url: img }] }
  ];
  const { input: out, removedImages } = minimizeHistoryImages(input);
  assert.equal(removedImages, 0, 'both current-turn screenshots must be kept for comparison');
  assert.equal(out[2].output[0].type, 'input_image', 'first screenshot kept');
  assert.equal(out[4].output[0].type, 'input_image', 'second screenshot kept');
});

test('deepseek request with image in function_call_output upgrades to luna and hits ergou', async () => {
  const calls = [];
  const img = 'data:image/png;base64,AAAA';
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: true,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is this?' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
          { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: img }] }
        ]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ergouapi.com/v1/responses', 'fco image must upgrade deepseek to luna and hit ergou');
  assert.equal(calls[0].body.model, 'gpt-5.6-luna');
  assert.equal(calls[0].body.input[2].output[0].type, 'input_image', 'current fco image is preserved');
});

test('view_image output upgrades deepseek even when followed by other tool calls', async () => {
  const calls = [];
  const img = 'data:image/png;base64,AAAA';
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: true,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look at the screenshot' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
          { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: img }] },
          { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'shell_command', arguments: '{}' },
          { type: 'function_call_output', id: 'fco_2', call_id: 'call_2', output: 'ran a command' }
        ]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ergouapi.com/v1/responses', 'view_image in current turn must upgrade to luna and hit ergou');
  assert.ok(JSON.stringify(calls[0].body.input).includes('base64'), 'image must be preserved for luna');
});

test('provider array tries each endpoint in order until success', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://ergou1/v1/responses') {
      return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: ['https://global-b/v1'],
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: ['https://ergou1/v1', 'https://ergou2/v1'], apiKey: 'ek' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', stream: true, input: [] })
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(calls, ['https://ergou1/v1/responses', 'https://ergou2/v1/responses'], 'should try array endpoints in order');
});

test('truncateHistory keeps latest N items and avoids orphan function_call_output at head', () => {
  const input = [];
  for (let i = 0; i < 20; i++) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `m${i}` }] });
  const { input: out, removed } = truncateHistory(input, 10);
  assert.equal(out.length, 10);
  assert.equal(removed, 10);
  assert.equal(out[0].content[0].text, 'm10');
  assert.equal(out[9].content[0].text, 'm19');

  // 开头不能是孤立的 function_call_output
  const withFco = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'm0' }] },
    { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'sh', arguments: '{}' },
    { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: 'x' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a', annotations: [] }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'm4' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a5', annotations: [] }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'm6' }] }
  ];
  const t2 = truncateHistory(withFco, 3);
  assert.equal(t2.input[0].type, 'message', 'head must not be a function_call_output');
  assert.equal(t2.input.length, 3);
});

test('custom provider request truncates history to maxHistoryMessages', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const history = [];
  for (let i = 0; i < 15; i++) history.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `m${i}` }] });
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key', maxHistoryMessages: 5 } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', stream: true, input: history })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ergouapi.com/v1/responses');
  assert.equal(calls[0].body.input.length, 5, 'history should be truncated to 5 items');
  assert.equal(calls[0].body.input[0].content[0].text, 'm10');
});

test('relayError adds readable message when upstream error body is empty', async () => {
  const calls = [];
  const res = { writeHead: (s, h) => calls.push(['head', s, h]), end: (b) => calls.push(['end', b]) };
  const upstream = new Response(JSON.stringify({ error: { message: '' } }), { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } });
  await relayError(res, upstream);
  assert.equal(calls[0][1], 403);
  assert.equal(JSON.parse(calls[1][1]).error.message, 'upstream 403 Forbidden');
});

test('stripAllImages removes every image from messages and tool outputs', () => {
  const img = 'data:image/png;base64,AAAA';
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }, { type: 'input_image', image_url: img }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: img }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] },
    { type: 'function_call_output', id: 'fco_2', call_id: 'call_2', output: [{ type: 'input_image', file_id: 'file_ref' }] }
  ];
  const { input: out, removedImages } = stripAllImages(input);
  assert.equal(removedImages, 2);
  assert.equal(out[0].content[1].type, 'input_text');
  assert.equal(out[0].content[1].text, '[image omitted]');
  assert.equal(out[2].output[0].type, 'input_text');
  assert.deepEqual(out[3], input[3]);
  assert.equal(out[4].output[0].file_id, 'file_ref', 'file_id references must be kept for file_id compatibility');
});

test('deepseek request without current image strips historical screenshots before forwarding', async () => {
  const calls = [];
  const img = 'data:image/png;base64,' + 'A'.repeat(2000);
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {}
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: true,
        input: [
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image', arguments: '{}' },
          { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: [{ type: 'input_image', image_url: img }] },
          { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'shell_command', arguments: '{}' },
          { type: 'function_call_output', id: 'fco_2', call_id: 'call_2', output: 'ran a command' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
        ]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(calls.length, 1);
  const sent = JSON.stringify(calls[0].body.input);
  assert.ok(!sent.includes('base64'), 'screenshot base64 must not reach deepseek');
  assert.equal(calls[0].body.input[1].output[0].text, '[image omitted]');
});

test('vision model direct request keeps images (no strip)', async () => {
  const calls = [];
  const img = 'data:image/png;base64,' + 'B'.repeat(1200);
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'resp_1', object: 'response' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  }, fetchImpl, async (base) => {
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'describe' }, { type: 'input_image', image_url: img }] }]
      })
    });
    assert.equal(res.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(calls[0].body.input).includes('base64'), 'vision model request must keep the image');
  assert.equal(calls[0].body.input[0].content[1].type, 'input_image');
});
