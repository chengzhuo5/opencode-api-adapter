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

test('config chat override routes to chat completions', () => {
  const cfg = { apiBaseUrl: 'https://x/v1', models: { 'deepseek-v4-flash': { upstream: 'chat' } } };
  const route = resolveRoute(cfg, 'deepseek-v4-flash');
  assert.equal(route.upstream, 'chat');
  assert.equal(route.endpoint, 'https://x/v1/chat/completions');
});

test('routes deepseek custom endpoint to official responses', () => {
  const cfg = { apiBaseUrl: 'https://opencode.ai/zen/go/v1', models: { 'deepseek-v4-flash': { upstream: 'responses', endpoint: 'https://api.deepseek.com/v1' } } };
  const route = resolveRoute(cfg, 'deepseek-v4-flash');
  assert.equal(route.upstream, 'responses');
  assert.equal(route.endpoint, 'https://api.deepseek.com/v1/responses');
});

test('routes all gpt models to responses', () => {
  for (const id of ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']) {
    const route = resolveRoute(config, id);
    assert.equal(route.upstream, 'responses');
    assert.equal(route.endpoint, 'https://opencode.ai/zen/go/v1/responses');
  }
});

test('gpt models route to ergou with custom endpoint and key', () => {
  const cfg = {
    apiBaseUrl: 'https://opencode.ai/zen/go/v1',
    models: {
      'gpt-5.5': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key', maxHistoryMessages: 10 },
      'gpt-5.6-terra': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKey: 'ergou-key', maxHistoryMessages: 10 }
    }
  };
  const r1 = resolveRoute(cfg, 'gpt-5.5');
  assert.equal(r1.endpoint, 'https://ergouapi.com/v1/responses');
  assert.equal(r1.apiKey, 'ergou-key');
  const r2 = resolveRoute(cfg, 'gpt-5.6-terra');
  assert.equal(r2.endpoint, 'https://ergouapi.com/v1/responses');
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

test('resolves ordered providers from array endpoints', () => {
  const cfg = {
    apiBaseUrl: ['https://global-a/v1', 'https://global-b/v1'],
    apiKey: 'gk',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: ['https://ergou1/v1', 'https://ergou2/v1'], apiKey: 'ek' } }
  };
  const route = resolveRoute(cfg, 'gpt-5.6-luna');
  assert.deepEqual(route.providers.map((p) => p.endpoint), [
    'https://ergou1/v1/responses',
    'https://ergou2/v1/responses',
    'https://global-a/v1/responses',
    'https://global-b/v1/responses'
  ]);
  assert.equal(route.endpoint, 'https://ergou1/v1/responses');
  assert.equal(route.apiKey, 'ek');
  assert.equal(route.fallbackEndpoint, 'https://ergou2/v1/responses');
  assert.equal(route.fallbackApiKey, 'ek');
});

test('array endpoint objects carry their own api keys', () => {
  const cfg = {
    apiBaseUrl: ['https://global-a/v1', { url: 'https://global-b/v1', apiKey: 'gk-b' }],
    apiKey: 'gk',
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: [
      { url: 'https://ergou1/v1', apiKey: 'ek-1' },
      'https://ergou2/v1',
      { url: 'https://ergou3/v1', apiKey: 'ek-3' }
    ], apiKey: 'ek' } }
  };
  const route = resolveRoute(cfg, 'gpt-5.6-luna');
  assert.deepEqual(route.providers.map((p) => ({ endpoint: p.endpoint, apiKey: p.apiKey })), [
    { endpoint: 'https://ergou1/v1/responses', apiKey: 'ek-1' },
    { endpoint: 'https://ergou2/v1/responses', apiKey: 'ek' },
    { endpoint: 'https://ergou3/v1/responses', apiKey: 'ek-3' },
    { endpoint: 'https://global-a/v1/responses', apiKey: 'gk' },
    { endpoint: 'https://global-b/v1/responses', apiKey: 'gk-b' }
  ]);
});

test('lists routed models', () => {
  assert.ok(listRoutedModels(config).includes('gpt-5.6-luna'));
  assert.ok(listRoutedModels(config).includes('qwen3.6-plus'));
});
