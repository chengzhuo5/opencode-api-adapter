import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createLeanCtxClient } from '../src/leanCtxClient.js';

async function mockServer(handler) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    await handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('compress posts messages and returns compressed text + stats', async () => {
  const mock = await mockServer(async (req, res, body) => {
    assert.equal(req.url, '/v1/compress');
    const payload = JSON.parse(body);
    assert.equal(payload.messages[0].content, 'big payload');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ role: 'user', content: 'tiny' }], stats: { saved_tokens: 100 } }));
  });
  try {
    const client = createLeanCtxClient({ baseUrl: mock.base, token: '' });
    const result = await client.compress([{ role: 'user', content: 'big payload' }], 'deepseek-v4-flash');
    assert.equal(result.messages[0].content, 'tiny');
    assert.equal(result.stats.saved_tokens, 100);
  } finally {
    mock.close();
  }
});

test('compress rejects when daemon is unreachable', async () => {
  const client = createLeanCtxClient({ baseUrl: 'http://127.0.0.1:1', token: '', timeoutMs: 500 });
  await assert.rejects(() => client.compress([{ role: 'user', content: 'x' }], 'deepseek-v4-flash'));
});
