import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 15721,
  apiBaseUrl: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  catalogFile: 'catalog.json',
  timeouts: { requestMs: 600000, streamIdleMs: 180000 },
  models: {},
  nonStreamingUpstream: false,
  compress: {
    enabled: true,
    backend: 'lean-ctx',
    baseUrl: undefined,
    token: '',
    storeDir: 'ctx-store',
    cacheSize: 1000,
    timeoutMs: 30000,
    logLevel: 'verbose'
  }
};

export function loadConfig({ configPath = 'config.json', env = process.env, cwd = process.cwd() } = {}) {
  const abs = path.resolve(cwd, configPath);
  if (!existsSync(abs)) throw new Error(`config file not found: ${abs}`);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...(raw.timeouts || {}) },
    models: raw.models || {},
    compress: { ...DEFAULT_CONFIG.compress, ...(raw.compress || {}) }
  };
  const apiKey = env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`missing ${config.apiKeyEnv} environment variable`);
  const normalizeEndpoint = (endpoint, defaultKey) => {
    const mapOne = (item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return { ...item, apiKey: item.apiKeyEnv ? env[item.apiKeyEnv] : defaultKey };
      }
      return item;
    };
    if (Array.isArray(endpoint)) return endpoint.map(mapOne);
    return mapOne(endpoint);
  };
  const models = {};
  for (const [id, entry] of Object.entries(config.models || {})) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const entryKey = entry.apiKeyEnv ? env[entry.apiKeyEnv] : apiKey;
      models[id] = { ...entry, apiKey: entryKey, endpoint: normalizeEndpoint(entry.endpoint, entryKey) };
    } else {
      models[id] = entry;
    }
  }
  return { ...config, apiKey, models, apiBaseUrl: normalizeEndpoint(config.apiBaseUrl, apiKey) };
}
