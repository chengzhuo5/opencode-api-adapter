import { createHash, createHmac, randomBytes } from 'node:crypto';

export const ROUTE_POLICY_VERSION = 'provider-execution-v2';
export const TRANSLATOR_VERSIONS = {
  responses: 'responses-context-v2',
  chat: 'responses-chat-v2',
  messages: 'responses-anthropic-v2'
};

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function deriveSecret(config) {
  if (config?.apiKey) {
    return createHash('sha256')
      .update('opencode-api-adapter/cache-diagnostics/v1\0')
      .update(String(config.apiKey))
      .digest();
  }
  return randomBytes(32);
}

function modelVisiblePayload(protocol, request) {
  if (protocol === 'chat') {
    return {
      model: request.model,
      messages: request.messages || [],
      tools: request.tools || [],
      tool_choice: request.tool_choice ?? null,
      parallel_tool_calls: request.parallel_tool_calls ?? null
    };
  }
  if (protocol === 'messages') {
    return {
      model: request.model,
      system: request.system ?? null,
      messages: request.messages || [],
      tools: request.tools || [],
      tool_choice: request.tool_choice ?? null
    };
  }
  return {
    model: request.model,
    instructions: request.instructions ?? null,
    input: request.input ?? [],
    tools: request.tools || [],
    tool_choice: request.tool_choice ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? null
  };
}

function toolsFor(protocol, request) {
  return protocol === 'responses' ? request.tools || [] : request.tools || [];
}

export function createCacheDiagnostics(config = {}, { secret = deriveSecret(config) } = {}) {
  const digest = (value) => createHmac('sha256', secret)
    .update(stableStringify(value))
    .digest('hex');
  return {
    request(protocol, request) {
      return {
        model_visible_prefix_hash: digest(modelVisiblePayload(protocol, request)),
        tool_schema_hash: digest(toolsFor(protocol, request)),
        route_policy_version: ROUTE_POLICY_VERSION,
        translator_version: TRANSLATOR_VERSIONS[protocol] || 'unknown'
      };
    },
    endpoint(endpoint) {
      return endpoint ? digest(String(endpoint)) : null;
    }
  };
}
