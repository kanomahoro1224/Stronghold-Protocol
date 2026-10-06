// REPRO (owner report 2026-10-06): 「只要有人退了，整个游戏就无法推进（时间到0无法继续下一回合）」.
//
// This drives the REAL platform: server/index.js + lobby + Match over websockets, real timers (timerScale 0.02),
// FakeBattle, and the production quit sequence (public/js/ui/matchChrome.js quitMatch: g.leave → room.leave).
// The engine-level suites (repro-quit-stall.test.js, connection.test.js, quit-phase-matrix.test.js) call
// Match.onLeave directly and all pass, so whatever the owner sees must differ on this path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { getData } from '../../server/data.js';
import { Match } from '../../server/match/Match.js';
import { TestClient } from '../helpers/wsClient.js';
import { FakeBattle } from './fakeBattle.js';
import { attachWsSimClient } from './simClient.js';

class FastMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 0.02, BattleClass: FakeBattle, clientCombat: true }); }
}

const errors = [];
const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
let srv = null;
const clients = [];

async function server() {
  if (!srv) srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: FastMatch, seedFn: () => 69 });
  return srv;
}
async function player(name, token) {
  const s = await server();
  const c = await TestClient.connect(`ws://127.0.0.1:${s.port}/ws`);
  clients.push(c);
  const w = await c.hello(name, token);
  c.id = w.playerId;
  c.token = w.token;
  c.sim = attachWsSimClient(c, { BattleClass: FakeBattle, pace: 'instant' });
  return c;
}
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };

/** A two-human co-op room in INFO_CHECK, both confirmed, bands picked, waiting in PREP R1. */
async function toPrep1(tag) {
  FakeBattle.reset();
  FakeBattle.script = () => ({ duration: 1 });
  const a = await player(`A${tag}`);
  const b = await player(`B${tag}`);
  await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const st = await a.waitFor('room.state');
  await ok(b, { t: 'room.join', code: st.code });
  await ok(a, { t: 'room.addBot' });
  await ok(b, { t: 'room.ready', ready: true });
  await ok(a, { t: 'room.start' });
  for (const c of [a, b]) await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK', 10000);
  await ok(a, { t: 'g.infoReady' });
  await ok(b, { t: 'g.infoReady' });
  // strategy draft: answer whoever is on turn
  const pending = new Map([[a.id, a], [b.id, b]]);
  while (pending.size) {
    const frame = await a.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT' && pending.has(p.draft?.turn), 15000);
    const taken = new Set(Object.values(frame.draft.picks));
    const band = Object.values(getData().bands).find((x) =>
      (!Array.isArray(x.modeTypeList) || x.modeTypeList.includes('MULTI')) && !taken.has(x.bandId));
    await ok(pending.get(frame.draft.turn), { t: 'g.band', bandId: band.bandId });
    pending.delete(frame.draft.turn);
  }
  await a.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 1, 15000);
  return { a, b };
}

/** The production quit: g.leave, then room.leave (matchChrome.quitMatch). */
async function quit(c) {
  await c.request({ t: 'g.leave' }).catch(() => {});
  await c.request({ t: 'room.leave' }).catch(() => {});
}

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  if (srv) await srv.close();
});

test('REAL quit during PREP R1: the player who stayed must still reach round 2', async () => {
  const { a, b } = await toPrep1('p');
  await ok(a, { t: 'g.ready', ready: true });
  await quit(b);
  await a.waitFor('m.public', (p) => p.round === 2 || p.phase === 'SETTLE', 20000);
  assert.deepEqual(errors, []);
});

test('REAL quit during COMBAT R1: the player who stayed must still reach round 2', async () => {
  const { a, b } = await toPrep1('c');
  await ok(a, { t: 'g.ready', ready: true });
  await ok(b, { t: 'g.ready', ready: true });
  await a.waitFor('m.public', (p) => p.phase === 'COMBAT', 15000);
  await quit(b);
  await a.waitFor('m.public', (p) => p.round === 2 || p.phase === 'SETTLE', 20000);
  assert.deepEqual(errors, []);
});

test('REAL quit during BAND_DRAFT: the player who stayed must still reach PREP', async () => {
  FakeBattle.reset();
  FakeBattle.script = () => ({ duration: 1 });
  const a = await player('Ad');
  const b = await player('Bd');
  await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const st = await a.waitFor('room.state');
  await ok(b, { t: 'room.join', code: st.code });
  await ok(a, { t: 'room.addBot' });
  await ok(b, { t: 'room.ready', ready: true });
  await ok(a, { t: 'room.start' });
  for (const c of [a, b]) await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK', 10000);
  await ok(a, { t: 'g.infoReady' });
  await ok(b, { t: 'g.infoReady' });
  await a.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT', 15000);
  await quit(b);
  await a.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 1, 20000);
  assert.deepEqual(errors, []);
});

test('REAL drop (no g.leave) during PREP R1: the player who stayed must still reach round 2', async () => {
  const { a, b } = await toPrep1('d');
  await ok(a, { t: 'g.ready', ready: true });
  await b.terminate();
  await a.waitFor('m.public', (p) => p.round === 2 || p.phase === 'SETTLE', 20000);
  assert.deepEqual(errors, []);
});
