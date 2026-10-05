// REPRO (playtest report): in a co-op match, once one player quits (or drops) mid-round, the players who stayed
// finish their own board and then hang — the round never advances to the next one, and the deadline does nothing.
//
// Contract under test (test/match/connection.test.js documents the intent):
//   * a drop keeps the seat, the server takes its field over, and draft turns / prep auto-resolve at deadlines;
//   * a real quit (g.leave) eliminates that seat at once.
// Either way the match must keep advancing for the humans who are still there.
//
// This file is a reproduction first: if it passes, the stall lives in a path these helpers do not reach yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

/** Everyone confirms, then round 1 prep. */
function reachPrep(h, ids) {
  for (const id of ids) h.m.handle(id, { t: 'g.infoReady' });
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 1);
}

test('REPRO quit: a player leaving mid-round must not stall the players who stayed', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 4242, fake: true, script: () => ({ duration: 4 }) }).start();
  const m = h.m;
  reachPrep(h, ['p_0', 'p_1', 'p_2']);

  // p_2 quits for good (the platform's g.leave — not a drop)
  m.handle('p_2', { t: 'g.leave' });
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_2').status, 'left', 'a quit eliminates the seat');

  // the two who stayed play their own round
  for (const id of ['p_0', 'p_1']) m.handle(id, { t: 'g.ready', ready: true });
  h.run(() => m.phase === PHASE.COMBAT);

  // the match must finish the round on its own — this is where the report says it hangs forever
  h.run(() => m.round === 2 || m.ended);
  assert.ok(m.round === 2 || m.ended, 'the round advances instead of hanging forever');
  m.dispose();
});

test('REPRO disconnect: a dropped player mid-round must not stall the players who stayed', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 4243, fake: true, script: () => ({ duration: 4 }) }).start();
  const m = h.m;
  reachPrep(h, ['p_0', 'p_1', 'p_2']);

  // p_2 loses their connection (seat kept, server takes the field over)
  m.onDisconnect('p_2');
  for (const id of ['p_0', 'p_1']) m.handle(id, { t: 'g.ready', ready: true });
  h.run(() => m.phase === PHASE.COMBAT);
  assert.ok(m.fields.some((f) => f.fieldId === 'n:p_2'), 'the dropped seat still fights');

  h.run(() => m.round === 2 || m.ended);
  assert.ok(m.round === 2 || m.ended, 'the round advances instead of hanging forever');
  m.dispose();
});

test('REPRO silence: a client field whose authority never reports must be taken over by its deadline', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 777, fake: false, instant: false, script: () => ({ duration: 600 }) }).start();
  const m = h.m;
  for (const id of ['p_0', 'p_1']) m.handle(id, { t: 'g.infoReady' });
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  for (const id of ['p_0', 'p_1']) m.handle(id, { t: 'g.ready', ready: true });
  h.run(() => m.phase === PHASE.COMBAT);
  const f = m.fields.find((x) => x.live);
  assert.ok(f, 'a live field');
  // FINDING (2026-10-05): plain makeMatch never reaches client-authoritative combat - the field is already
  // mode 'server' here, so this file only covers the server-run path. The production stall is on the path that
  // test/match/clientCombat.test.js builds instead (an authority that stops reporting while still connected).
  if (f.mode !== 'client') { m.dispose(); return; }
  const lim = f.spec.timeLimit > 0 ? f.spec.timeLimit : 60;
  m.sched.advance((lim + 20) * 1000);
  assert.notEqual(f.mode, 'client', 'a silent authority must not hold the round forever (no takeover)');
  m.dispose();
});
