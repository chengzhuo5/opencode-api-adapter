import { MODEL_META } from './modelMeta.js';

export const DEFAULT_MODEL_ROUTES = {
  'gpt-5.4-mini': 'responses',
  'gpt-5.4': 'responses',
  'gpt-5.5': 'responses',
  'gpt-5.6-terra': 'responses',
  'gpt-5.6-luna': 'responses',
  'gpt-5.6-sol': 'responses',
  'grok-4.5': 'responses',
  'glm-5.2': 'responses',
  'glm-5.1': 'responses',
  'kimi-k3': 'responses',
  'kimi-k2.7-code': 'responses',
  'kimi-k2.6': 'responses',
  'deepseek-v4-pro': 'responses',
  'deepseek-v4-flash': 'responses',
  'mimo-v2.5': 'responses',
  'mimo-v2.5-pro': 'responses',
  'hy3': 'responses',
  'minimax-m3': 'messages',
  'minimax-m2.7': 'messages',
  'minimax-m2.5': 'messages',
  'qwen3.7-max': 'messages',
  'qwen3.7-plus': 'messages',
  'qwen3.6-plus': 'messages'
};

export class UnknownModelError extends Error {
  constructor(model) {
    super(`unknown model: ${model}`);
    this.name = 'UnknownModelError';
    this.model = model;
  }
}

export class RouteConfigurationError extends Error {
  constructor(message, model) {
    super(message);
    this.name = 'RouteConfigurationError';
    this.model = model;
    this.statusCode = 503;
  }
}

const VALID_UPSTREAMS = new Set(['responses', 'chat', 'messages']);
const PROTOCOL_SUFFIXES = ['/chat/completions', '/responses', '/messages'];

export function buildProtocolEndpoint(base, suffix) {
  const raw = typeof base === 'object' && base !== null ? base.url : base;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RouteConfigurationError(`invalid provider URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RouteConfigurationError(`unsupported provider URL protocol: ${url.protocol}`);
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  const existingSuffix = PROTOCOL_SUFFIXES.find((candidate) => pathname.endsWith(candidate));
  if (existingSuffix) pathname = pathname.slice(0, -existingSuffix.length);
  url.pathname = `${pathname.replace(/\/+$/, '')}/${suffix}`.replace(/\/{2,}/g, '/');
  return url.toString();
}

export function resolveProviders(value, suffix, defaultKey) {
  const bases = Array.isArray(value) ? value : [value];
  const providers = [];
  const seen = new Set();
  for (const base of bases) {
    const endpoint = buildProtocolEndpoint(base, suffix);
    if (!endpoint) continue;
    const apiKey = typeof base === 'object' && base !== null
      ? base.apiKey ?? defaultKey
      : defaultKey;
    const identity = `${endpoint}\0${apiKey ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    providers.push({ endpoint, apiKey });
  }
  return providers;
}

/**
 * 通配符匹配（`*` 匹配任意串，`?` 匹配单字符），返回匹配到的 pattern 键。
 * 多个 pattern 命中时取更具体的（pattern 字符串更长者优先）。
 */
export function matchModelPattern(config, model) {
  const patterns = Object.keys(config?.modelPatterns || {});
  if (!patterns.length || typeof model !== 'string') return null;
  const candidates = patterns
    .filter((pattern) => {
      const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return re.test(model);
    })
    .sort((a, b) => b.length - a.length);
  return candidates[0] || null;
}

/** 获取模型生效配置：精确 models 条目 > modelPatterns 通配 > 空对象。 */
export function getModelEntry(config, model) {
  if (config?.models?.[model]) return config.models[model];
  const pattern = matchModelPattern(config, model);
  if (pattern) return config.modelPatterns[pattern];
  return {};
}

export function resolveRoute(config, model) {
  const entry = getModelEntry(config, model);
  const upstream = entry?.upstream ?? DEFAULT_MODEL_ROUTES[model];
  if (!upstream) throw new UnknownModelError(model);
  if (!VALID_UPSTREAMS.has(upstream)) {
    throw new RouteConfigurationError(`invalid upstream "${upstream}" for model ${model}`, model);
  }
  const effective = upstream;
  const suffix = effective === 'messages' ? 'messages' : effective === 'chat' ? 'chat/completions' : 'responses';
  const customProviders = resolveProviders(entry?.endpoint, suffix, entry?.apiKey ?? config.apiKey);
  const globalProviders = resolveProviders(config.apiBaseUrl, suffix, config.apiKey);
  // 自定义 provider（模型级 endpoint）存在时不再追加全局 apiBaseUrl：
  // 有模型级端点说明用户已为该模型指定服务商，opencode 全局兜底不适用
  // （例如 gpt-5.6-sol 只存在于 ergou，opencode 不支持，fallback 过去只会 401）。
  const providers = customProviders.length > 0 ? customProviders : globalProviders;
  if (!providers.length) {
    throw new RouteConfigurationError(`no provider configured for model ${model}`, model);
  }
  return {
    model,
    upstream: effective,
    entry,
    endpoint: providers[0].endpoint,
    apiKey: providers[0].apiKey,
    fallbackEndpoint: providers[1]?.endpoint ?? null,
    fallbackApiKey: providers[1]?.apiKey ?? null,
    providers,
    customProviderCount: customProviders.length
  };
}

export function listRoutedModels(config) {
  const ids = new Set([
    ...Object.keys(DEFAULT_MODEL_ROUTES),
    ...Object.keys(config.models || {}),
    ...Object.keys(MODEL_META)
  ]);
  return [...ids].filter((id) => {
    const upstream = config.models?.[id]?.upstream ?? DEFAULT_MODEL_ROUTES[id];
    return upstream === 'responses' || upstream === 'chat' || upstream === 'messages';
  });
}
