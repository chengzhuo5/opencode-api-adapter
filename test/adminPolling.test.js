import test from 'node:test';
import assert from 'node:assert/strict';
import { createPollGate } from '../admin/polling.js';

test('poll gate shares one in-flight promise across overlapping refreshes', async () => {
  let calls = 0;
  let resolveTask;
  const task = () => {
    calls += 1;
    if (calls > 1) return Promise.resolve('ok');
    return new Promise((resolve) => { resolveTask = resolve; });
  };
  const poll = createPollGate(task);
  const first = poll('status');
  const second = poll('status');
  assert.equal(first, second);
  assert.equal(calls, 0, 'task starts on the next microtask');
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveTask('ok');
  assert.equal(await first, 'ok');
  assert.equal(await poll('status'), 'ok');
  assert.equal(calls, 2, 'a later refresh starts after the previous one settles');
});

test('poll gate clears after rejection and can retry', async () => {
  let calls = 0;
  const poll = createPollGate(async () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
    return 'recovered';
  });
  await assert.rejects(poll(), /offline/);
  assert.equal(await poll(), 'recovered');
  assert.equal(calls, 2);
});

test('poll gate skips work while the page is paused', async () => {
  let hidden = true;
  let calls = 0;
  const poll = createPollGate(async () => {
    calls += 1;
    return 'ok';
  }, { isPaused: () => hidden });
  assert.equal(poll(), null);
  assert.equal(calls, 0);
  hidden = false;
  assert.equal(await poll(), 'ok');
  assert.equal(calls, 1);
});
