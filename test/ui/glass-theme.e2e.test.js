// 液态玻璃界面主题 (opt-in, needs Chrome, ~40 s):
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/glass-theme.e2e.test.js
//
// The lobby top bar's theme button (ui/theme.js) sits beside 添加到桌面 and switches `<html data-ui-theme>`; the glass
// skin is css/glass.css. This drives it end to end: the attribute, the persisted setting, the backdrop-filter and the
// inset rim a hub surface actually paints, the removal of the top black mask, and the round trip back. Both themes are
// written to test/e2e/out/theme-*.png for a human look. Static counterpart: test/ui/glass-theme.test.js.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
// fileURLToPath: `.pathname` gives `/F:/…` on Windows, which puppeteer then opens as `F:\F:\…`
const shot = (name) => fileURLToPath(new URL(`../e2e/out/${name}.png`, import.meta.url));

describe('液态玻璃界面主题 in the lobby (headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    const P = (await import('puppeteer-core')).default;
    browser = await P.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
    mkdirSync(new URL('../e2e/out/', import.meta.url), { recursive: true });
  });

  after(async () => { await browser?.close(); await srv?.close(); });

  /** The lobby of a returning player: sp.name + sessionStorage.sp.entered skips the title screen (community-controls). */  async function openLobby(width = 1600) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.setViewport({ width, height: width < 1000 ? 390 : 900 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.name', 'Doctor');
      sessionStorage.setItem('sp.entered', '1');
    });
    await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.lobby-screen');
    return { context, page, problems };
  }

  /**
   * The hub surfaces carry `transition: background` (lobby.css), so switching the skin cross-fades the fill:
   * getComputedStyle returns the interpolated value until it settles (an injected probe rule loses to it too).
   */
  const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 500)));

  /** What the skin looks like from the page: the attribute, the saved setting and the painted surfaces. */
  const skin = (page) => page.evaluate(() => {    const px = (sel) => (sel ? getComputedStyle(sel) : null);
    const entry = document.querySelector('.hub-entry');
    const tile = document.querySelector('.hub-tile');
    const es = px(entry);
    const vig = document.querySelector('.hub-bg__vignette');
    const bar = document.querySelector('.hub-topbar');
    return {
      attr: document.documentElement.dataset.uiTheme,
      saved: JSON.parse(localStorage.getItem('sp.pref.settings') || '{}').uiTheme,
      button: document.querySelector('[data-testid="ui-theme"]')?.getAttribute('aria-label') || null,
      pressed: document.querySelector('[data-testid="ui-theme"]')?.getAttribute('aria-pressed') || null,
      entryBlur: es ? (es.backdropFilter || es.webkitBackdropFilter) : null,
      entryShadow: es ? es.boxShadow : null,
      entryBg: es ? es.backgroundColor : null,
      entryBorder: es ? es.borderTopColor : null,
      tileBg: tile ? getComputedStyle(tile).backgroundColor : null,
      tileLeft: tile ? getComputedStyle(tile).borderLeftColor : null,
      plateBg: document.querySelector('.hub-plate') ? getComputedStyle(document.querySelector('.hub-plate')).backgroundImage : null,
      vignette: vig ? getComputedStyle(vig).backgroundImage : null,
      topbar: bar ? getComputedStyle(bar).backgroundImage : null,
      hit: (() => {
        const b = document.querySelector('[data-testid="ui-theme"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { onScreen: r.x >= 0 && r.right <= innerWidth && r.y >= 0, clickable: at === b || b.contains(at) };
      })(),
    };
  });

  test('the theme button switches both skins, persists, and the top black mask is gone', async () => {
    const { context, page, problems } = await openLobby();
    try {
      await page.evaluate(() => document.fonts.ready);
      const before = await skin(page);
      // this branch's own interface: the attribute is on <html>, no blur is painted, and the button offers the skin
      assert.equal(before.attr, 'default');
      // nothing saved yet: the default is the stylesheet's own look, not a stored choice
      assert.ok(before.saved === undefined || before.saved === 'default', `unexpected saved skin ${before.saved}`);
      assert.equal(before.entryBlur, 'none', `default hub-entry must not blur: ${before.entryBlur}`);
      // Button drops aria-pressed when `active` is false (components.js), so "not pressed" reads as null here
      assert.ok(before.pressed === null || before.pressed === 'false', `unexpected aria-pressed ${before.pressed}`);
      assert.equal(before.hit.clickable, true, 'the theme button must be clickable where it sits');
      assert.equal(before.hit.onScreen, true);
      await page.screenshot({ path: shot('theme-default') });

      // the top black mask (用户 2026-10-15): the 16 %-tall black band over the backdrop photo and the .85 top bar scrim
      assert.ok(!/rgba\(0, 0, 0, 0\.42\)/.test(before.vignette), `the top band is still painted: ${before.vignette}`);
      assert.ok(/radial-gradient/.test(before.vignette), 'the corner vignette stays');
      assert.ok(/rgba\(4, 8, 8, 0\.5\)/.test(before.topbar), `the top bar scrim must be softened: ${before.topbar}`);

      // one click: the glass skin
      await page.click('[data-testid="ui-theme"]');
      await page.waitForFunction(() => document.documentElement.dataset.uiTheme === 'glass');
      await settle(page);
      const glass = await skin(page);
      assert.equal(glass.saved, 'glass', 'the choice is persisted with the other settings');
      assert.equal(glass.pressed, 'true');
      assert.match(glass.entryBlur, /blur/, `the hub entry must blur its backdrop: ${glass.entryBlur}`);
      assert.match(glass.entryShadow, /inset/, `the hub entry must paint the inset rim: ${glass.entryShadow}`);
      assert.match(glass.tileBg, /^rgba\(255, 255, 255, 0\.0/, `the tile must turn translucent: ${glass.tileBg}`);
      assert.equal(glass.tileLeft, before.tileLeft, 'the mint spine of the left column stays');
      assert.match(glass.plateBg, /linear-gradient/, 'the plates keep their bracket marks');
      assert.ok(!/rgba\(0, 0, 0, 0\.42\)/.test(glass.vignette), 'the top band stays gone in the glass skin');
      await page.screenshot({ path: shot('theme-glass') });

      // a reload keeps the skin (sp.pref.settings), and the button switches back
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('.lobby-screen');
      assert.equal((await skin(page)).attr, 'glass', 'the skin survives a reload');
      await page.click('[data-testid="ui-theme"]');
      await page.waitForFunction(() => document.documentElement.dataset.uiTheme === 'default');
      await settle(page);
      assert.equal((await skin(page)).saved, 'default');
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test('a phone (844×390) keeps the button reachable and the glass light', async () => {
    const { context, page, problems } = await openLobby(844);
    try {
      await page.evaluate(() => document.fonts.ready);
      const before = await skin(page);
      assert.equal(before.hit.clickable, true, 'the theme button must stay reachable on a phone');
      assert.equal(before.hit.onScreen, true);
      await page.click('[data-testid="ui-theme"]');
      await page.waitForFunction(() => document.documentElement.dataset.uiTheme === 'glass');
      await settle(page);
      const glass = await skin(page);
      assert.match(glass.entryBlur, /blur/, `the phone also blurs: ${glass.entryBlur}`);
      await page.screenshot({ path: shot('theme-glass-phone') });
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });
});
