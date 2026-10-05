// Phase duty cycle on the virtual clock (one real 2H+2B match, no TestClients): how much of a match's life is spent
// in each phase, and how the round number distributes. Feeds the "average per-match cost" estimate.
//   node .p2tmp/mem/dwell.mjs
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';

const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed: 4100, captureFrames: false, clients: false });
h.m.start();
const t0 = h.sched.now();
const dwell = new Map();
const perRound = new Map();
let last = h.m.phase;
let lastT = t0;
for (let i = 0; i < 6e6; i++) {
  h.sent.length = 0; h.bc.length = 0;
  if (h.m.ended) break;
  if (!h.sched.runNext()) break;
  if (h.m.phase !== last) {
    const dt = h.sched.now() - lastT;
    dwell.set(last, (dwell.get(last) || 0) + dt);
    perRound.set(last, (perRound.get(last) || 0) + dt);
    last = h.m.phase;
    lastT = h.sched.now();
  }
}
const total = [...dwell.values()].reduce((a, b) => a + b, 0);
console.log(`match ended=${!!h.m.ended} after ${(h.sched.now() - t0) / 1000} s virtual`);
console.log('phase dwell (s / % of the match):');
for (const [p, ms] of [...dwell].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(p).padEnd(14)} ${String(Math.round(ms / 1000)).padStart(5)} s  ${String(Math.round((ms / total) * 100)).padStart(3)}%`);
}
console.log(`total ${Math.round(total / 1000)} s virtual for ${h.m.round} rounds => ${Math.round(total / 1000 / Math.max(1, h.m.round))} s/round`);
const stats = h.m.players.size;
console.log(`seats ${stats}, ended rounds ${h.m.round}`);
void PHASE;
