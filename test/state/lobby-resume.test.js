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
import { Match, STATE_HEARTBEAT_MS } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { getData } from '../../server/data.js';
import { MemoryStore } from '../../server/state/store.js';
import { PersistQueue } from '../../server/state/persist.js';
import { StateBridge, matchKey, loadResumable } from '../../server/state/resume.js';
import { tokenHash } from '../../server/state/snapshot.js';
import { captureProps } from '../../server/state/playerstate.js';
import { FakeBattle } from '../match/fakeBattle.js';
import { PHASE } from '../../shared/constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const DATA = getData({ log: quiet });

/**
 * One "process": its own registry + lobby, on a store that outlives it (the state directory).
 * @param {{ store?: MemoryStore, resume?: boolean, seed?: number, build?: string, rulesHash?: string,
 *           MatchClass?: Function, options?: object }} [opts]
 */
function newProcess({
  store = new MemoryStore({ log: quiet }), resume = true, seed = 1234, build = 'test-build',
  rulesHash = 'test-rules', MatchClass = StubMatch, options = undefined,
} = {}) {
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, build, rulesHash, resume, log: quiet });
  const registry = new SessionRegistry({});
  const lobby = new Lobby({
    registry, log: quiet, MatchClass, getData: () => DATA, state: bridge, seedFn: () => seed, options,
  });
  return { store, persist, bridge, registry, lobby };
}

/**
 * The REAL engine on a virtual clock (what test/match/harness.js builds for the engine suites): the lobby constructs
 * it like production does, so what is exercised below is the platform's own resume path and not a stub of it.
 * `idlePauseMs: 0` keeps a match whose human is briefly absent from freezing mid-test.
 * @param {VirtualScheduler} sched
 */
const engineClass = (sched) => class extends Match {
  constructor(o) {
    super({ ...o, scheduler: sched, BattleClass: FakeBattle, botRehearsal: 0, clientCombat: false, idlePauseMs: 0 });
  }
};

/** Drive the real match's start handshake (info → band) through the LOBBY, one scheduler callback at a time. */
function driveToPrep(lobby, session, sched, m, { band = 'band_bldsk', maxSteps = 5000 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (m.phase === PHASE.PREP) return true;
    if (m.ended) return false;
    if (m.phase === PHASE.INFO_CHECK) lobby.onMessage(session, { t: 'g.infoReady' });
    if (m.phase === PHASE.BAND_DRAFT && m.draftTurn() === session.playerId) lobby.onMessage(session, { t: 'g.band', bandId: band });
    if (!sched.runNext()) return m.phase === PHASE.PREP;
  }
  return m.phase === PHASE.PREP;
}

/** Canonical JSON: keys sorted, so two graphs compare independently of insertion order. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return String(JSON.stringify(v === undefined ? null : v));
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

test('a started match is persisted with its human seat token hash, and its record becomes the room\'s when it ends', async () => {
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

  // the stub match ends as soon as its only human is ready. The MATCH is not resumable any more — but the ROOM is
  // (P2): the record is replaced by the room form, which has no round to re-enter and no seat payload to apply.
  assert.equal(p1.lobby.onMessage(s, { t: 'g.infoReady' }).ok, true);
  await p1.persist.idle();
  const after = await p1.store.get(matchKey(code));
  assert.ok(after, 'the room outlives its match');
  assert.equal(after.inMatch, false, 'and says so');
  assert.equal(after.state, null, 'with no engine state to re-enter');
  assert.equal(after.seats[0].tokenHash, tokenHash(token), 'the seat still carries the durable identity');
  assert.equal(after.matchNo, 1, 'and the room remembers the match it finished');
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

test('a PREP record survives a restart: claim → rehydrate rebuilds the exact mid-prep match (real engine)', async () => {
  const token = 'e'.repeat(32);
  const stateDir = new MemoryStore({ log: quiet }); // the state directory both processes share
  const sched1 = new VirtualScheduler();
  const p1 = newProcess({ store: stateDir, MatchClass: engineClass(sched1), options: { idlePauseMs: 0 } });
  const s1 = sessionOf(p1.registry, { name: 'Host', token });
  const code = startRoom(p1.lobby, s1);
  const m1 = p1.lobby.rooms.get(code).match;
  assert.ok(m1 instanceof Match, 'the room runs the real engine');
  // the real start handshake, through the lobby: info confirmation, then the band pick
  assert.ok(driveToPrep(p1.lobby, s1, sched1, m1), `the match reached its prep (${m1.phase} R${m1.round})`);
  assert.equal(m1.loneHuman, true, 'one human seat: the re-entry gate accepts this match');
  assert.equal(m1.players.get(s1.playerId).ready, false, 'the human has not confirmed: the prep is still open');

  // the heartbeat writes the OPEN prep on its own schedule (4 s of virtual time)
  sched1.advance(STATE_HEARTBEAT_MS);
  assert.equal(m1.phase, PHASE.PREP, 'still the open prep');
  await p1.persist.idle();
  const rec = await p1.store.get(matchKey(code));
  assert.ok(rec, 'the heartbeat wrote a record');
  assert.equal(rec.phase, PHASE.PREP, 'and it is the PREP record (P2a-b: resumable, not refused)');
  assert.equal(rec.round, m1.round);
  assert.ok(rec.players.every((p) => p.props), 'every seat carries its full props');
  const recorded = new Map(rec.players.map((p) => [p.playerId, canon(p.props)]));

  // the process CRASHES: no shutdown, no dispose of the room — only the record on disk survives
  m1.dispose();

  // the NEW process: boot scan (the PREP record is taken, not refused), claim(token), first hello rehydrates
  const sched2 = new VirtualScheduler();
  const p2 = newProcess({ store: stateDir, MatchClass: engineClass(sched2), options: { idlePauseMs: 0 } });
  const scan = await loadResumable(p2.store, { build: 'test-build', rulesHash: 'test-rules', perSecond: 0, log: quiet });
  assert.deepEqual(scan.refused, [], 'nothing is refused: the PREP record is resumable');
  assert.deepEqual(scan.records.map((r) => r.code), [code]);
  p2.bridge.noteRefused(scan.refused);
  p2.bridge.markResumable(scan.records);
  assert.equal(p2.bridge.resumedCount, 1);
  assert.equal(p2.lobby.rooms.size, 0, 'NOTHING is rebuilt at boot: the returning player is the trigger');

  const adopted = p2.lobby.adoptIdentity(token);
  assert.deepEqual(adopted, { playerId: s1.playerId, roomCode: code }, 'the token proves the same seat');
  const s2 = sessionOf(p2.registry, { playerId: adopted.playerId, name: 'Host', token });
  s2.roomCode = adopted.roomCode;
  p2.lobby.onHello(s2, { resumed: false, repeat: false });
  const room = p2.lobby.rooms.get(code);
  assert.ok(room && room.match, 'the hello rebuilt the room and its match');
  const m2 = room.match;
  assert.equal(m2.round, rec.round, 'the recorded round was re-entered');
  assert.equal(m2.uidSeq, rec.state.uidSeq, 'with the recorded uid counter');
  for (const p of rec.players) {
    assert.equal(canon(captureProps(m2.players.get(p.playerId))), recorded.get(p.playerId),
      `${p.playerId}: the rebuilt seat is the recorded one (canonical digest)`);
  }

  // and the continuation is real: the prep reopens (the engine's own ROUND_START → PREP) with the recorded progress
  // intact — no free income, no second upgrade-price drop, no re-rolled shop
  assert.ok(sched2.runUntil(() => m2.phase === PHASE.PREP, { maxSteps: 5000 }), 'the prep reopens');
  const before = rec.players.find((p) => p.playerId === s1.playerId).props;
  const human = m2.players.get(s1.playerId);
  assert.equal(human.funds, before.funds, 'no income was paid a second time');
  assert.equal(human.shop.upgradePrice, before.shop.upgradePrice, 'and the upgrade price did not drop again');
  assert.equal(canon(human.shop.slots), canon(before.shop.slots), 'the shop is still the recorded one');
  assert.equal(human.round.buys, before.round.buys);
  assert.equal(human.ready, before.ready, 'and the recorded Ready is still the recorded one');
  assert.equal(canon(captureProps(human)), canon(before), 'the whole seat is the recorded one after the prep reopened');
  p2.lobby.shutdown('test');
});

// ---------------------------------------------------------------------------------------------------
// P2: the ROOM is persisted too, not only the match
// ---------------------------------------------------------------------------------------------------

test('P2: a room whose match never started is persisted, and the returning player gets the room back', async () => {
  const token = 'f'.repeat(32);
  const stateDir = new MemoryStore({ log: quiet });
  const p1 = newProcess({ store: stateDir });
  const s1 = sessionOf(p1.registry, { name: 'Host', token });
  assert.equal(p1.lobby.onMessage(s1, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const code = p1.lobby.roomOf(s1).code;
  await p1.persist.idle();

  const rec = await p1.store.get(matchKey(code));
  assert.ok(rec, 'the ROOM is persisted even though no match exists yet');
  assert.equal(rec.inMatch, false, 'the record says there is no match to rebuild');
  assert.equal(rec.state, null, 'and carries no engine state: there is no round to re-enter');
  assert.equal(rec.host, s1.playerId, 'the host is part of the room');
  assert.deepEqual(rec.seats.map((x) => x.playerId), [s1.playerId]);
  assert.equal(rec.seats[0].tokenHash, tokenHash(token), 'the durable identity of the seat');
  assert.equal(rec.seats[0].ready, false, 'and the seat state the lobby shows');

  // the process CRASHES: no shutdown, no dispose of the room — only the record on disk survives
  const p2 = newProcess({ store: stateDir });
  const scan = await loadResumable(p2.store, { build: 'test-build', rulesHash: 'test-rules', perSecond: 0, log: quiet });
  assert.deepEqual(scan.refused, [], 'a room record is resumable: it has nothing to re-enter, so nothing can be wrong');
  assert.deepEqual(scan.records.map((r) => r.code), [code]);
  p2.bridge.noteRefused(scan.refused);
  p2.bridge.markResumable(scan.records);
  assert.equal(p2.lobby.rooms.size, 0, 'NOTHING is rebuilt at boot: the returning player is the trigger');

  const adopted = p2.lobby.adoptIdentity(token);
  assert.deepEqual(adopted, { playerId: s1.playerId, roomCode: code }, 'the token proves the same seat and room');
  const s2 = sessionOf(p2.registry, { playerId: adopted.playerId, name: 'Host', token });
  s2.roomCode = adopted.roomCode;
  p2.lobby.onHello(s2, { resumed: false, repeat: false });

  const room = p2.lobby.rooms.get(code);
  assert.ok(room, 'the hello rebuilt the room');
  assert.equal(room.match, null, 'and NO match was invented for a room that never had one');
  assert.equal(room.mode, 'coop');
  assert.equal(room.difficulty, 'NORMAL');
  assert.equal(room.hostId, s1.playerId, 'the recorded host is the host again');
  assert.ok(room.seatOf(s1.playerId), 'the player is back on its own seat');
  assert.equal(room.seatOf(s1.playerId).connected, true, 'and marked connected again');
  assert.equal(s2.roomCode, code, 'the session stays in the room');
  // the rebuilt room is a LIVE room, not a museum piece: it still takes messages
  assert.equal(p2.lobby.onMessage(s2, { t: 'room.ready', ready: true }).ok, true, 'the room still accepts a ready');
  assert.equal(room.seatOf(s1.playerId).ready, true);
  p2.lobby.shutdown('test');
});

test('P2: after a match ends the ROOM is what a restart brings back, and the next match starts in it', async () => {
  const token = 'g'.repeat(32);
  const stateDir = new MemoryStore({ log: quiet });
  const p1 = newProcess({ store: stateDir });
  const s1 = sessionOf(p1.registry, { name: 'Host', token });
  const code = startRoom(p1.lobby, s1);
  await p1.persist.idle();
  // the stub match ends as soon as its only human is ready: the room drops back to the lobby
  assert.equal(p1.lobby.onMessage(s1, { t: 'g.infoReady' }).ok, true);
  await p1.persist.idle();
  const ended = await p1.store.get(matchKey(code));
  assert.equal(ended.inMatch, false, 'the record is the ROOM again');
  assert.equal(ended.matchNo, 1, 'and remembers the match that just ended');

  // the process CRASHES between two matches: the room, not the finished match, is what survives
  const p2 = newProcess({ store: stateDir });
  const scan = await loadResumable(p2.store, { build: 'test-build', rulesHash: 'test-rules', perSecond: 0, log: quiet });
  assert.deepEqual(scan.refused, []);
  p2.bridge.markResumable(scan.records);
  const adopted = p2.lobby.adoptIdentity(token);
  assert.deepEqual(adopted, { playerId: s1.playerId, roomCode: code });
  const s2 = sessionOf(p2.registry, { playerId: adopted.playerId, name: 'Host', token });
  s2.roomCode = adopted.roomCode;
  p2.lobby.onHello(s2, { resumed: false, repeat: false });

  const room = p2.lobby.rooms.get(code);
  assert.ok(room, 'the room came back');
  assert.equal(room.match, null, 'the finished match did not');
  assert.equal(room.hostId, s1.playerId);
  assert.equal(room.matchCount, 1, 'the room continues after the match it finished');
  // the restored room is a working room: the next match starts in it, numbered after the one that ended
  assert.equal(p2.lobby.onMessage(s2, { t: 'room.start' }).ok, true, 'a new match starts in the restored room');
  assert.ok(room.match, 'and it runs');
  assert.equal(room.matchCount, 2, 'as the room\'s second match');
  p2.lobby.shutdown('test');
});

test('P2: the room comes back with its host, its ready flags, its bots and its spectators', async () => {
  const hostTok = 'h'.repeat(32);
  const guestTok = 'i'.repeat(32);
  const watchTok = 'j'.repeat(32);
  const stateDir = new MemoryStore({ log: quiet });
  const p1 = newProcess({ store: stateDir });
  const host = sessionOf(p1.registry, { name: 'Host', token: hostTok });
  assert.equal(p1.lobby.onMessage(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const code = p1.lobby.roomOf(host).code;
  const guest = sessionOf(p1.registry, { name: 'Guest', token: guestTok });
  assert.equal(p1.lobby.onMessage(guest, { t: 'room.join', code }).ok, true);
  assert.equal(p1.lobby.onMessage(host, { t: 'room.addBot' }).ok, true);
  assert.equal(p1.lobby.onMessage(guest, { t: 'room.ready', ready: true }).ok, true);
  const watcher = sessionOf(p1.registry, { name: 'Watcher', token: watchTok });
  assert.equal(p1.lobby.onMessage(watcher, { t: 'room.spectate', code }).ok, true);
  await p1.persist.idle();

  const rec = await p1.store.get(matchKey(code));
  const byId = new Map(rec.seats.map((s) => [s.playerId, s]));
  assert.equal(rec.host, host.playerId, 'the host is part of the room');
  assert.equal(byId.get(host.playerId).ready, false);
  assert.equal(byId.get(guest.playerId).ready, true, 'and so is the ready flag of every seat');
  assert.equal(byId.get(host.playerId).tokenHash, tokenHash(hostTok));
  assert.equal(byId.get(guest.playerId).tokenHash, tokenHash(guestTok));
  assert.deepEqual(rec.spectators.map((s) => s.playerId), [watcher.playerId], 'and the spectators');
  assert.equal(rec.spectators[0].tokenHash, tokenHash(watchTok), 'with the identity that proves the seat on return');

  // the process CRASHES; BOTH players and the spectator come back, each on its own token
  const p2 = newProcess({ store: stateDir });
  const scan = await loadResumable(p2.store, { build: 'test-build', rulesHash: 'test-rules', perSecond: 0, log: quiet });
  assert.deepEqual(scan.refused, []);
  p2.bridge.markResumable(scan.records);
  for (const [tok, name, playerId] of [[hostTok, 'Host', host.playerId], [guestTok, 'Guest', guest.playerId], [watchTok, 'Watcher', watcher.playerId]]) {
    const adopted = p2.lobby.adoptIdentity(tok);
    assert.deepEqual(adopted, { playerId, roomCode: code }, `${name} claims its own place`);
    const s = sessionOf(p2.registry, { playerId: adopted.playerId, name, token: tok });
    s.roomCode = adopted.roomCode;
    p2.lobby.onHello(s, { resumed: false, repeat: false });
  }
  const room = p2.lobby.rooms.get(code);
  assert.ok(room, 'the room came back');
  assert.equal(room.hostId, host.playerId, 'the recorded host is the host again');
  assert.equal(room.activeHumans().length, 2, 'both humans are back on their seats');
  assert.equal(room.seatOf(guest.playerId).ready, true, 'with the ready flag they left');
  assert.equal(room.seats.filter((s) => s && s.isBot).length, 1, 'the AI teammate is back');
  assert.equal(room.spectators.length, 1, 'and the spectator seat');
  assert.equal(room.spectatorOf(watcher.playerId).connected, true, 'attached to the returning spectator');
  p2.lobby.shutdown('test');
});
