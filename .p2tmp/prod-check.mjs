// .p2tmp/prod-check.mjs — verify the live site after the nginx R2 redirect, with a real browser.
// Drives https://game.xiaolubao.com (no shim): title screen must boot, assets must come from R2,
// the dev render demo (if deployed) must still load Spine + the 3D board.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROD_BASE || 'https://game.xiaolubao.com';
const OUT = path.join(HERE, 'shots');
mkdirSync(OUT, { recursive: true });

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function open(url, waitMs, waitFor) {
  const page = await browser.newPage();
  if (process.env.SP_COOKIE) {
    const [name, value] = process.env.SP_COOKIE.split('=');
    await page.setCookie({ name, value, domain: 'game.xiaolubao.com', path: '/' });
  }
  const problems = [];
  const hosts = new Map();
  const r2 = new Set();
  const r2rel = new Set();
  const redirected = new Set();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text().slice(0, 180)); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message.slice(0, 180)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    hosts.set(u.host, (hosts.get(u.host) || 0) + 1);
    if (u.host === 'local.xiaolubao.com') r2.add(u.pathname);
    if (u.host === 'local.xiaolubao.com' && u.pathname.includes('/rel/')) r2rel.add(u.pathname);
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url().slice(0, 140)}`);
  });
  page.on('request', (r) => {
    const prev = r.redirectChain?.();
    if (prev && prev.length && r.url().includes('local.xiaolubao.com')) redirected.add(r.url().split('?')[0]);
  });
  await page.setViewport({ width: 1440, height: 810 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (waitFor) await page.waitForFunction(waitFor, { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, waitMs));
  return { page, problems, hosts, r2, r2rel, redirected };
}

const results = [];

// 1) title screen — the entry point every player hits
{
  const { page, problems, hosts, r2, r2rel } = await open(BASE + '/', 7000, 'document.querySelector("input") !== null');
  const st = await page.evaluate(() => ({
    hasInput: !!document.querySelector('input'),
    text: (document.body.innerText || '').slice(0, 80).replace(/\s+/g, ' '),
  }));
  await page.screenshot({ path: path.join(OUT, 'prod-title.png') });
  results.push({ case: 'title', ...st, problems, hosts: Object.fromEntries(hosts), r2assets: r2.size, r2mirrorFiles: r2rel.size });
  await page.close();
}

// 2) dev render demo — spine + 3D board, if the deployed build ships it
{
  const { page, problems, hosts, r2, redirected } = await open(BASE + '/dev/render-demo.html?scene=prep&stage=act2autochess_m01&panel=0', 8000,
    'window.__demo && (window.__demo.ready || window.__demo.error)');
  const st = await page.evaluate(() => ({ ready: !!window.__demo?.ready, err: window.__demo?.error || null, s: window.__demo?.stats?.() || null }));
  await page.screenshot({ path: path.join(OUT, 'prod-demo.png') });
  results.push({ case: 'demo-3d', ready: st.ready, err: st.err, board3d: st.s?.board3d, spine: st.s?.spine, units: st.s?.units, fps: st.s?.fps, problems, hosts: Object.fromEntries(hosts), r2assets: r2.size, redirectedSamples: [...redirected].slice(0, 4) });
  await page.close();
}

// 3) spine-heavy battle scene
{
  const { page, problems, hosts, r2 } = await open(BASE + '/dev/render-demo.html?scene=normal-m01&t=18&panel=0', 14000,
    'window.__demo && (window.__demo.ready || window.__demo.error)');
  const st = await page.evaluate(() => { const s = window.__demo?.stats?.() || {}; return { units: s.units, spine: s.spine, boardArt: s.boardArt, fps: s.fps, mode: s.mode }; });
  await page.screenshot({ path: path.join(OUT, 'prod-spine.png') });
  results.push({ case: 'demo-spine', ...st, problems, hosts: Object.fromEntries(hosts), r2assets: r2.size });
  await page.close();
}

// 4) the sim module graph + data fetches: this pulls /sim + /shared + /data (+ the /data.js shim)
//    through the redirect, which is the part the title screen alone does not exercise
{
  const { page, problems, hosts, r2, r2rel } = await open(BASE + '/', 3000, 'document.querySelector("input") !== null');
  const st = await page.evaluate(async () => {
    const out = { sim: null, simSupport: null, data: null, shim: null, assets: null };
    try { const m = await import('/sim/spec.js'); out.sim = typeof m.createBattle === 'function' || Object.keys(m).length; } catch (e) { out.sim = 'ERR ' + e.message; }
    try { const m = await import('/sim/content/support/index.js'); out.simSupport = Object.keys(m).length; } catch (e) { out.simSupport = 'ERR ' + e.message; }
    try { const r = await fetch('/data/chess.json'); out.data = r.status + ' ' + (r.ok ? typeof (await r.json()) : ''); } catch (e) { out.data = 'ERR ' + e.message; }
    try { const m = await import('/data.js'); out.shim = typeof m.getData + '/' + typeof m.resetData; } catch (e) { out.shim = 'ERR ' + e.message; }
    try { const m = await import('/shared/protocol.js'); out.assets = Object.keys(m).length; } catch (e) { out.assets = 'ERR ' + e.message; }
    return out;
  });
  results.push({ case: 'sim-graph', ...st, problems, hosts: Object.fromEntries(hosts), r2mirrorFiles: r2rel.size });
  await page.close();
}

console.log('\n=== PROD RESULTS ===');
for (const r of results) console.log(JSON.stringify(r, null, 1));
await browser.close();
process.exit(0);
