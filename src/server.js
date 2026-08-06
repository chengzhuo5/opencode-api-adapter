import http from 'node:http';
import path from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolveRoute, UnknownModelError, RouteConfigurationError } from './routes.js';
import { maybeUpgradeModel, minimizeHistoryImages, stripAllImages, DEEPSEEK_MODELS, truncateHistory, sendJson } from './fallback.js';
import { forwardRoute } from './providerExecution.js';
import { logEvent } from './logger.js';
import { maybeCompressInput, loadOutput } from './compression.js';
import { createLeanCtxClient } from './leanCtxClient.js';
import { createHealthMonitor } from './health.js';
import { createCircuitBreaker } from './circuitBreaker.js';
import { createUsageLogger, createRequestTracker } from './usageLog.js';
import { createCodexManager } from './codexConfig.js';
import { createProviderAffinity } from './providerAffinity.js';
import { createCacheDiagnostics } from './cacheDiagnostics.js';
import { createManagementAccess } from './managementAccess.js';
import { createClientDisconnectScope } from './requestLifecycle.js';

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
  const providerAffinity = createProviderAffinity(config);
  const cacheDiagnostics = createCacheDiagnostics(config);
  const codex = config?.codex?.enabled ? createCodexManager(config) : null;
  const managementAccess = createManagementAccess(config);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const managementDenial = managementAccess.inspect(req, url.pathname);
      if (managementDenial) {
        for (const [name, value] of Object.entries(managementDenial.headers)) {
          res.setHeader(name, value);
        }
        res.setHeader('cache-control', 'no-store');
        sendJson(res, managementDenial.statusCode, {
          error: { message: managementDenial.message }
        });
        return;
      }
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
        const archived = await loadOutput(hash, ctxStoreDir);
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
        const stats = usageLogger.aggregate({
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
        res.setHeader('cache-control', 'no-store');
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
            providerStickiness: config.providerStickiness,
            management: managementAccess.summary(),
            compress: config.compress ? { enabled: config.compress.enabled, backend: config.compress.backend } : null,
            nonStreamingUpstream: Boolean(config.nonStreamingUpstream)
          },
          health: health ? health.status() : [],
          circuit: breaker ? breaker.statuses() : [],
          usage: usageLogger
            ? usageLogger.aggregate({ days: 7 })
            : { enabled: false }
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        res.setHeader('cache-control', 'no-store');
        sendJson(res, 200, { ok: true, config: getConfigText ? getConfigText() : '' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reload') {
        const text = await readRawBody(req, config);
        const validation = onReloadValidate
          ? await onReloadValidate(text)
          : 'reload not configured';
        if (typeof validation === 'string' && validation) {
          sendJson(res, 400, { ok: false, error: validation });
          return;
        }
        sendJson(res, 200, { ok: true, message: '配置已校验，正在热加载' });
        setImmediate(() => {
          Promise.resolve()
            .then(() => onReloadCommit?.(validation))
            .catch((e) => logEvent(config, {
              event: 'admin_reload_failed',
              reason: String(e?.message || e).slice(0, 300)
            }));
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        sendJson(res, 200, { ok: true, message: '正在重启路由服务' });
        setImmediate(() => {
          Promise.resolve()
            .then(() => onRestartCommit?.())
            .catch((e) => logEvent(config, {
              event: 'admin_restart_failed',
              reason: String(e?.message || e).slice(0, 300)
            }));
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
          try { body = await readJson(req, config); } catch { body = {}; }
          const result = codex.restore({ file: body?.file, confirm: Boolean(body?.confirm) });
          logEvent(config, { event: 'codex_restore', restored: result.restored, method: result.method || null });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJson(req, config);
        validateResponsesRequest(body);
        const route = resolveRoute(config, maybeUpgradeModel(body).model);
        if (health) reorderProvidersByHealth(route, health);
        const affinityKey = providerAffinity.keyFor(body, req.headers);
        providerAffinity.apply(route, affinityKey);
        const tracker = usageLogger
          ? createRequestTracker(body.model, {
              streamed: body.stream === true,
              pricing: route.entry?.pricing
            })
          : null;
        tracker?.annotate({ conversation_key_hash: affinityKey });
        const lifecycle = createClientDisconnectScope(req, res);
        try {
          await forward(res, body, route, config, fetchImpl, {
            client: ctxClient,
            storeDir: ctxStoreDir,
            cache: ctxCache,
            safety: ctxSafety,
            stats: ctxStats,
            breaker,
            tracker,
            affinityKey,
            cacheDiagnostics,
            signal: lifecycle.signal,
            onProviderSuccess: (provider) => providerAffinity.recordSuccess(affinityKey, provider)
          });
        } catch (error) {
          if (!lifecycle.signal.aborted) {
            tracker?.record({ ok: false, status: 502, error: String(error?.message || 'internal error').slice(0, 200) });
          }
          throw error;
        } finally {
          lifecycle.dispose();
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
      if (error instanceof RequestValidationError) {
        if (error.closeConnection) res.setHeader('connection', 'close');
        sendJson(res, error.statusCode, { error: { message: error.message } });
      } else if (error instanceof UnknownModelError) {
        sendJson(res, 400, { error: { message: error.message } });
      } else if (error instanceof RouteConfigurationError) {
        sendJson(res, error.statusCode || 503, { error: { message: error.message } });
      }
      else sendJson(res, 500, { error: { message: error.message || 'internal error' } });
    }
  });
  server.__routerFlushUsage = () => usageLogger?.flush() ?? Promise.resolve();
  server.__routerCleanup = async () => {
    health?.stop();
    await usageLogger?.close();
  };
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
  res.writeHead(200, {
    'content-type': ADMIN_MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  });
  res.end(readFileSync(file));
}

function reorderProvidersByHealth(route, health) {
  if (!route.providers || route.providers.length < 2) return;
  const healthy = route.providers.filter((p) => !health.isUnhealthy(
    route.model,
    p.endpoint,
    p.apiKey
  ));
  const down = route.providers.filter((p) => health.isUnhealthy(
    route.model,
    p.endpoint,
    p.apiKey
  ));
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
    await forwardRoute(res, effective, route, config, fetchImpl, body.model, {
      replay,
      breaker: compression?.breaker,
      tracker: compression?.tracker,
      onProviderSuccess: compression?.onProviderSuccess,
      cacheDiagnostics: compression?.cacheDiagnostics,
      signal: compression?.signal
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
  const compressed = await maybeCompressInput(
    upgraded,
    config,
    compression?.client,
    compression?.storeDir,
    compression?.cache,
    compression?.safety,
    compression?.stats,
    {
      safetyKey: compression?.affinityKey,
      onMeta: (meta) => compression?.tracker?.annotate({
        compression_checkpoint_id: meta.checkpoint_id,
        compression_checkpoint_reused: meta.checkpoint_reused,
        compression_prefix_changed: meta.prefix_changed,
        compression_tokens_before: meta.tokens_before,
        compression_tokens_after: meta.tokens_after,
        compression_tokens_saved: meta.tokens_saved
      })
    }
  );
  await forwardRoute(res, compressed, route, config, fetchImpl, body.model, {
    replay,
    breaker: compression?.breaker,
    tracker: compression?.tracker,
    onProviderSuccess: compression?.onProviderSuccess,
    cacheDiagnostics: compression?.cacheDiagnostics,
    signal: compression?.signal
  });
}

async function readJson(req, config) {
  const text = await readBody(req, config);
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestValidationError('invalid JSON request body');
  }
}

async function readRawBody(req, config) {
  return readBody(req, config);
}

export async function readBody(req, config) {
  const maxBytes = Number.isFinite(config?.limits?.maxRequestBodyBytes)
    && config.limits.maxRequestBodyBytes > 0
    ? config.limits.maxRequestBodyBytes
    : 64 * 1024 * 1024;
  const idleMs = Number.isFinite(config?.limits?.requestBodyIdleMs)
    && config.limits.requestBodyIdleMs > 0
    ? config.limits.requestBodyIdleMs
    : 120_000;
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestValidationError(
      `request body exceeds ${maxBytes} bytes`,
      413,
      { closeConnection: true }
    );
  }
  const chunks = [];
  let total = 0;
  const iterator = req[Symbol.asyncIterator]();
  let iteratorClosed = false;
  const closeIterator = () => {
    if (iteratorClosed) return;
    iteratorClosed = true;
    try {
      const closing = iterator.return?.();
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
    } catch {
      // Iterator cleanup must never hide the validation error.
    }
  };
  try {
    while (true) {
      let timer = null;
      const next = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new RequestValidationError(
            `request body idle timeout after ${idleMs} ms`,
            408,
            { closeConnection: true }
          )), idleMs);
          timer.unref?.();
        })
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (next.done) {
        iteratorClosed = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        throw new RequestValidationError(
          `request body exceeds ${maxBytes} bytes`,
          413,
          { closeConnection: true }
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    closeIterator();
    throw error;
  }
}

class RequestValidationError extends Error {
  constructor(message, statusCode = 400, { closeConnection = false } = {}) {
    super(message);
    this.name = 'RequestValidationError';
    this.statusCode = statusCode;
    this.closeConnection = closeConnection;
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
