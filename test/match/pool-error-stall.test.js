// Regression (owner report 2026-10-06): 「只要有人退了，整个游戏就无法推进（时间到0无法继续下一回合）」.
//
// Production is the only place the worker pool runs (`SP_SIM_WORKERS=1`; /healthz showed fieldsPooled 25 on one worker).
// A departure is exactly what puts a field there: `_authorityLost` hands the leaver's field to `_runOnServer`, which
// prefers the pool. Two defects in that wiring stalled the phase that owned the field — and the takeover had already
// cancelled the field's own deadline, so nothing else could end it:
//
//   1. `f.poolJob` was the wrapper object `{ pause, resume, cancel }` while the guards compared it against the handle
//      `pool.run()` returned. The two are never equal, so `onDone` returned early every time: a pooled field NEVER took
//      its result, however well the worker ran. (The main defect: every pooled field hung its round.)
//   2. simPool's contract is "onError once, never followed by onDone" (a job error, a dead worker, a degraded pool).
//      `onError` only called `reportError`, so a lost job also left the field with no result and nothing armed.
//
// Both are exercised here at the seam `_runOnServer` uses, with the pool injected (the real one needs a non-virtual
// scheduler and the stock Battle, which is why no engine suite ever reached this code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

/** A co-op match in COMBAT R1 whose p_1 field the server has taken over (p_1 dropped). */
function takeover() {
  const h = makeMatch({
    mode: 'coop', humans: 2, bots: 0, seed: 5150, fake: true, clientCombat: true,
    instant: false, headlessSliceMs: 8, script: () => ({ duration: 3 }),
  }).start();
  const m = h.m;
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  for (const id of ['p_0', 'p_1']) m.handle(id, { t: 'g.ready', ready: true });
  h.run(() => m.phase === PHASE.COMBAT);

  const f = m.fields.find((x) => x.fieldId === 'n:p_1');
  assert.ok(f, 'p_1 has a field');
  m.onDisconnect('p_1');
  assert.equal(f.mode, 'server', 'the dropped seat is simulated by the server');
  assert.equal(f.result, null, 'the sliced takeover has not produced a result yet');
  return { h, m, f };
}

/** Hand the field to a pool stub and return the callbacks it was given. */
function handToPool(m, f) {
  let opts = null;
  const pool = { enabled: true, run: (spec, o) => { opts = o; return { pause() {}, resume() {}, cancel() {} }; } };
  assert.equal(m._runFieldInPool(f, pool), true, 'the pool took the field');
  assert.ok(opts, 'the pool was handed the job callbacks');
  return opts;
}

const stallReport = (h, m, f, label) => `${label} — STALLED: phase=${m.phase} round=${m.round} `
  + `fields=${m.fields.map((x) => `${x.fieldId}:${x.mode}${x.done ? ':done' : ':live'}${x.result ? ':result' : ':noresult'}`).join(',')} `
  + `deadline=${m.deadline} now=${h.sched.now()} poolJob=${!!f.poolJob}`;

// `m.ended` is `false` until the match ends: test it for truth, never `!= null` (`false != null` is true and would make
// the assertion below vacuous — the first draft of this test passed against the unfixed code for exactly that reason).
const throughRound = (h) => h.run(() => h.m.round >= 2 || !!h.m.ended, { maxTime: 120_000 });

test('a worker job that finishes must actually deliver its result (the wrapper/handle identity)', () => {
  const { h, m, f } = takeover();
  const opts = handToPool(m, f);
  // the frame simHost.js sends when the battle ran to its end in the worker
  opts.onDone({ result: { perPlayer: [{ playerId: 'p_1', lp: 0 }] }, timeline: [{ gt: 3 }], time: 3, crashed: false });
  assert.ok(f.result, 'the finished worker run reached the field');
  assert.equal(f.poolJob, null, 'the field is no longer owned by the pool');
  assert.ok(throughRound(h), stallReport(h, m, f, 'finished job'));
  m.dispose();
});

test('a worker job that is lost must be re-run on this thread, not strand the phase', () => {
  const { h, m, f } = takeover();
  const opts = handToPool(m, f);
  opts.onError(new Error('worker died'));
  assert.equal(f.noPool, true, 'the field will not be handed back to the pool that lost it');
  assert.ok(throughRound(h), stallReport(h, m, f, 'lost job'));
  m.dispose();
});

test('even a fallback that itself fails must settle the field and end the phase', () => {
  const { h, m, f } = takeover();
  const opts = handToPool(m, f);
  // the in-thread fallback blows up (a spec it cannot build, a bug in the takeover path): the field still has to end,
  // because the phase has no timer left to rescue it
  m._runOnServer = () => { throw new Error('fallback exploded'); };
  opts.onError(new Error('worker died'));
  assert.ok(f.result, 'the field got a result anyway');
  assert.equal(f.done, true, 'and it is done, so the phase can move on');
  assert.ok(throughRound(h), stallReport(h, m, f, 'failed fallback'));
  m.dispose();
});
