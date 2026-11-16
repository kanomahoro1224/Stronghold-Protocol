// Cloud Save V2 UI bridge (public/js/ui/cloud.js): one GET → merge → PUT, empty cloud never erases local documents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VERSION } from '../../shared/versions.js';

async function withStorage(fn) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousFetch = globalThis.fetch;
  const map = new Map();
  const storage = {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return await fn(map); } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
    globalThis.fetch = previousFetch;
  }
}

const jsonResponse = (data) => ({ ok: data.ok !== false, status: data.ok === false ? 401 : 200, async json() { return data; } });

test('mergeCloudSave keeps local empty-cloud documents and builds the PUT body from them', async () => {
  await withStorage(async () => {
    localStorage.setItem('sp.pref.loadout', JSON.stringify({ v: 2, byChar: { char_a: { skill: 2 } }, ops: {} }));
    localStorage.setItem('sp.pref.ownership', JSON.stringify({ v: 2, notOwnedChars: ['char_a'] }));
    const { mergeCloudSave, applyCloudSave } = await import('../../public/js/ui/cloud.js?cloud-save-empty');
    const merged = mergeCloudSave({ loadouts: {}, settings: {}, stats: {}, extras: {} });
    assert.equal(merged.body.loadouts.versions[DEFAULT_VERSION].byChar.char_a.skill, 2);
    assert.deepEqual(merged.body.extras.ownership.notOwnedChars, ['char_a']);
    applyCloudSave(merged);
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.loadout')).byChar.char_a.skill, 2);
    assert.deepEqual(JSON.parse(localStorage.getItem('sp.pref.ownership')).notOwnedChars, ['char_a']);
  });
});

test('versioned loadouts put each official version in its own slot and apply it back per version', async () => {
  await withStorage(async () => {
    localStorage.setItem('sp.pref.loadout', JSON.stringify({ v: 2, byChar: { char_a: { skill: 1 } }, ops: {} }));
    localStorage.setItem('sp.pref.loadout.act3autochess-v3_1', JSON.stringify({ v: 2, byChar: { char_b: { skill: 3 } }, ops: {} }));
    const { mergeCloudSave, applyCloudSave } = await import('../../public/js/ui/cloud.js?cloud-save-versioned');
    const merged = mergeCloudSave({ loadouts: { v: 2, byChar: { char_a: { skill: 9 } }, ops: {} }, settings: {}, stats: {}, extras: {} });
    assert.equal(merged.body.loadouts.versions[DEFAULT_VERSION].byChar.char_a.skill, 1);
    assert.equal(merged.body.loadouts.versions['act3autochess@V3_1'].byChar.char_b.skill, 3);
    applyCloudSave(merged);
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.loadout.act3autochess-v3_1')).byChar.char_b.skill, 3);
  });
});

test('cloud extras merge into local and one sync sends exactly one GET and one PUT', async () => {
  await withStorage(async () => {
    localStorage.setItem('sp.pref.loadout', JSON.stringify({ v: 2, byChar: { char_a: { skill: 1 } }, ops: {} }));
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push([url, opts.method || 'GET']);
      if (opts.method === 'PUT') return jsonResponse({ ok: true });
      return jsonResponse({
        ok: true, loadouts: {}, settings: {},
        stats: { records: [] },
        extras: { v: 1, ownership: { v: 2, notOwnedChars: ['char_b'] },
          diy: { act2autochess: { v: 1, picks: { s: { charId: 'char_b' } } } },
          skins: { char_b: 'skin_b' } },
      });
    };
    const { syncCloudSave } = await import('../../public/js/ui/cloud.js?cloud-save-sync');
    const r = await syncCloudSave();
    assert.equal(r.ok, true);
    assert.equal(r.added.ownership, 1, 'cloud ownership was merged');
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.ownership')).notOwnedChars[0], 'char_b');
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.diy')).picks.s.charId, 'char_b');
    assert.equal(JSON.parse(localStorage.getItem('sp.pref.skins')).char_b, 'skin_b');
    assert.deepEqual(calls.map(([, m]) => m), ['GET', 'PUT'], 'one sync is one GET + one PUT');
  });
});
