// Live check: does a real browser see the online pill on the title and in the lobby?
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.SP_BASE || 'https://game.xiaolubao.com';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
await page.setViewport({ width: 1600, height: 900 });
await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
await page.waitForSelector('.online-pill', { timeout: 15000 });
const title = await page.evaluate(() => ({
  pill: document.querySelector('.online-pill')?.textContent?.trim(),
  title: document.querySelector('.online-pill')?.getAttribute('title'),
  status: document.querySelector('.title-conn__status')?.textContent?.trim(),
}));
console.log('title:', JSON.stringify(title));

await page.type('.title-login input', 'PillCheck');
await page.click('.title-login .btn--xl');
await page.waitForSelector('.lobby-screen .topbar__left .online-pill', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));
const lobby = await page.evaluate(() => ({
  pill: document.querySelector('.lobby-screen .online-pill')?.textContent?.trim(),
  title: document.querySelector('.lobby-screen .online-pill')?.getAttribute('title'),
  ping: document.querySelector('.lobby-screen .ping')?.textContent?.trim(),
}));
console.log('lobby:', JSON.stringify(lobby));
console.log('errors:', JSON.stringify(errors.slice(0, 6)));
await browser.close();
process.exit(errors.length ? 1 : 0);
