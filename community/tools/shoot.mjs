// community/tools/shoot.mjs — dev-only visual verification: screenshot the pages via puppeteer-core + local Chrome.
// Usage: node tools/shoot.mjs [baseUrl] [outDir]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3100';
const OUT = process.argv[3] || path.join(process.cwd(), '.shots');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((p) => fs.existsSync(p));

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

async function shot(name, url, { wait = 2500, full = false, action } = {}) {
  await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, wait));
  if (action) { await action(page); await new Promise((r) => setTimeout(r, 1200)); }
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  console.log('shot:', name);
}

// 1. front-end list
await shot('01-list', '/', { wait: 4000 });
// 2. front-end with JSON expanded
await shot('02-list-json', '/', { wait: 4000, action: async (p) => { await p.evaluate(() => document.querySelector('.card__expand-head')?.click()); } });
// 3. admin login (fresh context: no session cookie)
const page2 = await browser.newPage();
await page2.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
await page2.setCookie({ name: 'sp_community_sid', value: '', domain: 'localhost', path: '/' }).catch(() => {});
await page2.goto(BASE + '/admin', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
await page2.screenshot({ path: path.join(OUT, '03-login.png') });
console.log('shot: 03-login');
// 4. login then serve console
await page2.waitForSelector('#login-name', { timeout: 15000 });
await page2.type('#login-name', process.env.SP_ADMIN_USER || 'admin@luke.qaq');
await page2.type('#login-pass', process.env.SP_ADMIN_PASS || 'kano1224KANO');
await page2.click('button[type=submit]');
await new Promise((r) => setTimeout(r, 5000));
await page2.screenshot({ path: path.join(OUT, '04-console-servers.png'), fullPage: true });
console.log('shot: 04-console-servers');
// 5. accounts page
await page2.goto(BASE + '/admin/accounts', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 2500));
await page2.screenshot({ path: path.join(OUT, '05-console-accounts.png'), fullPage: true });
console.log('shot: 05-console-accounts');
// 6. create-account modal
await page2.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建账号'))?.click());
await new Promise((r) => setTimeout(r, 1200));
await page2.screenshot({ path: path.join(OUT, '06-account-modal.png') });
console.log('shot: 06-account-modal');

await browser.close();
if (errors.length) { console.log('\n--- JS ERRORS ---'); errors.forEach((e) => console.log(e)); process.exitCode = 2; }
else console.log('\nno JS errors');
