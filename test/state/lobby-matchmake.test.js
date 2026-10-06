// test/state/lobby-matchmake.test.js — 同盟匹配 (user request): an alliance searches for teammates from INSIDE the room.
//
// The old flow (DESIGN §23, queue.join) pooled lone sessions and built a brand-new room the moment four of them were
// connected: the room you were in was left behind, and friends who wanted to play together could not use it at all.
// The new flow keeps the room: its host puts the alliance in the difficulty's pool, the pool MOVES whole groups into
// the OLDEST searching alliance while the seats fit, and a full alliance starts by itself. Friends keep the seats they
// took by invite code, the host can still fill what is left with AI (room.addBot), and nothing here needs a "ready".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { getData } from '../../server/data.js';
import { ERR, MAX_SEATS } from '../../shared/constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const DATA = getData({ log: quiet });

function newLobby() {
  const registry = new SessionRegistry({});
  const lobby = new Lobby({ registry, log: quiet, MatchClass: StubMatch, getData: () => DATA, seedFn: () => 7 });
  return { registry, lobby };
}

/** A session as net.js builds it. */
function sessionOf(registry, name) {
  const s = registry.create(name);
  s.connected = true;
  return s;
}

/** room.create + the room it made. `pool: true` is the 同盟匹配 card; without it the room is a 同盟模拟 alliance. */
function create(lobby, session, { mode = 'coop', difficulty = 'NORMAL', pool = true } = {}) {
  assert.equal(lobby.onMessage(session, { t: 'room.create', mode, difficulty, pool }).ok, true, 'room.create');
  return lobby.roomOf(session);
}

test('a 同盟模拟 alliance may not enter the public pool (owner report 2026-10-06)', () => {
  const { registry, lobby } = newLobby();
  const a = sessionOf(registry, 'A');
  const room = create(lobby, a, { pool: false });

  assert.equal(room.pool, false, 'the room carries the card it was created from');
  assert.equal(room.toState().pool, false, 'and tells the client, so it offers 开始模拟');
  const refused = lobby.onMessage(a, { t: 'room.matchmake' });
  assert.equal(refused.error, ERR.BAD_MSG, 'room.matchmake is refused: 同盟模拟 never meets a stranger');
  assert.equal(room.searching, false, 'and nothing was queued');
  assert.equal(lobby.onMessage(a, { t: 'room.start' }).ok, true, 'the host starts it directly instead');

  const b = sessionOf(registry, 'B');
  const pooled = create(lobby, b);
  assert.equal(pooled.pool, true, 'a 同盟匹配 room may search');
  assert.equal(pooled.toState().pool, true);
  assert.equal(lobby.onMessage(b, { t: 'room.matchmake' }).ok, true, 'and room.matchmake works there');
});

test('room.matchmake: the host starts the search; a solo room never searches and a guest may not start it', () => {
  const { registry, lobby } = newLobby();
  const a = sessionOf(registry, 'A');
  const room = create(lobby, a);

  const s = sessionOf(registry, 'S');
  create(lobby, s, { mode: 'solo' });
  assert.equal(lobby.onMessage(s, { t: 'room.matchmake' }).error, ERR.BAD_MSG, 'a solo room has nobody to match with');

  const b = sessionOf(registry, 'B');
  assert.equal(lobby.onMessage(b, { t: 'room.join', code: room.code }).ok, true);
  assert.equal(lobby.onMessage(b, { t: 'room.matchmake' }).error, ERR.NOT_HOST, 'only the host starts the search');

  assert.equal(lobby.onMessage(a, { t: 'room.matchmake' }).ok, true);
  assert.equal(room.searching, true);
  assert.equal(room.toState().searching, true, 'the room tells every seat it is searching');
  assert.equal(room.match, null, 'one doctor is not a match');

  assert.equal(lobby.onMessage(a, { t: 'room.matchmake', on: false }).ok, true, 'the host can call it off');
  assert.equal(room.searching, false);
  assert.equal(room.toState().searching, false);
  assert.equal(lobby.onMessage(a, { t: 'room.matchmake', on: false }).ok, true, 'cancelling twice is harmless');
});

test('a searching alliance absorbs whole groups from other searching alliances of the same difficulty, oldest first', () => {
  const { registry, lobby } = newLobby();
  const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map((n) => sessionOf(registry, n));
  const roomA = create(lobby, a);
  const roomB = create(lobby, b);
  const roomC = create(lobby, c, { difficulty: 'HARD' });
  const roomD = create(lobby, d);
  const roomE = create(lobby, e);

  assert.equal(lobby.onMessage(a, { t: 'room.matchmake' }).ok, true, 'A searches first: it anchors the pool');
  assert.equal(lobby.onMessage(b, { t: 'room.matchmake' }).ok, true);
  assert.equal(lobby.roomOf(b).code, roomA.code, 'B was moved into the older alliance');
  assert.equal(roomA.activeHumans().length, 2);
  assert.equal(lobby.rooms.has(roomB.code), false, 'the emptied alliance is disposed');
  assert.equal(roomA.matchCount, 0, 'two doctors are not a match yet');
  assert.equal(b.roomCode, roomA.code, 'B\'s session follows the move');

  assert.equal(lobby.onMessage(c, { t: 'room.matchmake' }).ok, true);
  assert.equal(lobby.roomOf(c).code, roomC.code, 'a HARD search never joins a NORMAL one');
  assert.equal(roomC.activeHumans().length, 1);

  assert.equal(lobby.onMessage(d, { t: 'room.matchmake' }).ok, true);
  assert.equal(lobby.roomOf(d).code, roomA.code, 'D was moved into the older alliance');
  assert.equal(roomA.activeHumans().length, 3);
  assert.equal(roomA.matchCount, 0, 'three doctors are still not a match');
  assert.equal(roomC.activeHumans().length, 1, 'the HARD alliance keeps waiting');

  assert.equal(lobby.onMessage(e, { t: 'room.matchmake' }).ok, true);
  assert.equal(lobby.roomOf(e).code, roomA.code, 'E was moved into the older alliance');
  assert.equal(roomA.activeHumans().length, MAX_SEATS, 'four doctors');
  assert.equal(roomA.matchCount, 1, 'a full alliance starts by itself');
  assert.equal(roomA.searching, false, 'and it stops searching');
  for (const s of [a, b, d, e]) assert.equal(lobby.roomOf(s).code, roomA.code, `${s.name} plays in the anchored alliance`);
  assert.equal(lobby.rooms.has(roomE.code), false, 'the emptied alliance is disposed');
});

test('the host fills what is left with AI while searching, and a full alliance starts by itself', () => {
  const { registry, lobby } = newLobby();
  const a = sessionOf(registry, 'A');
  const room = create(lobby, a);
  assert.equal(lobby.onMessage(a, { t: 'room.matchmake' }).ok, true);
  assert.equal(room.matchCount, 0);
  while (room.freeSeat() >= 0) assert.equal(lobby.onMessage(a, { t: 'room.addBot' }).ok, true, 'addBot');
  assert.equal(room.activeHumans().length, 1);
  assert.equal(room.seats.filter((s) => s && s.isBot).length, MAX_SEATS - 1, 'AI teammates fill the alliance up');
  assert.equal(room.matchCount, 1, 'the last AI teammate started the match');
  assert.equal(room.searching, false, 'and the alliance stops searching');
});

test('an alliance that is already full starts at once — four friends do not wait for a pool', () => {
  const { registry, lobby } = newLobby();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => sessionOf(registry, n));
  const room = create(lobby, a);
  for (const s of [b, c, d]) assert.equal(lobby.onMessage(s, { t: 'room.join', code: room.code }).ok, true);
  assert.equal(room.activeHumans().length, MAX_SEATS);
  assert.equal(room.matchCount, 0);
  assert.equal(lobby.onMessage(a, { t: 'room.matchmake' }).ok, true);
  assert.equal(room.matchCount, 1, 'four doctors in the room start without waiting for a pool');
});
