// tools/asset-hashes.mjs — write data/asset-hashes.json: the per-file SHA-1 (12 hex) of the fetched assets, which the
// server puts into /data/resource-manifest.json and the client verifies cached bytes against (docs/ASSETS.md「Preload」).
//
// Why this exists: server/resources.js falls back to a *synthetic* hash (`syn-<source stamp>|<url>`) for any file it has
// no real digest for, and that fallback is keyed to the whole source manifest — so one regenerated data/assets.json
// changes every web asset's hash and the preload re-downloads all ~380 MiB instead of the few files that changed. It
// also costs the content check: a synthetic hash is not a content digest, so store.js cannot verify cached bytes nor
// migrate them from an older cache layout (public/js/resources/store.js `#adopt`).
//
//   node tools/asset-hashes.mjs                 write data/asset-hashes.json
//   node tools/asset-hashes.mjs --check         compare only; exit 1 when the file is stale (run before a deploy)
//   node tools/asset-hashes.mjs --out <file>    write somewhere else
//   node tools/asset-hashes.mjs --root <dir>    hash another install (default: the repository root)
//
// The digest is the first 12 hex of the SHA-1 of the file's bytes — exactly what public/js/resources/store.js computes
// with WebCrypto, and what server/resources.js accepts (HASH_RE). No dependencies.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ASSET_HASHES_FILE } from '../server/resources.js';

/** The trees the resource manifest draws from (server/resources.js collects the same URLs out of the data manifests). */
export const ROOTS = Object.freeze(['assets', 'fonts']);
/** URL path prefix of each root: `public/assets/ui/x.png` → `/assets/ui/x.png`. */
const urlOf = (root, rel) => `/${root}/${rel.split(path.sep).join('/')}`;

/**
 * SHA-1 of a file's bytes, first 12 hex — the digest the client recomputes from the cached response body.
 * @param {string} file absolute path
 * @returns {Promise<string>}
 */
export async function digestFile(file) {
  const hash = createHash('sha1');
  const fh = await fsp.open(file, 'r');
  try {
    for await (const chunk of fh.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await fh.close();
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Every servable file under `<root>/public/{assets,fonts}`, as `{ url, hash, size }` sorted by URL.
 * Symlinks are skipped (a served tree should not depend on where a link points) and unreadable files are reported
 * through `onError` instead of aborting the walk.
 * @param {string} root repository root
 * @param {{ onError?: (file: string, err: any) => void, onProgress?: (n: number) => void }} [opts]
 */
export async function hashTree(root, { onError, onProgress } = {}) {
  const out = [];
  for (const name of ROOTS) {
    const base = path.join(root, 'public', name);
    let entries;
    try {
      entries = await fsp.readdir(base, { recursive: true, withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // a checkout without that tree (fonts/assets are not in git)
      throw err;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = path.join(e.parentPath ?? e.path, e.name);
      const rel = path.relative(base, abs);
      try {
        const stat = await fsp.stat(abs);
        out.push({ url: urlOf(name, rel), hash: await digestFile(abs), size: stat.size });
      } catch (err) {
        onError?.(abs, err);
      }
      if (out.length % 500 === 0) onProgress?.(out.length);
    }
  }
  out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return out;
}

/**
 * The document server/resources.js reads (`files` = URL path → 12-hex digest).
 * @param {{ url: string, hash: string, size: number }[]} entries
 */
export function buildDoc(entries) {
  const files = {};
  let bytes = 0;
  for (const e of entries) {
    files[e.url] = e.hash;
    bytes += e.size;
  }
  return { version: 1, generator: 'tools/asset-hashes.mjs', count: entries.length, bytes, files };
}

/**
 * Compare a document against what is on disk.
 * @returns {{ ok: boolean, missing: string[], stale: string[], changed: { url: string, was: string, now: string }[] }}
 */
export function diffDoc(doc, entries) {
  const known = doc && typeof doc === 'object' && doc.files && typeof doc.files === 'object' ? doc.files : {};
  const now = new Map(entries.map((e) => [e.url, e.hash]));
  const missing = [];
  const changed = [];
  for (const [url, was] of Object.entries(known)) {
    const hash = now.get(url);
    if (hash == null) missing.push(url);
    else if (hash !== was) changed.push({ url, was, now: hash });
  }
  const stale = entries.filter((e) => known[e.url] == null).map((e) => e.url);
  return { ok: missing.length === 0 && stale.length === 0 && changed.length === 0, missing, stale, changed };
}

async function main(argv) {
  const has = (flag, fallback = null) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const repoRoot = path.resolve(has('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const outFile = path.resolve(has('--out') || path.join(repoRoot, 'data', ASSET_HASHES_FILE));
  const check = argv.includes('--check');
  const quiet = argv.includes('--quiet');

  const t0 = Date.now();
  const entries = await hashTree(repoRoot, {
    onError: (file, err) => console.warn(`  skip ${file}: ${err?.message || err}`),
    onProgress: (n) => { if (!quiet) process.stdout.write(`\r  hashed ${n} files…`); },
  });
  if (!quiet) process.stdout.write('\r');
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  console.log(`[asset-hashes] ${entries.length} files, ${(bytes / 1048576).toFixed(1)} MiB under public/{${ROOTS.join(',')}}`
    + ` (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const doc = buildDoc(entries);
  if (check) {
    let current = null;
    try {
      current = JSON.parse(await fsp.readFile(outFile, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') {
        console.error(`[asset-hashes] FAIL ${path.relative(repoRoot, outFile)} does not exist — run: node tools/asset-hashes.mjs`);
        return 1;
      }
      throw err;
    }
    const d = diffDoc(current, entries);
    for (const url of d.missing.slice(0, 10)) console.error(`  gone from disk: ${url}`);
    for (const url of d.stale.slice(0, 10)) console.error(`  not in the file: ${url}`);
    for (const c of d.changed.slice(0, 10)) console.error(`  changed: ${c.url} ${c.was} → ${c.now}`);
    if (!d.ok) {
      console.error(`[asset-hashes] FAIL ${d.changed.length} changed, ${d.stale.length} new, ${d.missing.length} gone`
        + ' — regenerate with: node tools/asset-hashes.mjs');
      return 1;
    }
    console.log(`[asset-hashes] OK ${path.relative(repoRoot, outFile)} matches ${entries.length} files`);
    return 0;
  }

  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, `${JSON.stringify(doc, null, 1)}\n`, 'utf8');
  console.log(`[asset-hashes] wrote ${path.relative(repoRoot, outFile)} (${doc.count} entries)`
    + ' — deploy it with the assets; without it every manifest change re-downloads the whole cache.');
  return 0;
}

// Run only when invoked as a program (`node tools/asset-hashes.mjs …`), so tests can import the helpers.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error(`[asset-hashes] ${err?.stack || err}`);
    process.exit(1);
  });
}
