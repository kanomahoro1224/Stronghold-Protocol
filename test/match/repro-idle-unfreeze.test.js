// REPRO (playtest screenshot): FINAL_ASSAULT co-op, round 3, COUNTDOWN 00, a player on -9 (eliminated, watching),
// the board never advances, the UI waits on a seat that will never report.
//
// What the code does today:
//   * _idleTick freezes a match once liveHumans() is 0 for idlePauseMs (Match.js:1583) and only ever resets idleSince
//     when somebody is watching again (1581) - it never clears idlePaused;
//   * the only caller of _resumeIdle() is onReconnect (Match.js:612), which refuses a player who is not a seat
//     (`ps.left`) and which the lobby does NOT call for a spectator/eliminated player (lobby.js:1180 prefers
//     addSpectator).
// So a frozen co-op match whose remaining human is an eliminated watcher - or whose seats were re-attached without
// onReconnect - stays frozen forever: the boss clock, the progress ticker and the silence watchdog all stay parked
// and the round can never advance. That is the reported hang.
//
// clientCombat: true is required: plain makeMatch builds server-run fields, which hides this path entirely.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

test('REPRO: an idle-frozen match must unfreeze once a human is connected again', () => {
  const h = makeMatch({
    mode: 'coop', humans: 2, seed: 9001, fake: true, clientCombat: true, clients: false, instant: false,
    idlePauseMs: 1_000, idleCheckMs: 100,
  }).start();
  const m = h.m;
  h.autoHumans();
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT, { maxSteps: 5e6 }), 'reached combat');

  // every seat drops: the idle watch freezes the match (this part is intended)
  m.onDisconnect('p_0');
  m.onDisconnect('p_1');
  assert.equal(m.liveHumans(), 0);
  h.sched.advance(1_500);
  assert.equal(m.idlePaused, true, 'frozen after the idle grace');

  // a human is connected again, but re-attached the way the lobby does it for a spectator / eliminated player:
  // the flag flips without onReconnect, so _resumeIdle() is never called.
  m.players.get('p_0').connected = true;
  h.sched.advance(500);
  assert.equal(m.liveHumans(), 1);
  assert.equal(m.idlePaused, false, 'a connected human must unfreeze the match - today it stays frozen forever');
  assert.equal(m.paused, false, 'the frozen match must start stepping again');
  m.dispose();
});
