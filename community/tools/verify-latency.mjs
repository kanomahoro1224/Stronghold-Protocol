// community/tools/verify-latency.mjs — dev-only: prove the browser measures player→node latency itself.
//
// It loads the list page, waits for the client-side timing to settle, then reports:
//   * the figures the PAGE computed (window.__spLatency, written by latency.js)
//   * the raw timing the same page gets from a direct fetch, as a control
//   * whether the CSP blocked anything (any connect-src violation would surface as a console error)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
// Give the client-side measurement (3 samples × gap, per node) time to finish.
await new Promise((r) => setTimeout(r, 12000));

const report = await page.evaluate(async () => {
  // What the UI shows, read straight out of the DOM.
  const pills = [...document.querySelectorAll('.card__status-sub')].map((el) => el.textContent.trim());

  // Control: time a fetch here, in the page, to the first node's healthz.
  const link = document.querySelector('a.btn--primary')?.getAttribute('href');
  let control = null;
  if (link) {
    const url = new URL('healthz', link);
    url.searchParams.set('_ctl', Math.random().toString(36).slice(2));
    const t0 = performance.now();
    try {
      await fetch(url.toString(), { mode: 'no-cors', cache: 'no-store' });
      control = Math.round(performance.now() - t0);
    } catch (e) { control = 'ERR ' + e.message; }
  }
  return { pills, control, target: link };
});

await browser.close();

console.log('=== 卡片状态栏显示 ===');
report.pills.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
console.log('\n=== 页面内直接 fetch 对照 ===');
console.log('  目标:', report.target);
console.log('  实测:', report.control, 'ms');
console.log('\n=== 控制台错误 ===');
console.log(errors.length ? errors.join('\n') : '  无');
