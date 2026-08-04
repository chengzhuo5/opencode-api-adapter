import http from 'node:http';
import path from 'node:path';
import { resolveRoute, UnknownModelError } from './routes.js';
import { sseEncode } from './sse.js';
import { responsesToAnthropicRequest } from './translate/responsesToAnthropic.js';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from './translate/anthropicToResponses.js';
import { maybeUpgradeModel, minimizeHistoryImages, stripAllImages, DEEPSEEK_MODELS, truncateHistory, forwardWithFallback, relayUpstream, relayError, sendJson } from './fallback.js';
import { logEvent } from './logger.js';
import { maybeCompressInput, loadOutput } from './compression.js';
import { createLeanCtxClient } from './leanCtxClient.js';

export function createRouter(config, { fetchImpl = globalThis.fetch } = {}) {
  const compressEnabled = config?.compress?.enabled && config.compress.backend === 'lean-ctx';
  const ctxCache = compressEnabled ? new Map() : null;
  const ctxSafety = compressEnabled ? new Map() : null;
  const ctxStats = compressEnabled ? { total_chars_before: 0, total_chars_after: 0, total_tokens_before: 0, total_tokens_after: 0, requests: 0 } : null;
  const ctxStoreDir = compressEnabled && config.compress.storeDir ? path.resolve(config.compress.storeDir) : null;
  const ctxClient = compressEnabled ? createLeanCtxClient({ baseUrl: config.compress.baseUrl, token: config.compress.token, timeoutMs: config.compress.timeoutMs }) : null;
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
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJson(req);
        const route = resolveRoute(config, maybeUpgradeModel(body).model);
        await forward(res, body, route, config, fetchImpl, { client: ctxClient, storeDir: ctxStoreDir, cache: ctxCache, safety: ctxSafety, stats: ctxStats });
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

async function forward(res, body, route, config, fetchImpl, compression) {
  if (route.upstream === 'messages') {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    };
    const signal = AbortSignal.timeout(config.timeouts?.requestMs || 600000);
    const requestBody = responsesToAnthropicRequest(body);
    const upstream = await fetchImpl(route.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal });
    if (!upstream.ok) {
      await relayError(res, upstream);
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      await translateAnthropicStreamToResponses(upstream.body, body.model, (event, data) => res.write(sseEncode(event, data)));
      res.end();
    } else {
      const message = await upstream.json();
      sendJson(res, upstream.status, anthropicToResponsesObject(message, body.model));
    }
    return;
  }
  let upgraded = maybeUpgradeModel(body);
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
  const maxHistory = config.models?.[upgraded.model]?.maxHistoryMessages;
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
  await forwardWithFallback(res, compressed, route, config, fetchImpl, body.model);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
