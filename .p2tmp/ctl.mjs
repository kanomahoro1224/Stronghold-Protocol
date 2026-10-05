// .p2tmp/ctl.mjs — control experiment: same pages, direct-to-app vs behind the 302 shim.
// Tells us whether a failure is caused by the cross-origin redirect or already exists locally.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { startServer } = await import(pathToFileURL(path.join(ROOT, 'server/index.js')).href);
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
const DIRECT = `http://127.0.0.1:${srv.port}`;

const shim = spawn(process.execPath, [path.join(HERE, 'shim.mjs')], {
  env: { ...process.env, SHIM_PORT: '8899', SHIM_UPSTREAM_PORT: String(srv.port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
shim.stdout.on('data', (d) => process.stdout.write(String(d)));
shim.stderr.on('data', (d) => process.stderr.write('[shim:err] ' + String(d)));
await new Promise((r) => setTimeout(r, 900));
const VIA = 'http://127.0.0.1:8899';

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] });

async function probe(label, origin, pagePath, waitMs, extraFn) {
  const page = await browser.newPage();
  const logs = [];
  const bad = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 220)));
  page.on('pageerror', (e) => bad.push('pageerror: ' + e.message.slice(0, 220)));
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => bad.push(`FAILED ${r.failure()?.errorText} ${r.url()}`));
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(origin + pagePath, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, waitMs));
  const st = await page.evaluate(extraFn || (() => ({})));
  const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 120).replace(/\s+/g, ' '));
  console.log(`\n--- ${label} [${origin}${pagePath}]`);
  console.log('   text:', JSON.stringify(txt));
  console.log('   state:', JSON.stringify(st));
  console.log('   problems:', bad.length ? JSON.stringify(bad.slice(0, 6), null, 1) : 'none');
  const errs = logs.filter((l) => l.startsWith('error'));
  console.log('   console errors:', errs.length ? JSON.stringify(errs.slice(0, 6), null, 1) : 'none');
  const warn = logs.filter((l) => !l.startsWith('error') && !l.includes('[vite]'));
  console.log('   other console:', warn.length ? JSON.stringify(warn.slice(-8), null, 1) : 'none');
  await page.close();
}

const titleState = () => ({
  hasInput: !!document.querySelector('input'),
  bootErr: window.__spBootErr || null,
  canvases: document.querySelectorAll('canvas').length,
});

for (const [label, origin] of [['DIRECT', DIRECT], ['VIA-SHIM', VIA]]) {
  await probe(`${label} title`, origin, '/', 4000, titleState);
}
for (const [label, origin] of [['DIRECT', DIRECT], ['VIA-SHIM', VIA]]) {
  await probe(`${label} demo-3d`, origin, '/dev/render-demo.html?scene=prep&stage=act2autochess_m01&panel=0', 6000,
    () => ({ ready: !!window.__demo?.ready, err: window.__demo?.error || null, board3d: window.__demo?.stats?.().board3d, mode: window.__demo?.stats?.().mode }));
}
for (const [label, origin] of [['DIRECT', DIRECT], ['VIA-SHIM', VIA]]) {
  await probe(`${label} demo-spine`, origin, '/dev/render-demo.html?scene=normal-m01&t=18&panel=0', 12000,
    () => ({ spine: window.__demo?.stats?.().spine, units: window.__demo?.stats?.().units }));
}

await browser.close();
shim.kill();
await srv.close();
process.exit(0);
