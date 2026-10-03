// test/ui/server-picker.browser.test.js — 开始界面那排「本机当服务器 / 连接服务器」到底出不出现。
//
// 为什么值得一个真实浏览器的测试：这一排控件只在「页面来自本机或内网」时才有意义。玩家从公网域名
// （如 https://game.kafuno.cn/）直连进来时，他面前没有第二台服务器——地址框只会让人以为要跑去别处玩，
// 「本机当服务器」更会把访客指到他自己的 127.0.0.1。判定本身在 public/js/gameserver.js 的
// showServerPicker()（test/gameserver.test.js 有单测），这里验证的是**它真的接到了 DOM 上**。
//
// 做法：起本地服务器，用 Chrome 的 --host-resolver-rules 把域名指到 127.0.0.1。
// 这样页面来源（决定 UI 的那个值）是真的公网域名 / 内网 IP，不是伪造的 location。
//
// 需要 Chrome 与 puppeteer-core；缺任一个就跳过（不装 Chrome 的机器上套件照样是绿的）。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 系统 Chrome / Edge 的常见位置（CHROME_PATH 优先，与 test/render/* 一致）。 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));

const skip = CHROME ? false : '需要 Chrome（可用 CHROME_PATH 指定）';

describe('开始界面：服务器选择只在自建/内网页面出现', { skip }, () => {
  let srv;
  let browser;
  let puppeteer;
  let basePort;

  before(async () => {
    try {
      puppeteer = (await import('puppeteer-core')).default;
    } catch {
      return;   // 没有 puppeteer-core：下面的测试各自跳过
    }
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    basePort = srv.port ?? srv.address?.().port;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        '--no-first-run', '--no-sandbox',
        // 域名都指到本机；浏览器发的 Host 头仍是原始域名，页面来源因此是真的
        '--host-resolver-rules=MAP game.kafuno.cn 127.0.0.1,MAP game.example.com 127.0.0.1,MAP nas 127.0.0.1,MAP 192.168.1.23 127.0.0.1',
      ],
    });
  });

  after(async () => {
    await browser?.close();
    await srv?.close?.();
  });

  /** 打开页面、等开始界面渲染出来，报告那排控件在不在。 */
  async function probe(url) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('.title-net', { timeout: 20000 });
      return await page.evaluate(() => ({
        hasPicker: !!document.querySelector('.title-net__row--pick'),
        host: document.querySelector('.title-net__host')?.textContent?.trim() || '',
        inputs: [...document.querySelectorAll('.title-net input')].map((i) => i.placeholder),
        buttons: [...document.querySelectorAll('.title-net button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
      }));
    } finally {
      await page.close();
    }
  }

  test('公网域名上不出现「本机当服务器 / 连接服务器」', async (t) => {
    if (!browser) return t.skip('puppeteer-core 未安装');
    for (const host of ['game.kafuno.cn', 'game.example.com']) {
      const r = await probe(`http://${host}:${basePort}/`);
      assert.equal(r.hasPicker, false, `${host} 上不该出现服务器选择（实测有：${JSON.stringify(r.buttons)}）`);
      assert.equal(r.inputs.length, 0, `${host} 上不该有服务器地址输入框`);
      assert.equal(r.buttons.length, 0, `${host} 上不该有「本机当服务器 / 连接」按钮`);
      // 「我在哪台服务器上」这行仍然保留：它是状态，不是入口
      assert.match(r.host, new RegExp(host.replace(/\./g, '\\.')), '服务器名称仍然显示');
    }
  });

  test('本机与内网页面仍然可以换服务器', async (t) => {
    if (!browser) return t.skip('puppeteer-core 未安装');
    for (const host of ['127.0.0.1', 'nas', '192.168.1.23']) {
      const r = await probe(`http://${host}:${basePort}/`);
      assert.equal(r.hasPicker, true, `${host} 上应保留服务器选择（Windows 便携版 / 局域网自建服）`);
      assert.deepEqual(r.buttons, ['本机当服务器', '连接'], `${host} 上的按钮`);
      assert.equal(r.inputs.length, 1, `${host} 上应有地址输入框`);
    }
  });

  test('公网页面用 ?server= 连着别处时，要能取消回来', async (t) => {
    if (!browser) return t.skip('puppeteer-core 未安装');
    const r = await probe(`http://game.kafuno.cn:${basePort}/?server=other.example.com`);
    assert.equal(r.hasPicker, true, '指定了别的服务器就必须留着「取消」的出口');
    assert.equal(r.host, 'https://other.example.com', '顶部显示的是正在连的那台');
  });
});