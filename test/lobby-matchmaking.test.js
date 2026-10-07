// test/lobby-matchmaking.test.js — 搜寻队友 (matchmaking, DESIGN §26) end to end over a real server: four connected
// doctors in one pool form a full room at once, a smaller pool keeps searching forever (the owner removed the 120 s
// deadline: "不要那个120s超时了，如果没匹配到就一直匹配" — no AI fill either), and nothing may start a pool by hand.
// Also covers the sharp edges: a refused room.create / room.join must not end the search silently, the difficulty is
// the pool key, a dropped searcher's entry survives for the reconnect, and more connected searchers than seats must
// not drop anyone. Real servers on random ports; `StubMatch` so a start does not run a battle (as in test/lobby.test.js).

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { StubMatch as Match } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, MAX_SEATS } from '../shared/constants.js';

/** How long a case waits to prove a small pool really keeps searching: long past the 120 s rule this build dropped. */
const KEEP_WAITING = 400;
/** srv.url is the HTTP origin; the socket lives at /ws. */
const wsUrl = (s) => `ws://127.0.0.1:` + s.port + `/ws`;

describe('搜寻队友 / matchmaking (DESIGN §26)', () => {
  let srv;
  /** @type {string} */
  let WS;
  /** @type {Set<TestClient>} */
  let open;
  /** @type {TestClient[]} */
  let peers;

  before(async () => {
    srv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true, MatchClass: Match,
      matchQueueMax: 32, maxMatchesPerAddr: 0,
    });
    WS = wsUrl(srv);
    open = new Set();
    peers = [];
  });

  after(async () => {
    await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
    await srv.close();
  });

  afterEach(async () => {
    // Every case starts from an empty lobby: drop the clients, then let the lobby dispose what they left behind.
    await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
    open.clear();
    peers = [];
    for (const room of [...srv.lobby.rooms.values()]) srv.lobby.disposeRoom(room, 'test');
    for (const pool of [...srv.lobby.queues.values()]) srv.lobby.clearPool(pool);
    await delay(20);
  });

  /** Connect + hello; `.id` is the playerId, `.welcome` the welcome frame (it carries the resume token). */
  async function player(name) {
    const c = await TestClient.connect(WS);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.welcome = w;
    open.add(c);
    peers.push(c);
    return c;
  }

  /** `queue.join` with the direct reply asserted to be `ok`. */
  async function join(c, difficulty = 'HARD') {
    const r = await c.request({ t: 'queue.join', difficulty });
    assert.equal(r.t, 'ok', `queue.join replied ${JSON.stringify(r)}`);
    return r;
  }

  /** The running-match `room.state` a matchmade client receives, with its human/AI split asserted. */
  async function formed(c, humans) {
    const st = await c.waitFor('room.state', (s) => s.inMatch === true, 2000);
    assert.equal(st.mode, 'coop');
    assert.equal(st.seats.filter((s) => s && !s.isBot).length, humans, JSON.stringify(st.seats));
    assert.equal(st.seats.filter((s) => s && s.isBot).length, MAX_SEATS - humans);
    for (const s of st.seats) {
      if (!s) continue;
      assert.equal(s.ready, true, 'a matchmade member is ready by construction');
      assert.equal(s.connected, true);
    }
    return st;
  }

  test('4 searchers form the room at once — 4 humans, no AI, the match already started', async () => {
    const [a, b, c, d] = await Promise.all([player('A'), player('B'), player('C'), player('D')]);
    await join(a, 'NORMAL');
    const first = await a.waitFor('queue.state', (m) => m.active && m.size === 1);
    assert.equal(first.max, MAX_SEATS);
    assert.equal(first.solo, true, 'nobody else is searching yet, so the panel says so');
    await join(b, 'NORMAL');
    await a.waitFor('queue.state', (m) => m.size === 2);
    await join(c, 'NORMAL');
    await join(d, 'NORMAL'); // the 4th forms the room before any timer fires

    const states = await Promise.all([a, b, c, d].map((p) => formed(p, MAX_SEATS)));
    assert.equal(new Set(states.map((s) => s.code)).size, 1, 'one room for the whole pool');
    assert.equal(states[0].hostId, a.id, 'the earliest searcher owns the room');
    assert.equal(srv.lobby.queues.size, 0, 'the pool is gone');
    assert.equal(srv.lobby.queueSize(), 0);
    // The search ends on the client side too (main.js clears store.queue on active:false).
    assert.ok(peers.every((p) => p.log.some((m) => m.t === 'queue.state' && m.active === false)), 'every client is told the search ended');
  });

  test('2 searchers keep waiting: no deadline, no AI fill, no room', async () => {
    const [a, b] = await Promise.all([player('A'), player('B')]);
    await join(a, 'HARD');
    await join(b, 'HARD');
    const st = await a.waitFor('queue.state', (m) => m.size === 2);
    assert.equal(st.solo, false, 'two doctors is not the solo hint');
    assert.equal(srv.lobby.rooms.size, 0);

    // Nothing happens with time alone: the pool has no timer and never fills the seats with AI.
    await delay(KEEP_WAITING);
    assert.equal(srv.lobby.rooms.size, 0, 'two humans never form a room by themselves');
    assert.equal(srv.lobby.queueSize(), 2, 'both are still searching');
    assert.equal(st.max, MAX_SEATS);

    // The third one still does not start it; the fourth does (next case covers the formation itself).
    const c = await player('C');
    await join(c, 'HARD');
    await a.waitFor('queue.state', (m) => m.size === 3);
    await delay(80);
    assert.equal(srv.lobby.rooms.size, 0, 'three is still not four');
  });

  test('a lone searcher is told nobody else is waiting (solo) and simply keeps waiting', async () => {
    const a = await player('A');
    await join(a, 'FUNNY');
    const late = await a.waitFor('queue.state', (m) => m.active && m.solo === true, 2000);
    assert.equal(late.size, 1);
    assert.equal(srv.lobby.rooms.size, 0, 'one human never forms a room by itself');
    // Nothing can start the pool by hand: no such intent exists (the owner: whoever clicks it would cut the wait
    // of the others short), so the lone searcher stays until they cancel or somebody joins.
    const refused = await a.request({ t: 'queue.startAi' });
    assert.equal(refused.t, 'error');
    assert.equal(refused.code, ERR.BAD_MSG, 'queue.startAi is not a protocol intent');
    await delay(KEEP_WAITING);
    assert.equal(srv.lobby.queueSize(), 1, 'still waiting');
    const left = await a.request({ t: 'queue.leave' });
    assert.equal(left.t, 'ok');
    assert.equal(srv.lobby.queueSize(), 0);
  });

  test('queue.leave cancels: the client is told active:false and no room appears later', async () => {
    const a = await player('A');
    await join(a, 'ABYSS');
    const r = await a.request({ t: 'queue.leave' });
    assert.equal(r.t, 'ok');
    const idle = await a.waitFor('queue.state', (m) => m.active === false);
    assert.equal(idle.active, false); // active:false carries nothing else — the client drops store.queue
    assert.equal(srv.lobby.queueSize(), 0);
    await a.expectNone('room.state', () => true, KEEP_WAITING);
  });

  test('the difficulty is the pool key: searchers of different difficulties never meet', async () => {
    const a = await player('A');
    const b = await player('B');
    await join(a, 'HARD');
    await join(b, 'FUNNY');
    await delay(KEEP_WAITING);
    assert.equal(srv.lobby.queues.size, 2, 'two pools');
    assert.equal(srv.lobby.queueSize(), 2);
    await a.expectNone('room.state', () => true, 60);
    // Repeating the same difficulty is idempotent (a double click, or a reconnect asking again).
    await join(a, 'HARD');
    assert.equal(srv.lobby.queueSize(), 2);
    await a.waitFor('queue.state', (m) => m.active && m.difficulty === 'HARD');
  });

  test('starting a search leaves the lobby room it was sitting in', async () => {
    const a = await player('A');
    const b = await player('B');
    const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
    assert.equal(created.t, 'ok');
    const st = await a.waitFor('room.state', (s) => s.hostId === a.id);
    await b.request({ t: 'room.join', code: st.code });
    await b.waitFor('room.state', (s) => s.code === st.code);
    await join(b, 'HARD'); // b leaves the room to search
    const after = await a.waitFor('room.state', (s) => s.code === st.code && !s.seats.some((x) => x && x.playerId === b.id));
    assert.equal(after.seats.filter((x) => x && !x.isBot).length, 1);
    assert.equal(srv.lobby.queueSize(), 1);
  });

  test('a dropped searcher keeps the entry (a reconnect resumes) but is not seated', async () => {
    const a = await player('A');
    const b = await player('B');
    await join(a, 'NORMAL');
    await join(b, 'NORMAL');
    await a.terminate(); // the socket drops; the session (and its entry) stays for the reconnect window
    const late = await b.waitFor('queue.state', (m) => m.active && m.solo === true, 2000);
    assert.equal(late.size, 1, 'size counts connected humans only');
    assert.equal(srv.lobby.queueSize(), 2, 'the dropped entry is kept for the reconnect window');
    assert.equal(srv.lobby.rooms.size, 0);
    // The reconnect window expiring drops it for good (registry.onExpire → lobby.onExpire).
    srv.lobby.onExpire(srv.registry.byId(a.id));
    assert.equal(srv.lobby.queueSize(), 1);
    await b.expectNone('room.state', () => true, 60);
  });

  test('room.create ends the search, and a running match refuses a new one', async () => {
    const a = await player('A');
    await join(a, 'HARD');

    const r = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
    assert.equal(r.t, 'ok');
    await a.waitFor('room.state', (s) => s.hostId === a.id);
    assert.equal(srv.lobby.queueSize(), 0, 'no stale entry behind the room');

    await a.request({ t: 'room.addBot' });
    const started = await a.request({ t: 'room.start' });
    assert.equal(started.t, 'ok', JSON.stringify(started));
    await a.waitFor('room.state', (s) => s.inMatch === true);
    const refused = await a.request({ t: 'queue.join', difficulty: 'HARD' });
    assert.equal(refused.t, 'error');
    assert.equal(refused.code, ERR.ROOM_STARTED);
  });

  test('cancelling outside a pool is idempotent, and an unknown difficulty is BAD_MSG', async () => {
    const a = await player('A');
    const bad = await a.request({ t: 'queue.join', difficulty: 'NOPE' });
    assert.equal(bad.t, 'error');
    assert.equal(bad.code, ERR.BAD_MSG);
    const leave = await a.request({ t: 'queue.leave' });
    assert.equal(leave.t, 'ok', 'cancelling without a search is idempotent');
  });

  test('more connected searchers than seats: four play, the rest keep searching', async () => {
    // queue.join forms at four, so five *connected* searchers are only reachable through reconnects; build the pool
    // by hand (white box) and form it.
    const cs = [];
    for (const name of ['A', 'B', 'C', 'D', 'E']) cs.push(await player(name));
    const pool = srv.lobby.poolOf('NORMAL');
    for (const c of cs) pool.entries.push({ session: srv.registry.byId(c.id), at: Date.now() });
    assert.equal(srv.lobby.formQueue(pool, 2), true);

    const room = [...srv.lobby.rooms.values()][0];
    assert.equal(room.activeHumans().length, MAX_SEATS, 'a room holds MAX_SEATS humans');
    assert.equal(room.seats.filter((s) => s && s.isBot).length, 0);
    assert.equal(srv.lobby.queueSize(), 1, 'the fifth doctor is still searching, not silently dropped');
    assert.equal((await cs[4].waitFor('queue.state', (m) => m.active === true && m.size === 1)).max, MAX_SEATS);
    for (const c of cs.slice(0, MAX_SEATS)) await formed(c, MAX_SEATS);
    await cs[4].expectNone('room.state', () => true, 60);
  });

  test('a refused room.join leaves the search alone', async () => {
    const a = await player('A');
    const b = await player('B');
    await join(a, 'HARD');
    const solo = await b.request({ t: 'room.create', mode: 'solo', difficulty: 'HARD' });
    assert.equal(solo.t, 'ok', JSON.stringify(solo));
    const soloState = await b.waitFor('room.state', (s) => s.mode === 'solo');
    const refused = await a.request({ t: 'room.join', code: soloState.code });
    assert.equal(refused.t, 'error');
    assert.equal(refused.code, ERR.ROOM_FULL);
    assert.equal(srv.lobby.queueSize(), 1, 'a refused join must not silently end the search');
    // ...and the searcher is not told the search ended (that panel would count up forever).
    await a.expectNone('queue.state', (m) => m.active === false, 80);
  });

  test('a refused room.create leaves the search alone (room cap)', async () => {
    const tiny = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: Match, maxRooms: 0 });
    const c = await TestClient.connect(wsUrl(tiny));
    try {
      const w = await c.hello('A');
      c.id = w.playerId;
      assert.equal((await c.request({ t: 'queue.join', difficulty: 'HARD' })).t, 'ok');
      const refused = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
      assert.equal(refused.t, 'error');
      assert.equal(tiny.lobby.queueSize(), 1, 'a refused create must not silently end the search');
      assert.equal((await c.waitFor('queue.state', (m) => m.active === true)).size, 1);
    } finally {
      await c.terminate().catch(() => {});
      await tiny.close();
    }
  });

  test('a reconnect puts the searcher back in the pool, and the fourth doctor forms the room', async () => {
    // A searches and drops; its entry stays for the reconnect window. B searches alone (size 1, solo). A comes back
    // with its token: the pool is two connected humans again and still waits — the pool has no timer to re-arm, so a
    // reconnect is just another event that re-broadcasts the state (and can complete the group).
    const a = await player('A');
    const token = a.welcome.token;
    await join(a, 'HARD');
    await a.terminate();
    await delay(60);
    const b = await player('B');
    await join(b, 'HARD');
    await b.waitFor('queue.state', (m) => m.active && m.solo === true, 2000);
    assert.equal(srv.lobby.rooms.size, 0, 'nobody to form with yet');

    const again = await TestClient.connect(WS);
    open.add(again);
    const hello = await again.hello('A', token);
    again.id = hello.playerId;
    assert.equal(hello.resumed, true, 'the token resumed the same session');
    const back = await again.waitFor('queue.state', (m) => m.active && m.size === 2, 2000);
    assert.equal(back.solo, false, 'two connected humans again');
    await delay(KEEP_WAITING);
    assert.equal(srv.lobby.rooms.size, 0, 'two still do not start anything');

    const [c, d] = await Promise.all([player('C'), player('D')]);
    await join(c, 'HARD');
    await join(d, 'HARD');
    const states = await Promise.all([again, b, c, d].map((p) => formed(p, MAX_SEATS)));
    assert.equal(new Set(states.map((s) => s.code)).size, 1);
  });

  test('matchQueueMax refuses further searchers with RATE', async () => {
    const small = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: Match, matchQueueMax: 2 });
    const SMALL_WS = wsUrl(small);
    const clients = [];
    try {
      for (const name of ['A', 'B', 'C']) {
        const c = await TestClient.connect(SMALL_WS);
        const w = await c.hello(name);
        c.id = w.playerId;
        clients.push(c);
      }
      for (const c of clients.slice(0, 2)) {
        const r = await c.request({ t: 'queue.join', difficulty: 'HARD' });
        assert.equal(r.t, 'ok', JSON.stringify(r));
      }
      const full = await clients[2].request({ t: 'queue.join', difficulty: 'HARD' });
      assert.equal(full.t, 'error');
      assert.equal(full.code, ERR.RATE);
      assert.equal(small.lobby.queueSize(), 2);
    } finally {
      await Promise.all(clients.map((c) => c.terminate().catch(() => {})));
      await small.close();
    }
  });
});
