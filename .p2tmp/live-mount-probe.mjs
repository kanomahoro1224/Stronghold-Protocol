// .p2tmp/live-mount-probe.mjs — mount the LIVE site's EmoteWheel with the app's own preact instance and watch every
// /assets/ request it makes. Read-only: no match, no writes. Answers "does the live code ask for a prefix-less R2 url?"
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const assets = [];
const problems = [];
page.on('request', (r) => { if (/\/assets\//.test(r.url())) assets.push(r.url()); });
page.on('requestfailed', (r) => problems.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
await page.goto('https://game.xiaolubao.com/', { waitUntil: 'networkidle2' });

const res = await page.evaluate(async () => {
  const txt = async (u) => (await fetch(u)).text();
  const findImport = (src, names) => {
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      if (names.some((n) => m[1].includes(n))) return m[1];
    }
    return null;
  };
  try {
    const compSrc = await txt('/js/ui/components.js');
    const preactSpec = findImport(compSrc, ['preact']) || '/vendor/preact.module.js';
    const hooksSpec = findImport(compSrc, ['hooks']);
    const { render } = await import(preactSpec);
    const { html } = await import('/js/ui/components.js');
    const { EmoteWheel } = await import('/js/ui/emotes.js');
    const host = document.createElement('div');
    host.id = 'live-mount';
    host.style.cssText = 'position:fixed;left:60px;bottom:60px;z-index:99999';
    document.body.append(host);
    render(html`<${EmoteWheel} open=${true} onToggle=${() => {}} onSend=${() => {}} />`, host);
    return { ok: true, preactSpec, hooksSpec };
  } catch (e) { return { ok: false, error: e.message }; }
});

await new Promise((r) => setTimeout(r, 2000));
const state = await page.evaluate(() => {
  const btn = document.querySelector('#live-mount .ewheel__btn');
  const panel = document.querySelector('#live-mount .ewheel__panel');
  const items = [...document.querySelectorAll('#live-mount .ewheel__item')];
  const cssUrls = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } })
    .filter((t) => /emoji_btn|emoji_bkg|emoji_cell/.test(t)).slice(0, 3);
  return {
    btnClass: btn?.className ?? null,
    btnBg: btn ? getComputedStyle(btn).backgroundImage : null,
    panelClass: panel?.className ?? null,
    panelPlate: panel ? getComputedStyle(panel, '::before').content : null,
    itemCount: items.length,
    itemBg: items[0] ? getComputedStyle(items[0]).backgroundColor : null,
    imgsLoaded: items.filter((i) => i.querySelector('img')?.naturalWidth > 0).length,
    cssUrls,
  };
});

console.log(JSON.stringify({ mount: res, state, assets, problems }, null, 1));
const clip = await page.evaluate(() => {
  const r = document.querySelector('#live-mount')?.getBoundingClientRect();
  return r ? { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 20), width: 460, height: 340 } : null;
});
if (clip) await page.screenshot({ path: '.p2tmp/live-mount.png', clip });
await browser.close();
