// test/healthz-usage.test.js — the process sample on GET /healthz (server/http/healthUsage.js).
//
// The first test pins the shape and the "CPU is a delta" contract; the second one checks that a real server actually
// reports it, so a refactor that drops the field fails here instead of in a deploy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { usageSnapshot, resetUsageSnapshot } from '../server/http/healthUsage.js';
import { startServer } from '../server/index.js';

test('usageSnapshot reports memory bytes, and CPU since the previous sample', () => {
  resetUsageSnapshot();
  const first = usageSnapshot(1000);
  assert.ok(first.memory.rss > 0, 'rss');
  assert.ok(first.memory.heapUsed > 0, 'heapUsed');
  assert.ok(first.memory.heapTotal >= first.memory.heapUsed, 'heapTotal >= heapUsed');
  assert.ok(first.memory.arrayBuffers >= 0, 'arrayBuffers');
  assert.equal(first.cpu.sinceMs, 0, 'the first sample is the baseline');
  assert.equal(first.cpu.percent, 0);

  // burn a little CPU so the second sample has something to report
  let x = 0;
  for (let i = 0; i < 3e6; i++) x += i % 7;
  const second = usageSnapshot(1100);
  assert.ok(Number.isFinite(x));
  assert.equal(second.cpu.sinceMs, 100);
  assert.ok(second.cpu.userMicros + second.cpu.systemMicros >= 0);
  assert.ok(second.cpu.percent >= 0);
});

test('GET /healthz carries the sample', async () => {
  resetUsageSnapshot();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.usage, 'usage');
    assert.ok(body.usage.memory.rss > 0);
    assert.equal(typeof body.usage.cpu.percent, 'number');
    assert.equal(typeof body.usage.cpu.sinceMs, 'number');
  } finally {
    await srv.close();
  }
});
