import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalog, writeCatalog } from '../src/catalog.js';

const config = { apiBaseUrl: 'https://x/v1', models: {}, catalogFile: 'x.json' };
const template = { base_instructions: 'You are Codex.', context_window: 1048576 };
const meta = {
  'gpt-5.6-luna': { displayName: 'GPT 5.6 Luna', description: 'Luna', inputModalities: ['text', 'image'], contextWindow: 353000 },
  'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', description: 'Flash' }
};

test('builds catalog for routed models', () => {
  const catalog = buildCatalog(config, template, meta);
  assert.ok(catalog.models.some((m) => m.slug === 'gpt-5.6-luna'));
  assert.ok(catalog.models.some((m) => m.slug === 'deepseek-v4-flash'));
});

test('uses per-model context window from modelMeta', () => {
  const catalog = buildCatalog(config, template, meta);
  const luna = catalog.models.find((m) => m.slug === 'gpt-5.6-luna');
  const flash = catalog.models.find((m) => m.slug === 'deepseek-v4-flash');
  assert.equal(luna.context_window, 353000);
  assert.equal(luna.max_context_window, 353000);
  assert.equal(flash.context_window, 1048576, 'models without contextWindow keep template default');
});

test('model config contextWindow overrides modelMeta', () => {
  const cfg = { ...config, models: { 'gpt-5.6-luna': { contextWindow: 100000 } } };
  const catalog = buildCatalog(cfg, template, meta);
  const luna = catalog.models.find((m) => m.slug === 'gpt-5.6-luna');
  assert.equal(luna.context_window, 100000);
  assert.equal(luna.max_context_window, 100000);
});

test('writes catalog file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-catalog-'));
  const file = path.join(dir, 'catalog.json');
  writeCatalog({ ...config, catalogFile: file }, buildCatalog(config, template, meta));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(parsed.models.length > 0);
  rmSync(dir, { recursive: true, force: true });
});
