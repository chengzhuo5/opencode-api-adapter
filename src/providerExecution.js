import { responsesToAnthropicRequest } from './translate/responsesToAnthropic.js';
import { responsesToChatRequest } from './translate/responsesToChat.js';
import { chatToResponsesObject, translateChatStreamToResponses } from './translate/chatToResponses.js';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from './translate/anthropicToResponses.js';
import { replayResponsesAsSse } from './translate/responsesReplay.js';
import { normalizeResponsesRequest } from './translate/responsesContext.js';
import { sseEncode } from './sse.js';
import {
  hasFileIdInput,
  relayNonStreamingResponse,
  relayUpstreamSmart,
  relayUpstream,
  relayError,
  sendJson
} from './fallback.js';
import { logEvent } from './logger.js';
import { extractUsage } from './usageLog.js';
import { resolveProviders } from './routes.js';
import { createAbortScope } from './requestLifecycle.js';

const unsupportedResponses = new Map();
const unsupportedNotified = new Map();
const UNSUPPORTED_STATUSES = new Set([400, 404, 405]);
export const UNSUPPORTED_CACHE_TTL_MS = 5 * 60_000;
const UNSUPPORTED_MESSAGE_RE =
  /not[\s_-]?supported|unknown model|model[^\n]{0,40}(not found|does not exist)|(no such|invalid) model/i;

let unsupportedNow = () => Date.now();

const PROTOCOL_ADAPTERS = {
  chat: {
    requestBody: responsesToChatRequest,
    headers: (apiKey) => ({
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    }),
    translateStream: translateChatStreamToResponses,
    responseObject: chatToResponsesObject,
    networkError: 'chat upstream failed',
    invalidJsonError: 'chat upstream returned invalid JSON'
  },
  messages: {
    requestBody: responsesToAnthropicRequest,
    headers: (apiKey) => ({
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }),
    translateStream: translateAnthropicStreamToResponses,
    responseObject: anthropicToResponsesObject,
    networkError: 'messages upstream failed',
    invalidJsonError: 'messages upstream returned invalid JSON'
  }
};

/**
 * Provider 执行的唯一外部 Interface。
 * 路由调用者只选择协议并传入已准备好的 Responses 请求；provider 顺序、鉴权、
 * timeout、breaker、failover、usage 和响应回放全部留在本 Module 内。
 */
export async function forwardRoute(
  res,
  body,
  route,
  config,
  fetchImpl,
  displayModel = body.model,
  options = {}
) {
  const adapter = PROTOCOL_ADAPTERS[route.upstream];
  if (adapter) {
    await forwardConvertedRoute(res, body, route, config, fetchImpl, displayModel, options, adapter);
    return;
  }
  await forwardResponsesRoute(res, body, route, config, fetchImpl, displayModel, options);
}

/** 仅测试用：注入可控时钟以验证缓存过期行为。 */
export function __setUnsupportedCacheNowForTest(fn) {
  unsupportedNow = fn;
}

/** 仅测试用：恢复真实时钟。 */
export function __resetUnsupportedCacheNowForTest() {
  unsupportedNow = () => Date.now();
}

export function clearUnsupportedCache() {
  unsupportedResponses.clear();
  unsupportedNotified.clear();
}

async function forwardResponsesRoute(res, body, route, config, fetchImpl, displayModel, options) {
  let providers = routeProviders(route, config);
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
  options.tracker?.annotate(options.cacheDiagnostics?.request('responses', requestBody));
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    const nextProvider = providers[index + 1];
    const last = !nextProvider;

    if (isUnsupportedCached(displayModel, provider.endpoint)) {
      if (!isUnsupportedNotified(displayModel, provider.endpoint)) {
        markUnsupportedNotified(displayModel, provider.endpoint);
        logResponsesFallback(config, displayModel, provider, nextProvider, 'responses_unsupported');
      }
      if (last) {
        if (hasChatFallback(config)) {
          await forwardChatFallback(res, body, config, fetchImpl, displayModel, options);
        } else {
          sendJson(res, 502, {
            error: { message: `${displayModel} responses unsupported and no chat fallback configured` }
          });
        }
        return;
      }
      continue;
    }

    const breakerKey = options.breaker?.keyOf(
      displayModel,
      provider.endpoint,
      provider.apiKey
    ) ?? null;
    const permit = options.breaker
      ? options.breaker.allow(breakerKey, { forceProbe: last })
      : { allowed: true, usedHalfOpenPermit: false };
    if (!permit.allowed) {
      logEvent(config, {
        event: 'circuit_skip',
        model: displayModel,
        upstream: 'responses',
        endpoint: provider.endpoint,
        fallback_endpoint: nextProvider?.endpoint ?? (hasChatFallback(config) ? 'chat/completions' : null)
      });
      if (last) {
        if (hasChatFallback(config)) {
          await forwardChatFallback(res, body, config, fetchImpl, displayModel, options);
        } else {
          sendJson(res, 502, {
            error: { message: `all providers skipped and no chat fallback configured for ${displayModel}` }
          });
        }
        return;
      }
      continue;
    }

    const attempt = providerAttempt(config, options.signal);
    try {
      let upstream;
      try {
        upstream = await fetchImpl(provider.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${provider.apiKey}`
          },
          body: JSON.stringify(requestBody),
          signal: attempt.signal
        });
      } catch {
        if (clientDisconnected(options)) {
          recordClientDisconnect(options, provider.endpoint);
          return;
        }
        recordFailure(options, breakerKey, permit, provider.endpoint, 502, 'network_error');
        logResponsesFallback(config, displayModel, provider, nextProvider, 'network_error');
        if (last) {
          if (hasChatFallback(config)) {
            await forwardChatFallback(res, body, config, fetchImpl, displayModel, options);
          } else {
            sendJson(res, 502, {
              error: { message: `upstream network error and no chat fallback configured for ${displayModel}` }
            });
          }
          return;
        }
        continue;
      }

      if (upstream.ok) {
        let relayOk = true;
        let usage = null;
        try {
          if (options.replay) {
            relayOk = await relayNonStreamingResponse(
              res,
              upstream,
              displayModel,
              (value) => { usage = value; },
              attempt.signal
            );
          } else if (options.streamRetryFallback ?? true) {
            relayOk = await relayUpstreamSmart(
              res,
              upstream,
              body,
              config,
              fetchImpl,
              displayModel,
              provider,
              (value) => { usage = value; },
              attempt.signal
            );
          } else {
            relayOk = await relayUpstream(
              res,
              upstream,
              (value) => { usage = value; },
              attempt.signal
            );
          }
        } catch (error) {
          relayOk = false;
          if (!clientDisconnected(options)) {
            logEvent(config, {
              event: 'relay_error',
              model: displayModel,
              endpoint: provider.endpoint,
              reason: String(error?.message || 'relay error').slice(0, 200)
            });
            try { res.end(); } catch { /* noop */ }
          }
        }
        if (clientDisconnected(options)) {
          recordClientDisconnect(options, provider.endpoint, usage);
        } else if (relayOk) {
          recordSuccess(options, breakerKey, permit, provider, upstream.status, usage);
        } else {
          recordFailure(options, breakerKey, permit, provider.endpoint, 200, 'stream_interrupted', usage);
        }
        return;
      }

      if (clientDisconnected(options)) {
        await discardResponseBody(upstream);
        recordClientDisconnect(options, provider.endpoint);
        return;
      }
      recordFailure(options, breakerKey, permit, provider.endpoint, upstream.status, 'http_error');
      if (last && await isUnsupportedResponse(upstream)) {
        rememberUnsupported(displayModel, provider.endpoint);
      }
      logResponsesFallback(config, displayModel, provider, nextProvider, 'http_error', upstream.status);
      if (!last) {
        await discardResponseBody(upstream);
        continue;
      }
      if (hasChatFallback(config)) {
        await discardResponseBody(upstream);
        await forwardChatFallback(res, body, config, fetchImpl, displayModel, options);
      } else {
        await relayError(res, upstream);
      }
      return;
    } finally {
      attempt.dispose();
    }
  }
}

async function forwardChatFallback(res, body, config, fetchImpl, displayModel, options) {
  const providers = chatFallbackProviders(config);
  if (!providers.length) {
    sendJson(res, 502, { error: { message: `chat fallback not configured for ${displayModel}` } });
    return;
  }
  await forwardConvertedRoute(
    res,
    body,
    { upstream: 'chat', providers },
    config,
    fetchImpl,
    displayModel,
    { ...options, responseFallback: true },
    PROTOCOL_ADAPTERS.chat
  );
}

async function forwardConvertedRoute(res, body, route, config, fetchImpl, displayModel, options, adapter) {
  const effective = options.replay ? { ...body, stream: false } : body;
  const requestBody = adapter.requestBody(effective);
  options.tracker?.annotate(options.cacheDiagnostics?.request(route.upstream, requestBody));
  const providers = routeProviders(route, config);
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    const nextProvider = providers[index + 1];
    const last = !nextProvider;
    const breakerKey = options.breaker?.keyOf(
      displayModel,
      provider.endpoint,
      provider.apiKey
    ) ?? null;
    const permit = options.breaker
      ? options.breaker.allow(breakerKey, { forceProbe: last })
      : { allowed: true, usedHalfOpenPermit: false };

    if (!permit.allowed) {
      logEvent(config, {
        event: 'circuit_skip',
        model: displayModel,
        upstream: route.upstream,
        endpoint: provider.endpoint,
        fallback_endpoint: nextProvider?.endpoint ?? null
      });
      if (last) {
        sendJson(res, 502, { error: { message: `all ${route.upstream} providers skipped for ${displayModel}` } });
        return;
      }
      continue;
    }

    const attempt = providerAttempt(config, options.signal);
    try {
      let upstream;
      try {
        upstream = await fetchImpl(provider.endpoint, {
          method: 'POST',
          headers: adapter.headers(provider.apiKey ?? config.apiKey),
          body: JSON.stringify(requestBody),
          signal: attempt.signal
        });
      } catch (error) {
        if (clientDisconnected(options)) {
          recordClientDisconnect(options, provider.endpoint);
          return;
        }
        recordFailure(options, breakerKey, permit, provider.endpoint, 502, 'network_error');
        logConvertedFailure(config, displayModel, route.upstream, provider, nextProvider, 'network_error', undefined, options);
        if (!last) continue;
        sendJson(res, 502, {
          error: {
            message: error?.message || (options.responseFallback ? 'chat fallback failed' : adapter.networkError)
          }
        });
        return;
      }

      if (!upstream.ok) {
        if (clientDisconnected(options)) {
          await discardResponseBody(upstream);
          recordClientDisconnect(options, provider.endpoint);
          return;
        }
        recordFailure(options, breakerKey, permit, provider.endpoint, upstream.status, 'http_error');
        logConvertedFailure(
          config,
          displayModel,
          route.upstream,
          provider,
          nextProvider,
          'http_error',
          upstream.status,
          options
        );
        if (!last) {
          await discardResponseBody(upstream);
          continue;
        }
        await relayError(res, upstream);
        return;
      }

      if (effective.stream) {
        let usage = null;
        try {
          if (clientDisconnected(options) || res.destroyed) {
            await discardResponseBody(upstream);
            recordClientDisconnect(options, provider.endpoint);
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          });
          const streamOk = await adapter.translateStream(upstream.body, displayModel, (event, data) => {
            if (attempt.signal.aborted || res.destroyed) {
              throw attempt.signal.reason || new Error('client disconnected');
            }
            if (event === 'response.completed' && data?.response) {
              const extracted = extractUsage(data.response);
              if (extracted) usage = extracted;
            }
            res.write(sseEncode(event, data));
          }, { signal: attempt.signal });
          if (!res.destroyed) res.end();
          if (clientDisconnected(options)) {
            recordClientDisconnect(options, provider.endpoint, usage);
            return;
          }
          if (!streamOk) {
            recordFailure(options, breakerKey, permit, provider.endpoint, 200, 'stream_interrupted', usage);
            return;
          }
        } catch (error) {
          if (clientDisconnected(options)) {
            recordClientDisconnect(options, provider.endpoint, usage);
            return;
          }
          recordFailure(options, breakerKey, permit, provider.endpoint, 502, 'stream_interrupted');
          logEvent(config, {
            event: 'relay_error',
            model: displayModel,
            endpoint: provider.endpoint,
            reason: String(error?.message || 'stream relay error').slice(0, 200)
          });
          try { res.end(); } catch { /* noop */ }
          return;
        }
        recordSuccess(options, breakerKey, permit, provider, upstream.status, usage);
        return;
      }

      let response;
      try {
        response = await upstream.json();
      } catch {
        if (clientDisconnected(options)) {
          recordClientDisconnect(options, provider.endpoint);
          return;
        }
        recordFailure(options, breakerKey, permit, provider.endpoint, 502, 'invalid_json');
        logConvertedFailure(config, displayModel, route.upstream, provider, nextProvider, 'invalid_json', undefined, options);
        if (!last) continue;
        sendJson(res, 502, {
          error: {
            message: options.responseFallback ? 'chat fallback returned invalid JSON' : adapter.invalidJsonError
          }
        });
        return;
      }

      if (clientDisconnected(options) || res.destroyed) {
        recordClientDisconnect(options, provider.endpoint, extractUsage(response));
        return;
      }
      const usage = extractUsage(response);
      const normalized = adapter.responseObject(response, displayModel);
      if (options.replay) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        replayResponsesAsSse(normalized, (event, data) => res.write(sseEncode(event, data)));
        res.end();
      } else {
        sendJson(res, upstream.status, normalized);
      }
      recordSuccess(options, breakerKey, permit, provider.endpoint, upstream.status, usage);
      if (options.responseFallback) {
        logEvent(config, {
          event: 'api_fallback_result',
          model: displayModel,
          success: true,
          status: upstream.status,
          fallback_endpoint: 'chat/completions',
          fallback_url: provider.endpoint
        });
      }
      return;
    } finally {
      attempt.dispose();
    }
  }
}

function unsupportedKey(model, endpoint) {
  return `${model}::${endpoint}`;
}

function isUnsupportedCached(model, endpoint) {
  const key = unsupportedKey(model, endpoint);
  const expiry = unsupportedResponses.get(key);
  if (!expiry) return false;
  if (expiry > unsupportedNow()) return true;
  unsupportedResponses.delete(key);
  return false;
}

function rememberUnsupported(model, endpoint) {
  unsupportedResponses.set(
    unsupportedKey(model, endpoint),
    unsupportedNow() + UNSUPPORTED_CACHE_TTL_MS
  );
}

function isUnsupportedNotified(model, endpoint) {
  const key = unsupportedKey(model, endpoint);
  const expiry = unsupportedNotified.get(key);
  if (!expiry) return false;
  if (expiry > unsupportedNow()) return true;
  unsupportedNotified.delete(key);
  return false;
}

function markUnsupportedNotified(model, endpoint) {
  unsupportedNotified.set(
    unsupportedKey(model, endpoint),
    unsupportedNow() + UNSUPPORTED_CACHE_TTL_MS
  );
}

function isUnsupportedErrorText(text) {
  return Boolean(text && text.length <= 4000 && UNSUPPORTED_MESSAGE_RE.test(text));
}

async function isUnsupportedResponse(upstream) {
  if (!UNSUPPORTED_STATUSES.has(upstream.status)) return false;
  try {
    return isUnsupportedErrorText(await upstream.clone().text());
  } catch {
    return false;
  }
}

function hasChatFallback(config) {
  return chatFallbackProviders(config).length > 0;
}

function chatFallbackProviders(config) {
  return resolveProviders(config?.apiBaseUrl, 'chat/completions', config?.apiKey);
}

function routeProviders(route, config) {
  if (Array.isArray(route.providers) && route.providers.length) return route.providers;
  return [
    { endpoint: route.endpoint, apiKey: route.apiKey ?? config.apiKey },
    ...(route.fallbackEndpoint
      ? [{ endpoint: route.fallbackEndpoint, apiKey: route.fallbackApiKey ?? config.apiKey }]
      : [])
  ].filter((provider) => provider.endpoint);
}

function providerAttempt(config, parentSignal) {
  return createAbortScope({
    timeoutMs: config.timeouts?.requestMs || 600000,
    parentSignal
  });
}

async function discardResponseBody(upstream) {
  try {
    await upstream.body?.cancel();
  } catch {
    // 丢弃失败不能覆盖原始 provider 错误或阻止 failover。
  }
}

function recordFailure(options, breakerKey, permit, endpoint, status, error, usage) {
  options.breaker?.recordFailure(breakerKey, permit.usedHalfOpenPermit);
  options.tracker?.record({
    endpoint,
    provider_endpoint_hash: options.cacheDiagnostics?.endpoint(endpoint) ?? null,
    ok: false,
    status,
    error,
    usage
  });
}

function clientDisconnected(options) {
  return options.signal?.aborted === true;
}

function recordClientDisconnect(options, endpoint, usage) {
  options.tracker?.record({
    endpoint,
    provider_endpoint_hash: options.cacheDiagnostics?.endpoint(endpoint) ?? null,
    ok: false,
    status: 499,
    error: 'client_disconnected',
    usage
  });
}

function recordSuccess(options, breakerKey, permit, provider, status, usage) {
  const endpoint = provider.endpoint;
  options.breaker?.recordSuccess(breakerKey, permit.usedHalfOpenPermit);
  options.tracker?.record({
    endpoint,
    provider_endpoint_hash: options.cacheDiagnostics?.endpoint(endpoint) ?? null,
    ok: true,
    status,
    usage
  });
  try {
    options.onProviderSuccess?.(provider);
  } catch {
    // Affinity/observability hooks must never fail an otherwise successful request.
  }
}

function logProtocolFallback(config, model, upstream, provider, nextProvider, reason, status) {
  logEvent(config, {
    event: 'provider_fallback',
    model,
    upstream,
    reason,
    primary_url: provider.endpoint,
    ...(status ? { primary_status: status } : {}),
    fallback_url: nextProvider?.endpoint ?? null
  });
}

function logConvertedFailure(config, model, upstream, provider, nextProvider, reason, status, options) {
  if (!options.responseFallback) {
    logProtocolFallback(config, model, upstream, provider, nextProvider, reason, status);
    return;
  }
  logEvent(config, {
    event: 'api_fallback_result',
    model,
    success: false,
    status: status ?? 502,
    fallback_endpoint: 'chat/completions',
    fallback_url: provider.endpoint,
    next_fallback_url: nextProvider?.endpoint ?? null,
    reason
  });
}

function logResponsesFallback(config, model, provider, nextProvider, reason, status) {
  logEvent(config, {
    event: 'api_fallback',
    model,
    reason,
    primary_endpoint: endpointName(provider.endpoint),
    primary_url: provider.endpoint,
    ...(status ? { primary_status: status } : {}),
    fallback_endpoint: nextProvider
      ? endpointName(nextProvider.endpoint)
      : (hasChatFallback(config) ? 'chat/completions' : null)
  });
}

function endpointName(endpoint) {
  return endpoint.split('/').pop() || endpoint;
}
