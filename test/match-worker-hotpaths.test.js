import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { DATA } from './match/harness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const options = (roomCode) => ({
  roomCode, mode: 'coop', difficulty: 'NORMAL', seed: 42, matchNo: 1,
  seats: [0, 1].map((seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
});
const inspectWorker = new URL('./fixtures/match-worker-inspect.mjs', import.meta.url);
function poolFor(t, config = {}) {
  const pool = new MatchWorkerPool({ data: DATA, lanes: 1, ...config });
  t.after(() => pool.close());
  return pool;
}

test('one configure per lane; concurrent/reused Matches share a frozen owning snapshot before content imports', async (t) => {
  const data = { ...DATA, workerTestMarker: 'owning-server-not-disk' };
  const pool = poolFor(t, { data, lanes: 2, workerUrl: inspectWorker });
  const sent = [];
  for (const lane of pool.lanes) {
    const post = lane.worker.postMessage.bind(lane.worker);
    lane.worker.postMessage = (message, ...args) => { sent.push({ lane: lane.id, message }); return post(message, ...args); };
  }
  const matches = await Promise.all(['A', 'B', 'C', 'D'].map((key) => pool.create(key, {
    ...options(key), data: { invalidOverride: () => {} },
  })));
  for (const match of matches) {
    assert.deepEqual(await match.invoke('inspectWorkerData'), {
      shared: true, frozen: true, singleton: true, sim: true, content: true, marker: data.workerTestMarker,
    });
    await match.start();
    await match.setLoadout('p_0', {}, {});
    assert.equal((await match.snapshot()).seed, 42);
  }
  for (const lane of pool.lanes) assert.equal(sent.filter((x) => x.lane === lane.id && x.message.type === 'configure').length, 1);
  for (const { message } of sent.filter((x) => x.message.type === 'init')) {
    assert.ok(!Object.hasOwn(message.options, 'data'), 'init must not clone or retain the full dataset');
  }
  const old = matches[0];
  pool.release('A', old);
  const fresh = await pool.create('A', options('A'));
  assert.equal((await fresh.invoke('inspectWorkerData')).shared, true);
  assert.equal(sent.filter((x) => x.message.type === 'configure').length, 2, 'reused room does not reconfigure its lane');
});

test('IPC omits unchanged metadata, sends lifecycle changes, and retries metadata after a reply clone failure', async (t) => {
  const pool = poolFor(t, { workerUrl: inspectWorker });
  const events = [];
  pool.lanes[0].worker.on('message', (event) => events.push(event));
  const match = await pool.create('META', options('META'));
  const ready = events.find((e) => e.type === 'ready');
  assert.equal(ready.meta.order.length, 2);
  await match.start();
  const reply = () => events.findLast((e) => e.type === 'result');
  const before = match.order;
  for (let i = 0; i < 5; i++) await match.handle('p_0', { t: 'b.progress', battleId: 'stale' });
  assert.ok(!Object.hasOwn(reply(), 'meta'), 'unchanged high-frequency replies have no metadata');
  assert.equal(match.order, before, 'proxy keeps the last order instead of allocating another one');
  await match.onDisconnect('p_0');
  assert.equal(reply().meta.order[0].connected, false);
  assert.equal(match.order[0].connected, false);
  await match.onReconnect('p_0');
  assert.equal(reply().meta.order[0].connected, true);
  assert.equal(match.order[0].connected, true);
  const seq = match._battleSeq;
  await assert.rejects(match.invoke('inspectMetadataCloneFailure'), /could not be cloned/);
  await match.invoke('publicView');
  assert.equal(reply().meta._battleSeq, seq + 1, 'failed reply did not advance the baseline');
  assert.equal(match._battleSeq, seq + 1);
  await match.onLeave('p_1');
  assert.equal(match.order[1].left, true);
  assert.equal(reply().meta.order[1].left, true);
  pool.release('META', match);
  const fresh = await pool.create('META', options('META'));
  assert.equal(fresh.order[1].left, false, 'new instance gets a full independent metadata baseline');
});

test('shared configuration timeout rejects all reserved Matches and clears assignments', async (t) => {
  const pool = poolFor(t, { data: { hangConfigure: true }, timeoutMs: 100,
    workerUrl: new URL('./fixtures/match-worker-hang.mjs', import.meta.url) });
  const starts = ['A', 'B', 'C'].map((key) => assert.rejects(pool.create(key, options(key)), /timed out/));
  await Promise.all(starts);
  assert.equal(pool.stats().failedLanes, 1);
  assert.equal(pool.stats().rooms, 0);
  assert.equal(pool.assignments.size, 0);
  assert.equal(pool.lanes[0].pending.size, 0);
  await assert.rejects(pool.create('NEXT', options('NEXT')), /no healthy/);
});

test('uncloneable lane configuration is isolated and does not remain available to new Matches', async (t) => {
  const pool = poolFor(t, { data: { invalid: () => {} } });
  await Promise.all(['A', 'B'].map((key) => assert.rejects(pool.create(key, options(key)), { name: 'DataCloneError' })));
  assert.equal(pool.stats().failedLanes, 1);
  assert.equal(pool.stats().rooms, 0);
  assert.equal(pool.assignments.size, 0);
  await assert.rejects(pool.create('NEXT', options('NEXT')), /no healthy/);
});

// The remaining cases of this file (main-thread re-encode avoidance on the lobby side: matchBroadcast /
// queueMatchBroadcast / matchSend / queueMatchSend reusing the Worker's exact bytes) need the encoded fast path
// of send(ws, msg, encoded) and the queued-match broadcast helpers, which arrive with their own PRs.
