// community/tools/verify-admin-probe-address.mjs — dev-only: the 「实际探测地址」 field in the admin console.
//
//   node tools/verify-admin-probe-address.mjs
//
// Starts a throwaway service (ephemeral port, temp database, seeded admin), adds a server with a probe
// address through the API, then drives the real admin console in a browser: the edit modal must load the
// stored value, saving a new one must reach the database, and the table must show which address is probed.
// Requires puppeteer-core + a local Chrome/Edge.
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

const dir = mkdtempSync(path.join(tmpdir(), 'sp-admin-probe-'));
const ADMIN_PW = 'admin-probe-ui-pw';
process.env.SP_COMMUNITY_ADMIN_PASSWORD = ADMIN_PW;
const NAME = 'UI 探测地址测试';
const PROBE_1 = 'https://192.0.2.11:34046/';
const PROBE_2 = 'https://192.0.2.12:34046/';

const srv = await startCommunity({ port: 0, host: '127.0.0.1', dbFile: path.join(dir, 'community.db'), quiet: true });
const base = `http://127.0.0.1:${srv.port}`;
let cookieHeader = '';
async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (set.length) cookieHeader = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

let browser = null;
try {
  const login = await call('POST', '/api/auth/login', { loginName: 'admin', password: ADMIN_PW });
  ok('管理员登录', login.status === 200, JSON.stringify(login.json));
  const created = await call('POST', '/api/servers', { name: NAME, address: 'https://192.0.2.10:34046/', region: 'asia', note: '', probeAddress: PROBE_1 });
  ok('预置一条带探测地址的服务器', created.status === 201, JSON.stringify(created.json));
  const id = created.json?.server?.id;

  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100 });
  const [ckName, ckValue] = cookieHeader.split('=');
  await page.setCookie({ name: ckName, value: ckValue.split(';')[0], url: base });
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle2', timeout: 30000 });

  // 表格里应当标出「探测 → …」
  await page.waitForFunction((name) => document.body.textContent.includes(name), { timeout: 15000 }, NAME);
  const table = await page.evaluate(() => document.querySelector('.table, table')?.textContent || document.body.textContent);
  ok('表格里标出了实际探测地址', table.includes('探测 → ') && table.includes('192.0.2.11'), table.slice(table.indexOf(NAME), table.indexOf(NAME) + 160));

  // 点该行「编辑」
  const clicked = await page.evaluate((name) => {
    let best = null, bestDepth = Infinity;
    for (const b of document.querySelectorAll('button')) {
      if (b.textContent.trim() !== '编辑') continue;
      let el = b, d = 0;
      while (el && !el.textContent.includes(name)) { el = el.parentElement; d += 1; }
      if (el && d < bestDepth) { best = b; bestDepth = d; }
    }
    if (!best) return false;
    best.click();
    return true;
  }, NAME);
  ok('找到了该行的「编辑」按钮', clicked === true);
  await page.waitForSelector('#server-form', { timeout: 10000 });

  const form = await page.evaluate(() => {
    const label = [...document.querySelectorAll('.field__label')].find((l) => l.textContent.includes('实际探测地址'));
    const input = label?.parentElement?.querySelector('input') ?? null;
    return { label: label?.textContent ?? null, value: input?.value ?? null, placeholder: input?.placeholder ?? null, hint: input?.parentElement?.querySelector('.field__hint')?.textContent ?? null };
  });
  ok('编辑弹窗里有「实际探测地址」字段', !!form.label, String(form.label));
  ok('字段带说明（留空＝用服务器地址）', /留空/.test(form.hint || ''), String(form.hint));
  ok('编辑时回填已存的探测地址', form.value === PROBE_1, String(form.value));

  // 改成新地址并保存
  await page.evaluate((next) => {
    const label = [...document.querySelectorAll('.field__label')].find((l) => l.textContent.includes('实际探测地址'));
    const input = label.parentElement.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, PROBE_2);
  await page.click('button[form="server-form"]');
  await page.waitForFunction(() => !document.querySelector('#server-form'), { timeout: 15000 });

  const after = await call('GET', `/api/servers/${id}`);
  ok('保存后写入数据库', after.json?.server?.probeAddress === PROBE_2, String(after.json?.server?.probeAddress));
  await page.waitForFunction((p) => document.body.textContent.includes(p), { timeout: 15000 }, '192.0.2.12');
  ok('表格刷新为新探测地址', true);
} finally {
  if (browser) await browser.close();
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failed}/${checks} 通过`);
if (failed) process.exitCode = 1;
