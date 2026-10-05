// Group ablation with a large signal: build+drive N1 (warm-up, discarded), build N2, snapshot, drive N2, snapshot
// (=> the "driving" cost per match), then null one group at a time across the N2 batch and measure each drop.
//   node --expose-gc .p2tmp/mem/bisect.mjs R|B|A [N2]
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, mb } from './snap.mjs';

const whichArg = (process.argv[2] || 'R').toUpperCase();
const N2 = Number(process.argv[3]) || 16;
const dep = /^P(\d+)$/.exec(whichArg); // P13 = PREP round 13, 2 humans, 0 bots
const which = dep ? 'D' : whichArg;
const ROUND = dep ? Number(dep[1]) : 0;
const A = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };
const B = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };
const cfg = which === 'A' ? A : B;

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
function strip(h) {
  h.sent.length = 0; h.bc.length = 0;
  if (!h.clients) return;
  for (const c of h.clients.values()) {
    c.log.length = 0; c.starts.length = 0; c.ends.length = 0; c.pools.length = 0;
    for (const e of c.battles.values()) { e.battle = null; e.meter = null; e.spec = null; }
    c.battles.clear();
  }
}
function stage(h) {
  if (which === 'D') { drive(h, () => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= ROUND)); }
  else if (which === 'R') { drive(h, () => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= 7)); }
  else { drive(h, () => h.m.phase === PHASE.COMBAT); h.sched.advance(10_000); }
  strip(h);
}
const mk = (n, tag) => Array.from({ length: n }, (_, i) => {
  const h = makeMatch({ ...cfg, seed: cfg.seed0 + tag * 1000 + i, captureFrames: false });
  h.autoHumans();
  return h;
});

const warm = mk(6, 1);
for (const h of warm) stage(h);
const warmKeep = warm; // stays alive so the warm-up batch keeps paying its steady share

const b = mk(N2, 2);
const sIdle = await pinned();
for (const h of b) stage(h);
const sDriven = await pinned();
console.log(`=== variant ${which}: ${N2} matches, state ${b.map((h) => `${h.m.phase}${h.m.round}`).join(',')} ===`);
console.log(`DRIVING cost per match: ${Math.round((sDriven.heapUsed - sIdle.heapUsed) / N2)} B heap  (abs heapUsed ${mb(sDriven.heapUsed)} MB, heapTotal ${mb(sDriven.heapTotal)}, rss ${mb(sDriven.rss)} MB)`);
console.log(`  (idle built match costs ${Math.round((sIdle.heapUsed - (await pinned()).heapUsed) / N2)} B/match — see below)`);

const STEPS = [
  ['fields: battle/job/timeline/spec/result/progress', (h) => {
    for (const f of h.m.fields) { f.battle = null; f.job = null; f.timeline = null; f.spec = null; f.result = null; f.progress = null; f.sliceStep = null; }
  }],
  ['retained view JSON: m._lastPubJson, ps._lastPriv', (h) => {
    h.m._lastPubJson = ''; for (const ps of h.m.players.values()) ps._lastPriv = '';
  }],
  ['m.lastResults.clear()', (h) => { h.m.lastResults.clear(); }],
  ['ps.board/hand/temp/shop/offers/bounties/bonds/stats/unitStats/_deployMap', (h) => {
    for (const ps of h.m.players.values()) {
      ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
      ps.shop = null; ps.offers = null; ps.bounties = null; ps.bonds = null; ps.stats = null; ps.unitStats = null;
      ps._deployMap = null; ps.pendingLayerGains = null;
    }
  }],
  ['m.draft/sp/wave/bossWaves/unitePlan/registry/dispatcher/errors/watchers', (h) => {
    h.m.draft = null; h.m.sp = null; h.m.wave = null; h.m.bossWaves = null; h.m.unitePlan = null;
    h.m.registry = null; h.m.dispatcher = null; h.m.errors = null; h.m.simErrorLog = null; h.m.watchers.clear();
  }],
  ['m.pool + m.gd (GameData + SharedPool)', (h) => { h.m.pool = null; h.m.gd = null; }],
  ['PlayerState objects (m.players.clear, m.order=[])', (h) => { h.m.players.clear(); h.m.order = []; }],
  ['m.fields (drop the field records)', (h) => { h.m.fields.length = 0; }],
  ['scheduler + harness (h.sched/h.clients)', (h) => { h.sched.dispose(); h.clients = null; }],
  ['the Match object itself (h.m = null)', (h) => { h.m = null; }],
];

let prev = sDriven;
for (const [name, fn] of STEPS) {
  for (const h of b) fn(h);
  const s = await pinned();
  console.log(`  frees ${String(Math.round((prev.heapUsed - s.heapUsed) / N2)).padStart(8)} B/match  <- ${name}`);
  prev = s;
}
const end = prev;
const accounted = STEPS.length ? (sDriven.heapUsed - end.heapUsed) / N2 : 0;
console.log(`accounted ${Math.round(accounted)} B/match of the ${Math.round((sDriven.heapUsed - sIdle.heapUsed) / N2)} B/match driving cost`);
console.log(`heapUsed now ${mb(end.heapUsed)} MB, heapTotal ${mb(end.heapTotal)} MB, rss ${mb(end.rss)} MB (rss gave back ${mb(sDriven.rss - end.rss)} of ${mb(sDriven.rss - sIdle.rss)} MB)`);
void warmKeep;
