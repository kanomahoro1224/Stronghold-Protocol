// test/healthz-tuning.test.js — the timing knobs on GET /healthz (server/http/routes.js).
//
// The caps say how much the server takes; these say how it behaves while it takes it: how long a dropped session stays
// resumable, how often a client is pinged, how long a lobby seat is held and how often a heavy resync may repeat. They
// are reported from the options the Lobby and the Network are actually running with, so an option and its default are
// distinguishable in a deploy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { NET_DEFAULTS } from '../server/net.js';
import { LOBBY_DEFAULTS } from '../server/lobby.js';

test('the defaults are reported when nothing is configured', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const body = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
    assert.equal(body.tuning.reconnectWindowMs, NET_DEFAULTS.reconnectWindowMs);
    assert.equal(body.tuning.heartbeatMs, NET_DEFAULTS.heartbeatMs);
    assert.equal(body.tuning.helloTimeoutMs, NET_DEFAULTS.helloTimeoutMs);
    assert.equal(body.tuning.lobbyGraceMs, LOBBY_DEFAULTS.lobbyGraceMs);
    assert.equal(body.tuning.resyncMinGapMs, LOBBY_DEFAULTS.resyncMinGapMs);
    assert.equal(body.tuning.soloReconnectWindowMs, LOBBY_DEFAULTS.soloReconnectWindowMs);
  } finally {
    await srv.close();
  }
});

test('an explicit option shows up instead of the default', async () => {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true,
    reconnectWindowMs: 1234, heartbeatMs: 5678, lobbyGraceMs: 4321, resyncMinGapMs: 99, soloReconnectWindowMs: 111,
  });
  try {
    const body = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
    assert.deepEqual(body.tuning, {
      reconnectWindowMs: 1234, heartbeatMs: 5678, helloTimeoutMs: NET_DEFAULTS.helloTimeoutMs,
      lobbyGraceMs: 4321, resyncMinGapMs: 99, soloReconnectWindowMs: 111,
    });
  } finally {
    await srv.close();
  }
});
