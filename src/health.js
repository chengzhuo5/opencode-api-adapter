import { logEvent } from './logger.js';

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

  const keyOf = (model, endpoint) => `${model}::${endpoint}`;

  // 收集探测目标：显式列表优先，否则扫描 models 中 endpoint 为数组的模型，
  // 探测其所有 provider（当前场景即 opencode 优先、官方兜底的数组配置）。
  const collect = () => {
    const targets = [];
    const explicit = Array.isArray(hc.models) ? hc.models : null;
    if (explicit) {
      for (const model of explicit) {
        const entry = config.models?.[model];
        if (!entry) continue;
        for (const p of toProviders(entry)) targets.push({ model, ...p });
      }
      return targets;
    }
    for (const [model, entry] of Object.entries(config.models || {})) {
      if (!entry || !Array.isArray(entry.endpoint)) continue;
      for (const p of toProviders(entry)) targets.push({ model, ...p });
    }
    return targets;
  };

  const toProviders = (entry) => {
    const bases = Array.isArray(entry.endpoint) ? entry.endpoint : [entry.endpoint];
    return bases.filter((b) => b).map((b) => {
      if (typeof b === 'object') {
        return { endpoint: `${b.url}/responses`, apiKey: b.apiKey };
      }
      return { endpoint: `${b}/responses`, apiKey: entry.apiKey };
    });
  };

  const refreshWatched = () => {
    watched.clear();
    for (const t of collect()) watched.set(keyOf(t.model, t.endpoint), t);
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
      const res = await fetchImpl(target.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` },
        body: JSON.stringify({
          model: target.model,
          stream: true,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok' }] }]
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
        const text = await res.text();
        healthy = text.includes('response.completed');
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
    const results = [];
    for (const key of watched.keys()) results.push({ key, healthy: await probe(key) });
    return results;
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
    isUnhealthy: (model, endpoint) => unhealthy.has(keyOf(model, endpoint)),
    probe,
    probeAll,
    start,
    stop,
    watchedCount: () => watched.size
  };
}
