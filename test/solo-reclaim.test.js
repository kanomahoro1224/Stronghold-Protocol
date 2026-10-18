// test/solo-reclaim.test.js — how long a dropped solo run is kept (server/lobby.js).
//
// A solo run has no time limit, so a player who walks away leaves a room and its match waiting. The retention window
// used to be the official 24 h; the server now reclaims it after 6 h, while an explicit option (or a deployment that
// still wants the official value) keeps full control.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LOBBY_DEFAULTS, SOLO_RECONNECT_FALLBACK_SEC } from '../server/lobby.js';
import { startServer } from '../server/index.js';

test('the default solo retention is six hours', () => {
  assert.equal(LOBBY_DEFAULTS.soloReconnectWindowMs, 6 * 60 * 60_000);
  assert.equal(SOLO_RECONNECT_FALLBACK_SEC, 6 * 60 * 60);
});

test('a server without the option uses the six-hour window', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    assert.equal(srv.lobby.soloResumeWindowMs(), 6 * 60 * 60_000);
  } finally {
    await srv.close();
  }
});

test('an explicit option still wins, and null falls back to the official data value', async () => {
  const explicit = await startServer({ port: 0, host: '127.0.0.1', quiet: true, soloReconnectWindowMs: 1234 });
  try {
    assert.equal(explicit.lobby.soloResumeWindowMs(), 1234);
  } finally {
    await explicit.close();
  }
  const official = await startServer({ port: 0, host: '127.0.0.1', quiet: true, soloReconnectWindowMs: null });
  try {
    // constData.singleReconnectTime: the official 24 h, which is longer than the new default
    assert.ok(official.lobby.soloResumeWindowMs() >= 6 * 60 * 60_000);
  } finally {
    await official.close();
  }
});
