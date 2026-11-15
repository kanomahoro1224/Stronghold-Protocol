// public/js/demoStore.js — local demo storage (IndexedDB). Demos are the player's own: they never leave the browser,
// and playback is computed here, not on the server (user requirement 2026-11-15).
//
// One record per match: { id, startedAt, mode, difficulty, players, events, snapshots }. Local storage is unlimited
// (user requirement 2026-11-15); the cloud copy keeps only the newest 10 (server/accounts/store.js CLOUD_DEMOS).
// IndexedDB because a 15-minute match is a few hundred KB and localStorage would block the main thread on every write.

import { loadPref, savePref } from './store.js';

const DB_NAME = 'sp-demos';
const STORE = 'demos';
// A small catalogue of the documents (id, when, mode, steps) in localStorage: 对局记录 can then tell which row has a
// demo without reading every document out of IndexedDB (a 15-minute match is a few hundred KB).
const INDEX_KEY = 'demoIndex';
const INDEX_MAX = 400;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { resolve(null); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

export async function putDemo(doc) {
  const db = await openDb();
  if (!db) return false;
  await tx(db, 'readwrite', (s) => s.put(doc));
  indexPut(doc);
  return true;
}

export async function listDemos() {
  const db = await openDb();
  if (!db) return [];
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function getLocalDemo(id) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDemo(id) {
  const db = await openDb();
  if (!db) return false;
  await tx(db, 'readwrite', (s) => s.delete(id));
  indexDrop(id);
  return true;
}

// ---- the catalogue ------------------------------------------------------------------------------------------------
// Kept beside the documents, never instead of them: a lost / stale entry only costs a row its 播放 button, and
// rebuildDemoIndex() restores it from IndexedDB.

/** What the catalogue knows about one document. */
const indexEntry = (doc) => ({
  id: String(doc.id || ''),
  at: Number(doc.startedAt) || 0,
  mode: doc.mode || null,
  diff: doc.difficulty || null,
  n: Array.isArray(doc.events) ? doc.events.length : 0,
  end: doc.end || null,
  rounds: Number(doc.rounds) || 0,
});

/** Every document's entry, newest first (no IndexedDB read: screens/stats.js calls this on render). */
export function listDemoIndex() {
  const rows = loadPref(INDEX_KEY, []);
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string' && r.id) : [];
}

function indexPut(doc) {
  const entry = indexEntry(doc);
  if (!entry.id) return;
  savePref(INDEX_KEY, [entry, ...listDemoIndex().filter((r) => r.id !== entry.id)].slice(0, INDEX_MAX));
}

function indexDrop(id) {
  savePref(INDEX_KEY, listDemoIndex().filter((r) => r.id !== id));
}

/**
 * Rebuild the catalogue from the documents themselves — for demos recorded before it existed (the first statistics
 * page opened after the upgrade does it once).
 * @returns {Promise<any[]>} the entries, newest first
 */
export async function rebuildDemoIndex() {
  const all = await listDemos();
  savePref(INDEX_KEY, all.slice(0, INDEX_MAX).map(indexEntry));
  return listDemoIndex();
}
