import http from 'node:http';
import path from 'node:path';
import { resolveRoute, UnknownModelError } from './routes.js';
import { sseEncode } from './sse.js';
import { responsesToAnthropicRequest } from './translate/responsesToAnthropic.js';
import { responsesToChatRequest } from './translate/responsesToChat.js';
import { chatToResponsesObject, translateChatStreamToResponses } from './translate/chatToResponses.js';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from './translate/anthropicToResponses.js';
import { replayResponsesAsSse } from './translate/responsesReplay.js';
import { maybeUpgradeModel, minimizeHistoryImages, stripAllImages, DEEPSEEK_MODELS, truncateHistory, forwardWithFallback, relayUpstream, relayError, sendJson } from './fallback.js';
import { logEvent } from './logger.js';
import { maybeCompressInput, loadOutput } from './compression.js';
import { createLeanCtxClient } from './leanCtxClient.js';
import { createHealthMonitor } from './health.js';
import { createCircuitBreaker } from './circuitBreaker.js';
import { createUsageLogger, createRequestTracker, readUsageLines, aggregateUsage, extractUsage } from './usageLog.js';

export function createRouter(config, { fetchImpl = globalThis.fetch } = {}) {
  const compressEnabled = config?.compress?.enabled && config.compress.backend === 'lean-ctx';
  const ctxCache = compressEnabled ? new Map() : null;
  const ctxSafety = compressEnabled ? new Map() : null;
  const ctxStats = compressEnabled ? { total_chars_before: 0, total_chars_after: 0, total_tokens_before: 0, total_tokens_after: 0, requests: 0 } : null;
  const ctxStoreDir = compressEnabled && config.compress.storeDir ? path.resolve(config.compress.storeDir) : null;
  const ctxClient = compressEnabled ? createLeanCtxClient({ baseUrl: config.compress.baseUrl, token: config.compress.token, timeoutMs: config.compress.timeoutMs }) : null;
  const health = config?.healthCheck?.enabled
    ? createHealthMonitor({ config, fetchImpl })
    : null;
  if (health) health.start();
  const breaker = config?.circuitBreaker?.enabled
    ? createCircuitBreaker(config, {
        onStateChange: (key, state) => logEvent(config, { event: 'provider_circuit', key, state })
      })
    : null;
  const usageLogger = config?.usageLog?.enabled ? createUsageLogger(config) : null;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, 200, config.catalog || { models: [] });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/ctx/')) {
        const hash = url.pathname.slice('/v1/ctx/'.length);
        if (!/^[a-f0-9]{64}$/.test(hash)) {
          sendJson(res, 400, { error: { message: `invalid ctx hash: ${hash}` } });
          return;
        }
        const archived = loadOutput(hash, ctxStoreDir);
        if (!archived) {
          sendJson(res, 404, { error: { message: `ctx ${hash} not found` } });
          return;
        }
        sendJson(res, 200, archived);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/usage') {
        if (!usageLogger) {
          sendJson(res, 200, { enabled: false });
          return;
        }
        const days = Math.max(1, Number.parseInt(url.searchParams.get('days') || '7', 10) || 7);
        const stats = aggregateUsage(readUsageLines(usageLogger.file), {
          model: url.searchParams.get('model') || undefined,
          endpoint: url.searchParams.get('provider') || undefined,
          days
        });
        sendJson(res, 200, stats);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJson(req);
        const route = resolveRoute(config, maybeUpgradeModel(body).model);
        if (health) reorderProvidersByHealth(route, health);
        const tracker = usageLogger ? createRequestTracker(body.model, { streamed: body.stream === true }) : null;
        try {
          await forward(res, body, route, config, fetchImpl, { client: ctxClient, storeDir: ctxStoreDir, cache: ctxCache, safety: ctxSafety, stats: ctxStats, breaker, tracker });
        } catch (error) {
          tracker?.record({ ok: false, status: 502, error: String(error?.message || 'internal error').slice(0, 200) });
          throw error;
        } finally {
          if (usageLogger && tracker) usageLogger.log(tracker.finalize());
        }
        return;
      }
      sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
    } catch (error) {
            if (res.headersSent || res.writableEnded) {
        logEvent(config, {
          event: 'stream_aborted',
          reason: error?.message || 'streaming relay error'
        });
        try { res.end(); } catch { /* noop */ }
        return;
      }
if (error instanceof UnknownModelError) sendJson(res, 400, { error: { message: error.message } });
      else sendJson(res, 500, { error: { message: error.message || 'internal error' } });
    }
  });
}

function reorderProvidersByHealth(route, health) {
  if (!route.providers || route.providers.length < 2) return;
  const healthy = route.providers.filter((p) => !health.isUnhealthy(route.model, p.endpoint));
  const down = route.providers.filter((p) => health.isUnhealthy(route.model, p.endpoint));
  if (down.length) {
    const reordered = [...healthy, ...down];
    route.providers = reordered;
    route.endpoint = reordered[0]?.endpoint;
    route.apiKey = reordered[0]?.apiKey;
  }
}

async function forward(res, body, route, config, fetchImpl, compression) {
  // 非流式上游模式：Codex 请求流式，但向上游发 stream:false（完整 JSON），
  // 拿到响应后由路由回放成 SSE，避免上游流中断导致客户端解析失败。
  const replay = Boolean(config.nonStreamingUpstream && body.stream === true);
  const effective = replay ? { ...body, stream: false } : body;
  if (route.upstream === 'messages') {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    };
    const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
    const requestBody = responsesToAnthropicRequest(effective);
    const upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal });
    if (!upstream.ok) {
      compression?.tracker?.record({ endpoint: route.endpoint, ok: false, status: upstream.status, error: 'http_error' });
      await relayError(res, upstream);
      return;
    }
    if (effective.stream) {
      let usage = null;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      await translateAnthropicStreamToResponses(upstream.body, body.model, (event, data) => {
        if (event === 'response.completed' && data?.response) {
          const u = extractUsage(data.response);
          if (u) usage = u;
        }
        res.write(sseEncode(event, data));
      });
      res.end();
      compression?.tracker?.record({ endpoint: route.endpoint, ok: true, status: upstream.status, usage });
    } else {
      const message = await upstream.json();
      const usage = extractUsage(message);
      if (replay) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        replayResponsesAsSse(anthropicToResponsesObject(message, body.model), (event, data) => res.write(sseEncode(event, data)));
        res.end();
        compression?.tracker?.record({ endpoint: route.endpoint, ok: true, status: upstream.status, usage });
      } else {
        sendJson(res, upstream.status, anthropicToResponsesObject(message, body.model));
        compression?.tracker?.record({ endpoint: route.endpoint, ok: true, status: upstream.status, usage });
      }
    }
    return;
  }
  let upgraded = maybeUpgradeModel(effective);
  if (upgraded !== body) {
    const minimized = minimizeHistoryImages(upgraded.input);
    upgraded = { ...upgraded, input: minimized.input };
    logEvent(config, {
      event: 'multimodal_fallback',
      model: body.model,
      fallback_model: upgraded.model,
      reason: 'image_input',
      endpoint: route.endpoint,
      ...(minimized.removedImages > 0 ? { historical_images_removed: minimized.removedImages } : {})
    });
  } else if (DEEPSEEK_MODELS.has(upgraded.model)) {
    const stripped = stripAllImages(upgraded.input);
    if (stripped.removedImages > 0) {
      upgraded = { ...upgraded, input: stripped.input };
      logEvent(config, {
        event: 'image_stripped',
        model: upgraded.model,
        removed_images: stripped.removedImages,
        reason: 'non_multimodal_model'
      });
    }
  }
  const maxHistory = route.entry?.maxHistoryMessages;
  if (Number.isInteger(maxHistory) && maxHistory > 0) {
    const truncated = truncateHistory(upgraded.input, maxHistory);
    if (truncated.removed > 0) {
      upgraded = { ...upgraded, input: truncated.input };
      logEvent(config, {
        event: 'context_truncation',
        model: upgraded.model,
        max_items: maxHistory,
        original_items: truncated.original,
        removed_items: truncated.removed
      });
    }
  }
  const compressed = await maybeCompressInput(upgraded, config, compression?.client, compression?.storeDir, compression?.cache, compression?.safety, compression?.stats);
  if (route.upstream === 'chat') {
    await forwardChatRoute(res, compressed, route, config, fetchImpl, body.model, { replay, tracker: compression?.tracker });
    return;
  }
  await forwardWithFallback(res, compressed, route, config, fetchImpl, body.model, { replay, breaker: compression?.breaker, tracker: compression?.tracker });
}

async function forwardChatRoute(res, body, route, config, fetchImpl, displayModel, options = {}) {
  const effective = options.replay ? { ...body, stream: false } : body;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.apiKey ?? config.apiKey}`
  };
  const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
  const requestBody = responsesToChatRequest(effective);
  let upstream;
  try {
    upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal });
  } catch (error) {
    options.tracker?.record({ endpoint: route.endpoint, ok: false, status: 502, error: 'network_error' });
    sendJson(res, 502, { error: { message: error?.message || 'chat upstream failed' } });
    return;
  }
  if (!upstream.ok) {
    options.tracker?.record({ endpoint: route.endpoint, ok: false, status: upstream.status, error: 'http_error' });
    await relayError(res, upstream);
    return;
  }
  if (effective.stream) {
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
    options.tracker?.record({ endpoint: route.endpoint, ok: true, status: upstream.status, usage });
    return;
  }
  const chat = await upstream.json();
  const usage = extractUsage(chat);
  if (options.replay) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    replayResponsesAsSse(chatToResponsesObject(chat, displayModel), (event, data) => res.write(sseEncode(event, data)));
    res.end();
    options.tracker?.record({ endpoint: route.endpoint, ok: true, status: upstream.status, usage });
    return;
  }
  sendJson(res, upstream.status, chatToResponsesObject(chat, displayModel));
  options.tracker?.record({ endpoint: route.endpoint, ok: true, status: upstream.status, usage });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
