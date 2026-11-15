// public/js/demoStore.js — local demo storage (IndexedDB). Demos are the player's own: they never leave the browser,
// and playback is computed here, not on the server (user requirement 2026-11-15).
//
// One record per match: { id, startedAt, mode, difficulty, players, events, snapshots }. Local storage is unlimited
// (user requirement 2026-11-15); the cloud copy keeps only the newest 10 (server/accounts/store.js CLOUD_DEMOS).
// IndexedDB because a 15-minute match is a few hundred KB and localStorage would block the main thread on every write.

const DB_NAME = 'sp-demos';
const STORE = 'demos';

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
  return true;
}
