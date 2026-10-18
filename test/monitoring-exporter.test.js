// test/monitoring-exporter.test.js — the collector scrapes this repository's /healthz and invents nothing.
//
// 0.3.2 serves /healthz only (server/http/routes.js: healthReport): ok, uptimeSec, sockets, sessions and the lobby
// stats. There is no /metrics JSON endpoint and no websocket.diagnostics/persist/matchWorkers payload, so the exporter
// must translate what it really received and leave the rest absent instead of fabricating gauges from its own CPU or
// writing zeros.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

import { renderMetrics } from '../deploy/monitoring/exporter/metrics.mjs';
import { fetchSnapshot, probeWebSocket, startExporter, validateTargets } from '../deploy/monitoring/exporter/index.mjs';
import { startServer } from '../server/index.js';

// Exactly the shape healthReport() returns for this version.
const health = {
  ok: true, version: 3, app: '0.3.2', uptimeSec: 42, build: 'abc123',
  sockets: 7, sessions: 5, rooms: 2, matches: 1, humans: 4, bots: 2, spectators: 1, queued: 3,
};

const streamOf = (obj) => ReadableStream.from([new TextEncoder().encode(JSON.stringify(obj))]);
const response = (obj) => ({ ok: true, headers: new Headers(), body: streamOf(obj) });

test('renderMetrics translates the /healthz contract and does not invent missing families', () => {
  const text = renderMetrics([{ name: 'prod', url: 'http://game/healthz' }],
    new Map([['prod', { up: true, data: health, errors: 0, lastSuccess: 100, durationSeconds: 0.02 }]]), 110);

  assert.match(text, /sp_target_up\{game="prod"\} 1/);
  assert.match(text, /sp_players_sockets\{game="prod"\} 7/);
  assert.match(text, /sp_players_sessions\{game="prod"\} 5/);
  assert.match(text, /sp_players_queued\{game="prod"\} 3/);
  assert.match(text, /sp_uptime_seconds\{game="prod"\} 42/);

  // absent upstream data stays absent: no fabricated process/host gauge, availability is reported as 0
  assert.doesNotMatch(text, /sp_process_rss_bytes\{/);
  assert.doesNotMatch(text, /sp_process_cpu_user_seconds_total\{/);
  assert.match(text, /sp_process_cpu_available\{game="prod"\} 0/);
  assert.match(text, /sp_event_loop_window_available\{game="prod"\} 0/);
});

test('a failed scrape keeps target_up at 0 and reports the scrape error', () => {
  const text = renderMetrics([{ name: 'prod', url: 'http://game/healthz' }],
    new Map([['prod', { up: false, data: health, errors: 3, lastSuccess: 100, durationSeconds: 0.01 }]]), 110);
  assert.match(text, /sp_target_up\{game="prod"\} 0/);
  assert.match(text, /sp_exporter_scrape_errors_total\{game="prod"\} 3/);
});

test('targets are bounded and credentials in a URL are refused', () => {
  assert.throws(() => validateTargets([{ name: 'x', url: 'http://u:p@example.com/healthz' }]));
  assert.throws(() => validateTargets([{ name: 'x', url: 'ftp://example.com/healthz' }]));
  assert.deepEqual(validateTargets([{ name: 'local', url: 'http://127.0.0.1:3000/healthz' }]),
    [{ name: 'local', url: 'http://127.0.0.1:3000/healthz' }]);
});

test('fetchSnapshot accepts the /healthz payload and rejects anything else', async () => {
  const ok = await fetchSnapshot('http://game/healthz', { fetchFn: async () => response(health) });
  assert.equal(ok.sockets, 7);

  for (const bad of [{ ok: true }, { ok: true, uptimeSec: 1 }, { ok: false, uptimeSec: 1, sockets: 1 },
    { ok: true, uptimeSec: 'x', sockets: 1 }]) {
    await assert.rejects(() => fetchSnapshot('http://game/healthz', { fetchFn: async () => response(bad) }),
      /not game health JSON/);
  }
});

test('the exporter polls its targets and serves Prometheus text plus its own health endpoint', async () => {
  const exporter = await startExporter({
    targets: [{ name: 'prod', url: 'http://game/healthz' }], port: 0, intervalMs: 5000, timeoutMs: 100,
    fetchFn: async () => response(health),
  });
  try {
    await exporter.ready;
    assert.equal((await (await fetch(exporter.url + '/healthz')).json()).ok, true);
    const metrics = await (await fetch(exporter.url + '/metrics')).text();
    assert.match(metrics, /sp_target_up\{game="prod"\} 1/);
    assert.match(metrics, /sp_players_sockets\{game="prod"\} 7/);
    const head = await fetch(exporter.url + '/metrics', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(exporter.url + '/metrics', { method: 'POST' })).status, 405);
    assert.equal((await fetch(exporter.url + '/unknown')).status, 404);
  } finally { await exporter.close(); }
});

test('a real server is scraped through /healthz and the WS probe works against it', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const snapshot = await fetchSnapshot(base + '/healthz');
    assert.equal(snapshot.ok, true);
    assert.equal(typeof snapshot.sockets, 'number');
    assert.equal(typeof snapshot.sessions, 'number');

    const text = renderMetrics([{ name: 'local', url: base + '/healthz' }],
      new Map([['local', { up: true, data: snapshot, errors: 0, lastSuccess: 1, durationSeconds: 0.01 }]]), 110);
    assert.match(text, /sp_players_sockets\{game="local"\} 0/);
    assert.match(text, /sp_players_sessions\{game="local"\} 0/);

    const probe = await probeWebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    assert.equal(probe.up, true, 'an unauthenticated ping is answered');
    assert.ok(probe.rttSeconds >= 0);
  } finally { await srv.close(); }
});
