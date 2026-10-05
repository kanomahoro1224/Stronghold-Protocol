// test/match/field-battle-release.test.js — P2 lever 1: a server-run (client-combat) field releases its finished battle
// graph as soon as its `HeadlessJob` is done (`Match._releaseFieldBattle`, called from the `complete()` closure of
// `_runOnServer`) instead of keeping `f.battle` on the field until the phase ends.
//
// Nothing else may change. What the match still reads travels beside the released graph:
//   * `f.result`   — settlement / LP / `lastResults` input,
//   * `f.timeline` — the teammates' progress UI (`_fieldProgress`, `_uniteLeft`) on the field clock,
//   * `f.endGt`    — the field-clock time the result is released at (`_armRelease`),
//   * `f.battleErrors` — the engine-error records `_collectSimErrors` folds into `m.simErrorLog`.
//
// The tests hold every one of those to an independently rebuilt battle from the very same spec (the spec carries the
// seed), and compare a released run against a retained one — the release is a single overridable seam — for one seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { runHeadless, timelineAt } from '../../server/match/fields.js';
import { makeMatch } from './harness.js';

const CFG = {
  mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, captureFrames: false,
};

/**
 * Drive a virtual-time match to COMBAT and on until `n` server-run fields have their result (so `complete()` ran).
 *
 * Each field is also observed the instant its OWN result appears (`h.atResult`), not only once all `n` have one. The
 * release seam runs inside the same `complete()` callback, but `_armRelease` arms a *zero-delay* timer under the
 * virtual scheduler's instant mode (`Match._armRelease`: `this.sched.instant ? 0 : …`), so the field that finishes
 * first is `f.done` (and its published progress turns into its result's totals) as soon as one more scheduler callback
 * runs. The two fields' `HeadlessJob` slice chains (`headlessSliceMs`: the 8 ms budget is checked against the wall
 * clock every 16 ticks) need not take the same number of slices, so which field finishes first — and by how many
 * slices — varies with machine load. Waiting for both fields would therefore sometimes observe the earlier one
 * *after* its release timer fired (`f.done === true`), which says nothing about the release. `atResult` holds
 * `{ done, at, progress }` at the one interleaving-independent instant: that field's own result, after the release
 * seam and before its field-clock release timer can run.
 */
function toCompleted(n, seed, { release = true } = {}) {
  const h = makeMatch({ ...CFG, seed });
  h.autoHumans();
  // `release: false` reproduces the pre-lever behaviour: the finished battle stays on the field until the phase ends.
  if (!release) h.m._releaseFieldBattle = () => {};
  h.m.start();
  const hasResult = (f) => !!f.cc && f.mode === 'server' && !!f.result;
  const atResult = new Map();
  for (let k = 1; k <= n; k++) {
    h.run(() => !!h.m.ended || (h.m.phase === PHASE.COMBAT && h.m.fields.filter(hasResult).length >= k), { maxSteps: 4e7 });
    for (const f of h.m.fields) {
      if (!hasResult(f) || atResult.has(f.fieldId)) continue;
      const view = h.m.publicView().fields.find((x) => x.fieldId === f.fieldId);
      atResult.set(f.fieldId, { done: f.done, at: h.m._fieldElapsed(f), progress: view ? view.progress : null });
    }
  }
  h.atResult = atResult;
  return h;
}

const serverFields = (h) => h.m.fields.filter((f) => f.cc && f.mode === 'server' && f.result);

test('a completed server-run field drops its battle graph and keeps result / timeline / endGt / error records', () => {
  const h = toCompleted(2, 4141);
  const m = h.m;
  try {
    const done = serverFields(h);
    assert.equal(done.length, 2, 'both bot fields finished on the server');
    assert.equal(m.phase, PHASE.COMBAT, 'the release happens inside COMBAT, not at the phase end');
    for (const f of done) {
      assert.equal(f.battle, null, `${f.fieldId}: the battle graph is released`);
      // `done` and the published progress are read at this field's own result (toCompleted): both change later, on the
      // virtual scheduler's zero-delay `_armRelease` timer, which is a harness-clock artifact, not the release.
      const obs = h.atResult.get(f.fieldId);
      assert.ok(obs, `${f.fieldId}: the field was observed the moment its result appeared`);
      assert.equal(obs.done, false, `${f.fieldId}: its result still waits for the field clock (_armRelease)`);
      assert.ok(f.result && typeof f.result === 'object' && f.result.perPlayer, `${f.fieldId}: result kept`);
      assert.ok(Array.isArray(f.timeline) && f.timeline.length > 0, `${f.fieldId}: timeline kept`);
      assert.ok(Number.isFinite(f.endGt) && f.endGt > 0, `${f.fieldId}: endGt kept`);

      // the same spec (it carries the seed) rebuilt from scratch reproduces every value the match reads
      const fresh = runHeadless(m._specBattle(f.spec), { players: f.players });
      assert.deepEqual(f.result, fresh.result, `${f.fieldId}: result identical to an independent rebuild`);
      assert.deepEqual(f.timeline, fresh.timeline, `${f.fieldId}: timeline identical`);
      assert.equal(f.endGt, Number(fresh.battle.time) || 0, `${f.fieldId}: endGt identical`);
      assert.deepEqual(f.battleErrors ?? [], fresh.battle.errors ?? [], `${f.fieldId}: error records identical`);

      // the teammates' progress view of the released field still reports what the battle had done at the FIELD clock
      // (the job ran ahead of it in slices), computed from the kept timeline — and the rebuilt battle's identical
      // timeline says the same thing at that clock. Read at the field's own result (`obs`): once the harness's
      // zero-delay `_armRelease` timer has run, the published progress is the result's totals with `done: true`.
      const at = obs.at;
      const view = m.publicView().fields.find((x) => x.fieldId === f.fieldId);
      assert.ok(view, `${f.fieldId}: still published in m.public.fields`);
      const [, killed, total] = timelineAt(f.timeline, at);
      assert.deepEqual(obs.progress, { killed, total, done: false },
        `${f.fieldId}: progress comes from the timeline, not the released battle`);
      const freshAt = timelineAt(fresh.timeline, at);
      assert.deepEqual([killed, total], [freshAt[1], freshAt[2]],
        `${f.fieldId}: the published progress equals the rebuilt battle's timeline at the same field clock`);
    }
    assert.equal(m.errorCount, 0, 'no error was reported while the fields completed');
    assert.deepEqual(h.sched.errors, []);
    assert.equal(m.hostedFieldStats().inThread, 0, 'no headless job is left holding a released field');
  } finally {
    m.dispose();
    h.clients?.closeAll();
  }
});

/** Plain snapshot of everything a field exposes to the rest of the match (no battle object). */
function snapshot(h) {
  return h.m.fields.map((f) => ({
    fieldId: f.fieldId,
    kind: f.kind,
    players: f.players.slice(),
    mode: f.mode,
    // read at the field's own result (`toCompleted`) — `f.done` flips later on the harness's zero-delay `_armRelease`
    // timer, and that timing is not the release's doing (client-run fields are not observed there, so keep the live flag)
    done: h.atResult.get(f.fieldId)?.done ?? f.done,
    result: f.result ?? null,
    timeline: f.timeline ?? null,
    endGt: f.endGt ?? null,
    errors: f.battleErrors ?? (f.battle ? f.battle.errors : null) ?? null,
  }));
}

test('the same seed, released vs retained: every field value deep-equals', () => {
  const a = toCompleted(2, 4242, { release: true });
  const sa = snapshot(a);
  const aHeld = a.m.fields.filter((f) => f.cc && f.battle).map((f) => f.fieldId);
  a.m.dispose();
  a.clients?.closeAll();

  const b = toCompleted(2, 4242, { release: false });
  const sb = snapshot(b);
  const bHeld = b.m.fields.filter((f) => f.cc && f.battle).map((f) => f.fieldId);
  b.m.dispose();
  b.clients?.closeAll();

  assert.equal(sa.filter((f) => f.mode === 'server').length, 2, 'the seed really finished both server-run fields');
  assert.deepEqual(aHeld, [], 'with the release: no finished field holds a battle');
  assert.equal(bHeld.length, 2, 'without the release: both finished fields still hold their battle');
  assert.deepEqual(sa, sb, 'the release changes no field value');
});

test('_collectSimErrors catalogs the records of a released battle (and still reads a live one)', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 0, clientCombat: true, clients: false, seed: 9 });
  const m = h.m;
  try {
    // a released field: `f.battle` is gone, the records were kept beside the result
    m._collectSimErrors({ cc: true, battle: null, battleErrors: [{ label: 'kit', who: 'u7', message: 'boom', stack: 'at x' }] }, { errors: 1 });
    assert.equal(m.simErrors, 1);
    assert.equal(m.simErrorLog.size, 1);
    assert.deepEqual([...m.simErrorLog.values()][0], { label: 'kit', who: 'u7', message: 'boom', stack: 'at x', battles: 1, count: 1 });

    // the legacy shape (a battle still on the field, nothing kept beside it) keeps working
    m._collectSimErrors({ cc: true, battle: { errors: [{ label: 'sim', who: '', message: 'oof' }] } }, { errors: 2 });
    assert.equal(m.simErrors, 3);
    assert.equal(m.simErrorLog.size, 2);
    assert.equal([...m.simErrorLog.values()][1].message, 'oof');

    // no records anywhere: an empty catalog, never a throw
    m._collectSimErrors({ cc: true, battle: null }, { errors: 0 });
    assert.equal(m.simErrors, 3);
    assert.equal(m.simErrorLog.size, 2);
  } finally {
    m.dispose();
    h.clients?.closeAll();
  }
});
