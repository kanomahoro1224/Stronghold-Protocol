// Where the client's /assets/** requests go.
//
// Why this exists: nginx used to answer every /assets/** request with a 302 to the object store, and at peak those
// redirects were the single largest CPU consumer on a 2-vCPU box (~60% of its request volume, ~30% of total CPU). The
// store already serves the same objects with permissive CORS (`Access-Control-Allow-Origin: *`, preflight 204), so the
// client can ask it directly and skip the redirect entirely.
//
// Two rules keep this safe:
//   1. Only `/assets/**` is redirected — and `/assets/audio/**` is excluded on purpose. Audio must keep flowing
//      through the game host's extension-less `/media/…` path (media.js): that is what stops download managers
//      (IDM / 迅雷 / FDM) from popping up "下载文件信息" for every BGM track. A direct .mp3 URL would bring that back.
//   2. Manifest paths are rewritten once, where the manifests enter the client (`data.js`, `assets.js`), so every
//      consumer — including ui/assetUrls.js and every `<img src>` — gets an absolute URL with no call-site changes.
//
// Switch: `globalThis.__SP_ASSET_BASE__` overrides everything (a string; `''` disables the redirect and restores the
// original root-relative URLs). Without it the base applies everywhere except local development (localhost / file://),
// where assets must come from the local server so edits show up. Rollback in production is the code-version prefix
// (sp-code-version.conf), which needs no restart; this variable is the per-session escape hatch.

/** The object store that mirrors this deployment, including its path prefix. */
export const ASSET_BASE = 'https://local.xiaolubao.com/Stronghold-Protocol';

const ASSET_PATH = /^\/assets\//;
const AUDIO_PATH = /^\/assets\/audio\//;

/** Hosts where the direct-to-store base must NOT be used by default (local dev, tests, file://). */
function isLocalHost(host) {
  if (!host) return true;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

/**
 * The active base (no trailing slash), or '' when /assets/** should stay on the game host.
 * @returns {string}
 */
export function assetBase() {
  const override = globalThis.__SP_ASSET_BASE__;
  if (typeof override === 'string') return override.replace(/\/+$/, '');
  const loc = globalThis.location;
  if (!loc) return '';                       // Node / a worker without a location: keep paths relative
  if (loc.protocol === 'file:') return '';
  if (isLocalHost(loc.hostname)) return '';
  return ASSET_BASE;
}

/**
 * Absolute URL for an asset path, or the input unchanged when it is not one of ours (already absolute, a data: URL,
 * a bare file name, a `/media/…` path, audio, or when the base is off).
 * @param {unknown} url
 * @returns {unknown} the URL, or the input as-is
 */
export function assetUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  if (!ASSET_PATH.test(url) || AUDIO_PATH.test(url)) return url;
  const base = assetBase();
  if (!base) return url;
  return base + url;
}

/**
 * Rewrite every `/assets/**` string in a manifest object (deep). Returns the input unchanged when the base is off, so
 * a disabled switch costs nothing. Idempotent: an already-absolute URL no longer starts with `/assets/`. Non-URL
 * values (names, sizes, `kind`, spine file names such as `sl.atlas`) never match and are left alone.
 * @template T
 * @param {T} json
 * @returns {T}
 */
export function rewriteAssetPaths(json) {
  if (!assetBase()) return json;
  return walk(json);
}

/**
 * Resolve a directory relative to the module that needs it, so the client fetches code-side data (`/data`, `/sim`)
 * from the **same immutable version prefix** the module itself was served from. nginx points `/js/**` at
 * `…/Stronghold-Protocol/rel/<ver>/js/**`, so `import.meta.url` is already inside the version directory and
 * `'../data/'` resolves to `…/rel/<ver>/data/`. That URL is content-addressed — a deploy changes the prefix, never the
 * contents — so it can be cached hard and never needs revalidation, and the browser skips the 302 it used to eat
 * first.
 *
 * Anything that is not an http(s) module URL keeps the historical root-relative path: Node imports `file:`, and the
 * unit tests must keep fetching from their injected base.
 *
 * @param {string} moduleUrl `import.meta.url` of the calling module
 * @param {string} rel path relative to that module, e.g. `'../data/'`
 * @param {string} fallback the historical root-relative path, e.g. `'/data/'`
 * @returns {string}
 */
export function siblingBase(moduleUrl, rel, fallback) {
  try {
    const u = new URL(moduleUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
    return new URL(rel, u).href;
  } catch {
    return fallback;
  }
}

function walk(v) {
  if (typeof v === 'string') return assetUrl(v);
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => { const y = walk(x); if (y !== x) changed = true; return y; });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const y = walk(x); if (y !== x) changed = true; out[k] = y; }
    return changed ? out : v;
  }
  return v;
}
