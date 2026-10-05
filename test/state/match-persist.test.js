// test/state/match-persist.test.js — the write points inside the match engine (server/match/Match.js + server/state/*).
//
// The engine itself must stay I/O-free, so what is asserted here is exactly the contract: reaching ROUND_START or
// SETTLE calls the injected `stateSink`, the mid-round heartbeat fires on the match's own scheduler, and a frozen
// match writes nothing at all. The heavy parts (battles) are the harness's fake battle — no full battle is simulated.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeMatch } from '../match/harness.js';
import { MemoryStore } from '../../server/state/store.js';
import { PersistQueue } from '../../server/state/persist.js';
import { StateBridge, matchKey, loadResumable } from '../../server/state/resume.js';
import { RECORD_VERSION } from '../../server/state/snapshot.js';
import { STATE_HEARTBEAT_MS } from '../../server/match/Match.js';
import { PHASE } from '../../shared/constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A bridge on an in-memory store, plus every reason the engine reported. */
function wiredMatch(seed, opts = {}) {
  const store = new MemoryStore({ log: quiet });
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, build: 'test-build', rulesHash: 'test-rules', log: quiet });
  const reasons = [];
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed, fake: true, ...opts });
  h.m.stateSink = (reason, m) => {
    reasons.push(reason);
    bridge.noteMatch(m, { tokenHashOf: (playerId) => (playerId === 'p_0' ? 'hash-of-p_0' : null) });
  };
  h.reasons = reasons;
  h.bridge = bridge;
  h.persist = persist;
  h.store = store;
  return h;
}

test('a match reaching ROUND_START persists a record, and SETTLE persists the settled round', async () => {
  const h = wiredMatch(4242);
  const m = h.m;
  try {
    h.start();
    h.autoHumans();
    h.toPrep(1); // ROUND_START R1 happened on the way here
    assert.ok(h.reasons.includes('round_start'), `ROUND_START wrote a record: ${h.reasons.join(',')}`);
    await h.persist.idle();
    const atPrep = await h.store.get(matchKey('TEST'));
    assert.ok(atPrep, 'the record exists');
    assert.equal(atPrep.version, RECORD_VERSION, 'the record carries the CURRENT version (v2 since P2a)');
    assert.equal(atPrep.code, 'TEST', 'the record is keyed by the room code');
    assert.equal(atPrep.mode, 'coop');
    assert.equal(atPrep.difficulty, 'NORMAL');
    assert.equal(atPrep.seed, 4242, 'the master seed rides along: the match is reconstructible from it');
    assert.equal(atPrep.round, 1);
    assert.equal(atPrep.ended, false);
    assert.equal(atPrep.build, 'test-build');
    assert.equal(atPrep.rulesHash, 'test-rules');
    assert.ok(atPrep.updatedAt > 0);
    // seats: the human with the identity hash that proves its seat, the bots without one
    const human = atPrep.seats.find((s) => !s.isBot);
    assert.equal(human.playerId, 'p_0');
    assert.equal(human.tokenHash, 'hash-of-p_0');
    assert.equal(atPrep.seats.length, 4, '4 seats: 1 human + 3 AI');
    assert.ok(atPrep.seats.filter((s) => s.isBot).every((s) => s.tokenHash === null));
    // the per-player payload the resume applies
    const payload = atPrep.players.find((p) => p.playerId === 'p_0');
    assert.ok(payload, 'the human got a payload');
    assert.equal(typeof payload.lp, 'number');
    assert.equal(typeof payload.bandId, 'string');
    assert.equal(typeof payload.funds, 'number');
    assert.ok(payload.layers && typeof payload.layers === 'object');

    // drive the (fake) battle to settlement — the second durable point
    h.drive(() => m.phase === 'SETTLE');
    assert.equal(m.phase, 'SETTLE');
    assert.ok(h.reasons.includes('settle'), `SETTLE wrote a record: ${h.reasons.join(',')}`);
    assert.equal(m._stateTimer, null, 'the round boundary stopped the heartbeat');
    await h.persist.idle();
    const atSettle = await h.store.get(matchKey('TEST'));
    assert.equal(atSettle.phase, 'SETTLE');
    assert.equal(atSettle.round, 1);
    // a settled match does not rewrite the same record while it waits to move on (DELAYS.SETTLE = 3000 ms)
    const beats = h.reasons.filter((r) => r === 'heartbeat').length;
    h.sched.advance(2000);
    assert.equal(m.phase, 'SETTLE');
    assert.equal(h.reasons.filter((r) => r === 'heartbeat').length, beats, 'no heartbeat once the round is over');
  } finally { m.dispose(); }
});

test('the mid-round heartbeat writes every STATE_HEARTBEAT_MS, and a frozen match writes nothing', async () => {
  const h = wiredMatch(777);
  const m = h.m;
  try {
    h.start();
    h.autoHumans();
    h.toPrep(1);
    const base = h.reasons.filter((r) => r === 'heartbeat').length;
    assert.equal(base, 0, 'nothing but the boundary write so far');
    assert.ok(m._stateTimer, 'the heartbeat is armed while a round is active');

    // runUntil drives the virtual clock one callback at a time, so the count is exact: one write per interval, and the
    // tick always re-arms itself
    const beating = () => h.reasons.filter((r) => r === 'heartbeat').length;
    assert.ok(h.run(() => beating() >= 3, { maxSteps: 5000 }), 'the heartbeat keeps firing while the round runs');
    assert.equal(beating(), 3, 'exactly one write per interval — no bursts, no duplicates');

    // a frozen match (solo pause / idle suspension) parks the chain: no wake-ups, no writes
    const before = h.reasons.length;
    m._freeze();
    h.sched.advance(STATE_HEARTBEAT_MS * 5);
    assert.equal(h.reasons.length, before, 'a frozen match persisted nothing');
    assert.equal(m._stateTimer, null, 'and left no timer armed');
    assert.equal(m._stateWanted, true, 'the chain is parked, waiting for the resume');
    m._unfreeze();
    assert.equal(m._stateWanted, false);
    assert.ok(m._stateTimer, 'the resume hands the chain its next tick');
    assert.ok(h.run(() => h.reasons.length > before, { maxSteps: 5000 }), 'the heartbeat runs again');
    assert.equal(h.reasons.length, before + 1, 'exactly once, not twice');

    // the stop is explicit and idempotent: the round-end path (SETTLE) uses the same call
    m._stopStateHeartbeat();
    assert.equal(m._stateTimer, null);
    assert.equal(m._stateWanted, false);
  } finally { m.dispose(); }
});

test('the heartbeat writes a resumable PREP record: the boot scan keeps it and purgeRefused does not delete it', async () => {
  const h = wiredMatch(2024);
  const m = h.m;
  try {
    h.start();
    h.autoHumans();
    h.toPrep(1);
    assert.equal(m.phase, PHASE.PREP);
    assert.equal(m.loneHuman, true, 'one human seat: the re-entry gate accepts this match');
    // the heartbeat fires while the prep is open — a lone-human prep is untimed, so the match really is sitting there
    const beating = () => h.reasons.filter((r) => r === 'heartbeat').length;
    assert.ok(h.run(() => beating() >= 1, { maxSteps: 5000 }), 'the heartbeat wrote mid-prep');
    assert.equal(m.phase, PHASE.PREP, 'and the prep is still open (the human has not confirmed)');
    await h.persist.idle();
    const rec = await h.store.get(matchKey('TEST'));
    assert.equal(rec.phase, PHASE.PREP, 'the record on disk is the OPEN prep, not a round boundary');
    assert.equal(rec.round, 1);
    assert.equal(rec.loneHuman, true);
    assert.ok(rec.state && rec.players.every((p) => p.props), 'and it carries the full state (P2a)');

    // the "new process": the boot scan must TAKE it (P2a-b — the gate includes PREP) and purgeRefused must leave it
    const scan = await loadResumable(h.store, { build: 'test-build', rulesHash: 'test-rules', perSecond: 0, log: quiet });
    assert.deepEqual(scan.refused, [], 'a PREP record is not refused: it is the point the heartbeat exists to write');
    assert.deepEqual(scan.records.map((r) => r.code), ['TEST']);
    const bridge2 = new StateBridge({ store: h.store, persist: h.persist, build: 'test-build', rulesHash: 'test-rules', resume: true, log: quiet });
    bridge2.noteRefused(scan.refused);
    bridge2.markResumable(scan.records);
    assert.equal(bridge2.purgeRefused(), 0, 'nothing to purge: PREP is no longer "never resumable"');
    await h.persist.idle();
    assert.equal(bridge2.resumedCount, 1, 'the record is resumable');
    assert.ok(await h.store.get(matchKey('TEST')), 'and it is still on disk after the boot purge');
    assert.equal(bridge2.claim('not-the-token'), null, 'a wrong token proves nothing');
  } finally { m.dispose(); }
});

test('a match without a state sink (tests, tools, simulations) schedules no heartbeat at all', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 5, fake: true });
  const m = h.m;
  try {
    h.start();
    h.autoHumans();
    h.toPrep(1);
    assert.equal(m.stateSink, null);
    assert.equal(m._stateTimer, null, 'nothing was armed');
    h.sched.advance(STATE_HEARTBEAT_MS * 4);
    assert.equal(m._stateTimer, null, 'and nothing ever is');
  } finally { m.dispose(); }
});

test('dispose() and finish() stop the heartbeat, and an ended match is never persisted', async () => {
  const h = wiredMatch(99);
  const m = h.m;
  try {
    h.start();
    h.autoHumans();
    h.toPrep(1);
    assert.ok(m._stateTimer);
    m.finish({ victory: false, reason: 'abandoned' });
    assert.equal(m._stateTimer, null, 'finish() stopped the heartbeat');
    const seen = h.reasons.length;
    h.sched.advance(STATE_HEARTBEAT_MS * 3);
    assert.equal(h.reasons.length, seen, 'an ended match writes nothing more');
    assert.equal(h.bridge.noteMatch(m), false, 'and the bridge refuses an ended match outright');
  } finally { m.dispose(); }
});
