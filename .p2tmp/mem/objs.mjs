// Which object shapes do the matches actually hold? Diff the plain-object signature histogram with and without them.
//   node --expose-gc .p2tmp/mem/objs.mjs
import v8 from 'node:v8';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, mb } from './snap.mjs';

const W = process.emitWarning; process.emitWarning = () => {}; // silence the queryObjects experimental warning

function drive(h, pred, maxSteps = 8e6) {
  if (!h._started) { h._started = true; h.m.start(); }
  for (let i = 0; i < maxSteps; i++) {
    h.sent.length = 0; h.bc.length = 0;
    if (h.clients) for (const c of h.clients.values()) { c.log.length = 0; c.starts.length = 0; c.ends.length = 0; c.pools.length = 0; }
    if (pred()) return true;
    if (!h.sched.runNext()) return !!pred();
  }
  return !!pred();
}
function hist() {
  const objs = v8.queryObjects(Object);
  const m = new Map();
  for (const o of objs) {
    let sig;
    try { sig = Object.keys(o).sort().slice(0, 14).join(','); } catch { sig = '?'; }
    m.set(sig, (m.get(sig) || 0) + 1);
  }
  return m;
}

const N = Number(process.argv[2]) || 6;
const cfg = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };

const before = { ...(await pinned()) };
const h0 = hist();
console.log(`bare (module state + data): heapUsed ${mb(before.heapUsed)} MB, plain objects ${[...h0.values()].reduce((a, b) => a + b, 0)}`);

const batch = Array.from({ length: N }, (_, i) => {
  const h = makeMatch({ ...cfg, seed: cfg.seed0 + i, captureFrames: false });
  h.autoHumans();
  return h;
});
for (const h of batch) { drive(h, () => h.m.phase === PHASE.COMBAT); h.sched.advance(10_000); }
for (const h of batch) {
  h.sent.length = 0; h.bc.length = 0;
  for (const c of h.clients.values()) { c.log.length = 0; for (const e of c.battles.values()) { e.battle = null; e.meter = null; e.spec = null; } c.battles.clear(); }
}
const withM = await pinned();
const h1 = hist();
console.log(`with ${N} matches in COMBAT R1 +10 s: heapUsed ${mb(withM.heapUsed)} MB (+${Math.round((withM.heapUsed - before.heapUsed) / N)} B/match)`);

const delta = [];
for (const [sig, n] of h1) {
  const d = n - (h0.get(sig) || 0);
  if (d > 0) delta.push([d, sig]);
}
delta.sort((a, b) => b[0] - a[0]);
console.log(`\ntop plain-object families created by ${N} matches (count, per match, keys):`);
for (const [d, sig] of delta.slice(0, 25)) {
  console.log(`  ${String(d).padStart(7)}  ${String(Math.round(d / N)).padStart(7)}/match  {${sig.slice(0, 150)}}`);
}
console.log(`\ntotal plain-object delta: ${delta.reduce((a, b) => a + b[0], 0)} (${Math.round(delta.reduce((a, b) => a + b[0], 0) / N)}/match)`);

// sample one of the biggest families so the shape is visible
const big = delta[0];
if (big) {
  const keys = big[1].split(',');
  const objs = v8.queryObjects(Object).filter((o) => { try { return Object.keys(o).sort().slice(0, 14).join(',') === big[1]; } catch { return false; } });
  console.log(`\nsample of largest family (${keys.join(',')}):`);
  console.log(JSON.stringify(objs[0]).slice(0, 600));
  console.log(JSON.stringify(objs[1]).slice(0, 600));
}
