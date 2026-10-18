// test/net-send-queue.test.js — the send-queue sample on /healthz (server/net.js sendQueueStats()).
//
// The numbers exist to answer "is one slow client about to hit the hard limit?" without attaching a profiler: total and
// worst bufferedAmount across the live sockets, plus how many are past the snap-drop threshold.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

test('an idle server reports an empty send queue', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.sendQueue, { sockets: 0, queuedBytes: 0, worstBytes: 0, slowSockets: 0 });
    assert.deepEqual(srv.network.sendQueueStats(), { sockets: 0, queuedBytes: 0, worstBytes: 0, slowSockets: 0 });
  } finally {
    await srv.close();
  }
});

test('a connected client is counted, and its queue is a number', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  try {
    const c = await TestClient.connect(url);
    await c.hello('Queue');
    const stats = srv.network.sendQueueStats();
    assert.equal(stats.sockets, 1);
    assert.ok(stats.queuedBytes >= 0);
    assert.ok(stats.worstBytes >= 0);
    assert.ok(stats.worstBytes <= stats.queuedBytes || stats.sockets === 0);
    assert.ok(stats.slowSockets >= 0);
    const body = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
    assert.equal(body.sendQueue.sockets, 1);
    await c.close();
  } finally {
    await srv.close();
  }
});
