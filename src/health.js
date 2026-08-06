import { createHash, createHmac, randomBytes } from 'node:crypto';
import { logEvent } from './logger.js';
import { resolveRoute } from './routes.js';

/**
 * 模型健康监控：定期探测指定 provider 是否可用。
 * - 探测失败（网络错误/非 2xx/无 response.completed）→ 标记 unhealthy；
 * - 探测成功 → 恢复 healthy；
 * - 路由转发前查询状态，把 unhealthy 的 provider 排到末尾（由 healthy 的 provider 优先）。
 */
export function createHealthMonitor({ config, fetchImpl = globalThis.fetch, onStatusChange = () => {} }) {
  const unhealthy = new Set(); // `model::endpoint`
  const watched = new Map();   // key -> { model, endpoint, apiKey }
  const hc = config?.healthCheck || {};
  const intervalMs = hc.intervalMs || 300000;
  const timeoutMs = hc.timeoutMs || 20000;
  const identitySecret = config?.apiKey
    ? createHash('sha256')
        .update('opencode-api-adapter/health/v1\0')
        .update(String(config.apiKey))
        .digest()
    : randomBytes(32);

  const keyOf = (model, endpoint, apiKey) => {
    const credential = createHmac('sha256', identitySecret)
      .update(String(endpoint))
      .update('\0')
      .update(String(apiKey ?? ''))
      .digest('hex')
      .slice(0, 16);
    return `${model}::${endpoint}::credential:${credential}`;
  };

  // 收集探测目标：显式列表优先，否则扫描 models 中 endpoint 为数组的模型，
  // 探测其所有 provider（当前场景即 opencode 优先、官方兜底的数组配置）。
  const collect = () => {
    const targets = [];
    const explicit = Array.isArray(hc.models) ? hc.models : null;
    const models = explicit || Object.entries(config.models || {})
      .filter(([, entry]) => entry && Array.isArray(entry.endpoint))
      .map(([model]) => model);
    for (const model of models) {
      let route;
      try {
        route = resolveRoute(config, model);
      } catch {
        continue;
      }
      for (const provider of route.providers || []) {
        targets.push({
          model,
          upstream: route.upstream,
          endpoint: provider.endpoint,
          apiKey: provider.apiKey
        });
      }
    }
    return targets;
  };

  const refreshWatched = () => {
    watched.clear();
    for (const t of collect()) watched.set(keyOf(t.model, t.endpoint, t.apiKey), t);
  };

  async function probe(key) {
    let target = watched.get(key);
    if (!target) {
      refreshWatched();
      target = watched.get(key);
    }
    if (!target) return;
    let healthy = false;
    try {
      const probe = buildProbeRequest(target);
      const res = await fetchImpl(target.endpoint, {
        method: 'POST',
        headers: probe.headers,
        body: JSON.stringify(probe.body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (target.upstream === 'responses'
        && res.ok
        && res.headers.get('content-type')?.includes('text/event-stream')) {
        healthy = await readResponsesProbeTerminal(res.body);
      } else if (res.ok) {
        healthy = true;
      }
    } catch {
      healthy = false;
    }
    const wasUnhealthy = unhealthy.has(key);
    if (healthy && wasUnhealthy) {
      unhealthy.delete(key);
      logEvent(config, { event: 'provider_health', model: target.model, endpoint: target.endpoint, status: 'recovered' });
      onStatusChange(key, true);
    } else if (!healthy && !wasUnhealthy) {
      unhealthy.add(key);
      logEvent(config, { event: 'provider_health', model: target.model, endpoint: target.endpoint, status: 'down' });
      onStatusChange(key, false);
    } else {
      logEvent(config, { event: 'provider_health', model: target.model, endpoint: target.endpoint, status: healthy ? 'up' : 'down', unchanged: true });
    }
    return healthy;
  }

  async function probeAll() {
    refreshWatched();
    return Promise.all([...watched.keys()].map(async (key) => ({
      key,
      healthy: await probe(key)
    })));
  }

  let timer = null;
  function start() {
    refreshWatched();
    if (!hc.enabled) return;
    // 启动时立即探测一次，然后按 intervalMs 周期探测
    probeAll().catch(() => {});
    timer = setInterval(() => { probeAll().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return timer;
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    isUnhealthy: (model, endpoint, apiKey) => unhealthy.has(keyOf(model, endpoint, apiKey)),
    probe,
    probeAll,
    status: () => [...watched.entries()].map(([key, target]) => ({
      key,
      model: target.model,
      endpoint: target.endpoint,
      unhealthy: unhealthy.has(key)
    })),
    start,
    stop,
    watchedCount: () => watched.size
  };
}

function buildProbeRequest(target) {
  if (target.upstream === 'messages') {
    return {
      headers: {
        'content-type': 'application/json',
        'x-api-key': target.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: target.model,
        max_tokens: 1,
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }]
      }
    };
  }
  if (target.upstream === 'chat') {
    return {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.apiKey}`
      },
      body: {
        model: target.model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }]
      }
    };
  }
  return {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${target.apiKey}`
    },
    body: {
      model: target.model,
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok' }] }]
    }
  };
}

async function readResponsesProbeTerminal(body) {
  const reader = body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      const terminal = buffer.match(/response\.(completed|incomplete|failed)/);
      if (terminal) return terminal[1] !== 'failed';
      if (buffer.length > 8192) buffer = buffer.slice(-4096);
    }
  } finally {
    try { await reader.cancel(); } catch { /* noop */ }
    reader.releaseLock();
  }
}
