import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, UnknownModelError, listRoutedModels } from '../src/routes.js';

const config = { apiBaseUrl: 'https://opencode.ai/zen/go/v1', models: {} };

test('routes luna to responses', () => {
  const route = resolveRoute(config, 'gpt-5.6-luna');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/responses');
});

test('routes deepseek to responses with chat fallback', () => {
  const route = resolveRoute(config, 'deepseek-v4-flash');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/responses');
});

test('config chat override is normalized to responses', () => {
  const cfg = { apiBaseUrl: 'https://x/v1', models: { 'deepseek-v4-flash': { upstream: 'chat' } } };
  const route = resolveRoute(cfg, 'deepseek-v4-flash');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://x/v1/responses');
});

test('routes minimax to messages', () => {
  const route = resolveRoute(config, 'minimax-m3');
  assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/messages');
});

test('throws for unknown model', () => {
  assert.throws(() => resolveRoute(config, 'nope'), UnknownModelError);
});

test('routes model with custom endpoint to provider and keeps opencode fallback', () => {
  const cfg = {
    apiBaseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: 'opencode-key',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key' } }
  };
  const route = resolveRoute(cfg, 'gpt-5.6-luna');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://ergouapi.com/v1/responses');
  assert.equal(route.apiKey, 'ergou-key');
  assert.equal(route.fallbackEndpoint, 'https://opencode.ai/zen/go/v1/responses');
  assert.equal(route.fallbackApiKey, 'opencode-key');
});

test('route without custom endpoint has no provider fallback', () => {
  const route = resolveRoute({ ...config, apiKey: 'k' }, 'gpt-5.6-luna');
  assert.equal(route.fallbackEndpoint, null);
  assert.equal(route.fallbackApiKey, null);
  assert.equal(route.apiKey, 'k');
});

test('lists routed models', () => {
  assert.ok(listRoutedModels(config).includes('gpt-5.6-luna'));
  assert.ok(listRoutedModels(config).includes('qwen3.6-plus'));
});
