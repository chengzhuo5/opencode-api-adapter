import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 15721,
  apiBaseUrl: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  catalogFile: 'catalog.json',
  timeouts: { requestMs: 600000, streamIdleMs: 180000 },
  models: {},
  nonStreamingUpstream: false,
  healthCheck: {
    enabled: false,
    intervalMs: 300000,
    timeoutMs: 20000
  },
  circuitBreaker: {
    enabled: false,
    failureThreshold: 3,
    successThreshold: 2,
    timeoutMs: 60000,
    errorRateThreshold: 0.6,
    minRequests: 5
  },
  usageLog: {
    enabled: false,
    file: 'usage/requests.jsonl'
  },
  codex: {
    enabled: false,
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    providerName: 'minar_route',
    providerDisplayName: '米纳尔',
    model: 'gpt-5.6-luna',
    baseUrl: 'http://127.0.0.1:15722/v1',
    wireApi: 'responses',
    authToken: 'PROXY_MANAGED'
  },
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
    modelPatterns: raw.modelPatterns || {},
    compress: { ...DEFAULT_CONFIG.compress, ...(raw.compress || {}) },
    healthCheck: { ...DEFAULT_CONFIG.healthCheck, ...(raw.healthCheck || {}) },
    circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, ...(raw.circuitBreaker || {}) },
    usageLog: { ...DEFAULT_CONFIG.usageLog, ...(raw.usageLog || {}) },
    codex: { ...DEFAULT_CONFIG.codex, ...(raw.codex || {}) }
  };
  const requireEnv = (name, context) => {
    const value = env[name];
    if (!value) throw new Error(`missing ${name} environment variable for ${context}`);
    return value;
  };
  const apiKey = requireEnv(config.apiKeyEnv, 'apiBaseUrl');
  const normalizeEndpoint = (endpoint, defaultKey, context) => {
    const mapOne = (item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return {
          ...item,
          apiKey: item.apiKeyEnv
            ? requireEnv(item.apiKeyEnv, context)
            : defaultKey
        };
      }
      return item;
    };
    if (Array.isArray(endpoint)) return endpoint.map(mapOne);
    return mapOne(endpoint);
  };
  const models = {};
  for (const [id, entry] of Object.entries(config.models || {})) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const entryKey = entry.apiKeyEnv
        ? requireEnv(entry.apiKeyEnv, `model ${id}`)
        : apiKey;
      models[id] = {
        ...entry,
        apiKey: entryKey,
        endpoint: normalizeEndpoint(entry.endpoint, entryKey, `model ${id} endpoint`)
      };
    } else {
      models[id] = entry;
    }
  }
  const modelPatterns = {};
  for (const [pattern, entry] of Object.entries(config.modelPatterns || {})) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const entryKey = entry.apiKeyEnv
        ? requireEnv(entry.apiKeyEnv, `model pattern ${pattern}`)
        : apiKey;
      modelPatterns[pattern] = {
        ...entry,
        apiKey: entryKey,
        endpoint: normalizeEndpoint(entry.endpoint, entryKey, `model pattern ${pattern} endpoint`)
      };
    } else {
      modelPatterns[pattern] = entry;
    }
  }
  return {
    ...config,
    apiKey,
    models,
    modelPatterns,
    apiBaseUrl: normalizeEndpoint(config.apiBaseUrl, apiKey, 'apiBaseUrl')
  };
}
