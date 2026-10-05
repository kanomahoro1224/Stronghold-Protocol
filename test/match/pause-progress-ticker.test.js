// test/match/pause-progress-ticker.test.js — task B: `Match._armProgressTicker` is the only thing a frozen match still
// schedules (1 Hz `markPublic()` for its parked server-run fields), and 157 matches are paused in production. The tick
// must do nothing at all while the match is paused, and the resume (`_unfreeze`) must hand the chain its next tick
// exactly once.
//
// The engine's only 1000 ms `later` timer is this ticker, so the tests count those registrations (`armed`) and, to
// attribute `markPublic` calls, wrap every one of them in a flag: `tickPubs` counts only the calls made from inside a
// progress tick. A frozen match still processes incoming `b.progress` / `b.result` from a client (a browser keeps
// simulating its own battle while the server is paused), and that marks the public view dirty too — those are not the
// ticker and must not be confused with it. The ticker exists only on a non-instant scheduler (`sched.instant` is false
// in production's RealScheduler), hence `instant: false` here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';

/** A match driven to the moment the 1 Hz progress ticker is armed, with spies on that ticker and on markPublic. */
function tickerMatch(seed) {
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed, captureFrames: false,
    clientCombat: true, instant: false, headlessSliceMs: 0.05,
  });
  h.autoHumans();
  const m = h.m;
  const armed = []; // every 1000 ms `later` of this match = one progress tick
  let inTick = false;
  const origLater = m.later.bind(m);
  m.later = (ms, fn) => {
    if (ms !== 1000) return origLater(ms, fn);
    const handle = origLater(1000, () => { inTick = true; try { fn(); } finally { inTick = false; } });
    armed.push(handle);
    return handle;
  };
  let pubs = 0;
  let tickPubs = 0;
  const origMark = m.markPublic.bind(m);
  m.markPublic = () => { pubs++; if (inTick) tickPubs++; origMark(); };
  h.armed = armed;
  h.pubCount = () => pubs;
  h.tickPubCount = () => tickPubs;
  h.start();
  h.run(() => m._progressTimer != null || h.ended != null, { maxSteps: 5e6 });
  return h;
}

test('a frozen match runs no progress ticker at all, and the resume re-arms it exactly once', () => {
  const h = tickerMatch(9751);
  const m = h.m;
  try {
    assert.equal(m.sched.instant, false, 'the ticker only exists on a non-instant scheduler (production)');
    assert.ok(m._progressTimer, `the ticker is armed (phase ${m.phase} R${m.round}, ended ${!!h.ended})`);
    assert.equal(m.paused, false);
    assert.ok(m.fields.some((f) => f.cc && f.mode === 'server' && !f.done && f.timeline), 'a server-run field with a timeline is live');
    const armedBefore = h.armed.length;
    const tickPubsBefore = h.tickPubCount();

    m._freeze(); // the primitive behind both the owner's solo pause and the idle suspension
    assert.equal(m.paused, true);
    const slices = m.fields.filter((f) => f.sliceTimer === null).length;

    h.sched.advance(5000); // five tick intervals of frozen time: the old ticker fired five times in here
    assert.equal(h.armed.length, armedBefore, 'not one progress tick was re-armed while frozen');
    assert.equal(m._progressTimer, null, 'and none is pending');
    assert.equal(h.tickPubCount(), tickPubsBefore, 'no progress tick ran at all while frozen');
    assert.equal(m._progressWanted, true, 'the chain is parked, waiting for the resume');
    assert.equal(m.fields.filter((f) => f.sliceTimer === null).length, slices, 'no field chain started either');

    m._unfreeze();
    assert.equal(m.paused, false);
    assert.equal(m._progressWanted, false);
    assert.ok(m._progressTimer, 'the resume arms the next tick');
    assert.equal(h.armed.length, armedBefore + 1, 'exactly one progress tick was armed, not two');

    // and the resumed chain lives on: the next unfrozen second marks the public view from inside a tick, and re-arms
    const tickPubsAtResume = h.tickPubCount();
    h.sched.advance(1000);
    assert.ok(h.tickPubCount() > tickPubsAtResume, 'the ticker runs again after the resume');
    assert.ok(h.armed.length >= armedBefore + 2, 'and hands itself the following tick');
  } finally { m.dispose(); if (h.clients) h.clients.closeAll(); }
});

test('arming the ticker while the match is frozen schedules nothing and leaves the chain parked', () => {
  const h = tickerMatch(9752);
  const m = h.m;
  try {
    const f = m.fields.find((x) => x.cc && x.mode === 'client' && !x.done && x.kind === 'normal');
    assert.ok(f, `the human's field is still the authority (phase ${m.phase} R${m.round})`);
    m._freeze();
    h.sched.advance(1000); // the tick pending at the freeze fires and parks the chain (timer null, wanted true)
    assert.equal(m._progressTimer, null);
    assert.equal(m._progressWanted, true);
    // the state a chain that ended on its own leaves behind (nothing armed, nothing parked) — then a field is handed
    // to the server while the match is still frozen: `_runOnServer` arms the ticker from the field side.
    m._progressWanted = false;
    const armedBefore = h.armed.length;
    const tickPubsBefore = h.tickPubCount();
    m._runOnServer(f, 'test');
    assert.equal(f.mode, 'server');
    assert.equal(m._progressTimer, null, 'nothing is armed while frozen');
    assert.equal(m._progressWanted, true, 'the chain is parked for the resume instead');
    assert.equal(h.armed.length, armedBefore, 'no 1 s timer was created');
    m.sched.advance(10_000);
    assert.equal(h.armed.length, armedBefore, 'still nothing after ten frozen seconds');
    assert.equal(h.tickPubCount(), tickPubsBefore, 'and no tick ran');

    m._unfreeze();
    assert.equal(m._progressWanted, false);
    assert.ok(m._progressTimer, 'the resume arms the parked chain');
    assert.equal(h.armed.length, armedBefore + 1, 'exactly once');
  } finally { m.dispose(); if (h.clients) h.clients.closeAll(); }
});
