// RSS behaviour at scale: does V8 hand the pages back, and what is the RSS slope per 100 matches?
//   node --expose-gc .p2tmp/mem/rss.mjs
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, mb } from './snap.mjs';

function drive(h, pred, maxSteps = 6e6) {
  if (!h._started) { h._started = true; h.m.start(); }
  for (let i = 0; i < maxSteps; i++) {
    h.sent.length = 0;
    h.bc.length = 0;
    if (pred()) return true;
    if (!h.sched.runNext()) return !!pred();
  }
  return !!pred();
}

const base = await pinned();
console.log(`process baseline: heapUsed ${mb(base.heapUsed)} heapTotal ${mb(base.heapTotal)} rss ${mb(base.rss)} MB`);

const rows = [];
const keep = [];
const STEP = 5;
const CFG = { mode: 'coop', difficulty: 'NORMAL', humans: 0, bots: 4, clientCombat: true, pace: 'paced', headlessSliceMs: 8 };

console.log('\n--- build 4-bot matches in COMBAT R1, 5 at a time (no dispose) ---');
for (let round = 1; round <= 6; round++) {
  for (let i = 0; i < STEP; i++) {
    const h = makeMatch({ ...CFG, seed: 50000 + keep.length, captureFrames: false });
    h.autoHumans();
    keep.push(h);
  }
  for (let i = keep.length - STEP; i < keep.length; i++) { drive(keep[i], () => keep[i].m.phase === PHASE.COMBAT); keep[i].sched.advance(10_000); }
  const s = await pinned();
  rows.push({ n: keep.length, heapUsed: s.heapUsed, heapTotal: s.heapTotal, rss: s.rss, external: s.external });
  const prev = rows[rows.length - 2];
  const slope = prev ? `  Δ/5 matches: heapUsed ${mb(s.heapUsed - prev.heapUsed)} heapTotal ${mb(s.heapTotal - prev.heapTotal)} rss ${mb(s.rss - prev.rss)} MB` : '';
  console.log(`${String(keep.length).padStart(3)} matches: heapUsed ${String(mb(s.heapUsed)).padStart(7)} heapTotal ${String(mb(s.heapTotal)).padStart(7)} rss ${String(mb(s.rss)).padStart(7)} MB${slope}`);
}
{
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const per = (a, b) => ((b - a) / STEP);
  console.log(`\nsteady slope (last 5): heapUsed ${Math.round(per(prev.heapUsed, last.heapUsed))} B/match, `
    + `rss ${Math.round(per(prev.rss, last.rss))} B/match  =>  rss ${mb(per(prev.rss, last.rss) * 100)} MB / 100 matches, `
    + `heap ${mb(per(prev.heapUsed, last.heapUsed) * 100)} MB / 100 matches`);
  console.log(`heapTotal:heapUsed ratio at ${last.n} matches = ${(last.heapTotal / last.heapUsed).toFixed(2)}; rss:heapUsed = ${(last.rss / last.heapUsed).toFixed(2)}`);
}

console.log('\n--- now dispose every match and gc: do the pages come back? ---');
for (const h of keep) { try { h.m.dispose(); } catch { /* ignore */ } }
keep.length = 0;
const after = await pinned();
console.log(`after dispose: heapUsed ${mb(after.heapUsed)} heapTotal ${mb(after.heapTotal)} rss ${mb(after.rss)} external ${mb(after.external)} MB`);
console.log(`=> heapUsed released ${mb(rows[rows.length - 1].heapUsed - after.heapUsed)} MB but RSS only ${mb(rows[rows.length - 1].rss - after.rss)} MB`);
