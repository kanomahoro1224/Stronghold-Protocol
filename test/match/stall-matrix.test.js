// Stress matrix for the owner report: 「只要有人退了，整个游戏就无法推进（时间到0无法继续下一回合）」.
//
// Production evidence (3 h of journal on 45.207.220.22): 1004 field takeovers, of which many are `(left)`. One match
// (GXTF) lost three players inside 11 s of the same round — the signature of a team giving up on a round that would not
// end. So the stall is a COMBINATION: a departure plus everything else that happens to the same field, which the
// single-axis suites never put together.
//
// Matrix: action {quit, drop} × phase {INFO_CHECK, BAND_DRAFT, SP_DRAFT, PREP, COMBAT} × follow-up {none, freeze+return}.
// The freeze is the solo-pause primitive (`_freeze`/`_unfreeze`) driven directly: it is the only way a match still
// freezes now that the idle suspension is gone, and the pooled/sliced field work it parks must still finish afterwards.
// Every cell must still reach the next round (or end the match) for the players who stayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

const PHASES = [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.PREP, PHASE.COMBAT];
const ACTIONS = ['quit', 'drop'];
const FOLLOWS = ['none', 'freeze+return'];

/** Drive the match (humans auto-answer) until `phase`; returns the harness. */
function toPhase(seed, phase, clientCombat) {
  const h = makeMatch({
    mode: 'coop', humans: 3, bots: 1, seed, fake: true, instant: false, clientCombat,
    script: () => ({ duration: 3 }),
  }).start();
  const ok = h.drive(() => h.m.phase === phase || h.ended != null, { ready: true });
  assert.ok(ok && h.m.phase === phase, `seed ${seed}: could not reach ${phase} (got ${h.m.phase}${h.ended ? ', ended' : ''})`);
  return h;
}

for (const clientCombat of [true, false]) {
  for (const phase of PHASES) {
    for (const action of ACTIONS) {
      for (const follow of FOLLOWS) {
        const label = `${clientCombat ? 'client' : 'server'}-combat / ${phase} / ${action} / ${follow}`;
        test(`stall matrix: ${label}`, () => {
          const seed = 7000 + phase.length * 10 + action.length + (follow === 'none' ? 0 : 1);
          const h = toPhase(seed, phase, clientCombat);
          const m = h.m;
          const gone = 'p_2';        // the departing seat
          const staying = ['p_0', 'p_1'];

          if (action === 'quit') m.onLeave(gone);
          else m.onDisconnect(gone);
          assert.equal(m.players.get(gone).left, action === 'quit', `${label}: departure applied`);

          if (follow === 'freeze+return') {
            // the players who stayed lose their connection too, and the match freezes (the solo-pause primitive, the
            // only freeze left): the fields it parks — sliced headless jobs and pooled jobs alike — must finish after
            // the resume instead of stranding the round
            for (const id of staying) m.onDisconnect(id);
            m._freeze();
            assert.equal(m.paused, true, `${label}: the match is frozen`);
            h.sched.advance(1500);
            // and they come back
            for (const id of staying) m.onReconnect(id);
            m._unfreeze();
            assert.equal(m.paused, false, `${label}: the freeze lifted`);
          }

          // The players who stayed must still get through the round. (`m.ended` is `false` until the match ends: test it
          // for truth, never `!= null` — `false != null` is true and would make every cell of this matrix vacuous.)
          const target = m.phase === PHASE.COMBAT ? 'round 2' : 'the next phase';
          const done = h.run(() => m.round >= 2 || !!m.ended, { maxTime: 900_000 });
          assert.ok(done, `${label}: STALLED — phase=${m.phase} round=${m.round} paused=${m.paused} `
            + `fields=${m.fields.map((f) => `${f.fieldId}:${f.mode}${f.done ? ':done' : ':live'}`).join(',')} `
            + `deadline=${m.deadline} (wanted ${target})`);
          assert.equal(h.logs.error.length, 0, `${label}: errors — ${h.logs.error.join(' | ')}`);
          m.dispose();
        });
      }
    }
  }
}
