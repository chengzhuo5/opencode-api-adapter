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


export const DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);
const MULTIMODAL_FALLBACK_MODEL = 'gpt-5.6-luna';

function isImagePart(part) {
  return part
    && typeof part === 'object'
    && (part.type === 'input_image'
      || part.type === 'image_url'
      || Object.hasOwn(part, 'image_url')
      || Object.hasOwn(part, 'file_id'));
}

function itemImages(item) {
  const images = [];
  if (!item || typeof item !== 'object') return images;
  if (item.type === 'function_call_output') {
    if (Array.isArray(item.output)) {
      for (const part of item.output) if (isImagePart(part)) images.push(part);
    } else if (typeof item.output === 'string' && item.output.includes('data:image/')) {
      images.push({ type: 'input_image', image_url: item.output });
    }
  } else if (Array.isArray(item.content)) {
    for (const part of item.content) if (isImagePart(part)) images.push(part);
  }
  return images;
}

export function hasImageInput(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return false;
  let lastUserIdx = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item && typeof item === 'object' && (item.role === 'user' || (item.type === 'message' && item.role === 'user'))) {
      lastUserIdx = i;
      break;
    }
  }
  // 当前轮次 = 最后一条 user 消息之后（含该消息本身）的所有项：
  // view_image 输出图片后即使再跑了其他工具，图片仍属于本轮，应触发多模态升级。
  const start = Math.max(lastUserIdx, 0);
  for (let i = start; i < input.length; i++) {
    if (itemImages(input[i]).length > 0) return true;
  }
  // 兼容历史结构：最后一条工具输出含图也视为当前轮次
  const latestFco = [...input].reverse().find((item) => (
    item && typeof item === 'object' && item.type === 'function_call_output'
  ));
  return itemImages(latestFco).length > 0;
}

function hasFileIdInput(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some((item) => {
    if (!item || typeof item !== 'object') return false;
    return itemImages(item).some((part) => Object.hasOwn(part, 'file_id'));
  });
}

/**
 * 多模态降级优化：只保留最后一条用户消息中的图片（当前要识别的图），
 * 历史消息中的图片替换为占位文本，避免历史图片（尤其 file_id）重复消耗 token 或触发上游 403。
 * 文本历史原样保留以维持对话上下文。
 */
export function minimizeHistoryImages(input) {
  const items = Array.isArray(input) ? input : [];
  let lastUserIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && typeof item === 'object' && (item.role === 'user' || (item.type === 'message' && item.role === 'user'))) {
      lastUserIdx = i;
      break;
    }
  }
  // 当前轮次 = 最后一条 user 消息之后的所有项（含该消息本身），
  // 其中的图片（如同一轮连续多次 view_image 的对比截图）全部保留；
  // 只有更早历史轮次的图片才替换为占位。
  const currentStart = Math.max(lastUserIdx, 0);
  let removedImages = 0;
  const stripPart = (part) => {
    if (isImagePart(part)) {
      removedImages += 1;
      return { type: 'input_text', text: '[image omitted]' };
    }
    return part;
  };
  const out = items.map((item, index) => {
    if (index >= currentStart) return item;
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'function_call_output' && Array.isArray(item.output)) {
      return { ...item, output: item.output.map(stripPart) };
    }
    if (Array.isArray(item.content)) {
      return { ...item, content: item.content.map(stripPart) };
    }
    return item;
  });
  return { input: out, removedImages };
}

/**
 * 非多模态模型（如 deepseek 无图请求）：剥离 input 里所有图片（消息 content 或工具输出），
 * 避免截图 base64 以海量 token 发给不支持视觉的模型导致上下文超限。
 */
export function stripAllImages(input) {
  const items = Array.isArray(input) ? input : [];
  let removedImages = 0;
  const stripable = (part) => isImagePart(part) && !Object.hasOwn(part, 'file_id');
  const out = items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'function_call_output' && Array.isArray(item.output)) {
      const output = item.output.map((part) => {
        if (stripable(part)) {
          removedImages += 1;
          return { type: 'input_text', text: '[image omitted]' };
        }
        return part;
      });
      return { ...item, output };
    }
    if (Array.isArray(item.content)) {
      const content = item.content.map((part) => {
        if (stripable(part)) {
          removedImages += 1;
          return { type: 'input_text', text: '[image omitted]' };
        }
        return part;
      });
      return { ...item, content };
    }
    return item;
  });
  return { input: out, removedImages };
}

/**
 * 上下文截断：只保留最近 maxItems 条消息（自定义服务商上下文窗口较小时使用）。
 * 保证截断后的开头不是孤立的 function_call_output，避免上游拒绝请求。
 */
export function truncateHistory(input, maxItems) {
  const items = Array.isArray(input) ? input : [];
  if (items.length <= maxItems) return { input, removed: 0 };
  let start = items.length - maxItems;
  while (start < items.length && items[start]?.type === 'function_call_output') start += 1;
  return { input: items.slice(start), removed: start, original: items.length };
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
  let providers = Array.isArray(route.providers) && route.providers.length
    ? route.providers
    : [
        { endpoint: route.endpoint, apiKey: route.apiKey ?? config.apiKey },
        ...(route.fallbackEndpoint ? [{ endpoint: route.fallbackEndpoint, apiKey: route.fallbackApiKey ?? config.apiKey }] : [])
      ];
  if (hasFileIdInput(body) && providers.length > 1) {
    const skip = Math.min(route.customProviderCount ?? (providers.length > 1 ? 1 : 0), providers.length - 1);
    logEvent(config, {
      event: 'file_id_compat',
      model: displayModel,
      reason: 'file_id_image_routes_to_opencode',
      endpoint: providers[skip].endpoint
    });
    providers = providers.slice(skip);
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
  if (!parsed?.error?.message) {
    parsed = { ...(parsed || {}), error: { ...(parsed?.error || {}), message: `upstream ${upstream.status} ${upstream.statusText || ''}`.trim() } };
  }
  sendJson(res, upstream.status, parsed);
}

export async function pipeBody(body, res) {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
        if (res.destroyed) break;
      res.write(Buffer.from(value));
    }
      } catch (error) {
      // Upstream stream aborted mid-flight; teardown instead of bubbling up so
      // the outer catch never tries to write a second response.
      try { res.end(); } catch { /* noop */ }
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
