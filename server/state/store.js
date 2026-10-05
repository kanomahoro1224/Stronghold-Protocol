// server/state/store.js — the tiny pluggable KV the match-state persistence (P0/P1) is built on.
//
// Scope (DESIGN: match-state persistence, P0+P1): ONE record per match, written from a single-writer queue
// (server/state/persist.js) and read back at boot (server/state/resume.js). No queries, no transactions, no
// secondary indexes: `put` / `get` / `del` / `list(prefix)` / `close`, all async, all of them cheap.
//
// Backends, selected by `SP_STATE` (default `file`):
//
//   file    one JSON file per key under `SP_STATE_DIR` (default <repo>/state/matches/). `put` is atomic — the record
//           is written to a temp file in the same directory and renamed over the target, so a crash mid-write can
//           never leave a half-record behind (the temp file is unlinked on failure). One JSON document per file also
//           keeps the crash window to a single rename and makes a partially written file impossible to observe.
//   memory  in-process Map. Tests only: nothing survives a restart, which is exactly the feature under test.
//   redis   NOT IMPLEMENTED on purpose — a documented stub that throws rather than a dependency (the repo has a hard
//           "zero new npm dependencies" rule). `createStore({ backend: 'redis' })` throws; it never silently degrades.
//
// `list(prefix)` is a directory scan, not an index file: an index would be a second thing to keep in sync with the
// records and a second thing to corrupt, and the record count is bounded by the room cap (hundreds, not millions).
// Keys are restricted to `[A-Za-z0-9_.:-]` and file names are `encodeURIComponent(key) + '.json'`, so a key can never
// escape the state directory.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (server/state/ → ../..). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default state directory (`SP_STATE_DIR` overrides it). */
export const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'matches');

/** Backends `createStore` accepts. */
export const STORE_BACKENDS = Object.freeze(['file', 'memory', 'redis']);

/**
 * The key alphabet: no path separators, bounded length, and no LEADING dot — the file of a leading-dot key
 * (`.hidden.json`) would look like a temp file and be invisible to `list`, so such a key is refused outright.
 */
const KEY_RE = /^[A-Za-z0-9_:][A-Za-z0-9_.:-]{0,95}$/;

/** @param {unknown} key */
export const isStateKey = (key) => typeof key === 'string' && KEY_RE.test(key);

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** The `SP_STATE` value → backend name. An unknown value is a typo, not a silent fallback. */
export function parseBackend(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'file';
  if (s === 'off' || s === 'none' || s === '0' || s === 'false') return 'off';
  if (STORE_BACKENDS.includes(s)) return s;
  throw new RangeError(`unknown SP_STATE backend ${JSON.stringify(v)} (use ${STORE_BACKENDS.join('|')}|off)`);
}

/** A key that can never be written (logs once, returns false) — a programming error, not a runtime condition. */
function badKey(key) {
  return !isStateKey(key);
}

// ---------------------------------------------------------------------------------------------------
// file backend
// ---------------------------------------------------------------------------------------------------

export class FileStore {
  /** @param {{ dir?: string, log?: object }} [opts] */
  constructor({ dir = DEFAULT_STATE_DIR, log = noopLog } = {}) {
    this.kind = 'file';
    /** @type {string} */
    this.dir = path.resolve(dir);
    this.log = log;
    /** @type {Promise<void> | null} the one mkdir in flight/done */
    this._ready = null;
    this._seq = 0;
  }

  /** Create the directory once (lazily: a store nothing writes to never touches the disk). */
  _prepare() {
    if (!this._ready) this._ready = fsp.mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this._ready;
  }

  /** @param {string} key */
  _file(key) { return path.join(this.dir, `${encodeURIComponent(key)}.json`); }

  /**
   * Atomic put: temp file in the SAME directory, then `rename` over the target (rename is atomic within a
   * filesystem, which is why the temp file may not live in os.tmpdir()).
   * @param {string} key @param {unknown} obj
   */
  async put(key, obj) {
    if (badKey(key)) throw new TypeError(`state store: bad key ${JSON.stringify(key)}`);
    const json = JSON.stringify(obj);
    if (json === undefined) throw new TypeError(`state store: ${key} is not JSON-serializable`);
    await this._prepare();
    const final = this._file(key);
    const tmp = path.join(this.dir, `.${encodeURIComponent(key)}.${process.pid}.${++this._seq}.tmp`);
    try {
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, final);
    } catch (e) {
      try { await fsp.rm(tmp, { force: true }); } catch { /* the temp file is best-effort cleanup */ }
      throw e;
    }
  }

  /**
   * @param {string} key
   * @returns {Promise<any | null>} the record, or null when it is absent (or unreadable/corrupt: a broken record must
   *   never take the boot down — it is reported and skipped, like an expired one)
   */
  async get(key) {
    if (badKey(key)) return null;
    let text;
    try {
      text = await fsp.readFile(this._file(key), 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      this.log.warn?.(`[state] read ${key} failed: ${e && e.message ? e.message : e}`);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      this.log.warn?.(`[state] ${key} is corrupt (${e && e.message ? e.message : e}) — ignored`);
      return null;
    }
  }

  /** @param {string} key */
  async del(key) {
    if (badKey(key)) return false;
    try {
      await fsp.rm(this._file(key), { force: true });
      return true;
    } catch (e) {
      this.log.warn?.(`[state] delete ${key} failed: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  /**
   * Every key starting with `prefix`, sorted. A directory scan: temp files (leading dot / no `.json` suffix) are
   * invisible by construction, so a crash mid-write can never show up as a phantom record.
   * @param {string} [prefix]
   * @returns {Promise<string[]>}
   */
  async list(prefix = '') {
    let names;
    try {
      names = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return []; // nothing was ever written
      this.log.warn?.(`[state] list ${this.dir} failed: ${e && e.message ? e.message : e}`);
      return [];
    }
    const out = [];
    for (const d of names) {
      if (!d.isFile() || d.name.startsWith('.') || !d.name.endsWith('.json')) continue;
      let key;
      try { key = decodeURIComponent(d.name.slice(0, -'.json'.length)); } catch { continue; }
      if (!isStateKey(key) || !key.startsWith(prefix)) continue;
      out.push(key);
    }
    return out.sort();
  }

  /** Nothing is held open (every op is one writeFile/rename/readFile) — kept for the store interface. */
  async close() {}

  /** True when the directory exists (diagnostics/tests). */
  get exists() { return fs.existsSync(this.dir); }
}

// ---------------------------------------------------------------------------------------------------
// memory backend (tests)
// ---------------------------------------------------------------------------------------------------

export class MemoryStore {
  /** @param {{ log?: object }} [opts] */
  constructor({ log = noopLog } = {}) {
    this.kind = 'memory';
    this.log = log;
    /** @type {Map<string, string>} */
    this.map = new Map();
    this.writes = 0;
    this.deletes = 0;
  }

  async put(key, obj) {
    if (badKey(key)) throw new TypeError(`state store: bad key ${JSON.stringify(key)}`);
    this.map.set(key, JSON.stringify(obj));
    this.writes++;
  }

  async get(key) {
    if (badKey(key)) return null;
    const s = this.map.get(key);
    if (s === undefined) return null;
    try { return JSON.parse(s); } catch { return null; }
  }

  async del(key) {
    this.deletes++;
    return this.map.delete(key);
  }

  async list(prefix = '') { return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort(); }

  async close() {}
}

// ---------------------------------------------------------------------------------------------------
// redis backend (documented stub)
// ---------------------------------------------------------------------------------------------------

/**
 * Redis backend placeholder. It is deliberately NOT implemented: the design keeps Redis as the multi-process follow-up
 * (P2), and reaching it requires a client package, which this repo does not take. Constructing it throws, so a
 * deployment that sets `SP_STATE=redis` fails loudly at boot instead of running with persistence silently switched off.
 */
export class RedisStore {
  /** @param {object} [_opts] */
  constructor(_opts = {}) {
    throw new Error('server/state/store.js: the "redis" backend is not implemented — use SP_STATE=file (or memory)');
  }
}

/** A store that drops every write: `SP_STATE=off`, or a bootstrap failure the caller chose to tolerate. */
export class NullStore {
  constructor() { this.kind = 'off'; this.dropped = 0; }
  async put() { this.dropped++; }
  async get() { return null; }
  async del() { return false; }
  async list() { return []; }
  async close() {}
}

/**
 * Build the configured store.
 * @param {{ backend?: string, dir?: string, log?: object }} [opts] `backend` defaults to `process.env.SP_STATE`
 * @returns {FileStore | MemoryStore | NullStore}
 */
export function createStore({ backend, dir, log = noopLog } = {}) {
  const kind = parseBackend(backend !== undefined ? backend : process.env.SP_STATE);
  if (kind === 'off') return new NullStore();
  if (kind === 'memory') return new MemoryStore({ log });
  if (kind === 'redis') return new RedisStore({ dir, log });
  return new FileStore({ dir: dir || process.env.SP_STATE_DIR || DEFAULT_STATE_DIR, log });
}
