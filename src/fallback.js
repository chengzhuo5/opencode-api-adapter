import { responsesToChatRequest } from './translate/responsesToChat.js';
import { chatToResponsesObject, translateChatStreamToResponses } from './translate/chatToResponses.js';
import { normalizeResponsesRequest } from './translate/responsesContext.js';
import { sseEncode } from './sse.js';
import { logEvent } from './logger.js';

const unsupportedResponses = new Set();
const unsupportedNotified = new Set();
const UNSUPPORTED_STATUSES = new Set([400, 404, 405]);

export function clearUnsupportedCache() {
  unsupportedResponses.clear();
  unsupportedNotified.clear();
}


const DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);
const MULTIMODAL_FALLBACK_MODEL = 'gpt-5.6-luna';

export function hasImageInput(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return false;
  const latestUser = [...input].reverse().find((item) => (
    item
    && typeof item === 'object'
    && (item.role === 'user' || (item.type === 'message' && item.role === 'user'))
  ));
  const content = latestUser?.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    return part.type === 'input_image'
      || part.type === 'image_url'
      || Object.hasOwn(part, 'image_url')
      || Object.hasOwn(part, 'file_id');
  });
}

function hasFileIdInput(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const content = Array.isArray(item.content) ? item.content : [];
    return content.some((part) => (
      part
      && typeof part === 'object'
      && (part.type === 'input_image' || part.type === 'image_url')
      && Object.hasOwn(part, 'file_id')
    ));
  });
}

export function maybeUpgradeModel(body) {
  if (!body || !DEEPSEEK_MODELS.has(body.model)) return body;
  if (!hasImageInput(body)) return body;
  return { ...body, model: MULTIMODAL_FALLBACK_MODEL };
}


export async function forwardWithFallback(res, body, route, config, fetchImpl, displayModel = body.model) {
  if (unsupportedResponses.has(body.model)) {
    if (!unsupportedNotified.has(body.model)) {
      unsupportedNotified.add(body.model);
      logEvent(config, {
        event: 'api_fallback',
        model: displayModel,
        reason: 'responses_unsupported',
        primary_endpoint: endpointName(route.endpoint),
        primary_url: route.endpoint,
        fallback_endpoint: 'chat/completions'
      });
    }
    await forwardChat(res, body, config, fetchImpl, displayModel);
    return;
  }
  let providers = [
    { endpoint: route.endpoint, apiKey: route.apiKey ?? config.apiKey },
    ...(route.fallbackEndpoint ? [{ endpoint: route.fallbackEndpoint, apiKey: route.fallbackApiKey ?? config.apiKey }] : [])
  ];
  if (hasFileIdInput(body) && providers.length > 1) {
    logEvent(config, {
      event: 'file_id_compat',
      model: displayModel,
      reason: 'file_id_image_routes_to_opencode',
      endpoint: providers[1].endpoint
    });
    providers = [providers[1]];
  }
  const requestBody = normalizeResponsesRequest(body);
  const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` };
    const lastProvider = i === providers.length - 1;
    let upstream;
    try {
      upstream = await fetchImpl(provider.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal });
    } catch {
      logEvent(config, {
        event: 'api_fallback',
        model: displayModel,
        reason: 'network_error',
        primary_endpoint: endpointName(provider.endpoint),
        primary_url: provider.endpoint,
        fallback_endpoint: lastProvider ? 'chat/completions' : endpointName(providers[i + 1].endpoint)
      });
      if (lastProvider) {
        await forwardChat(res, body, config, fetchImpl, displayModel);
        return;
      }
      continue;
    }
    if (upstream.ok) {
      await relayUpstream(res, upstream);
      return;
    }
    if (lastProvider && UNSUPPORTED_STATUSES.has(upstream.status)) {
      unsupportedResponses.add(body.model);
    }
    logEvent(config, {
      event: 'api_fallback',
      model: displayModel,
      reason: 'http_error',
      primary_endpoint: endpointName(provider.endpoint),
      primary_url: provider.endpoint,
      primary_status: upstream.status,
      fallback_endpoint: lastProvider ? 'chat/completions' : endpointName(providers[i + 1].endpoint)
    });
    if (lastProvider) {
      await forwardChat(res, body, config, fetchImpl, displayModel);
      return;
    }
  }
}

async function forwardChat(res, body, config, fetchImpl, displayModel) {
  const chatBody = responsesToChatRequest(body);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
  const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
  const endpoint = `${config.apiBaseUrl}/chat/completions`;
  let upstream;
  try {
    upstream = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(chatBody), signal });
  } catch (error) {
    logEvent(config, {
      event: 'api_fallback_result',
      model: displayModel,
      success: false,
      status: 502,
      fallback_endpoint: 'chat/completions',
      fallback_url: endpoint,
      reason: 'network_error'
    });
    sendJson(res, 502, { error: { message: error.message || 'chat fallback failed' } });
    return;
  }
  if (!upstream.ok) {
    logEvent(config, {
      event: 'api_fallback_result',
      model: displayModel,
      success: false,
      status: upstream.status,
      fallback_endpoint: 'chat/completions',
      fallback_url: endpoint,
      reason: 'http_error'
    });
    await relayError(res, upstream);
    return;
  }
  logEvent(config, {
    event: 'api_fallback_result',
    model: displayModel,
    success: true,
    status: upstream.status,
    fallback_endpoint: 'chat/completions',
    fallback_url: endpoint
  });
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await translateChatStreamToResponses(upstream.body, displayModel, (event, data) => res.write(sseEncode(event, data)));
    res.end();
    return;
  }
  const chat = await upstream.json();
  sendJson(res, upstream.status, chatToResponsesObject(chat, displayModel));
}

export async function relayUpstream(res, upstream) {
  if (!upstream.ok) {
    await relayError(res, upstream);
    return;
  }
  const contentType = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, { 'content-type': contentType });
  await pipeBody(upstream.body, res);
  res.end();
}

export async function relayError(res, upstream) {
  const text = await upstream.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: { message: text.slice(0, 500) } }; }
  sendJson(res, upstream.status, parsed);
}

export async function pipeBody(body, res) {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function endpointName(endpoint) {
  return endpoint.split('/').pop() || endpoint;
}
