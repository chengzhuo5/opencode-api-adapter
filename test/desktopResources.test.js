import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { seedDataDir } from '../desktop/resourceSeed.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'router-desktop-assets-'));
  const assetsDir = path.join(root, 'assets');
  const dataDir = path.join(root, 'data');
  mkdirSync(path.join(assetsDir, 'admin'), { recursive: true });
  writeFileSync(path.join(assetsDir, 'admin', 'app.js'), 'new-admin');
  writeFileSync(path.join(assetsDir, 'admin', 'index.html'), 'new-index');
  writeFileSync(path.join(assetsDir, 'catalog-template.json'), '{}');
  const manifest = JSON.stringify({
    schemaVersion: 1,
    files: {
      'admin/app.js': createHash('sha256').update('new-admin').digest('hex'),
      'admin/index.html': createHash('sha256').update('new-index').digest('hex')
    }
  });
  writeFileSync(path.join(assetsDir, 'asset-manifest.json'), manifest);
  return { root, assetsDir, dataDir };
}

test('desktop resource seeding upgrades versioned admin assets without overwriting config', () => {
  const { root, assetsDir, dataDir } = fixture();
  mkdirSync(path.join(dataDir, 'admin'), { recursive: true });
  writeFileSync(path.join(dataDir, 'admin', 'app.js'), 'old-admin');
  writeFileSync(path.join(dataDir, 'admin', 'stale.js'), 'stale');
  writeFileSync(path.join(dataDir, '.admin-assets-manifest.json'), '{"version":"old"}');
  writeFileSync(path.join(dataDir, 'config.json'), '{"port":19999}');

  const configPath = seedDataDir({ assetsDir, dataDir });
  assert.equal(readFileSync(path.join(dataDir, 'admin', 'app.js'), 'utf8'), 'new-admin');
  assert.equal(existsSync(path.join(dataDir, 'admin', 'stale.js')), false);
  assert.equal(readFileSync(configPath, 'utf8'), '{"port":19999}');
  assert.equal(
    readFileSync(path.join(dataDir, '.admin-assets-manifest.json'), 'utf8'),
    readFileSync(path.join(assetsDir, 'asset-manifest.json'), 'utf8')
  );

  writeFileSync(path.join(dataDir, 'admin', 'app.js'), 'tampered');
  seedDataDir({ assetsDir, dataDir });
  assert.equal(readFileSync(path.join(dataDir, 'admin', 'app.js'), 'utf8'), 'new-admin');
  rmSync(root, { recursive: true, force: true });
});

test('desktop initial config keeps optional compression and circuit breaker disabled', () => {
  const { root, assetsDir, dataDir } = fixture();
  const configPath = seedDataDir({ assetsDir, dataDir });
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.compress.enabled, false);
  assert.equal(config.circuitBreaker.enabled, false);
  assert.equal(config.limits.maxRequestBodyBytes, 67108864);
  assert.equal(config.management.allowRemote, false);
  assert.equal(config.providerStickiness.enabled, true);
  rmSync(root, { recursive: true, force: true });
});
