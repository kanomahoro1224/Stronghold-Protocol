// Focused probe: reproduce the CORS failure on the title background and print the full browser message.
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.SP_BASE || 'https://game.xiaolubao.com';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[reqfail]', r.failure()?.errorText, r.resourceType(), r.url()));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('bg_mountains_tiled')) {
    const h = r.headers();
    console.log('[resp]', r.status(), r.fromCache() ? 'fromCache' : 'network',
      'acao=' + (h['access-control-allow-origin'] ?? 'none'), 'vary=' + (h.vary ?? 'none'),
      'cc=' + (h['cache-control'] ?? 'none'), u);
  }
});
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 7000));
const out = await page.evaluate(async () => {
  const url = '/assets/ui/entry/bg_mountains_tiled.png';
  const res = {};
  const timing = (label, fn) => fn().then((v) => { res[label] = v; }, (e) => { res[label] = 'FAIL ' + e.message; });
  await timing('crossOriginImg', async () => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const p = new Promise((resolve, reject) => { img.onload = () => resolve('ok ' + img.naturalWidth + 'px'); img.onerror = () => reject(new Error('onerror')); });
    img.src = url;
    return p;
  });
  await timing('fetchCors', async () => {
    const r = await fetch(url, { mode: 'cors' });
    return r.status + ' acao=' + (r.headers.get('access-control-allow-origin') ?? 'none');
  });
  await timing('fetchPlain', async () => (await fetch(url)).status);
  await timing('xhrCors', async () => {
    return await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'blob';
      x.onload = () => resolve(x.status);
      x.onerror = () => reject(new Error('xhr error'));
      x.send();
    });
  });
  return res;
});
console.log('page-context:', JSON.stringify(out, null, 1));
await browser.close();
