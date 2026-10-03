// test/windows-bundle.test.js — Windows 开箱即用那套工具的纯函数（脚本本身是 CLI，这里只测不打服务器的部分）：
//   * scripts/launch.mjs 的 browserUrl：`--game-server` 时页面仍由本机发、客户端连远端（`?server=`）
//   * scripts/make-windows-bundle.mjs 的 stripWebfonts：便携包默认去掉 Google Fonts 外链
// 目的：这两处一旦写错，玩家看到的就是「连了别人的服务器却打开了本机页面 / 离线包卡在打不开的字体请求」。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

describe('launch.mjs: 打开的页面地址', () => {
  test('没有 --game-server → 本机页面本身', async () => {
    const { browserUrl, localPageUrl } = await mod('scripts/launch.mjs');
    assert.equal(localPageUrl(3000), 'http://localhost:3000');
    assert.equal(browserUrl('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(browserUrl('http://localhost:3000', {}), 'http://localhost:3000');
    assert.equal(browserUrl('http://localhost:3000', { gameServer: '' }), 'http://localhost:3000');
  });

  test('--game-server → 本机页面 + ?server=远端', async () => {
    const { browserUrl } = await mod('scripts/launch.mjs');
    assert.equal(browserUrl('http://localhost:3000', { gameServer: 'game.example.com' }),
      'http://localhost:3000/?server=game.example.com');
    assert.equal(browserUrl('http://localhost:3001', { gameServer: '192.168.1.23:3000' }),
      'http://localhost:3001/?server=192.168.1.23%3A3000');
    assert.equal(browserUrl('http://localhost:3000', { gameServer: 'game.example.com', pushOnly: true }),
      'http://localhost:3000/?server=game.example.com&pushOnly=1');
    assert.ok(!/pushOnly/.test(browserUrl('http://localhost:3000', { gameServer: 'game.example.com' })),
      '没开省流量模式就不带这个标志');
  });
});

describe('启动器「发给朋友」的地址清单（tools/doctor.mjs）', () => {
  /** @param {string} name @param {string} address */
  const iface = (name, address) => [name, [{ family: 'IPv4', address, internal: false }]];

  test('只列真正能连的地址：真正局域网在前，虚拟网卡/代理 TUN 不要冒充公网 IP', async () => {
    const { classifyAddresses, KIND_LABEL } = await mod('tools/doctor.mjs');
    const list = classifyAddresses(Object.fromEntries([
      iface('Mihomo', '198.18.0.1'),                    // Clash/Mihomo TUN 的 fake-ip 池（RFC 2544）
      iface('vEthernet (Default Switch)', '172.25.112.1'),
      iface('以太网 5', '192.168.1.7'),
      iface('Radmin VPN', '26.200.79.213'),
      iface('Tailscale', '100.64.0.9'),
    ]));
    const kind = (ip) => list.find((a) => a.address === ip)?.kind;
    assert.equal(kind('198.18.0.1'), 'virtual', '代理 TUN 不能当成公网 IP 发给朋友');
    assert.equal(kind('172.25.112.1'), 'virtual', 'Hyper-V 网卡');
    assert.equal(kind('26.200.79.213'), 'vpn', 'Radmin VPN 是点对点地址');
    assert.equal(kind('100.64.0.9'), 'vpn', 'CGNAT（Tailscale）');
    assert.equal(kind('192.168.1.7'), 'lan');
    assert.equal(list[0].address, '192.168.1.7', '局域网地址排最前');

    // launch.mjs 就是按这三种 kind 打印「发给朋友」的
    const shareable = list.filter((a) => ['lan', 'vpn', 'public'].includes(a.kind)).map((a) => a.address);
    assert.deepEqual(shareable, ['192.168.1.7', '26.200.79.213', '100.64.0.9']);
    assert.ok(!shareable.includes('198.18.0.1'));
    assert.ok(KIND_LABEL.virtual, '虚拟网卡也有标签可读');
  });

  test('198.18.0.0/15 整体都算虚拟（不只是 .0.1）', async () => {
    const { classifyAddresses } = await mod('tools/doctor.mjs');
    const list = classifyAddresses(Object.fromEntries([iface('Clash', '198.19.255.254'), iface('x', '198.20.0.1')]));
    assert.equal(list.find((a) => a.address === '198.19.255.254').kind, 'virtual');
    assert.equal(list.find((a) => a.address === '198.20.0.1').kind, 'public', '198.20 不在 /15 里');
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