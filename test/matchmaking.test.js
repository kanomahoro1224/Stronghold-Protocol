import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Lobby } from '../server/lobby.js';
import { TestClient } from './helpers/wsClient.js';

const clients = [];
let srv;

async function player(name) {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  const w = await c.hello(name);
  c.id = w.playerId;
  clients.push(c);
  return c;
}

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  await srv?.close();
});

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, matchmakingTickMs: 10 });
});

test('public and room matchmaking retain operator ownership and self-selected picks', async () => {
  const c = await player('QLoadout');
  const session = srv.registry.byId(c.id);
  session.notOwned = ['chess_char_4_22_a'];
  session.diy = { chess_char_5_diy1_a: { charId: 'char_112_siege', skillIndex: 2 } };
  for (const inRoom of [false, true]) {
    if (inRoom) {
      assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty: 'ABYSS' })).t, 'ok');
      await c.waitFor('room.state', (s) => s.code);
    }
    assert.equal((await c.request({ t: 'match.join', mode: 'coop', difficulty: 'ABYSS' })).t, 'ok');
    const entry = srv.lobby.queueByPlayer.get(c.id);
    assert.deepEqual(entry.players[0].notOwned, session.notOwned);
    assert.deepEqual(entry.players[0].diy, session.diy);
    assert.equal((await c.request({ t: 'match.leave' })).t, 'ok');
  }
  assert.equal((await c.request({ t: 'room.leave' })).t, 'ok');
});

test('four alliance queue entries start one four-seat preparation match immediately', async () => {
  const cs = await Promise.all(['A', 'B', 'C', 'D'].map(player));
  for (const c of cs) {
    const reply = await c.request({ t: 'match.join', mode: 'coop', difficulty: 'FUNNY' });
    assert.equal(reply.t, 'ok');
    if (c === cs[0] && cs.indexOf(c) === 0) {
      const queued = await c.waitFor('match.queue', (m) => m.status === 'queued');
      assert.equal(queued.count, 1);
    }
    if (c === cs[1]) {
      const updated = await cs[0].waitFor('match.queue', (m) => m.status === 'queued' && m.count === 2);
      assert.equal(updated.count, 2);
    }
  }
  for (const c of cs) {
    const pub = await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    assert.equal(pub.players.length, 4);
    assert.equal(pub.players.filter((p) => p.isBot).length, 0);
  }
  assert.equal((await cs[0].request({ t: 'g.autoplay', on: true })).t, 'ok', 'standalone queue match accepts in-match intents');
  assert.equal(srv.lobby.stats().rooms, 0);
});

test('a waiting room ticket is combined with public players and everyone starts', async () => {
  const host = await player('Room head');
  const cs = await Promise.all(['Public A', 'Public B', 'Public C'].map(player));
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await host.waitFor('room.state', (s) => s.code);
  assert.equal((await host.request({ t: 'match.join', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const queued = await host.waitFor('match.queue', (m) => m.status === 'queued');
  assert.equal(queued.count, 1);
  assert.equal(queued.deadlineAt, undefined, 'the queue carries no countdown');
  assert.equal(queued.fillBots, undefined, 'and no fill-Bots switch');
  for (const [i, c] of cs.entries()) {
    assert.equal((await c.request({ t: 'match.join', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    const seen = await c.waitFor('match.queue', (m) => m.status === 'queued');
    assert.equal(seen.count, i + 2, 'every queued party counts toward the same four seats');
  }
  for (const c of [...cs, host]) {
    const pub = await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    assert.deepEqual(pub.players.map((p) => p.playerId).sort(), [host.id, ...cs.map((x) => x.id)].sort());
    assert.equal(pub.players.filter((p) => p.isBot).length, 0, 'no seat is filled with AI');
  }
  const started = await host.waitFor('room.state', (s) => s.code === room.code && s.inMatch);
  assert.equal(started.matching, null, 'the room leaves the queue for its own match');
});

function manualQueue(t) {
  let now = 1000;
  const sessions = new Map();
  const lobby = new Lobby({ registry: { byId: (id) => sessions.get(id) }, now: () => now, options: {} });
  clearInterval(lobby.matchQueueTimer);
  lobby.matchQueueTimer = null;
  t.after(() => lobby.shutdown());
  const launched = [];
  lobby.broadcastState = () => {};                 // the manual queue has no real room behind it
  lobby.startQueuedMatch = (owner, players) => launched.push(players);
  let seq = 0;
  return {
    lobby, launched,
    at(time) { now = time; },
    queueState(entry) { return sessions.get(entry.players[0].playerId).messages.at(-1); },
    join({ count = 1, difficulty = 'NORMAL', room = null } = {}) {
      const entry = lobby.makeQueueEntry({ mode: 'coop', difficulty, room,
        players: Array.from({ length: count }, () => {
          const playerId = `queue-test-${++seq}`;
          const messages = [];
          sessions.set(playerId, { playerId, connected: true, messages,
            ws: { readyState: 1, bufferedAmount: 0, send: (data) => messages.push(JSON.parse(data)) } });
          return { playerId, isBot: false };
        }) });
      lobby.enqueueMatchEntry(entry);
      return entry;
    },
  };
}

for (const scenario of [
  { name: 'eight single players pair up into two full teams', sizes: [1, 1, 1, 1, 1, 1, 1, 1],
    counts: [4, 4, 4, 4, 4, 4, 4, 4], matches: 2, remaining: [] },
  { name: 'parties that cannot fit the head wait, the rest launch', sizes: [3, 2, 2, 2, 2, 2],
    counts: [3, 4, 4, 4, 4, 2], matches: 2, remaining: [0, 5] },
]) {
  test(`queue counts and immediate launches use actual groups: ${scenario.name}`, (t) => {
    const q = manualQueue(t);
    const entries = scenario.sizes.map((count) => q.join({ count }));
    assert.deepEqual(entries.map((entry) => q.queueState(entry).count), scenario.counts);
    assert.ok(entries.every((entry) => q.queueState(entry).capacity === 4));
    assert.ok(entries.every((entry) => q.queueState(entry).deadlineAt === undefined), 'no countdown is broadcast');
    const otherDifficulty = q.join({ difficulty: 'HARD' });
    assert.equal(q.queueState(otherDifficulty).count, 1);

    q.lobby.processMatchQueues();
    assert.equal(q.launched.length, scenario.matches, 'only full teams start');
    assert.ok(q.launched.every((players) => players.length === 4 && players.every((p) => !p.isBot)));
    const remaining = scenario.remaining.map((i) => entries[i]);
    assert.deepEqual(q.lobby.matchQueues.get('coop:NORMAL') || [], remaining);
    for (const entry of remaining) {
      assert.equal(q.queueState(entry).count, scenario.counts[entries.indexOf(entry)]);
      for (const p of entry.players) assert.equal(q.lobby.queueByPlayer.get(p.playerId), entry);
    }
    const launchedIds = q.launched.flat().map((p) => p.playerId);
    assert.equal(new Set(launchedIds).size, launchedIds.length, 'each human launches once');
    for (const id of launchedIds) assert.equal(q.lobby.queueByPlayer.has(id), false);
    q.lobby.processMatchQueues();
    assert.equal(q.launched.length, scenario.matches, 'scheduler ticks do not relaunch full groups');
  });
}

test('a group smaller than four waits indefinitely and starts once a teammate completes it', (t) => {
  const q = manualQueue(t);
  const first = q.join({ count: 2 });
  q.at(10_000_000);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 0, 'waiting never adds AI, however long the queue is open');
  assert.equal(q.queueState(first).count, 2);
  const second = q.join({ count: 2 });
  assert.equal(q.queueState(first).count, 4);
  assert.equal(q.queueState(second).count, 4);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 1);
  assert.equal(q.launched[0].length, 4);
  assert.equal(q.launched[0].filter((p) => p.isBot).length, 0);
  assert.deepEqual(q.lobby.matchQueues.get('coop:NORMAL'), undefined, 'the queue empties once the team starts');
});

test('a new teammate grows the group count without starting anything before four', (t) => {
  const q = manualQueue(t);
  const room = { code: 'TEST' };
  const first = q.join({ room });
  const queuedAt = first.queuedAt;
  q.at(60_000);
  const second = q.join();
  q.at(61_000);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 0);
  assert.equal(q.queueState(first).count, 2);
  assert.equal(q.queueState(second).count, 2);
  q.at(90_000);
  const third = q.join();
  assert.equal(q.queueState(first).count, 3);
  q.at(120_000);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 0, 'three seats still wait');
  const fourth = q.join();
  assert.equal(q.queueState(first).count, 4);
  assert.equal(first.queuedAt, queuedAt, 'original queue order is preserved');
  assert.deepEqual(room.matching, { queueId: first.queueId, queuedAt: first.queuedAt }, 'the room state carries no deadline');
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 1);
  assert.equal(q.launched[0].filter((p) => p.isBot).length, 0);
  assert.ok([first, second, third, fourth].every((entry) => q.lobby.queueByPlayer.has(entry.players[0].playerId) === false));
});

test('cancelling a party updates only its remaining group count', (t) => {
  const q = manualQueue(t);
  const first = q.join({ count: 3 });
  q.at(20_000);
  const second = q.join({ count: 2 });
  q.at(30_000);
  const third = q.join({ count: 2 });
  assert.equal(q.queueState(first).count, 3);
  assert.equal(q.queueState(second).count, 4);
  q.lobby.cancelMatchQueue(third);
  assert.equal(q.queueState(third).status, 'cancelled');
  assert.equal(q.queueState(second).count, 2);
  assert.equal(q.queueState(first).count, 3);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 0, 'nothing starts without four seats');
});

test('other difficulties and parties that do not fit never join a group', (t) => {
  const q = manualQueue(t);
  const first = q.join({ count: 3 });
  q.at(30_000);
  const otherDifficulty = q.join({ difficulty: 'HARD' });
  const largeParty = q.join({ count: 2 });
  assert.equal(q.queueState(first).count, 3);
  assert.equal(q.queueState(otherDifficulty).count, 1, 'another difficulty is a separate pool');
  assert.equal(q.queueState(largeParty).count, 2, 'a party that does not fit waits on its own');
  q.at(40_000);
  const teammate = q.join();
  assert.equal(q.queueState(first).count, 4, 'the single player completes the party of three');
  assert.equal(q.queueState(largeParty).count, 2);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 1, 'the full team starts');
  assert.equal(q.launched[0].filter((p) => p.isBot).length, 0);
  assert.deepEqual(q.lobby.matchQueues.get('coop:NORMAL'), [largeParty]);
  assert.deepEqual(q.lobby.matchQueues.get('coop:HARD'), [otherDifficulty]);
});

test('queue counts reach existing clients and leaving shrinks the group again', async () => {
  const a = await player('Countdown A'), b = await player('Countdown B');
  const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
  assert.equal(created.t, 'ok');
  const room = await a.waitFor('room.state', (s) => s.code);
  assert.equal((await a.request({ t: 'match.join', mode: 'coop', difficulty: 'HARD' })).t, 'ok');
  const original = await a.waitFor('match.queue', (m) => m.status === 'queued');
  assert.equal(original.count, 1);
  const matching = await a.waitFor('room.state', (s) => s.matching?.queueId === original.queueId);
  assert.deepEqual(matching.matching, { queueId: original.queueId, queuedAt: original.queuedAt });
  assert.equal((await b.request({ t: 'match.join', mode: 'coop', difficulty: 'HARD' })).t, 'ok');
  const updated = await a.waitFor('match.queue', (m) => m.status === 'queued' && m.count === 2);
  assert.equal(updated.deadlineAt, undefined);
  assert.equal(updated.queueId, original.queueId, 'the host keeps its own ticket');
  const joined = await b.waitFor('match.queue', (m) => m.status === 'queued' && m.count === 2);
  assert.notEqual(joined.queueId, updated.queueId, 'each party is its own ticket in the same group');
  assert.equal((await b.request({ t: 'match.leave' })).t, 'ok');
  const left = await a.waitFor('match.queue', (m) => m.status === 'queued' && m.count === 1);
  assert.equal(left.queueId, updated.queueId, 'the host keeps waiting');
  assert.equal((await a.request({ t: 'match.leave' })).t, 'ok');
  const cleared = await a.waitFor('room.state', (s) => s.matching === null);
  assert.equal(cleared.code, room.code);
});
