// Does the browser's redirected (hop 2) request to R2 carry an Origin header?
// If yes, an edge-cached copy of that URL is always stored WITH access-control-allow-origin,
// so forcing edge caching on .skel/.atlas/.obj/.json cannot poison the fetch-based loaders.
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.SP_BASE || 'https://game.xiaolubao.com';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const seen = new Map();          // path+query -> {origin, type, ok}
const responses = new Map();
page.on('request', (r) => {
  const u = new URL(r.url());
  if (!u.hostname.includes('local.xiaolubao.com')) return;
  const ext = (u.pathname.match(/\.[a-z0-9]+$/) || ['(none)'])[0];
  const key = ext + ' ' + (u.search.includes('co=1') ? 'co=1' : 'plain');
  const h = r.headers();
  const prev = seen.get(key) || { n: 0, origin: 0, types: new Set() };
  prev.n++;
  if (h.origin) prev.origin++;
  prev.types.add(r.resourceType());
  seen.set(key, prev);
});
page.on('response', (r) => {
  const u = new URL(r.url());
  if (!u.hostname.includes('local.xiaolubao.com')) return;
  const ext = (u.pathname.match(/\.[a-z0-9]+$/) || ['(none)'])[0];
  const key = ext + ' ' + (u.search.includes('co=1') ? 'co=1' : 'plain');
  const h = r.headers();
  responses.set(key, { acao: h['access-control-allow-origin'] ?? 'none', cf: h['cf-cache-status'] ?? 'none' });
});
await page.goto(BASE + '/dev/render-demo.html?scene=normal-m01&t=18&panel=0', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 12000));
console.log('key'.padEnd(22), 'reqs', 'withOrigin', 'ACAO', 'cf-cache-status');
for (const [key, v] of [...seen.entries()].sort()) {
  const resp = responses.get(key) || {};
  console.log(key.padEnd(22), String(v.n).padStart(4), String(v.origin).padStart(10), String(resp.acao).padStart(5), resp.cf ?? '-', [...v.types].join('/'));
}
await browser.close();
