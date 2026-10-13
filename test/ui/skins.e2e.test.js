// Browser E2E for 干员皮肤 (docs/SKINS.md) in headless Chrome. Opt-in, like the other E2E files.
//
//   SP_E2E=1 node --test test/ui/skins.e2e.test.js
//
// What it pins down, in the real picker inside the real 干员调配 screen:
//   * the 皮肤 section appears for an operator that HAS skins and is absent for one that has none (the section
//     hides itself rather than showing an empty box);
//   * every skin the catalogue lists is selectable — the install step is not part of the game (docs/SKINS.md), so
//     no tile is ever an install button;
//   * choosing one persists it for this browser, which is what the sync sends to the server.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

/** A base, visible chess record — the rows the roster actually renders. */
const isRosterChess = (id, rec) => !rec.isGolden && rec.visible !== false && !rec.isHidden && !rec.isDiy && (!rec.baseId || rec.baseId === id);

/**
 * The CHESS id of a roster row whose operator has skin models in this install. The roster is keyed by chess id
 * (`chess_char_1_01_a`) while the manifest is keyed by operator (`char_498_inside`), so the two have to be joined
 * through data/chess.json's `charId` — exactly the mapping the picker needs and gets wrong at its peril.
 * @param {(charId: string, skins: Record<string, unknown>) => boolean} want
 */
function chessIdWhere(want) {
  try {
    const chess = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
    const m = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
    for (const [id, rec] of Object.entries(chess)) {
      if (!isRosterChess(id, rec)) continue;
      if (want(rec.charId, m.chars?.[rec.charId]?.skins || {})) return id;
    }
  } catch { /* no data */ }
  return null;
}

const CATALOG = (() => { try { return JSON.parse(readFileSync(path.join(ROOT, 'data/skins.json'), 'utf8')); } catch { return { chars: {} }; } })();

/** A row whose operator this install has at least one skin model for — the 选中 case. */
const skinnedChessId = () => chessIdWhere((_c, skins) => Object.keys(skins).length > 0);

/** A row whose operator has skins in the catalogue — enough to assert the section renders. */
const anySkinChessId = () => chessIdWhere((charId) => (CATALOG.chars?.[charId] || []).length > 0);

const NO_SKINS = skinnedChessId() ? false : 'no skin models in this install — run: node tools/install-skins.mjs add <skinId>';

describe('skin picker (browser)', { skip: !ENABLED }, () => {
  let server; let browser; let page;
  const errors = [];

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    server = await startServer({ port: 0, quiet: true });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.name', 'E2E皮肤');
      sessionStorage.setItem('sp.entered', '1');
    });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
  });

  after(async () => {
    try { await browser?.close(); } catch { /* gone */ }
    try { await server?.close(); } catch { /* gone */ }
  });

  /** Open 干员调配 and select the operator whose base chess id is `charId`. */
  async function openDetailFor(charId) {
    // the roster row and the button the 干员调配 screen itself uses (screens/loadout.js LoadoutButton)
    await page.waitForSelector('[data-testid="loadout-open"]', { timeout: 20000 });
    await page.click('[data-testid="loadout-open"]');
    await page.waitForSelector('.lo-detail', { timeout: 10000 });
    const ok = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll('[data-chess]')];
      const row = rows.find((r) => r.getAttribute('data-chess') === id);
      if (!row) return false;
      row.click();
      return true;
    }, charId);
    return ok;
  }

  test('the 皮肤 section lists the operator\'s skins', async () => {
    const row = anySkinChessId();
    assert.ok(row, 'some roster operator has skins in the catalogue');
    assert.ok(await openDetailFor(row), `the roster has a row for ${row}`);

    await page.waitForSelector('[data-testid="skin-section"]', { timeout: 5000 });
    const tiles = await page.$$eval('[data-testid="skin-section"] .lo-skin', (els) => els.map((b) => ({
      skin: b.getAttribute('data-skin'),
      disabled: b.disabled,
      checked: b.getAttribute('aria-checked'),
      text: b.textContent.trim(),
    })));
    assert.ok(tiles.length >= 2, `默认 + at least one skin, got ${tiles.length}`);
    assert.equal(tiles[0].skin, '', 'the first tile is 默认');
    assert.equal(tiles[0].checked, 'true', 'nothing chosen yet → 默认 is selected');
    assert.ok(tiles.every((t) => !t.disabled), 'no tile is disabled — there is no install step to wait for');
  });

  test('a skin can be chosen and persists for this browser', { skip: NO_SKINS }, async () => {
    assert.ok(await openDetailFor(skinnedChessId()), 'the roster row of an operator with skin models');
    const chosen = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('[data-testid="skin-section"] .lo-skin')];
      const b = tiles.find((x) => x.getAttribute('data-skin'));
      if (!b) return null;
      b.click();
      return b.getAttribute('data-skin');
    });
    assert.ok(chosen, 'this operator has a skin tile to select');
    // compared in JS, not through a CSS selector: a skin id contains '@' and '#' and escaping it into an attribute
    // selector is exactly the kind of thing that fails for reasons unrelated to the feature
    await page.waitForFunction((id) => {
      const tiles = [...document.querySelectorAll('[data-testid="skin-section"] .lo-skin')];
      return tiles.some((b) => b.getAttribute('data-skin') === id && b.getAttribute('aria-checked') === 'true');
    }, { timeout: 5000 }, chosen);

    // and it is persisted for this browser, which is what the sync sends to the server
    const stored = await page.evaluate(() => localStorage.getItem('sp.pref.skins'));
    assert.match(stored || '', new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the choice is saved to localStorage');

    // 默认 clears it again
    await page.evaluate(() => document.querySelector('[data-testid="skin-section"] .lo-skin--default').click());
    await page.waitForFunction(() => document.querySelector('[data-testid="skin-section"] .lo-skin--default')?.getAttribute('aria-checked') === 'true', { timeout: 5000 });
  });

  test('an operator with no skins shows no section at all', async () => {
    const cat = JSON.parse(readFileSync(path.join(ROOT, 'data/skins.json'), 'utf8'));
    const bare = chessIdWhere((charId) => !(cat.chars?.[charId] || []).length);
    if (!bare) return; // every roster operator happens to have skins — nothing to assert
    await openDetailFor(bare);
    await page.waitForSelector('.lo-detail', { timeout: 5000 });
    const title = await page.$eval('.lo-dhead__name', (el) => el.textContent.trim()).catch(() => '');
    assert.equal(await page.$('[data-testid="skin-section"]'), null, `no empty 皮肤 box for ${bare} (${title})`);
  });
});
