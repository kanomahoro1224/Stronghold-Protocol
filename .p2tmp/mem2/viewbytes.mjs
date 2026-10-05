// Byte split of the retained view-JSON diff baselines (m._lastPubJson vs one ps._lastPriv per connected human seat), at
// the exact measurement points of the memory battery.
//   node --expose-gc .p2tmp/mem2/viewbytes.mjs
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';

function drive(h, pred, maxSteps = 4e7) {
  if (!h._started) { h._started = true; h.m.start(); }
  for (let i = 0; i < maxSteps; i++) {
    h.sent.length = 0; h.bc.length = 0;
    if (h.clients) for (const c of h.clients.values()) { c.log.length = 0; c.starts.length = 0; c.ends.length = 0; c.pools.length = 0; }
    if (pred(h)) return true;
    if (!h.sched.runNext()) return !!pred(h);
  }
  return !!pred(h);
}

const CFG = { mode: 'coop', difficulty: 'NORMAL', clientCombat: true, pace: 'paced', headlessSliceMs: 8 };
const combat = (r) => (h) => h.m.ended || (h.m.phase === PHASE.COMBAT && h.m.round >= r);
const prep = (r) => (h) => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= r);

function at(label, bots, reach, then = null) {
  let pub = 0, priv = 0, seats = 0, n = 0;
  for (let i = 0; i < 8; i++) {
    const h = makeMatch({ ...CFG, humans: 2, bots, seed: 4100 + i, captureFrames: false });
    h.autoHumans();
    drive(h, reach);
    if (then) then(h);
    const m = h.m;
    pub += (m._lastPubJson || '').length;
    for (const ps of m.players.values()) { if (ps.isBot || ps.left || !ps.connected) continue; seats++; priv += (ps._lastPriv || '').length; }
    n++;
    m.dispose();
    if (h.clients) h.clients.closeAll();
  }
  const kb = (x) => (x / n / 1024).toFixed(1);
  console.log(`  ${label.padEnd(30)} _lastPubJson ${kb(pub).padStart(6)} KB   _lastPriv (${(seats / n).toFixed(1)} seats) ${kb(priv).padStart(6)} KB   total ${((pub + priv) / n / 1024).toFixed(1)} KB`);
}

const plus10 = (h) => h.sched.advance(10_000);
console.log('retained view JSON per match (last-sent strings still pinned on the match):');
at('2h+0b COMBAT R1 +10 s', 0, combat(1), plus10);
at('2h+2b COMBAT R1 +10 s', 2, combat(1), plus10);
at('2h+0b COMBAT R7 +10 s', 0, combat(7), plus10);
at('2h+2b COMBAT R7 +10 s', 2, combat(7), plus10);
at('2h+0b COMBAT R13 +10 s', 0, combat(13), plus10);
at('2h+2b COMBAT R13 +10 s', 2, combat(13), plus10);
at('2h+2b PREP R7', 2, prep(7));
at('2h+2b PREP R13', 2, prep(13));
