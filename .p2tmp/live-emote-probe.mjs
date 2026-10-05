// .p2tmp/live-emote-probe.mjs — check the LIVE site's emote wheel in a real browser, without touching any match:
// load https://game.xiaolubao.com/, mount EmoteWheel from the deployed bundle, read what it resolved.
//   node .p2tmp/live-emote-probe.mjs            (sprites available)
//   node .p2tmp/live-emote-probe.mjs --block    (the user's case: the plate sprites do not load)
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH;
const block = process.argv.includes('--block');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
if (block) {
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().includes('/assets/local/ui/battle/emoji_')
    ? r.respond({ status: 404, contentType: 'text/plain', body: 'blocked' })
    : r.continue().catch(() => {})));
}
await page.goto('https://game.xiaolubao.com/', { waitUntil: 'networkidle2' });
const mounted = await page.evaluate(async () => {
  try {
    // the app's own preact instance: resolve it the way the page's import map does, otherwise render() and the
    // component disagree about which preact they belong to (Cannot read properties of null (reading '__H')).
    const map = JSON.parse(document.querySelector('script[type=importmap]')?.textContent ?? '{}');
    const preactUrl = map.imports?.preact ?? '/vendor/preact.module.js';
    const { render } = await import(preactUrl);
    const { html } = await import('/js/ui/components.js');
    const { EmoteWheel } = await import('/js/ui/emotes.js');
    const host = document.createElement('div');
    host.id = 'live-emo';
    host.style.cssText = 'position:fixed;left:80px;bottom:80px;z-index:9999;font-size:16px';
    document.body.append(host);
    render(html`<${EmoteWheel} open=${true} onToggle=${() => {}} onSend=${() => {}} />`, host);
    return `ok (preact: ${preactUrl})`;
  } catch (e) { return `mount failed: ${e.message}`; }
});
await new Promise((r) => setTimeout(r, 1500));
const state = await page.evaluate(() => {
  const d = globalThis.__SP__?.data;
  const btn = document.querySelector('#live-emo .ewheel__btn');
  const panel = document.querySelector('#live-emo .ewheel__panel');
  const item = document.querySelector('#live-emo .ewheel__item');
  return {
    mount: null,
    localStatus: d?.status?.('local') ?? null,
    manifestEntry: d?.get?.('local')?.groups?.['ui/battle']?.emoji_btn?.path ?? null,
    btnClass: btn?.className ?? null,
    btnVar: (btn?.style?.getPropertyValue('--ewheel-btn') || '').trim() || null,
    btnBgImage: btn ? getComputedStyle(btn).backgroundImage : null,
    btnBorder: btn ? getComputedStyle(btn).borderTopWidth + ' ' + getComputedStyle(btn).borderTopColor : null,
    panelClass: panel?.className ?? null,
    panelPlate: panel ? getComputedStyle(panel, '::before').content : null,
    itemBg: item ? getComputedStyle(item).backgroundColor : null,
    cssHref: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href).find((h) => h.includes('emotes.css')) ?? null,
  };
});
state.mount = mounted;
const clip = await page.evaluate(() => {
  const r = document.querySelector('#live-emo')?.getBoundingClientRect();
  return r ? { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 20), width: Math.min(600, r.width + 40), height: Math.min(500, r.height + 40) } : null;
});
console.log(JSON.stringify({ block, state, problems }, null, 1));
if (clip) await page.screenshot({ path: `.p2tmp/live-wheel${block ? '-blocked' : ''}.png`, clip });
await browser.close();
