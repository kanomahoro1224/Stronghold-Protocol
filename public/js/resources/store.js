// public/js/resources/store.js — the preload store: downloads the manifest's files into Cache Storage and reports what
// is already there (docs/ASSETS.md「Preload」).
//
// One cache (`CACHE_NAME`) holds every asset, whatever manifest it came from, and each file's *hash* decides whether the
// stored bytes are still current: an asset update re-downloads the changed files only (~310 MiB → a few MiB), and a
// re-run of the extraction or a redeploy with unchanged art costs nothing. The hashes of the stored files live in one
// index entry inside that cache, written as the run advances — an interrupted run keeps the progress it flushed.
//
// The page does the downloading (a plain `fetch` per file, stored with `cache.put`), so a page without a Service Worker
// still builds the cache and only *serving it from the cache* needs one. Files are fetched with `cache: 'no-store'` on
// purpose: they are stored in Cache Storage, and letting the HTTP cache keep a second copy would double the disk the
// browser needs (~250 MiB of art). Everything is injected (`caches`, `fetcher`) so this module is unit-testable.

import {
  CACHE_NAME, CACHE_PREFIX, CONTENT_HASH_RE, FILE_TIMEOUT_MS, MAX_FILE_BYTES, RESOURCE_GROUPS, TIER_ESSENTIAL,
  TIER_REST, absoluteUrl, abortError, checkAbort, indexUrl, isGoneError, isQuotaError, resourceGroup,
} from './common.js';
import { t } from '../../../shared/i18n.js';

/** Files above this go to the big-file lanes: a 20 MiB Spine texture should not race sixteen small ones. */
const BIG_FILE_BYTES = 4 << 20;
/** Default lanes for files up to BIG_FILE_BYTES — the settings 下载并发 select; the fallback when no caller passes one. */
export const DEFAULT_SMALL_LANES = 16;
/** The big-file lanes that go with DEFAULT_SMALL_LANES — the 4:1 ratio the defaults were picked with. */
export const DEFAULT_BIG_LANES = 4;
/**
 * The big-file lane count that belongs to `smallLanes`: a quarter of it, never less than one (16 → 4, 8 → 2, 4 → 1).
 * One lane per big file was the old rule and it made a 190 MiB Spine queue take as long as its slowest single file;
 * a quarter keeps a couple of them moving without letting four 20 MiB textures starve the small lanes. Exported so the
 * settings panel and the controller derive it exactly like the store does.
 * @param {number} smallLanes
 * @returns {number}
 */
export function bigLanesFor(smallLanes) {
  const small = Math.max(1, Math.trunc(Number(smallLanes) || DEFAULT_SMALL_LANES));
  return Math.max(1, Math.round(small / 4));
}
/** Failures kept for the UI (the count is always exact). */
const MAX_FAILURES = 10;
/** Successful files between two index writes (a flush is one put of a few KiB; 64 keeps an abort at ~1 % loss). */
const INDEX_FLUSH_EVERY = 64;

/**
 * The 12-hex SHA-1 of a response body — the same digest the server puts in the manifest (tools/asset-hashes.mjs,
 * tools/local-extract/extract.py). WebCrypto has no streaming digest, so one file is read at a time (Big files go
 * through the single big-file lane, so at most one of them is ever in memory).
 * @param {Response} response
 * @returns {Promise<string|null>} null when the browser cannot hash (no WebCrypto, an unreadable body)
 */
async function digestOf(response) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bits = await subtle.digest('SHA-1', await response.clone().arrayBuffer());
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  } catch {
    return null;
  }
}

export class ResourceStore {
  /**
   * @param {{ files: { url: string, tier: number, size?: number, hash?: string }[], version: string, totalBytes?: number|null }} manifest
   * @param {{ caches?: any, fetcher?: typeof fetch, origin?: string, smallLanes?: number, bigLanes?: number,
   *           fileTimeoutMs?: number, now?: () => number }} [opts] `bigLanes` defaults to `bigLanesFor(smallLanes)`
   */
  constructor(manifest, { caches = globalThis.caches, fetcher = globalThis.fetch?.bind(globalThis), origin, smallLanes = DEFAULT_SMALL_LANES, bigLanes = bigLanesFor(smallLanes), fileTimeoutMs = FILE_TIMEOUT_MS, now = () => Date.now() } = {}) {
    this.manifest = manifest;
    this.files = Array.isArray(manifest.files) ? manifest.files : [];
    this.caches = caches;
    this.fetcher = fetcher;
    this.origin = origin || globalThis.location?.origin || 'http://localhost';
    this.smallLanes = Math.max(1, smallLanes);
    this.bigLanes = Math.max(1, bigLanes);
    /** Per-file deadline (0 disables it — tests that script a fetcher by hand want no timers). */
    this.fileTimeoutMs = Number.isFinite(fileTimeoutMs) && fileTimeoutMs > 0 ? fileTimeoutMs : 0;
    this.now = now;
    this.cacheName = CACHE_NAME;
    /** @type {Promise<any> | null} */
    this.running = null;
  }

  /** Cache key (absolute URL) of a manifest entry. */
  keyOf(url) {
    return absoluteUrl(url, this.origin) || String(url);
  }

  /**
   * Import already-verified bytes (a ZIP package, `archive.js`) into this cache: the files a caller hands over were
   * checked against the CURRENT manifest's content hashes, and every one of them is re-checked here before it is
   * written, so a package can never install a version the server no longer serves. Callers own the download lock.
   * @param {{ url: string, tier: number, size?: number, hash?: string }[]} files
   * @param {{ read?: (file: any) => Promise<Response>, signal?: AbortSignal, onProgress?: (p: any) => void }} [opts]
   */
  async importFiles(files, { read, signal, onProgress } = {}) {
    checkAbort(signal);
    if (this.running) throw new Error('请先暂停资源下载');
    const cache = await this.caches.open(this.cacheName);
    const index = await this.#readIndex(cache);
    const before = await this.status();
    const allowed = new Set(this.files);
    let imported = 0;
    let processed = 0;
    // Build category counters only when the controller actually publishes a UI update.
    const getStatus = () => this.#tally(before.present, this.#goneSet(before.present, index));
    try {
      for (const file of files) {
        checkAbort(signal);
        const key = this.keyOf(file.url);
        if (!allowed.has(file) || !this.eligible(file) || !CONTENT_HASH_RE.test(file.hash || '')) {
          throw new Error('资源缺少可校验的当前指纹');
        }
        const existing = before.present.has(key) ? await cache.match(key) : null;
        if (!existing || await digestOf(existing) !== file.hash) {
          const response = await read(file);
          if (await digestOf(response) !== file.hash) throw new Error(`资源校验失败：${file.url}`);
          checkAbort(signal);
          await cache.put(key, this.storable(response));
          index.files[key] = file.hash;
          delete index.gone[key]; // the file is here now: a 404 record of an older run must not outlive it
          before.present.add(key);
          imported++;
          if (imported % INDEX_FLUSH_EVERY === 0) await this.#writeIndex(cache, index.files, this.manifest.version, index.gone);
        }
        onProgress?.({ imported, processed: ++processed, file, getStatus });
      }
    } finally {
      // A cancelled import or a quota error keeps completed, verified files reusable on the next run.
      await this.#writeIndex(cache, index.files, this.manifest.version, index.gone);
    }
    return { ...await this.status(), imported };
  }

  /**
   * The hashes of what this cache holds: `<absolute url>` → hash, plus `<absolute url>` → hash for the entries the
   * origin answered 404/410 for (`gone`). A missing or unreadable index means "nothing is verified", i.e. every entry is
   * fetched again — what the first run of this version and a cleared cache need.
   * @param {any} cache
   */
  async #readIndex(cache) {
    let doc = null;
    try {
      const res = await cache.match(indexUrl(this.origin));
      if (res) doc = await res.json();
    } catch { doc = null; }
    const files = doc && typeof doc === 'object' && doc.files && typeof doc.files === 'object' ? doc.files : null;
    const gone = doc && typeof doc === 'object' && doc.gone && typeof doc.gone === 'object' ? doc.gone : null;
    return {
      manifest: typeof doc?.manifest === 'string' ? doc.manifest : '',
      files: files ? { ...files } : {},
      gone: gone ? { ...gone } : {},
    };
  }

  /** Write the index entry (the only synthetic entry of the cache; the worker never answers it: not /assets|/fonts). */
  async #writeIndex(cache, files, manifest, gone = {}) {
    const body = JSON.stringify({ version: 2, manifest: String(manifest || ''), files, gone });
    await cache.put(indexUrl(this.origin), new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  }

  /**
   * A file this store will fetch: small enough to be worth caching (a huge one is skipped, never fails the run), and
   * one the manifest actually has bytes for. The generator records a size only for a file it found, so an entry
   * without one is a file the origin does not serve — fetching it is a guaranteed 404. The deployed manifest carried
   * 55 of them (36 /assets/ui/emoticon/**, 19 /assets/ui/guide/**), every one in tier 1, and the panel reported each
   * as a failure. Not eligible = counted as skipped, never requested.
   */
  eligible(file) {
    if (!Number.isSafeInteger(file.size)) return false;
    return file.size <= MAX_FILE_BYTES;
  }

  /** The response we store: original type, `Accept-Ranges` (the worker answers ranges) and our marker. */
  storable(response) {
    const headers = new Headers();
    const type = response.headers.get('content-type');
    if (type) headers.set('Content-Type', type);
    // A stored body must never claim a length it does not have: `fetch` hands us the DECODED body, so a compressed
    // transfer's Content-Length (372 for a 100 000-byte gzipped .skel) would describe the wrong bytes and the browser
    // would truncate it. Keep the header only when the response was not content-encoded — there it is exactly the
    // length we store (and DevTools' Cache Storage view can show a size instead of 0).
    if (!response.headers.get('content-encoding')) {
      const len = Number(response.headers.get('content-length'));
      if (Number.isSafeInteger(len) && len >= 0) headers.set('Content-Length', String(len));
    }
    headers.set('Accept-Ranges', 'bytes');
    headers.set('X-SP-Resource', '1');
    return new Response(response.body, { status: 200, statusText: 'OK', headers });
  }

  /**
   * What is already cached *and current*: `present` holds the absolute URLs whose stored bytes match the manifest's
   * hash, plus every counter the settings panel shows. An entry of another revision (or with no index record yet) does
   * not count, which is what makes the next run fetch it again.
   */
  async status() {
    const cache = await this.caches.open(this.cacheName);
    const cached = new Set((await cache.keys()).map((k) => k.url));
    const index = await this.#readIndex(cache);
    const fresh = this.#fresh(cached, index);
    const gone = this.#goneSet(fresh, index);
    return { ...this.#tally(fresh, gone), present: fresh };
  }

  /** The subset of `cached` whose recorded hash equals the manifest's (an entry without a hash counts as current). */
  #fresh(cached, index) {
    const fresh = new Set();
    for (const f of this.files) {
      const key = this.keyOf(f.url);
      if (!cached.has(key)) continue;
      if (f.hash && index.files[key] !== f.hash) continue;
      fresh.add(key);
    }
    return fresh;
  }

  /**
   * The entries this browser asked for and the origin said it does not have (404/410). They are remembered *with* the
   * manifest hash they were asked under: a redeploy that adds the file ships a new hash, the record stops matching and
   * the file is requested again — while a manifest that still lists a file nobody serves stops costing a request per
   * run (the deployed manifest once listed 1 685 such entries, 1 680 of them voice lines).
   */
  #goneSet(fresh, index) {
    const gone = new Set();
    for (const f of this.files) {
      const key = this.keyOf(f.url);
      if (fresh.has(key) || !f.hash) continue;
      if (index.gone[key] === f.hash) gone.add(key);
    }
    return gone;
  }

  /** Caches of earlier builds this app wrote: their entries carry no hash record and are verified before being kept. */
  async #olderCaches() {
    const names = (await this.caches.keys()) || [];
    return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== this.cacheName);
  }

  /**
   * Run `fn(innerSignal)` under both the caller's signal and a per-file deadline. Either one aborts the request, so a
   * socket that answers nothing costs one failed file instead of a frozen lane (`fileTimeoutMs`, common.js). The
   * deadline covers the body too: aborting the fetch breaks the stream `cache.put` is reading, so a stalled download
   * cannot hang inside the cache write either.
   */
  async #withDeadline(signal, fn) {
    const ctl = new AbortController();
    const onAbort = () => { try { ctl.abort(signal.reason instanceof Error ? signal.reason : abortError('aborted')); } catch { /* already aborted */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener?.('abort', onAbort, { once: true });
    }
    const timer = this.fileTimeoutMs ? setTimeout(() => {
      const secs = this.fileTimeoutMs >= 1000 ? t('（{0} 秒）', { 0: Math.round(this.fileTimeoutMs / 1000) }) : '';
      try { ctl.abort(new Error(`响应超时${secs}`)); } catch { /* already aborted */ }
    }, this.fileTimeoutMs) : null;
    try {
      return await fn(ctl.signal);
    } finally {
      if (timer !== null) clearTimeout(timer);
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* a signal stub without the method */ }
    }
  }

  /**
   * `promise`, but rejected once `ms` passes. The per-file `fetch` already runs under `#withDeadline`; this is the guard
   * for the one step that has no deadline of its own — adopting a file out of an older cache (`#adopt` reads Cache
   * Storage, which can stall on a broken profile). Without it a single stalled file freezes its lane for good: the run
   * never settles, the panel stays on 「正在后台预载…」 with the counters of the last emit, and no progress is ever
   * published again. On timeout the file is counted as failed and the lane moves on. (The label stays ASCII: the i18n
   * scan rejects an unwrapped Chinese literal, and this error never reaches a player — `#download` only counts it.)
   */
  #withTimeout(promise, ms, what) {
    if (!ms) return promise;
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, guard]).finally(() => { if (timer !== null) clearTimeout(timer); });
  }

  /** Fetch a file and hand back a storable response (an opaque or empty or failed answer throws). */
  async #fetchStorable(url, signal) {
    const res = await this.fetcher(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal });
    if (res.type === 'opaque' || !res.body) throw new Error('响应不可读取（缺少 CORS 头或空响应）');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  /**
   * Rescue a file from a cache of the previous layout instead of downloading it again: hash the stored bytes and, when
   * they are exactly the revision this manifest wants, move the entry into the current cache. A mismatching entry is
   * dropped (the caller downloads the right bytes next) so a stale copy can never shadow the fresh one.
   * @returns {Promise<boolean>} true when the file needed no network at all
   */
  async #adopt(file, cache, older) {
    if (!older.length || !file.hash || !CONTENT_HASH_RE.test(file.hash)) return false; // nothing to compare against
    const key = this.keyOf(file.url);
    for (const name of older) {
      const other = await this.caches.open(name);
      const hit = await other.match(key);
      if (!hit) continue;
      if ((await digestOf(hit)) === file.hash) {
        await cache.put(key, hit); // same bytes, now in the current cache…
        await other.delete(key); // …and gone from the old one: never two copies, never a stale shadow
        return true;
      }
      await other.delete(key);
      return false;
    }
    return false;
  }

  /**
   * Counters for a set of cached URLs (shared by status() and clear(), which must not re-create a cache). `goneNow` are
   * the entries the origin answered 404/410 for: they are counted separately — never as cached — but they *do* settle
   * `complete`, because a manifest that lists a file nobody serves would otherwise never reach 100 %.
   *
   * `groups` is the same tally per resource category (common.js `resourceGroup`), each entry carrying the tier of the
   * FILE it collected — a category the server splits across tiers (avatars essential, portraits optional) is listed in
   * both sections, with the numbers of the section it is in. `id` is the category, `gid` the category *and* tier: the
   * settings panel keys on `gid`, so one category can appear twice.
   */
  #tally(present, goneNow = new Set()) {
    const total = this.files.length;
    let count = 0;
    let gone = 0;
    let bytes = 0;
    let sized = 0;
    let skipped = 0;
    let tier1 = 0;
    let tier1Present = 0;
    let tier1Gone = 0;
    let tier2 = 0;
    let tier2Present = 0;
    let tier2Gone = 0;
    let tier1Wanted = 0;
    let tier2Wanted = 0;
    /** @type {Map<string, any>} */
    const groups = new Map();
    for (const f of this.files) {
      const key = this.keyOf(f.url);
      const hit = present.has(key);
      const isGone = !hit && goneNow.has(key);
      const essential = f.tier === TIER_ESSENTIAL;
      if (essential) tier1++; else tier2++;
      const id = resourceGroup(f);
      const gid = `${f.tier}:${id}`;
      let group = groups.get(gid);
      if (!group) {
        group = { gid, id, tier: f.tier, ...RESOURCE_GROUPS[id],
          total: 0, wanted: 0, present: 0, gone: 0, bytes: 0, totalBytes: 0, unknownSize: 0 };
        groups.set(gid, group);
      }
      group.total++;
      if (!this.eligible(f)) { skipped++; continue; }
      group.wanted++;
      if (Number.isSafeInteger(f.size)) group.totalBytes += f.size;
      else group.unknownSize++;
      if (essential) tier1Wanted++; else tier2Wanted++;
      if (hit) {
        count++;
        group.present++;
        if (essential) tier1Present++; else tier2Present++;
        if (Number.isSafeInteger(f.size)) { bytes += f.size; sized++; group.bytes += f.size; }
      } else if (isGone) {
        gone++;
        group.gone++;
        if (essential) tier1Gone++; else tier2Gone++;
      }
    }
    const wanted = total - skipped;
    return {
      version: this.manifest.version,
      cacheName: this.cacheName,
      count,
      gone,
      total,
      wanted,
      skipped,
      bytes,
      totalBytes: Number.isSafeInteger(this.manifest.totalBytes) ? this.manifest.totalBytes : null,
      sized,
      sizedTotal: Number.isSafeInteger(this.manifest.sized) ? this.manifest.sized : null,
      tier1,
      tier1Present,
      tier1Gone,
      tier2,
      tier2Present,
      tier2Gone,
      tier1Wanted,
      tier2Wanted,
      groups: [...groups.values()].filter((g) => g.total > 0),
      complete: wanted > 0 && count + gone >= wanted,
    };
  }

  /**
   * Download every missing file (essential tier first). Aborting the signal stops within one file; single file failures
   * are collected instead, so one broken file cannot waste a whole run.
   * @param {{ signal?: AbortSignal, onProgress?: (p: any) => void, tiers?: number[] }} [opts]
   */
  download({ signal, onProgress, tiers = [TIER_ESSENTIAL, TIER_REST] } = {}) {
    if (this.running) return this.running;
    const run = this.#download({ signal, onProgress, tiers }).finally(() => { this.running = null; });
    this.running = run;
    return run;
  }

  async #download({ signal, onProgress, tiers }) {
    const wanted = new Set(tiers);
    const cache = await this.caches.open(this.cacheName);
    const index = await this.#readIndex(cache);
    const start = await this.status();
    checkAbort(signal);
    // Entries the origin answered 404/410 for (recorded against this manifest's hash) are left alone: asking again would
    // cost one request per entry per run and cannot succeed while the manifest keeps listing a file nobody serves.
    const goneKeys = this.#goneSet(start.present, index);
    const work = this.files.filter((f) => wanted.has(f.tier) && this.eligible(f)
      && !start.present.has(this.keyOf(f.url)) && !goneKeys.has(this.keyOf(f.url)));
    let done = start.count;
    let bytes = start.bytes;
    let sized = start.sized;
    let failed = 0;
    /** Entries this run asked for and the origin 404'd: remembered in the index so the next run skips them. */
    let gone = 0;
    let tier1Done = start.tier1Present;
    let tier2Done = start.tier2Present;
    let pendingFlush = 0;
    // Migration and network traffic are reported separately: the panel says "整理已保存的资源" while nothing is fetched.
    let adopted = 0;
    let downloaded = 0;
    /** @type {{ url: string, message: string }[]} */
    const failures = [];
    let lastEmit = 0;
    // Exactly the counters of status(): the UI maps one shape for both, so a field can never be missing mid-run.
    const progress = (current = null) => ({
      phase: 'download', count: done, total: start.total, wanted: start.wanted, skipped: start.skipped,
      bytes, totalBytes: start.totalBytes, sized, sizedTotal: start.sizedTotal,
      tier1: start.tier1, tier1Present: tier1Done, tier2: start.tier2, tier2Present: tier2Done,
      tier1Wanted: start.tier1Wanted, tier2Wanted: start.tier2Wanted,
      tier1Gone: start.tier1Gone, tier2Gone: start.tier2Gone,
      groups: this.#tally(start.present, goneKeys).groups,
      complete: false, failed, failures: failures.slice(), current, adopted, downloaded, gone: start.gone + gone,
    });
    const emit = (current = null, force = false) => {
      if (!onProgress) return;
      const t = this.now();
      if (!force && t - lastEmit < 120) return;
      lastEmit = t;
      onProgress(progress(current));
    };
    emit(null, true);
    if (work.length) {
      // the manifest is sorted essential-first, so a plain order keeps tier 1 ahead of tier 2
      const small = [];
      const big = [];
      for (const f of work) (Number.isSafeInteger(f.size) && f.size > BIG_FILE_BYTES ? big : small).push(f);
      // Caches of the pre-hash layout: their entries are verified (and moved) before anything is fetched.
      const older = await this.#olderCaches();
      const one = async (file) => {
        checkAbort(signal);
        const key = this.keyOf(file.url);
        try {
          if (await this.#withTimeout(this.#adopt(file, cache, older), this.fileTimeoutMs, 'adopt')) adopted++;
          else {
            // Everything network-touching of this file runs under the per-file deadline, including the cache write.
            await this.#withDeadline(signal, async (inner) => {
              let res = await this.#fetchStorable(key, inner);
              // `cache: 'no-store'` bypasses the HTTP cache, not Cache Storage: a Service Worker of an older build may
              // answer this fetch out of its own cache (and a stale one at that). Verify the bytes against the manifest
              // hash and, when they disagree, ask again on a URL no cache entry can match — the worker matches full URLs.
              // If the second answer still disagrees the asset hashes are stale (tools/asset-hashes.mjs --check catches
              // that before a deploy): keep the bytes rather than failing the file, and record the manifest's hash.
              if (file.hash && CONTENT_HASH_RE.test(file.hash)) {
                const seen = await digestOf(res);
                if (seen && seen !== file.hash) {
                  res = await this.#fetchStorable(`${key}${key.includes('?') ? '&' : '?'}sp=${file.hash}`, inner);
                }
              }
              await cache.put(key, this.storable(res));
            });
            downloaded++;
          }
          // The file is current only once the index says so: a run stopped before its next flush re-fetches this one.
          if (file.hash) {
            index.files[key] = file.hash;
            delete index.gone[key]; // it answered this time (a redeploy may have added it): drop the 404 record
            if (++pendingFlush >= INDEX_FLUSH_EVERY) { pendingFlush = 0; await this.#writeIndex(cache, index.files, this.manifest.version, index.gone); }
          }
          done++;
          start.present.add(key);
          if (file.tier === TIER_ESSENTIAL) tier1Done++; else tier2Done++;
          if (Number.isSafeInteger(file.size)) { bytes += file.size; sized++; }
        } catch (err) {
          checkAbort(signal); // an abort wins over a per-file error: the run is being stopped
          if (isQuotaError(err)) {
            const quota = new Error('quota exceeded');
            quota.name = 'QuotaExceededError';
            quota.cause = err;
            throw quota;
          }
          if (isGoneError(err)) {
            // The origin says it does not have this file (HTTP 404/410): remember it against the manifest hash, so the
            // next run skips it instead of spending one request per entry per run (the live manifest listed 1 685).
            gone++;
            if (file.hash) { index.gone[key] = file.hash; goneKeys.add(key); }
          } else {
            failed++;
            if (failures.length < MAX_FAILURES) failures.push({ url: file.url, message: String(err?.message || err) });
          }
        }
        emit(file.url);
      };
      const drain = async (list, lanes) => {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(lanes, list.length) }, async () => {
          for (let i = next++; i < list.length; i = next++) await one(list[i]);
        }));
      };
      try {
        await drain(small, this.smallLanes);
        await drain(big, this.bigLanes);
        checkAbort(signal);
      } finally {
        // Flush on every exit — an abort or a quota failure included: the files stored so far must count as current
        // next time (and the 404 records must survive, or the next run pays for the same missing entries again). A
        // failing write only costs re-downloading them.
        try { await this.#writeIndex(cache, index.files, this.manifest.version, index.gone); } catch { /* out of storage: the run is already failing */ }
      }
    } else {
      checkAbort(signal);
    }
    const after = await this.status();
    const result = { ...after, phase: 'ready', failed, failures: failures.slice(), adopted, downloaded };
    onProgress?.(result);
    // Only a complete set may drop anything: a partial run never deletes files it did not replace.
    if (result.complete) await this.prune();
    return result;
  }
  /** Delete every cache this app owns, of every version — 「清理缓存」 in the settings panel. Never re-creates one. */
  async clear() {
    if (this.caches?.keys) {
      const names = await this.caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => this.caches.delete(n)));
    }
    return { ...this.#tally(new Set()), present: new Set() };
  }

  /** Drop the caches of other versions (a new asset manifest frees the files of the previous one). */
  async pruneOld() {
    const names = (await this.caches.keys()) || [];
    const stale = names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== this.cacheName);
    await Promise.all(stale.map((n) => this.caches.delete(n)));
    return stale;
  }

  /**
   * Delete cached entries that the manifest no longer lists (a file that was renamed or dropped would otherwise sit in
   * the cache forever, and its index record with it). Older caches are only cleaned up once they held no serviceable
   * entry at all — i.e. after the migration of this run moved or dropped what it could.
   */
  async pruneStale() {
    const cache = await this.caches.open(this.cacheName);
    const wanted = new Set(this.files.map((f) => this.keyOf(f.url)));
    const indexKey = indexUrl(this.origin);
    const keys = await cache.keys();
    const doomed = keys.filter((k) => k.url !== indexKey && !wanted.has(k.url));
    if (!doomed.length) return 0;
    await Promise.all(doomed.map((k) => cache.delete(k)));
    const index = await this.#readIndex(cache);
    for (const k of doomed) { delete index.files[k.url]; delete index.gone[k.url]; }
    await this.#writeIndex(cache, index.files, this.manifest.version, index.gone);
    return doomed.length;
  }

  /**
   * Housekeeping after a complete run: other caches (the version-named layout of earlier builds) and the entries this
   * manifest dropped. `includeStale: false` is used from a download, where the cache was just brought up to date.
   */
  async prune(includeStale = true) {
    const caches = await this.pruneOld();
    const files = includeStale ? await this.pruneStale() : 0;
    return { caches, files };
  }
}
