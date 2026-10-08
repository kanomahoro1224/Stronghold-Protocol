// community/tools/verify-no-importmap.mjs — 浏览器实测：旧 iOS（不支持 import map）也必须能用，且失败时不许空白。
//
//   node tools/verify-no-importmap.mjs
//
// 两幕：
//   A. 把页面里的 <script type="importmap"> 全部删掉再加载（正是 iOS 16.4 以下的处境）⇒ 页面必须正常渲染。
//   B. 故意让 /vendor/*.js 加载失败（模拟模块图整体挂掉）⇒ 必须在页面上出现可读的中文提示，而不是深色空页。
// 需要 puppeteer-core + 本地 Chrome/Edge。
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startCommunity } from '../server/index.js';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(1); }

let checks = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const dir = mkdtempSync(path.join(tmpdir(), 'sp-no-importmap-'));
process.env.SP_COMMUNITY_ADMIN_PASSWORD = 'no-importmap-test-pw';
const srv = await startCommunity({ port: 0, host: '127.0.0.1', dbFile: path.join(dir, 'community.db'), quiet: true });
const base = `http://127.0.0.1:${srv.port}`;
let browser = null;

try {
  const servers = (await (await fetch(`${base}/api/servers`)).json()).servers.length;
  ok('服务端有节点可渲染', servers >= 1, String(servers));

  const html = await (await fetch(`${base}/`)).text();
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
  ok('线上 HTML 里已经没有 importmap 标签', !/<script[^>]*\btype\s*=\s*["']importmap["']/i.test(htmlNoComments));
  ok('线上 HTML 引用了 boot-guard.js', html.includes('/js/boot-guard.js'));

  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

  // 幕 A：删掉 importmap 再加载（模拟 iOS 16.4 以下的浏览器）
  const pageA = await browser.newPage();
  await pageA.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
  const errorsA = [];
  pageA.on('pageerror', (e) => errorsA.push(e.message));
  await pageA.setRequestInterception(true);
  pageA.on('request', async (req) => {
    if (req.isNavigationRequest() && req.url().endsWith('/')) {
      const stripped = html.replace(/<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi, '');
      return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: stripped });
    }
    return req.continue();
  });
  await pageA.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  // 社区站要先拿到 /api/bootstrap + /api/servers 才渲染，别用固定等待。
  await pageA.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 20000 });
  const a = await pageA.evaluate(() => ({
    appChildren: document.getElementById('app')?.childElementCount ?? 0,
    cards: document.querySelectorAll('.card').length,
    bootError: !!document.getElementById('boot-error'),
    ready: document.documentElement.dataset.appReady === '1',
  }));
  ok('A 没有 importmap 也能渲染出内容', a.appChildren > 0 && a.cards === servers, JSON.stringify(a));
  ok('A 渲染标记 appReady 已置位', a.ready === true);
  ok('A 没有误报启动失败', a.bootError === false, errorsA.slice(0, 2).join(' | '));
  await pageA.close();

  // 幕 B：让 /vendor/*.js 加载失败 ⇒ 必须有可读提示
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
  await pageB.setRequestInterception(true);
  pageB.on('request', (req) => (req.url().includes('/vendor/') ? req.abort('failed') : req.continue()));
  await pageB.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pageB.waitForSelector('#boot-error', { timeout: 15000 });
  const b = await pageB.evaluate(() => ({
    text: document.getElementById('boot-error')?.textContent || '',
    appChildren: document.getElementById('app')?.childElementCount ?? 0,
  }));
  ok('B 模块挂掉时页面给出可读提示', /没能启动/.test(b.text) && /iOS/.test(b.text), b.text.split('\n')[0]);
  ok('B 提示里带 UA 便于定位', /UA：/.test(b.text));
  ok('B 不再是「一片空页」', b.text.trim().length > 20);
  await pageB.close();
} finally {
  if (browser) await browser.close();
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failed}/${checks} 通过`);
if (failed) process.exitCode = 1;
