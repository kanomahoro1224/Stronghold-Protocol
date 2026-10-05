// test/state/lobby-resume.test.js — the lobby half of the persistence wiring (server/lobby.js + server/net.js).
//
// What is checked here is the sequence that makes "reconnect after a crash" possible at all, driven through the
// platform stub match (the real engine's write points are covered by test/state/match-persist.test.js):
//
//   1. a started match writes a record whose human seat carries sha256(token) — the durable identity;
//   2. after a "restart" (fresh registry + lobby on the SAME state directory) the presented token resolves to the
//      SAME playerId and room code;
//   3. the first hello then REBUILDS the match (lazily — nothing exists before that moment) and hands the player to
//      the normal reconnect path;
//   4. the record is deleted when the match ends or the room is disposed, and a changed build/rules is never resumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { getData } from '../../server/data.js';
import { MemoryStore } from '../../server/state/store.js';
import { PersistQueue } from '../../server/state/persist.js';
import { StateBridge, matchKey, loadResumable } from '../../server/state/resume.js';
import { tokenHash } from '../../server/state/snapshot.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const DATA = getData({ log: quiet });

/**
 * One "process": its own registry + lobby, on a store that outlives it (the state directory).
 * @param {{ store?: MemoryStore, resume?: boolean, seed?: number, build?: string, rulesHash?: string }} [opts]
 */
function newProcess({ store = new MemoryStore({ log: quiet }), resume = true, seed = 1234, build = 'test-build', rulesHash = 'test-rules' } = {}) {
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, build, rulesHash, resume, log: quiet });
  const registry = new SessionRegistry({});
  const lobby = new Lobby({
    registry, log: quiet, MatchClass: StubMatch, getData: () => DATA, state: bridge, seedFn: () => seed,
  });
  return { store, persist, bridge, registry, lobby };
}

/** A session as net.js builds it (the playerId may come from an identity the lobby adopted). */
function sessionOf(registry, { playerId = null, name = 'P', token = 't'.repeat(32) } = {}) {
  const s = registry.create(name, playerId ? { playerId } : undefined);
  s.token = token; // the token the client will present on its next hello
  s.connected = true;
  return s;
}

/** Create + start a coop room as the given session; returns the room code. */
function startRoom(lobby, session) {
  assert.equal(lobby.onMessage(session, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const code = lobby.roomOf(session).code;
  const res = lobby.onMessage(session, { t: 'room.start' });
  assert.equal(res.ok, true, JSON.stringify(res));
  return code;
}

test('a started match is persisted with its human seat token hash, and ends by deleting the record', async () => {
  const p1 = newProcess();
  const token = 'a'.repeat(32);
  const s = sessionOf(p1.registry, { name: 'Host', token });
  const code = startRoom(p1.lobby, s);
  await p1.persist.idle();

  const rec = await p1.store.get(matchKey(code));
  assert.ok(rec, 'the started match was persisted');
  assert.equal(rec.code, code);
  assert.equal(rec.mode, 'coop');
  assert.equal(rec.seed, 1234);
  assert.deepEqual(rec.seats.map((x) => x.playerId), [s.playerId], 'one human seat');
  assert.equal(rec.seats[0].tokenHash, tokenHash(token), 'the durable identity of the seat');
  assert.equal(rec.ended, false);
  assert.equal(rec.build, 'test-build');
  assert.equal(rec.rulesHash, 'test-rules');

  // the stub match ends as soon as its only human is ready: onEnd must delete the record
  assert.equal(p1.lobby.onMessage(s, { t: 'g.infoReady' }).ok, true);
  await p1.persist.idle();
  assert.equal(await p1.store.get(matchKey(code)), null, 'a finished match is not resumable');
});

test('after a restart the presented token rebuilds the match lazily, on the first hello', async () => {
  const token = 'b'.repeat(32);
  const stateDir = new MemoryStore({ log: quiet }); // the state directory both processes share
  const p1 = newProcess({ store: stateDir });
  const s1 = sessionOf(p1.registry, { name: 'Host', token });
  const code = startRoom(p1.lobby, s1);
  await p1.persist.idle();
  const rec = await p1.store.get(matchKey(code));
  assert.ok(rec);
  // the process CRASHES: no lobby.shutdown, no dispose — only the record on disk survives
  p1.lobby.rooms.get(code).match.dispose();

  const p2 = newProcess({ store: stateDir });
  const scan = await loadResumable(p2.store, { build: 'test-build', rulesHash: 'test-rules', perSecond: 0, log: quiet });
  assert.equal(scan.records.length, 1);
  p2.bridge.markResumable(scan.records);
  assert.equal(p2.lobby.rooms.size, 0, 'NOTHING is rebuilt at boot: the record is only marked resumable');
  assert.equal(p2.bridge.resumedCount, 1);

  // the client comes back: net.js asks the lobby for the identity the token proves, BEFORE `welcome`
  const adopted = p2.lobby.adoptIdentity(token);
  assert.deepEqual(adopted, { playerId: s1.playerId, roomCode: code }, 'the same playerId and room come back');
  assert.equal(p2.lobby.adoptIdentity(token), null, 'a second hello with the same token proves nothing (one-shot)');

  const s2 = sessionOf(p2.registry, { playerId: adopted.playerId, name: 'Host', token });
  assert.equal(s2.playerId, s1.playerId, 'net.js can adopt the persisted playerId');
  s2.roomCode = adopted.roomCode;
  p2.lobby.onHello(s2, { resumed: false, repeat: false });

  const room = p2.lobby.rooms.get(code);
  assert.ok(room, 'the room was rebuilt by the hello');
  assert.ok(room.match, 'and so was its match');
  assert.equal(room.matchCtx.live, true);
  assert.ok(room.seatOf(s1.playerId), 'the recorded seat kept its playerId');
  assert.equal(room.seatOf(s1.playerId).connected, true, 'and is marked connected again');
  assert.equal(room.hostId, s1.playerId);
  assert.equal(room.matchCount, 1, 'the room continues at the recorded match number');
  assert.equal(s2.roomCode, code, 'the session stays in the room');
  p2.lobby.shutdown('test');
  await p2.persist.idle();
  assert.equal(await p2.store.get(matchKey(code)), null, 'disposing the room deleted its record');
});

test('resume disabled (SP_STATE_RESUME off): records are still written, but no identity is handed out', async () => {
  const token = 'c'.repeat(32);
  const p1 = newProcess({ resume: false });
  const s1 = sessionOf(p1.registry, { name: 'Host', token });
  const code = startRoom(p1.lobby, s1);
  await p1.persist.idle();
  assert.ok(await p1.store.get(matchKey(code)), 'the record is written either way (the /healthz counters stay honest)');
  assert.equal(p1.lobby.adoptIdentity(token), null, 'but the identity is not handed out');
  assert.equal(p1.lobby.rehydrate({ roomCode: code }), false, 'and nothing is rebuilt');
  assert.equal(p1.lobby.rooms.size, 1, 'the live room of this process is untouched');
  p1.lobby.shutdown('test');
});

test('a record whose build changed is refused and deleted, never resumed', async () => {
  const stateDir = new MemoryStore({ log: quiet });
  const p1 = newProcess({ store: stateDir });
  const s1 = sessionOf(p1.registry, { name: 'Host', token: 'd'.repeat(32) });
  const code = startRoom(p1.lobby, s1);
  await p1.persist.idle();
  p1.lobby.rooms.get(code).match.dispose();

  const p2 = newProcess({ store: stateDir, build: 'other-build' });
  const scan = await loadResumable(p2.store, { build: 'other-build', rulesHash: 'test-rules', perSecond: 0, log: quiet });
  assert.deepEqual(scan.refused, [{ key: matchKey(code), reason: 'build' }]);
  p2.bridge.noteRefused(scan.refused);
  p2.bridge.markResumable(scan.records);
  p2.bridge.purgeRefused();
  await p2.persist.idle();
  assert.equal(p2.bridge.resumedCount, 0, 'a record from another build can never be resumed');
  assert.equal(await p2.store.get(matchKey(code)), null, 'and its record is deleted');
});
