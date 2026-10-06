// test/state/persist.test.js — the single-writer write queue (server/state/persist.js).
//
// The queue is what keeps disk I/O out of the game loop, so the properties that matter are: calls coalesce per key
// (latest wins), the queue is bounded (the OLDEST pending entry is dropped, counted), a delete cancels a pending put,
// and nothing a store does can reach the caller as a throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PersistQueue, DEFAULT_MAX_PENDING } from '../../server/state/persist.js';
import { MemoryStore } from '../../server/state/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** A store that records the exact call order and can be made to fail. */
class SpyStore {
  constructor() { this.kind = 'spy'; this.calls = []; this.fail = null; this.closed = 0; }
  async put(key, obj) { this.calls.push(['put', key, obj]); if (this.fail) throw new Error(this.fail); }
  async del(key) { this.calls.push(['del', key]); if (this.fail) throw new Error(this.fail); }
  async get() { return null; }
  async list() { return []; }
  async close() { this.closed++; }
}

test('coalescing: a burst of writes for one key is ONE store call carrying the newest record', async () => {
  const store = new SpyStore();
  const q = new PersistQueue({ store, log: quiet });
  for (let i = 1; i <= 25; i++) q.enqueue('match:ABCD', { n: i });
  q.enqueue('match:WXYZ', { n: 1 });
  assert.equal(q.size, 2, 'two keys, two pending entries — never 26');
  assert.equal(q.stats().queued, 2);
  await q.idle();
  const puts = store.calls.filter((c) => c[0] === 'put');
  assert.equal(puts.length, 2, `one write per key (the drain starts on a microtask): ${JSON.stringify(store.calls)}`);
  assert.deepEqual(puts.map((c) => c[1]).sort(), ['match:ABCD', 'match:WXYZ']);
  assert.deepEqual(puts.find((c) => c[1] === 'match:ABCD')[2], { n: 25 }, 'the newest value of the key won');
  assert.equal(q.stats().written, 2);
  assert.equal(q.stats().dropped, 0);
});

test('bounded: over the cap the oldest pending entry is dropped and counted, and the queue never grows', async () => {
  const store = new SpyStore();
  const q = new PersistQueue({ store, cap: 3, log: quiet });
  const keys = ['match:A', 'match:B', 'match:C', 'match:D', 'match:E'];
  // the writes coalesce per KEY, so use distinct keys to make the queue grow at all
  for (const k of keys) q.enqueue(k, { k });
  assert.equal(q.size, 3, 'capped at 3 pending entries');
  assert.equal(q.stats().dropped, 2, 'the two oldest (A, B) were dropped');
  await q.idle();
  const written = store.calls.filter((c) => c[0] === 'put').map((c) => c[1]);
  assert.deepEqual(written, ['match:C', 'match:D', 'match:E'], 'the NEWEST entries are the ones that reached the store');
});

test('a newest-wins update moves its key to the back, so a drop takes the least recently written key', async () => {
  const store = new SpyStore();
  const q = new PersistQueue({ store, cap: 2, log: quiet });
  q.enqueue('match:A', { n: 1 });
  q.enqueue('match:B', { n: 1 });
  q.enqueue('match:A', { n: 2 }); // A is refreshed: B is now the oldest
  q.enqueue('match:C', { n: 1 }); // ... and B is what the cap drops
  await q.idle();
  const written = store.calls.filter((c) => c[0] === 'put').map((c) => c[1]);
  assert.deepEqual(written, ['match:A', 'match:C']);
  assert.equal(q.stats().dropped, 1);
});

test('a delete coalesces with a pending put: enqueue-then-remove writes nothing and deletes once', async () => {
  const store = new SpyStore();
  const q = new PersistQueue({ store, log: quiet });
  q.enqueue('match:ABCD', { n: 1 });
  q.remove('match:ABCD');
  assert.equal(q.size, 1, 'the put was replaced by the delete, not queued behind it');
  await q.idle();
  assert.deepEqual(store.calls, [['del', 'match:ABCD']], 'no write, one delete');
  assert.equal(q.stats().written, 0);
  assert.equal(q.stats().deleted, 1);

  // a delete of a key that was never queued still reaches the store (the room-disposal path)
  q.remove('match:NEVER');
  await q.idle();
  assert.deepEqual(store.calls.at(-1), ['del', 'match:NEVER']);
});

test('a failing store is counted, never thrown, and the queue keeps draining (no retry storm)', async () => {
  const store = new SpyStore();
  const q = new PersistQueue({ store, cap: 8, log: quiet });
  store.fail = 'disk on fire';
  assert.doesNotThrow(() => { q.enqueue('match:A', { a: 1 }); q.enqueue('match:B', { b: 1 }); });
  await q.idle();
  assert.equal(q.stats().errors, 2, 'both failures were counted');
  assert.equal(q.stats().lastError, 'disk on fire');
  assert.equal(q.stats().queued, 0, 'the failed entries were dropped, not retried');
  store.fail = null;
  q.enqueue('match:C', { c: 1 });
  await q.idle();
  assert.equal(q.stats().written, 1, 'the queue is still usable after a failure');
  assert.equal(store.calls.filter((c) => c[0] === 'put').length, 3);
});

test('enqueue never throws, even with a broken store object and after close()', async () => {
  const q = new PersistQueue({ store: { put: () => { throw new Error('sync boom'); }, del: async () => {} }, log: quiet });
  assert.equal(q.enqueue('match:A', { a: 1 }), true, 'accepted; the failure is the writer\'s problem');
  await q.idle();
  assert.equal(q.stats().errors, 1);
  assert.ok(q.stats().lastError.includes('sync boom'));
  await q.close();
  assert.equal(q.enqueue('match:B', {}), false, 'a closed queue refuses new work');
  assert.equal(q.stats().dropped, 1, 'and counts it');
});

test('close() flushes what is pending and closes the store; idle() is deterministic', async () => {
  const store = new MemoryStore({ log: quiet });
  const q = new PersistQueue({ store, log: quiet });
  q.enqueue('match:A', { a: 1 });
  q.remove('match:B');
  await q.close({ flushMs: 500 });
  assert.equal(store.writes, 1, 'the pending put was flushed before the store closed');
  assert.equal(store.deletes, 1);
  assert.equal(q.stats().queued, 0);
  assert.equal(q.stats().lastError, null);
});

test('the cap is a real number: a huge maxPending is not truncated into a negative 32-bit int', () => {
  const store = new MemoryStore({ log: quiet });
  // `Number(x) | 0` wraps above 2^31, so `SP_STATE_MAX_PENDING=3000000000` used to become a NEGATIVE int, `Math.max(1,…)`
  // turned that into a cap of 1, and the queue then kept a single pending entry and dropped nearly every write.
  assert.equal(new PersistQueue({ store, maxPending: 3e9, log: quiet }).cap, 3e9, 'a huge cap stays a real number');
  assert.equal(new PersistQueue({ store, maxPending: 4096.7, log: quiet }).cap, 4096, 'a fractional cap is floored');
  assert.equal(new PersistQueue({ store, maxPending: 0, log: quiet }).cap, 1, '0 keeps its old meaning (the smallest queue)');
  assert.equal(new PersistQueue({ store, maxPending: -5, log: quiet }).cap, 1);
  assert.equal(new PersistQueue({ store, maxPending: Number.NaN, log: quiet }).cap, DEFAULT_MAX_PENDING, 'garbage falls back');
  assert.equal(new PersistQueue({ store, log: quiet }).cap, DEFAULT_MAX_PENDING);
});
