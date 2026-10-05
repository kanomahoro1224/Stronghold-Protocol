// Decisive functional check for the assets-direct change: load the live site once and see WHERE the browser asks for art.
// Expected after 0.1.5-assets-r2: /assets/** requests go to local.xiaolubao.com directly, and the game host stops
// seeing them. Local browser, one page load, no server-side load.
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const r2 = [];
const hostAssets = [];
const hostOther = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('local.xiaolubao.com') && !u.endsWith('.css')) r2.push(u);
  else if (/game\.xiaolubao\.com\/assets\//.test(u)) hostAssets.push(u);
  else if (/game\.xiaolubao\.com\/(js|css|data|vendor|sim|shared)\//.test(u)) hostOther.push(u);
});
page.on('response', async (res) => {
  const u = res.url();
  if (/game\.xiaolubao\.com\/assets\//.test(u)) console.log('  host asset response:', res.status(), u);
});

await page.goto('https://game.xiaolubao.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 15000));

console.log('=== where the browser asked for art ===');
console.log('  local.xiaolubao.com (R2 direct):', r2.length);
console.log('  game host /assets/         :', hostAssets.length);
console.log('  game host js/css/data      :', hostOther.length);
console.log('=== first few of each ===');
console.log(r2.slice(0, 4).map((u) => '  R2   ' + u).join('\n') || '  R2   (none yet)');
console.log(hostAssets.slice(0, 4).map((u) => '  HOST ' + u).join('\n') || '  HOST (none)');
console.log('=== what an <img> resolves to on the page ===');
console.log(JSON.stringify(await page.$$eval('img', (els) => els.slice(0, 4).map((e) => e.src)), null, 1));
console.log('=== did the manifest get rewritten in the page? ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const m = await import('/js/assetOrigin.js').catch(() => null);
  return { assetBase: m ? m.assetBase() : 'module not loadable', sample: m ? m.assetUrl('/assets/x.png') : null };
}), null, 1));
await browser.close();
