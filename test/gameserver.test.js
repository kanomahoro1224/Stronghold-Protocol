// test/gameserver.test.js — 客户端「我到底在连哪台服务器」的判断（public/js/gameserver.js）与它的三个使用者：
//   * public/js/net.js         WebSocket 地址（defaultWsUrl）
//   * public/js/screens/room.js 邀请链接（inviteLink，指向游戏服务器而不是本机 127.0.0.1）
//   * public/js/screens/title.js 开始界面的拦截（isStartBlocked）
//
// 场景来自 docs/WINDOWS.md 的「连接服务器」：页面与素材从本机（127.0.0.1）读，对局数据连远端服务器
// （`?server=host`）。安全上下文的判断与 server/net.js 的 requestSecure 一一对应：https 或本机。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const mod = (rel) => import(pathToFileURL(path.join(PUBLIC, 'js', rel)).href);

/** 假装页面在这个地址上（模块都在调用时读 globalThis.location）。 */
function withLocation(loc, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const prev = globalThis.location;
  globalThis.location = loc;
  try { return fn(); } finally { if (had) globalThis.location = prev; else delete globalThis.location; }
}

const at = (protocol, host, search = '') => ({ protocol, host, hostname: host.split(':')[0], search, href: `${protocol}//${host}/${search}`, origin: `${protocol}//${host}`, pathname: '/' });

describe('gameserver: 地址解析', () => {
  test('isLocalHostName', async () => {
    const { isLocalHostName } = await mod('gameserver.js');
    for (const h of ['127.0.0.1', '127.0.0.5', '127.0.0.1:3000', 'localhost', 'LOCALHOST:3000', 'LocalHost',
      '[::1]', '[::1]:3000', '0.0.0.0', 'dev.localhost', 'box.local']) {
      assert.ok(isLocalHostName(h), `${h} 是本机`);
    }
    for (const h of ['192.168.1.23', '192.168.1.23:3000', '10.0.0.5', 'game.example.com', 'example.com',
      'notlocalhost.com', '128.0.0.1', 'x.localdomain', '', '   ']) {
      assert.ok(!isLocalHostName(h), `${JSON.stringify(h)} 不是本机（空值不能当成本机，安全默认）`);
    }
  });

  test('isPrivateAddress：内网地址没写协议时按 http', async () => {
    const { isPrivateAddress } = await mod('gameserver.js');
    for (const h of ['192.168.1.23', '192.168.1.23:3000', '10.0.0.5', '172.16.4.4', '172.31.255.1', '169.254.1.1',
      'nas', 'my-pc:3000', 'box.local', 'game.lan', 'server.home', 'git.internal']) {
      assert.ok(isPrivateAddress(h), `${h} 是内网`);
    }
    for (const h of ['game.example.com', 'example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', 'x.localhost']) {
      assert.ok(!isPrivateAddress(h), `${h} 不是内网`);
    }
  });

  test('parseServer: 裸域名默认 https，本机/内网地址用 http', async () => {
    const { parseServer } = await mod('gameserver.js');
    const remote = parseServer('game.example.com');
    assert.equal(remote.host, 'game.example.com');
    assert.equal(remote.encrypted, true);
    assert.equal(remote.secure, true);
    assert.equal(remote.ws, 'wss://game.example.com');
    assert.equal(remote.origin, 'https://game.example.com');

    const lan = parseServer('192.168.1.23:3000');
    assert.equal(lan.scheme, 'http', '内网没有证书，按 http 连');
    assert.equal(lan.encrypted, false);
    assert.equal(lan.local, false);
    assert.equal(lan.secure, false, '局域网 http 不是安全上下文');
    assert.equal(lan.ws, 'ws://192.168.1.23:3000');

    const local = parseServer('127.0.0.1:3000');
    assert.equal(local.scheme, 'http');
    assert.equal(local.local, true);
    assert.equal(local.secure, true, '浏览器把 127.0.0.1 视为安全上下文');
    assert.equal(local.ws, 'ws://127.0.0.1:3000');

    const explicit = parseServer('https://game.example.com');
    assert.equal(explicit.encrypted, true);
    assert.equal(parseServer('  Game.Example.COM  ').host, 'game.example.com', '大小写与空格');
    assert.equal(parseServer('game.example.com/some/path?x=1').host, 'game.example.com', '带路径也只取源');
    assert.equal(parseServer('http://127.0.0.1:3000').host, '127.0.0.1:3000');
  });

  test('parseServer: 无法使用的地址返回 null', async () => {
    const { parseServer } = await mod('gameserver.js');
    for (const bad of ['', '   ', null, undefined, 'ws://game.example.com', 'ftp://x', 'javascript:alert(1)', '/path/only', 'http://']) {
      assert.equal(parseServer(bad), null, `${JSON.stringify(bad)} 应被拒绝`);
    }
  });

  test('paramOf', async () => {
    const { paramOf, SERVER_PARAM, PUSH_ONLY_PARAM } = await mod('gameserver.js');
    assert.equal(SERVER_PARAM, 'server');
    assert.equal(PUSH_ONLY_PARAM, 'pushOnly');
    assert.equal(paramOf('?server=game.example.com', 'server'), 'game.example.com');
    assert.equal(paramOf('?room=ABCD&server=a.com', 'server'), 'a.com');
    assert.equal(paramOf('?room=ABCD', 'server'), '');
    assert.equal(paramOf('', 'server'), '');
    assert.equal(paramOf(null, 'server'), '');
  });
});

describe('gameserver: 当前页面连哪台服务器', () => {
  test('没有 ?server= → 页面自己的源', async () => {
    const { gameServer } = await mod('gameserver.js');
    withLocation(at('http:', '192.168.1.23:3000', ''), () => {
      const s = gameServer();
      assert.equal(s.host, '192.168.1.23:3000');
      assert.equal(s.sameOrigin, true);
      assert.equal(s.local, false);
      assert.equal(s.secure, false);
    });
    withLocation(at('http:', '127.0.0.1:3000', ''), () => {
      const s = gameServer();
      assert.equal(s.sameOrigin, true);
      assert.equal(s.secure, true, '本机 http 也是安全上下文');
      assert.equal(s.pageOrigin, 'http://127.0.0.1:3000');
    });
    withLocation(at('https:', 'game.example.com', ''), () => {
      const s = gameServer();
      assert.equal(s.ws, 'wss://game.example.com');
      assert.equal(s.secure, true);
      assert.equal(s.sameOrigin, true);
    });
  });

  test('?server= 指向别的服务器 → sameOrigin=false，ws 跟着它走', async () => {
    const { gameServer } = await mod('gameserver.js');
    withLocation(at('http:', '127.0.0.1:3000', '?server=game.example.com'), () => {
      const s = gameServer();
      assert.equal(s.sameOrigin, false);
      assert.equal(s.host, 'game.example.com');
      assert.equal(s.ws, 'wss://game.example.com', '远端默认 wss');
      assert.equal(s.secure, true);
      assert.equal(s.pageOrigin, 'http://127.0.0.1:3000', '页面仍是本机');
    });
    // 加了省流量模式标志也一样
    withLocation(at('http:', '127.0.0.1:3000', '?server=game.example.com&pushOnly=1'), () => {
      assert.equal(gameServer().host, 'game.example.com');
      assert.equal(gameServer().sameOrigin, false);
    });
    // ?server= 就是页面自己 → 仍然是同一个源（不用绕一层）
    withLocation(at('http:', '127.0.0.1:3000', '?server=127.0.0.1:3000'), () => {
      assert.equal(gameServer().sameOrigin, true);
    });
    // 远端是局域网 http：不安全，省流量模式会拒绝
    withLocation(at('http:', '127.0.0.1:3000', '?server=192.168.1.23:3000'), () => {
      const s = gameServer();
      assert.equal(s.sameOrigin, false);
      assert.equal(s.secure, false);
      assert.equal(s.ws, 'ws://192.168.1.23:3000');
    });
    // 页面是 https、远端写了 http → 不因为页面安全就算安全
    withLocation(at('https:', 'game.example.com', '?server=other.example.com'), () => {
      const s = gameServer();
      assert.equal(s.encrypted, true);
      assert.equal(s.host, 'other.example.com');
    });
  });

  test('switchServerUrl / clearServerUrl 保留 room 参数', async () => {
    const { switchServerUrl, clearServerUrl } = await mod('gameserver.js');
    const loc = at('http:', '127.0.0.1:3000', '?room=ABCD');
    assert.equal(switchServerUrl('game.example.com', loc), 'http://127.0.0.1:3000/?room=ABCD&server=game.example.com');
    assert.equal(switchServerUrl('192.168.1.23:3000', loc), 'http://127.0.0.1:3000/?room=ABCD&server=192.168.1.23%3A3000');
    assert.equal(switchServerUrl('', loc), '', '无效地址不跳转');
    assert.equal(switchServerUrl('ws://x', loc), '');
    assert.equal(clearServerUrl(at('http:', '127.0.0.1:3000', '?room=ABCD&server=game.example.com&pushOnly=1')),
      'http://127.0.0.1:3000/?room=ABCD', '去掉 server 与 pushOnly');
  });

  test('clientConfigUrl 问的是游戏服务器，不是页面', async () => {
    const { clientConfigUrl, gameServer } = await mod('gameserver.js');
    withLocation(at('http:', '127.0.0.1:3000', '?server=game.example.com'), () => {
      assert.equal(clientConfigUrl(gameServer()), 'https://game.example.com/api/client-config');
    });
    withLocation(at('http:', '127.0.0.1:3000', ''), () => {
      assert.equal(clientConfigUrl(gameServer()), 'http://127.0.0.1:3000/api/client-config');
    });
  });
});

describe('gameserver: 三个使用者', () => {
  test('net.js defaultWsUrl 跟着 ?server= 走', async () => {
    const { defaultWsUrl } = await mod('net.js');
    assert.equal(defaultWsUrl(at('http:', 'a:3000')), 'ws://a:3000/ws');
    assert.equal(defaultWsUrl(at('https:', 'x.io')), 'wss://x.io/ws');
    // 本机页面 + 远端服务器：对局数据发到远端
    assert.equal(defaultWsUrl(at('http:', '127.0.0.1:3000', '?server=game.example.com')), 'wss://game.example.com/ws');
    assert.equal(defaultWsUrl(at('http:', '127.0.0.1:3000', '?server=192.168.1.23:3000')), 'ws://192.168.1.23:3000/ws');
    assert.equal(defaultWsUrl(at('https:', 'a.com', '?server=b.com')), 'wss://b.com/ws');
    assert.equal(defaultWsUrl(at('http:', '127.0.0.1:3000', '?server=127.0.0.1:3000')), 'ws://127.0.0.1:3000/ws');
    assert.equal(defaultWsUrl(null), 'ws://localhost:3000/ws', '没有 location 时的兜底');
    assert.equal(defaultWsUrl({}), 'ws://localhost:3000/ws');
  });

  test('room.js inviteLink 指向游戏服务器，而不是本机', async () => {
    const { inviteLink } = await mod('screens/room.js');
    withLocation(at('http:', '192.168.1.23:3000', ''), () => {
      assert.equal(inviteLink('ABCD'), 'http://192.168.1.23:3000/?room=ABCD');
    });
    // 本机页面连远端：链接必须给远端，否则朋友会收到你的 127.0.0.1
    withLocation(at('http:', '127.0.0.1:3000', '?server=game.example.com'), () => {
      assert.match(inviteLink('ABCD'), /^https:\/\/game\.example\.com\/\?room=ABCD$/);
      assert.ok(!/127\.0\.0\.1/.test(inviteLink('ABCD')), '不能泄露本机地址');
    });
    withLocation(at('https:', 'game.example.com', ''), () => {
      assert.equal(inviteLink('AB CD'), 'https://game.example.com/?room=AB%20CD', '密钥要转义');
    });
  });

  test('title.js isStartBlocked：省流量模式 + 非安全连接才拦', async () => {
    const { isStartBlocked } = await mod('screens/title.js');
    const { gameServer } = await mod('gameserver.js');
    const blockedAt = (loc, cfg = { pushOnly: true }) => withLocation(loc, () => isStartBlocked(cfg, gameServer()));
    // 开了省流量模式
    assert.equal(blockedAt(at('http:', '192.168.1.23:3000', '')), true, '局域网 http 被拦');
    assert.equal(blockedAt(at('http:', 'game.example.com', '')), true, '域名 http 被拦');
    assert.equal(blockedAt(at('http:', '127.0.0.1:3000', '')), false, '本机 http 放行');
    assert.equal(blockedAt(at('https:', 'game.example.com', '')), false, 'https 放行');
    assert.equal(blockedAt(at('http:', '127.0.0.1:3000', '?server=192.168.1.23:3000')), true, '本机页面连不安全远端：拦');
    assert.equal(blockedAt(at('http:', '127.0.0.1:3000', '?server=game.example.com')), false, '本机页面连 https 远端：放行');
    // 没开省流量模式：一律放行
    assert.equal(withLocation(at('http:', '192.168.1.23:3000', ''), () => isStartBlocked({ pushOnly: false }, gameServer())), false);
    assert.equal(withLocation(at('http:', '192.168.1.23:3000', ''), () => isStartBlocked(null, gameServer())), false, '读不到配置时不拦（老服务器）');
    assert.equal(isStartBlocked({ pushOnly: true }, { secure: false }), true);
    assert.equal(isStartBlocked({ pushOnly: true }, { secure: true }), false);
  });

  test('title.js showServerPicker：公网域名上不给「换服务器」的入口', async () => {
    const { showServerPicker } = await mod('gameserver.js');
    // 公网域名 / 公网 IP：访客面前没有第二台服务器，地址框只会把人引到别处（还有他自己的 127.0.0.1）
    for (const loc of [at('https:', 'game.kafuno.cn'), at('http:', 'game.example.com'), at('https:', '8.138.253.12')]) {
      assert.equal(showServerPicker(loc), false, `${loc.host} 上不该出现服务器选择`);
    }
    // Windows 便携版「本机当服务器」：页面就在 127.0.0.1 上
    assert.equal(showServerPicker(at('http:', '127.0.0.1:3000')), true);
    assert.equal(showServerPicker(at('http:', 'localhost:3000')), true);
    // 局域网自建服：同宿舍的朋友从 192.168.x 进来，仍然允许改连别的服务器
    assert.equal(showServerPicker(at('http:', '192.168.1.23:3000')), true);
    assert.equal(showServerPicker(at('http:', 'nas:3000')), true);
    // 已经用 ?server= 连着远端：必须留着，否则「取消指定」没有出口
    assert.equal(showServerPicker(at('http:', '127.0.0.1:3000', '?server=game.example.com')), true);
    assert.equal(showServerPicker(at('https:', 'game.kafuno.cn', '?server=other.example.com')), true,
      '公网页面主动指定了别的服务器时，要能取消回来');
    // ?server= 指回自己：仍是同一台，按公网页面处理
    assert.equal(showServerPicker(at('https:', 'game.kafuno.cn', '?server=game.kafuno.cn')), false);
  });
});