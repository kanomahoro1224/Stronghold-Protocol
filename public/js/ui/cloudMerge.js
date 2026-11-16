// public/js/ui/cloudMerge.js — Cloud Save V2 merge rules (CLOUD-SAVE-V2 §3.3).
//
// The server stores `extras` as an opaque envelope; all conflict resolution happens here, on the client, because only
// the browser knows its own documents and can write them back without wiping a fresh device. The pure merge functions
// (mergeLoadoutDoc / mergeOwnershipDoc / mergeDiyDocs / mergeSkinDocs) do not read storage, so they are unit-testable.
//
// The envelope is deliberately versioned and keeps unknown 自选编队 version keys: a renamed/unreleased version must not
// make another version's picks disappear. Empty documents ({}, null, no entries) never replace a non-empty side.

import { DEFAULT_VERSION, VERSIONS, versionById, versionSlug } from '../../../shared/versions.js';
import { loadPref, savePref } from '../store.js';
import { parseStoredOwnershipChars } from './ownershipModel.js';
import { parseStoredDiy, diyPrefKey } from './diyModel.js';
import { parseStoredSkins } from './skins.js';
import { LOADOUT_PREF, LOADOUT_STORE_VERSION, loadoutPrefKey, loadoutVersionOfKey } from './loadoutModel.js';

export const EXTRAS_VERSION = 1;
export const LOADOUT_VERSION = 2;
export const OWNERSHIP_VERSION = 2;
export const DIY_VERSION = 1;
/** Keep at most six version keys (the five official versions plus one future/unknown); same bound as DIY versions. */
export const MAX_LOADOUT_VERSIONS = 6;
export const MAX_DIY_VERSIONS = 6;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (o) => isObj(o) && Object.keys(o).length > 0;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeKey = (k) => typeof k === 'string' && k.length > 0 && !UNSAFE_KEYS.has(k);

/** Whether a loadout document has anything worth merging (v2 byChar/ops or a legacy entries map). */
function loadoutHas(doc) {
  return isObj(doc) && ((isObj(doc.byChar) && hasKeys(doc.byChar)) || (isObj(doc.ops) && hasKeys(doc.ops))
    || (isObj(doc.entries) && hasKeys(doc.entries)));
}

/** The per-version documents of a local/cloud loadouts document (old single v2 documents mean the default version). */
function loadoutVersions(doc) {
  if (!isObj(doc)) return {};
  if (doc.v === LOADOUT_STORE_VERSION && isObj(doc.versions)) return doc.versions;
  if (loadoutHas(doc)) return { [DEFAULT_VERSION]: doc };
  return {};
}

/** How many operators/legacy entries a loadout document carries (for the cloud-only "编队 +N" summary). */
function loadoutCount(doc) {
  const ids = new Set();
  if (isObj(doc?.byChar)) for (const id of Object.keys(doc.byChar)) if (safeKey(id)) ids.add(id);
  if (isObj(doc?.ops)) for (const id of Object.keys(doc.ops)) if (safeKey(id)) ids.add(id);
  if (isObj(doc?.entries)) for (const id of Object.keys(doc.entries)) if (safeKey(id)) ids.add(id);
  if (isObj(doc?.versions)) for (const value of Object.values(doc.versions)) {
    for (const id of new Set([
      ...(isObj(value?.byChar) ? Object.keys(value.byChar) : []),
      ...(isObj(value?.ops) ? Object.keys(value.ops) : []),
    ])) if (safeKey(id)) ids.add(id);
  }
  return ids.size;
}

/** Whether an ownership document has a non-empty list (v2 notOwnedChars or the legacy v1 notOwned). */
function ownershipHas(doc) {
  return isObj(doc) && ((Array.isArray(doc.notOwnedChars) && doc.notOwnedChars.length > 0)
    || (Array.isArray(doc.notOwned) && doc.notOwned.length > 0));
}

/** Whether a 自选编队 document has at least one filled slot. */
function diyHas(doc) {
  return isObj(doc) && isObj(doc.picks) && hasKeys(doc.picks);
}

/** The filled slots of any stored 自选编队 document ({ v, picks }; junk → {}). */
function picksOf(doc) {
  return isObj(doc) && isObj(doc.picks) ? doc.picks : {};
}

/**
 * Merge two v2 loadout documents by operator: local wins, cloud fills only operators the local document lacks. A v1
 * document on either side cannot be merged safely (its keys are chess ids, not operator ids), so the local document
 * wins whole; an empty local falls back to the cloud.
 * @param {any} local @param {any} cloud
 * @returns {{ doc: any, added: number }}
 */
export function mergeLoadoutDoc(local, cloud) {
  const localOk = loadoutHas(local);
  const cloudOk = loadoutHas(cloud);
  if (!localOk) return { doc: cloudOk ? cloud : (local ?? cloud ?? null), added: cloudOk ? loadoutCount(cloud) : 0 };
  if (!cloudOk) return { doc: local, added: 0 };
  // any v1 side: whole-document local priority (the plan's explicit rule)
  if (local.v !== LOADOUT_VERSION || cloud.v !== LOADOUT_VERSION) return { doc: local, added: 0 };

  const localByChar = isObj(local.byChar) ? local.byChar : {};
  const localOps = isObj(local.ops) ? local.ops : {};
  const cloudByChar = isObj(cloud.byChar) ? cloud.byChar : {};
  const cloudOps = isObj(cloud.ops) ? cloud.ops : {};
  const byChar = { ...localByChar };
  const ops = { ...localOps };
  const addedIds = new Set();
  for (const [id, value] of Object.entries(cloudByChar)) {
    if (safeKey(id) && !Object.hasOwn(byChar, id)) { byChar[id] = value; addedIds.add(id); }
  }
  for (const [id, value] of Object.entries(cloudOps)) {
    if (safeKey(id) && !Object.hasOwn(ops, id)) { ops[id] = value; addedIds.add(id); }
  }
  return { doc: { ...local, v: LOADOUT_VERSION, byChar, ops }, added: addedIds.size };
}

/**
 * Merge the per-version loadouts documents. Each version is independent: the same mergeLoadoutDoc runs inside it, so a
 * choice on version A can never be filled into (or overwritten by) version B. An old single v2 document is treated as
 * the default version and remains compatible with every existing client.
 * @param {any} local @param {any} cloud
 * @returns {{ doc: any, added: number }}
 */
export function mergeLoadoutDocs(local, cloud) {
  const localVersions = loadoutVersions(local);
  const cloudVersions = loadoutVersions(cloud);
  const all = [...new Set([...Object.keys(localVersions), ...Object.keys(cloudVersions)])].filter(safeKey);
  // Keep the default first, then known versions, then unknown ones; six versions is the same retention bound as DIY.
  const ordered = [
    ...all.filter((k) => k === DEFAULT_VERSION),
    ...VERSIONS.map((v) => v.id).filter((k) => k !== DEFAULT_VERSION && all.includes(k)),
    ...all.filter((k) => k !== DEFAULT_VERSION && !VERSIONS.some((v) => v.id === k)),
  ].slice(0, MAX_LOADOUT_VERSIONS);
  const versions = {};
  let added = 0;
  for (const key of ordered) {
    const a = localVersions[key];
    const b = cloudVersions[key];
    // A version seeded from the old global document is only a fallback: a real cloud document for that version wins,
    // otherwise the seeded local config becomes authoritative (and loses the marker) as soon as it is read.
    const localArg = a?.seeded === true && loadoutHas(b) ? null : a;
    const one = mergeLoadoutDoc(localArg || {}, b || {});
    if (!loadoutHas(one.doc)) continue;
    const doc = one.doc?.seeded === true ? { ...one.doc } : one.doc;
    if (doc) delete doc.seeded;
    versions[key] = doc;
    added += one.added || 0;
  }
  if (!hasKeys(versions)) return { doc: null, added: 0 };
  return { doc: { v: LOADOUT_STORE_VERSION, versions }, added };
}

/** The ids of a legacy `{ v: 1, notOwned }` ownership document (chess ids, not charIds; junk → []). */
function legacyOwnership(doc) {
  if (!isObj(doc) || !Array.isArray(doc.notOwned)) return [];
  return doc.notOwned.filter((id) => safeKey(id)).slice(0, 128);
}

/**
 * Merge ownership: the 未持有 set is conservative information, so the result is the union. A v2 document is the normal
 * shape; a legacy v1 list cannot be converted to charIds without the data of its version, so it is never silently
 * replaced by an empty v2 list: a v1 side wins over an empty other side, while two v1 lists are unioned.
 * @param {any} local @param {any} cloud
 * @returns {{ doc: any, added: number }}
 */
export function mergeOwnershipDoc(local, cloud) {
  const localChars = isObj(local) && local.v === OWNERSHIP_VERSION ? parseStoredOwnershipChars(local) : [];
  const cloudChars = isObj(cloud) && cloud.v === OWNERSHIP_VERSION ? parseStoredOwnershipChars(cloud) : [];
  const localLegacy = legacyOwnership(local);
  const cloudLegacy = legacyOwnership(cloud);
  if (localLegacy.length || cloudLegacy.length) {
    if (localChars.length) return { doc: local, added: 0 }; // a v2 local document cannot be mixed with a v1 list
    if (localLegacy.length) {
      const out = new Set(localLegacy);
      let added = 0;
      for (const id of cloudLegacy) if (!out.has(id)) { out.add(id); added += 1; }
      return { doc: { v: 1, notOwned: [...out].sort() }, added };
    }
    return { doc: { v: 1, notOwned: [...new Set(cloudLegacy)].sort() }, added: cloudLegacy.length };
  }
  if (!localChars.length && !cloudChars.length) return { doc: local ?? cloud ?? null, added: 0 };
  const out = new Set(localChars);
  let added = 0;
  for (const id of cloudChars) if (!out.has(id)) { out.add(id); added += 1; }
  return { doc: { v: OWNERSHIP_VERSION, notOwnedChars: [...out].sort() }, added };
}

/**
 * Merge per-version 自选编队 documents: every version key (known or unknown) is kept; inside a version local slots win,
 * cloud fills the holes. A non-empty local map with a legacy document shape still wins on the per-version level.
 * @param {Record<string, any>|null|undefined} localMap @param {Record<string, any>|null|undefined} cloudMap
 * @returns {{ map: Record<string, any>, added: number }}
 */
export function mergeDiyDocs(localMap, cloudMap) {
  const local = isObj(localMap) ? localMap : {};
  const cloud = isObj(cloudMap) ? cloudMap : {};
  const map = {};
  let added = 0;
  for (const key of new Set([...Object.keys(local), ...Object.keys(cloud)])) {
    if (!safeKey(key)) continue;
    const a = local[key];
    const b = cloud[key];
    if (!diyHas(a) && !diyHas(b)) continue;
    if (!diyHas(a)) { map[key] = b; added += Object.keys(picksOf(b)).length; continue; }
    if (!diyHas(b)) { map[key] = a; continue; }
    const picks = {};
    for (const [slot, pick] of Object.entries(picksOf(a))) if (safeKey(slot)) picks[slot] = pick;
    for (const [slot, pick] of Object.entries(picksOf(b))) {
      if (safeKey(slot) && !Object.hasOwn(picks, slot)) { picks[slot] = pick; added += 1; }
    }
    map[key] = { ...a, v: DIY_VERSION, picks };
  }
  // drop only keys whose both sides are absent/empty
  const keys = Object.keys(map);
  const ordered = [
    ...keys.filter((k) => k === DEFAULT_VERSION),
    ...VERSIONS.map((v) => v.id).filter((k) => k !== DEFAULT_VERSION && keys.includes(k)),
    ...keys.filter((k) => k !== DEFAULT_VERSION && !VERSIONS.some((v) => v.id === k)),
  ].slice(0, MAX_DIY_VERSIONS);
  const capped = {};
  for (const key of ordered) capped[key] = map[key];
  return { map: capped, added };
}

 /**
 * Merge skin selections by operator: local wins, cloud fills operators the local document does not name.
 * @param {any} local @param {any} cloud
 * @returns {{ doc: Record<string, string>, added: number }}
 */
export function mergeSkinDocs(local, cloud) {
  const a = isObj(local) ? local : {};
  const b = isObj(cloud) ? cloud : {};
  const doc = { ...a };
  let added = 0;
  for (const [charId, skinId] of Object.entries(b)) {
    if (safeKey(charId) && typeof skinId === 'string' && skinId && !Object.hasOwn(doc, charId)) {
      doc[charId] = skinId; added += 1;
    }
  }
  return { doc, added };
}

/**
 * Merge the whole `extras` envelope. `loadout` is not part of this envelope (it stays in profiles.loadouts), matching
 * CLOUD-SAVE-V2 §3.1.
 * @param {any} local @param {any} cloud
 * @returns {{ doc: any, added: { loadout?: number, ownership: number, diy: number, skins: number } }}
 */
export function mergeExtrasDocs(local, cloud) {
  const l = isObj(local) ? local : {};
  const c = isObj(cloud) ? cloud : {};
  const ownership = mergeOwnershipDoc(l.ownership, c.ownership);
  const diy = mergeDiyDocs(l.diy, c.diy);
  const skins = mergeSkinDocs(l.skins, c.skins);
  const doc = { v: EXTRAS_VERSION };
  if (ownership.doc && ownershipHas(ownership.doc)) doc.ownership = ownership.doc;
  if (hasKeys(diy.map)) doc.diy = diy.map;
  if (hasKeys(skins.doc)) doc.skins = skins.doc;
  return { doc, added: { ownership: ownership.added, diy: diy.added, skins: skins.added } };
}

// ---- local storage bridge ----------------------------------------------------------------------------------------------

/** The `sp.pref.` key of a version's 自选编队: `diy` for the default, `diy.<slug>` for another version. */
function diyKeyForVersion(versionId) {
  const v = versionById(versionId);
  return v ? diyPrefKey(v.id) : `diy.${versionId}`;
}

/** Every local `diy*` key → its version id (unknown suffixes are preserved under the suffix itself). */
function localDiyKeys() {
  const out = [];
  const known = new Set(VERSIONS.map((v) => diyPrefKey(v.id)));
  for (const v of VERSIONS) out.push([v.id, diyPrefKey(v.id)]);
  try {
    const storage = globalThis.localStorage;
    if (!storage) return out;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith('sp.pref.diy.')) continue;
      if (known.has(key.slice(8))) continue; // 8 = 'sp.pref.'.length
      const suffix = key.slice('sp.pref.diy.'.length);
      const v = VERSIONS.find((x) => versionSlug(x) === suffix);
      out.push([v ? v.id : suffix, key]);
    }
  } catch { /* private mode */ }
  return out;
}

/**
 * Read every local per-version loadout into the Cloud Save V2.1 outer document. `sp.pref.loadout` is the default
 * version, `sp.pref.loadout.<slug>` another version. Existing old clients' single v2 `loadout` is the default; that
 * document is also copied to every known version that has no local document yet, so an upgrade keeps its current 编队
 * on every version until the player edits one.
 * @returns {{ v: number, versions: Record<string, any> }}
 */
export function readLocalLoadouts() {
  const versions = {};
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      for (let i = 0; i < storage.length; i += 1) {
        const full = storage.key(i);
        if (!full || !full.startsWith('sp.pref.')) continue;
        const key = full.slice('sp.pref.'.length);
        if (key !== LOADOUT_PREF && !key.startsWith(`${LOADOUT_PREF}.`)) continue;
        const version = loadoutVersionOfKey(key);
        if (!version || !safeKey(version)) continue;
        const raw = loadPref(key, null);
        if (loadoutHas(raw)) versions[version] = raw;
      }
    }
  } catch { /* private mode: keep whatever was read before */ }
  const base = versions[DEFAULT_VERSION];
  if (isObj(base) && base.v === LOADOUT_VERSION && loadoutHas(base)) {
    for (const v of VERSIONS) {
      if (v.id === DEFAULT_VERSION || Object.hasOwn(versions, v.id)) continue;
      // Do not overwrite a document a new client already wrote; only fill the versions this device has never seen.
      versions[v.id] = { ...base, seeded: true };
      const key = loadoutPrefKey(v.id);
      if (key) savePref(key, { ...base, seeded: true });
    }
  }
  return { v: LOADOUT_STORE_VERSION, versions };
}

/**
 * Write the merged per-version loadouts back to localStorage. Empty per-version documents are skipped; a version absent
 * from the merge result keeps its local copy.
 * @param {any} doc the outer document (or an old single v2 document for the default version)
 * @returns {number} versions written
 */
export function applyLocalLoadouts(doc) {
  const versions = loadoutVersions(doc);
  let written = 0;
  for (const [version, value] of Object.entries(versions)) {
    if (!safeKey(version) || !loadoutHas(value)) continue;
    const key = loadoutPrefKey(version);
    if (!key) continue;
    const clean = { ...value };
    delete clean.seeded;
    savePref(key, clean);
    written += 1;
  }
  return written;
}

/**
 * Read the browser's operator-related documents into a Cloud Save V2 envelope: ownership / 自选编队 (every version) /
 * skins. Empty blocks are omitted so an empty local device cannot overwrite another device's cloud data. Loadouts live
 * in profiles.loadouts and are read by readLocalLoadouts (one document per version).
 * @returns {{ v: number, ownership?: any, diy?: Record<string, any>, skins?: Record<string, string> }}
 */
export function readLocalExtras() {
  const out = { v: EXTRAS_VERSION };
  try {
    const ownership = loadPref('ownership', null);
    if (isObj(ownership) && ownership.v === OWNERSHIP_VERSION) {
      const chars = parseStoredOwnershipChars(ownership);
      if (chars.length) out.ownership = { v: OWNERSHIP_VERSION, notOwnedChars: chars };
    } else if (ownershipHas(ownership)) {
      // Never turn a v1 chess-id list into an empty v2 charId list (the Cloud Save V2 compatibility bug).
      out.ownership = { v: 1, notOwned: legacyOwnership(ownership) };
    }
  } catch { /* ignore */ }
  const diy = {};
  for (const [versionId, key] of localDiyKeys()) {
    if (!safeKey(versionId)) continue;
    try {
      const raw = loadPref(key, null);
      const parsed = parseStoredDiy(raw);
      if (hasKeys(parsed)) diy[versionId] = { v: DIY_VERSION, picks: parsed };
    } catch { /* ignore */ }
  }
  if (hasKeys(diy)) out.diy = diy;
  try {
    const skins = parseStoredSkins(loadPref('skins', null));
    if (hasKeys(skins)) out.skins = skins;
  } catch { /* ignore */ }
  return out;
}

/**
 * Apply a merged envelope to localStorage. Empty blocks are skipped, never written; this is the "空文档不参与写入"
 * rule that kept the old restore from clearing a local loadout.
 * @param {any} extras
 * @returns {{ ownership: boolean, diy: number, skins: boolean }}
 */
export function applyExtras(extras) {
  const out = { ownership: false, diy: 0, skins: false };
  if (!isObj(extras)) return out;
  if (isObj(extras.ownership)) {
    if (extras.ownership.v === 1 && Array.isArray(extras.ownership.notOwned)) {
      const legacy = legacyOwnership(extras.ownership);
      if (legacy.length) {
        savePref('ownership', { v: 1, notOwned: legacy });
        out.ownership = true;
      }
    } else if (ownershipHas(extras.ownership)) {
      const chars = parseStoredOwnershipChars(extras.ownership);
      if (chars.length) {
        savePref('ownership', { v: OWNERSHIP_VERSION, notOwnedChars: chars });
        out.ownership = true;
      }
    }
  }
  if (isObj(extras.diy)) {
    for (const [versionId, doc] of Object.entries(extras.diy)) {
      if (!safeKey(versionId)) continue;
      const picks = picksOf(doc);
      if (!hasKeys(picks)) continue;
      savePref(diyKeyForVersion(versionId), { v: DIY_VERSION, picks });
      out.diy += 1;
    }
  }
  if (isObj(extras.skins)) {
    const skins = parseStoredSkins(extras.skins);
    if (hasKeys(skins)) { savePref('skins', skins); out.skins = true; }
  }
  return out;
}

/** UTF-8 byte length of an extras envelope (the server's 96 KB block limit). */
export function extrasSize(extras) {
  try {
    const text = JSON.stringify(extras ?? {});
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    return text.length;
  } catch { return Infinity; }
}

/** Default version id used by the envelope (exported for callers that build version keys). */
export { DEFAULT_VERSION };
