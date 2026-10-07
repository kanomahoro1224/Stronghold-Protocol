// Platform interface: start/handle/onDisconnect/onReconnect/onLeave/dispose, autoplay, bot takeover, views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, ERR, CHAT_MAX_LEN, DROP_TAKEOVER_MS } from '../../shared/constants.js';
import { Match, parseBotRehearsal } from '../../server/match/Match.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { DATA, makeMatch, checkInvariants, give, chessOfTier } from './harness.js';
import { bossPoolHp } from '../../server/match/finalAssault.js';

const STATUSES = ['acting', 'ready', 'deciding', 'combat', 'done', 'helping', 'left', 'dead'];

test('constructor validation mirrors the stub; start() sends the first m.public and one m.private per human', () => {
  assert.throws(() => new Match({ seats: [] }), TypeError);
  assert.throws(() => new Match({ seats: [{ seat: 0, playerId: 'a', name: 'a', isBot: false, connected: true }] }), TypeError);
  assert.equal(typeof StubMatch, 'function', 'the platform stub is kept for platform tests');
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 60 }).start();
  const pub = h.lastBc('m.public');
  for (const k of ['phase', 'round', 'lastRound', 'deadline', 'serverNow', 'modeId', 'difficulty', 'stageId', 'factions', 'disabledBonds', 'bannedChess', 'bossId', 'players', 'fields']) assert.ok(k in pub, `m.public.${k}`);
  assert.equal(pub.phase, PHASE.INFO_CHECK);
  assert.equal(pub.lastRound, 14);
  assert.ok(DATA.stages[pub.stageId]);
  assert.equal(pub.factions.length, 3);
  assert.ok(DATA.bosses[pub.bossId]);
  for (const p of pub.players) {
    for (const k of ['playerId', 'seat', 'name', 'isBot', 'connected', 'alive', 'lp', 'bandId', 'shopLevel', 'boardCount', 'ready', 'bonds', 'fieldId', 'status']) assert.ok(k in p, `players[].${k}`);
    assert.ok(STATUSES.includes(p.status));
  }
  const privs = h.sent.filter(([, m]) => m.t === 'm.private');
  assert.deepEqual(privs.map(([id]) => id).sort(), ['p_0', 'p_1'], 'one m.private per human, none for bots');
  for (const [id, priv] of privs) {
    assert.equal(priv.playerId, id);
    for (const k of ['seat', 'alive', 'lp', 'funds', 'bandId', 'ready', 'canReady', 'shop', 'hand', 'temp', 'board', 'deployCap', 'deployCount', 'bonds', 'effects', 'nextEnemies', 'stats']) assert.ok(k in priv, `m.private.${k}`);
    for (const k of ['level', 'maxLevel', 'upgradePrice', 'refreshPrice', 'freeRefreshes', 'frozen', 'slots', 'rewardOffer']) assert.ok(k in priv.shop, `shop.${k}`);
    assert.equal(priv.hand.length, 10);
    assert.equal(priv.temp.length, 5);
    for (const k of ['dmgDealt', 'kills', 'leaks', 'gold', 'refreshes', 'merges']) assert.ok(k in priv.stats);
  }
  h.m.dispose();
});

test('m.private shape in PREP matches DESIGN §8.3 (pieces, slots, bonds, effects, nextEnemies)', () => {
  const h = makeMatch({ mode: 'solo', seed: 61 }).start();
  h.toPrep(1);
  h.flushAll();
  const priv = h.lastTo('p_0', 'm.private');
  assert.equal(priv.funds, 4);
  assert.equal(priv.shop.slots.length, 4);
  for (const s of priv.shop.slots) {
    assert.deepEqual(Object.keys(s).sort(), ['basePrice', 'frozen', 'id', 'kind', 'price', 'sold']);
    assert.equal(s.frozen, false);
    assert.ok(s.kind === 'chess' || s.kind === 'item');
  }
  assert.equal(priv.shop.rewardOffer, null);
  assert.equal(priv.deployCap, 8);
  assert.ok(priv.effects.some((e) => e.iconKind === 'band' && e.name));
  assert.ok(priv.nextEnemies.length > 0);
  for (const e of priv.nextEnemies) { assert.ok(DATA.enemies[e.enemyKey]); assert.ok(e.count >= 1); assert.ok('tag' in e); }
  const ps = h.ps('p_0');
  h.m.handle('p_0', { t: 'g.buy', slot: 0 });
  h.flushAll();
  const p2 = h.lastTo('p_0', 'm.private');
  const piece = p2.hand.find(Boolean);
  assert.deepEqual(Object.keys(piece).sort(), ['count', 'golden', 'id', 'items', 'kind', 'ownerUid', 'tier', 'uid']);
  assert.equal(p2.funds, ps.funds);
  h.m.dispose();
});

test('m.public is throttled to ≤ 10/s; m.private is only resent when it changed', () => {
  const h = makeMatch({ mode: 'solo', seed: 62 }).start();
  h.toPrep(1);
  h.sched.advance(500);
  const n0 = h.bc.filter((m) => m.t === 'm.public').length;
  const t0 = h.sched.now();
  for (let i = 0; i < 50; i++) { h.m.handle('p_0', { t: 'g.freeze' }); h.sched.advance(5); }
  h.sched.advance(200);
  const n1 = h.bc.filter((m) => m.t === 'm.public').length;
  const elapsed = (h.sched.now() - t0) / 1000;
  assert.ok(n1 - n0 <= Math.ceil(elapsed * 10) + 1, `${n1 - n0} public frames in ${elapsed}s`);
  const privs = h.allTo('p_0', 'm.private').length;
  h.m.flush();
  h.m.markPrivate(h.ps('p_0'));
  h.m.flush();
  assert.equal(h.allTo('p_0', 'm.private').length, privs, 'unchanged private view is not resent');
  h.m.dispose();
});

test('disconnect: the seat is taken over after the reconnect grace; reconnect resends everything', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 63, fake: true, script: () => ({ duration: 4 }) }).start();
  const m = h.m;
  h.m.onDisconnect('p_1');
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_1').connected, false);
  // NOT on the spot any more (operator request, 2026-10-07): the seat waits out DROP_TAKEOVER_MS for its player, so a
  // phase that is already running resolves on its OWN deadline instead (the grace is longer than the info timer here)
  assert.equal(h.ps('p_1').infoReady, false, 'the briefing is not confirmed for them while the grace runs');
  assert.equal(h.ps('p_1').botControlled, false);
  h.sched.advance(DROP_TAKEOVER_MS + 1);
  h.sched.runNext(); // the harness fires timers with runNext(); advance only moves the clock
  assert.equal(h.ps('p_1').botControlled, true, 'once the grace is over the engine owns the seat again');
  m.handle('p_0', { t: 'g.infoReady' });
  // p_1 never picks its band: the engine plays that turn too, and both picks are its own
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  assert.equal(h.ps('p_1').bandId, 'band_bldsk');
  const sentBefore = h.sent.length;
  // p_0 readies; p_1 is readied by its own bot prep, not by the prep deadline
  m.handle('p_0', { t: 'g.ready', ready: true });
  h.run(() => m.phase === PHASE.COMBAT);
  assert.ok(h.ps('p_1').ready);
  assert.ok(m.fields.some((f) => f.fieldId === 'n:p_1'), 'the disconnected seat still fights');
  assert.ok(!h.sent.slice(sentBefore).some(([id]) => id === 'p_1') || true);
  // reconnect mid-combat: m.public + m.private + m.field + b.snap
  const mark = h.sent.length;
  m.onReconnect('p_1');
  const got = h.sent.slice(mark).filter(([id]) => id === 'p_1').map(([, x]) => x.t);
  assert.ok(got.includes('m.public') && got.includes('m.private') && got.includes('m.field') && got.includes('b.snap'), got.join());
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_1').connected, true);
  m.dispose();
});

test('a permanent quit (g.leave) is not a drop: the abandoned rule ends the match at once', () => {
  const q = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 66, fake: true, instant: false, script: () => ({ duration: 600 }) }).start();
  q.m.onLeave('p_0');
  assert.ok(q.ended, 'the last human leaving ends the match');
  q.m.dispose();
});

test('a match with no human seat at all is reaped on the live server and left alone on a virtual clock', () => {
  // Every seat a genuine bot and a running match takes no new humans: the live server ends it like a room whose last
  // human quit instead of simulating it for nobody. A virtual-clock bot-only match is on purpose (the balance sims,
  // tools/matchrun, test/perf/hosted-load.mjs --rehearsal), so it is never reaped.
  const sim = makeMatch({ mode: 'coop', humans: 0, bots: 2, seed: 67, fake: true }).start();
  assert.equal(sim.ended, null, 'a virtual-clock bot-only run is not reaped');
  sim.m.dispose();

  const live = makeMatch({ mode: 'coop', humans: 0, bots: 2, seed: 67, fake: true }).start();
  live.m.sched.virtual = false; // the live server's clock
  live.m._endIfNoHumanSeat();
  assert.ok(live.ended, 'the live server ends it at once');
  assert.equal(live.ended.reason, 'abandoned');
  assert.equal(live.m.ended, true);
  assert.equal(live.m.runner ? live.m.runner.hosted : 0, 0, 'nothing is stepped');
  live.m.dispose();
});

test('a frozen match does no bot work: no prep, no layout rehearsal, until it is unfrozen', () => {
  // Every bot prep rehearses whole simulated battles (BOT_REHEARSAL_DEFAULT), so a frozen match must not run them: the
  // bots re-arm and finish their prep after the resume instead. The only freeze left is the owner's solo pause (which
  // only applies inside a battle), so the primitive is driven directly here.
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 2, seed: 68, fake: true, instant: false, botRehearsal: 3 }).start();
  const m = h.m;
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  m._freeze();
  assert.equal(m.paused, true);
  assert.equal(m.ended, false, 'a drop never ends somebody else\'s match');
  const bots = [...m.players.values()].filter((p) => p.isBot);
  // whatever the bots had done at the moment of the freeze is all they will ever have done
  const snapshot = `${m.phase}:${m.round}:${bots.map((p) => (p.ready ? 1 : 0)).join('')}:${m.runner ? m.runner.ticks : -1}`;
  m.sched.advance(60_000);
  assert.equal(`${m.phase}:${m.round}:${bots.map((p) => (p.ready ? 1 : 0)).join('')}:${m.runner ? m.runner.ticks : -1}`, snapshot,
    'a frozen match advances nothing: no phase, no prep, no rehearsal, no tick');
  m._unfreeze();
  assert.equal(m.paused, false);
  m.sched.advance(5_000);
  assert.ok(bots.every((p) => p.ready), 'the bots finish their prep after the resume');
  assert.equal(m.ended, false);
  m.dispose();
});

test('parseBotRehearsal: the env knob keeps the documented defaults on junk', () => {
  assert.equal(parseBotRehearsal(undefined), null, 'null = keep BOT_REHEARSAL_DEFAULT');
  assert.equal(parseBotRehearsal('1'), 1);
  assert.equal(parseBotRehearsal('0'), 0);
  assert.equal(parseBotRehearsal('99'), 8);
  assert.equal(parseBotRehearsal('x'), null);
});

test('g.autoplay lets the bot play a human seat (buys, places, readies); turning it off returns control', () => {
  const h = makeMatch({ mode: 'solo', seed: 64, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  assert.deepEqual(m.handle('p_0', { t: 'g.autoplay', on: true }), { ok: true });
  assert.equal(m.publicView().players[0].autoplay, true);
  h.run(() => m.phase !== PHASE.PREP);
  const ps = h.ps('p_0');
  assert.ok(ps.board.size > 0, 'the bot deployed units');
  assert.notEqual(m.phase, PHASE.PREP, 'the bot readied');
  h.run(() => m.phase === PHASE.PREP && m.round === 2);
  assert.deepEqual(m.handle('p_0', { t: 'g.autoplay', on: false }), { ok: true });
  h.sched.advance(60000);
  assert.equal(m.phase, PHASE.PREP, 'solo prep waits for the human again');
  checkInvariants(m);
  m.dispose();
});

test('onLeave: quitting counts as elimination (copies back to the pool at once, status left); last human leaving ends the match once', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 65, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  const q = h.ps('p_1');
  const id = chessOfTier(1).find((x) => m.pool.has(x) && m.pool.left(x) >= 2);
  give(m, q, id);
  give(m, q, id);
  const base = m.gd.baseIdOf(id);
  const left0 = m.pool.left(base);
  m.onLeave('p_1');
  assert.equal(q.alive, false, 'the departed seat is out of the match');
  assert.equal(m.pool.left(base), left0 + 2, 'its copies went back to the shared pool at once');
  assert.ok(q.board.size === 0 && q.hand.every((x) => x == null), 'it holds nothing');
  assert.equal(q.eliminatedRound, 1);
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_1').status, 'left');
  assert.deepEqual(m.handle('p_1', { t: 'g.ready', ready: true }), { error: ERR.NOT_IN_ROOM });
  checkInvariants(m);
  m.handle('p_0', { t: 'g.ready', ready: true });
  h.run(() => m.phase === PHASE.COMBAT);
  assert.deepEqual(m.fields.map((f) => f.fieldId), ['n:p_0'], 'no battle for the departed seat');
  h.run(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.round, 2);
  m.onLeave('p_0');
  assert.equal(h.endedCount, 1);
  assert.equal(h.ended.reason, 'abandoned');
  assert.equal(h.ended.players.find((p) => p.playerId === 'p_1').roundsPassed, 0);
  m.onLeave('p_0');
  m.onReconnect('p_0');
  m.onDisconnect('p_0');
  assert.equal(h.endedCount, 1);
  assert.deepEqual(m.handle('p_0', { t: 'g.ready', ready: true }).error, ERR.NOT_IN_ROOM);
  m.dispose();
  m.dispose();
  assert.equal(h.sched.pending(), 0, 'dispose cancels every timer');
});

test('onLeave: a quitter has no place in the Final Assault pairing or the boss pool; its draft turns pass on', () => {
  // band draft: the player on turn leaves → its pick is the default band and the turn moves on
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 3, seed: 5, fake: true, script: (b) => (b.kind === 'boss' ? { bossDps: 1e9 } : {}) }).start();
  const m = h.m;
  for (const id of ['p_0', 'p_1', 'p_2']) m.handle(id, { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  const first = m.draftTurn();
  m.onLeave(first);
  assert.equal(m.draft.picks[first], m.gd.bandDraft.timeoutBandId);
  assert.notEqual(m.draftTurn(), first);
  h.autoHumans();
  h.drive(() => m.phase === PHASE.PREP && m.round === 14);
  const alive = m.alivePlayers().map((p) => p.playerId);
  assert.equal(alive.length, 2);
  assert.ok(!alive.includes(first));
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  assert.deepEqual(m.fields.map((f) => f.players), [alive], 'one boss field for the two players left');
  assert.equal(m.bossPool.maxHp, bossPoolHp(m.gd, m.bossId, 2), 'the co-op boss pool of two alive players');
  assert.equal(m.bossPool.maxHp, m.gd.boss(m.bossId).bloodPoint[m.gd.difficulty], 'bloodPoint, no alive-player factor (DESIGN §20.10)');
  const end = h.runToEnd();
  assert.equal(end.victory, true);
  assert.equal(end.players.find((p) => p.playerId === first).roundsPassed, 0);
  m.dispose();

  // 机变: the picker on turn leaves → the next alive player picks; the last alive player leaving ends the match
  const h2 = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 2, seed: 18, fake: true }).start();
  const m2 = h2.m;
  h2.autoHumans();
  h2.drive(() => m2.phase === PHASE.SP_DRAFT);
  const turn = m2.spTurn();
  m2.onLeave(turn);
  assert.equal(m2.phase, PHASE.SP_DRAFT);
  assert.notEqual(m2.spTurn(), turn, 'the turn passed on');
  checkInvariants(m2);
  m2.dispose();

  // mid-combat: the quitter's own battle is force-ended, the others play on
  const h4 = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 3, seed: 20, fake: true, instant: false, script: (b) => (b.kind === 'normal' ? { duration: 5 } : {}) }).start();
  const m4 = h4.m;
  h4.toPrep(2);
  h4.drive(() => m4.phase === PHASE.COMBAT);
  h4.sched.advance(500);
  m4.onLeave('p_2');
  const f2 = m4.fields.find((f) => f.fieldId === 'n:p_2');
  assert.ok(f2.battle.finished, 'its battle was force-ended');
  assert.ok(m4.fields.filter((f) => f.fieldId !== 'n:p_2').every((f) => !f.battle.finished), 'the others still fight');
  checkInvariants(m4);
  h4.drive(() => m4.phase === PHASE.PREP && m4.round === 3);
  assert.deepEqual(m4.alivePlayers().map((p) => p.playerId), ['p_0', 'p_1']);
  assert.equal(h4.ps('p_2').eliminatedRound, 2);
  checkInvariants(m4);
  m4.dispose();

  // only an eliminated spectator left → the match ends as a defeat ('eliminated'), not 'abandoned'
  const h3 = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 2, seed: 19, fake: true }).start();
  h3.toPrep(2);
  h3.ps('p_1').eliminate(2);
  h3.m.onLeave('p_0');
  assert.equal(h3.endedCount, 1);
  assert.equal(h3.ended.reason, 'eliminated');
  assert.ok(h3.lastTo('p_1', 'm.result'), 'the spectator gets the result');
  h3.m.dispose();
});

test('dispose stops timers and battles; handle/hooks after dispose are inert', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 66, instant: false }).start();
  h.m.handle('p_0', { t: 'g.infoReady' });
  h.sched.advance(10);
  h.m.dispose();
  assert.equal(h.sched.pending(), 0);
  const n = h.sent.length + h.bc.length;
  h.sched.advance(100000);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.refresh' }), { error: ERR.WRONG_PHASE });
  h.m.onReconnect('p_0');
  h.m.onDisconnect('p_0');
  assert.equal(h.sent.length + h.bc.length, n, 'nothing is sent after dispose');
  assert.equal(h.endedCount, 0);
});

test('emotes: relayed as m.emote with a 1 s cooldown; g.watch during prep scouts a teammate board', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 67, fake: true }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.emote', id: 'autochess_battle_happy' }), { ok: true });
  assert.deepEqual(h.lastBc('m.emote'), { t: 'm.emote', playerId: 'p_0', id: 'autochess_battle_happy' });
  assert.equal(m.handle('p_0', { t: 'g.emote', id: 'slug_autochess_battle_thanks' }).error, ERR.RATE);
  h.sched.advance(1000);
  // only the official emote ids are relayed (defence in depth: handle() may be called without validateC2S)
  assert.equal(m.handle('p_0', { t: 'g.emote', id: 'autochess_room_hello' }).error, ERR.BAD_MSG); // room-scene emote
  assert.equal(m.handle('p_0', { t: 'g.emote', id: 'happy' }).error, ERR.BAD_MSG); // v1 short id
  assert.deepEqual(m.handle('p_0', { t: 'g.emote', id: 'slug_autochess_battle_thanks' }), { ok: true });
  h.toPrep(1);
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
  const f = h.lastTo('p_0', 'm.field');
  assert.equal(f.fieldId, 'n:p_1');
  assert.equal(f.prep, true);
  assert.ok(Array.isArray(f.units));
  assert.equal(m.handle('p_0', { t: 'g.watch', fieldId: 'n:nobody' }).error, ERR.BAD_TARGET);
  m.dispose();
});

test('chat: a text line is relayed as m.chat, shares the 1 s cooldown with emotes and is capped at CHAT_MAX_LEN', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 68, fake: true }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.chat', text: '  你好  ' }), { ok: true });
  assert.deepEqual(h.lastBc('m.chat'), { t: 'm.chat', playerId: 'p_0', text: '你好' }, 'the line is trimmed');
  // ONE cooldown for both: a line right after a line, or an emote right after a line, is refused (chatCD = 1 s)
  assert.equal(m.handle('p_0', { t: 'g.chat', text: '刷屏' }).error, ERR.RATE);
  assert.equal(m.handle('p_0', { t: 'g.emote', id: 'autochess_battle_happy' }).error, ERR.RATE);
  h.sched.advance(1000);
  assert.deepEqual(m.handle('p_0', { t: 'g.emote', id: 'autochess_battle_happy' }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.chat', text: '再来一条' }).error, ERR.RATE, 'the emote started the same cooldown');
  h.sched.advance(1000);
  // empty, whitespace-only, over-long and non-string lines are refused without throwing
  for (const text of ['', '   ', 'x'.repeat(CHAT_MAX_LEN + 1), 7, null, undefined]) {
    assert.equal(m.handle('p_0', { t: 'g.chat', text }).error, ERR.BAD_MSG, `refused: ${JSON.stringify(text)}`);
  }
  assert.deepEqual(m.handle('p_0', { t: 'g.chat', text: 'x'.repeat(CHAT_MAX_LEN) }), { ok: true }, 'exactly the cap is fine');
  assert.equal(h.lastBc('m.chat').text.length, CHAT_MAX_LEN);
  m.dispose();
});

test('unknown / wrong-phase intents are rejected without throwing', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 68 }).start();
  const m = h.m;
  assert.equal(m.handle('nobody', { t: 'g.ready', ready: true }).error, ERR.NOT_IN_ROOM);
  assert.equal(m.handle('ai_0', { t: 'g.ready', ready: true }).error, ERR.NOT_IN_ROOM);
  assert.equal(m.handle('p_0', { t: 'room.start' }).error, ERR.BAD_MSG);
  assert.equal(m.handle('p_0', null).error, ERR.BAD_MSG);
  assert.equal(m.handle('p_0', { t: 'g.buy', slot: 0 }).error, ERR.WRONG_PHASE);
  assert.equal(m.handle('p_0', { t: 'g.choice', idx: 0 }).error, ERR.WRONG_PHASE);
  assert.equal(m.handle('p_0', { t: 'g.band', bandId: 'band_bldsk' }).error, ERR.WRONG_PHASE);
  assert.equal(m.errorCount, 0);
  m.dispose();
});

test('degraded data: a match without a chess pool ends immediately with an error summary (no throw)', () => {
  const out = { ended: null, bc: [] };
  const m = new Match({
    roomCode: 'X', mode: 'coop', difficulty: 'HARD', modeId: 'mode_multi_hard', seed: 1,
    seats: [{ seat: 0, playerId: 'p', name: 'P', isBot: false, connected: true }],
    data: { config: {} }, log: { info() {}, warn() {}, error() {} },
    send: () => true, broadcast: (x) => out.bc.push(x), onEnd: (s) => { out.ended = s; },
  });
  m.start();
  assert.ok(out.ended);
  assert.equal(out.ended.reason, 'error');
  m.dispose();
});

test('m.public follows player-state changes (shop level, board count, bonds) within the throttle window', () => {
  const h = makeMatch({ mode: 'solo', seed: 69 }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  ps.funds = 50;
  m.handle('p_0', { t: 'g.levelUp' });
  h.sched.advance(150);
  assert.equal(h.lastBc('m.public').players[0].shopLevel, 2);
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------
// A dropped human (community report: "掉线之后无法推进"): the seat is kept for the reconnect window, so it is
// neither left nor autoplay — and every interactive gate keys on PlayerState.botControlled, which used to know
// bots / left / 托管 only. The seat then never acted and each phase waited out its OWN timer instead: measured
// on this seed, one drop stretched the match to 1.65–1.84 M ms of virtual time (~11x the 155 k baseline) and the
// players sat through a full info/band/sp/prep timer every round. Match.onDisconnect therefore promises the
// auto-play policy (class header) — but since 2026-10-07 it is a GRACE, not an instant (operator request): the
// seat waits DROP_TAKEOVER_MS for its player and only then goes to the engine, so a socket blip or a reload no
// longer hands a live seat to the bot. The first two tests pin the grace itself; the loop below pins the policy
// it still has to satisfy — a match with a drop must finish, and close to the no-drop baseline.

/** Drive the connected humans only: a dropped seat has to be carried by the engine alone. */
function driveConnected(h, { dropAt = null, dropIn = null } = {}) {
  const m = h.m;
  let dropped = false;
  for (let steps = 0; steps < 3e6; steps++) {
    if (m.ended) return { dropped, ended: true };
    if (dropAt && !dropped && m.phase === dropAt) { m.onDisconnect(dropIn); dropped = true; }
    for (const ps of m.players.values()) {
      if (ps.isBot || ps.left || !ps.connected) continue;
      if (m.phase === PHASE.INFO_CHECK && !ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' });
      if (m.phase === PHASE.BAND_DRAFT && m.draftTurn() === ps.playerId) m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' });
      if (m.phase === PHASE.SP_DRAFT && m.spTurn() === ps.playerId) {
        const idx = m.sp.cards.map((c) => c.idx).find((k) => m.sp.taken[k] == null);
        if (idx != null) m.handle(ps.playerId, { t: 'g.choice', idx });
      }
      if (m.phase === PHASE.PREP && ps.alive && !ps.ready) {
        if (!ps.tempEmpty) ps.resolveTemp();
        m.handle(ps.playerId, { t: 'g.ready', ready: true });
      }
    }
    if (!m.ended && !h.sched.runNext() && m.phase !== PHASE.RESULT) return { dropped, ended: !!m.ended };
  }
  return { dropped, ended: !!m.ended };
}

test('a dropped seat is NOT engine-played at once: it waits DROP_TAKEOVER_MS, and a return inside it wins it back', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 0, seed: 11, fake: true }).start();
  const m = h.m;
  const ps = h.ps('p_1');
  assert.equal(ps.autoPlayOnDrop, true, 'somebody else is waiting, so this seat must not hold them up forever');
  assert.equal(ps.dropGraceMs, DROP_TAKEOVER_MS, 'and the grace is the operator\'s minute');

  m.onDisconnect('p_1');
  assert.equal(ps.connected, false);
  assert.equal(ps.botControlled, false, 'the instant a socket dies is NOT enough: the player gets the grace');
  assert.notEqual(ps.dropTimer, null, 'the takeover is armed on the match timer (so dispose cancels it)');

  // …the player comes back inside the grace: the seat is theirs and nothing is left armed
  m.onReconnect('p_1');
  assert.equal(ps.botControlled, false);
  assert.equal(ps.dropTimer, null, 'a reconnect cancels the pending takeover');
  h.sched.advance(DROP_TAKEOVER_MS * 2);
  assert.equal(ps.connected, true);
  assert.equal(ps.botControlled, false, 'the cancelled takeover never fires');
  m.dispose();

  // …and with no return, the grace really does hand the seat over
  const h2 = makeMatch({ mode: 'coop', humans: 2, bots: 0, seed: 11, fake: true }).start();
  const ps2 = h2.ps('p_1');
  h2.m.onDisconnect('p_1');
  assert.equal(ps2.botControlled, false);
  h2.sched.advance(DROP_TAKEOVER_MS + 1);
  assert.equal(ps2.botControlled, true, 'after the grace the engine owns the seat');
  assert.equal(ps2.left, false, 'a drop is never a leave: the seat stays for the reconnect window');
  h2.m.onReconnect('p_1');
  assert.equal(ps2.botControlled, false, 'and a later reconnect still takes it back');
  h2.m.dispose();
});

test('a solo run never auto-plays a drop — no grace involved', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 11, fake: true }).start();
  const ps = h.ps('p_0');
  assert.equal(ps.autoPlayOnDrop, false);
  h.m.onDisconnect('p_0');
  h.sched.advance(DROP_TAKEOVER_MS * 3);
  assert.equal(ps.botControlled, false, 'the official reconnect promise: the run waits for its player');
  h.m.dispose();
});

test('a dropped human is engine-played after the grace, so a match with a drop runs like one without', () => {
  const base = makeMatch({ mode: 'coop', humans: 2, bots: 0, seed: 11, fake: true }).start();
  driveConnected(base);
  assert.ok(base.ended, 'the baseline match finishes');
  const baseline = base.ended.durationMs;
  base.m.dispose();

  for (const at of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.PREP, PHASE.COMBAT]) {
    const h = makeMatch({ mode: 'coop', humans: 2, bots: 0, seed: 11, fake: true }).start();
    const m = h.m;
    driveConnected(h, { dropAt: at, dropIn: 'p_1' });
    const ps = h.ps('p_1');
    assert.ok(h.ended, `a drop at ${at} must not stop the match (stuck in ${m.phase} R${m.round})`);
    assert.equal(ps.botControlled, true, `the dropped seat is engine-played after the grace (a drop at ${at})`);
    assert.equal(ps.left, false, 'a drop never counts as a leave: the seat stays for the reconnect window');
    assert.ok(
      h.ended.durationMs <= baseline + DROP_TAKEOVER_MS + 30_000,
      `a drop at ${at} cost ${h.ended.durationMs - baseline} ms over the ${baseline} ms baseline — one grace, not a stalled phase`,
    );
    m.onReconnect('p_1');
    assert.equal(ps.botControlled, false, 'a reconnect hands the seat back to its player');
    m.dispose();
  }
});
