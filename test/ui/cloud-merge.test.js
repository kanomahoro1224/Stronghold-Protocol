// Cloud Save V2 merge rules (CLOUD-SAVE-V2 §3.3). Pure document merges plus the localStorage bridge; no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeLoadoutDoc, mergeLoadoutDocs, mergeOwnershipDoc, mergeDiyDocs, mergeSkinDocs, mergeExtrasDocs,
  readLocalExtras, applyExtras, readLocalLoadouts, applyLocalLoadouts, extrasSize, EXTRAS_VERSION,
} from '../../public/js/ui/cloudMerge.js';
import { DEFAULT_VERSION } from '../../shared/versions.js';

function withStorage(fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const map = new Map();
  const storage = {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return fn(map); } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

test('loadout merge: local byChar/ops win, cloud only fills missing operators; a v1 side wins whole', () => {
  const local = { v: 2, byChar: { char_a: { skill: 1 } }, ops: { char_a: { potential: 3 } } };
  const cloud = { v: 2, byChar: { char_a: { skill: 9 }, char_b: { skill: 2 } }, ops: { char_b: { cultivate: 2 } } };
  const { doc, added } = mergeLoadoutDoc(local, cloud);
  assert.equal(doc.byChar.char_a.skill, 1, 'local choice wins');
  assert.equal(doc.byChar.char_b.skill, 2, 'cloud fills the missing operator');
  assert.deepEqual(doc.ops.char_a, { potential: 3 });
  assert.deepEqual(doc.ops.char_b, { cultivate: 2 });
  assert.equal(added, 1, 'one operator, counted once across byChar and ops');

  const legacy = { v: 1, entries: { chess_a: { skill: 1 } }, ops: {} };
  assert.equal(mergeLoadoutDoc(legacy, cloud).doc, legacy, 'any v1 side means local whole-document priority');
  assert.equal(mergeLoadoutDoc({}, cloud).doc, cloud, 'empty local falls back to cloud');
  assert.equal(mergeLoadoutDoc(local, {}).doc, local, 'empty cloud cannot erase local');
});

test('versioned loadout merge keeps each official version independent, and accepts the old single document', () => {
  const local = {
    v: 3,
    versions: {
      [DEFAULT_VERSION]: { v: 2, byChar: { char_a: { skill: 1 } }, ops: {} },
      'act3autochess@V3_1': { v: 2, byChar: { char_b: { skill: 2 } }, ops: {} },
    },
  };
  const cloud = {
    v: 3,
    versions: {
      [DEFAULT_VERSION]: { v: 2, byChar: { char_b: { skill: 9 } }, ops: {} },
      'act3autochess@V3_1': { v: 2, byChar: { char_b: { skill: 8 }, char_c: { skill: 3 } }, ops: {} },
    },
  };
  const { doc, added } = mergeLoadoutDocs(local, cloud);
  assert.equal(doc.versions[DEFAULT_VERSION].byChar.char_a.skill, 1);
  assert.equal(doc.versions[DEFAULT_VERSION].byChar.char_b.skill, 9, 'cloud fills only the default version');
  assert.equal(doc.versions['act3autochess@V3_1'].byChar.char_b.skill, 2, 'local V3 choice wins in its own version');
  assert.equal(doc.versions['act3autochess@V3_1'].byChar.char_c.skill, 3, 'cloud fills the V3 hole');
  assert.equal(added, 2);

  // An old single v2 document means the default version; it must not leak into a named version.
  const old = mergeLoadoutDocs({ v: 2, byChar: { char_a: { skill: 7 } }, ops: {} }, {});
  assert.equal(old.doc.versions[DEFAULT_VERSION].byChar.char_a.skill, 7);
  assert.equal(old.doc.versions['act3autochess@V3_1'], undefined);
});

test('versioned local loadouts: old single v2 is copied to every known version once, never overwriting newer keys', () => {
  withStorage(() => {
    localStorage.setItem('sp.pref.loadout', JSON.stringify({ v: 2, byChar: { char_a: { skill: 1 } }, ops: {} }));
    const first = readLocalLoadouts();
    assert.equal(first.v, 3);
    assert.equal(first.versions[DEFAULT_VERSION].byChar.char_a.skill, 1);
    assert.equal(first.versions['act3autochess@V3_1'].byChar.char_a.skill, 1, 'old global copy seeded to V3');
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.loadout.act3autochess-v3_1')).byChar.char_a.skill, 1);

    localStorage.setItem('sp.pref.loadout.act3autochess-v3_1', JSON.stringify({ v: 2, byChar: { char_a: { skill: 4 } }, ops: {} }));
    const second = readLocalLoadouts();
    assert.equal(second.versions['act3autochess@V3_1'].byChar.char_a.skill, 4, 'existing per-version key wins over the seed');
    assert.equal(applyLocalLoadouts(second), 5, 'all five official versions are written');

    const seeded = { v: 2, byChar: { char_a: { skill: 1 } }, ops: {}, seeded: true };
    const cloudV3 = { v: 2, byChar: { char_a: { skill: 6 } }, ops: {} };
    const merged = mergeLoadoutDocs({ v: 3, versions: { [DEFAULT_VERSION]: seeded, 'act3autochess@V3_1': seeded } },
      { v: 3, versions: { 'act3autochess@V3_1': cloudV3 } });
    assert.equal(merged.doc.versions['act3autochess@V3_1'].byChar.char_a.skill, 6, 'seeded local copy defers to a real cloud version');
    assert.equal(merged.doc.versions['act3autochess@V3_1'].seeded, undefined);
  });
});


test('ownership merge: notOwnedChars is a conservative union, never local overwrite', () => {
  const { doc, added } = mergeOwnershipDoc(
    { v: 2, notOwnedChars: ['char_b', 'char_a'] },
    { v: 2, notOwnedChars: ['char_c', 'char_a'] },
  );
  assert.deepEqual(doc, { v: 2, notOwnedChars: ['char_a', 'char_b', 'char_c'] });
  assert.equal(added, 1);
  assert.deepEqual(mergeOwnershipDoc({ v: 2, notOwnedChars: ['char_a'] }, {}).doc, { v: 2, notOwnedChars: ['char_a'] });
});

test('ownership merge: a v1 notOwned list is preserved instead of becoming an empty v2 list', () => {
  const v1 = { v: 1, notOwned: ['chess_a'] };
  assert.deepEqual(mergeOwnershipDoc(v1, {}).doc, { v: 1, notOwned: ['chess_a'] });
  assert.deepEqual(mergeOwnershipDoc({}, v1).doc, { v: 1, notOwned: ['chess_a'] });
  assert.deepEqual(mergeOwnershipDoc(v1, { v: 2, notOwnedChars: ['char_b'] }).doc, v1, 'v1 local wins whole over v2');
  assert.deepEqual(mergeOwnershipDoc(v1, { v: 1, notOwned: ['chess_b'] }).doc,
    { v: 1, notOwned: ['chess_a', 'chess_b'] }, 'two v1 lists are unioned');
  withStorage(() => {
    localStorage.setItem('sp.pref.ownership', JSON.stringify(v1));
    assert.deepEqual(readLocalExtras().ownership, { v: 1, notOwned: ['chess_a'] });
    applyExtras({ v: 1, ownership: v1 });
    assert.deepEqual(JSON.parse(localStorage.getItem('sp.pref.ownership')), v1);
  });
});


test('diy merge: version keys stay, local slots win, cloud fills holes and unknown versions survive', () => {
  const local = {
    [DEFAULT_VERSION]: { v: 1, picks: { slot_a: { charId: 'char_a' } } },
    'future@V9': { v: 1, picks: { slot_a: { charId: 'char_future' } } },
  };
  const cloud = {
    [DEFAULT_VERSION]: { v: 1, picks: { slot_a: { charId: 'char_other' }, slot_b: { charId: 'char_b' } } },
    'act3autochess@V3_1': { v: 1, picks: { slot_a: { charId: 'char_c' } } },
  };
  const { map, added } = mergeDiyDocs(local, cloud);
  assert.deepEqual(map[DEFAULT_VERSION].picks.slot_a, { charId: 'char_a' });
  assert.deepEqual(map[DEFAULT_VERSION].picks.slot_b, { charId: 'char_b' });
  assert.deepEqual(map['future@V9'].picks.slot_a, { charId: 'char_future' });
  assert.deepEqual(map['act3autochess@V3_1'].picks.slot_a, { charId: 'char_c' });
  assert.equal(added, 2, 'slot_b plus the cloud-only version');
  assert.deepEqual(mergeDiyDocs({}, { [DEFAULT_VERSION]: { v: 1, picks: { slot_a: { charId: 'x' } } } }).map[DEFAULT_VERSION].picks.slot_a,
    { charId: 'x' });
});

test('skin merge: local operator wins, cloud adds missing characters', () => {
  const { doc, added } = mergeSkinDocs({ char_a: 'skin_local' }, { char_a: 'skin_cloud', char_b: 'skin_b' });
  assert.deepEqual(doc, { char_a: 'skin_local', char_b: 'skin_b' });
  assert.equal(added, 1);
});

test('extras envelope keeps unknown version keys and empty blocks are skipped', () => {
  const { doc, added } = mergeExtrasDocs(
    { v: 1, ownership: { v: 2, notOwnedChars: ['char_a'] }, diy: { [DEFAULT_VERSION]: { v: 1, picks: {} } } },
    { v: 1, ownership: { v: 2, notOwnedChars: ['char_b'] }, diy: { 'unknown': { v: 1, picks: { s: { charId: 'x' } } } } },
  );
  assert.equal(doc.v, EXTRAS_VERSION);
  assert.equal(doc.ownership.notOwnedChars.length, 2);
  assert.equal(doc.diy.unknown.picks.s.charId, 'x');
  assert.equal(doc.diy[DEFAULT_VERSION], undefined, 'an empty local pick block adds nothing');
  assert.equal(added.ownership, 1);
});

test('readLocalExtras/applyExtras preserve empty cloud blocks instead of erasing local data', () => {
  withStorage(() => {
    localStorage.setItem('sp.pref.ownership', JSON.stringify({ v: 2, notOwnedChars: ['char_a'] }));
    localStorage.setItem('sp.pref.diy', JSON.stringify({ v: 1, picks: { slot_a: { charId: 'char_a' } } }));
    localStorage.setItem('sp.pref.diy.act3autochess-v3_1', JSON.stringify({ v: 1, picks: { slot_b: { charId: 'char_b' } } }));
    localStorage.setItem('sp.pref.skins', JSON.stringify({ char_a: 'skin_a' }));
    const extras = readLocalExtras();
    assert.deepEqual(extras.ownership.notOwnedChars, ['char_a']);
    assert.equal(extras.diy[DEFAULT_VERSION].picks.slot_a.charId, 'char_a');
    assert.equal(extras.diy['act3autochess@V3_1'].picks.slot_b.charId, 'char_b');
    assert.equal(extras.skins.char_a, 'skin_a');
    assert.ok(extrasSize(extras) > 0);

    // a cloud block that only has ownership must not erase the local DIY/skins keys
    applyExtras({ v: 1, ownership: { v: 2, notOwnedChars: ['char_a'] } });
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.diy')).picks.slot_a.charId, 'char_a');
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.skins')).char_a, 'skin_a');

    applyExtras({ v: 1, ownership: { v: 2, notOwnedChars: [] }, diy: {}, skins: {} });
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.ownership')).notOwnedChars[0], 'char_a', 'empty cloud blocks write nothing');
  });
});
