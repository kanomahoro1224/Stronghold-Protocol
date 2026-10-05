// Ablation: null one group at a time and measure what each group actually retains.
//   node --expose-gc .p2tmp/mem/ablate.mjs [PREP7|COMBAT]
import v8 from 'node:v8';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, mb } from './snap.mjs';

const mode = (process.argv[2] || 'COMBAT').toUpperCase();
const N = 8;
const cfg = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };

function drive(h, pred, maxSteps = 8e6) {
  if (!h._started) { h._started = true; h.m.start(); }
  for (let i = 0; i < maxSteps; i++) {
    h.sent.length = 0; h.bc.length = 0;
    if (h.clients) for (const c of h.clients.values()) { c.log.length = 0; c.starts.length = 0; }
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

const batch = Array.from({ length: N }, (_, i) => {
  const h = makeMatch({ ...cfg, seed: cfg.seed0 + i, captureFrames: false });
  h.autoHumans();
  return h;
});
for (const h of batch) {
  if (mode === 'PREP7') drive(h, () => h.m.ended || (h.m.phase === PHASE.PREP && h.m.round >= 7));
  else { drive(h, () => h.m.phase === PHASE.COMBAT); h.sched.advance(10_000); }
  stripClients(h);
}
console.log(`mode=${mode}; rounds ${batch.map((h) => `${h.m.phase}${h.m.round}`).join(',')}`);

function counts() {
  const out = {};
  try {
    for (const [name, ctor] of [['plainObj', Object], ['array', Array], ['map', Map], ['set', Set], ['string', String]]) {
      const r = v8.queryObjects(ctor, { format: 'count' });
      out[name] = typeof r === 'number' ? r : (r && typeof r.count === 'number' ? r.count : '?');
    }
  } catch (e) { out.error = String(e.message || e); }
  return out;
}
console.log('counts at baseline:', JSON.stringify(counts()));

let prev = await pinned();
const base = prev;
console.log(`TOTAL retained: ${Math.round((prev.heapUsed - 0) / N)} B/match (heapUsed ${mb(prev.heapUsed)} MB, rss ${mb(prev.rss)} MB)`);

const STEPS = [
  ['field payloads (battle/job/timeline/spec/result/progress)', (m) => {
    for (const f of m.fields) { f.battle = null; f.job = null; f.timeline = null; f.spec = null; f.result = null; f.progress = null; f.sliceStep = null; f.credit = null; f.heldResult = null; f.bossReported = null; }
  }],
  ['retained view JSON (_lastPubJson / _lastPriv)', (m) => {
    m._lastPubJson = ''; m._lastPubX = null; m._lastPubAt = -Infinity;
    for (const ps of m.players.values()) ps._lastPriv = '';
  }],
  ['player boards / hand / temp / shop / offers / bonds / stats', (m) => {
    for (const ps of m.players.values()) {
      ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
      ps.shop = null; ps.offers = null; ps.bounties = null;
      if (ps._tempDue) ps._tempDue.clear();
      ps.bonds = null; ps.stats = null; ps.unitStats = null; ps.pendingLayerGains = null; ps.pendingFundsView = null;
      ps._deployMap = null; ps._legalityStale = false;
    }
    m.lastResults.clear();
  }],
  ['match phase bookkeeping (draft/sp/wave/bossWaves/unite/dispatcher/registry/errors)', (m) => {
    m.draft = null; m.sp = null; m.wave = null; m.bossWaves = null; m.unitePlan = null;
    m.registry = null; m.dispatcher = null; m.errors = null; m.simErrorLog = null;
    m.watchers.clear(); m._uniteBounds = null; m.runner = null; m.pacer = null; m.bossPool = null; m.teamLp = null;
  }],
  ['GameData + shared pool', (m) => { m.pool = null; m.gd = null; }],
  ['PlayerState objects (m.players.clear + order)', (m) => { m.players.clear(); m.order = []; }],
  ['fields array', (m) => { m.fields.length = 0; }],
  ['scheduler queue + timers', (h) => { h.sched.dispose(); h.clients = null; }],
  ['the Match object itself', (h) => { h.m = null; }],
];

for (const [name, fn] of STEPS) {
  for (const h of batch) fn(h.m ? h.m : h, h);
  const s = await pinned();
  console.log(`  freed ${String(Math.round((prev.heapUsed - s.heapUsed) / N)).padStart(9)} B/match   <- ${name}`);
  prev = s;
}
const s = await pinned();
console.log(`leftover (script + module state + data singleton): ${Math.round((s.heapUsed) / 1048576 * 1000) / 1000} MB heap, rss ${mb(s.rss)} MB`);
console.log('counts at end:', JSON.stringify(counts()));
void base;
