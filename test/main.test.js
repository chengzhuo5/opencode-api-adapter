import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startRouter } from '../src/main.js';

const ROOT_DIR = path.resolve('.');

function testConfig(extra = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    apiBaseUrl: 'https://x/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    catalogFile: 'catalog.json',
    models: {},
    usageLog: { enabled: false },
    compress: { enabled: false },
    healthCheck: { enabled: false },
    circuitBreaker: { enabled: false },
    ...extra
  };
}

async function startTestRouter(config, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-main-'));
  const configPath = path.join(dir, 'config.json');
  const originalText = JSON.stringify({
    ...config,
    catalogFile: path.join(dir, 'catalog.json')
  }, null, 2);
  writeFileSync(configPath, originalText);
  const oldKey = process.env.OPENCODE_GO_API_KEY;
  process.env.OPENCODE_GO_API_KEY = 'test-key';
  const router = await startRouter({
    configPath,
    rootDir: ROOT_DIR,
    templateFile: path.join(ROOT_DIR, 'catalog-template.json'),
    adminDir: path.join(ROOT_DIR, 'admin'),
    log: { log() {}, error() {} },
    ...options
  });
  if (!router.server.listening) await once(router.server, 'listening');
  return {
    dir,
    configPath,
    originalText,
    router,
    base: `http://127.0.0.1:${router.server.address().port}`,
    async cleanup() {
      await router.stop();
      if (oldKey === undefined) delete process.env.OPENCODE_GO_API_KEY;
      else process.env.OPENCODE_GO_API_KEY = oldKey;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('reload rejects a fully invalid candidate without overwriting the active config', async () => {
  const ctx = await startTestRouter(testConfig());
  try {
    const catalogPath = path.join(ctx.dir, 'catalog.json');
    const originalCatalog = readFileSync(catalogPath, 'utf8');
    const candidate = JSON.stringify({
      ...JSON.parse(ctx.originalText),
      port: 70_000,
      models: {
        'gpt-5.6-luna': {
          upstream: 'responses',
          contextWindow: 123_456
        }
      }
    });
    const response = await fetch(ctx.base + '/api/reload', {
      method: 'POST',
      body: candidate
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /invalid port/i);
    assert.equal(readFileSync(ctx.configPath, 'utf8'), ctx.originalText);
    assert.equal(
      readFileSync(catalogPath, 'utf8'),
      originalCatalog,
      'validation must not publish a candidate catalog before commit'
    );
    assert.equal((await fetch(ctx.base + '/healthz')).status, 200);
  } finally {
    await ctx.cleanup();
  }
});

test('reload rolls back to the previous listener when the candidate port cannot bind', async () => {
  const originalPort = await freePort();
  const occupiedPort = await freePort();
  const blocker = net.createServer();
  blocker.listen(occupiedPort, '127.0.0.1');
  await once(blocker, 'listening');
  const ctx = await startTestRouter(testConfig({ port: originalPort }));
  const originalServer = ctx.router.server;
  const originalCatalog = readFileSync(path.join(ctx.dir, 'catalog.json'), 'utf8');
  try {
    const candidate = JSON.stringify({
      ...JSON.parse(ctx.originalText),
      port: occupiedPort,
      models: {
        'gpt-5.6-luna': {
          upstream: 'responses',
          contextWindow: 123_456
        }
      }
    }, null, 2);
    const response = await fetch(ctx.base + '/api/reload', {
      method: 'POST',
      body: candidate
    });
    assert.equal(response.status, 200);
    assert.match((await response.json()).message, /已校验/);

    await withTimeout(waitUntil(() => (
      ctx.router.server !== originalServer
      && ctx.router.server?.listening
    )), 'rollback listener');
    assert.equal(ctx.router.server.address().port, originalPort);
    assert.equal(readFileSync(ctx.configPath, 'utf8'), ctx.originalText);
    assert.equal(readFileSync(path.join(ctx.dir, 'catalog.json'), 'utf8'), originalCatalog);
    assert.equal((await fetch(ctx.base + '/healthz')).status, 200);
  } finally {
    await ctx.cleanup();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('hot restart lets an active SSE generation drain while the replacement takes over', async () => {
  const port = await freePort();
  let upstreamController = null;
  let upstreamCancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(new TextEncoder().encode(
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"r1","model":"deepseek-v4-flash","status":"in_progress"}}\n\n'
      ));
    },
    cancel() {
      upstreamCancelled = true;
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
  const ctx = await startTestRouter(testConfig({ port }), { fetchImpl });
  try {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
    const responsePromise = once(request, 'response').then(([response]) => response);
    request.end(JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: 'finish across restart' }]
    }));
    const response = await responsePromise;
    let received = '';
    let paused = false;
    const firstEvent = new Promise((resolve) => {
      response.on('data', (chunk) => {
        received += chunk.toString('utf8');
        if (!paused && received.includes('event: response.created')) {
          paused = true;
          response.pause();
          resolve();
        }
      });
    });
    await withTimeout(firstEvent, 'first SSE event');

    const restart = ctx.router.restart();
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (!upstreamCancelled) {
      upstreamController.enqueue(new TextEncoder().encode(
        'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"r1","model":"deepseek-v4-flash","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
      ));
      upstreamController.close();
    }
    const responseEnded = once(response, 'end');
    response.resume();
    await withTimeout(responseEnded, 'active response end');
    await withTimeout(restart, 'replacement restart');

    assert.equal(upstreamCancelled, false, 'restart must not cancel the active generation');
    assert.match(received, /event: response\.completed/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  } finally {
    await ctx.cleanup();
  }
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function withTimeout(promise, label, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      timeoutMs
    );
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met');
}
