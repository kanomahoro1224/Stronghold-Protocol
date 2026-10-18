// test/http-limits.test.js — the configurable room / match / socket caps (server/http/config.js).
//
// The parseEnvLimit table is taken verbatim from test/lobby.test.js (authored by @xinhai-ai); the second test is the
// wiring: the environment reaches the net.js / lobby.js options while an explicit startServer() option still wins.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEnvLimit, netOptionsFrom, lobbyOptionsFrom } from '../server/http/config.js';

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

test('the SP_MAX_* variables reach the lobby and net options, and an explicit option wins', () => {
  const names = ['SP_MAX_ROOMS', 'SP_MAX_ROOMS_PER_ADDR', 'SP_MAX_MATCHES_PER_ADDR', 'SP_MAX_CONNECTIONS', 'SP_MAX_CONNECTIONS_PER_ADDR'];
  const before = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    process.env.SP_MAX_ROOMS = '12';
    process.env.SP_MAX_ROOMS_PER_ADDR = '0';
    process.env.SP_MAX_MATCHES_PER_ADDR = 'junk';
    process.env.SP_MAX_CONNECTIONS = '500';
    process.env.SP_MAX_CONNECTIONS_PER_ADDR = '7';

    assert.deepEqual(lobbyOptionsFrom({}), { maxRooms: 12, maxRoomsPerAddr: 0 });
    assert.equal(netOptionsFrom({}).maxConnections, 500);
    assert.equal(netOptionsFrom({}).maxConnectionsPerAddr, 7);
    // a junk value is ignored: the option keeps whatever default net.js / lobby.js has
    assert.equal('maxMatchesPerAddr' in lobbyOptionsFrom({}), false);
    // an explicit startServer() option still wins over the environment
    assert.deepEqual(lobbyOptionsFrom({ maxRooms: 3 }), { maxRooms: 3, maxRoomsPerAddr: 0 });
    assert.equal(netOptionsFrom({ maxConnections: 9 }).maxConnections, 9);
  } finally {
    for (const k of names) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});
