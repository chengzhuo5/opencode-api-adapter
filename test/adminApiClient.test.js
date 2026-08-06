import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorMessage, createApiClient, AdminApiError } from '../admin/apiClient.js';

test('apiErrorMessage unwraps structured server errors instead of rendering object text', () => {
  assert.equal(apiErrorMessage({ error: { message: 'request body too large' } }, 413), 'request body too large');
  assert.equal(apiErrorMessage({ error: 'plain failure' }, 400), 'plain failure');
  assert.equal(apiErrorMessage({ message: 'fallback failure' }, 500), 'fallback failure');
  assert.equal(apiErrorMessage({}, 502), 'HTTP 502');
});

test('admin API client attaches the session bearer token', async () => {
  let authorization = null;
  const request = createApiClient({
    getToken: () => 'tab-only-secret',
    fetchImpl: async (_path, options) => {
      authorization = options.headers.get('authorization');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.deepEqual(await request('/api/status'), { ok: true });
  assert.equal(authorization, 'Bearer tab-only-secret');
});

test('admin API client exposes HTTP status and the nested server message', async () => {
  const request = createApiClient({
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'management authorization required' }
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(
    request('/api/status'),
    (error) => error instanceof AdminApiError
      && error.status === 401
      && error.message === 'management authorization required'
  );
});
