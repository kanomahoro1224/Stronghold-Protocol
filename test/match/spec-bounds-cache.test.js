// test/match/spec-bounds-cache.test.js — fields.js specBounds is memoized per spec object (one entry per field). These
// tests pin the two things a cache may never change: the values it returns, and the verdict of the caller that used to
// recompute them (validateClientResult — it copies the two budget maps it decrements, and that must stay true).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specBounds, validateClientResult } from '../../server/match/fields.js';
import { createBattleFromSpec, compactResult } from '../../server/sim/spec.js';
import { makeMatch } from './harness.js';

/** The whole bounds record as plain data (Maps / Sets → sorted arrays), for a deep comparison. */
function plain(B) {
  const list = (m) => [...m.entries()].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  const set = (s) => [...s].sort();
  return {
    keyCounts: list(B.keyCounts), keySourceCounts: list(B.keySourceCounts), derivedSourceCounts: list(B.derivedSourceCounts),
    uncountedKeys: set(B.uncountedKeys), derived: set(B.derived), sources: set(B.sources),
    spawnCount: B.spawnCount, bountyCoins: B.bountyCoins, maxTotal: B.maxTotal, layerCap: B.layerCap, maxTime: B.maxTime,
    players: list(B.players).map(([pid, p]) => [pid, {
      chess: list(p.chess), all: list(p.all), defIds: set(p.defIds), bonds: p.bonds ? set(p.bonds) : null,
      startLayers: list(p.startLayers), layerAllow: list(p.layerAllow),
    }]),
  };
}

/** Real authoritative field specs of a client-combat match (the objects the server validates results against). */
function realSpecs(n, seed) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed, captureFrames: false, clientCombat: true });
  h.autoHumans();
  const specs = [];
  h.onSend.push((pid, msg) => { if (msg.t === 'b.start' && msg.authoritative && specs.length < n) specs.push(msg.spec); });
  h.m.start();
  h.run(() => specs.length >= n || h.ended != null, { maxSteps: 5e6 });
  return { h, specs };
}

test('specBounds: a field spec is computed once and its cached value equals a fresh computation', () => {
  const { h, specs } = realSpecs(2, 9721);
  try {
    assert.ok(specs.length >= 2, `authoritative specs (${specs.length})`);
    for (const spec of specs) {
      const a = specBounds(spec, h.m.gd);
      assert.equal(specBounds(spec, h.m.gd), a, 'the second call is served from the cache');
      // a different object with the same content: computed for real, and it must agree value for value
      const fresh = specBounds(JSON.parse(JSON.stringify(spec)), h.m.gd);
      assert.notEqual(fresh, a, 'a distinct spec object is not a cache hit');
      assert.deepEqual(plain(fresh), plain(a), `${spec.fieldId} R${spec.round}: cached = uncached`);
    }
    // `gd` is part of the key: the same spec under another data source is recomputed, not served the first one's bounds
    const spec = specs[0];
    const withGd = specBounds(spec, h.m.gd);
    const without = specBounds(spec, null);
    assert.notEqual(without, withGd, 'a different gd recomputes');
    assert.deepEqual(plain(specBounds(spec, h.m.gd)), plain(withGd), 'and switching back still agrees');
    // a non-object spec is answered (and cannot be cached — there is no key)
    assert.equal(specBounds(null).spawnCount, 0);
    assert.equal(specBounds(undefined, h.m.gd).bountyCoins, 0);
  } finally { h.m.dispose(); }
});

test('validateClientResult: a cached spec gives exactly the accepted result (and the same rejections)', () => {
  const { h, specs } = realSpecs(2, 9722);
  try {
    const gd = h.m.gd;
    let checked = 0;
    for (const spec of specs) {
      const res = compactResult(createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true }).runToEnd(4000));
      const warm = validateClientResult(spec, res, { gd });       // bounds just built (one field, one result)
      assert.equal(warm.ok, true, `${spec.fieldId} R${spec.round}: an honest result is accepted (${warm.reason})`);
      assert.deepEqual(validateClientResult(spec, res, { gd }), warm, 'the cached bounds change nothing');
      assert.deepEqual(validateClientResult(JSON.parse(JSON.stringify(spec)), res, { gd }), warm, 'a fresh spec object computes the same value');
      // a tampered result is rejected the same way with the cache warm as with it cold: the cached maps are read-only
      const pid = Object.keys(res.perPlayer)[0];
      const forged = { ...res, perPlayer: { ...res.perPlayer, [pid]: { ...res.perPlayer[pid], total: spec.spawns.length * 400 + 10_000 } } };
      const warmBad = validateClientResult(spec, forged, { gd });
      assert.equal(warmBad.ok, false, 'a forged total is rejected');
      assert.deepEqual(validateClientResult(JSON.parse(JSON.stringify(spec)), forged, { gd }), warmBad, 'same rejection, cached or not');
      // the budget maps the validator decrements were copies: validating twice does not consume the cached ones
      assert.equal(specBounds(spec, gd).keySourceCounts.size,
        specBounds(JSON.parse(JSON.stringify(spec)), gd).keySourceCounts.size, 'the cached budgets are untouched');
      checked++;
    }
    assert.ok(checked >= 2, `specs validated (${checked})`);
  } finally { h.m.dispose(); }
});
