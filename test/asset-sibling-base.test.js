// Immutable version-prefix bases: public/js/assetOrigin.js siblingBase and the modules that derive a client-side data
// base from it (`battle/runner.js` → /data/, `assets.js` → the two manifests in /data/), plus the two dynamic /sim/
// module imports that must stay absolute literals for the production publisher (`battle/runner.js`, `render/fx.js`).
//
// Why: nginx answers /js/**, /sim/**, /data/** with a 302 to …/Stronghold-Protocol/rel/<ver>/<same path>, and the store
// serves those with `Cache-Control: public, max-age=31536000, immutable`. A module loaded from that prefix finds its
// siblings under the same prefix, so deriving the base from `import.meta.url` (a) skips the 302 and (b) makes the
// response cacheable across page loads instead of revalidating it every time. This test file pins:
//
//   * siblingBase's contract: an http(s) module URL → the sibling under the SAME version prefix (query-less, so module
//     identity never splits — a ?v= on a module URL has already produced a duplicate-Preact bug here); file:// (Node)
//     and anything unparseable → the historical root-relative literal, which is what every other Node test relies on.
//   * the call sites: the rel path each siblingBase user must use (runner data: ../../data; assets: ../data), that the
//     defaults are still the historical literals in Node, that the dynamic sim module imports stay literal absolute
//     specifiers, and that the injected seams a test/caller passes (runner `base`/`dataBase`, assets
//     `url`/`localUrl`/`dataBase`) are used verbatim.
//   * the revalidation rule (mirrors data.js): `cache: 'no-cache'` is sent ONLY for the unversioned '/data/' base.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siblingBase } from '../public/js/assetOrigin.js';
import { createAssets } from '../public/js/assets.js';
import { loadBrowserSim, SIM_BASE, SIM_DATA_BASE, SIM_DATA_FILES } from '../public/js/battle/runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

/** The live deployment shape: one immutable prefix for /js/**, /sim/** and /data/**. */
const REL = 'https://local.xiaolubao.com/Stronghold-Protocol/rel/0.1.5-assets-r2';
/** The real /sim/ modules on disk, for a loader call whose module imports must actually succeed. */
const SIM_DIR = `${new URL('../server/sim/', import.meta.url).href}`;

describe('siblingBase', () => {
  test('a mirrored module URL resolves to its sibling under the same version prefix', () => {
    assert.equal(siblingBase(`${REL}/js/data.js`, '../data/', '/data/'), `${REL}/data/`);
    // the runner sits two levels down: /js/battle/runner.js → /sim/ and /data/ at the prefix root
    assert.equal(siblingBase(`${REL}/js/battle/runner.js`, '../../sim/', '/sim/'), `${REL}/sim/`);
    assert.equal(siblingBase(`${REL}/js/battle/runner.js`, '../../data/', '/data/'), `${REL}/data/`);
    // the fx system: /js/render/fx.js → /sim/
    assert.equal(siblingBase(`${REL}/js/render/fx.js`, '../../sim/', '/sim/'), `${REL}/sim/`);
  });

  test('a dev server keeps the same path on its own origin (no 302, no prefix)', () => {
    assert.equal(siblingBase('http://localhost:3000/js/data.js', '../data/', '/data/'), 'http://localhost:3000/data/');
    assert.equal(siblingBase('http://localhost:3000/js/battle/runner.js', '../../sim/', '/sim/'), 'http://localhost:3000/sim/');
  });

  test('file:// (Node tests, tools) and unparseable input fall back to the historical literal', () => {
    for (const rel of ['../data/', '../../data/', '../../sim/']) {
      const fallback = rel.includes('sim') ? '/sim/' : '/data/';
      assert.equal(siblingBase('file:///F:/x/js/battle/runner.js', rel, fallback), fallback);
      assert.equal(siblingBase('', rel, fallback), fallback);
      assert.equal(siblingBase('data:text/javascript,', rel, fallback), fallback);
      assert.equal(siblingBase(undefined, rel, fallback), fallback);
      assert.equal(siblingBase(null, rel, fallback), fallback);
    }
  });

  test('the derived base carries no query string, even from a module URL that has one', () => {
    // A ?v= on a module URL splits module identity (the duplicate-Preact regression): the base must never introduce
    // one, and a query on import.meta.url must not leak into it.
    for (const base of [
      siblingBase(`${REL}/js/battle/runner.js?v=3`, '../../sim/', '/sim/'),
      siblingBase(`${REL}/js/data.js?v=3`, '../data/', '/data/'),
    ]) {
      assert.ok(!base.includes('?'), base);
      assert.ok(base.endsWith('/'), base);
    }
    assert.equal(siblingBase(`${REL}/js/battle/runner.js?v=3`, '../../sim/', '/sim/'), `${REL}/sim/`);
  });
});

describe('battle/runner.js: the sim and data bases', () => {
  test('in Node (file://) the defaults are still the historical literals', () => {
    assert.equal(SIM_BASE, '/sim/');
    assert.equal(SIM_DATA_BASE, '/data/');
  });

  test('a versioned data base is fetched as-is, without revalidation', async () => {
    const dataBase = `${REL}/data/`;
    const calls = [];
    const fetchFn = (u, o) => { calls.push([u, o]); return Promise.resolve({ ok: false, status: 503, json: async () => null }); };
    await assert.rejects(loadBrowserSim({ base: SIM_DIR, dataBase, fetchFn }), /simulation data unavailable/);
    assert.ok(calls.length > 0, 'the data files were requested');
    for (const n of SIM_DATA_FILES) {
      const hit = calls.find(([u]) => u === `${dataBase}${n}.json`);
      assert.ok(hit, `missing request for ${n} (got ${calls[0]?.[0]})`);
      assert.deepEqual(hit[1], {}, `${n}: a content-addressed URL is not revalidated`);
    }
    for (const [u] of calls) {
      assert.ok(u.startsWith(dataBase), u);
      assert.ok(!u.includes('?'), `query-less: ${u}`);
    }
  });

  test('the unversioned base keeps the old revalidating fetch (dev + tests)', async () => {
    const calls = [];
    const fetchFn = (u, o) => { calls.push([u, o]); return Promise.resolve({ ok: false, status: 503, json: async () => null }); };
    await assert.rejects(loadBrowserSim({ base: SIM_DIR, dataBase: '/data/', fetchFn }), /simulation data unavailable/);
    assert.ok(calls.length > 0);
    for (const [u, o] of calls) {
      assert.match(u, /^\/data\/[a-z]+\.json$/, u);
      assert.deepEqual(o, { cache: 'no-cache' });
    }
  });

  test('an injected sim base + data base are used verbatim (a whole real load)', async () => {
    // The seams test/match/clientCombat-review.test.js drives: both are honoured, unchanged, so an injected base still
    // resolves the modules and the data exactly as the caller asked.
    const dataDir = new URL('../data/', import.meta.url).href;
    const fetchFn = async (u) => ({ ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(u), 'utf8')) });
    const { spec, ds } = await loadBrowserSim({ base: SIM_DIR, dataBase: dataDir, fetchFn });
    assert.ok(spec && typeof spec.createBattleFromSpec === 'function', 'the injected sim base resolved the modules');
    assert.ok(ds, 'the injected data base supplied every SIM_DATA_FILES entry');
  });
});

describe('assets.js: the manifest bases', () => {
  test('in Node the manifest URLs are the historical literals and still revalidate', async () => {
    const calls = [];
    const a = createAssets({ fetch: async (u, o) => { calls.push([u, o]); return { ok: true, status: 200, json: async () => ({}) }; } });
    await a.ready();
    await a.local();
    assert.deepEqual(calls, [['/data/assets.json', { cache: 'no-cache' }], ['/data/local-assets.json', { cache: 'no-cache' }]]);
  });

  test('a versioned data base serves both manifests under the prefix, cacheably', async () => {
    const dataBase = `${REL}/data/`;
    const calls = [];
    const a = createAssets({ dataBase, fetch: async (u, o) => { calls.push([u, o]); return { ok: true, status: 200, json: async () => ({}) }; } });
    await a.ready();
    await a.local();
    assert.deepEqual(calls, [[`${dataBase}assets.json`, {}], [`${dataBase}local-assets.json`, {}]]);
    assert.deepEqual(a.manifest, {});
    for (const [u] of calls) assert.ok(!u.includes('?'), `query-less: ${u}`);
  });

  test('injected url / localUrl are honoured verbatim (the old seam, old behaviour)', async () => {
    const calls = [];
    const a = createAssets({
      url: '/data/assets.json', localUrl: '/data/local-assets.json',
      fetch: async (u, o) => { calls.push([u, o]); return { ok: true, status: 200, json: async () => ({}) }; },
    });
    await a.ready();
    await a.local();
    assert.deepEqual(calls.map(([u]) => u), ['/data/assets.json', '/data/local-assets.json']);
    assert.deepEqual(calls.map(([, o]) => o), [{ cache: 'no-cache' }, { cache: 'no-cache' }]);
  });

  test('the manifest content is untouched: only the fetch URL/options are derived', async () => {
    // Asset + spine URLs keep their exact shape (unloadSpineData frees pages by URL equality, pixi-spine resolves atlas
    // pages relative to the atlas URL) — assetOrigin.js rewrites /assets/** and nothing here touches them.
    const M = {
      chars: { char_1: { spine: { front: { skel: '/assets/char/spine/a.skel', atlas: '/assets/char/spine/a.atlas', anims: {} } } } },
      ui: { 'battle/sprite_shadow': '/assets/ui/battle/sprite_shadow.png' },
    };
    const a = createAssets({ manifest: M, localManifest: { groups: {} } });
    assert.deepEqual(a.spineEntry('char_1'), { skel: '/assets/char/spine/a.skel', atlas: '/assets/char/spine/a.atlas', anims: {} });
    assert.equal(a.ui('battle/sprite_shadow'), '/assets/ui/battle/sprite_shadow.png');
    assert.deepEqual(a.localUrl('g', 'n'), null);
  });
});

describe('render/fx.js: the dynamic /sim/constants.js import', () => {
  test('imports a literal, query-less specifier (source pin)', async () => {
    // fx.js cannot be exercised at runtime in Node (its browser branch is behind `typeof window !== 'undefined'`, and
    // the specifier is fixed when the module is first evaluated), so the call site is pinned here: the historical
    // root-relative LITERAL, which the production publisher resolves into the version prefix itself (a template base
    // with no absolute literal default made it refuse the whole tree), and no ?v= that would split the module's identity.
    const src = read('public/js/render/fx.js');
    assert.match(src, /import\('\/sim\/constants\.js'\)/);
    assert.ok(!src.includes('SIM_BASE'), 'the template base is gone');
    assert.ok(!src.includes('import(`'), 'no template-literal dynamic import left');
  });
});

describe('the call sites pin the rel path each module must use (source)', () => {
  test('battle/runner.js', () => {
    const src = read('public/js/battle/runner.js');
    // the sim modules are imported through a parameter whose default is the historical absolute literal: that is what
    // the publisher's module-ref check resolves (a siblingBase-derived default was reported as "no absolute base
    // default"), while the fetch-only data base keeps the version prefix
    assert.match(src, /SIM_BASE = '\/sim\/'/);
    assert.match(src, /SIM_DATA_BASE = siblingBase\(\s*import\.meta\.url\s*,\s*'\.\.\/\.\.\/data\/'\s*,\s*'\/data\/'\s*\)/);
    assert.match(src, /base = '\/sim\/', dataBase = SIM_DATA_BASE/);
    assert.match(src, /dataBase === '\/data\/' \? \{ cache: 'no-cache' \} : \{\}/);
    // the three /sim/ module specifiers are templates over that parameter: they are fine only because the default is
    // that absolute literal, and they must stay query-less (a ?v= would split the module identity)
    for (const m of src.matchAll(/import\(`\$\{base\}([^`]*)`\)/g)) assert.ok(!m[1].includes('?'), m[0]);
  });

  test('assets.js', () => {
    const src = read('public/js/assets.js');
    assert.match(src, /dataBase = opts\.dataBase \?\? siblingBase\(\s*import\.meta\.url\s*,\s*'\.\.\/data\/'\s*,\s*'\/data\/'\s*\)/);
    assert.match(src, /const url = opts\.url \|\| `\$\{dataBase\}assets\.json`/);
    assert.match(src, /const localUrl = opts\.localUrl \|\| `\$\{dataBase\}local-assets\.json`/);
    assert.match(src, /manifestOpts = dataBase === '\/data\/' \? \{ cache: 'no-cache' \} : \{\}/);
    assert.ok(!src.includes("doFetch(url, { cache: 'no-cache' })") && !src.includes("doFetch(localUrl, { cache: 'no-cache' })"));
  });
});
