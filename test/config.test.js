import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

function makeConfig(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-config-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ port: 12345, ...extra }));
  return { dir, file };
}

test('loads config and api key from env', () => {
  const { dir, file } = makeConfig();
  const cfg = loadConfig({ configPath: file, env: { OPENCODE_GO_API_KEY: 'k' } });
  assert.equal(cfg.port, 12345);
  assert.equal(cfg.apiKey, 'k');
  rmSync(dir, { recursive: true, force: true });
});

test('throws when api key env is missing', () => {
  const { dir, file } = makeConfig();
  assert.throws(() => loadConfig({ configPath: file, env: {} }), /missing OPENCODE_GO_API_KEY/);
  rmSync(dir, { recursive: true, force: true });
});

test('loads compress defaults and merges overrides', () => {
  const { dir, file } = makeConfig({ compress: { baseUrl: 'http://127.0.0.1:4444' } });
  const cfg = loadConfig({ configPath: file, env: { OPENCODE_GO_API_KEY: 'k' } });
  assert.equal(cfg.compress.backend, 'lean-ctx');
  assert.equal(cfg.compress.enabled, true);
  assert.equal(cfg.compress.baseUrl, 'http://127.0.0.1:4444');
  assert.equal(cfg.compress.storeDir, 'ctx-store');
  rmSync(dir, { recursive: true, force: true });
});

test('resolves per-model api key from its own env var', () => {
  const { dir, file } = makeConfig({
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: 'https://ergouapi.com/v1', apiKeyEnv: 'ERGOUAPI_API_KEY' } }
  });
  const cfg = loadConfig({ configPath: file, env: { OPENCODE_GO_API_KEY: 'opencode-key', ERGOUAPI_API_KEY: 'ergou-key' } });
  assert.equal(cfg.models['gpt-5.6-luna'].apiKey, 'ergou-key');
  assert.equal(cfg.models['gpt-5.6-luna'].endpoint, 'https://ergouapi.com/v1');
  rmSync(dir, { recursive: true, force: true });
});

test('throws when a model or endpoint api key env is missing', () => {
  const modelConfig = makeConfig({
    models: {
      'gpt-5.6-luna': {
        upstream: 'responses',
        endpoint: 'https://ergouapi.com/v1',
        apiKeyEnv: 'MISSING_MODEL_KEY'
      }
    }
  });
  assert.throws(() => loadConfig({
    configPath: modelConfig.file,
    env: { OPENCODE_GO_API_KEY: 'global-key' }
  }), /missing MISSING_MODEL_KEY.*model gpt-5\.6-luna/i);
  rmSync(modelConfig.dir, { recursive: true, force: true });

  const endpointConfig = makeConfig({
    apiBaseUrl: [
      { url: 'https://global-b/v1', apiKeyEnv: 'MISSING_ENDPOINT_KEY' }
    ]
  });
  assert.throws(() => loadConfig({
    configPath: endpointConfig.file,
    env: { OPENCODE_GO_API_KEY: 'global-key' }
  }), /missing MISSING_ENDPOINT_KEY.*apiBaseUrl/i);
  rmSync(endpointConfig.dir, { recursive: true, force: true });
});

test('resolves per-endpoint api keys from endpoint objects', () => {
  const { dir, file } = makeConfig({
    apiBaseUrl: [{ url: 'https://global-b/v1', apiKeyEnv: 'GLOBAL_B_KEY' }],
    models: { 'gpt-5.6-luna': { upstream: 'responses', endpoint: [
      { url: 'https://ergou1/v1', apiKeyEnv: 'ERGO1_KEY' },
      'https://ergou2/v1'
    ], apiKeyEnv: 'ERGOUAPI_API_KEY' } }
  });
  const cfg = loadConfig({
    configPath: file,
    env: { OPENCODE_GO_API_KEY: 'gk', ERGOUAPI_API_KEY: 'ek', ERGO1_KEY: 'ek-1', GLOBAL_B_KEY: 'gk-b' }
  });
  assert.equal(cfg.models['gpt-5.6-luna'].endpoint[0].apiKey, 'ek-1');
  assert.equal(cfg.models['gpt-5.6-luna'].endpoint[1], 'https://ergou2/v1');
  assert.equal(cfg.apiBaseUrl[0].apiKey, 'gk-b');
  rmSync(dir, { recursive: true, force: true });
});

test('normalizes modelPatterns api keys and endpoints', () => {
  const { dir, file } = makeConfig({
    modelPatterns: {
      'gpt-*': {
        upstream: 'responses',
        endpoint: [
          { url: 'https://ergou1/v1', apiKeyEnv: 'ERGO1_KEY' },
          'https://ergou2/v1'
        ],
        apiKeyEnv: 'ERGOUAPI_API_KEY'
      }
    }
  });
  const cfg = loadConfig({
    configPath: file,
    env: { OPENCODE_GO_API_KEY: 'gk', ERGOUAPI_API_KEY: 'ek', ERGO1_KEY: 'ek-1' }
  });
  assert.equal(cfg.modelPatterns['gpt-*'].apiKey, 'ek');
  assert.equal(cfg.modelPatterns['gpt-*'].endpoint[0].apiKey, 'ek-1');
  assert.equal(cfg.modelPatterns['gpt-*'].endpoint[1], 'https://ergou2/v1');
  rmSync(dir, { recursive: true, force: true });
});

test('loads usageLog defaults and merges overrides', () => {
  const { dir, file } = makeConfig({ usageLog: { file: 'x/y.jsonl' } });
  const cfg = loadConfig({ configPath: file, env: { OPENCODE_GO_API_KEY: 'k' } });
  assert.equal(cfg.usageLog.enabled, false);
  assert.equal(cfg.usageLog.file, 'x/y.jsonl');
  rmSync(dir, { recursive: true, force: true });
});
