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

