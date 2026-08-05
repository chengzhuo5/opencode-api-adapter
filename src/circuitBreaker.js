/**
 * 被动熔断器（passive circuit breaker）。
 *
 * 与 health.js 的主动探测互补：
 * - health.js 定时发探针，把探测失败的 provider 排到末尾；
 * - 这里由真实请求的成败驱动，连续失败/错误率超阈值后直接跳过该 provider，
 *   熔断时间到期后放行一个半开探测请求，成功达到阈值即恢复。
 *
 * 状态机：closed（正常）→ open（熔断，跳过）→ half_open（放行 1 个探测）
 * → closed（探测成功）或 → open（探测失败）。
 */

const DEFAULT_CONFIG = {
  enabled: false,
  failureThreshold: 3,
  successThreshold: 2,
  timeoutMs: 60000,
  errorRateThreshold: 0.6,
  minRequests: 5
};

export function createCircuitBreaker(config = {}, { onStateChange = () => {} } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config?.circuitBreaker || {}) };
  /** @type {Map<string, object>} */
  const breakers = new Map();

  const stateOf = (key) => {
    let s = breakers.get(key);
    if (!s) {
      s = {
        state: 'closed',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        failedRequests: 0,
        lastOpenedAt: 0,
        halfOpenPermits: 0
      };
      breakers.set(key, s);
    }
    return s;
  };

  const keyOf = (model, endpoint) => `${model}::${endpoint}`;

  /**
   * 请求前调用。返回 { allowed, usedHalfOpenPermit }。
   * usedHalfOpenPermit 必须回传给 recordSuccess/recordFailure，
   * 用于释放半开探测名额。
   */
  function allow(key) {
    if (!cfg.enabled) return { allowed: true, usedHalfOpenPermit: false };
    const s = stateOf(key);
    if (s.state === 'closed') return { allowed: true, usedHalfOpenPermit: false };
    if (s.state === 'open') {
      if (Date.now() - s.lastOpenedAt >= cfg.timeoutMs) {
        s.state = 'half_open';
        s.consecutiveSuccesses = 0;
        // 当前请求占用唯一的半开探测名额，结果返回后由 record* 释放
        s.halfOpenPermits = 0;
        onStateChange(key, 'half_open', s);
        return { allowed: true, usedHalfOpenPermit: true };
      }
      return { allowed: false, usedHalfOpenPermit: false };
    }
    // half_open：同一时间只放行一个探测请求
    if (s.halfOpenPermits > 0) {
      s.halfOpenPermits -= 1;
      return { allowed: true, usedHalfOpenPermit: true };
    }
    return { allowed: false, usedHalfOpenPermit: false };
  }

  function recordSuccess(key, usedHalfOpenPermit = false) {
    if (!cfg.enabled) return;
    const s = stateOf(key);
    s.totalRequests += 1;
    if (usedHalfOpenPermit) s.halfOpenPermits += 1;
    if (s.state === 'half_open') {
      s.consecutiveSuccesses += 1;
      s.consecutiveFailures = 0;
      if (s.consecutiveSuccesses >= cfg.successThreshold) {
        s.state = 'closed';
        s.consecutiveSuccesses = 0;
        s.failedRequests = 0;
        onStateChange(key, 'closed', s);
      }
      return;
    }
    s.consecutiveFailures = 0;
  }

  function recordFailure(key, usedHalfOpenPermit = false) {
    if (!cfg.enabled) return;
    const s = stateOf(key);
    s.totalRequests += 1;
    s.failedRequests += 1;
    if (usedHalfOpenPermit) s.halfOpenPermits += 1;
    if (s.state === 'half_open') {
      s.state = 'open';
      s.lastOpenedAt = Date.now();
      s.consecutiveFailures = 0;
      s.consecutiveSuccesses = 0;
      onStateChange(key, 'open', s);
      return;
    }
    s.consecutiveFailures += 1;
    const errorRate = s.totalRequests >= cfg.minRequests
      ? s.failedRequests / s.totalRequests
      : 0;
    if (s.consecutiveFailures >= cfg.failureThreshold
        || (s.totalRequests >= cfg.minRequests && errorRate >= cfg.errorRateThreshold)) {
      s.state = 'open';
      s.lastOpenedAt = Date.now();
      s.consecutiveFailures = 0;
      s.consecutiveSuccesses = 0;
      onStateChange(key, 'open', s);
    }
  }

  function isAvailable(key) {
    if (!cfg.enabled) return true;
    const s = breakers.get(key);
    if (!s) return true;
    return s.state !== 'open';
  }

  function reset(key) {
    breakers.delete(key);
  }

  function statuses() {
    return [...breakers.entries()].map(([key, s]) => ({
      key,
      state: s.state,
      consecutiveFailures: s.consecutiveFailures,
      consecutiveSuccesses: s.consecutiveSuccesses,
      totalRequests: s.totalRequests,
      failedRequests: s.failedRequests
    }));
  }

  return { allow, recordSuccess, recordFailure, isAvailable, reset, statuses, keyOf };
}
