// test/match/layer-memo-equivalence.test.js — task A: the content-keyed layer memo of fields.js (recordWordsCache /
// chessAllowCache, WeakMaps keyed on the shared frozen data records) must be invisible in the values it returns.
//
// Both paths run the SAME code: the module as loaded in the process (cached), and a second instance of the very same
// file (`fields.js?uncached=1`, a distinct ESM module) loaded while `globalThis.WeakMap` is shimmed so that no memo in
// it can ever answer — that second instance recomputes every layer value from scratch, exactly like fields.js before
// the memo existed. The two are compared on:
//   * real authoritative field specs of a real client-combat match (every bond / band / effect / item content the
//     match produced), and
//   * a synthetic sweep with one player per chess record of the data (all 266), items on every unit, token units,
//     band ids, effects and bond snapshots — which reaches the fixed-cap, bond_by_id, lineup and extra_cnt / uncapped
//     branches of `layerAllowanceOf` and every record shape `layerBondsOf` walks,
// each under TWO distinct frozen data graphs (`loadData()` twice: same content, different record objects), so the
// memo cannot pass by serving one data source's answer under another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';
import { makeMatch } from './harness.js';

// the module under test, with its memos live
const cachedMod = await import('../../server/match/fields.js');

// a second instance of the same file whose WeakMaps never hit: `get` always misses, `set` stores nothing. Installed
// only for the duration of the import — the instances that module creates keep the never-hitting behavior.
const RealWeakMap = globalThis.WeakMap;
globalThis.WeakMap = class NeverHitsWeakMap extends RealWeakMap {
  get() { return undefined; }
  has() { return false; }
  set() { return this; }
};
const uncachedMod = await import('../../server/match/fields.js?uncached=1');
globalThis.WeakMap = RealWeakMap;

const MODE_ID = 'mode_multi_normal';

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

/** The same data in ITERATION order (the memo shares one words array per record, so insertion order must survive). */
function ordered(B) {
  const entries = (m) => [...m.entries()];
  return {
    players: [...B.players.entries()].map(([pid, p]) => [pid, {
      bonds: p.bonds ? [...p.bonds] : null,
      layerAllow: entries(p.layerAllow),
    }]),
  };
}

/** Cached path vs uncached path for one spec under one data source. Returns the cached bounds. */
function compare(spec, gd, label) {
  const cachedSpec = JSON.parse(JSON.stringify(spec));
  const a1 = cachedMod.specBounds(cachedSpec, gd);
  assert.equal(cachedMod.specBounds(cachedSpec, gd), a1, `${label}: the spec memo serves the same object`);
  const uncachedSpec = JSON.parse(JSON.stringify(spec));
  const b1 = uncachedMod.specBounds(uncachedSpec, gd);
  assert.notEqual(uncachedMod.specBounds(uncachedSpec, gd), b1, `${label}: the uncached instance recomputes`);
  assert.deepEqual(plain(b1), plain(a1), `${label}: cached = uncached`);
  assert.deepEqual(ordered(b1), ordered(a1), `${label}: cached = uncached (iteration order)`);
  return a1;
}

/** Real authoritative specs of a client-combat match (the objects the server validates results against). */
function realSpecs(n, seed) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed, captureFrames: false, clientCombat: true });
  h.autoHumans();
  const specs = [];
  h.onSend.push((pid, msg) => { if (msg.t === 'b.start' && msg.authoritative && specs.length < n) specs.push(msg.spec); });
  h.m.start();
  h.run(() => specs.length >= n || h.ended != null, { maxSteps: 5e6 });
  return { h, specs };
}

/** One player per chess record: all 266 chess ids, all 115 items, tokens, bands, effects, bond snapshots. */
function sweepSpec(gd) {
  const raw = gd.raw;
  const chessIds = Object.keys(raw.chess);
  const itemIds = Object.keys(raw.items);
  const bondIds = Object.keys(raw.bonds);
  const bandIds = Object.keys(raw.bands);
  const tokenIds = Object.keys(raw.tokens);
  const players = chessIds.map((chessId, i) => {
    const units = [
      { uid: 1000 + i * 10, kind: 'chess', chessId, row: 0, col: 0, dir: 2, items: [itemIds[i % itemIds.length], itemIds[(i * 7 + 3) % itemIds.length]] },
      // a second operator: the handed-out ADD_BOND traits are counted once per operator (units.length)
      { uid: 1001 + i * 10, kind: 'chess', chessId: chessIds[(i * 13 + 7) % chessIds.length], row: 0, col: 1, dir: 2, items: [] },
    ];
    if (i % 5 === 0) units.push({ uid: 1002 + i * 10, kind: 'token', tokenId: tokenIds[i % tokenIds.length], row: 0, col: 2, dir: 2, ownerUid: 1000 + i * 10 });
    return {
      playerId: `p_${i}`, seat: i, side: 'L', colOffset: 0, units,
      bonds: {
        [bondIds[i % bondIds.length]]: { count: 1, active: true, tier: 1, layers: 3 },
        [bondIds[(i * 5 + 1) % bondIds.length]]: { count: 2, active: false, tier: 2, layers: 0 },
      },
      bandId: bandIds[i % bandIds.length],
      playerEffects: [
        { id: 'e1', key: bandIds[i % bandIds.length], source: 'choice', params: { n: i }, counter: i, data: { chessId } },
        { id: 'e2', key: `not_a_bond_${i}`, source: null, params: null, counter: null, data: null },
      ],
      deviceOverrides: {},
    };
  });
  return {
    v: 1, battleId: 'eq.sweep', fieldId: 'eq.sweep', kind: 'normal', seed: 1, modeId: null, round: 3, stageId: null,
    rect: null, timeLimit: 60, players, spawns: [], routes: [], flags: { layerGainsEnabled: true },
    enemyOverrides: {}, waveId: null, bossId: null, content: 'full', boss: null,
  };
}

/** Two distinct record sets: loadData() twice (same content, different frozen objects). */
function twoGraphs() {
  const gdA = new GameData(loadData(), MODE_ID);
  const gdB = new GameData(loadData(), MODE_ID);
  const id = 'chess_char_1_01_a';
  assert.ok(gdA.chess(id) && gdB.chess(id), 'both data graphs carry the sample chess');
  assert.notEqual(gdA.chess(id), gdB.chess(id), 'the two graphs hold distinct record objects');
  assert.notEqual(gdA.raw, gdB.raw, 'and distinct raw graphs');
  return [gdA, gdB];
}

test('layer memo: real field specs give the same bounds cached and uncached, under two distinct record sets', () => {
  const graphs = twoGraphs();
  const { h, specs } = realSpecs(3, 9731);
  try {
    assert.ok(specs.length >= 3, `authoritative specs (${specs.length})`);
    for (const gd of graphs) for (const spec of specs) compare(spec, gd, `${spec.fieldId} R${spec.round} gd#${graphs.indexOf(gd)}`);
    // switching back to the first graph after the second one: the memo must not have crossed the two
    for (const spec of specs) compare(spec, graphs[0], `${spec.fieldId} R${spec.round} gd#0 again`);
  } finally { h.m.dispose(); if (h.clients) h.clients.closeAll(); }
});

test('layer memo: the sweep over every chess / item / bond / band record is identical cached and uncached', () => {
  const graphs = twoGraphs();
  const [gdA, gdB] = graphs;
  const B = compare(sweepSpec(gdA), gdA, 'sweep gd#0');
  const B2 = compare(sweepSpec(gdB), gdB, 'sweep gd#1');
  assert.equal(B.players.size, Object.keys(gdA.raw.chess).length, 'one bounds entry per chess player');
  assert.equal(B2.players.size, B.players.size);
  // the sweep really reached the layer work: bonds named, allowances computed, and the uncapped (Infinity) branch
  const players = [...B.players.values()];
  assert.ok(players.some((p) => p.bonds && p.bonds.size > 0), 'some player names bonds');
  assert.ok(players.some((p) => p.layerAllow.size > 0), 'some player gets a layer allowance');
  const vals = players.flatMap((p) => [...p.layerAllow.values()]);
  assert.ok(vals.some((v) => v === Infinity), 'the uncapped branch is exercised');
  assert.ok(vals.some((v) => Number.isFinite(v) && v > 0), 'and a finite capped one');
  assert.ok(vals.some((v) => Number.isFinite(v) && v >= 12), 'the GRANTED_CAP_OVERRIDE caps are exercised');
});
