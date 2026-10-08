// test/match/pause-headless-slice.test.js — P1b follow-up (DESIGN §27): a frozen match (idle suspension, or the
// owner's solo pause) must stop stepping the in-thread headless jobs of its server-run fields, and a resume must carry
// on exactly where the field clock says. The `later(0)` slice chain of Match._runOnServer used to re-arm itself while
// `this.paused` (≈1 ms of gap after every ≈8 ms slice, a ~90% duty cycle), so a suspended four-bot match simulated
// every bot / takeover battle to its end — the CPU the idle machinery exists to stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessJob, runHeadless } from '../../server/match/fields.js';
import { createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
import { makeMatch } from './harness.js';

/** The first live server-run field holding an unfinished in-thread job (the sliced `HeadlessJob`). */
const slicedField = (m) => m.fields.find((f) => f.cc && f.mode === 'server' && f.job && !f.poolJob && !f.done) || null;

/** A client-combat match driven to the moment a server-run field is mid-slice, counting every HeadlessJob.run call. */
function sliced(opts = {}) {
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, captureFrames: false, clientCombat: true,
    // a wall-clock slice budget keeps the server-run fields as sliced jobs even in virtual time (production default)
    headlessSliceMs: 0.05, ...opts,
  });
  h.autoHumans();
  const orig = HeadlessJob.prototype.run;
  let runs = 0;
  HeadlessJob.prototype.run = function countedRun(...a) { runs++; return orig.apply(this, a); };
  h.runs = () => runs;
  h.restore = () => { HeadlessJob.prototype.run = orig; };
  h.start();
  h.run(() => slicedField(h.m) != null || h.ended != null, { maxSteps: 5e6 });
  return h;
}

test('a frozen match takes zero steps of its in-thread headless jobs and arms nothing until the resume', () => {
  const h = sliced({ seed: 9701 });
  const m = h.m;
  try {
    const f = slicedField(m);
    assert.ok(f, `a server-run field is mid-slice (phase ${m.phase}, round ${m.round})`);
    assert.ok(f.sliceTimer, 'its slice chain is armed');
    assert.equal(m.paused, false);
    const before = h.runs();
    const ticks = f.job.n;

    m._freeze(); // the primitive behind the idle suspension (P1b) and behind setPause
    assert.equal(m.paused, true);
    assert.equal(f.sliceTimer, null, 'the pending slice is cancelled');
    assert.equal(f.rearmSlice, true, 'and the chain is remembered for the resume');

    m.sched.advance(30_000); // frozen virtual time: the old chain simulated this whole battle inside this call
    assert.equal(h.runs(), before, 'not one slice ran while frozen');
    assert.equal(f.job.n, ticks, 'not one tick was simulated while frozen');
    assert.equal(f.sliceTimer, null, 'nothing was re-armed while frozen');
    assert.ok(f.job && !f.done, 'the unfinished job is still parked, waiting for the resume');

    m._unfreeze();
    assert.equal(m.paused, false);
    assert.equal(f.rearmSlice, false);
    assert.ok(f.sliceTimer, 'the resume hands the same chain its next slice');
    h.run(() => f.done || h.ended != null, { maxSteps: 5e6 });
    assert.ok(f.done && f.result, 'the parked field finished after the resume');
    assert.ok(h.runs() > before, 'the job was stepped again');

    // the resumed field ran exactly the battle its spec describes: a one-shot server run of the same spec agrees
    const whole = runHeadless(createBattleFromSpec(f.spec, m.ds, { recordEvents: false, quiet: true }), { players: f.players });
    assert.equal(resultDigest(f.result).hash, resultDigest(whole.result).hash, 'paused + resumed = uninterrupted');
  } finally { h.restore(); m.dispose(); }
});

test('a field handed to the server while the match is already frozen arms no slice, and starts on the resume', () => {
  const h = sliced({ seed: 9702 });
  const m = h.m;
  try {
    const f = m.fields.find((x) => x.cc && x.mode === 'client' && !x.done && x.kind === 'normal');
    assert.ok(f, `the human's field is running (phase ${m.phase}, round ${m.round})`);
    m._freeze();
    const before = h.runs();
    h.m._runOnServer(f, 'test'); // a takeover while nobody is connected (or the owner paused a solo run)
    assert.equal(f.mode, 'server');
    assert.ok(f.job, 'the field is now stepped in this thread');
    assert.equal(f.sliceTimer, null, 'nothing is armed while frozen');
    assert.equal(f.rearmSlice, true, 'the chain waits for the resume');
    const ticks = f.job.n;
    m.sched.advance(10_000);
    assert.equal(h.runs(), before, 'zero slices while frozen');
    assert.equal(f.job.n, ticks, 'zero ticks while frozen');

    m._unfreeze();
    assert.ok(f.sliceTimer, 'the resume arms the first slice');
    h.run(() => f.done || h.ended != null, { maxSteps: 5e6 });
    assert.ok(f.done && f.result, 'the takeover field finished');
    assert.ok(h.runs() > before, 'the slice chain carried on');
  } finally { h.restore(); m.dispose(); }
});
