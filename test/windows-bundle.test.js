// test/windows-bundle.test.js — Windows 开箱即用那套工具的纯函数（脚本本身是 CLI，这里只测不打服务器的部分）：
//   * scripts/launcher.mjs 的地址解析：决定用 http 还是 https 去连（本机/内网没有证书）
//   * scripts/make-windows-bundle.mjs 的 stripWebfonts：便携包默认去掉 Google Fonts 外链
// 目的：这两处一旦写错，玩家看到的就是「连不上自己的局域网服务器 / 离线包卡在打不开的字体请求」。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseServer, originOf, isLocalOrPrivate } from '../scripts/launcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

describe('launcher.mjs: 服务器地址解析', () => {
  test('没写协议时：本机 / 内网 / 点对点用 http，公网域名用 https', () => {
    const scheme = (s) => parseServer(s)?.scheme;
    assert.equal(scheme('192.168.1.7:3000'), 'http');
    assert.equal(scheme('localhost:3000'), 'http');
    assert.equal(scheme('127.0.0.1'), 'http');
    assert.equal(scheme('10.0.0.5:3000'), 'http');
    assert.equal(scheme('172.20.1.1'), 'http');
    assert.equal(scheme('mac-mini.local'), 'http');
    assert.equal(scheme('nas:3000'), 'http', '单段主机名 = 局域网机器名');
    assert.equal(scheme('game.example.com'), 'https');
    assert.equal(scheme('8.8.8.8'), 'https');
  });

  test('100.64/10（Tailscale）与 26.x（Radmin）不能当公网 IP，按 http 连', () => {
    // 这两段看着像公网 IP，实际是私有点对点网段；按 https 去连只会白等一次握手再失败。
    assert.equal(parseServer('100.64.0.9:3000')?.scheme, 'http', 'CGNAT / Tailscale');
    assert.equal(parseServer('100.127.255.254')?.scheme, 'http', '100.64.0.0/10 的上界');
    assert.equal(parseServer('26.200.79.213:3000')?.scheme, 'http', 'Radmin VPN');
    assert.equal(parseServer('100.128.0.1')?.scheme, 'https', '100.128 已经不在 /10 里');
    assert.equal(parseServer('101.0.0.1')?.scheme, 'https', '别把 10. 的前缀匹配成 100.');
  });

  test('显式写的协议优先；host / 端口 / 路径都规范化', () => {
    assert.deepEqual(parseServer('http://192.168.1.7:3000/play?x=1'),
      { host: '192.168.1.7:3000', scheme: 'http', secure: false, encrypted: false });
    assert.equal(parseServer('https://game.example.com')?.secure, true);
    assert.equal(parseServer('https://game.example.com')?.encrypted, true, '显式 https：连接时先试它');
    assert.equal(parseServer('game.example.com:8443')?.host, 'game.example.com:8443');
    assert.equal(originOf(parseServer('192.168.1.7:3000/')), 'http://192.168.1.7:3000/');
  });

  test('无效地址返回 null', () => {
    for (const bad of ['', '   ', 'ftp://x/', 'http://', '://x']) assert.equal(parseServer(bad), null, `「${bad}」应当是无效地址`);
  });

  test('isLocalOrPrivate 的边界', () => {
    for (const h of ['localhost', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.1.1', '100.64.0.1', 'nas']) {
      assert.ok(isLocalOrPrivate(h), h);
    }
    for (const h of ['8.8.8.8', 'game.example.com', '100.128.0.1']) assert.ok(!isLocalOrPrivate(h), h);
  });
});

describe('make-windows-bundle.mjs: 离线包不引用外网', () => {
  test('stripWebfonts 去掉 Google Fonts 的两条 link，保留其它', async () => {
    const { stripWebfonts } = await mod('scripts/make-windows-bundle.mjs');
    const html = [
      '<head>',
      '  <link rel="preconnect" href="https://fonts.googleapis.com" />',
      '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      '  <link rel="stylesheet" media="print" onload="this.media=\'all\'"',
      '    href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC&display=swap" />',
      '  <link rel="stylesheet" href="/fonts/fonts.css" />',
      '  <link rel="stylesheet" href="/css/theme.css" />',
      '</head>',
    ].join('\n');
    const { html: out, removed } = stripWebfonts(html);
    assert.equal(removed, 3, '两条 preconnect + 一条 css2');
    assert.ok(!/googleapis|gstatic/.test(out), '不剩任何外网字体引用');
    assert.match(out, /\/fonts\/fonts\.css/, '包内自托管字体保留');
    assert.match(out, /\/css\/theme\.css/);
    assert.match(out, /<head>/);
  });

  test('stripWebfonts 对没有外链的页面是空操作', async () => {
    const { stripWebfonts } = await mod('scripts/make-windows-bundle.mjs');
    const html = '<head>\n  <link rel="stylesheet" href="/fonts/fonts.css" />\n</head>\n';
    const { html: out, removed } = stripWebfonts(html);
    assert.equal(removed, 0);
    assert.equal(out, html, '一字不改');
  });

  test('真实 index.html：先去外链，再确认包内字体仍在', async () => {
    const { stripWebfonts } = await mod('scripts/make-windows-bundle.mjs');
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const { html: out, removed } = stripWebfonts(src);
    assert.ok(removed >= 2, `index.html 里应有外链字体（实际 ${removed}）`);
    assert.ok(!/fonts\.googleapis\.com/.test(out));
    assert.match(out, /\/fonts\/fonts\.css/);
    // 去掉的只是字体外链：<script> 与其它 <link> 的数量变化应等于 removed
    const count = (s, re) => (s.match(re) || []).length;
    assert.equal(count(src, /<link/g) - count(out, /<link/g), removed);
    assert.equal(count(src, /<script/g), count(out, /<script/g));
  });
});
