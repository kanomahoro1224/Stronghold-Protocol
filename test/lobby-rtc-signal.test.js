// 头像 P2P 的信令中继（server/lobby.js rtcSignal, shared/protocol.js `rtc.signal`）: the server forwards SDP/ICE
// between two seats of the SAME room and keeps nothing. These tests drive the real WebSocket lobby, because the
// point of the feature is that the server sees only the envelope — never the avatar, which travels on the
// DataChannel (public/js/ui/peerAvatars.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { RTC_LIMITS } from '../shared/protocol.js';

const ok = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', JSON.stringify(r));
  return r;
};
const bad = async (c, msg, code) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', JSON.stringify(r));
  assert.equal(r.code, code, JSON.stringify(r));
  return r;
};

async function lobby(t) {
  const errors = [], clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
    log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } });
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); assert.deepEqual(errors, []); });
  const join = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    const w = await c.hello(name);
    c.id = w.playerId; c.token = w.token;
    return c;
  };
  return { srv, join };
}

const OFFER = JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' });

test('rtc.signal reaches the addressed seat of the same room and is relayed verbatim', async (t) => {
  const { join } = await lobby(t);
  const host = await join('Host'), guest = await join('Guest');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const state = await host.waitFor('room.state');
  await ok(guest, { t: 'room.join', code: state.code });

  await ok(host, { t: 'rtc.signal', to: guest.id, kind: 'offer', data: OFFER });
  const got = await guest.waitFor('rtc.signal', (m) => m.from === host.id);
  assert.equal(got.kind, 'offer');
  assert.equal(got.data, OFFER, 'the payload must arrive unchanged — the server does not parse it');

  // the other direction (an answer) works the same way
  await ok(guest, { t: 'rtc.signal', to: host.id, kind: 'answer', data: JSON.stringify({ type: 'answer', sdp: 'x' }) });
  const back = await host.waitFor('rtc.signal', (m) => m.from === guest.id);
  assert.equal(back.kind, 'answer');
});

test('rtc.signal is refused outside a room, to yourself, or to a player in another room', async (t) => {
  const { join } = await lobby(t);
  const a = await join('A'), b = await join('B'), c = await join('C');
  await bad(a, { t: 'rtc.signal', to: b.id, kind: 'offer', data: OFFER }, 'NOT_IN_ROOM'); // neither is in a room
  await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const roomA = await a.waitFor('room.state');
  await ok(b, { t: 'room.join', code: roomA.code });
  await ok(c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  await c.waitFor('room.state');

  await bad(a, { t: 'rtc.signal', to: a.id, kind: 'offer', data: OFFER }, 'BAD_MSG'); // self
  await bad(a, { t: 'rtc.signal', to: c.id, kind: 'offer', data: OFFER }, 'NOT_IN_ROOM'); // another room
  await bad(a, { t: 'rtc.signal', to: 'p_nobody', kind: 'offer', data: OFFER }, 'NOT_IN_ROOM'); // unknown player
  // the guest may answer the host: membership is symmetric
  await ok(b, { t: 'rtc.signal', to: a.id, kind: 'ice', data: JSON.stringify({ candidate: 'c' }) });
  const ice = await a.waitFor('rtc.signal', (m) => m.from === b.id);
  assert.equal(ice.kind, 'ice');
});

test('rtc.signal validates its envelope and caps the payload length', async (t) => {
  const { join } = await lobby(t);
  const host = await join('Host'), guest = await join('Guest');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const state = await host.waitFor('room.state');
  await ok(guest, { t: 'room.join', code: state.code });

  // unknown kind, missing fields and an oversized SDP are all refused by shared/protocol.js validateC2S
  await bad(host, { t: 'rtc.signal', to: guest.id, kind: 'nope', data: OFFER }, 'BAD_MSG');
  await bad(host, { t: 'rtc.signal', to: guest.id, kind: 'offer' }, 'BAD_MSG');
  await bad(host, { t: 'rtc.signal', to: guest.id, kind: 'offer', data: 'x'.repeat(RTC_LIMITS.signalLen + 1) }, 'BAD_MSG');
  // the largest accepted payload still gets through
  await ok(host, { t: 'rtc.signal', to: guest.id, kind: 'offer', data: 'x'.repeat(RTC_LIMITS.signalLen) });
});

test('rtc.signal is rate limited per session so a looping client cannot flood a peer', async (t) => {
  const { join } = await lobby(t);
  const host = await join('Host'), guest = await join('Guest');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const state = await host.waitFor('room.state');
  await ok(guest, { t: 'room.join', code: state.code });

  // TokenBucket(60/s, burst 120): the burst goes through, then the next one is refused.
  let refused = false;
  for (let i = 0; i < 140; i++) {
    const r = await host.request({ t: 'rtc.signal', to: guest.id, kind: 'ice', data: JSON.stringify({ candidate: String(i) }) });
    if (r.t === 'error') { assert.equal(r.code, 'RATE', JSON.stringify(r)); refused = true; break; }
  }
  assert.equal(refused, true, 'a client looping on rtc.signal must be cut off');
});

test('a spectator of the same room can take part in the mesh', async (t) => {
  const { join } = await lobby(t);
  const host = await join('Host'), guest = await join('Guest'), watcher = await join('Watcher');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const state = await host.waitFor('room.state');
  await ok(guest, { t: 'room.join', code: state.code });
  await ok(watcher, { t: 'room.join', code: state.code, spectate: true });

  await ok(host, { t: 'rtc.signal', to: watcher.id, kind: 'offer', data: OFFER });
  const got = await watcher.waitFor('rtc.signal', (m) => m.from === host.id);
  assert.equal(got.kind, 'offer');
});
