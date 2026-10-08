// 一次性诊断：把线上公开列表里的「服务端不可达 + 本机可达」场景真实渲染出来，逐字打印用户看到的东西。
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const URL_ = process.argv[2] || 'https://game.xiaolubao.com/';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

async function run(fakeServerDown) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (fakeServerDown && /\/api\/servers\?probe=1/.test(req.url())) {
      const res = await fetch(req.url(), { headers: { accept: 'application/json' } });
      const data = await res.json();
      if (data.servers && data.servers[0]) {
        data.servers[0].health = { ok: false, reachable: false, status: null, latencyMs: null, error: '探测超时' };
      }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    }
    return req.continue();
  });
  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 6000));
  const out = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card')].map((c) => ({
      title: (c.querySelector('.card__title, h3, .card__name')?.textContent || '').trim(),
      cls: c.className,
      dot: (c.querySelector('[class*=dot]')?.className || ''),
      status: (c.querySelector('.cell-status, .status, [class*=status]')?.textContent || '').trim(),
      enterDisabled: !!c.querySelector('button[disabled]'),
      text: c.innerText.replace(/\n+/g, ' | ').slice(0, 220),
    }));
    return { cards, hero: document.body.innerText.split('\n').filter((l) => /在线节点|运行正常|本机可达|离线/.test(l)) };
  });
  console.log(`--- ${fakeServerDown ? '伪造：节点1 服务端不可达' : '线上真实状态'} ---`);
  for (const c of out.cards) {
    console.log(`  [card] cls=${c.cls} dot=${c.dot} disabled=${c.enterDisabled}`);
    console.log(`         status="${c.status}"`);
    console.log(`         text="${c.text}"`);
  }
  console.log(`  [hero] ${JSON.stringify(out.hero)}`);
  await page.close();
}

await run(false);
await run(true);
await browser.close();
