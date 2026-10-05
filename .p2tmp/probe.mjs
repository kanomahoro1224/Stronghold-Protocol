// .tools/phase2-probe.mjs 鈥?verify the planned R2 redirect in a real browser, without touching production.
//
// Boots the game server locally, puts the .tools/edge-shim.mjs in front of it (302 for
// /assets/ /fonts/ /vendor/ /media/ exactly like the nginx rule we plan to add), then drives
// headless Chrome through the dev render demo (Spine units + 3D board) and the title screen.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const R2 = process.env.PROBE_R2 || 'https://local.xiaolubao.com/Stronghold-Protocol';
const SHIM_PORT = Number(process.env.PROBE_SHIM_PORT || 8899);
const OUT = path.join(HERE, 'shots');
mkdirSync(OUT, { recursive: true });

const { startServer } = await import(pathToFileURL(path.join(ROOT, 'server/index.js')).href);
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
console.log('[probe] game server on', srv.port);

const shim = spawn(process.execPath, [path.join(HERE, 'shim.mjs')], {
  env: { ...process.env, SHIM_PORT: String(SHIM_PORT), SHIM_UPSTREAM_PORT: String(srv.port), SHIM_R2: R2 },
  stdio: ['ignore', 'pipe', 'pipe'],
});
shim.stdout.on('data', (d) => process.stdout.write(String(d)));
shim.stderr.on('data', (d) => process.stderr.write('[shim:err] ' + String(d)));
const ORIGIN = `http://127.0.0.1:${SHIM_PORT}`;
await new Promise((r) => setTimeout(r, 900));

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
});

const results = [];

async function newPage() {
  const page = await browser.newPage();
  const problems = [];
  const hosts = new Map();
  const r2assets = new Set();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    let h = '?';
    try { h = new URL(r.url()).host; } catch { /* ignore */ }
    hosts.set(h, (hosts.get(h) || 0) + 1);
    if (h === 'local.xiaolubao.com') r2assets.add(new URL(r.url()).pathname);
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.setViewport({ width: 1600, height: 900 });
  return { page, problems, hosts, r2assets };
}

async function canvasTaint(page) {
  return page.evaluate(() => {
    const out = [];
    for (const c of document.querySelectorAll('canvas')) {
      try { c.toDataURL(); out.push(`${c.width}x${c.height}:ok`); }
      catch (e) { out.push(`${c.width}x${c.height}:TAINTED(${e.name})`); }
    }
    return out.join(' ') || 'no canvas';
  });
}

// ---- 1) 2D battlefield + Spine (units, .skel/.atlas/textures cross-origin) -------------------
{
  const { page, problems, hosts, r2assets } = await newPage();
  await page.goto(`${ORIGIN}/dev/render-demo.html?scene=normal-m01&t=18&panel=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__demo && (window.__demo.ready || window.__demo.error)', { timeout: 60000 });
  const bootErr = await page.evaluate(() => window.__demo.error || null);
  await new Promise((r) => setTimeout(r, 4000));
  const st = await page.evaluate(() => window.__demo.stats());
  const taint = await canvasTaint(page);
  await page.screenshot({ path: path.join(OUT, 'p2-spine-2d.png') });
  results.push({ case: '2D battle (Spine)', bootErr, units: st.units, spine: st.spine, fps: st.fps, mode: st.mode, taint, problems, hosts: Object.fromEntries(hosts), r2paths: r2assets.size });
  await page.close();
}

// ---- 2) 3D board (three.js textures + local client art) --------------------------------------
{
  const { page, problems, hosts, r2assets } = await newPage();
  await page.goto(`${ORIGIN}/dev/render-demo.html?scene=prep&stage=act2autochess_m01&panel=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__demo && (window.__demo.ready || window.__demo.error)', { timeout: 60000 });
  const bootErr = await page.evaluate(() => window.__demo.error || null);
  await new Promise((r) => setTimeout(r, 3000));
  const st = await page.evaluate(() => window.__demo.stats());
  const taint = await canvasTaint(page);
  await page.screenshot({ path: path.join(OUT, 'p2-board3d.png') });
  results.push({ case: '3D board', bootErr, board3d: st.board3d, fps: st.fps, taint, problems, hosts: Object.fromEntries(hosts), r2paths: r2assets.size });
  await page.close();
}

// ---- 3) title screen + /media/ audio (the real entry point players see) -----------------------
{
  const { page, problems, hosts, r2assets } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('document.querySelector("input") !== null', { timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const title = await page.evaluate(() => ({
    hasInput: !!document.querySelector('input'),
    text: (document.body.innerText || '').slice(0, 160).replace(/\s+/g, ' '),
  }));
  const media = await page.evaluate(async () => {
    try {
      const r = await fetch('/media/bgm/m_bat_abyssalhunters_loop');
      return { ok: r.ok, status: r.status, type: r.headers.get('content-type'), len: r.headers.get('content-length'), url: r.url, acao: r.headers.get('access-control-allow-origin') };
    } catch (e) { return { error: String(e) }; }
  });
  const spineDirect = await page.evaluate(async () => {
    try {
      const r = await fetch('/assets/local/ui/battle/trap_1096_acshopup.skel');
      return { ok: r.ok, status: r.status, len: r.headers.get('content-length') };
    } catch (e) { return { error: String(e) }; }
  });
  const taint = await canvasTaint(page);
  await page.screenshot({ path: path.join(OUT, 'p2-title.png') });
  results.push({ case: 'title + media', title, media, spineDirect, taint, problems, hosts: Object.fromEntries(hosts), r2paths: r2assets.size });
  await page.close();
}

console.log('\n=== RESULTS ===');
console.log(JSON.stringify(results, null, 1));

await browser.close();
shim.kill();
await srv.close();
process.exit(0);

