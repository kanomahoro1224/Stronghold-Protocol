// test/lobby-card.test.js — room.card (名片干员, PR #643 split 6) end to end over WebSocket, in this branch's object
// model `{ charId, avatar }` (shared/playerCard.js; the deep schema / persistence / broadcast coverage lives in
// test/room-card.test.js — this file keeps the data-driven whitelist over chess.json, the client picker sweep, the seat
// publication rules and the cosmetics): the wire check (BAD_MSG), the whitelist (only a visible charId of chess.json —
// not a hidden preset, a stand-in body or a 自选-only operator: BAD_TARGET, the stored card stays whole), storage on the
// session (it follows the player into the next room) and the seat, room.state seats[].card for every member (human seats
// with a card only), '' clearing it, and no phase gate (cosmetic: a running match is neither asked nor refused).
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';
import { getData } from '../server/data.js';
import { cardOperators } from '../public/js/ui/seatArt.js';

const OPERATOR = 'char_498_inside';   // 隐现 (chess.json)
const OTHER = 'char_1012_skadi2';     // 浊心斯卡蒂 (chess.json)
const STAND_IN = 'char_600_cpione';   // a 补位 body (backups.units), no chess record
const DIY_ONLY = 'char_003_kalts';    // a 自选 operator (backups.diy.ownedPool), no chess record
const HIDDEN = 'char_616_pithst';     // a hidden preset (chess.json visible: false), not in the picker

function clientPool(getUrl) {
  const open = new Set();
  return {
    async player(name, token) {
      const c = await TestClient.connect(getUrl());
      open.add(c);
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => ({ info() {}, warn() {}, debug() {}, error() {} });
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
async function createRoom(c, mode = 'coop') {
  await ok(c, { t: 'room.create', mode, difficulty: 'FUNNY' });
  return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
}
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id);

describe('room.card (lobby, stub match)', () => {
  let srv;
  let pool;
  before(async () => {
    // a burst large enough for the test that walks the whole picker list
    srv = await startServer({ port: 0, host: '127.0.0.1', log: quietLog(), MatchClass: StubMatch, heavyBurst: 400, heavyPerSec: 4, rateBurst: 400 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => { await srv?.close(); });

  test('the wire check: a well-formed charId (or "") passes; a number, junk or a missing field is BAD_MSG', async () => {
    const c = await pool.player('Wire');
    await ok(c, { t: 'room.card', charId: OPERATOR, avatar: '' });
    await ok(c, { t: 'room.card', charId: '' });
    for (const charId of [7, null, 'chess_char_1_01_a', 'char_498 inside', `char_1_${'x'.repeat(78)}`]) {
      await err(c, { t: 'room.card', charId }, ERR.BAD_MSG);
    }
    await err(c, { t: 'room.card' }, ERR.BAD_MSG);
  });

  test('only a visible operator of chess.json: a hidden preset, a stand-in body, a 自选-only operator or an unknown id is BAD_TARGET, the stored card stays', async () => {
    const host = await pool.player('Host');
    await createRoom(host);
    await ok(host, { t: 'room.card', charId: OPERATOR });
    await host.waitFor('room.state', (s) => seatOf(s, host.id)?.card?.charId === OPERATOR);
    for (const charId of [HIDDEN, STAND_IN, DIY_ONLY, 'char_999_nobody']) {
      await err(host, { t: 'room.card', charId }, ERR.BAD_TARGET);
    }
    // a later room.state still carries the card the refused ones did not replace
    await ok(host, { t: 'room.addBot' });
    const st = await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));
    assert.equal(seatOf(st, host.id).card.charId, OPERATOR);
  });

  test('the server takes every operator the client picker lists (ui/seatArt.js cardOperators), in a room too', async () => {
    const list = cardOperators(Object.values(getData().chess)).map((c) => c.charId);
    assert.ok(list.length > 100);
    const c = await pool.player('All');
    await createRoom(c, 'solo');
    for (const charId of list) await ok(c, { t: 'room.card', charId });
  });

  test('every member sees it as room.state seats[].card; "" clears it; bots and card-less seats carry no key', async () => {
    const host = await pool.player('Host');
    const guest = await pool.player('Guest');
    const st0 = await createRoom(host);
    assert.ok(!('card' in seatOf(st0, host.id)), 'a room without cards sends what it sent before');
    await ok(guest, { t: 'room.join', code: st0.code });
    await guest.waitFor('room.state', (s) => !!seatOf(s, guest.id));
    await ok(host, { t: 'room.card', charId: OPERATOR });
    const seen = await guest.waitFor('room.state', (s) => seatOf(s, host.id)?.card?.charId === OPERATOR);
    assert.ok(!('card' in seatOf(seen, guest.id)), 'the guest picked none');
    await ok(host, { t: 'room.addBot' });
    const withBot = await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));
    assert.ok(withBot.seats.filter((x) => x && x.isBot).every((b) => !('card' in b)));
    await ok(host, { t: 'room.card', charId: '', avatar: '' });
    const cleared = await guest.waitFor('room.state', (s) => !!seatOf(s, host.id) && !('card' in seatOf(s, host.id)));
    assert.equal(cleared.code, st0.code);
  });

  test('the card follows the player: picked outside a room it is on the seat of the next room', async () => {
    const c = await pool.player('Early');
    await ok(c, { t: 'room.card', charId: OTHER });
    const st = await createRoom(c);
    assert.equal(seatOf(st, c.id).card.charId, OTHER);
    await ok(c, { t: 'room.leave' });
    const again = await createRoom(c, 'solo');
    assert.equal(seatOf(again, c.id).card.charId, OTHER);
  });

  test('cosmetic, no phase gate: accepted while the match runs and shown in room.state', async () => {
    const host = await pool.player('Solo');
    await createRoom(host, 'solo');
    await ok(host, { t: 'room.start' });
    await host.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    await ok(host, { t: 'room.card', charId: OPERATOR });
    const st = await host.waitFor('room.state', (s) => seatOf(s, host.id)?.card?.charId === OPERATOR);
    assert.equal(st.inMatch, true);
  });
});
