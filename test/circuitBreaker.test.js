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

test('half-open probe success releases the next probe permit', () => {
  const cb = createCircuitBreaker({ ...cfg, circuitBreaker: { ...cfg.circuitBreaker, timeoutMs: 0 } });
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  cb.recordFailure(key);
  cb.recordFailure(key);
  cb.recordFailure(key);
  const firstProbe = cb.allow(key);
  assert.deepEqual(firstProbe, { allowed: true, usedHalfOpenPermit: true });
  assert.equal(cb.allow(key).allowed, false, 'first probe occupies the only half-open permit');
  cb.recordSuccess(key, firstProbe.usedHalfOpenPermit);
  const secondProbe = cb.allow(key);
  assert.deepEqual(secondProbe, { allowed: true, usedHalfOpenPermit: true }, 'success result releases the next probe permit');
  assert.equal(cb.allow(key).allowed, false, 'second probe occupies the only half-open permit');
  cb.recordSuccess(key, secondProbe.usedHalfOpenPermit);
  assert.equal(cb.isAvailable(key), true, 'second successful probe closes breaker');
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

test('keyOf builds the breaker key from model and endpoint', () => {
  const cb = createCircuitBreaker(cfg);
  assert.equal(
    cb.keyOf('gpt-5.6-luna', 'https://x/v1/responses'),
    'gpt-5.6-luna::https://x/v1/responses'
  );
});

test('keyOf isolates credentials that share the same endpoint without exposing them', () => {
  const cb = createCircuitBreaker(cfg);
  const primary = cb.keyOf('gpt-5.6-luna', 'https://x/v1/responses', 'primary-secret');
  const backup = cb.keyOf('gpt-5.6-luna', 'https://x/v1/responses', 'backup-secret');
  assert.notEqual(primary, backup);
  assert.equal(primary.includes('primary-secret'), false);
  assert.equal(backup.includes('backup-secret'), false);
});

test('reset clears breaker state', () => {
  const cb = createCircuitBreaker({ ...cfg, circuitBreaker: { ...cfg.circuitBreaker, failureThreshold: 1 } });
  const key = 'gpt-5.6-luna::https://x/v1/responses';
  cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), false);
  cb.reset(key);
  assert.equal(cb.isAvailable(key), true);
});

test('forceProbe allows one request immediately when open and records success path', () => {
  const cb = createCircuitBreaker({ ...cfg, circuitBreaker: { ...cfg.circuitBreaker, timeoutMs: 600000 } });
  const key = 'gpt-5.6-sol::https://ergou/v1/responses';
  for (let i = 0; i < 3; i++) cb.recordFailure(key);
  assert.equal(cb.isAvailable(key), false);
  const probe = cb.allow(key, { forceProbe: true });
  assert.equal(probe.allowed, true);
  assert.equal(probe.usedHalfOpenPermit, true);
  assert.equal(cb.allow(key).allowed, false, 'only one forced probe is granted');
  cb.recordSuccess(key, true);
  cb.recordSuccess(key, true);
  assert.equal(cb.isAvailable(key), true, 'success threshold closes breaker after forced probe');
});
