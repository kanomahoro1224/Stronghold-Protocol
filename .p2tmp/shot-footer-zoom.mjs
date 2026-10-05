// Zoomed 3x shots of the footer link: exact underline placement (normal) and hover highlight.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH;
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 3 });
await page.goto('http://127.0.0.1:3123/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.title-foot__link', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const linkBox = await page.evaluate(() => {
  const a = document.querySelector('.title-foot__link');
  const r = a.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, text: a.textContent };
});
// one line either side of the link, generous horizontal padding, 3x scale
const clip = {
  x: 40,
  y: Math.max(0, linkBox.y - 26),
  width: 980,
  height: linkBox.h + 52,
};
await page.screenshot({ path: '.p2tmp/footer-zoom-normal.png', clip });
await page.hover('.title-foot__link');
await new Promise((r) => setTimeout(r, 450));
await page.screenshot({ path: '.p2tmp/footer-zoom-hover.png', clip });
console.log(JSON.stringify({ link: linkBox, clip }, null, 1));
await browser.close();
