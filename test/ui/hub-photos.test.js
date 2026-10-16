// 用户 2026-10-16：大厅内置背景加入 10 张鹿乃图，图片放 R2（资产 CDN），客户端按 ASSETS_CDN 取，不在构建产物里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HUB_PHOTOS, HUB_THEMES, isHubPhoto, hubPhotoUrl, hubPhotoThumbUrl, sanitizeBackdrop, backdropScene, backdropImage, backdropTheme,
} from '../../public/js/ui/hubAppearance.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const backdrop = read('public/js/ui/hubBackdrop.js');

test('ten built-in photo backgrounds named 鹿乃1…鹿乃10', () => {
  assert.equal(HUB_PHOTOS.length, 10);
  assert.deepEqual(HUB_PHOTOS.map((x) => x.id), Array.from({ length: 10 }, (_, i) => `kano${i + 1}`));
  assert.deepEqual(HUB_PHOTOS.map((x) => x.name), Array.from({ length: 10 }, (_, i) => `鹿乃${i + 1}`));
  // the procedural themes are untouched and the photo ids are recognised next to them
  assert.deepEqual(HUB_THEMES.map((x) => x.id), ['night', 'frost', 'ember', 'calm']);
  assert.equal(isHubPhoto('kano1'), true);
  assert.equal(isHubPhoto('night'), false);
  assert.equal(isHubPhoto('custom'), false);
});

test('the photos are fetched from the assets CDN (R2), not bundled', () => {
  // ASSETS_CDN is empty in a same-origin checkout, so the path stays root-relative here; the server injects the CDN base
  assert.equal(hubPhotoUrl('kano3').endsWith('/assets/local/hub/kano3.jpg'), true);
  assert.equal(hubPhotoThumbUrl('kano3').endsWith('/assets/local/hub/thumb/kano3.jpg'), true);
  assert.match(hubPhotoUrl('kano1'), /^\/?[^"]*assets\/local\/hub\/kano1\.jpg$/);
  // the local, gitignored copies live where scripts/sync-to-r2.sh uploads from
  const dir = root + 'public/assets/local/hub';
  if (existsSync(dir)) {
    const full = readdirSync(dir).filter((f) => /^kano\d+\.jpg$/.test(f));
    const thumbs = readdirSync(dir + '/thumb').filter((f) => /^kano\d+\.jpg$/.test(f));
    assert.equal(full.length, 10, 'ten full-size frames');
    assert.equal(thumbs.length, 10, 'ten swatch thumbnails');
  }
});

test('a photo theme behaves like the custom photo scene, sliders included', () => {
  for (const id of ['kano1', 'kano10']) {
    const theme = sanitizeBackdrop({ theme: id }).theme;
    assert.equal(theme, id, 'sanitizeBackdrop keeps a built-in photo id');
    assert.equal(backdropScene({ pref: { theme: id } }), 'photo');
    assert.equal(backdropImage({ pref: { theme: id } }).endsWith(`/assets/local/hub/${id}.jpg`), true);
    assert.equal(backdropTheme({ pref: { theme: id } }), 'custom', 'the photo CSS path is reused');
  }
  assert.equal(sanitizeBackdrop({ theme: 'ember' }).theme, 'ember');
  assert.equal(sanitizeBackdrop({ theme: 'nope' }).theme, 'night', 'unknown ids still fall back');
  // the user's own import keeps working: no theme id involved, blob URL stays the source
  assert.equal(backdropScene({ pref: { theme: 'custom' }, imageUrl: 'blob:x' }), 'photo');
  assert.equal(backdropImage({ pref: { theme: 'custom' }, imageUrl: 'blob:x' }), 'blob:x');
  assert.equal(backdropImage({ pref: { theme: 'night' } }), '');
});

test('the panel lists the photos and the renderer reads the CDN url', () => {
  assert.match(backdrop, /HUB_PHOTOS\.map\(/);
  assert.match(backdrop, /bgset__themes--photos/);
  assert.match(backdrop, /t\('内置背景'\)/);
  assert.match(backdrop, /hubPhotoThumbUrl\(x\.id\)/);
  assert.match(backdrop, /backgroundImage: `url\("\$\{backdropImage\(bg\)\}"\)`/);
  assert.doesNotMatch(backdrop, /url\("\$\{bg\.imageUrl\}"\)/, 'the renderer no longer reads the local blob only');
  // dim/blur apply to built-in photos too, but the import note stays custom-only
  assert.match(backdrop, /const photoTheme = pref\.theme === 'custom' \|\| isHubPhoto\(pref\.theme\);/);
});

test('every pack carries the ten names and the group label', () => {
  for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
    const pack = JSON.parse(read(`public/i18n/${lang}.json`));
    assert.equal(typeof pack['内置背景'], 'string', `${lang}: 内置背景`);
    for (let i = 1; i <= 10; i++) assert.equal(typeof pack[`鹿乃${i}`], 'string', `${lang}: 鹿乃${i}`);
  }
  // en must not fall back to the Chinese name (test/i18n.test.js rejects Chinese in en values)
  const en = JSON.parse(read('public/i18n/en.json'));
  assert.equal(en['鹿乃1'], 'Kano 1');
  assert.equal(en['鹿乃10'], 'Kano 10');
});
