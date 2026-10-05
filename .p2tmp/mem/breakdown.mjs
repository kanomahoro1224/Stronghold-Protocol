// Object-graph breakdown: what a live match actually retains, layer by layer.
//   node --expose-gc .p2tmp/mem/breakdown.mjs
import { performance } from 'node:perf_hooks';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, diff, mb } from './snap.mjs';

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
function stripClients(h) {
  h.sent.length = 0; h.bc.length = 0;
  if (!h.clients) return;
  for (const c of h.clients.values()) {
    c.log.length = 0;
    for (const e of c.battles.values()) { e.battle = null; e.meter = null; e.spec = null; }
    c.battles.clear();
  }
}
const build = (cfg, N) => Array.from({ length: N }, (_, i) => {
  const h = makeMatch({ ...cfg, seed: cfg.seed0 + i, captureFrames: false });
  h.autoHumans();
  return h;
});

const LAYERS = [
  ['1. field payloads (bot battles + HeadlessJobs + timelines + result + spec)', (h) => {
    for (const f of h.m.fields) { f.battle = null; f.job = null; f.timeline = null; f.spec = null; f.result = null; f.progress = null; f.sliceStep = null; }
  }],
  ['2. retained view JSON strings (_lastPubJson / _lastPriv) + lastResults', (h) => {
    h.m._lastPubJson = ''; h.m._lastPubJsonPlayers = null; h.m._lastPubX = null;
    for (const ps of h.m.players.values()) { ps._lastPriv = ''; }
    h.m.lastResults.clear();
  }],
  ['3. player boards / hands / temp / shops / deploy caches', (h) => {
    for (const ps of h.m.players.values()) {
      ps.board.clear();
      ps.hand.fill(null);
      ps.temp.fill(null);
      if (ps.shop) { ps.shop.slots = null; ps.shop.offers = null; }
      ps._deployMap = null; ps._deployMapKey = null; ps._deployMapDevice = null;
      ps.shopOffers = null; ps._shopOffers = null;
    }
  }],
  ['4. draft / sp / wave / stage / misc match bookkeeping', (h) => {
    h.m.draft = null; h.m.sp = null; h.m.wave = null; h.m.bossWaves = null; h.m.unitePlan = null;
    h.m.pool = null; h.m.gd = null;
  }],
];

async function analyse(label, cfg, N, driveFn) {
  console.log(`\n===== ${label} (${cfg.humans ?? 0} humans + ${cfg.bots ?? 0} bots, N=${N}) =====`);
  const batch = build(cfg, N);
  const s0 = await pinned();
  const t = performance.now();
  for (const h of batch) { driveFn(h); stripClients(h); }
  const sTotal = await pinned();
  const per = (a, b) => Math.round((b.heapUsed - a.heapUsed) / N);
  console.log(`  TOTAL retained per match           ${String(per(s0, sTotal)).padStart(8)} B  (${mb(per(s0, sTotal))} MB/100 matches)`);
  let prev = sTotal;
  for (const [name, fn] of LAYERS) {
    for (const h of batch) fn(h);
    const s = await pinned();
    console.log(`  - ${name.padEnd(62)} ${String(per(prev, s)).padStart(8)} B`);
    prev = s;
  }
  console.log(`  = leftover (match record + GameData + pool + maps)  ${String(per(s0, prev)).padStart(8)} B`);
  console.log(`  (drove ${N} matches in ${((performance.now() - t) / 1000).toFixed(1)} s)`);
  for (const h of batch) { try { h.m.dispose(); } catch { /* ignore */ } }
  return { s0, sTotal };
}

const mid = (h) => { drive(h, () => h.m.phase === PHASE.COMBAT); h.sched.advance(10_000); };
const prep = (round) => (h) => { drive(h, () => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= round)); };

await analyse('A. COMBAT R1 +10 s (peak state)', { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 }, 12, mid);
await analyse('B. COMBAT R1 +10 s, NO bots (the common live shape)', { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 5100 }, 12, mid);
await analyse('C. PREP R7 (deep, no battle running)', { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 6100 }, 12, prep(7));
await analyse('D. COMBAT R1 +10 s, 4 bots', { mode: 'coop', difficulty: 'NORMAL', humans: 0, bots: 4, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 7300 }, 12, mid);
