export const DEFAULT_MODEL_ROUTES = {
  'gpt-5.6-luna': 'responses',
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

export function resolveRoute(config, model) {
  const entry = config.models?.[model];
  const upstream = entry?.upstream ?? DEFAULT_MODEL_ROUTES[model];
  if (!upstream) throw new UnknownModelError(model);
  const effective = upstream === 'messages' ? 'messages' : 'responses';
  const suffix = effective === 'messages' ? 'messages' : 'responses';
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
  const providers = [
    ...customBases.map((base) => toProvider(base, entry?.apiKey ?? config.apiKey)),
    ...globalBases.map((base) => toProvider(base, config.apiKey))
  ];
  const seen = new Set();
  const unique = providers.filter((p) => {
    if (seen.has(p.endpoint)) return false;
    seen.add(p.endpoint);
    return true;
  });
  return {
    model,
    upstream: effective,
    endpoint: unique[0]?.endpoint,
    apiKey: unique[0]?.apiKey,
    fallbackEndpoint: unique[1]?.endpoint ?? null,
    fallbackApiKey: unique[1]?.apiKey ?? null,
    providers: unique,
    customProviderCount: customBases.length
  };
}

export function listRoutedModels(config) {
  const ids = new Set([...Object.keys(DEFAULT_MODEL_ROUTES), ...Object.keys(config.models || {})]);
  return [...ids].filter((id) => {
    const upstream = config.models?.[id]?.upstream ?? DEFAULT_MODEL_ROUTES[id];
    return upstream === 'responses' || upstream === 'chat' || upstream === 'messages';
  });
}
