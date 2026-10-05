// .p2tmp/err.mjs — print the FULL text of CORS-ish console errors under the redirect.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { startServer } = await import(pathToFileURL(path.join(ROOT, 'server/index.js')).href);
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
const shim = spawn(process.execPath, [path.join(HERE, 'shim.mjs')], {
  env: { ...process.env, SHIM_PORT: '8899', SHIM_UPSTREAM_PORT: String(srv.port), SHIM_R2_VERSION: process.env.SHIM_R2_VERSION || '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
shim.stdout.on('data', (d) => process.stdout.write(String(d)));
await new Promise((r) => setTimeout(r, 900));

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/blocked|CORS|Access to|ERR_/.test(t)) console.log(`\n[${m.type()}] ${t}`);
});
page.on('requestfailed', (r) => console.log(`\n[requestfailed] ${r.failure()?.errorText} ${r.url()}`));
page.on('request', (r) => {
  if (r.url().includes('bg_mountains') || r.url().includes('.skel')) console.log(`[req] ${r.url()} mode=${r.method()} headers.Origin=${(r.headers().origin) ?? '-'}`);
});
await page.setViewport({ width: 1280, height: 720 });
await page.goto('http://127.0.0.1:8899/dev/render-demo.html?scene=prep&stage=act2autochess_m01&panel=0', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__demo && (window.__demo.ready || window.__demo.error)', { timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 8000));

// ask the browser directly: same-origin URL -> 302 -> R2, as a CORS image and as a CORS fetch
const direct = await page.evaluate(async () => {
  const url = '/assets/ui/entry/bg_mountains_tiled.png';
  const img = await new Promise((res) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res({ ok: true, w: i.naturalWidth });
    i.onerror = (e) => res({ ok: false, err: String(e?.message || e) });
    i.src = url;
  });
  let f;
  try { const r = await fetch(url, { mode: 'cors' }); f = { ok: r.ok, status: r.status, type: r.headers.get('content-type') }; }
  catch (e) { f = { error: String(e) }; }
  return { img, fetch: f };
});
console.log('\n[direct check]', JSON.stringify(direct, null, 1));

await browser.close();
shim.kill();
await srv.close();
process.exit(0);
