// Server-wide browser presence: counts players that said hello, once per player, pushed coalesced.
//
// The title screen keeps a socket that never hellos (the server retires it after helloTimeoutMs and the
// client opens a fresh one), so counting raw sockets made the number bounce N → N−1 → N for everybody.
// Tabs share a session (the second tab takes it over), so keying by playerId keeps them at one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startServer } from '../server/index.js';
import { Network, SessionRegistry } from '../server/net.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const COALESCE_MS = 20;

async function harness(t, options = {}) {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, presenceCoalesceMs: COALESCE_MS, ...options,
  });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  });
  return {
    srv,
    async connect() {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      return c;
    },
  };
}

/**
 * Wait until this socket is told the expected number (earlier frames it saw while the count was lower are
 * skipped), then check the frame carries nothing but the aggregate.
 */
async function count(c, expected) {
  const msg = await c.waitFor('presence', (m) => m.onlineCount === expected);
  assert.deepEqual(Object.keys(msg).sort(), ['onlineCount', 't'], 'only an aggregate is exposed');
  return msg;
}

test('only players who said hello are counted, and everyone is told the number', async (t) => {
  const { srv, connect } = await harness(t);
  const title = await connect();
  await count(title, 0);
  assert.equal(srv.network.onlineCount, 0, 'a socket that never helloed is not online');

  await title.hello('Player');
  await count(title, 1);
  assert.equal(srv.network.onlineCount, 1);

  const second = await connect();
  await count(second, 1);
  assert.equal(srv.network.onlineCount, 1, 'a new socket is told the number without joining it');

  await second.hello('Second');
  await Promise.all([count(title, 2), count(second, 2)]);
  assert.equal(srv.network.onlineCount, 2);
});

test('retiring a title-screen socket never moves the number', async (t) => {
  const { srv, connect } = await harness(t);
  const player = await connect();
  await player.hello('Player');
  await count(player, 1);

  // what the server's hello watchdog does to a visitor that never sent hello
  const visitor = await connect();
  await count(visitor, 1);
  const visitorConn = [...srv.network.conns.values()].find((c) => !c.session);
  assert.ok(visitorConn, 'the visitor holds an un-helloed socket');
  visitorConn.close(4002, 'hello timeout');
  await visitor.closed;

  const fresh = await connect();
  await count(fresh, 1, 'the replacement is told the unchanged number');
  const playerConn = [...srv.network.conns.values()].find((c) => c.session);
  assert.equal(playerConn.presenceSent, 1, 'the player was not resent a number it already knows');
  assert.equal(srv.network.onlineCount, 1, 'rotating un-helloed sockets never moves the number');
});

test('a player with several tabs counts once and keeps playing after a tab is replaced', async (t) => {
  const { srv, connect } = await harness(t);
  const observer = await connect();
  await observer.hello('Watcher');
  await count(observer, 1);

  const firstTab = await connect();
  const welcome = await firstTab.hello('Player');
  await Promise.all([count(firstTab, 2), count(observer, 2)]);

  const secondTab = await connect();
  const resumed = await secondTab.hello('Player', welcome.token);
  assert.equal(resumed.playerId, welcome.playerId, 'the second tab takes over the same session');
  assert.equal((await firstTab.closed).code, 4001, 'the first tab is closed as replaced');
  await count(secondTab, 2);
  assert.equal(srv.network.onlineCount, 2, 'two tabs of one player are one player');
});

test('a disconnected session stops counting even though it stays resumable', async (t) => {
  const { srv, connect } = await harness(t);
  const observer = await connect();
  await observer.hello('Watcher');
  const player = await connect();
  const welcome = await player.hello('Player');
  await Promise.all([count(observer, 2), count(player, 2)]);

  await player.close();
  await count(observer, 1);
  assert.equal(srv.registry.byToken(welcome.token).connected, false, 'the session is still resumable');
  assert.equal(srv.network.onlineCount, 1);

  const back = await connect();
  const resumed = await back.hello('Player', welcome.token);
  assert.equal(resumed.playerId, welcome.playerId);
  await count(back, 2);
  assert.equal(srv.network.onlineCount, 2, 'resuming does not count the retained session twice');
});

test('AI teammates and room membership do not change the online browser count', async (t) => {
  const { srv, connect } = await harness(t);
  const player = await connect();
  await player.hello('Host');
  await count(player, 1);
  assert.equal((await player.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  await player.waitFor('room.state');
  assert.equal((await player.request({ t: 'room.addBot' })).t, 'ok');
  const room = await player.waitFor('room.state', (s) => s.seats.some((seat) => seat?.isBot));
  assert.equal(room.seats.filter(Boolean).length, 2);
  assert.equal(srv.network.onlineCount, 1, 'the AI seat has no browser connection');
  await player.expectNone('presence', () => true, COALESCE_MS * 3);
});

test('presence pushes are coalesced and only sent to sockets that need them', async (t) => {
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    frames = [];
    send(data, done) { this.frames.push(JSON.parse(data)); done?.(); }
    close() { this.readyState = 2; }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const net = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} }, options: { presenceCoalesceMs: COALESCE_MS } });
  t.after(() => net.close());
  const tick = () => new Promise((r) => setTimeout(r, COALESCE_MS * 3));

  const a = new Socket();
  net.handleConnection(a);
  assert.deepEqual(a.frames, [], 'a connect alone does not broadcast synchronously');
  await tick();
  assert.deepEqual(a.frames, [{ t: 'presence', onlineCount: 0 }], 'coalesced into one frame');

  // five title-screen visits landing at once: no number change, but each of them still learns it
  const burst = [];
  for (let i = 0; i < 5; i++) { const s = new Socket(); burst.push(s); net.handleConnection(s); }
  await tick();
  assert.deepEqual(a.frames, [{ t: 'presence', onlineCount: 0 }], 'an unchanged number is not resent');
  for (const s of burst) assert.deepEqual(s.frames, [{ t: 'presence', onlineCount: 0 }], 'new sockets are always told');

  // one of them actually joins the game
  const joined = net.conns.get(burst[0]);
  joined.session = { playerId: 'p1', token: 't1', ws: burst[0] };
  net.schedulePresence();
  await tick();
  assert.equal(net.onlineCount, 1);
  assert.equal(a.frames.at(-1).onlineCount, 1, 'a real change reaches every socket');
  for (const s of burst) assert.equal(s.frames.at(-1).onlineCount, 1);

  // a second tab of the same player is not a second player
  const tab2 = new Socket();
  net.handleConnection(tab2);
  net.conns.get(tab2).session = { playerId: 'p1', token: 't1', ws: tab2 };
  net.schedulePresence();
  await tick();
  assert.equal(net.onlineCount, 1, 'two tabs of one player count once');
  assert.deepEqual(tab2.frames, [{ t: 'presence', onlineCount: 1 }], 'the new tab is told, nobody else is');
  assert.equal(a.frames.at(-1).onlineCount, 1);
});
