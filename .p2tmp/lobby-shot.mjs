// .p2tmp/lobby-shot.mjs — quick UI look at 同盟匹配 (DESIGN §22): 3 mode cards, the search panel with 2 real players
// in it, the lone-searcher hint and the room the pool forms. Local server + headless Chrome; screenshots to
// test/e2e/out/. Throwaway (gitignored .p2tmp/): the durable test is test/lobby-matchmaking.test.js.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.js';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WAIT_MS = 7000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, matchQueueMaxWaitMs: WAIT_MS });
const base = `http://127.0.0.1:${srv.port}`;
const problems = [];
const browsers = [];

async function player(name) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 90000,
    args: ['--no-sandbox', '--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  browsers.push(browser);
  const [first] = await browser.pages();
  const page = first || await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(m.location()?.url || '')) problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !/fonts\.(googleapis|gstatic)\.com/.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.evaluateOnNewDocument((n) => { localStorage.setItem('sp.name', n); sessionStorage.setItem('sp.entered', '1'); }, name);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen'), { timeout: 30000 });
  await sleep(500); // card-in animation
  return page;
}
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').includes(text));
  if (!el) throw new Error(`no ${sel} with ${text}`);
  el.click();
}, sel, text);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `matchmaking-${name}.png`) });
const queueState = (page) => page.evaluate(() => globalThis.__SP__.store.get().queue);
const roomState = (page) => page.evaluate(() => {
  const r = globalThis.__SP__.store.get().room;
  return r ? { code: r.code, inMatch: r.inMatch, humans: r.seats.filter((s) => s && !s.isBot).length, bots: r.seats.filter((s) => s && s.isBot).length, ready: r.seats.filter((s) => s).every((s) => s.ready) } : null;
});

try {
  // --- A: the mode screen (3 cards), the selection, then the search ------------------------------------------
  const a = await player('博士A');
  await shot(a, '1-modes');
  const cards = await a.evaluate(() => [...document.querySelectorAll('.mode-card')].map((c) => c.textContent.trim().replace(/\s+/g, ' ')));
  await clickText(a, '.mode-card', '同盟匹配');
  await sleep(300);
  const button = await a.evaluate(() => document.querySelector('.create-box .btn')?.textContent.trim());
  const selected = await a.evaluate(() => document.querySelector('.mode-card.is-selected')?.textContent.includes('同盟匹配'));
  await shot(a, '2-match-selected');

  // B boots first, so both sit in the pool well before the deadline: the 2/4 window stays visible on A.
  const b = await player('博士B');
  await clickText(b, '.mode-card', '同盟匹配');
  await sleep(200);
  await clickText(a, '.create-box .btn', '开始搜寻队友');
  await a.waitForFunction(() => !!document.querySelector('.match-panel'), { timeout: 10000 });
  await sleep(300);
  await shot(a, '3-searching-1p');

  await clickText(b, '.create-box .btn', '开始搜寻队友');
  await a.waitForFunction(() => (globalThis.__SP__.store.get().queue?.size || 0) === 2, { timeout: 10000 });
  const q2 = await queueState(a);
  await sleep(250);
  await shot(a, '4-searching-2p');

  // the deadline forms the room for both: 2 humans + 2 AI, already started, no ready check
  await a.waitForFunction(() => !!globalThis.__SP__.store.get().room?.inMatch, { timeout: 25000 });
  await sleep(1500); // the room screen's entrance
  const ra = await roomState(a);
  const rb = await roomState(b);
  await shot(a, '5-room-matched');

  // --- C: a lone searcher in another difficulty only gets the hint (no button may start the pool by hand) -----
  const c = await player('博士C');
  await clickText(c, '.diff-card', '终极');
  await clickText(c, '.mode-card', '同盟匹配');
  await sleep(200);
  await clickText(c, '.create-box .btn', '开始搜寻队友');
  await c.waitForFunction(() => globalThis.__SP__.store.get().queue?.solo === true, { timeout: 25000 });
  const hint = await c.evaluate(() => document.querySelector('.match-panel__note')?.textContent.trim());
  const panelButtons = await c.evaluate(() => [...document.querySelectorAll('.match-panel .btn')].map((b) => b.textContent.trim()));
  await sleep(300);
  await shot(c, '6-solo-hint');
  await clickText(c, '.match-panel .btn', '取消搜寻');
  await c.waitForFunction(() => !globalThis.__SP__.store.get().queue, { timeout: 10000 });
  await sleep(400);
  const afterCancel = await c.evaluate(() => ({ searching: !!document.querySelector('.match-panel'), cards: document.querySelectorAll('.mode-card').length }));
  await shot(c, '7-cancelled');

  console.log(JSON.stringify({ cards, selected, button, queue2p: q2, roomA: ra, roomB: rb, soloHint: hint, panelButtons, afterCancel, problems }, null, 2));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  await srv.close();
}
