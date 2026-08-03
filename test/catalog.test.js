import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalog, writeCatalog } from '../src/catalog.js';

const config = { apiBaseUrl: 'https://x/v1', models: {}, catalogFile: 'x.json' };
const template = { base_instructions: 'You are Codex.', context_window: 1048576 };
const meta = {
  'gpt-5.6-luna': { displayName: 'GPT 5.6 Luna', description: 'Luna', inputModalities: ['text', 'image'] },
  'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', description: 'Flash' }
};

test('builds catalog for routed models', () => {
  const catalog = buildCatalog(config, template, meta);
  assert.ok(catalog.models.some((m) => m.slug === 'gpt-5.6-luna'));
  assert.ok(catalog.models.some((m) => m.slug === 'deepseek-v4-flash'));
});

test('writes catalog file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-catalog-'));
  const file = path.join(dir, 'catalog.json');
  writeCatalog({ ...config, catalogFile: file }, buildCatalog(config, template, meta));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(parsed.models.length > 0);
  rmSync(dir, { recursive: true, force: true });
});
