// Screenshot the title-screen footer locally: normal state + hover state on the link. No deploy, no server changes.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH;
const URL = process.env.PROBE_URL || 'http://127.0.0.1:3123/';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', (e) => problems.push(String(e.message).slice(0, 160)));
page.on('requestfailed', (r) => { if (!/assets\//.test(r.url())) problems.push(`failed ${r.url()}`); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.title-foot', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

const info = await page.evaluate(() => {
  const f = document.querySelector('.title-foot');
  const a = document.querySelector('.title-foot__link');
  const cs = a ? getComputedStyle(a) : null;
  const r = f.getBoundingClientRect();
  return {
    footerText: f.innerText,
    href: a ? a.href : null,
    target: a ? a.target : null,
    decoration: cs ? cs.textDecorationLine : null,
    color: cs ? cs.color : null,
    fontSize: cs ? cs.fontSize : null,
    underlineOffset: cs ? cs.textUnderlineOffset : null,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
});

const pad = 48;
const clip = {
  x: 0,
  y: Math.max(0, info.rect.y - pad),
  width: Math.min(1920, 1280),
  height: Math.min(1080 - Math.max(0, info.rect.y - pad), info.rect.h + pad * 2),
};
await page.screenshot({ path: '.p2tmp/footer-normal.png', clip });

const link = await page.$('.title-foot__link');
let hover = null;
if (link) {
  await link.hover();
  await new Promise((r) => setTimeout(r, 450));
  hover = await page.evaluate(() => {
    const a = document.querySelector('.title-foot__link');
    const cs = getComputedStyle(a);
    return { color: cs.color, textShadow: cs.textShadow, decoration: cs.textDecorationLine };
  });
  await page.screenshot({ path: '.p2tmp/footer-hover.png', clip });
}
console.log(JSON.stringify({ ...info, hover, clip, problems }, null, 1));
await browser.close();
