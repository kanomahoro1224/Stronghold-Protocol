// Per-key ablation: null one own-property at a time and record how much heap it uniquely holds.
//   node --expose-gc .p2tmp/mem/keys.mjs [PREP7|COMBAT] [N]
// Order-dependent (cumulative): a value shared by two holders is credited to whichever is nulled first.
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, mb } from './snap.mjs';

const mode = (process.argv[2] || 'COMBAT').toUpperCase();
const N = Number(process.argv[3]) || 4;
const cfg = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };

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

const batch = Array.from({ length: N }, (_, i) => {
  const h = makeMatch({ ...cfg, seed: cfg.seed0 + i, captureFrames: false });
  h.autoHumans();
  return h;
});
for (const h of batch) {
  if (mode === 'PREP7') drive(h, () => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= 7));
  else { drive(h, () => h.m.phase === PHASE.COMBAT); h.sched.advance(10_000); }
  h.sent.length = 0; h.bc.length = 0;
  for (const c of h.clients.values()) { c.log.length = 0; for (const e of c.battles.values()) { e.battle = null; e.meter = null; e.spec = null; } c.battles.clear(); }
}
console.log(`mode=${mode} N=${N} state=${batch.map((h) => `${h.m.phase}${h.m.round}`).join(',')}`);

let prev = await pinned();
const s0 = prev;

/** Targets in a fixed order: fields first, then players, then the match shell. */
const targets = [];
for (const h of batch) {
  for (const f of h.m.fields) targets.push([`${h.m.seed}:field:${f.fieldId}`, f]);
  for (const ps of h.m.players.values()) targets.push([`${h.m.seed}:ps:${ps.playerId}`, ps]);
  targets.push([`${h.m.seed}:match`, h.m]);
}
const drops = [];
for (const [path, obj] of targets) {
  for (const k of Object.getOwnPropertyNames(obj)) {
    let v;
    try { v = obj[k]; } catch { continue; }
    if (v == null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'function') continue;
    try { obj[k] = null; } catch { continue; }
    const s = await pinned();
    const freed = prev.heapUsed - s.heapUsed;
    prev = s;
    if (freed > 200) drops.push([freed / N, `${path}.${k}`]);
  }
}
drops.sort((a, b) => b[0] - a[0]);
const total = drops.reduce((a, b) => a + b[0], 0);
console.log(`\nfreed per match by key (top 30 of ${drops.length}), total attributed ${Math.round(total)} B/match:`);
for (const [b, p] of drops.slice(0, 30)) console.log(`  ${String(Math.round(b)).padStart(8)} B/match  ${p}`);
const final = await pinned();
console.log(`\nheapUsed: start ${mb(s0.heapUsed)} -> end ${mb(final.heapUsed)} MB; total freed ${Math.round((s0.heapUsed - final.heapUsed) / N)} B/match; rss ${mb(s0.rss)} -> ${mb(final.rss)} MB (gave back ${mb(s0.rss - final.rss)})`);
