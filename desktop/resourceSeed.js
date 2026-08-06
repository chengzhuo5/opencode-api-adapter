import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const INSTALLED_ADMIN_MANIFEST = '.admin-assets-manifest.json';

export function seedDataDir({ assetsDir, dataDir }) {
  if (!assetsDir || !dataDir) throw new Error('assetsDir and dataDir are required');
  fs.mkdirSync(dataDir, { recursive: true });
  syncAdminAssets({ assetsDir, dataDir });

  const templateTarget = path.join(dataDir, 'catalog-template.json');
  if (!fs.existsSync(templateTarget)) {
    fs.copyFileSync(path.join(assetsDir, 'catalog-template.json'), templateTarget);
  }

  const configTarget = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configTarget)) {
    fs.writeFileSync(
      configTarget,
      JSON.stringify(defaultDesktopConfig(dataDir), null, 2),
      'utf8'
    );
  }
  return configTarget;
}

export function defaultDesktopConfig(dataDir) {
  return {
    host: '127.0.0.1',
    port: 15722,
    apiBaseUrl: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    catalogFile: path.join(dataDir, 'catalog.json'),
    timeouts: { requestMs: 600000, streamIdleMs: 180000 },
    limits: { maxRequestBodyBytes: 67108864, requestBodyIdleMs: 120000 },
    management: {
      allowRemote: false,
      tokenEnv: 'CODEX_ROUTER_ADMIN_TOKEN',
      trustedOrigins: []
    },
    models: {},
    modelPatterns: {
      'gpt-*': {
        upstream: 'responses',
        endpoint: 'https://ergouapi.com/v1',
        apiKeyEnv: 'ERGOUAPI_API_KEY',
        maxHistoryMessages: 10,
        contextWindow: 353000
      }
    },
    usageLog: {
      enabled: true,
      file: path.join(dataDir, 'usage', 'requests.jsonl'),
      flushDelayMs: 10
    },
    providerStickiness: {
      enabled: true,
      ttlMs: 21600000,
      maxEntries: 10000
    },
    compress: {
      enabled: false,
      backend: 'lean-ctx',
      baseUrl: 'http://127.0.0.1:4444',
      token: '',
      storeDir: path.join(dataDir, 'ctx-store'),
      cacheSize: 1000,
      minOutputTokens: 2048,
      timeoutMs: 30000,
      logLevel: 'verbose'
    },
    healthCheck: { enabled: true, intervalMs: 300000, timeoutMs: 20000 },
    circuitBreaker: {
      enabled: false,
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 60000,
      errorRateThreshold: 0.6,
      minRequests: 5
    }
  };
}

export function syncAdminAssets({ assetsDir, dataDir }) {
  const sourceDir = path.join(assetsDir, 'admin');
  const targetDir = path.join(dataDir, 'admin');
  const sourceManifest = readIfExists(path.join(assetsDir, 'asset-manifest.json'));
  const installedManifestPath = path.join(dataDir, INSTALLED_ADMIN_MANIFEST);
  const installedManifest = readIfExists(installedManifestPath);
  if (
    fs.existsSync(targetDir)
    && sourceManifest
    && sourceManifest === installedManifest
    && adminAssetsCurrent(sourceManifest, dataDir)
  ) {
    return false;
  }

  syncDir(sourceDir, targetDir);
  if (sourceManifest) {
    const pending = `${installedManifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(pending, sourceManifest, 'utf8');
    fs.rmSync(installedManifestPath, { force: true });
    fs.renameSync(pending, installedManifestPath);
  }
  return true;
}

function syncDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const sourceNames = new Set();
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    sourceNames.add(entry.name);
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(dst) && !fs.statSync(dst).isDirectory()) {
        fs.rmSync(dst, { force: true });
      }
      syncDir(src, dst);
    } else {
      if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) {
        fs.rmSync(dst, { recursive: true, force: true });
      }
      fs.copyFileSync(src, dst);
    }
  }
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue;
    fs.rmSync(path.join(to, entry.name), {
      recursive: entry.isDirectory(),
      force: true
    });
  }
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function adminAssetsCurrent(manifestText, dataDir) {
  try {
    const manifest = JSON.parse(manifestText);
    const adminFiles = Object.entries(manifest.files || {})
      .filter(([relative]) => relative.startsWith('admin/'));
    if (adminFiles.length === 0) return false;
    return adminFiles.every(([relative, expectedHash]) => {
      const file = path.join(dataDir, ...relative.split('/'));
      return fs.existsSync(file)
        && fs.statSync(file).isFile()
        && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expectedHash;
    });
  } catch {
    return false;
  }
}
