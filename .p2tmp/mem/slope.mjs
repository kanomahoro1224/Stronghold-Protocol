// Marginal per-match cost: build + drive N1 matches, snapshot, then build + drive N2 MORE of the same kind and take
// the slope. The second batch pays no one-time module/shape bookkeeping, so the slope is the honest per-match number.
//   node --expose-gc .p2tmp/mem/slope.mjs <variant> [N1] [N2]
//   A        2 humans + 0 bots, COMBAT R1 +10 s, server-side
//   B        2 humans + 2 bots, COMBAT R1 +10 s, server-side
//   C        0 humans + 4 bots, COMBAT R1 +10 s
//   P        2 humans + 2 bots, COMBAT R1 +10 s then IDLE-PAUSED
//   R        2 humans + 2 bots, PREP R7
//   D<n>     2 humans + 0 bots, PREP round n         (base cost vs round depth)
//   DB<n>    2 humans + 2 bots, PREP round n
//   DC<n>    2 humans + 2 bots, COMBAT round n +10 s (server-side peak)
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, diff, line, mb } from './snap.mjs';

const which = (process.argv[2] || 'A').toUpperCase();
const N1 = Number(process.argv[3]) || 12;
const N2 = Number(process.argv[4]) || 12;
const base = { mode: 'coop', difficulty: 'NORMAL', clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };
const depth = /^(DE|D|DB|DC)(\d+)$/.exec(which);
let cfg; let round = 0; let combat = false; let mixed = false;
const mixm = /^X([02])$/.exec(which); // X0 / X2 = no SimClients at all, stopped at a random point in the match
if (mixm) {
  mixed = true;
  cfg = { ...base, humans: 2, bots: Number(mixm[1]), clients: false, headlessSliceMs: 8 };
} else if (depth) {
  round = Number(depth[2]);
  combat = depth[1] === 'DC' || depth[1] === 'DE';
  cfg = { ...base, humans: 2, bots: (depth[1] === 'D' || depth[1] === 'DE') ? 0 : 2 };
} else {
  cfg = {
    A: { ...base, humans: 2, bots: 0 },
    B: { ...base, humans: 2, bots: 2 },
    C: { ...base, humans: 0, bots: 4, seed0: 7300 },
    P: { ...base, humans: 2, bots: 2 },
    R: { ...base, humans: 2, bots: 2 },
  }[which];
}
if (!cfg) throw new Error(`unknown variant ${which}`);

function drive(h, pred, maxSteps = 2e7) {
  if (!h._started) { h._started = true; h.m.start(); }
  for (let i = 0; i < maxSteps; i++) {
    h.sent.length = 0; h.bc.length = 0;
    if (h.clients) for (const c of h.clients.values()) { c.log.length = 0; c.starts.length = 0; c.ends.length = 0; c.pools.length = 0; }
    if (pred()) return true;
    if (!h.sched.runNext()) return !!pred();
  }
  return !!pred();
}
function stripClients(h) {
  h.sent.length = 0; h.bc.length = 0;
  if (!h.clients) return;
  for (const c of h.clients.values()) {
    c.log.length = 0; c.starts.length = 0; c.ends.length = 0; c.pools.length = 0;
    for (const e of c.battles.values()) { e.battle = null; e.meter = null; e.spec = null; }
    c.battles.clear();
  }
}
function stage(h) {
  if (mixed) {
    const target = 30_000 + Math.random() * 870_000; // uniform over 30 s .. 15 min of match clock
    drive(h, () => h.m.ended || h.sched.now() - h._t0 >= target);
    stripClients(h);
    return h;
  }
  if (round > 0 && !combat) drive(h, () => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= round));
  else if (round > 0 && combat) { drive(h, () => h.m.ended || (h.m.phase === PHASE.COMBAT && h.m.round >= round)); h.sched.advance(10_000); }
  else { drive(h, () => h.m.phase === PHASE.COMBAT); h.sched.advance(10_000); }
  stripClients(h);
  if (which === 'P') h.m._freeze();
  return h;
}
const mk = (n, tag) => Array.from({ length: n }, (_, i) => {
  const h = makeMatch({ ...cfg, seed: cfg.seed0 + tag * 10000 + i, captureFrames: false });
  h.autoHumans();
  h._t0 = h.sched.now();
  return h;
});

const b1 = mk(N1, 1);
for (const h of b1) stage(h);
const s1 = await pinned();
const b2 = mk(N2, 2);
for (const h of b2) stage(h);
const s2 = await pinned();
const d = diff(s1, s2);
const label = depth
  ? (combat ? `COMBAT R${round} +10 s` : `PREP R${round}`)
  : ({ P: 'COMBAT R1 +10 s then IDLE-PAUSED', R: 'PREP R7' }[which] || 'COMBAT R1 +10 s');
console.log(`=== variant ${which}: ${cfg.humans} humans + ${cfg.bots} bots, ${label} (rounds reached ${b2.map((h) => `${h.m.phase}${h.m.round}`).join(',')}) ===`);
line(`marginal cost of the last ${N2} matches (after ${N1})`, d, N2);
console.log(`  abs after ${N1 + N2}: heapUsed ${mb(s2.heapUsed)} heapTotal ${mb(s2.heapTotal)} external ${mb(s2.external)} rss ${mb(s2.rss)} MB`);
console.log(`  per match: heap ${Math.round(d.heapUsed / N2)} B, rss ${Math.round(d.rss / N2)} B  =>  ${mb((d.heapUsed / N2) * 100)} MB heap / 100 matches`);
