// community/tools/check-nav.mjs — verify the tab group sits on the nav bar's true centre,
// and that the favicon links resolve. Dev-only.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3100';
const OUT = path.join(process.cwd(), '.shots-check');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

const m = await page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
  const bar = r('.nav__in'), tabs = r('.tabs'), left = r('.nav__left'), right = r('.nav__right');
  return {
    bar: bar && { x: bar.x, w: bar.width, mid: bar.x + bar.width / 2 },
    tabs: tabs && { x: tabs.x, w: tabs.width, mid: tabs.x + tabs.width / 2 },
    leftRight: left && right ? left.right : null,
    rightLeft: right && left ? right.left : null,
    viewport: window.innerWidth,
  };
});

console.log('=== Tab 居中量测（1440 视口）===');
console.log(`  视口中线        ${m.viewport / 2}`);
console.log(`  导航栏中线      ${m.bar.mid.toFixed(1)}   (x=${m.bar.x}, w=${m.bar.w})`);
console.log(`  Tab 组中线      ${m.tabs.mid.toFixed(1)}   (x=${m.tabs.x.toFixed(1)}, w=${m.tabs.w})`);
console.log(`  偏差            ${Math.abs(m.tabs.mid - m.bar.mid).toFixed(2)} px`);
console.log(`  品牌右边界      ${m.leftRight.toFixed(1)}`);
console.log(`  右侧组左边界    ${m.rightLeft.toFixed(1)}`);
console.log(`  中间净空        ${(m.rightLeft - m.leftRight).toFixed(1)} px`);
const gapOK = m.tabs.x > m.leftRight && (m.tabs.x + m.tabs.w) < m.rightLeft;
console.log(`  是否与两侧重叠  ${gapOK ? '否 ✓' : '是 ✗'}`);

const icons = await page.evaluate(() =>
  [...document.querySelectorAll('link[rel*="icon"]')].map((l) => ({ rel: l.rel, href: l.getAttribute('href'), sizes: l.sizes?.value || '' })));
console.log('=== favicon link 标签 ===');
icons.forEach((i) => console.log(`  ${i.rel.padEnd(20)} ${String(i.sizes).padEnd(10)} ${i.href}`));

// crop the top 80px at 3x so the tab detail is legible
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 3 });
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: path.join(OUT, 'nav-center.png'), clip: { x: 0, y: 0, width: 1440, height: 80 } });
console.log('\n已输出裁剪图: .shots-check/nav-center.png');
console.log(errors.length ? '--- JS ERRORS ---\n' + errors.join('\n') : 'no JS errors');
await browser.close();
