import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createCodexManager } from '../src/codexConfig.js';
import { createRouter } from '../src/server.js';

const FIXTURE = [
  '# 用户自己的注释，不要动',
  'model_provider = "deepseek"',
  'model = "deepseek-v4-flash"',
  'model_reasoning_effort = "max"',
  "model_catalog_json = 'C:/Code/catalog.json'",
  '',
  '[features]',
  'goals = true',
  '',
  '[model_providers.minar]',
  'name = "米纳尔"',
  '# base_url = "http://127.0.0.1:15722/v1"',
  'wire_api = "responses"',
  '',
  '[mcp_servers.example]',
  'command = "node"'
].join('\n');

function makeManager(dir) {
  const configPath = path.join(dir, 'config.toml');
  writeFileSync(configPath, FIXTURE, 'utf8');
  return createCodexManager({
    codex: {
      enabled: true,
      configPath,
      providerName: 'minar_route',
      providerDisplayName: '米纳尔',
      model: 'gpt-5.6-luna',
      baseUrl: 'http://127.0.0.1:15722/v1',
      wireApi: 'responses',
      authToken: 'PROXY_MANAGED'
    }
  });
}

function backupFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.minar_route.bak'));
}

test('apply adds minar_route block and comments originals, preserves everything else', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-apply-'));
  const manager = makeManager(dir);
  const result = manager.apply();
  assert.equal(result.changed, true);
  assert.ok(result.backup && existsSync(result.backup), 'backup file created');
  const out = readFileSync(path.join(dir, 'config.toml'), 'utf8');
  assert.match(out, /# minar_route_original: model_provider = "deepseek"/);
  assert.match(out, /# minar_route_original: model = "deepseek-v4-flash"/);
  assert.match(out, /\nmodel_provider = "minar_route"\n/);
  assert.match(out, /\nmodel = "gpt-5.6-luna"\n/);
  assert.match(out, /\[model_providers\.minar_route\]/);
  assert.match(out, /name = "米纳尔"/);
  assert.match(out, /base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(out, /wire_api = "responses"/);
  assert.match(out, /requires_openai_auth = true/);
  assert.match(out, /experimental_bearer_token = "PROXY_MANAGED"/);
  // 用户内容保持原样
  assert.match(out, /# 用户自己的注释，不要动/);
  assert.match(out, /model_reasoning_effort = "max"/);
  assert.match(out, /\[model_providers\.minar\]/);
  assert.match(out, /# base_url = "http:\/\/127\.0\.0\.1:15722\/v1"/);
  assert.match(out, /\[mcp_servers\.example\]/);
  assert.match(out, /command = "node"/);
  assert.equal(backupFiles(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('apply is idempotent and does not create extra backups', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-idem-'));
  const manager = makeManager(dir);
  manager.apply();
  const second = manager.apply();
  assert.equal(second.changed, false);
  assert.equal(backupFiles(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('restore via markers brings back original values and removes provider block', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-restore-'));
  const manager = makeManager(dir);
  manager.apply();
  const result = manager.restore();
  assert.equal(result.restored, true);
  assert.equal(result.method, 'marker');
  const out = readFileSync(path.join(dir, 'config.toml'), 'utf8');
  assert.match(out, /\nmodel_provider = "deepseek"\n/);
  assert.match(out, /\nmodel = "deepseek-v4-flash"\n/);
  assert.doesNotMatch(out, /minar_route/);
  assert.match(out, /# 用户自己的注释，不要动/);
  assert.match(out, /\[model_providers\.minar\]/);
  assert.match(out, /\[mcp_servers\.example\]/);
  rmSync(dir, { recursive: true, force: true });
});

test('restore without markers asks for backup, then restores on confirm', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-backup-'));
  const manager = makeManager(dir);
  manager.apply();
  const configPath = path.join(dir, 'config.toml');
  // 人为删掉注释标记，模拟无法自动还原
  const tampered = readFileSync(configPath, 'utf8')
    .replace(/^# minar_route_original: model_provider = "deepseek"$/m, '# user: model_provider = "deepseek"')
    .replace(/^# minar_route_original: model = "deepseek-v4-flash"$/m, '# user: model = "deepseek-v4-flash"');
  writeFileSync(configPath, tampered, 'utf8');

  const ask = manager.restore();
  assert.equal(ask.restored, false);
  assert.equal(ask.needsBackup, true);
  assert.ok(ask.backups.length >= 1);

  const noConfirm = manager.restore({ file: ask.backups[0].file, confirm: false });
  assert.equal(noConfirm.restored, false, 'without confirm must not restore');

  const confirmed = manager.restore({ file: ask.backups[0].file, confirm: true });
  assert.equal(confirmed.restored, true);
  assert.equal(confirmed.method, 'backup');
  assert.equal(readFileSync(configPath, 'utf8'), FIXTURE, 'backup content equals original fixture');
  rmSync(dir, { recursive: true, force: true });
});

test('status reports applied state and sanitized fields only', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-status-'));
  const manager = makeManager(dir);
  assert.equal(manager.status().applied, false);
  manager.apply();
  const s = manager.status();
  assert.equal(s.applied, true);
  assert.equal(s.activeModelProvider, '"minar_route"');
  assert.equal(s.originalModelProvider, '"deepseek"');
  assert.equal(s.originalModel, '"deepseek-v4-flash"');
  assert.equal(s.provider.displayName, '米纳尔');
  assert.equal(s.modelCatalogJsonPresent, true);
  assert.equal(s.backups.length, 1);
  assert.ok(!JSON.stringify(s).includes('sk-'), 'status must not leak bearer tokens');
  rmSync(dir, { recursive: true, force: true });
});

test('server codex endpoints apply and restore', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-http-'));
  const manager = makeManager(dir);
  const server = createRouter({
    apiKey: 'k',
    apiBaseUrl: 'https://x/v1',
    models: {},
    codex: {
      enabled: true,
      configPath: path.join(dir, 'config.toml'),
      providerName: 'minar_route',
      providerDisplayName: '米纳尔',
      model: 'gpt-5.6-luna',
      baseUrl: 'http://127.0.0.1:15722/v1',
      wireApi: 'responses',
      authToken: 'PROXY_MANAGED'
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await fetch(base + '/api/codex').then((r) => r.json());
    assert.equal(before.enabled, true);
    assert.equal(before.status.applied, false);
    const apply = await fetch(base + '/api/codex/apply', { method: 'POST' }).then((r) => r.json());
    assert.equal(apply.changed, true);
    const after = await fetch(base + '/api/codex').then((r) => r.json());
    assert.equal(after.status.applied, true);
    const restore = await fetch(base + '/api/codex/restore', { method: 'POST' }).then((r) => r.json());
    assert.equal(restore.restored, true);
    assert.equal(readFileSync(path.join(dir, 'config.toml'), 'utf8'), FIXTURE);
  } finally {
    server.closeAllConnections?.();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
