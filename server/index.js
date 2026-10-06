// server/index.js — process entry & boot (DESIGN §1, §2).
//
//   * node:http static server:  /        → public/      (index.html for directories)
//                                /data/   → data/        (generated game data)
//                                /shared/ → shared/      (ESM shared with the browser)
//                                /sim/    → server/sim/  (the battle simulation, read-only, `.js` only — client-side
//                                                         combat, DESIGN §14; the Node-only loader nodeData.js is not served)
//                                /data.js → a generated browser stand-in of server/data.js (the sim's content modules
//                                           import `../../../data.js`; in the browser it serves the data injected with
//                                           /sim/simdata.js setSimData). No other server file is ever served.
//                                /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 — the same audio files, addressed
//                                           **without** an extension so download managers (IDM / 迅雷 …) stop popping a
//                                           "下载文件信息" dialog for every BGM track (shared/media.js, public/js/media.js)
//     MIME types incl. .mjs/.js text/javascript, .skel application/octet-stream, .atlas text/plain;
//     gzip for text-like types, .skel and uncompressed fonts when the client accepts it (small files are
//     compressed once and cached in memory); strong ETag + Last-Modified with 304s; Cache-Control
//     (html & code/data: no-cache + revalidate; public/assets|fonts|vendor: 1 day; any `?v=` URL: immutable);
//     single byte-range requests (206/416, used by <audio>); traversal & dotfile protection; 404 page.
//   * GET /healthz → JSON status (protocol `version`, release `app`, rooms, matches, sessions, sockets).
//   * WebSocket (ws) at /ws, maxPayload 64 KB → server/net.js Network → server/lobby.js Lobby.
//   * Env: PORT (default 3000), HOST (default 0.0.0.0), TRUST_PROXY ('auto' default: honour CF-Connecting-IP /
//     X-Real-IP / X-Forwarded-For only from loopback/private peers such as a local cloudflared; '1' always; '0' never).
//     Prints LAN URLs on boot.
//   * Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
//     (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//   * Graceful shutdown on SIGINT/SIGTERM (rooms get room.closed{reason:'shutdown'}, sockets close 1001).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from './net.js';
import { Lobby, LOBBY_DEFAULTS } from './lobby.js';
import { getData, loadData } from './data.js';
import { createStore } from './state/store.js';
import { PersistQueue, DEFAULT_MAX_PENDING } from './state/persist.js';
import { StateBridge, loadResumable, rulesHash, recordTtlMs } from './state/resume.js';
import { PROTOCOL_VERSION, APP_VERSION } from '../shared/constants.js';
import { MEDIA_PREFIX, AUDIO_EXTS } from '../shared/media.js';

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/**
 * Event-loop delay, as `/healthz.loop` reports it: the single-threaded process pays for every hosted battle on the
 * same core that answers players, so this is the number that says whether the box still has headroom (DESIGN §23).
 * Enabled lazily on the first read and reset between reads, so the figures describe "since the last check" (a
 * rolling window of at most LOOP_WINDOW_MS) instead of everything since boot. The 10 ms sampling resolution puts a
 * floor of roughly that under `p50`, so `p99`/`max` are the signals worth alarming on (a stalled poll on the live
 * box reads as 100s of ms; measured 411 ms for a deliberate 400 ms block).
 */
export const LOOP_WINDOW_MS = 10_000;
let loopHist = null;
let loopResetAt = 0;
export function loopStats() {
  if (!loopHist) {
    loopHist = monitorEventLoopDelay({ resolution: 10 });
    loopHist.enable();
    if (typeof loopHist.unref === 'function') loopHist.unref(); // a diagnostic must never hold the process open
    loopResetAt = Date.now();
    return { p50: 0, p99: 0, max: 0, windowMs: 0 };
  }
  const ms = (ns) => Math.round(ns / 1e5) / 10; // ns → ms with one decimal
  const now = Date.now();
  const windowMs = now - loopResetAt;
  const out = { p50: ms(loopHist.percentile(50)), p99: ms(loopHist.percentile(99)), max: ms(loopHist.max), windowMs };
  if (windowMs >= LOOP_WINDOW_MS) { loopResetAt = now; loopHist.reset(); }
  return out;
}

/**
 * Process memory for `/healthz.mem`, reduced to two small numbers in MB: the resident set (what the box pays for) and
 * the used heap (what the GC will hand back). One `process.memoryUsage()` call is cheap and /healthz is polled every
 * 60 s by every open page, so nothing more verbose (no heap spaces, no external/arrayBuffers) goes over the wire.
 */
export function memStats() {
  const m = process.memoryUsage();
  const mb = (bytes) => Math.round((Number(bytes) || 0) / 1048576);
  return { rss: mb(m.rss), heap: mb(m.heapUsed) };
}

/** The live state bridge of the last `startServer` (there is one per process in production); /healthz reads it. */
let stateProbe = null;

/**
 * Match-state persistence counters for `/healthz.state` (P0/P1, server/state/*): the write queue's depth and totals,
 * the last write error (null while healthy — the field worth alarming on) and how many persisted matches this process
 * has loaded as resumable (`resumedCount`; `resumed` says whether a returning player may actually be put back into
 * one). Reading it is a few property reads — /healthz is polled by every open page.
 */
export function stateStats() {
  const idle = { queued: 0, written: 0, dropped: 0, errors: 0, lastError: null, resumedCount: 0, resumed: false, store: 'off' };
  try {
    return stateProbe ? stateProbe.stats() : idle;
  } catch {
    return { ...idle, store: 'error' };
  }
}

/** A truthy env flag (`1/true/yes/on`). */
function envFlag(v, dflt = false) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

/**
 * Build the persistence bridge of this process. `config === false` disables it outright (tests, `SP_STATE=off`); a
 * backend failure degrades to a disabled bridge with one error line — a broken state directory must never take the
 * server down (persistence is a recovery aid, not a dependency of the live match loop).
 * @param {{ config?: false | object, log: object }} opts
 * @returns {StateBridge}
 */
function createStateBridge({ config, log }) {
  if (config === false) return StateBridge.disabled('off');
  const cfg = config && typeof config === 'object' ? config : {};
  // Under the Node test runner (`node --test`) persistence defaults to OFF unless the backend is set explicitly
  // (SP_STATE=... or startServer({ state: {...} })): the existing suites boot real servers on the real state
  // directory, and a test run must not write records into the working tree.
  if (cfg.backend == null && process.env.NODE_TEST_CONTEXT && process.env.SP_STATE == null) {
    return StateBridge.disabled('test');
  }
  try {
    const store = createStore({ backend: cfg.backend, dir: cfg.dir, log });
    const persist = new PersistQueue({
      store,
      maxPending: cfg.maxPending ?? (Number(process.env.SP_STATE_MAX_PENDING) || DEFAULT_MAX_PENDING),
      log,
    });
    const bridge = new StateBridge({
      store,
      persist,
      // the version gate: a record is only resumable by the build + rules that wrote it (server/state/resume.js)
      build: buildTag(),
      rulesHash: rulesHash(),
      ttlMs: recordTtlMs(),
      resume: cfg.resume !== undefined ? !!cfg.resume : envFlag(process.env.SP_STATE_RESUME),
      log,
    });
    bridge.startSweeper();
    return bridge;
  } catch (e) {
    log.error(`[state] persistence disabled (${e && e.message ? e.message : e})`);
    return StateBridge.disabled('error');
  }
}

/** Browser stand-in of server/data.js, served at /data.js (see the header). */
export const DATA_SHIM_JS = `// Generated by server/index.js — browser stand-in for server/data.js (DESIGN §14 client-side combat).
// The simulation's content modules (/sim/content/support/index.js) import getData() from here; it returns the game data
// the page injected with /sim/simdata.js setSimData(data).
import { getSimData } from './sim/simdata.js';
export function getData() { return getSimData() || {}; }
export function resetData() {}
`;
/** Files under server/sim that are never served (Node-only). */
const SIM_PRIVATE = new Set(['nodedata.js']); // lower-case (compared case-insensitively)

/** Extension → Content-Type. */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
});

/** Extensions worth gzipping (text-like, .skel, uncompressed fonts). */
export const COMPRESSIBLE = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.md', '.csv', '.xml',
  '.atlas', '.skel', '.bin', '.wasm', '.svg', '.ico', '.otf', '.ttf', '.wav',
]);

const GZIP_MIN_BYTES = 512;
const GZIP_CACHE_MAX_FILE = 8 << 20;      // larger files are gzip-streamed on the fly
const GZIP_CACHE_MAX_TOTAL = 96 << 20;
// Asset URLs carry no content hash yet, and tools/fetch-assets.mjs / tools/vendor.mjs can rewrite files in
// place (atlas + png + skel must stay consistent), so "long" is one day; revalidation after that is a cheap 304.
const LONG_CACHE = 'public, max-age=86400';          // 1 day
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const LONG_CACHE_DIRS = ['assets', 'fonts', 'vendor']; // first path segment under public/
const MAX_URL_LENGTH = 4096;

// ---------------------------------------------------------------------------------------------------
// build tag — the "your page is stale" signal (public/js/ui/buildGuard.js)
// ---------------------------------------------------------------------------------------------------

/**
 * The files that make up the runtime the BROWSER loads. A change in any of them is a new build: an already-open page
 * keeps the modules it imported at load time (ES modules live in the page's module map for its whole lifetime), so
 * without this signal a deployed fix could never reach a player who does not reload — a client-only battle fix
 * shipped exactly that way and stayed invisible on a page that had been opened before the deploy.
 *
 * `server/`, `data/` and `shared/` are deliberately NOT in here: this process read them once at startup, so when they
 * change without a restart the server still runs the old simulation and data — a page that reloaded into the new files
 * would be out of step with the server that validates its battles (and DEPLOY.md restarts the server for every update).
 */
export const BUILD_INPUTS = Object.freeze(['public/index.html', 'public/js', 'public/css']);

/** Names the static server never serves: dot files (`.DS_Store`, `.main.js.swp`) and editor backups (`main.js~`). */
const isIgnoredBuildName = (name) => name.startsWith('.') || name.endsWith('~');

/** @type {{ tag: string|null }|null} */
let buildCache = null;

/** Every file under `abs` (or `abs` itself), as `[relative path, size, mtimeMs]`, sorted by path. Missing → []. */
function buildEntries(abs, rel, out) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return; }
  if (stat.isFile()) { out.push([rel, stat.size, stat.mtimeMs]); return; }
  if (!stat.isDirectory()) return;
  let names;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const d of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (isIgnoredBuildName(d.name)) continue;
    const child = path.join(abs, d.name);
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) buildEntries(child, childRel, out);
    else if (d.isFile()) { try { const s = fs.statSync(child); out.push([childRel, s.size, s.mtimeMs]); } catch { /* ignore */ } }
  }
}

/** Short hash of the served browser runtime (size + mtime of every BUILD_INPUTS file); null when nothing is readable. */
export function computeBuildTag(root = ROOT) {
  const out = [];
  for (const rel of BUILD_INPUTS) buildEntries(path.join(root, rel), rel, out);
  if (!out.length) return null;
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha1');
  for (const [rel, size, mtime] of out) h.update(`${rel}\0${size}\0${Math.floor(mtime)}\n`);
  return h.digest('hex').slice(0, 12);
}

/**
 * The build tag of THIS process. Computed once (`startServer` warms it at startup): the tag describes the files the
 * process is actually serving, every update restarts the server (DEPLOY.md), and re-reading the tree on a timer would
 * let a half-finished deploy — or a file that changed while the process kept running — move the tag under a page.
 * @param {string} [root] used by the first call only (tests)
 */
export function buildTag(root = ROOT) {
  if (buildCache === null) buildCache = { tag: computeBuildTag(root) };
  return buildCache.tag;
}

/** Drop the cache: the next `buildTag()` re-reads the tree (tests, and `startServer`). */
export function resetBuildTag() { buildCache = null; }

const gzipAsync = promisify(zlib.gzip);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// gzip cache (LRU by bytes)
// ---------------------------------------------------------------------------------------------------

class GzipCache {
  constructor(maxTotal = GZIP_CACHE_MAX_TOTAL) {
    this.maxTotal = maxTotal;
    this.total = 0;
    /** @type {Map<string, Buffer>} */ this.map = new Map();
    /** @type {Map<string, Promise<Buffer>>} */ this.inflight = new Map();
  }

  /** @returns {Promise<Buffer>} gzip of the file identified by (path, size, mtime) */
  get(absPath, stat) {
    const key = `${absPath}\0${stat.size}\0${stat.mtimeMs}`;
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); return Promise.resolve(hit); }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const raw = await fsp.readFile(absPath);
      const gz = await gzipAsync(raw, { level: 6 });
      this.store(key, gz);
      return gz;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  store(key, buf) {
    if (buf.length > this.maxTotal) return;
    this.map.set(key, buf);
    this.total += buf.length;
    for (const [k, v] of this.map) {
      if (this.total <= this.maxTotal) break;
      this.map.delete(k);
      this.total -= v.length;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------

/** Does the Accept-Encoding header allow gzip (q > 0)? @param {string | undefined} header */
export function acceptsGzip(header) {
  if (!header || typeof header !== 'string') return false;
  let gzipQ = null;
  let starQ = null;
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    if (token === 'gzip' || token === 'x-gzip') gzipQ = q;
    else if (token === '*') starQ = q;
  }
  if (gzipQ != null) return gzipQ > 0;
  return starQ != null && starQ > 0;
}

/**
 * Parse a single `bytes=` range against a file size.
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null} null = ignore header (serve 200)
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // multi-range or malformed → ignore (RFC 9110 permits serving the full body)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (b !== '' && Number(b) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

const stripWeak = (tag) => tag.trim().replace(/^W\//, '');

/** Conditional GET check (If-None-Match wins over If-Modified-Since). */
function isNotModified(req, etag, mtime) {
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string') {
    if (inm.trim() === '*') return true;
    return inm.split(',').some((t) => stripWeak(t) === etag);
  }
  const ims = req.headers['if-modified-since'];
  if (typeof ims === 'string') {
    const t = Date.parse(ims);
    if (Number.isFinite(t)) return Math.floor(mtime.getTime() / 1000) * 1000 <= t;
  }
  return false;
}

/** If-Range: serve the range only when the validator still matches. */
function ifRangeMatches(req, etag, lastModified) {
  const v = req.headers['if-range'];
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (s.startsWith('"') || s.startsWith('W/')) return s === etag; // strong comparison
  return s === lastModified;
}

function cacheControlFor(ext, mountName, segments, query) {
  if (ext === '.html' || ext === '.htm') return 'no-cache';
  if (/(^|&)v=/.test(query)) return IMMUTABLE_CACHE;
  if (mountName === 'public' && segments.length > 1 && LONG_CACHE_DIRS.includes(segments[0])) return LONG_CACHE;
  return 'no-cache';
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function errorPage(status, title, detail = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} · 卫戍协议：盟约</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111614;color:#d8e3de;font:16px/1.6 "Noto Sans SC",system-ui,sans-serif}
main{border:1px solid #2c3a35;padding:32px 40px;max-width:520px;text-align:center}h1{margin:0;color:#4ed8af;font-size:56px;letter-spacing:4px}
p{margin:8px 0}a{color:#4ed8af}</style></head><body><main><h1>${status}</h1><p>${escapeHtml(title)}</p>
${detail ? `<p style="opacity:.6">${escapeHtml(detail)}</p>` : ''}<p><a href="/">返回首页 · Back to home</a></p></main></body></html>`;
}

function sendError(req, res, status, title, detail) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(errorPage(status, title, detail));
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Split an absolute request URL into raw path + query (also accepts absolute-form URLs). */
function splitUrl(url) {
  let u = url || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { const parsed = new URL(u); u = parsed.pathname + parsed.search; } catch { return null; }
  }
  const q = u.indexOf('?');
  const hashless = (s) => { const h = s.indexOf('#'); return h >= 0 ? s.slice(0, h) : s; };
  return q >= 0 ? { rawPath: hashless(u.slice(0, q)), query: hashless(u.slice(q + 1)) } : { rawPath: hashless(u), query: '' };
}

// ---------------------------------------------------------------------------------------------------
// Static file handler
// ---------------------------------------------------------------------------------------------------

/**
 * Create the static request handler.
 * @param {{ publicDir: string, dataDir: string, sharedDir: string, simDir?: string, log?: object }} dirs
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse, rawPath: string, query: string) => Promise<void>}
 */
/** Optional per-machine art manifest (tools/local-extract) and the empty stand-in served when it is absent. */
const LOCAL_ART_MANIFEST = 'local-assets.json';
const EMPTY_LOCAL_ART = Buffer.from(JSON.stringify({ version: 1, source: 'none', count: 0, groups: {} }));

import { createResourceIndex, RESOURCE_MANIFEST_FILE } from './resources.js';
import { rewriteAssetPaths } from '../shared/cdn.js';
export { rewriteAssetPaths } from '../shared/cdn.js';

export function createStaticHandler({ publicDir, dataDir, sharedDir, simDir = path.join(ROOT, 'server', 'sim'), log = noopLog, cdnBase = '' }) {
  const cdn = typeof cdnBase === 'string' ? cdnBase : '';
  // the preload manifest (docs/ASSETS.md "Preload"): built on first request, cached until the manifests change
  const resources = createResourceIndex({ dataDir, publicDir, cdnBase: cdn, rewrite: (v) => (cdn ? rewriteAssetPaths(v, cdn) : v), log });
  const mounts = [
    { prefix: '/data/', name: 'data', dir: path.resolve(dataDir) },
    { prefix: '/shared/', name: 'shared', dir: path.resolve(sharedDir) },
    // the simulation: ES modules only (no directory listings, no other file types, no Node-only loader)
    { prefix: '/sim/', name: 'sim', dir: path.resolve(simDir), only: new Set(['.js']), deny: SIM_PRIVATE },
    { prefix: '/', name: 'public', dir: path.resolve(publicDir) },
  ];
  const shimBody = Buffer.from(DATA_SHIM_JS);
  const shimTag = `"shim-${shimBody.length.toString(16)}"`;
  const gzipCache = new GzipCache();

  return async function serveStatic(req, res, rawPath, query) {
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) {
      sendError(req, res, 400, '请求地址无效 · Bad request');
      return;
    }
    // The offline-resource manifest is generated, never read from disk, before the mount handling below.
    if (decoded.toLowerCase() === `/data/${RESOURCE_MANIFEST_FILE}`) {
      let idx;
      try {
        idx = await resources.get();
      } catch (e) {
        log.error('[http] cannot build the resource manifest', e);
        sendError(req, res, 500, 'Internal error');
        return;
      }
      const gz = acceptsGzip(req.headers['accept-encoding']) ? idx.gzip : null;
      const body = gz || idx.body;
      const stat = { size: idx.body.length, mtimeMs: idx.mtimeMs, mtime: new Date(idx.mtimeMs) };
      const etag = gz ? `${idx.etag.slice(0, -1)}-gz"` : idx.etag;
      const headers = {
        'Content-Type': MIME['.json'],
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': stat.mtime.toUTCString(),
        Vary: 'Accept-Encoding',
      };
      if (gz) headers['Content-Encoding'] = 'gzip';
      if (isNotModified(req, etag, stat.mtime)) { res.writeHead(304, headers); res.end(); return; }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (decoded === '/data.js') {
      const headers = { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', ETag: shimTag, 'Content-Length': shimBody.length };
      if (isNotModified(req, shimTag, new Date(0))) { delete headers['Content-Length']; res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : shimBody);
      return;
    }
    // Extension-less audio (download-manager avoidance): /media/bgm/act1 → /assets/audio/bgm/act1.mp3
    if (decoded.startsWith(MEDIA_PREFIX)) {
      await serveMedia(req, res, decoded.slice(MEDIA_PREFIX.length), query, publicDir, gzipCache, log);
      return;
    }
    // Bare mount paths (e.g. "/data") → treat as the mount directory.
    const mount = mounts.find((m) => decoded.startsWith(m.prefix) || decoded === m.prefix.slice(0, -1)) || mounts[mounts.length - 1];
    const rest = decoded.length > mount.prefix.length ? decoded.slice(mount.prefix.length) : '';
    const segments = rest.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.')) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }
    if (segments.some((s) => s.startsWith('.'))) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
    if (mount.only && (!segments.length || !mount.only.has(path.extname(segments[segments.length - 1]).toLowerCase())
      // (case-insensitive: the host may be Windows / macOS, where NODEDATA.JS opens nodeData.js)
      || (mount.deny && mount.deny.has(segments[segments.length - 1].toLowerCase())))) {
      sendError(req, res, 404, '页面不存在 · Not found');
      return;
    }
    let absPath = path.join(mount.dir, ...segments);
    if (absPath !== mount.dir && !absPath.startsWith(mount.dir + path.sep)) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }

    let stat;
    let viaDirectory = false;
    try {
      stat = await fsp.stat(absPath);
      if (stat.isDirectory()) {
        if (!decoded.endsWith('/')) {
          // Built from normalized segments (never from the raw path) so "//host" can't become an open redirect.
          const loc = (mount.prefix + segments.map(encodeURIComponent).join('/') + '/').replace(/\/{2,}/g, '/');
          res.writeHead(301, { Location: loc + (query ? `?${query}` : ''), 'Cache-Control': 'no-cache', 'Content-Length': 0 });
          res.end();
          return;
        }
        absPath = path.join(absPath, 'index.html');
        segments.push('index.html');
        viaDirectory = true;
        stat = await fsp.stat(absPath);
      }
      // Not a regular file, or a file addressed like a directory ("/app.js/") → 404.
      if (!stat.isFile() || (decoded.endsWith('/') && !viaDirectory)) {
        throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      }
      if (mount.deny) {
        // the on-disk name decides (case-insensitive file systems, Windows 8.3 short names like NODEDA~1.JS)
        const real = await fsp.realpath(absPath);
        if (mount.deny.has(path.basename(real).toLowerCase())) throw Object.assign(new Error('private'), { code: 'ENOENT' });
      }
    } catch (e) {
      if (e && e.code === 'ENOENT' && mount.name === 'data' && segments.length === 1 && segments[0] === LOCAL_ART_MANIFEST) {
        // Optional local-client art (DESIGN §13): an install without it gets an empty manifest instead of a 404,
        // so browsers don't log an error on every page load. Clients treat empty groups as "no local art".
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Content-Length': EMPTY_LOCAL_ART.length });
        res.end(req.method === 'HEAD' ? undefined : EMPTY_LOCAL_ART);
      } else if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR' || e.code === 'ENAMETOOLONG')) {
        sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : '');
      } else if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
        sendError(req, res, 403, '禁止访问 · Forbidden');
      } else {
        log.error('[http] stat failed', e);
        sendError(req, res, 500, '服务器内部错误 · Internal error');
      }
      return;
    }
    await serveFile(req, res, absPath, stat, mount.name, segments, query, gzipCache, log);
  };
}

/**
 * Extension-less audio route: `/media/bgm/act1` → `public/assets/audio/bgm/act1.mp3`.
 *
 * Clients ask for audio through this path because download managers (IDM, 迅雷, FDM …) hijack XHR/fetch whose
 * URL ends in a media extension and pop a "下载文件信息" dialog for every BGM track — see `public/js/media.js`.
 * Requests for the direct `/assets/audio/…` URLs keep working (they are the fallback for plain static hosts).
 * `MEDIA_PREFIX` / `AUDIO_EXTS` live in `shared/media.js`: the browser decides which URLs to rewrite with the
 * same two values, and they must not drift apart.
 */
async function serveMedia(req, res, rest, query, publicDir, gzipCache, log) {
  const root = path.join(path.resolve(publicDir), 'assets', 'audio');
  const segments = String(rest || '').split('/').filter((s) => s.length > 0);
  if (!segments.length || rest.endsWith('/')) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
  if (segments.some((s) => s === '..' || s === '.')) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }
  // A leading or trailing dot would address something else (dotfiles, "x..mp3") — and the client never asks for it.
  if (segments.some((s) => s.startsWith('.') || s.endsWith('.'))) { sendError(req, res, 404, '页面不存在 · Not found'); return; }

  const last = segments[segments.length - 1];
  const given = path.extname(last).toLowerCase();
  const wanted = AUDIO_EXTS.includes(given) ? given : '';
  const stem = wanted ? last.slice(0, -wanted.length) : last;
  if (!stem || stem.startsWith('.')) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
  const dir = path.join(root, ...segments.slice(0, -1));
  if (dir !== root && !dir.startsWith(root + path.sep)) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }

  // An explicit extension wins (`/media/bgm.ogg` → bgm.ogg), otherwise the usual order decides.
  const order = wanted ? [wanted, ...AUDIO_EXTS.filter((e) => e !== wanted)] : AUDIO_EXTS;
  for (const ext of order) {
    const absPath = path.join(dir, stem + ext);
    if (!absPath.startsWith(root + path.sep)) continue;
    let stat;
    try {
      // eslint-disable-next-line no-await-in-loop
      stat = await fsp.stat(absPath);
    } catch { continue; }
    if (!stat.isFile()) continue;
    // serveFile decides Content-Type from the resolved name (`.mp3` → audio/mpeg) — Range/ETag handling is shared.
    // Cache policy is that of the public path the client would otherwise have asked for (`/assets/audio/…`, 1 day).
    // eslint-disable-next-line no-await-in-loop
    await serveFile(req, res, absPath, stat, 'public', ['assets', 'audio', ...segments], query, gzipCache, log);
    return;
  }
  sendError(req, res, 404, '页面不存在 · Not found');
}

async function serveFile(req, res, absPath, stat, mountName, segments, query, gzipCache, log) {
  const ext = path.extname(absPath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const compressible = COMPRESSIBLE.has(ext);
  const rangeHeader = req.headers.range;
  const useGzip = compressible && stat.size >= GZIP_MIN_BYTES && !rangeHeader && acceptsGzip(req.headers['accept-encoding']);
  const baseTag = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
  const etag = `"${baseTag}${useGzip ? '-gz' : ''}"`;
  const lastModified = stat.mtime.toUTCString();
  const isHead = req.method === 'HEAD';

  const headers = {
    'Content-Type': type,
    'Cache-Control': cacheControlFor(ext, mountName, segments, query),
    ETag: etag,
    'Last-Modified': lastModified,
  };
  if (compressible) headers.Vary = 'Accept-Encoding';

  if (isNotModified(req, etag, stat.mtime)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (useGzip) {
    headers['Content-Encoding'] = 'gzip';
    if (stat.size <= GZIP_CACHE_MAX_FILE) {
      const gz = await gzipCache.get(absPath, stat);
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      res.end(isHead ? undefined : gz);
      return;
    }
    res.writeHead(200, headers);
    if (isHead) { res.end(); return; }
    await streamTo(fs.createReadStream(absPath), res, log, zlib.createGzip());
    return;
  }

  headers['Accept-Ranges'] = 'bytes';
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (rangeHeader && ifRangeMatches(req, etag, lastModified)) {
    const r = parseRange(rangeHeader, stat.size);
    if (r === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 0 });
      res.end();
      return;
    }
    if (r) {
      ({ start, end } = r);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (isHead || stat.size === 0) { res.end(); return; }
  await streamTo(fs.createReadStream(absPath, { start, end }), res, log);
}

async function streamTo(src, res, log, transform) {
  try {
    if (transform) await pipeline(src, transform, res);
    else await pipeline(src, res);
  } catch (e) {
    if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.debug?.('[http] stream aborted', e.code || e.message);
    res.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------
// Server assembly
// ---------------------------------------------------------------------------------------------------

/** Non-internal IPv4 addresses as http URLs. @param {number} port */
export function lanUrls(port) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   matchQueueMax?: number, matchQueueMaxPerAddr?: number,
 *   state?: false | { backend?: string, dir?: string, maxPending?: number, resume?: boolean },
 * }} [opts] `state` configures match-state persistence (server/state/*): omitted = the env defaults (SP_STATE,
 *   SP_STATE_DIR, SP_STATE_RESUME), `false` = off (tests keep an untouched working tree).
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: WebSocketServer,
 *                     lobby: Lobby, network: Network, registry: SessionRegistry, close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  const log = opts.log || makeLogger(!!opts.quiet);
  const publicDir = opts.publicDir || path.join(ROOT, 'public');
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const sharedDir = opts.sharedDir || path.join(ROOT, 'shared');

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const netOptions = {};
  for (const k of ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'presenceCoalesceMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
    'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy']) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = {};
  for (const k of ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs',
    'matchQueueMax', 'matchQueueMaxPerAddr']) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz. It is also the
  // build half of the resume version gate, so it must be read before the state bridge is built.
  resetBuildTag();
  buildTag();
  // Match-state persistence (server/state/*, P0/P1). The bridge exists before the lobby (the lobby hands it to every
  // Match as opts.stateSink); the persisted index is only READ after `listen` below, so boot never waits for the disk.
  const state = createStateBridge({ config: opts.state, log });
  stateProbe = state;
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions, state });
  // the TTL sweeper may never delete the record of a room this process still holds (a frozen match writes nothing)
  state.isLive = (code) => lobby.rooms.has(String(code));
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, log });
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  });

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, {
        ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
        // older than this reloads itself, so a deploy reaches clients that never reload
        build: buildTag(),
        sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
        // Hosted battles the server steps + how far behind the loop is (DESIGN §23): `fields` is the CPU driver
        // (`fieldsInThread` / `fieldsPooled` say where it is paid), `loop` is the symptom players feel, `mem` is the
        // third load signal (RSS / used heap in MB). All are tiny, and /healthz is also the build guard's poll.
        loop: loopStats(), mem: memStats(),
        // match-state persistence (P0/P1): queue depth/totals, the last write error and the number of persisted
        // matches this process has marked resumable. Never throws, always a few numbers.
        state: stateStats(),
      });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  server.on('clientError', (err, socket) => {
    if (err && err.code === 'ECONNRESET') { socket.destroy(); return; }
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    } catch { /* ignore */ }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  // The persisted index is read AFTER `listen` — boot never waits for the disk — and lazily: a record is only marked
  // resumable, nothing is rebuilt until a player actually comes back (server/lobby.js rehydrate). The scan is paced
  // (≈20 records/s) and hard-capped, so a large state directory or a slow disk can only delay the marks.
  if (state.enabled) {
    const cap = Math.max(0, Math.min(
      Number.isFinite(opts.maxRooms) ? opts.maxRooms : LOBBY_DEFAULTS.maxRooms,
      Number(process.env.SP_MAX_ROOMS) > 0 ? Number(process.env.SP_MAX_ROOMS) : Infinity,
    ));
    loadResumable(state.store, {
      // paced at ≈20 records/s (the disk is not worth a boot spike) inside a hard time budget: a huge state directory
      // delays the marks, never the serving — `listen` already happened
      // SP_STATE_IGNORE_BUILD=1 drops the BUILD half of the version gate for this scan only: an operator restarting the
      // service mid-match must not interrupt a room, even when the deploy changed the build tag (the records still
      // carry the real tag, `state.build` — only the comparison is skipped). The rulesHash half STAYS: a record is
      // never replayed against rules (data/*.json, shared/constants.js) it never saw.
      build: envFlag(process.env.SP_STATE_IGNORE_BUILD) ? null : state.build,
      rulesHash: state.rulesHash, ttlMs: state.ttlMs, maxRecords: cap,
      // 60 s instead of 15 s: this scan runs AFTER `listen`, so it delays only the marks, never the serving — and with
      // ~20 records/s a 15 s budget marked 293 of 815 records on the live box ("capped at 293 record(s), more remain on
      // disk"): every record past the cap keeps its match unresumable, i.e. a restart still interrupts it. 100/s over
      // 60 s covers 6000 records — past `maxRooms`, and reading these small JSON files is nothing next to a match.
      perSecond: 100, budgetMs: 60_000, log,
    }).then(({ records, refused }) => {
      state.noteRefused(refused);
      state.markResumable(records, { maxRooms: cap });
      state.logRefusals();
      state.purgeRefused(); // a refused record can never become resumable: delete it instead of re-reading it forever
      if (state.resumedCount) {
        log.info(`[state] ${state.resumedCount} persisted match(es) resumable `
          + `(${state.resume ? 'resume enabled' : 'resume disabled'}${refused.length ? `, ${refused.length} refused` : ''})`);
      }
    }).catch((e) => log.error('[state] resume scan failed', e));
  }

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      // the queue's final drain (the room disposal above only ENQUEUES the record deletions) is bounded by flushMs
      try { state.close(); await state.persist?.close(); } catch (e) { log.error('[shutdown] state', e); }
      if (stateProbe === state) stateProbe = null;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  return { port: actualPort, host, url, server, wss, lobby, network, registry, close };
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[process] uncaught exception', e));
  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`端口已被占用 / port in use: ${e.port ?? process.env.PORT ?? 3000}. Try PORT=3001 npm start`);
    else console.error('[boot] failed to start', e);
    process.exit(1);
  }
  console.log(`\n  卫戍协议：盟约 · Stronghold Protocol: Alliance v${APP_VERSION}`);
  console.log(`  Local:   ${srv.url}`);
  if (srv.host === '0.0.0.0' || srv.host === '::') {
    for (const u of lanUrls(srv.port)) console.log(`  LAN:     ${u}`);
  }
  console.log('  Internet: cloudflared tunnel --url ' + `http://localhost:${srv.port}` + '\n');

  let stopping = false;
  const stop = (signal) => {
    if (stopping) { console.log('forced exit'); process.exit(1); }
    stopping = true;
    console.log(`\n[${signal}] shutting down…`);
    setTimeout(() => process.exit(0), 5000).unref();
    srv.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (isMain()) main();
