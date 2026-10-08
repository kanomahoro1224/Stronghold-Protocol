// 临时诊断：打开后台页面，把它抛的错原样打出来。
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCommunity } from '../server/index.js';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const dir = mkdtempSync(path.join(tmpdir(), 'sp-diag-admin-'));
process.env.SP_COMMUNITY_ADMIN_PASSWORD = 'diag-admin-pw';
const srv = await startCommunity({ port: 0, host: '127.0.0.1', dbFile: path.join(dir, 'community.db'), quiet: true });
const base = `http://127.0.0.1:${srv.port}`;
const res = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loginName: 'admin', password: 'diag-admin-pw' }),
});
const setCookie = res.headers.get('set-cookie') || '';
const [name, value] = [setCookie.split('=')[0], setCookie.split('=')[1]?.split(';')[0]];
console.log('  login ok:', res.status, 'cookie:', name);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
if (name) await page.setCookie({ name, value, url: base });
await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));
const state = await page.evaluate(() => ({
  appChildren: document.getElementById('app')?.childElementCount ?? -1,
  bootError: document.getElementById('boot-error')?.textContent || null,
  text: document.body.innerText.replace(/\n+/g, ' | ').slice(0, 300),
}));
console.log('  errors:', JSON.stringify(errs, null, 1));
console.log('  state:', JSON.stringify(state, null, 1));
await browser.close();
await srv.close();
rmSync(dir, { recursive: true, force: true });
