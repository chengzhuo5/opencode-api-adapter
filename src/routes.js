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
  const effective = upstream === 'messages' ? 'messages' : upstream === 'chat' ? 'chat' : 'responses';
  const suffix = effective === 'messages' ? 'messages' : effective === 'chat' ? 'chat/completions' : 'responses';
  const toBases = (value) => (Array.isArray(value) ? value : [value]).filter((v) => (
    (typeof v === 'string' && v) || (v && typeof v === 'object' && typeof v.url === 'string' && v.url)
  ));
  const customBases = toBases(entry?.endpoint);
  const globalBases = toBases(config.apiBaseUrl);
  const toProvider = (base, defaultKey) => (
    typeof base === 'object'
      ? { endpoint: `${base.url}/${suffix}`, apiKey: base.apiKey ?? defaultKey }
      : { endpoint: `${base}/${suffix}`, apiKey: defaultKey }
  );
  // 自定义 provider（模型级 endpoint）存在时不再追加全局 apiBaseUrl：
  // 有模型级端点说明用户已为该模型指定服务商，opencode 全局兜底不适用
  // （例如 gpt-5.6-sol 只存在于 ergou，opencode 不支持，fallback 过去只会 401）。
  const providers = customBases.length > 0
    ? customBases.map((base) => toProvider(base, entry?.apiKey ?? config.apiKey))
    : globalBases.map((base) => toProvider(base, config.apiKey));
  const seen = new Set();
  const unique = providers.filter((p) => {
    if (seen.has(p.endpoint)) return false;
    seen.add(p.endpoint);
    return true;
  });
  return {
    model,
    upstream: effective,
    entry,
    endpoint: unique[0]?.endpoint,
    apiKey: unique[0]?.apiKey,
    fallbackEndpoint: unique[1]?.endpoint ?? null,
    fallbackApiKey: unique[1]?.apiKey ?? null,
    providers: unique,
    customProviderCount: customBases.length
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
