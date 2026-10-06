// test/state/resume-p2a.test.js — P2a: the record v2 round trip and the faithful re-entry of a lone-human match.
//
// The suites next door cover the gate, the store and the write points. This one covers what P2a adds:
//
//   1. a source match is driven through a real fake-battle round to SETTLE R1 and ROUND_START R2, and every record its
//      own write points produced is captured;
//   2. at the ROUND_START R2 boundary the seat is decorated with the state a record has to carry, and one more record
//      is captured by hand there, so the assertions below cover every field (pieces, offer, temp due, overrides, shop
//      flags, layers, counters, stats) and not only whatever a bot happened to leave behind;
//   3. that record reconstructs the seat EXACTLY — a canonical digest of every gameplay field, the pool and all six rng
//      positions — with no second income, no second upgrade-price drop and no re-rolled shop (the P0/P1 double-apply bug,
//      reproduced here as the "old order" control);
//   4. the SETTLE record continues into R2 and lands on the very state the source match reached by itself;
//   5. a PREP record — the point the mid-round heartbeat writes — is ACCEPTED and reconstructs the mid-prep seat exactly
//      (the same proof as 3, on the path a real crash usually lands on), and the resumed prep can still be finished;
//   6. a v1 record, a co-op record, a COMBAT / SP_DRAFT / FINAL_ASSAULT record are each refused with their own reason,
//      and the same record applied twice is the same state (nothing compounds on a resume).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeMatch, give, giveItem, chessOfTier, legalTileFor } from '../match/harness.js';
import { buildRecord, RECORD_VERSION } from '../../server/state/snapshot.js';
import { captureProps, applyPlayerState } from '../../server/state/playerstate.js';
import { applyRecord, checkRecord, recordSeats, resumePlan, RESUME_TTL_MS } from '../../server/state/resume.js';
import { PHASE } from '../../shared/constants.js';

const SEED = 4242;
const NOW = Date.now();

/** Canonical JSON: keys sorted, so two graphs compare independently of insertion order. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return String(JSON.stringify(v === undefined ? null : v));
}

/** The digest of one seat's gameplay state (every captured field, the generic piece graphs included). */
const seatDigest = (ps) => canon(captureProps(ps));

/** The digest of the match's volatile run state (rng positions, uid/battle counters, pool, waves). */
const runDigest = (m) => canon(m.captureRunState());

/** A seat rebuilt the way the lobby does it: from the record's own seats (ids, names, loadout). */
function rebuild(rec) {
  const seats = recordSeats(rec).map((s) => ({
    seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: false, loadout: s.loadout,
  }));
  const h = makeMatch({ seats, mode: rec.mode, difficulty: rec.difficulty, modeId: rec.modeId, seed: rec.seed, matchNo: rec.matchNo ?? 1, fake: true });
  h.m.stateSink = null; // the rebuild has no persistence: what it writes is not the subject here
  h.start();
  return h;
}

/** The payload of a seat in a record. */
const payloadOf = (rec, playerId) => rec.players.find((p) => p.playerId === playerId).props;

/**
 * Decorate the human seat with the state a record has to carry, so the assertions below cover every field (pieces, an
 * offer, temp due, overrides, shop flags, layers, counters, stats) and not only whatever a bot happened to leave behind.
 * The phase is whatever the match is in (a round-start boundary or an open prep); the caller captures the record.
 */
function decorate(h) {
  const m = h.m;
  const ps = h.ps('p_0');
  // bases the seat does not already own (the engine never lets 3 normal copies of one base coexist — them merging is an
  // invariant, so decorating with an owned base would build a state the engine itself could not produce)
  const owned = new Set(ps.allChess().map((p) => m.gd.baseIdOf(p.id)));
  const free = chessOfTier(1).filter((id) => !owned.has(m.gd.baseIdOf(id)) && m.pool.left(m.gd.baseIdOf(id)) > 0);
  const chessId = free[0];
  const otherId = free[1];
  const tile = legalTileFor(m, ps, chessId);
  if (tile) give(m, ps, chessId, 'board', tile);            // a deployed piece (dir / meta.round ride along)
  give(m, ps, chessId, 'hand');                             // a hand piece — never a merge (needs 3)
  const temp = ps.newPiece('chess', otherId, { poolCopies: m.pool.take(m.gd.baseIdOf(otherId), 1) });
  ps.stow(temp, { toTemp: true });
  ps._tempDue.set(temp.uid, ps.prepsEnded + 1);             // overflowed after Ready: due at the NEXT prep
  const itemId = ps.shop.slots.find((s) => s && s.kind === 'item')?.id;
  if (itemId) giveItem(m, ps, itemId, 'hand');
  ps.pushRewardOffer('merge');                              // a queued offer (uses rngShop)
  ps.addLayers(m.gd.chess(chessId).bonds[0], 2);            // persistent layers (the derived bonds follow)
  ps.counters.test = 3;
  ps.round.buys = 2;
  ps.stats.buys = 2;
  ps.shop.frozen = true;
  if (ps.shop.slots[0]) ps.shop.slots[0].frozen = true;
  if (ps.shop.slots[1]) ps.shop.slots[1] = null;            // a cleared slot: the payload keeps the hole
  ps.deployCapBonus = 1;
  ps.deviceOverrides = { '0:0': 'melee' };                  // a content override the deploy map reads
  // normally written by _finishCombat and settled at SETTLE: set so the field is really carried
  ps.pendingLayerGains = { [m.gd.chess(chessId).bonds[0]]: 1 };
  // `_battleSeq` only advances in client-combat mode (production): set it so the restore is really exercised
  m._battleSeq = 2;
  return buildRecord(m, { build: 'test-build', rulesHash: 'test-rules', now: NOW });
}

/**
 * The source run: a lone-human coop match driven through one full fake-battle round, capturing the records its own
 * write points produced (ROUND_START R1/R2, SETTLE R1), then decorated AT the ROUND_START R2 boundary (still the
 * recorded phase, the scheduler has not moved on) so one further hand-captured record holds every field under test.
 */
function sourceRun() {
  const captured = { round_start: [], settle: [] };
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: SEED, fake: true });
  h.m.stateSink = (reason, m) => {
    if (captured[reason]) captured[reason].push(buildRecord(m, { build: 'test-build', rulesHash: 'test-rules', now: NOW }));
  };
  h.start();
  h.autoHumans();
  h.toPrep(1);
  const m = h.m;
  h.run(() => m.phase === PHASE.SETTLE && m.round === 1);
  h.run(() => m.phase === PHASE.ROUND_START && m.round === 2);

  const rich = decorate(h);
  h.invariants(); // the decorated source state is one the engine itself could hold: the round trip below is fair
  return { h, captured, rich, m, ps: h.ps('p_0') };
}

/**
 * The same run stopped one phase later: at the OPEN PREP of round 2, which is where the mid-round heartbeat writes
 * (`STATE_HEARTBEAT_MS` after the round start — an untimed lone-human prep, so a live process sits here). The record is
 * captured by hand at that point, exactly like the round-start one; the heartbeat's own write there is covered by
 * test/state/match-persist.test.js.
 */
function prepRun() {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: SEED, fake: true });
  h.m.stateSink = null;
  h.start();
  h.autoHumans();
  h.toPrep(1);
  h.run(() => h.m.phase === PHASE.SETTLE && h.m.round === 1);
  h.run(() => h.m.phase === PHASE.ROUND_START && h.m.round === 2);
  h.toPrep(2);
  const prep = decorate(h);
  h.invariants();
  return { h, prep, m: h.m, ps: h.ps('p_0') };
}

const atRoundStart = (captured, round) => captured.round_start.find((r) => r.round === round && r.phase === PHASE.ROUND_START);

// ---------------------------------------------------------------------------------------------------
// record v2 shape
// ---------------------------------------------------------------------------------------------------

test('buildRecord writes a v2 record: loneHuman, the volatile run state and the full per-seat props', () => {
  const { h, captured, rich } = sourceRun();
  try {
    const own = atRoundStart(captured, 2);
    assert.ok(own, 'the ROUND_START R2 record was captured by the match itself');
    assert.equal(own.version, RECORD_VERSION);
    assert.equal(RECORD_VERSION, 2, 'P2a bumped the record shape');
    assert.equal(own.loneHuman, true, 'one human seat (Match.loneHuman)');
    assert.equal(own.phase, PHASE.ROUND_START);
    assert.equal(own.round, 2);
    assert.equal(own.seed, SEED);
    assert.equal(captured.settle.length, 1, 'and SETTLE R1 as well');
    // the run state: six streams, the uid / battle counters, the shared pool and the recorded round's enemies
    assert.ok(rich.state, 'a real match captures its run state');
    assert.deepEqual(Object.keys(rich.state.rng).sort(), ['bots', 'draft', 'meta', 'setup', 'shop', 'waves']);
    assert.ok(Number.isInteger(rich.state.uidSeq) && rich.state.uidSeq > 0);
    assert.equal(rich.state.battleSeq, 2);
    assert.equal(rich.state.battlePrefix, h.m.battlePrefix);
    assert.ok(Object.keys(rich.state.pool).length > 10, 'the pool snapshot lists the remaining copies');
    assert.equal(rich.state.pool[h.m.gd.baseIdOf(h.m.gd.visibleChess[0])] !== undefined, true);
    assert.ok(rich.state.wave && Array.isArray(rich.state.wave.spawns), 'the recorded round keeps its enemies by value');
    assert.equal(rich.state.bossWaves, null, 'a normal round has no boss pairing');
    // the per-seat props of the decorated seat
    for (const p of rich.players) assert.ok(p.props, `${p.playerId} carries props`);
    const props = payloadOf(rich, 'p_0');
    assert.ok(props.hand.some(Boolean), 'the hand pieces are in the payload');
    assert.ok(props.board.length >= 1, 'the board is in the payload');
    assert.ok(props.temp.some(Boolean), 'the temp piece is in the payload');
    assert.deepEqual(props.tempDue, [[props.temp.find(Boolean).uid, payloadOf(rich, 'p_0').prepsEnded + 1]]);
    assert.equal(props.offers.length, 1, 'the queued offer is in the payload');
    assert.equal(props.shop.slots.length, h.ps('p_0').shop.slots.length);
    assert.equal(props.shop.slots[1], null, 'a cleared slot stays a hole');
    assert.deepEqual(props.shop.layout, { chess: h.ps('p_0').shop.layout.chess, item: h.ps('p_0').shop.layout.item });
    assert.equal(props.shop.frozen, true);
    assert.equal(props.shop.slots[0].frozen, true);
    assert.equal(props.deployCapBonus, 1);
    assert.equal(props.counters.test, 3);
    assert.deepEqual(props.deviceOverrides, { '0:0': 'melee' });
    assert.ok(Object.keys(props.pendingLayerGains).length === 1);
    // the payload is a SNAPSHOT: mutating the match afterwards does not write into the record
    if (payloadOf(rich, 'p_0').board.length) {
      const pieceRef = props.board[0][1];
      h.ps('p_0').board.get(props.board[0][0]).id = 'mutated-later';
      assert.notEqual(pieceRef.id, 'mutated-later', 'capture copied the piece graphs');
    }
  } finally { h.m.dispose(); }
});

// ---------------------------------------------------------------------------------------------------
// the round trip: a ROUND_START record reconstructs the source state exactly
// ---------------------------------------------------------------------------------------------------

test('a ROUND_START record reconstructs every gameplay field, the pool and all six rng positions', () => {
  const { h, rich } = sourceRun();
  const b = rebuild(rich);
  try {
    const applied = applyRecord(b.m, rich);
    assert.equal(applied, 2, 'both seats (the human and its AI teammate) were restored');
    assert.equal(b.m.round, 2);
    assert.equal(b.m.phase, PHASE.ROUND_START, 're-entered at the recorded boundary');
    for (const p of rich.players) {
      assert.equal(seatDigest(b.m.players.get(p.playerId)), canon(p.props), `${p.playerId}: the seat digest round-trips`);
    }
    assert.equal(runDigest(b.m), canon(rich.state), 'the run state (rng ×6, uid/battle seq, pool, waves) round-trips');
    assert.equal(b.m.uidSeq, rich.state.uidSeq, 'uidSeq is preserved (the next piece gets the id the dead process would give it)');
    assert.equal(b.m._battleSeq, rich.state.battleSeq);
    assert.deepEqual(b.m.pool.snapshot(), h.m.pool.snapshot(), 'the shared pool is where the record left it');
    assert.deepEqual(b.m.wave, rich.state.wave, 'the recorded round keeps the enemies it was recorded with');
    b.invariants();
  } finally { h.m.dispose(); b.m.dispose(); }
});

test('Blocker #1: the OLD order (payload, then startRound) is the bug — the NEW order pays nothing twice', () => {
  const { h, rich } = sourceRun();
  try {
    const payload = payloadOf(rich, 'p_0');
    const digest = canon(payload);

    // (a) the OLD order, kept as the control that proves the regression is real: apply the payload and let resumeAt run
    //     PlayerState.startRound on top of it (a second income, a second upgrade-price drop, a re-rolled shop)
    const old = rebuild(rich);
    for (const p of rich.players) applyPlayerState(old.m.players.get(p.playerId), p);
    old.m.resumeAt(rich.round); // the old call: playerStart defaults to true, the wave is re-drawn
    const drifted = old.ps('p_0');
    assert.equal(drifted.funds, payload.funds + old.m.gd.income(2) + payload.pendingFunds,
      `the old order paid round 2's income a second time (funds ${payload.funds} → ${drifted.funds})`);
    assert.equal(drifted.shop.upgradePrice, Math.max(0, payload.shop.upgradePrice - 1),
      `and dropped the upgrade price again (${payload.shop.upgradePrice} → ${drifted.shop.upgradePrice})`);
    assert.notEqual(canon(drifted.shop.slots), canon(payload.shop.slots), 'and re-rolled the shop');
    old.m.dispose();

    // (b) the NEW order: the payload IS the state, nothing is applied twice and nothing compounds
    const b1 = rebuild(rich);
    const b2 = rebuild(rich);
    applyRecord(b1.m, rich);
    applyRecord(b2.m, rich);
    const human = b1.ps('p_0');
    assert.equal(human.funds, payload.funds, `no income was paid again (funds ${payload.funds} → ${human.funds})`);
    assert.equal(human.pendingFunds, payload.pendingFunds);
    assert.equal(human.shop.upgradePrice, payload.shop.upgradePrice,
      `no second decrement (${payload.shop.upgradePrice} → ${human.shop.upgradePrice})`);
    assert.equal(canon(human.shop.slots), canon(payload.shop.slots), 'the shop was NOT re-rolled');
    assert.equal(canon(human.shop.layout), canon(payload.shop.layout));
    assert.equal(seatDigest(human), digest, 'the whole seat digest is the recorded one');
    assert.equal(seatDigest(b2.ps('p_0')), seatDigest(human), 'the same record applied twice is the same state');
    assert.equal(b1.m.uidSeq, rich.state.uidSeq);
    assert.equal(b2.m.uidSeq, rich.state.uidSeq, 'uidSeq is not advanced by a resume');
    assert.equal(runDigest(b1.m), runDigest(b2.m), 'nothing compounds: the two resumes are identical');
    b1.m.dispose();
    b2.m.dispose();
  } finally { h.m.dispose(); }
});

// ---------------------------------------------------------------------------------------------------
// SETTLE: continue into the next round, exactly as the engine itself would have
// ---------------------------------------------------------------------------------------------------

test('a SETTLE record continues into the NEXT round and lands on the state the source match reached', () => {
  const { h, captured } = sourceRun();
  const settle = captured.settle.find((r) => r.round === 1 && r.phase === PHASE.SETTLE);
  const control = atRoundStart(captured, 2); // what the source match itself reached from that SETTLE
  const b = rebuild(settle);
  try {
    assert.ok(settle, 'the SETTLE R1 record was captured by the match itself');
    assert.ok(settle.players.every((p) => p.props), 'the settled payload is the full one');
    const before = payloadOf(settle, 'p_0');
    assert.equal(applyRecord(b.m, settle), 2);
    assert.equal(b.m.round, 2, 'the settled round is continued, not replayed');
    assert.equal(b.m.phase, PHASE.ROUND_START);
    // the continuation is the engine's own transition (afterSettle → startRound(round + 1)): it must land on the state
    // the source match reached by itself — income paid once on top of the settled funds, one price drop, one new shop
    for (const p of control.players) {
      assert.equal(seatDigest(b.m.players.get(p.playerId)), canon(p.props), `${p.playerId}: the R2 continuation matches the control`);
    }
    assert.equal(runDigest(b.m), canon(control.state), 'and so do the rng streams, the pool and the counters');
    const human = b.ps('p_0');
    assert.equal(human.pendingFunds, 0, 'the settled bounty coins were paid out exactly once');
    assert.equal(human.ready, false, 'the new prep started');
    assert.equal(human.prepsEnded, before.prepsEnded, 'the settled preps stay counted (the round was not settled twice)');
    b.invariants();
  } finally { h.m.dispose(); b.m.dispose(); }
});

test('the same seed and the restored state drive the same future (a deterministic pool/rng/uid stepper)', () => {
  const { h, rich } = sourceRun();
  const b = rebuild(rich);
  /** Twelve steps of the machinery a match's NEXT draws run through: pool rolls, every stream, the uid counter. */
  const step = (m) => {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const base = m.pool.roll(m.rngShop, { maxTier: 1 + (i % 6) });
      out.push([
        base, base ? m.pool.left(base) : 0,
        m.rngShop(), m.rngWaves(), m.rngDraft(), m.rngBots(), m.rngMeta(), m.rngSetup(),
        m.nextUid(), m.pool.roll(m.rngMeta, { maxTier: 4 }),
      ]);
    }
    return canon(out);
  };
  try {
    applyRecord(b.m, rich);
    const control = step(h.m);   // the source match walks on from where the record was taken
    const restored = step(b.m);  // and so does the rebuilt one
    assert.equal(restored, control, 'the same seed + the restored state produce the same future');
    assert.equal(b.m.uidSeq, h.m.uidSeq, 'including the uid counter');
    assert.deepEqual(b.m.pool.snapshot(), h.m.pool.snapshot(), 'and the pool');
  } finally { h.m.dispose(); b.m.dispose(); }
});

// ---------------------------------------------------------------------------------------------------
// PREP: the point the mid-round heartbeat writes (the gate includes it — P2a-b)
// ---------------------------------------------------------------------------------------------------

test('a PREP record is accepted and reconstructs the mid-prep seat exactly (no free income, no second price drop, no re-roll)', () => {
  const { h, prep } = prepRun();
  const b = rebuild(prep);
  try {
    assert.equal(prep.phase, PHASE.PREP, 'the record is the OPEN prep, not a round boundary');
    assert.equal(prep.round, 2);
    assert.deepEqual(resumePlan(prep), { ok: true, round: 2, payloadFirst: false, intoPrep: true },
      'PREP rides the round-start re-entry (payload after, run state last) but enters the PREP directly');
    assert.deepEqual(checkRecord(prep, { now: NOW, ttlMs: RESUME_TTL_MS }), { ok: true },
      'and the boot gate takes it — refusing it would throw away what the heartbeat exists for');
    const before = payloadOf(prep, 'p_0');
    assert.equal(applyRecord(b.m, prep), 2, 'every seat is restored (the AI teammate included)');
    assert.equal(b.m.round, 2);
    assert.equal(b.m.phase, PHASE.ROUND_START, 'the recorded round is re-entered; the engine reopens the prep from there');
    for (const p of prep.players) {
      assert.equal(seatDigest(b.m.players.get(p.playerId)), canon(p.props), `${p.playerId}: the mid-prep seat is the recorded one`);
    }
    assert.equal(runDigest(b.m), canon(prep.state), 'and so are the rng streams, the pool and the counters');
    // Blocker #1 holds on THIS path too: the payload is the state, nothing is applied on top of it
    const human = b.ps('p_0');
    assert.equal(human.funds, before.funds, `no free income (${before.funds} → ${human.funds})`);
    assert.equal(human.pendingFunds, before.pendingFunds);
    assert.equal(human.shop.upgradePrice, before.shop.upgradePrice,
      `no second upgrade-price drop (${before.shop.upgradePrice} → ${human.shop.upgradePrice})`);
    assert.equal(canon(human.shop.slots), canon(before.shop.slots), 'the shop was NOT re-rolled');
    assert.equal(b.m.uidSeq, prep.state.uidSeq, 'uidSeq is neither reset nor advanced');
    assert.equal(human.round.buys, before.round.buys, 'the prep counters are the recorded ones');
    b.invariants();
  } finally { h.m.dispose(); b.m.dispose(); }
});

test('a resumed prep continues where it was: a recorded Ready survives, and the round is playable to the end', () => {
  const { h, prep } = prepRun();
  const b = rebuild(prep);
  try {
    // a recorded Ready is a state the engine itself holds (the human confirmed, the AI teammate has not yet): make the
    // record that one, so the assertion below is really exercised instead of depending on the bot's timing
    const ready = {
      ...prep,
      players: prep.players.map((p) => (p.playerId === 'p_0' ? { ...p, props: { ...p.props, ready: true } } : p)),
    };
    const before = payloadOf(ready, 'p_0');
    assert.equal(before.ready, true);
    assert.equal(applyRecord(b.m, ready), 2);
    assert.equal(b.m.phase, PHASE.ROUND_START);
    // the engine's own ROUND_START → PREP transition reopens the prep: no second round start, no new shop, no income,
    // and — because the record is already INSIDE the prep — no second prep entry that would clear the Ready flag
    assert.ok(b.run(() => b.m.phase === PHASE.PREP), 'the prep reopens');
    const after = captureProps(b.ps('p_0'));
    assert.equal(after.ready, true, 'the human is still ready: the prep entry did not run a second time');
    assert.equal(canon(after), canon(before), 'the whole mid-prep seat is the recorded one');
    assert.equal(b.m.uidSeq, prep.state.uidSeq, 'and no uid was burned on the way in');
    assert.equal(b.m.alivePlayers().every((ps) => ps.ready), false, 'the AI teammate still has to finish its own prep');
    // the round is playable to the end: the human confirms and the (fake) battle settles exactly as in a live match
    b.m.handle('p_0', { t: 'g.ready', ready: true });
    assert.ok(b.run(() => b.m.phase === PHASE.SETTLE && b.m.round === 2), 'the resumed round settles like any other');
    b.invariants();
  } finally { h.m.dispose(); b.m.dispose(); }
});

/**
 * The co-op source run: `humans` human seats plus two bots, driven to the OPEN PREP of round 2 and decorated there —
 * the state a live co-op room sits on when the process dies. The record is captured the way `decorate` does it (no
 * `tokenHashOf`), i.e. the pessimistic shape: no seat can be claimed, and the restore still has to reproduce it.
 */
function coopRun(humans = 2) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans, bots: 2, seed: SEED, fake: true });
  h.m.stateSink = null;
  h.start();
  h.autoHumans();
  h.toPrep(1);
  h.run(() => h.m.phase === PHASE.SETTLE && h.m.round === 1);
  h.run(() => h.m.phase === PHASE.ROUND_START && h.m.round === 2);
  h.toPrep(2);
  const rec = decorate(h);
  h.invariants();
  return { h, rec };
}

test('P1: a CO-OP record with two human seats re-enters, and BOTH humans come back seat for seat', () => {
  // The lone-human run above is the easy case. A co-op room is the one the gate used to refuse: two humans, two bots,
  // one record that has to carry all four seats. Nothing about the restore is per-human — it is per-SEAT, and the
  // record already holds every seat — so the same re-entry must reproduce the whole table.
  const { h, rec } = coopRun(2);
  const b = rebuild(rec);
  try {
    assert.equal(rec.loneHuman, false, 'two human seats: this is exactly the case the gate used to refuse');
    assert.equal(rec.seats.filter((s) => !s.isBot).length, 2, 'both humans are in the record');
    assert.deepEqual(resumePlan(rec), { ok: true, round: 2, payloadFirst: false, intoPrep: true });
    assert.deepEqual(checkRecord(rec, { now: NOW, ttlMs: RESUME_TTL_MS }), { ok: true });
    assert.equal(applyRecord(b.m, rec), 4, 'all four seats are restored (two humans, two bots)');
    assert.equal(b.m.round, 2);
    assert.equal(b.m.phase, PHASE.ROUND_START);
    for (const p of rec.players) {
      assert.equal(seatDigest(b.m.players.get(p.playerId)), canon(p.props), `${p.playerId}: the mid-prep seat is the recorded one`);
    }
    assert.equal(runDigest(b.m), canon(rec.state), 'the rng streams, the pool and the counters are the recorded ones too');
    b.invariants();
  } finally { h.m.dispose(); b.m.dispose(); }
});

test('P1: the lobby-shaped record carries a tokenHash per human seat, and a seat without one costs only that seat', () => {
  const { h, rec } = coopRun(2);
  const b = rebuild(rec);
  try {
    // how the lobby builds it (server/lobby.js noteMatch → tokenHashOf): every human seat gets sha256(token), which is
    // what lets that player be put back into ITS OWN seat after the restart
    const shaped = buildRecord(h.m, {
      build: 'test-build', rulesHash: 'test-rules', now: NOW,
      tokenHashOf: (playerId) => `hash_${playerId}`,
    });
    assert.deepEqual(shaped.seats.filter((s) => !s.isBot).map((s) => s.tokenHash), ['hash_p_0', 'hash_p_1'],
      'one hash per human seat, in seat order');
    assert.ok(shaped.seats.filter((s) => s.isBot).every((s) => s.tokenHash == null), 'bots carry no token');
    // a teammate whose session the process no longer knows (no hash) must not cost the match: the other seats still
    // re-enter and the seat is simply unclaimed until someone reconnects with that token
    const orphaned = { ...shaped, seats: shaped.seats.map((s) => (s.playerId === 'p_1' ? { ...s, tokenHash: null } : s)) };
    assert.deepEqual(checkRecord(orphaned, { now: NOW, ttlMs: RESUME_TTL_MS }), { ok: true });
    assert.equal(applyRecord(b.m, orphaned), 4, 'the seat without a hash is rebuilt too — it just cannot be claimed');
    for (const p of shaped.players) {
      assert.equal(seatDigest(b.m.players.get(p.playerId)), canon(p.props), `${p.playerId}: restored from the lobby-shaped record`);
    }
    b.invariants();
  } finally { h.m.dispose(); b.m.dispose(); }
});

test('a PREP record at a 机变 round does NOT replay the draft: the re-entry comes back to the open prep', () => {
  // round 3 is a draft round for this mode (gd.spRounds() = [3, 6, 9]): the record is written INSIDE the prep, i.e.
  // after the player's pick. Re-entering ROUND_START and letting the round start run would fall back into enterSpDraft
  // and hand out a SECOND 机变 card for a round that is already drafted — the case this option exists for.
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: SEED, fake: true });
  h.m.stateSink = null;
  h.start();
  h.toPrep(1);
  const m = h.m;
  h.run(() => m.phase === PHASE.SETTLE && m.round === 1);
  for (const r of [2, 3]) {
    h.run(() => m.phase === PHASE.ROUND_START && m.round === r);
    h.toPrep(r);
  }
  const prep = buildRecord(m, { build: 'test-build', rulesHash: 'test-rules', now: NOW });
  const b = rebuild(prep);
  const control = rebuild({ ...prep, phase: PHASE.ROUND_START }); // the SAME round, recorded at its boundary
  try {
    assert.deepEqual(m.gd.spRounds(), [3, 6, 9], 'round 3 is a draft round: this is the case that matters');
    assert.equal(prep.phase, PHASE.PREP);
    assert.equal(prep.round, 3);
    const before = payloadOf(prep, 'p_0');
    assert.equal(applyRecord(b.m, prep), 2);
    assert.equal(b.m.phase, PHASE.ROUND_START);
    assert.ok(b.run(() => b.m.phase !== PHASE.ROUND_START), 'the round start runs out');
    assert.equal(b.m.phase, PHASE.PREP, 'the re-entry came back to the OPEN prep, not to a fresh draft');
    assert.equal(b.m.sp, null, 'and no draft was opened');
    assert.equal(canon(captureProps(b.ps('p_0'))), canon(before), 'the mid-prep seat is the recorded one (no second card)');
    assert.equal(canon(b.ps('p_0').shop.slots), canon(before.shop.slots), 'no second draft re-rolled the shop');
    assert.equal(b.m.uidSeq, prep.state.uidSeq);
    // the control proves the difference is the RECORDED PHASE, not the round: a ROUND_START record of round 3 still
    // plays that round's draft (the player picks it again, which is correct — that pick was never in the record)
    assert.equal(applyRecord(control.m, { ...prep, phase: PHASE.ROUND_START }), 2);
    assert.ok(control.run(() => control.m.phase !== PHASE.ROUND_START), 'the control round start runs out');
    assert.equal(control.m.phase, PHASE.SP_DRAFT, 'a round-start record of a draft round still drafts');
    b.invariants();
  } finally { h.m.dispose(); b.m.dispose(); control.m.dispose(); }
});

// ---------------------------------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------------------------------

test('a v1 record is refused (never read as v2) and an unreadable point is refused, not half-entered', () => {
  const { h, rich } = sourceRun();
  try {
    const opts = { now: NOW, ttlMs: RESUME_TTL_MS };
    assert.deepEqual(checkRecord(rich, opts), { ok: true });
    assert.deepEqual(checkRecord({ ...rich, version: 1 }, opts), { ok: false, reason: 'version' },
      'the P0/P1 shape has no props/state: it must never be read as a v2 record');
    assert.deepEqual(checkRecord({ ...rich, version: RECORD_VERSION + 1 }, opts), { ok: false, reason: 'version' });
    // P1: a CO-OP match is re-enterable. The record carries every seat — each human with its own tokenHash, the bots
    // with their whole PlayerState — and the lobby rebuilds the room and the match from exactly those rows, so the
    // number of humans no longer decides anything. What still decides is the POINT (below) and the version.
    assert.deepEqual(checkRecord({ ...rich, loneHuman: false }, opts), { ok: true },
      'more than one human seat no longer refuses the record: the restore is per-seat');
    assert.deepEqual(resumePlan({ ...rich, loneHuman: false }), { ok: true, round: 2, payloadFirst: false, intoPrep: false });
    // PREP is the point the heartbeat writes and is ACCEPTED since P2a-b (see the PREP section above); COMBAT and
    // SP_DRAFT are still refused, each with its own case in the tests below
    assert.deepEqual(checkRecord({ ...rich, phase: PHASE.PREP }, opts), { ok: true },
      'the gate includes the open prep: the heartbeat record is the newest truth on disk');
    assert.deepEqual(checkRecord({ ...rich, phase: PHASE.COMBAT }, opts), { ok: false, reason: 'phase' });
    assert.deepEqual(checkRecord({ ...rich, phase: PHASE.SP_DRAFT }, opts), { ok: false, reason: 'phase' });
    // the Hidden Core chapter (round 15 here) is entered from the visible final assault's live outcome: refused
    assert.equal(rich.hiddenRound, 15);
    assert.deepEqual(checkRecord({ ...rich, round: 15 }, opts), { ok: false, reason: 'final' });
    assert.deepEqual(resumePlan({ ...rich, round: 15 }), { ok: false, reason: 'final' });
    assert.deepEqual(checkRecord({ ...rich, round: 16 }, opts), { ok: false, reason: 'final' },
      'and so is anything past it; the boss round itself (the visible final assault\'s prep) stays resumable');
    assert.deepEqual(checkRecord({ ...rich, round: rich.lastRound, phase: PHASE.SETTLE }, opts), { ok: true });
    assert.deepEqual(checkRecord({ ...rich, round: rich.lastRound, phase: PHASE.PREP }, opts), { ok: true },
      'and so does an open prep at the boss round (the final assault has not started yet)');
    assert.deepEqual(resumePlan({ ...rich, state: null }), { ok: false, reason: 'no-state' });
    // a match implementation without engine state (the platform stub) is NOT gated: it has no round to re-enter
    assert.deepEqual(checkRecord({ ...rich, state: null, loneHuman: false, phase: 'INFO_CHECK' }, opts), { ok: true });
    // and applyRecord never half-enters a refused point
    const b = rebuild(rich);
    assert.equal(applyRecord(b.m, { ...rich, phase: PHASE.COMBAT }), 0);
    assert.equal(b.m.phase, 'INFO_CHECK', 'the match was left untouched');
    assert.equal(b.m.round, 0);
    assert.equal(applyRecord(b.m, { ...rich, version: 1 }), 0, 'nor does a v1 record get to re-enter a round');
    assert.equal(b.m.phase, 'INFO_CHECK');
    b.m.dispose();
  } finally { h.m.dispose(); }
});

/**
 * One refused phase, one case: the reason, and the proof that nothing was half-entered. P2a-b widened the gate to PREP;
 * these three are the phases that MUST stay refused, because a battle in flight, a draft in progress and the final
 * assault are not persisted anywhere in a record.
 * @param {string} phase @param {string} why @param {object} [over]
 */
function refusesPhase(phase, why, over = {}) {
  const { h, rich } = sourceRun();
  const b = rebuild(rich);
  const rec = { ...rich, phase, ...over };
  try {
    assert.deepEqual(checkRecord(rich, { now: NOW, ttlMs: RESUME_TTL_MS }), { ok: true }, 'the control record itself is fine');
    assert.deepEqual(resumePlan(rec), { ok: false, reason: 'phase' }, why);
    assert.deepEqual(checkRecord(rec, { now: NOW, ttlMs: RESUME_TTL_MS }), { ok: false, reason: 'phase' });
    assert.equal(applyRecord(b.m, rec), 0, 'and the rebuilt match is left untouched — never half-entered');
    assert.equal(b.m.phase, 'INFO_CHECK');
    assert.equal(b.m.round, 0);
  } finally { h.m.dispose(); b.m.dispose(); }
}

test('a COMBAT record is still refused: a battle in flight is not persisted', () => {
  refusesPhase(PHASE.COMBAT, 'mid-combat resume stays refused (the battle would be invented, not restored)');
});

test('an SP_DRAFT record is still refused: a draft in progress is not persisted', () => {
  refusesPhase(PHASE.SP_DRAFT, 'mid-draft resume stays refused (the cards and the picked order are not in the record)');
});

test('a FINAL_ASSAULT record is still refused: the final assault is not persisted', () => {
  // at the boss round, where the final assault really happens: a state whose team LP / boss pool are not recorded
  refusesPhase(PHASE.FINAL_ASSAULT, 'the final assault stays refused', { round: 14 });
});

test('the lobby resume path is unchanged for a record without engine state (no resumeAt on the stub)', () => {
  const { h } = sourceRun();
  try {
    const stub = {
      roomCode: 'TEST', mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seed: SEED, round: 0,
      phase: 'INFO_CHECK', ended: false,
      order: [{ playerId: 'p_0', seat: 0, name: 'P0', isBot: false, lp: 5, layers: {}, counters: {}, round: {}, stats: {}, bondCountBonus: {}, loadout: {}, shop: { level: 2 } }],
      opts: {},
    };
    const rec = buildRecord(stub, { now: NOW });
    assert.equal(rec.state, null, 'a match with no pool / rng captures no run state');
    assert.equal(rec.players[0].props, null, 'and no engine props');
    assert.equal(rec.loneHuman, true, 'derived from the seat rows when the match does not expose loneHuman');
    const targets = { players: new Map([['p_0', { playerId: 'p_0', isBot: false }]]) };
    assert.equal(applyRecord(targets, rec), 1, 'the plain payload still applies');
  } finally { h.m.dispose(); }
});
