import { createHash, createHmac, randomBytes } from 'node:crypto';

const DEFAULTS = {
  enabled: true,
  ttlMs: 6 * 60 * 60_000,
  maxEntries: 10_000
};

const SESSION_HEADERS = [
  'x-codex-session-id',
  'x-session-id',
  'x-conversation-id',
  'openai-conversation-id'
];

const SESSION_METADATA_FIELDS = [
  'session_id',
  'conversation_id',
  'thread_id',
  'chat_id'
];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return nonEmptyString(headers.get(name));
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return nonEmptyString(value[0]);
  return nonEmptyString(value);
}

function explicitSessionId(body, headers) {
  for (const name of SESSION_HEADERS) {
    const value = headerValue(headers, name);
    if (value) return `header:${name}:${value}`;
  }
  const direct = nonEmptyString(body?.session_id);
  if (direct) return `body:session_id:${direct}`;
  const conversation = nonEmptyString(body?.conversation)
    || nonEmptyString(body?.conversation?.id);
  if (conversation) return `body:conversation:${conversation}`;
  const promptCacheKey = nonEmptyString(body?.prompt_cache_key);
  if (promptCacheKey) return `body:prompt_cache_key:${promptCacheKey}`;
  for (const field of SESSION_METADATA_FIELDS) {
    const value = nonEmptyString(body?.metadata?.[field]);
    if (value) return `metadata:${field}:${value}`;
  }
  return null;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => !['id', 'status', 'created_at', 'outputIndex', 'output_index'].includes(key))
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function visiblePrefixAnchor(body) {
  const input = body?.input;
  if (Array.isArray(input)) {
    if (!input.length) return null;
    return {
      instructions: body.instructions ?? null,
      tools: body.tools ?? [],
      input: input.slice(0, 1)
    };
  }
  if (typeof input === 'string' && input) {
    return {
      instructions: body.instructions ?? null,
      tools: body.tools ?? [],
      input
    };
  }
  return null;
}

function normalizeConfig(config) {
  const raw = config?.providerStickiness || {};
  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    ttlMs: Number.isFinite(raw.ttlMs) && raw.ttlMs > 0 ? raw.ttlMs : DEFAULTS.ttlMs,
    maxEntries:
      Number.isInteger(raw.maxEntries) && raw.maxEntries > 0
        ? raw.maxEntries
        : DEFAULTS.maxEntries
  };
}

function deriveSecret(config) {
  if (config?.apiKey) {
    return createHash('sha256')
      .update('opencode-api-adapter/provider-affinity/v1\0')
      .update(String(config.apiKey))
      .digest();
  }
  return randomBytes(32);
}

/**
 * In-memory Provider affinity keyed by an opaque local HMAC.
 *
 * The request is never mutated. Explicit session identifiers are preferred;
 * when a client sends only full history, an append-stable leading visible
 * prefix is used as a best-effort conversation anchor.
 */
export function createProviderAffinity(config = {}, {
  now = () => Date.now(),
  secret = deriveSecret(config)
} = {}) {
  const options = normalizeConfig(config);
  const bindings = new Map();

  function keyFor(body, headers) {
    if (!options.enabled || !body?.model) return null;
    const session = explicitSessionId(body, headers);
    const source = session || (() => {
      const anchor = visiblePrefixAnchor(body);
      return anchor ? `visible-prefix:${stableStringify(anchor)}` : null;
    })();
    if (!source) return null;
    return createHmac('sha256', secret)
      .update(String(body.model))
      .update('\0')
      .update(source)
      .digest('hex');
  }

  function removeExpired() {
    const current = now();
    for (const [key, binding] of bindings) {
      if (binding.expiresAt <= current) bindings.delete(key);
    }
  }

  function apply(route, key) {
    if (!options.enabled || !key || !Array.isArray(route?.providers)) return false;
    const binding = bindings.get(key);
    if (!binding) return false;
    if (binding.expiresAt <= now()) {
      bindings.delete(key);
      return false;
    }
    const index = route.providers.findIndex((provider) => provider.endpoint === binding.endpoint);
    if (index < 0) return false;
    if (index > 0) {
      const providers = [...route.providers];
      const [preferred] = providers.splice(index, 1);
      providers.unshift(preferred);
      route.providers = providers;
    }
    route.endpoint = route.providers[0]?.endpoint ?? null;
    route.apiKey = route.providers[0]?.apiKey ?? null;
    route.fallbackEndpoint = route.providers[1]?.endpoint ?? null;
    route.fallbackApiKey = route.providers[1]?.apiKey ?? null;
    return true;
  }

  function recordSuccess(key, endpoint) {
    if (!options.enabled || !key || !endpoint) return;
    removeExpired();
    if (bindings.has(key)) bindings.delete(key);
    while (bindings.size >= options.maxEntries) {
      const oldest = bindings.keys().next().value;
      if (oldest === undefined) break;
      bindings.delete(oldest);
    }
    bindings.set(key, { endpoint, expiresAt: now() + options.ttlMs });
  }

  return {
    keyFor,
    apply,
    recordSuccess,
    size: () => bindings.size
  };
}
