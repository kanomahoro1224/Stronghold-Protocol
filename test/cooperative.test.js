// test/cooperative.test.js — the process-wide CPU-slice queue (server/cooperative.js) and its scheduler hook.
//
// Matches are CPU work on the main thread: a room that simulates for 50 ms in one go delays every socket, heartbeat
// and health check behind it. CooperativeQueue gives all real matches one shared FIFO with a small time budget, so a
// new macrotask turn runs I/O between slices instead of one timer per room.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CooperativeQueue, matchWorkQueue } from '../server/cooperative.js';
import { RealScheduler } from '../server/match/scheduler.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the queue runs FIFO within one turn and honours the task cap', async () => {
  const q = new CooperativeQueue({ budgetMs: 1000, maxTasks: 2 });
  const order = [];
  q.enqueue(() => order.push(1));
  q.enqueue(() => order.push(2));
  q.enqueue(() => order.push(3));
  await tick();
  assert.deepEqual(order, [1, 2], 'maxTasks bounds one turn');
  await tick();
  assert.deepEqual(order, [1, 2, 3], 'the rest runs on the next turn');
});

test('the time budget stops a turn even when the task cap is far away', async () => {
  let now = 0;
  const q = new CooperativeQueue({ budgetMs: 4, maxTasks: 1000, now: () => now });
  const ran = [];
  for (let i = 0; i < 10; i++) q.enqueue(() => { ran.push(i); now += 3; });
  await tick();
  assert.ok(ran.length < 10, `the budget broke the turn (ran ${ran.length})`);
  for (let i = 0; i < 20 && ran.length < 10; i++) await tick();
  assert.equal(ran.length, 10, 'everything still runs, one bounded turn at a time');
});

test('a removed token never runs and cancels the pending turn', async () => {
  const cancelled = [];
  const q = new CooperativeQueue({ cancel: (h) => { cancelled.push(h); clearImmediate(h); } });
  const token = q.enqueue(() => { throw new Error('removed work must not run'); });
  q.remove(token);
  await tick();
  assert.equal(cancelled.length, 1, 'the scheduled turn was cancelled, not left dangling');
});

test('the real scheduler routes setWork through the shared queue and dispose clears it', async () => {
  const sched = new RealScheduler({ now: Date.now });
  const ran = [];
  const h = sched.setWork(() => ran.push('work'));
  assert.ok(h, 'setWork returns a handle');
  await tick();
  assert.deepEqual(ran, ['work']);
  const slow = sched.setWork(() => ran.push('late'));
  sched.dispose();
  await tick();
  assert.deepEqual(ran, ['work'], 'dispose removes queued work');
  assert.equal(sched.clearTimeout(slow), undefined);
  sched.dispose();
});

test('the shared queue is one process-wide instance, and custom schedulers stay untouched', () => {
  assert.ok(matchWorkQueue instanceof CooperativeQueue);
  // a scheduler that only knows timers keeps working: RealScheduler.setWork is additive, and MatchInfra.laterWork
  // falls back to later(0, …) when the hook is absent (virtual/custom schedulers in tests and replays)
  const custom = { setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {}, setInterval: () => 2, clearInterval() {} };
  assert.equal(custom.setWork, undefined);
});
