import http from 'node:http';
import { resolveRoute, UnknownModelError } from './routes.js';
import { sseEncode } from './sse.js';
import { responsesToAnthropicRequest } from './translate/responsesToAnthropic.js';
import { anthropicToResponsesObject, translateAnthropicStreamToResponses } from './translate/anthropicToResponses.js';
import { maybeUpgradeModel, forwardWithFallback, relayUpstream, relayError, sendJson } from './fallback.js';
import { logEvent } from './logger.js';

export function createRouter(config, { fetchImpl = globalThis.fetch } = {}) {
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
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJson(req);
        const route = resolveRoute(config, body.model);
        await forward(res, body, route, config, fetchImpl);
        return;
      }
      sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
    } catch (error) {
      if (error instanceof UnknownModelError) sendJson(res, 400, { error: { message: error.message } });
      else sendJson(res, 500, { error: { message: error.message || 'internal error' } });
    }
  });
}

async function forward(res, body, route, config, fetchImpl) {
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
  const upgraded = maybeUpgradeModel(body);
  if (upgraded !== body) {
    logEvent(config, {
      event: 'multimodal_fallback',
      model: body.model,
      fallback_model: upgraded.model,
      reason: 'image_input'
    });
  }
  await forwardWithFallback(res, upgraded, route, config, fetchImpl, body.model);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
