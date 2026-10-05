// .p2tmp/lobby-phone.mjs — short-landscape phone check for the third mode card + the 搜寻队友 panel
// (devices.css @media max-height:460px). Throwaway.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, matchQueueMaxWaitMs: 60000 });
const base = `http://127.0.0.1:${srv.port}`;
const problems = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 90000,
  args: ['--no-sandbox', '--no-first-run', '--mute-audio'] });
try {
  const [first] = await browser.pages();
  const page = first || await browser.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(m.location()?.url || '')) problems.push(`console: ${m.text()}`); });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('sp.name', '博士P'); sessionStorage.setItem('sp.entered', '1'); });
  const report = {};
  for (const [w, h] of [[844, 390], [756, 366]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('.lobby-screen'), { timeout: 30000 });
    await sleep(600);
    await page.screenshot({ path: path.join(OUT, `matchmaking-phone-${w}x${h}-modes.png`) });
    const m = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.mode-card')];
      const box = document.querySelector('.mode-cards').getBoundingClientRect();
      return {
        cards: cards.length,
        cardW: Math.round(cards[2].getBoundingClientRect().width),
        rowBottom: Math.round(box.bottom),
        thirdVisible: cards[2].getBoundingClientRect().right <= innerWidth + 1,
        btnBottom: Math.round(document.querySelector('.create-box .btn').getBoundingClientRect().bottom),
        viewportH: innerHeight,
      };
    });
    // search: the panel is the tallest state, check it fits / scrolls
    await page.evaluate(() => { [...document.querySelectorAll('.mode-card')].find((e) => e.textContent.includes('同盟匹配')).click(); });
    await sleep(150);
    await page.evaluate(() => document.querySelector('.create-box .btn').click());
    await page.waitForFunction(() => !!document.querySelector('.match-panel'), { timeout: 10000 });
    await sleep(500);
    await page.screenshot({ path: path.join(OUT, `matchmaking-phone-${w}x${h}-searching.png`) });
    const p = await page.evaluate(() => {
      const panel = document.querySelector('.match-panel').getBoundingClientRect();
      const acts = [...document.querySelectorAll('.match-panel .btn')].map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; });
      return { panelBottom: Math.round(panel.bottom), acts, scrollH: document.querySelector('.lobby-body').scrollHeight, clientH: document.querySelector('.lobby-body').clientHeight };
    });
    report[`${w}x${h}`] = { modes: m, panel: p };
    await page.evaluate(() => globalThis.__SP__.net.request('queue.leave', {}));
    await sleep(200);
  }
  console.log(JSON.stringify({ report, problems }, null, 2));
} finally {
  await browser.close().catch(() => {});
  await srv.close();
}
