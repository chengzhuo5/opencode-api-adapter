import { randomUUID } from 'node:crypto';
import { responsesToChatRequest } from './translate/responsesToChat.js';
import { chatToResponsesObject, translateChatStreamToResponses } from './translate/chatToResponses.js';
import { normalizeResponsesRequest } from './translate/responsesContext.js';
import { parseSseEvent, sseEncode } from './sse.js';
import { replayResponsesAsSse } from './translate/responsesReplay.js';
import { logEvent } from './logger.js';
import { extractUsage } from './usageLog.js';

const unsupportedResponses = new Set();
const unsupportedNotified = new Set();
const UNSUPPORTED_STATUSES = new Set([400, 404, 405]);

/** 是否存在可用的全局 chat 兜底（apiBaseUrl 配置且非空）。 */
function hasChatFallback(config) {
  const base = config?.apiBaseUrl;
  if (Array.isArray(base)) return base.some((b) => (typeof b === 'string' ? b : b?.url));
  return Boolean(base);
}

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


export async function forwardWithFallback(res, body, route, config, fetchImpl, displayModel = body.model, options = {}) {
  const breaker = options.breaker || null;
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
    if (hasChatFallback(config)) {
      await forwardChat(res, body, config, fetchImpl, displayModel, options);
    } else {
      sendJson(res, 502, { error: { message: `${body.model} responses unsupported and no chat fallback configured` } });
    }
    return;
  }
  let providers = Array.isArray(route.providers) && route.providers.length
    ? route.providers
    : [
        { endpoint: route.endpoint, apiKey: route.apiKey ?? config.apiKey },
        ...(route.fallbackEndpoint ? [{ endpoint: route.fallbackEndpoint, apiKey: route.fallbackApiKey ?? config.apiKey }] : [])
      ];
  // file_id 图片只在“自定义 provider 之外还存在全局 provider”时才跳过自定义端：
  // 模型已明确指定服务商（如 gpt-* → ergou）时不再试图绕到全局 opencode。
  const customCount = route.customProviderCount ?? 0;
  if (hasFileIdInput(body) && customCount > 0 && providers.length > customCount) {
    const skip = Math.min(customCount, providers.length - 1);
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
    const lastProvider = i === providers.length - 1;
    const breakerKey = breaker ? breaker.keyOf(displayModel, provider.endpoint) : null;
    const permit = breaker ? breaker.allow(breakerKey) : { allowed: true, usedHalfOpenPermit: false };
    if (!permit.allowed) {
      logEvent(config, {
        event: 'circuit_skip',
        model: displayModel,
        endpoint: provider.endpoint,
        fallback_endpoint: lastProvider ? 'chat/completions' : endpointName(providers[i + 1].endpoint)
      });
      if (lastProvider) {
        if (hasChatFallback(config)) {
          await forwardChat(res, body, config, fetchImpl, displayModel, options);
        } else {
          sendJson(res, 502, { error: { message: `all providers skipped and no chat fallback configured for ${displayModel}` } });
        }
        return;
      }
      continue;
    }
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` };
    let upstream;
    try {
      upstream = await fetchImpl(provider.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal });
    } catch {
      breaker?.recordFailure(breakerKey, permit.usedHalfOpenPermit);
      options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: 502, error: 'network_error' });
      logEvent(config, {
        event: 'api_fallback',
        model: displayModel,
        reason: 'network_error',
        primary_endpoint: endpointName(provider.endpoint),
        primary_url: provider.endpoint,
        fallback_endpoint: lastProvider ? 'chat/completions' : endpointName(providers[i + 1].endpoint)
      });
      if (lastProvider) {
        if (hasChatFallback(config)) {
          await forwardChat(res, body, config, fetchImpl, displayModel, options);
        } else {
          sendJson(res, 502, { error: { message: `upstream network error and no chat fallback configured for ${displayModel}` } });
        }
        return;
      }
      continue;
    }
    if (upstream.ok) {
      let relayOk = true;
      let lastUsage = null;
      try {
        if (options.replay) {
          relayOk = await relayNonStreamingResponse(res, upstream, displayModel, (u) => { lastUsage = u; });
        } else if (options.streamRetryFallback ?? true) {
          relayOk = await relayUpstreamSmart(res, upstream, body, config, fetchImpl, displayModel, provider, (u) => { lastUsage = u; });
        } else {
          relayOk = await relayUpstream(res, upstream, (u) => { lastUsage = u; });
        }
      } catch (error) {
        relayOk = false;
        logEvent(config, {
          event: 'relay_error',
          model: displayModel,
          endpoint: provider.endpoint,
          reason: String(error?.message || 'relay error').slice(0, 200)
        });
        try { res.end(); } catch { /* noop */ }
      }
      if (relayOk) breaker?.recordSuccess(breakerKey, permit.usedHalfOpenPermit);
      else breaker?.recordFailure(breakerKey, permit.usedHalfOpenPermit);
      options.tracker?.record({
        endpoint: provider.endpoint,
        ok: relayOk,
        status: 200,
        usage: lastUsage,
        error: relayOk ? undefined : 'stream_interrupted'
      });
      return;
    }
    breaker?.recordFailure(breakerKey, permit.usedHalfOpenPermit);
    options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: upstream.status, error: 'http_error' });
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
      if (hasChatFallback(config)) {
        await forwardChat(res, body, config, fetchImpl, displayModel, options);
      } else {
        await relayError(res, upstream);
      }
      return;
    }
  }
}

async function forwardChat(res, body, config, fetchImpl, displayModel, options = {}) {
  if (!hasChatFallback(config)) {
    sendJson(res, 502, { error: { message: `chat fallback not configured for ${displayModel}` } });
    return;
  }
  const chatBody = responsesToChatRequest(body);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
  const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
  const endpoint = `${config.apiBaseUrl}/chat/completions`;
  let upstream;
  try {
    upstream = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(chatBody), signal });
  } catch (error) {
    options.tracker?.record({ endpoint, ok: false, status: 502, error: 'network_error' });
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
    options.tracker?.record({ endpoint, ok: false, status: upstream.status, error: 'http_error' });
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
    let usage = null;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await translateChatStreamToResponses(upstream.body, displayModel, (event, data) => {
      if (event === 'response.completed' && data?.response) {
        const u = extractUsage(data.response);
        if (u) usage = u;
      }
      res.write(sseEncode(event, data));
    });
    res.end();
    options.tracker?.record({ endpoint, ok: true, status: upstream.status, usage });
    return;
  }
  const chat = await upstream.json();
  const usage = extractUsage(chat);
  if (options.replay) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    replayResponsesAsSse(chatToResponsesObject(chat, displayModel), (event, data) => res.write(sseEncode(event, data)));
    res.end();
    options.tracker?.record({ endpoint, ok: true, status: upstream.status, usage });
    return;
  }
  sendJson(res, upstream.status, chatToResponsesObject(chat, displayModel));
  options.tracker?.record({ endpoint, ok: true, status: upstream.status, usage });
}

const RESPONSE_STATUS_FOR_EVENT = {
  'response.created': 'in_progress',
  'response.in_progress': 'in_progress',
  'response.completed': 'completed',
  'response.failed': 'failed'
};

/**
 * Responses 直通路径的响应可能缺失 Codex 客户端要求的顶层字段（例如部分网关只
 * 返回 id/model/usage，导致客户端解析 response.completed 报 missing field
 * input_tokens）。这里补齐顶层字段，已有字段保持不变。
 */
export function normalizeResponsesObject(resp, fallbackStatus) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return resp;
  const usage = resp.usage || {};
  const out = { ...resp };
  if (out.object === undefined) out.object = 'response';
  if (out.created_at === undefined) out.created_at = Math.floor(Date.now() / 1000);
  if (out.status === undefined) out.status = fallbackStatus || 'completed';
  if (out.input_tokens === undefined) out.input_tokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  if (out.output_tokens === undefined) out.output_tokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (out.output === undefined) out.output = [];
  if (out.error === undefined) out.error = null;
  if (out.incomplete_details === undefined) out.incomplete_details = null;
  return out;
}

async function parseNonStreamingResponse(upstream, displayModel) {
  const text = await upstream.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && (parsed.object === 'response' || (parsed.id && parsed.model))) {
      return normalizeResponsesObject(parsed, 'completed');
    }
  } catch {
    return null;
  }
  return normalizeResponsesObject({
    id: 'resp_' + randomUUID().replace(/-/g, ''),
    status: 'failed',
    error: { code: 'upstream_response', message: 'upstream returned a non-response payload' }
  }, 'failed');
}

async function relayNonStreamingResponse(res, upstream, displayModel, onUsage) {
  const response = await parseNonStreamingResponse(upstream, displayModel);
  if (!response) {
    sendJson(res, 502, { error: { message: 'upstream returned non-JSON response' } });
    return false;
  }
  const usage = extractUsage(response);
  if (usage) onUsage?.(usage);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  replayResponsesAsSse(response, (event, data) => res.write(sseEncode(event, data)));
  res.end();
  return true;
}

/**
 * 方案 3（流式优先 + 断流自动降级）：先尝试流式转发；若上游流在首个事件前
 * 就断开（此时尚未向 Codex 写任何字节），自动改用非流式请求重试，拿到完整
 * JSON 后回放为 SSE。流开始转发后中断则补发完整 failed（由
 * pipeSseWithNormalization 处理）。
 */
/**
 * 方案 3（流式优先 + 断流/首事件超时自动降级）：
 * - 先向 Codex 写 SSE 头，等待上游真实事件期间持续发送 keep-alive，
 *   避免 Codex 因长时间无字节判定 stream disconnected；
 * - 上游可能先发纯注释行（: keep-alive），这些不算真实事件，跳过；
 * - 等待真实事件超时（streamIdleMs，默认 180s，与 Codex 空闲窗口一致）
 *   后取消流式，改发 stream:false 重试；拿到完整 JSON 后补全字段并回放
 *   为 SSE；重试也失败则补发字段完整的 response.failed。
 */
export async function relayUpstreamSmart(res, upstream, body, config, fetchImpl, displayModel, provider, onUsage) {
  const contentType = upstream.headers.get('content-type') || 'application/json';
  if (!contentType.includes('text/event-stream')) {
    return relayUpstream(res, upstream, onUsage);
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const keepAlive = startKeepAlive(res);
  // 最长等待真实首事件的时间。期间路由持续向 Codex 发 keep-alive，客户端不会
  // 因空闲判定断流；上游流仍活着（keep-alive 注释）就继续等，EOF/错误才兜底。
  const firstTimeoutMs = Math.max(30000, config.timeouts?.streamIdleMs || 180000);
  let buffer = '';
  let firstSeenAt = null;
  try {
    const deadline = Date.now() + firstTimeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timedout: true }), remaining))
      ]);
      if (done) break;
      if (value && value.length) {
        buffer += decoder.decode(value, { stream: true });
        // 纯注释行（: keep-alive）不算真实事件，继续等
        if (buffer.split('\n\n').some((part) => part.trim() && !part.trimStart().startsWith(':'))) {
          firstSeenAt = Date.now();
          break;
        }
      }
    }
  } catch {
    // 上游流错误，视为无真实首事件
  }
  stopKeepAlive(keepAlive);
  if (firstSeenAt === null) {
    try { reader.cancel?.(); } catch { /* noop */ }
    return retryNonStreamingReplay(res, body, config, fetchImpl, displayModel, provider, buffer, onUsage);
  }
  const ok = await pipeSseWithNormalization(upstream.body, res, { reader, decoder, buffer }, onUsage);
  try { res.end(); } catch { /* noop */ }
  return ok;
}

function startKeepAlive(res) {
  return setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch { /* noop */ }
  }, 10000);
}

function stopKeepAlive(handle) {
  if (handle) clearInterval(handle);
}

async function retryNonStreamingReplay(res, body, config, fetchImpl, displayModel, provider, staleBuffer = '', onUsage) {
  logEvent(config, {
    event: 'stream_retry_nonstreaming',
    model: displayModel,
    reason: 'first_event_timeout',
    endpoint: provider.endpoint,
    stale_bytes: staleBuffer.length
  });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` };
  const retryBody = { ...body, stream: false };
  try {
    const retry = await fetchImpl(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(normalizeResponsesRequest(retryBody)),
      signal: AbortSignal.timeout(Math.min(config.timeouts?.requestMs || 600000, 60000))
    });
    if (retry.ok) {
      const response = await parseNonStreamingResponse(retry, displayModel);
      const usage = extractUsage(response);
      if (usage) onUsage?.(usage);
      replayResponsesAsSse(response, (event, data) => res.write(sseEncode(event, data)));
      res.end();
      return true;
    }
    const text = await retry.text();
    writeFailedEvent(res, 'upstream_error', `upstream ${retry.status}: ${text.slice(0, 200)}`);
  } catch (error) {
    writeFailedEvent(res, 'retry_failed', String(error?.message || 'retry failed').slice(0, 200));
  }
  return false;
}

function writeFailedEvent(res, code, message) {
  const failed = normalizeResponsesObject({
    id: 'resp_' + randomUUID().replace(/-/g, ''),
    status: 'failed',
    error: { code, message }
  }, 'failed');
  try {
    res.write(sseEncode('response.failed', { type: 'response.failed', response: failed }));
    res.end();
  } catch { /* noop */ }
}

export async function relayUpstream(res, upstream, onUsage) {
  if (!upstream.ok) {
    await relayError(res, upstream);
    return false;
  }
  const contentType = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, { 'content-type': contentType });
  if (contentType.includes('text/event-stream')) {
    await pipeSseWithNormalization(upstream.body, res, null, onUsage);
  } else {
    const text = await upstream.text();
    let out = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && (parsed.object === 'response' || (parsed.id && parsed.model))) {
        const usage = extractUsage(parsed);
        if (usage) onUsage?.(usage);
        out = JSON.stringify(normalizeResponsesObject(parsed, 'completed'));
      }
    } catch {
      // 非 JSON 或解析失败时原样转发
    }
    res.write(out);
  }
  res.end();
  return true;
}

async function pipeSseWithNormalization(body, res, initial = null, onUsage) {
  const reader = initial?.reader ?? body?.getReader();
  if (!reader) return false;
  const decoder = initial?.decoder ?? new TextDecoder();
  let buffer = initial?.buffer ?? '';
  const keepAlive = startKeepAlive(res);
  let terminalSeen = false;
  let sawCompleted = false;
  const flush = (part) => {
    if (!part || !part.trim()) return;
    const parsed = parseSseEvent(part);
    if (!parsed) return;
    if (!parsed.event.startsWith('response.')) {
      res.write(part + '\n\n');
      return;
    }
    try {
      const obj = JSON.parse(parsed.data);
      if (obj && typeof obj === 'object' && obj.response) {
        obj.response = normalizeResponsesObject(obj.response, RESPONSE_STATUS_FOR_EVENT[parsed.event] || 'completed');
        const usage = extractUsage(obj.response);
        if (usage) onUsage?.(usage);
        res.write(sseEncode(parsed.event, obj));
        if (parsed.event === 'response.completed') {
          terminalSeen = true;
          sawCompleted = true;
        } else if (parsed.event === 'response.failed') {
          terminalSeen = true;
        }
        return;
      }
    } catch {
      // 无法解析时原样转发
    }
    res.write(part + '\n\n');
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) flush(part);
      if (terminalSeen) break;
    }
    flush(buffer);
  } catch (error) {
    // 上游流中断时补发一个字段完整的 failed 事件，避免 Codex 收到截断的流
    // 导致 'failed to parse ResponseCompleted: missing field input_tokens'。
    try {
      const failed = normalizeResponsesObject({
        id: 'resp_' + randomUUID().replace(/-/g, ''),
        status: 'failed',
        error: { code: 'stream_interrupted', message: String(error?.message || 'upstream stream interrupted').slice(0, 200) }
      }, 'failed');
      res.write(sseEncode('response.failed', { type: 'response.failed', response: failed }));
      res.end();
      return false;
    } catch { /* noop */ }
  } finally {
    stopKeepAlive(keepAlive);
    reader.releaseLock();
  }
  return sawCompleted;
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
