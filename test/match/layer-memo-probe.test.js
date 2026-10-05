// test/match/layer-memo-probe.test.js — the measurement probe of the content-keyed layer memo in
// server/match/fields.js (task A). It patches `globalThis.WeakMap` BEFORE fields.js is loaded, watches every WeakMap
// the module creates, and reports, for the caches keyed on data records (chess / token / item / band / effect /
// garrison records):
//
//   * gets / hits / misses / sets and the resulting hit rate,
//   * µs per miss (the recomputation the cache saved: the time between a missed get and the set that answers it) and
//     µs per hit (the lookup paid instead),
//   * one end-to-end number: a full client-combat match with a fixed seed / config, wall ms,
//   * µs per field: `specBounds` on a fresh clone of every authoritative spec (one computation per field),
//   * the reuse prediction of the key space itself (total lookups vs distinct record objects) — this one works even
//     against a fields.js without the memo, which is how the BEFORE number is taken.
//
// Run it explicitly:
//   $env:SP_LAYER_PROBE='1'; node --test test/match/layer-memo-probe.test.js            # memo as it is (AFTER)
//   $env:SP_LAYER_PROBE='1'; $env:SP_LAYER_PROBE_MODE='off'; node --test ...            # same code, every record
//                                                                                       # cache forced to miss (BEFORE)
// Without SP_LAYER_PROBE the file asserts nothing and the heavy work never runs (the test tree stays fast).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PROBE = process.env.SP_LAYER_PROBE === '1';
// 'on' (memo), 'off' (every record cache forced to miss = the pre-memo cost) or 'ab' (alternate off/on run by run:
// the same process, so the match-to-match variance of this box cancels out of the comparison)
const MODE = ['off', 'ab'].includes(process.env.SP_LAYER_PROBE_MODE) ? process.env.SP_LAYER_PROBE_MODE : 'on';
let probeOff = MODE === 'off';
const SEED = Number(process.env.SP_LAYER_PROBE_SEED || 9721);
const RUNS = Number(process.env.SP_LAYER_PROBE_RUNS || 2);
/** untimed runs before the measured ones (JIT + a warm record memo = the steady state of a long-lived server) */
const WARMUP = Number(process.env.SP_LAYER_PROBE_WARMUP || 0);

const HR = () => Number(process.hrtime.bigint()) / 1000; // µs
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
const p95 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0);
const sum = (a) => a.reduce((x, y) => x + y, 0);

// "keys of the right shape": a shared data record (chess / token / item / band / effect / garrison). A spec object
// (boundsCache), a gd (derivedCache / summonCache) and a freshly built player input match none of these.
const isRecord = (k) => !!k && typeof k === 'object' && (
  typeof k.chessId === 'string' || typeof k.garrisonId === 'string' || typeof k.tokenId === 'string'
  || typeof k.effectId === 'string' || typeof k.bandId === 'string'
  || (typeof k.id === 'string' && typeof k.itemType === 'string')
);

const RealWeakMap = globalThis.WeakMap;
const probed = [];
if (PROBE) {
  globalThis.WeakMap = class ProbedWeakMap extends RealWeakMap {
    constructor(entries) {
      super(entries);
      this._p = { gets: 0, hits: 0, misses: 0, sets: 0, hitUs: [], missUs: [], recKeys: 0, _missAt: 0, _lastKey: null, _lastVal: false, _lastAt: 0 };
      probed.push(this);
    }

    get(k) {
      if (!isRecord(k)) return super.get(k);
      const st = this._p;
      st.gets++;
      const t0 = HR();
      const v = probeOff ? undefined : super.get(k);
      const t1 = HR();
      // remember the lookup for set(): a caller that got a value and stored a new one for the same key recomputed it
      // (a data-source mismatch) — a miss by another name, and the probe must not report it as a hit.
      st._lastKey = k;
      st._lastVal = v !== undefined;
      st._lastAt = t1;
      if (v === undefined) { st.misses++; st._missAt = t1; } else { st.hits++; st.hitUs.push(t1 - t0); }
      return v;
    }

    set(k, v) {
      const st = this._p;
      if (isRecord(k)) {
        if (k === st._lastKey && st._lastVal) {
          st.hits--;
          st.hitUs.pop();
          st.misses++;
          st.missUs.push(HR() - st._lastAt);
          st._lastVal = false;
        } else if (st._missAt) {
          st.missUs.push(HR() - st._missAt);
          st._missAt = 0;
        }
        st.sets++;
        st.recKeys++;
      }
      return super.set(k, v);
    }
  };
}

// fields.js must be the FIRST module loaded under the patched WeakMap
const fields = await import('../../server/match/fields.js');
const { makeMatch } = await import('./harness.js');

/** Replay of the record-key space the two new caches key on: { cache → { lookups, distinct } }. */
function replayKeys(gd, specs) {
  const words = { lookups: 0, set: new Set() };
  const allow = { lookups: 0, set: new Set() };
  const see = (o, rec) => { if (!rec || typeof rec !== 'object') return; o.lookups++; o.set.add(rec); };
  for (const spec of specs) {
    for (const p of spec.players || []) {
      if (!p) continue;
      const band = p.bandId && typeof gd.band === 'function' ? gd.band(p.bandId) : null;
      if (band) { see(words, band); if (band.effectId && typeof gd.effect === 'function') see(words, gd.effect(band.effectId)); }
      for (const u of Array.isArray(p.units) ? p.units : []) {
        if (!u) continue;
        if (u.kind === 'token') { if (typeof gd.token === 'function') see(words, gd.token(u.tokenId)); continue; }
        if (typeof gd.chess === 'function') {
          see(words, gd.chess(u.chessId));
          if (typeof u.chessId === 'string') see(allow, gd.chess(u.chessId));
        }
        for (const it of Array.isArray(u.items) ? u.items : []) if (typeof gd.item === 'function') see(words, gd.item(it));
      }
    }
  }
  return { words: { lookups: words.lookups, distinct: words.set.size }, chessAllow: { lookups: allow.lookups, distinct: allow.set.size } };
}

/** One full client-combat match with the fixed seed / config, capturing every spec the match builds. */
function runMatch(seed) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed, captureFrames: false, clientCombat: true });
  h.autoHumans();
  const specs = [];
  const cc = h.m._ccField.bind(h.m);
  h.m._ccField = (o) => { const f = cc(o); specs.push(f.spec); return f; };
  const t0 = HR();
  h.m.start();
  const done = h.run(() => h.ended != null, { maxSteps: 5e6 });
  const ms = (HR() - t0) / 1000;
  return { h, specs, ms, done: !!done && h.ended != null };
}

/** Cache counters of the record-keyed WeakMaps, for per-phase deltas (a forced-miss arm must not pollute them). */
function cacheSnapshot() {
  return probed.map((w) => ({ gets: w._p.gets, hits: w._p.hits, misses: w._p.misses, sets: w._p.sets, missUs: w._p.missUs.length, hitUs: w._p.hitUs.length }));
}

function cacheDelta(before) {
  let gets = 0, hits = 0, misses = 0, sets = 0;
  const missUs = [], hitUs = [];
  probed.forEach((w, i) => {
    const b = before[i];
    if (!b || w._p.recKeys === 0) return;
    gets += w._p.gets - b.gets;
    hits += w._p.hits - b.hits;
    misses += w._p.misses - b.misses;
    sets += w._p.sets - b.sets;
    missUs.push(...w._p.missUs.slice(b.missUs));
    hitUs.push(...w._p.hitUs.slice(b.hitUs));
    b.missUs = w._p.missUs.length;
    b.hitUs = w._p.hitUs.length;
  });
  return { gets, hits, misses, sets, hitRate: gets ? Number((hits / gets).toFixed(4)) : 0, missUsMed: Number(med(missUs).toFixed(2)), hitUsMed: Number(med(hitUs).toFixed(3)) };
}

test('layer memo probe (SP_LAYER_PROBE=1)', { skip: !PROBE }, () => {
  const report = { mode: MODE, seed: SEED, runs: [] };
  const arms = { off: { ms: [], fieldsUs: [] }, on: { ms: [], fieldsUs: [] } };
  let last = null;
  for (let i = 0; i < WARMUP + RUNS; i++) {
    const warm = i < WARMUP;
    probeOff = MODE === 'off' ? true : MODE === 'on' ? false : (warm ? i % 2 === 0 : (i - WARMUP) % 2 === 0);
    const snap = cacheSnapshot();
    const r = runMatch(SEED);
    last = r;
    if (warm) continue;
    arms[probeOff ? 'off' : 'on'].ms.push(r.ms);
    report.runs.push({ arm: probeOff ? 'off' : 'on', ms: Number(r.ms.toFixed(1)), fields: r.specs.length, ended: r.done, cache: cacheDelta(snap) });
  }
  const { h, specs } = last;
  const gd = h.m.gd;
  try {
    assert.ok(specs.length > 5, `specs built (${specs.length})`);
    report.fieldsBuilt = specs.length;
    report.replay = replayKeys(gd, specs);

    // per-field cost: specBounds on a FRESH clone of every spec = one full computation per field (the bounds cache
    // always misses; only the record caches differ). Measured under both arms, back to back, same specs.
    for (const arm of ['off', 'on']) {
      probeOff = arm === 'off';
      fields.specBounds(JSON.parse(JSON.stringify(specs[0])), gd); // one warm-up call per arm
      const snap = cacheSnapshot();
      const us = [];
      for (const spec of specs) {
        const fresh = JSON.parse(JSON.stringify(spec));
        const t0 = HR();
        fields.specBounds(fresh, gd);
        us.push(HR() - t0);
      }
      arms[arm].fieldsUs = us;
      report[`fieldsArm_${arm}`] = cacheDelta(snap);
    }
    probeOff = MODE === 'off';

    const stat = (a) => ({ n: a.length, med: Number(med(a).toFixed(1)), p95: Number(p95(a).toFixed(1)), total: Number(sum(a).toFixed(1)) });
    report.matchMs = { off: stat(arms.off.ms), on: stat(arms.on.ms) };
    report.fieldsUs = { off: stat(arms.off.fieldsUs), on: stat(arms.on.fieldsUs) };
    report.caches = probed
      .filter((w) => w._p.recKeys > 0)
      .map((w, idx) => ({ idx, recKeys: w._p.recKeys, totalSets: w._p.sets, totalGets: w._p.gets }));
  } finally {
    h.m.dispose();
    if (h.clients) h.clients.closeAll();
  }
  console.log('PROBE ' + JSON.stringify(report));
  assert.ok(report.replay.words.lookups > 0, 'the replay saw record lookups');
});
