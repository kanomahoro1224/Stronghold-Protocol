// test/healthz-memory.test.js — /healthz reports the server's own footprint so the monitoring stack can chart it.
//
// The collector (deploy/monitoring/exporter/metrics.mjs) maps memory.rss / heapUsed / heapTotal / external /
// arrayBuffers to sp_process_rss_bytes and sp_main_heap_*; without this field those panels stay empty even though the
// data is one cheap process.memoryUsage() call away.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { healthReport } from '../server/http/routes.js';

const deps = () => ({
  startedAt: Date.now() - 5000,
  network: { connectionCount: 3 },
  registry: { size: 2 },
  lobby: { stats: () => ({ rooms: 1, matches: 1, humans: 2, bots: 0, spectators: 0, queued: 0 }) },
});

test('the health report carries finite process memory numbers', () => {
  const r = healthReport(deps());
  for (const key of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) {
    assert.equal(typeof r.memory[key], 'number', `${key} is a number`);
    assert.ok(Number.isFinite(r.memory[key]) && r.memory[key] > 0, `${key} is a positive finite number`);
  }
  assert.ok(r.memory.heapUsed <= r.memory.heapTotal, 'heapUsed cannot exceed heapTotal');
  assert.ok(r.memory.rss >= r.memory.heapTotal, 'rss covers the heap');
});

test('the report still carries the fields it always had', () => {
  const r = healthReport(deps());
  assert.equal(r.ok, true);
  assert.equal(typeof r.uptimeSec, 'number');
  assert.equal(r.sockets, 3);
  assert.equal(r.sessions, 2);
  assert.equal(r.rooms, 1);
  assert.ok(!('traffic' in r), 'traffic stays opt-in');
});
