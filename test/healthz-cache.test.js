// test/healthz-cache.test.js — a probe storm reuses one bounded counters snapshot instead of rebuilding it per request.
//
// /healthz is polled by every page (buildGuard, every 60 s), by the monitoring collector (every 10 s) and by any
// orchestrator probe, and each call walked every room and seat to build lobby.stats(). The cached part is only that
// walk: sockets, sessions, uptime and build stay current, room topology changes invalidate it at once, and ?traffic=1
// keeps building a live report.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHealthBody, healthReport } from '../server/http/routes.js';

function deps(rooms = 1) {
  const state = { calls: 0, sockets: 3, rooms };
  return {
    state,
    health: {
      startedAt: Date.now() - 5000,
      network: { get connectionCount() { return state.sockets; } },
      registry: { size: 2 },
      lobby: {
        rooms: { get size() { return state.rooms; } },
        stats: () => { state.calls++; return { rooms: state.rooms, matches: state.rooms, humans: 2, bots: 0, spectators: 0, queued: 0 }; },
      },
    },
  };
}

test('healthReport uses the counters it is handed', () => {
  const { health } = deps();
  const r = healthReport(health, false, { rooms: 9, matches: 8, humans: 7, bots: 0, spectators: 0, queued: 1 });
  assert.equal(r.rooms, 9);
  assert.equal(r.matches, 8);
  assert.equal(r.humans, 7);
  assert.equal(r.sockets, 3, 'sockets stay live');
});

test('the cached body rebuilds the counters once per window and keeps the cheap fields current', () => {
  const { health, state } = deps();
  let clock = 1000;
  const body = createHealthBody(health, { now: () => clock, maxAgeMs: 1000 });

  const first = body();
  assert.equal(state.calls, 1);
  body(); body();
  assert.equal(state.calls, 1, 'three probes inside the window share one counters walk');

  state.sockets = 5;
  assert.equal(body().sockets, 5, 'sockets are read per request, not cached');

  clock += 1001;
  body();
  assert.equal(state.calls, 2, 'the window expires');

  state.rooms = 2;
  body();
  assert.equal(state.calls, 3, 'a room appearing invalidates immediately');
  assert.equal(body().rooms, 2);
  assert.equal(state.calls, 3, 'and then it is cached again');
});

test('the report shape is unchanged by the cache', () => {
  const { health } = deps();
  const body = createHealthBody(health, { now: () => 1, maxAgeMs: 1000 });
  const r = body();
  assert.equal(r.ok, true);
  assert.equal(typeof r.uptimeSec, 'number');
  assert.equal(r.sockets, 3);
  assert.equal(r.sessions, 2);
  assert.ok(!('traffic' in r), 'traffic stays opt-in');
});