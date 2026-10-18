// test/http-limits.test.js — the configurable room / match / socket caps (server/http/config.js) and the capacity they
// report on /healthz.
//
// The parseEnvLimit table is taken verbatim from test/lobby.test.js (authored by @xinhai-ai); the other two tests are the
// wiring: the environment reaches the net.js / lobby.js options while an explicit startServer() option still wins, and
// /healthz reports what is actually enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEnvLimit, netOptionsFrom, lobbyOptionsFrom } from '../server/http/config.js';
import { startServer } from '../server/index.js';

const ENV_NAMES = ['SP_MAX_ROOMS', 'SP_MAX_ROOMS_PER_ADDR', 'SP_MAX_MATCHES_PER_ADDR', 'SP_MAX_CONNECTIONS', 'SP_MAX_CONNECTIONS_PER_ADDR'];

/** Sets the SP_MAX_* variables for the duration of `fn` and restores them afterwards. */
async function withEnv(values, fn) {
  const before = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    return await fn();
  } finally {
    for (const k of ENV_NAMES) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

test('parseEnvLimit: a value from the environment wins, 0 means unlimited, junk keeps the default', () => {
  assert.equal(parseEnvLimit(undefined, 16, 'X'), 16);
  assert.equal(parseEnvLimit('', 16, 'X'), 16);
  assert.equal(parseEnvLimit(' 25 ', 16, 'X'), 25);
  assert.equal(parseEnvLimit('0', 16, 'X'), 0, '0 = unlimited for the per-network caps');
  const warns = [];
  for (const bad of ['many', '-1', '1.5', '1e9', 'NaN']) assert.equal(parseEnvLimit(bad, 16, 'SP_MAX_ROOMS', { warn: (m) => warns.push(m) }), 16, bad);
  assert.equal(warns.length, 5);
  assert.match(warns[0], /SP_MAX_ROOMS=many ignored: a non-negative integer is required/);
  assert.equal(parseEnvLimit('50', 16, 'X'), 50);
});

test('the SP_MAX_* variables reach the lobby and net options, and an explicit option wins', async () => {
  await withEnv({ SP_MAX_ROOMS: '12', SP_MAX_ROOMS_PER_ADDR: '0', SP_MAX_MATCHES_PER_ADDR: 'junk', SP_MAX_CONNECTIONS: '500', SP_MAX_CONNECTIONS_PER_ADDR: '7' }, () => {
    assert.deepEqual(lobbyOptionsFrom({}), { maxRooms: 12, maxRoomsPerAddr: 0 });
    assert.equal(netOptionsFrom({}).maxConnections, 500);
    assert.equal(netOptionsFrom({}).maxConnectionsPerAddr, 7);
    // a junk value is ignored: the option keeps whatever default net.js / lobby.js has
    assert.equal('maxMatchesPerAddr' in lobbyOptionsFrom({}), false);
    // an explicit startServer() option still wins over the environment
    assert.deepEqual(lobbyOptionsFrom({ maxRooms: 3 }), { maxRooms: 3, maxRoomsPerAddr: 0 });
    assert.equal(netOptionsFrom({ maxConnections: 9 }).maxConnections, 9);
  });
});

test('/healthz reports the caps the server actually enforces', async () => {
  await withEnv({ SP_MAX_ROOMS: '5', SP_MAX_ROOMS_PER_ADDR: '2', SP_MAX_MATCHES_PER_ADDR: '1', SP_MAX_CONNECTIONS: '40', SP_MAX_CONNECTIONS_PER_ADDR: '3' }, async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.limits, { rooms: 5, roomsPerAddr: 2, matchesPerAddr: 1, connections: 40, connectionsPerAddr: 3 });
    } finally {
      await srv.close();
    }
  });
});
