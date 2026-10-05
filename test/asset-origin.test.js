// Direct-to-object-store asset URLs (public/js/assetOrigin.js).
//
// The point of the feature is that nginx stops answering ~60% of all requests with a 302 at peak. These tests pin the
// two rules that make it safe: audio is NEVER redirected (it must keep using the game host's extension-less /media/…
// path, or download managers pop up "下载文件信息" for every BGM track), and everything that is not an /assets/**
// path is left exactly as it was. They also pin the "off" behaviour, which is what every other test in this suite —
// and local development — depends on.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_BASE, assetBase, assetUrl, rewriteAssetPaths } from '../public/js/assetOrigin.js';
import { validSpine, spineEntry, localSpineEntry } from '../public/js/assets.js';
import { createDataStore } from '../public/js/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(readFileSync(path.join(ROOT, 'data', f), 'utf8'));

/** Pretend the page is served from `hostname`. */
const serveFrom = (hostname) => {
  globalThis.location = { protocol: 'https:', hostname, origin: `https://${hostname}` };
};

let savedLocation;
let savedOverride;

beforeEach(() => {
  savedLocation = globalThis.location;
  savedOverride = globalThis.__SP_ASSET_BASE__;
  delete globalThis.__SP_ASSET_BASE__;
  delete globalThis.location;
});

afterEach(() => {
  if (savedLocation === undefined) delete globalThis.location; else globalThis.location = savedLocation;
  if (savedOverride === undefined) delete globalThis.__SP_ASSET_BASE__; else globalThis.__SP_ASSET_BASE__ = savedOverride;
});

describe('assetBase', () => {
  test('is off without a location (Node, workers) so tests and tools keep root-relative paths', () => {
    assert.equal(assetBase(), '');
    assert.equal(assetUrl('/assets/ui/x.png'), '/assets/ui/x.png');
  });

  test('is off on localhost and file:// so local edits are what you see', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', 'dev.localhost']) {
      serveFrom(host);
      assert.equal(assetBase(), '', host);
    }
    globalThis.location = { protocol: 'file:', hostname: '', origin: 'null' };
    assert.equal(assetBase(), '');
  });

  test('points at the store on a real host', () => {
    serveFrom('game.xiaolubao.com');
    assert.equal(assetBase(), ASSET_BASE);
    assert.match(ASSET_BASE, /^https:\/\//);
    assert.ok(!ASSET_BASE.endsWith('/'), 'no trailing slash, or every join would double it');
  });

  test('__SP_ASSET_BASE__ overrides everything, including the off switch', () => {
    serveFrom('game.xiaolubao.com');
    globalThis.__SP_ASSET_BASE__ = 'https://cdn.example.com/base/';
    assert.equal(assetBase(), 'https://cdn.example.com/base', 'trailing slash dropped');
    globalThis.__SP_ASSET_BASE__ = '';
    assert.equal(assetBase(), '', 'empty string disables the redirect for this session');
    serveFrom('localhost');
    globalThis.__SP_ASSET_BASE__ = 'https://cdn.example.com';
    assert.equal(assetBase(), 'https://cdn.example.com', 'an explicit base also works locally');
  });
});

describe('assetUrl', () => {
  beforeEach(() => serveFrom('game.xiaolubao.com'));

  test('makes /assets/** absolute', () => {
    assert.equal(assetUrl('/assets/ui/battle/emoji_btn.png'), `${ASSET_BASE}/assets/ui/battle/emoji_btn.png`);
    assert.equal(assetUrl('/assets/char/avatar/char_002_amiya_1.png'), `${ASSET_BASE}/assets/char/avatar/char_002_amiya_1.png`);
    // Query strings survive (cache-busting in artUrls / sprite URLs).
    assert.equal(assetUrl('/assets/spine/enemy/x.skel?v=2'), `${ASSET_BASE}/assets/spine/enemy/x.skel?v=2`);
  });

  test('leaves audio alone: it must keep flowing through /media/… (no download-manager popups)', () => {
    const bgm = '/assets/audio/bgm/act1.mp3';
    assert.equal(assetUrl(bgm), bgm);
    assert.equal(assetUrl('/assets/audio/sfx/battle/hit.mp3'), '/assets/audio/sfx/battle/hit.mp3');
    // Exactly the prefix matters: an unrelated group that merely starts with the same letters is not audio.
    assert.equal(assetUrl('/assets/audiofoo/x.png'), `${ASSET_BASE}/assets/audiofoo/x.png`);
  });

  test('leaves anything that is not one of our /assets/** paths untouched', () => {
    for (const v of [
      '/media/bgm/act1',                 // the rewritten audio path (already extension-less, same origin)
      'assets/ui/x.png',                 // relative: not ours to guess
      'https://other.example.com/assets/ui/x.png', // already absolute
      'data:image/png;base64,AAAA',
      'sl.atlas',                        // a spine file name resolved against a directory
      'ui/battle/emoji_btn.png',         // a manifest group/key, not a path
      '/data/assets.json',
      '/js/assets.js',
      '',
      null,
      undefined,
      42,
    ]) assert.equal(assetUrl(v), v, String(v));
  });
});

describe('rewriteAssetPaths', () => {
  test('is a no-op (same object) while the base is off', () => {
    const m = load('local-assets.json');
    assert.equal(rewriteAssetPaths(m), m, 'identity must hold: manifests are used as WeakMap keys');
  });

  test('rewrites every manifest path to the store, deeply, and leaves sizes/names alone', () => {
    serveFrom('game.xiaolubao.com');
    const src = load('local-assets.json');
    const out = rewriteAssetPaths(src);
    assert.notEqual(out, src, 'a copy is returned, the input is never mutated');

    let paths = 0;
    for (const g of Object.values(out.groups)) {
      for (const entry of Object.values(g)) {
        assert.ok(entry.path.startsWith(`${ASSET_BASE}/assets/`), entry.path);
        assert.notEqual(entry.path, src.groups[g === null ? '' : ''] && undefined, 'placeholder');
        paths++;
      }
    }
    assert.ok(paths > 0, 'the local manifest lists art');
    // Non-URL fields survive untouched.
    const first = Object.values(Object.values(out.groups)[0])[0];
    assert.equal(typeof first.w, typeof Object.values(Object.values(src.groups)[0])[0].w);
    assert.equal(first.w, Object.values(Object.values(src.groups)[0])[0].w);
  });

  test('rewrites the real asset manifest without touching audio or bare names', () => {
    serveFrom('game.xiaolubao.com');
    const src = load('assets.json');
    const out = rewriteAssetPaths(src);
    let seen = 0;
    for (const url of Object.values(out.ui)) {
      assert.ok(url.startsWith(`${ASSET_BASE}/assets/`), url);
      seen++;
    }
    assert.ok(seen > 0, 'ui urls exist');
    // The audio tree drives BGM/SFX and must stay on the game host.
    for (const url of Object.values(src.audio?.bgm ?? {})) {
      assert.ok(!String(url).startsWith('http'), `bgm must stay same-origin: ${url}`);
      if (typeof url === 'string' && url.startsWith('/assets/audio/')) assert.equal(assetUrl(url), url);
    }
  });

  test('is idempotent', () => {
    serveFrom('game.xiaolubao.com');
    const once = rewriteAssetPaths(load('local-assets.json'));
    const twice = rewriteAssetPaths(once);
    assert.equal(twice, once, 'already-absolute URLs no longer match, so nothing changes');
  });
});

describe('data store integration', () => {
  test('manifests loaded through data.js carry store URLs, and /assets/audio/ is untouched', async () => {
    serveFrom('game.xiaolubao.com');
    const body = {
      groups: { 'ui/battle': { emoji_btn: { path: '/assets/local/ui/battle/emoji_btn.png', w: 40, h: 40 } } },
      ui: { 'guide/1': '/assets/ui/guide/1.png' },
      audio: { bgm: { act1: '/assets/audio/bgm/act1.mp3' } },
    };
    const store = createDataStore({
      fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }),
    });
    await store.load('local');
    const m = store.get('local');
    assert.equal(m.groups['ui/battle'].emoji_btn.path, `${ASSET_BASE}/assets/local/ui/battle/emoji_btn.png`);
    assert.equal(m.groups['ui/battle'].emoji_btn.w, 40);
    assert.equal(m.audio.bgm.act1, '/assets/audio/bgm/act1.mp3', 'audio stays on the game host');
  });

  test('with the base off, a loaded manifest is byte-for-byte what the server sent', async () => {
    const body = { groups: { 'ui/battle': { e: { path: '/assets/local/ui/battle/emoji_btn.png' } } } };
    const store = createDataStore({
      fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }),
    });
    await store.load('local');
    assert.equal(store.get('local').groups['ui/battle'].e.path, '/assets/local/ui/battle/emoji_btn.png');
  });
});

describe('spine entries survive the rewrite', () => {
  // Regression: validSpine() used to require a root-relative skeleton path. Rewriting asset URLs to absolute made it
  // reject every operator/enemy/token model, which degrades the whole battlefield to static art — a silent, total
  // failure that no unit test caught until asset URLs moved.
  test('validSpine accepts an absolute skeleton but still rejects junk', () => {
    const ok = { atlas: 'x.atlas', anims: {} };
    assert.equal(validSpine({ ...ok, skel: '/assets/char/spine/x.skel' }), true, 'root-relative');
    assert.equal(validSpine({ ...ok, skel: `${ASSET_BASE}/assets/char/spine/x.skel` }), true, 'absolute');
    assert.equal(validSpine({ ...ok, skel: '//local.xiaolubao.com/x.skel' }), true, 'protocol-relative');
    assert.equal(validSpine({ ...ok, skel: 'x.skel' }), false, 'a bare file name is not a path');
    assert.equal(validSpine({ ...ok, skel: '/assets/x.skel ' }), false, 'no whitespace');
    assert.equal(validSpine({ ...ok, skel: '/assets/x.png' }), false, 'must be a skeleton');
    assert.equal(validSpine({ ...ok, skel: 'https://store.example.com/x.skel' }), true);
    assert.equal(validSpine({ atlas: 'a.atlas', skel: '/assets/x.skel' }), false, 'anims required');
  });

  test('spineEntry resolves a model from a rewritten manifest', () => {
    serveFrom('game.xiaolubao.com');
    const m = rewriteAssetPaths({
      chars: { char_1: { spine: { front: { skel: '/assets/char/spine/a.skel', atlas: '/assets/char/spine/a.atlas', anims: {} } } } },
      enemies: { e_1: { icon: '/assets/enemy/icon/e.png', spine: { skel: '/assets/enemy/spine/e.skel', atlas: '/assets/enemy/spine/e.atlas', anims: {} } } },
      tokens: { t_1: { avatar: '/assets/token/a.png', spine: { skel: '/assets/token/spine/t.skel', atlas: '/assets/token/spine/t.atlas', anims: {} } } },
    });
    assert.equal(spineEntry(m, 'char_1').skel, `${ASSET_BASE}/assets/char/spine/a.skel`);
    assert.equal(spineEntry(m, 'e_1').skel, `${ASSET_BASE}/assets/enemy/spine/e.skel`);
    assert.equal(spineEntry(m, 't_1').skel, `${ASSET_BASE}/assets/token/spine/t.skel`);
    assert.equal(spineEntry(m, 'nope'), null);
  });

  test('localSpineEntry still pairs the skeleton with its atlas under one prefix', () => {
    serveFrom('game.xiaolubao.com');
    const local = rewriteAssetPaths({
      groups: {
        g: {
          'a.skel': { path: '/assets/local/g/a.skel' },
          'a.atlas': { path: '/assets/local/g/a.atlas' },
          'a.png': { path: '/assets/local/g/a.png' },
        },
      },
    });
    const entry = localSpineEntry({ group: 'g', skel: 'a.skel', atlas: 'a.atlas', textures: ['a.png'], pma: false, anims: {} }, local, null);
    assert.ok(entry, 'the local model still resolves');
    assert.equal(entry.skel, `${ASSET_BASE}/assets/local/g/a.skel`);
    assert.equal(entry.atlas, `${ASSET_BASE}/assets/local/g/a.atlas`);
    assert.deepEqual(entry.textures, [`${ASSET_BASE}/assets/local/g/a.png`]);
  });
});
