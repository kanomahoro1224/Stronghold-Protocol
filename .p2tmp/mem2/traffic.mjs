// What does the m.public / m.private diff baseline actually buy? Count and byte-size the frames a match sends with the
// baselines live, and again with the baselines always cleared (the "drop the retained view JSON" policy), on the very
// same drive: the ratio is the extra traffic that policy costs.
//   node --expose-gc .p2tmp/mem2/traffic.mjs [A|B] [PREP<n>|END|R<n>]
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { Match } from '../../server/match/Match.js';

const which = (process.argv[2] || 'B').toUpperCase();
const stop = (process.argv[3] || 'END').toUpperCase();

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

function goal(h) {
  const m = h.m;
  if (stop === 'END') return () => m.ended;
  const p = /^PREP(\d+)$/.exec(stop);
  if (p) return () => m.ended || (m.phase === PHASE.PREP && m.round >= Number(p[1]));
  const r = /^R(\d+)$/.exec(stop);
  if (r) return () => m.ended || (m.phase === PHASE.COMBAT && m.round >= Number(r));
  return () => m.ended;
}

/** Run one match and count the view frames it emits; `noBaseline` clears both diff baselines before every decision. */
function run(noBaseline, seed) {
  const cfg = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: which === 'B' ? 2 : 0, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed, captureFrames: false };
  const h = makeMatch(cfg);
  h.autoHumans();
  const m = h.m;
  const stat = { pub: 0, pubBytes: 0, priv: 0, privBytes: 0 };
  // the instance methods win over the prototype: force the baseline empty at every call
  if (noBaseline) {
    m._maybeSendPublic = function (force) { this._lastPubJson = ''; return Match.prototype._maybeSendPublic.call(this, force); };
    m._sendPrivate = function (ps, force) { ps._lastPriv = null; return Match.prototype._sendPrivate.call(this, ps, force); };
  }
  h.onBroadcast.push((msg) => { if (msg && msg.t === 'm.public') { stat.pub++; stat.pubBytes += JSON.stringify(msg).length; } });
  h.onSend.push((pid, msg) => { if (msg && msg.t === 'm.private') { stat.priv++; stat.privBytes += JSON.stringify(msg).length; } });
  drive(h, goal(h));
  const rounds = m.round;
  const phase = m.phase;
  try { m.dispose(); } catch { /* ignore */ }
  if (h.clients) h.clients.closeAll();
  return { stat, rounds, phase };
}

const seeds = [4101, 4102, 4103, 4104];
const withB = { pub: 0, pubBytes: 0, priv: 0, privBytes: 0 };
const withoutB = { pub: 0, pubBytes: 0, priv: 0, privBytes: 0 };
let last = null;
for (const s of seeds) {
  const a = run(false, s);
  const b = run(true, s);
  last = a;
  for (const k of Object.keys(withB)) { withB[k] += a.stat[k]; withoutB[k] += b.stat[k]; }
}
const f = (n) => (n / 1024).toFixed(1);
console.log(`=== ${which} (2 humans + ${which === 'B' ? 2 : 0} bots), stop=${stop}, ${seeds.length} seeds ===`);
console.log(`  reached: ${last.phase} R${last.round}`);
console.log(`  with the diff baselines : m.public ${withB.pub} frames / ${f(withB.pubBytes)} KB, m.private ${withB.priv} frames / ${f(withB.privBytes)} KB`);
console.log(`  baselines always cleared: m.public ${withoutB.pub} frames / ${f(withoutB.pubBytes)} KB, m.private ${withoutB.priv} frames / ${f(withoutB.privBytes)} KB`);
const ratio = (a, b) => (b > 0 ? (a / b).toFixed(2) : '-');
console.log(`  cost of dropping them   : m.public ×${ratio(withB.pub, withoutB.pub)} frames ×${ratio(withB.pubBytes, withoutB.pubBytes)} bytes,`
  + ` m.private ×${ratio(withB.priv, withoutB.priv)} frames ×${ratio(withB.privBytes, withoutB.privBytes)} bytes`);
