import http from 'node:http';
import path from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolveRoute, UnknownModelError, RouteConfigurationError } from './routes.js';
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
import { createCodexManager } from './codexConfig.js';

const ADMIN_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function createRouter(config, {
  fetchImpl = globalThis.fetch,
  adminDir,
  version,
  getConfigText,
  onReloadValidate,
  onReloadCommit,
  onRestartCommit
} = {}) {
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
  const codex = config?.codex?.enabled ? createCodexManager(config) : null;
  const server = http.createServer(async (req, res) => {
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
      if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) {
        serveAdmin(res, url.pathname, adminDir);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.floor(process.uptime()),
          host: config.host,
          port: config.port,
          version: version || '0.0.0',
          config: {
            models: Object.keys(config.models || {}).length,
            modelPatterns: Object.keys(config.modelPatterns || {}),
            healthCheck: config.healthCheck,
            circuitBreaker: config.circuitBreaker,
            usageLog: config.usageLog,
            compress: config.compress ? { enabled: config.compress.enabled, backend: config.compress.backend } : null,
            nonStreamingUpstream: Boolean(config.nonStreamingUpstream)
          },
          health: health ? health.status() : [],
          circuit: breaker ? breaker.statuses() : [],
          usage: usageLogger
            ? aggregateUsage(readUsageLines(usageLogger.file), { days: 7 })
            : { enabled: false }
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        sendJson(res, 200, { ok: true, config: getConfigText ? getConfigText() : '' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reload') {
        const text = await readRawBody(req);
        const error = onReloadValidate ? onReloadValidate(text) : 'reload not configured';
        if (error) {
          sendJson(res, 400, { ok: false, error });
          return;
        }
        sendJson(res, 200, { ok: true, message: '配置已保存，正在热加载' });
        setImmediate(() => {
          onReloadCommit?.().catch((e) => logEvent(config, { event: 'admin_reload_failed', reason: String(e?.message || e).slice(0, 300) }));
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        sendJson(res, 200, { ok: true, message: '正在重启路由服务' });
        setImmediate(() => {
          onRestartCommit?.().catch((e) => logEvent(config, { event: 'admin_restart_failed', reason: String(e?.message || e).slice(0, 300) }));
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/codex') {
        if (!codex) {
          sendJson(res, 200, { enabled: false });
          return;
        }
        try {
          sendJson(res, 200, { enabled: true, status: codex.status() });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/codex/apply') {
        if (!codex) {
          sendJson(res, 400, { ok: false, error: 'codex 管理未启用（config.codex.enabled）' });
          return;
        }
        try {
          const result = codex.apply();
          logEvent(config, { event: 'codex_apply', changed: result.changed, backup: result.backup || null });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/codex/restore') {
        if (!codex) {
          sendJson(res, 400, { ok: false, error: 'codex 管理未启用（config.codex.enabled）' });
          return;
        }
        try {
          let body = {};
          try { body = await readJson(req); } catch { body = {}; }
          const result = codex.restore({ file: body?.file, confirm: Boolean(body?.confirm) });
          logEvent(config, { event: 'codex_restore', restored: result.restored, method: result.method || null });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJson(req);
        validateResponsesRequest(body);
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
      if (error instanceof RequestValidationError || error instanceof UnknownModelError) {
        sendJson(res, 400, { error: { message: error.message } });
      } else if (error instanceof RouteConfigurationError) {
        sendJson(res, error.statusCode || 503, { error: { message: error.message } });
      }
      else sendJson(res, 500, { error: { message: error.message || 'internal error' } });
    }
  });
  server.__routerCleanup = () => { health?.stop(); };
  return server;
}

function serveAdmin(res, urlPath, adminDir) {
  if (!adminDir) {
    sendJson(res, 404, { error: { message: 'admin ui not configured' } });
    return;
  }
  let rel = urlPath === '/admin' ? '/index.html' : urlPath.slice('/admin'.length);
  const normalized = path.normalize(rel).replace(/^([/\\])+/, '');
  const file = path.resolve(adminDir, normalized);
  if (!file.startsWith(adminDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    sendJson(res, 404, { error: { message: `not found: ${urlPath}` } });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': ADMIN_MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(file));
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
    route.fallbackEndpoint = reordered[1]?.endpoint ?? null;
    route.fallbackApiKey = reordered[1]?.apiKey ?? null;
  }
}

async function forward(res, body, route, config, fetchImpl, compression) {
  // 非流式上游模式：Codex 请求流式，但向上游发 stream:false（完整 JSON），
  // 拿到响应后由路由回放成 SSE，避免上游流中断导致客户端解析失败。
  const replay = Boolean(config.nonStreamingUpstream && body.stream === true);
  const effective = replay ? { ...body, stream: false } : body;
  if (route.upstream === 'messages') {
    await forwardMessagesRoute(res, effective, route, config, fetchImpl, body.model, {
      replay,
      tracker: compression?.tracker
    });
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
  const requestBody = responsesToChatRequest(effective);
  const providers = routeProviders(route, config);
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    const last = index === providers.length - 1;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey ?? config.apiKey}`
    };
    let upstream;
    try {
      upstream = await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: requestSignal(config)
      });
    } catch (error) {
      options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: 502, error: 'network_error' });
      logProtocolFallback(config, displayModel, 'chat', provider, providers[index + 1], 'network_error');
      if (!last) continue;
      sendJson(res, 502, { error: { message: error?.message || 'chat upstream failed' } });
      return;
    }
    if (!upstream.ok) {
      options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: upstream.status, error: 'http_error' });
      logProtocolFallback(config, displayModel, 'chat', provider, providers[index + 1], 'http_error', upstream.status);
      if (!last) continue;
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
      options.tracker?.record({ endpoint: provider.endpoint, ok: true, status: upstream.status, usage });
      return;
    }
    let chat;
    try {
      chat = await upstream.json();
    } catch {
      options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: 502, error: 'invalid_json' });
      logProtocolFallback(config, displayModel, 'chat', provider, providers[index + 1], 'invalid_json');
      if (!last) continue;
      sendJson(res, 502, { error: { message: 'chat upstream returned invalid JSON' } });
      return;
    }
    const usage = extractUsage(chat);
    if (options.replay) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      replayResponsesAsSse(chatToResponsesObject(chat, displayModel), (event, data) => res.write(sseEncode(event, data)));
      res.end();
      options.tracker?.record({ endpoint: provider.endpoint, ok: true, status: upstream.status, usage });
      return;
    }
    sendJson(res, upstream.status, chatToResponsesObject(chat, displayModel));
    options.tracker?.record({ endpoint: provider.endpoint, ok: true, status: upstream.status, usage });
    return;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestValidationError('invalid JSON request body');
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

class RequestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

function validateResponsesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestValidationError('request body must be a JSON object');
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw new RequestValidationError('model must be a non-empty string');
  }
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

function requestSignal(config) {
  return AbortSignal.timeout(config.timeouts?.requestMs || 600000);
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

async function forwardMessagesRoute(res, body, route, config, fetchImpl, displayModel, options = {}) {
  const requestBody = responsesToAnthropicRequest(body);
  const providers = routeProviders(route, config);
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    const last = index === providers.length - 1;
    const headers = {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey ?? config.apiKey,
      'anthropic-version': '2023-06-01'
    };
    let upstream;
    try {
      upstream = await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: requestSignal(config)
      });
    } catch (error) {
      options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: 502, error: 'network_error' });
      logProtocolFallback(config, displayModel, 'messages', provider, providers[index + 1], 'network_error');
      if (!last) continue;
      sendJson(res, 502, { error: { message: error?.message || 'messages upstream failed' } });
      return;
    }
    if (!upstream.ok) {
      options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: upstream.status, error: 'http_error' });
      logProtocolFallback(config, displayModel, 'messages', provider, providers[index + 1], 'http_error', upstream.status);
      if (!last) continue;
      await relayError(res, upstream);
      return;
    }
    if (body.stream) {
      let usage = null;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      await translateAnthropicStreamToResponses(upstream.body, displayModel, (event, data) => {
        if (event === 'response.completed' && data?.response) {
          const extracted = extractUsage(data.response);
          if (extracted) usage = extracted;
        }
        res.write(sseEncode(event, data));
      });
      res.end();
      options.tracker?.record({ endpoint: provider.endpoint, ok: true, status: upstream.status, usage });
      return;
    }
    let message;
    try {
      message = await upstream.json();
    } catch {
      options.tracker?.record({ endpoint: provider.endpoint, ok: false, status: 502, error: 'invalid_json' });
      logProtocolFallback(config, displayModel, 'messages', provider, providers[index + 1], 'invalid_json');
      if (!last) continue;
      sendJson(res, 502, { error: { message: 'messages upstream returned invalid JSON' } });
      return;
    }
    const usage = extractUsage(message);
    if (options.replay) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      replayResponsesAsSse(anthropicToResponsesObject(message, displayModel), (event, data) => res.write(sseEncode(event, data)));
      res.end();
      options.tracker?.record({ endpoint: provider.endpoint, ok: true, status: upstream.status, usage });
      return;
    }
    sendJson(res, upstream.status, anthropicToResponsesObject(message, displayModel));
    options.tracker?.record({ endpoint: provider.endpoint, ok: true, status: upstream.status, usage });
    return;
  }
}
