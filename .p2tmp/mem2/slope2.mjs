// Marginal per-match cost (P2 work): build+drive batch 1, snapshot after --expose-gc + two major GCs, build+drive
// batch 2 of the same kind, take the slope. The second batch pays no one-time module/hidden-class/string-table cost.
//   node --expose-gc .p2tmp/mem2/slope2.mjs <variant> [N1] [N2]
//   A<n> / B<n>   n humans 2, <n=round>: COMBAT R<n> +10 s   (A = 0 bots, B = 2 bots)   [the MEMREPORT metric]
//   P<n>          2 humans + 2 bots, PREP R<n>
//   Q<n>          2 humans + 2 bots, COMBAT R<n> stopped at the first moment one field is done and another live
//   S<n>          2 humans + 2 bots, COMBAT R<n> stopped the instant EVERY field is done (combat finishes here)
//   U<n>          0 humans + 4 bots, COMBAT R<n> +10 s
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, diff, line, mb } from '../mem/snap.mjs';

const which = (process.argv[2] || 'B1').toUpperCase();
const N1 = Number(process.argv[3]) || 12;
const N2 = Number(process.argv[4]) || 12;

const m = /^([ABPQSU])(\d+)$/.exec(which);
if (!m) throw new Error(`unknown variant ${which}`);
const kind = m[1];
const round = Number(m[2]);
const base = { mode: 'coop', difficulty: 'NORMAL', clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };
const cfg = kind === 'U'
  ? { ...base, humans: 0, bots: 4, seed0: 7300 }
  : { ...base, humans: 2, bots: kind === 'A' ? 0 : 2 };

function drive(h, pred, maxSteps = 4e7) {
  if (!h._started) { h._started = true; h.m.start(); }
  for (let i = 0; i < maxSteps; i++) {
    h.sent.length = 0; h.bc.length = 0;
    if (h.clients) for (const c of h.clients.values()) { c.log.length = 0; c.starts.length = 0; c.ends.length = 0; c.pools.length = 0; }
    if (pred()) return true;
    if (!h.sched.runNext()) return !!pred();
  }
  return !!pred();
}

/** Drop what exists only because a browser is stood up inside this process (the real client's battle is elsewhere). */
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
  const inCombat = () => h.m.ended || (h.m.phase === PHASE.COMBAT && h.m.round >= round);
  if (kind === 'P') {
    drive(h, () => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= round));
  } else if (kind === 'A' || kind === 'B' || kind === 'U') {
    drive(h, inCombat);
    h.sched.advance(10_000);
  } else if (kind === 'Q') {
    drive(h, inCombat);
    drive(h, () => h.m.ended || (h.m.fields.length > 0 && h.m.fields.some((f) => f.done) && h.m.fields.some((f) => !f.done && f.live)));
  } else {
    // S: the instant the last field is done (phase is still COMBAT; _finishCombat has just run)
    drive(h, inCombat);
    drive(h, () => h.m.ended || (h.m.fields.some((f) => f.cc) && h.m.fields.every((f) => f.done)));
  }
  stripClients(h);
  return h;
}

const mk = (n, tag) => Array.from({ length: n }, (_, i) => {
  const h = makeMatch({ ...cfg, seed: cfg.seed0 + tag * 10000 + i, captureFrames: false });
  h.autoHumans();
  return h;
});

const b1 = mk(N1, 1);
for (const h of b1) stage(h);
const s1 = await pinned();
const b2 = mk(N2, 2);
for (const h of b2) stage(h);
const s2 = await pinned();
const d = diff(s1, s2);
const label = kind === 'P' ? `PREP R${round}` : kind === 'Q' ? `COMBAT R${round}, one field done` : kind === 'S' ? `COMBAT R${round}, all fields done` : `COMBAT R${round} +10 s`;
const state = b2.map((h) => {
  const fs = h.m.fields.map((f) => (f.cc ? (f.done ? 'd' : f.live ? 'L' : '-') : (f.done ? 'd' : 'L'))).join('');
  return `${h.m.phase}${h.m.round}[${fs}]`;
}).join(' ');
console.log(`=== ${which}: ${cfg.humans} humans + ${cfg.bots} bots, ${label} ===`);
console.log(`  per-match state: ${state}`);
console.log(`  per match: heap ${Math.round(d.heapUsed / N2)} B, rss ${Math.round(d.rss / N2)} B`);
console.log(line(`marginal cost of the last ${N2} (after ${N1})`, d, N2));
console.log(`  abs after ${N1 + N2}: heapUsed ${mb(s2.heapUsed)} heapTotal ${mb(s2.heapTotal)} external ${mb(s2.external)} rss ${mb(s2.rss)} MB`);
console.log(`RESULT ${which} ${(d.heapUsed / N2).toFixed(0)} B/match`);
