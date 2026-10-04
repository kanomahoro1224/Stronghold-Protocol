// Opt-in browser regression: SP_E2E=1 node --test test/ui/online-presence.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

test('title and lobby show live online count without overlapping their controls', {
  skip: !ENABLED && 'set SP_E2E=1 and CHROME_PATH to run', timeout: 60000,
}, async (t) => {
  const { startServer } = await import('../../server/index.js');
  const puppeteer = (await import('puppeteer-core')).default;
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  let browser;
  t.after(async () => { await browser?.close(); await srv.close(); });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const base = `http://127.0.0.1:${srv.port}`;
  const out = join(ROOT, 'test', 'e2e', 'out');
  mkdirSync(out, { recursive: true });
  const errors = [];
  async function open() {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1920, height: 1080 });
    // Keep visual checks deterministic and avoid fetching optional external fonts / local art.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('https://fonts.')) return request.respond({ status: 200, contentType: 'text/css', body: '' });
      if (url === base + '/data/assets.json') return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
      if (url === base + '/fonts/fonts.css') return request.respond({ status: 200, contentType: 'text/css', body: '' });
      return request.continue();
    });
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.title-conn .online-pill');
    return page;
  }
  const waitCount = (page, count) => page.waitForFunction((text) => document.querySelector('.online-pill__value')?.textContent === text, { timeout: 7000 }, String(count));
  // Nobody has said hello yet: the sockets on the title screen are deliberately not counted, but they are
  // still told the number (0 players in the game), so the pill never shows "--" once connected.
  const first = await open();
  await waitCount(first, 0);
  const second = await open();
  await waitCount(second, 0);
  await waitCount(first, 0);
  await second.close();
  await first.type('.title-login input', 'OnlineTest');
  await first.click('.title-login .btn--xl');
  await first.waitForSelector('.lobby-screen .topbar__left .online-pill');
  await waitCount(first, 1);

  // Ordinary disconnect, then reconnect: the last known count stays put instead of flashing "--" (the
  // title screen rotates its quiet socket every 30 s, and a flickering number is worse than a stale one).
  await first.evaluate(async () => (await import('/js/net.js')).net.close());
  await waitCount(first, 1);
  await first.evaluate(async () => (await import('/js/net.js')).net.connect());
  await waitCount(first, 1);
  await first.waitForFunction(async () => (await import('/js/net.js')).net.status === 'online');

  async function checkLayout(screen) {
    const selector = screen === 'title' ? '.title-conn' : '.lobby-screen .topbar__left';
    const issues = await first.$eval(selector, (container) => {
      const children = [...container.querySelectorAll('.online-pill, .ping, button, .title-conn__status')];
      const rects = children.map((el) => ({ name: el.className, ...el.getBoundingClientRect().toJSON() })).filter((r) => r.width && r.height);
      const box = container.getBoundingClientRect();
      const errors = [];
      for (const a of rects) {
        if (a.left < box.left - 1 || a.right > box.right + 1 || a.top < box.top - 1 || a.bottom > box.bottom + 1) errors.push(`overflow: ${a.name}`);
        for (const b of rects) {
          if (a === b) continue;
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) errors.push(`overlap: ${a.name} / ${b.name}`);
        }
      }
      return errors;
    });
    assert.deepEqual(issues, [], `${screen} layout`);
  }
  for (const [width, height] of [[1920, 1080], [1280, 720], [844, 390]]) {
    await first.setViewport({ width, height });
    await checkLayout('lobby');
    await (await first.$('.lobby-screen .topbar')).screenshot({ path: join(out, `online-lobby-${width}.png`) });
    await first.click('.topbar__left button');
    await first.waitForSelector('.title-conn .online-pill');
    await first.$eval('.title-login', (el) => Promise.all(el.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {}))));
    await checkLayout('title');
    await (await first.$('.title-login')).screenshot({ path: join(out, `online-title-${width}.png`) });
    await first.evaluate(async () => (await import('/js/net.js')).net._onMessage(JSON.stringify({ t: 'presence', onlineCount: 2000 })));
    await waitCount(first, 2000);
    await checkLayout('title');
    await first.click('.title-login .btn--xl');
    await first.waitForSelector('.lobby-screen');
    await checkLayout('lobby');
    await first.evaluate(async () => (await import('/js/net.js')).net._onMessage(JSON.stringify({ t: 'presence', onlineCount: 1 })));
    await waitCount(first, 1);
  }
  assert.deepEqual(errors, []);
});
