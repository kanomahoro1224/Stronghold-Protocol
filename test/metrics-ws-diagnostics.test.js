// test/metrics-ws-diagnostics.test.js — GET /metrics.websocket.diagnostics (server/http/routes.js).
//
// server/netDiagnostics.js answers "is the main thread healthy?" with bounded histograms instead of a growing sample
// array: per-frame-type handler time, event-loop delay, and an independent 10 s window that a scrape does not reset.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

test('an idle server reports diagnostics without any traffic', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const body = await (await fetch(`http://127.0.0.1:${srv.port}/metrics.websocket.diagnostics`)).json();
    const d = body.diagnostics;
    assert.equal(d.period, 'sinceStart');
    assert.equal(typeof d.elapsedSec, 'number');
    assert.equal(typeof d.processCpu.userSeconds, 'number');
    assert.equal(typeof d.eventLoop.utilization, 'number');
    assert.equal(d.receivedFrames, 0);
    assert.equal(d.receivedBytes, 0);
    assert.equal(typeof d.handlerMs, 'object');
    assert.equal(typeof d.sendCompletionMs, 'object');
    // the 10 s window is sampled on a timer: either the first sample or null, never a growing array
    assert.ok(d.recentEventLoop === null || typeof d.recentEventLoop.meanMs === 'number');
  } finally {
    await srv.close();
  }
});

test('a handled frame shows up as counts, per-type handler time and a p95', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    await c.hello('Diagnostics');
    await c.send({ t: 'ping', c: 1 });
    // the ping is counted when the server has handled it: poll briefly instead of racing the frame
    let d = null;
    for (let i = 0; i < 40; i++) {
      d = (await (await fetch(`http://127.0.0.1:${srv.port}/metrics.websocket.diagnostics`)).json()).diagnostics;
      if (d.receivedFrames >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(d.receivedFrames >= 2, `frames counted (${d.receivedFrames})`);
    assert.ok(d.receivedBytes > 0);
    assert.equal(typeof d.handlerMs.hello?.count, 'number');
    assert.ok(d.handlerMs.hello.count >= 1, 'hello has its own timing bucket');
    assert.ok(d.handlerMs.hello.p95UpperMs >= 0);
    assert.ok(d.handlerMs.hello.sumMs >= 0);
    assert.equal(typeof d.handlerMs.hello.buckets[0].leMs, 'number');
    assert.equal(d.handlerMs.hello.buckets.at(-1).leMs, '+Inf');
    await c.close();
  } finally {
    await srv.close();
  }
});
