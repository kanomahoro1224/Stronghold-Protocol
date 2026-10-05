// .p2tmp/probe2.mjs — round 2: same as probe but with the versioned redirect and longer settle times.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(HERE, 'shots');
mkdirSync(OUT, { recursive: true });

const { startServer } = await import(pathToFileURL(path.join(ROOT, 'server/index.js')).href);
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
console.log('[probe] game server on', srv.port);

const shim = spawn(process.execPath, [path.join(HERE, 'shim.mjs')], {
  env: { ...process.env, SHIM_PORT: '8899', SHIM_UPSTREAM_PORT: String(srv.port), SHIM_R2_VERSION: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
shim.stdout.on('data', (d) => process.stdout.write(String(d)));
shim.stderr.on('data', (d) => process.stderr.write('[shim:err] ' + String(d)));
await new Promise((r) => setTimeout(r, 900));

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

const results = [];
async function newPage() {
  const page = await browser.newPage();
  const problems = [];
  const hosts = new Map();
  const r2 = new Set();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text().slice(0, 160)); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message.slice(0, 160)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    hosts.set(u.host, (hosts.get(u.host) || 0) + 1);
    if (u.host === 'local.xiaolubao.com') r2.add(u.pathname);
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url().slice(0, 130)}`);
  });
  await page.setViewport({ width: 1440, height: 810 });
  return { page, problems, hosts, r2 };
}
const taint = (page) => page.evaluate(() => [...document.querySelectorAll('canvas')]
  .map((c) => { try { c.toDataURL(); return `${c.width}x${c.height}:ok`; } catch (e) { return `${c.width}x${c.height}:TAINTED`; } }).join(' ') || 'no canvas');

// 1) title screen — the real entry point, boots the whole module graph
{
  const { page, problems, hosts, r2 } = await newPage();
  await page.goto('http://127.0.0.1:8899/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 6000));
  const st = await page.evaluate(() => ({
    hasInput: !!document.querySelector('input'),
    text: (document.body.innerText || '').slice(0, 90).replace(/\s+/g, ' '),
    fonts: document.fonts ? [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ':' + f.weight) : [],
  }));
  await page.screenshot({ path: path.join(OUT, 'p2b-title.png') });
  results.push({ case: 'title', ...st, taint: await taint(page), problems, hosts: Object.fromEntries(hosts), r2paths: r2.size });
  await page.close();
}

// 2) 3D board (three.js, local client art, tiles.json)
{
  const { page, problems, hosts, r2 } = await newPage();
  await page.goto('http://127.0.0.1:8899/dev/render-demo.html?scene=prep&stage=act2autochess_m01&panel=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__demo && (window.__demo.ready || window.__demo.error)', { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 7000));
  const st = await page.evaluate(() => ({ ready: !!window.__demo?.ready, err: window.__demo?.error || null, board3d: window.__demo?.stats?.().board3d, boardArt: window.__demo?.stats?.().boardArt, fps: window.__demo?.stats?.().fps }));
  await page.screenshot({ path: path.join(OUT, 'p2b-board3d.png') });
  results.push({ case: '3D board', ...st, taint: await taint(page), problems, hosts: Object.fromEntries(hosts), r2paths: r2.size });
  await page.close();
}

// 3) 2D battlefield + Spine (the heavy cross-origin path)
{
  const { page, problems, hosts, r2 } = await newPage();
  await page.goto('http://127.0.0.1:8899/dev/render-demo.html?scene=normal-m01&t=18&panel=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__demo && (window.__demo.ready || window.__demo.error)', { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 16000));
  const st = await page.evaluate(() => { const s = window.__demo?.stats?.() || {}; return { units: s.units, spine: s.spine, boardArt: s.boardArt, fps: s.fps, mode: s.mode }; });
  await page.screenshot({ path: path.join(OUT, 'p2b-spine.png') });
  results.push({ case: '2D + Spine', ...st, taint: await taint(page), problems, hosts: Object.fromEntries(hosts), r2paths: r2.size });
  await page.close();
}

console.log('\n=== RESULTS ===');
for (const r of results) console.log(JSON.stringify(r, null, 1));

await browser.close();
shim.kill();
await srv.close();
process.exit(0);
