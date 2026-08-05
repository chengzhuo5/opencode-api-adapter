import test from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from '../src/circuitBreaker.js';

const cfg = { circuitBreaker: { enabled: true, failureThreshold: 3, successThreshold: 2, timeoutMs: 60000, errorRateThreshold: 0.6, minRequests: 5 } };

test('disabled breaker always allows and ignores records', () => {
  const cb = createCircuitBreaker({ circuitBreaker: { enabled: false } });
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  assert.deepEqual(cb.allow(key), { allowed: true, usedHalfOpenPermit: false });
  cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), true);
});

test('opens after consecutive failures and rejects requests', () => {
  const cb = createCircuitBreaker(cfg);
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  for (let i = 0; i < 2; i++) {
    assert.equal(cb.allow(key).allowed, true);
    cb.recordFailure(key);
  }
  assert.equal(cb.isAvailable(key), true, 'still closed under threshold');
  assert.equal(cb.allow(key).allowed, true);
  cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), false, 'opened after 3 consecutive failures');
  assert.equal(cb.allow(key).allowed, false);
});

test('recovers via half-open probe after timeout', () => {
  const cb = createCircuitBreaker({ ...cfg, circuitBreaker: { ...cfg.circuitBreaker, timeoutMs: 0 } });
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  cb.recordFailure(key);
  cb.recordFailure(key);
  cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), false);
  const probe = cb.allow(key);
  assert.equal(probe.allowed, true);
  assert.equal(probe.usedHalfOpenPermit, true, 'open timeout elapsed, half-open probe granted');
  assert.equal(cb.allow(key).allowed, false, 'only one half-open permit at a time');
  cb.recordSuccess(key, true);
  cb.recordSuccess(key, true);
  assert.equal(cb.isAvailable(key), true, 'half-open success threshold closes breaker');
});

test('half-open failure reopens breaker', () => {
  const cb = createCircuitBreaker({ ...cfg, circuitBreaker: { ...cfg.circuitBreaker, timeoutMs: 0 } });
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  cb.recordFailure(key);
  cb.recordFailure(key);
  cb.recordFailure(key);
  const probe = cb.allow(key);
  cb.recordFailure(key, probe.usedHalfOpenPermit);
  assert.equal(cb.isAvailable(key), false, 'half-open failure returns to open');
});

test('success in closed state resets failure streak', () => {
  const cb = createCircuitBreaker(cfg);
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  cb.recordFailure(key);
  cb.recordFailure(key);
  cb.recordSuccess(key);
  cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), true, 'streak reset by success');
});

test('opens on sustained error rate even below consecutive threshold', () => {
  const cb = createCircuitBreaker({
    circuitBreaker: { enabled: true, failureThreshold: 100, successThreshold: 2, timeoutMs: 60000, errorRateThreshold: 0.6, minRequests: 5 }
  });
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  // 6 次请求 4 次失败：错误率 0.67 >= 0.6 且达到 minRequests
  cb.recordSuccess(key);
  cb.recordFailure(key);
  cb.recordSuccess(key);
  cb.recordFailure(key);
  cb.recordFailure(key);
  cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), false, 'error rate threshold should open breaker');
});

test('statuses expose breaker state', () => {
  const cb = createCircuitBreaker(cfg);
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  cb.recordFailure(key);
  const statuses = cb.statuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].key, key);
  assert.equal(statuses[0].state, 'closed');
  assert.equal(statuses[0].failedRequests, 1);
});

test('reset clears breaker state', () => {
  const cb = createCircuitBreaker({ ...cfg, circuitBreaker: { ...cfg.circuitBreaker, failureThreshold: 1 } });
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), false);
  cb.reset(key);
  assert.equal(cb.isAvailable(key), true);
});
