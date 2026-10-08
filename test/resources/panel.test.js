// test/resources/panel.test.js — the two faces of the preload UI (public/js/ui/resourcePanel.js, docs/ASSETS.md
// 「Preload」): the numbers both render, and the wiring that puts the launcher in the title screen's bottom-right corner
// (the settings modal is only reachable inside a match, so the home screen needs its own entry).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { byteText, detailText, percent } from '../../public/js/ui/resourcePanel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The state public/js/resources/index.js publishes, with the counters its store filled in. */
const state = (over = {}) => ({
  enabled: true, phase: 'download', supported: true, reason: '', done: 0, total: 0, wanted: 0,
  tier1Done: 0, tier1Total: 0, tier2Done: 0, tier2Total: 0, bytes: 0, totalBytes: null, sized: 0, sizedTotal: 0,
  skipped: 0, failed: 0, complete: false, message: '', error: false, worker: '', version: '', ...over,
});

describe('preload numbers', () => {
  test('byteText: only when the server could size the files', () => {
    assert.equal(byteText(state()), '', 'nothing known yet');
    assert.equal(byteText(state({ totalBytes: null })), '');
    assert.equal(byteText(state({ totalBytes: 0 })), '');
    assert.equal(byteText(state({ totalBytes: 2 * 1024 * 1024, sizedTotal: 0 })), '2.0 MiB', 'sizes unknown ⇒ the total only');
    assert.equal(byteText(state({ totalBytes: 2 * 1024 * 1024, sizedTotal: 3, bytes: 1024 * 1024 })), '1.0 MiB / 2.0 MiB');
  });

  test('detailText: the two tiers, the file count and the bytes', () => {
    assert.equal(detailText(state()), '', 'no manifest yet');
    // `wanted` (not `total`) is the goal: entries the origin has no size for are never requested, so counting them in
    // the denominator made the line read `全部 812/3966` for ever while there was nothing left to download.
    assert.equal(detailText(state({ total: 3966, wanted: 3960, done: 812, tier1Total: 456, tier1Done: 456, tier2Total: 3510, tier2Done: 356 })), '必需 456/456 · 全部 812/3960');
    assert.equal(detailText(state({ total: 10, wanted: 10, done: 10, tier1Total: 0 })), '全部 10/10', 'a skipped entry never reaches the goal');
    assert.equal(detailText(state({ total: 10, wanted: 8, done: 8, tier1Total: 0 })), '全部 8/8', '8 servable files, 2 the origin does not have');
    assert.equal(detailText(state({ total: 10, wanted: 8, done: 6, gone: 2, tier1Total: 0 })), '全部 8/8', '404s settle towards the same goal');
    // `wanted` is authoritative whenever the payload has it (store.js always fills it in); only a payload without the
    // field at all falls back to `total`, and a run with nothing servable (wanted 0) shows no count line at all
    assert.equal(detailText(state({ total: 10, wanted: undefined, done: 4, tier1Total: 0 })), '全部 4/10');
    assert.equal(detailText(state({ total: 9756, wanted: 0, done: 0, tier1Total: 0 })), '', 'nothing this box can size ⇒ no count line');
    assert.equal(detailText(state({ total: 100, wanted: 90, done: 50, tier1Total: 30, tier1Wanted: 20, tier1Done: 10 })), '必需 10/20 · 全部 50/90');
    const withBytes = state({ total: 3966, wanted: 3966, done: 812, tier1Total: 456, tier1Done: 456, totalBytes: 259726913, sizedTotal: 3966, bytes: 50000000 });
    assert.equal(detailText(withBytes), '必需 456/456 · 全部 812/3966 · 47.7 MiB / 248 MiB');
    assert.equal(detailText(state({ total: 10, done: 1, tier1Total: 0 })), '全部 1/10', 'no essential tier ⇒ no 必需 line');
    // entries the origin does not serve are settled: the line reads 全部 10/10 without 10 files being cached
    assert.equal(detailText(state({ total: 10, done: 8, gone: 2, tier1Total: 0 })), '全部 10/10');
  });

  test('percent: by bytes when every file is sized, by file count otherwise, clamped', () => {
    assert.equal(percent(state()), 0);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 25 })), 25);
    assert.equal(percent(state({ total: 100, wanted: 80, done: 40 })), 50, 'skipped files do not count as missing');
    assert.equal(percent(state({ total: 100, wanted: 100, done: 100 })), 100);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 0, totalBytes: 200, sizedTotal: 100, bytes: 50 })), 25);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 0, totalBytes: 200, sizedTotal: 50, bytes: 50 })), 0, 'a partly sized manifest falls back to files');
    assert.equal(percent(state({ total: 4, wanted: 4, done: 9 })), 100, 'clamped');
    // a manifest with entries nobody serves still reaches the end (store.js counts them as `gone` for `complete`)
    assert.equal(percent(state({ total: 100, wanted: 100, done: 90, gone: 10, complete: true })), 100);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 80, gone: 10, totalBytes: 200, sizedTotal: 100, bytes: 160 })), 90, 'files, not bytes, once entries are missing');
    assert.equal(percent(state({ total: 100, wanted: 100, done: 90, gone: 10, totalBytes: 200, sizedTotal: 100, bytes: 180 })), 100, 'all settled ⇒ done');
  });
});

describe('where the preload is reachable', () => {
  test('the settings modal still has its row (in-match management)', () => {
    const settings = read('public/js/ui/settings.js');
    assert.match(settings, /import \{ ResourceRow \} from '\.\/resourcePanel\.js';/);
    assert.match(settings, /<\$\{ResourceRow\} enabled=\$\{s\.preload\} onChange=\$\{\(v\) => updateSettings\(\{ preload: v \}\)\} \/>/);
  });

  test('the title screen mounts the launcher in its bottom-right corner', () => {
    const title = read('public/js/screens/title.js');
    assert.match(title, /import \{ ResourceLauncher \} from '\.\.\/ui\/resourcePanel\.js';/);
    assert.match(title, /import \{ updateSettings, useSettings \} from '\.\.\/ui\/settings\.js';/);
    assert.match(title, /const settings = useSettings\(\);/);
    assert.match(title, /<div class="title-preload"><\$\{ResourceLauncher\} enabled=\$\{settings\.preload\} onChange=\$\{\(v\) => updateSettings\(\{ preload: v \}\)\} \/><\/div>/);
    const css = read('public/css/screens/title.css');
    assert.match(css, /\.title-preload \{[^}]*position: absolute;[^}]*right: \.44rem;[^}]*bottom: \.86rem;/, 'bottom-right, above the footer');
    assert.match(css, /\.res-pill \{/, 'the pill has its own styling');
  });

  test('the launcher starts the preload in one click and can always undo it', () => {
    const panel = read('public/js/ui/resourcePanel.js');
    assert.match(panel, /export function ResourceLauncher/);
    assert.match(panel, /onClick=\$\{\(\) => \{ if \(!enabled\) onChange\(true\); \}\}/, 'the header starts it');
    assert.match(panel, /onClose=\$\{\(\) => onChange\(false\)\}/, '关闭预载 turns the setting back off');
    assert.match(panel, /if \(!enabled && !st\.supported\) return null;/, 'no clutter on a plain-HTTP LAN');
    assert.match(panel, /disabled=\$\{!enabled && !st\.supported \? 'disabled' : null\}/, 'a browser that cannot cache can still turn it back off');
    assert.match(panel, /onChange\(false\)\}>\$\{t\('关闭预载'\)\}<\/button>/, 'and the pill can always be closed');
    // a failed registration must always be visible: the download still works without the worker, so a hidden warning
    // would look exactly like "the Service Worker never intercepts anything" (see the pill's worker line)
    assert.equal(panel.match(/\$\{st\.worker \? html/g).length, 3, 'all three faces show it (settings row, title pill, manager)');
    assert.equal((panel.match(/\$\{st\.worker && st\.message/g) || []).length, 0, 'never hidden behind a message');
    // the copy never promises offline play: the preload only means "served from the local cache"
    const index = read('public/js/resources/index.js');
    for (const [name, src] of [['resourcePanel.js', panel], ['resources/index.js', index]]) {
      assert.equal(/离线/.test(src), false, `${name}: no 离线 wording`);
      assert.equal(/可离线进入对局|断网[^。]*可用/.test(src), false, `${name}: no offline-play promise`);
    }
    assert.match(panel, /startResources\(\)/, 'continue');
    assert.match(panel, /pauseResources\(\)/, 'pause');
    assert.match(panel, /clearResources\(\)/, 'clear');
    // the two compact faces render the shared actions, so they can never drift apart; the manager has its own action bar
    // plus one progress bar per tier and one for a running ZIP import/export
    assert.equal(panel.match(/\$\{ResourceActions\}/g).length, 2);
    assert.equal(panel.match(/\$\{ProgressBar\}/g).length, 4);
  });

  test('both entry points open the shared resource manager, which is mounted once above every route', () => {
    const panel = read('public/js/ui/resourcePanel.js');
    // the settings row's 资源管理 button and the title pill's link — the two ways into the big modal
    assert.equal(panel.match(/onClick=\$\{openResources\}/g).length, 2, 'settings row + title pill');
    assert.equal(panel.match(/onClick=\$\{closeResources\}/g).length, 1, '关闭 closes it');
    assert.match(panel, /onClose=\$\{closeResources\}/, 'so does the modal chrome (Esc / backdrop)');
    // the manager itself: one section per tier, the ZIP actions and the selection checkbox
    assert.match(panel, /title=\$\{t\('预载资源管理'\)\}/);
    assert.match(panel, /<div class="resource-manager">/);
    assert.match(panel, /<section class="resource-archive">/, 'the ZIP block is its own section');
    assert.match(panel, /<\$\{ResourceTier\} st=\$\{st\} tier=\$\{1\} \/>/);
    assert.match(panel, /<\$\{ResourceTier\} st=\$\{st\} tier=\$\{2\}/);
    assert.match(panel, /t\('导入 ZIP'\)/);
    assert.match(panel, /t\('导出 ZIP'\)/);
    assert.match(panel, /t\('同时预载'\)/, 'the optional-tier selection lives in the manager');
    // main.js mounts it once, above the router, wired to the same settings the other two faces write
    const main = read('public/js/main.js');
    assert.match(main, /import \{ ResourceHost \} from '\.\/ui\/resourcePanel\.js';/);
    assert.match(main, /<\$\{ResourceManagerHost\} \/>/);
    assert.match(main, /<\$\{ResourceHost\} enabled=\$\{settings\.preload\} optional=\$\{settings\.preloadOptional\}/);
    assert.match(main, /syncResources\(!!s\.preload, !!s\.preloadOptional\)/, 'both switches reach the preload controller');
  });
});
