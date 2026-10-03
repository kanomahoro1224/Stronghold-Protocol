// public/js/gameserver.js — 这个页面到底在连哪台游戏服务器。
//
// 默认就是页面自己的源（同一台机器既发页面又跑对局）。页面也可以用 `?server=<host>` 指定另一台服务器：
// Windows 启动器的「连接服务器」就是这么做的——**页面和素材都从本机读**（`http://127.0.0.1:3000`，便携包里
// 已有全部素材），只有游戏协议（WebSocket）走远端服务器。这样连别人的服务器时不必把几十 MB 素材再从远端下
// 载一遍，也正好配合服务器的省流量模式（战斗由服务器模拟并推流，客户端只发操作）。
//
// 地址可以是裸域名、`host:port` 或完整 URL。没写协议时按地址决定：本机地址用 http/ws，其余用 https/wss——
// 开了省流量模式的服务器本来就只接受安全连接。三种判断与 server/net.js 的 requestSecure 一一对应：
//   encrypted（https/wss）/ local（本机）/ secure = encrypted || local。
//
// 只看 URL 参数，不写 localStorage：一键「本机当服务器」与「连接服务器」必须能被明确区分，不能凭记忆串台。

/** URL 参数名：指定另一台游戏服务器（docs/WINDOWS.md）。 */
export const SERVER_PARAM = 'server';
/** URL 参数名：启动器预读到的省流量模式标志（远端没开跨域时也能做出判断）。 */
export const PUSH_ONLY_PARAM = 'pushOnly';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * 本机地址（浏览器把 `http://127.0.0.1` 视为安全上下文，普通 http 的局域网地址则不是）。
 * @param {string} value host / host:port / [::1]:port
 * @returns {boolean}
 */
export function isLocalHostName(value) {
  let h = String(value || '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else if (h.split(':').length === 2) {
    h = h.split(':')[0];
  }
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || h.endsWith('.local') || /^127\./.test(h);
}

/**
 * @param {string} search `location.search`
 * @param {string} name
 * @returns {string} '' 当参数不存在
 */
export function paramOf(search, name) {
  try {
    return new URLSearchParams(String(search || '')).get(name) || '';
  } catch {
    return '';
  }
}

/**
 * 大概是「同一个局域网里的一台机器」：RFC1918 私网、链路本地、单段主机名、`.local` / `.lan` / `.home`。
 * 这类地址现实中不会有证书，所以没写协议时按 http 处理（https 会连不上）；它们**不是**安全上下文，
 * 因此省流量模式会照样拒绝——见 server/net.js。
 * @param {string} value host / host:port / [::1]:port
 * @returns {boolean}
 */
export function isPrivateAddress(value) {
  let h = String(value || '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else if (h.split(':').length === 2) {
    h = h.split(':')[0];
  }
  if (!h) return false;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/\.(local|lan|home|internal|intranet)$/.test(h)) return true;
  return !h.includes('.') && !h.includes(':');   // 单段主机名（nas、my-pc）只可能是内网
}

/** 没写协议时的默认协议：本机/内网用 http，其余（公网域名或 IP）用 https。 */
const defaultScheme = (host) => (isLocalHostName(host) || isPrivateAddress(host) ? 'http' : 'https');

/**
 * 规范化一个服务器地址参数。
 * @param {string} raw
 * @returns {{ host: string, hostname: string, encrypted: boolean, local: boolean, secure: boolean,
 *             scheme: 'http' | 'https', origin: string, ws: string } | null} null 表示地址不可用
 */
export function parseServer(raw) {
  let s = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  // `/path`、`?room=…` 这类不是地址：加上协议头会被 WHATWG URL 当成主机名（`https:///path` → host `path`）。
  if (/^[/?#]/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${defaultScheme(s.split('/')[0])}://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.host) return null;
  const encrypted = u.protocol === 'https:';
  const local = isLocalHostName(u.host);
  return {
    host: u.host,
    hostname: u.hostname,
    encrypted,
    local,
    secure: encrypted || local,
    scheme: encrypted ? 'https' : 'http',
    origin: `${u.protocol}//${u.host}`,
    ws: `${encrypted ? 'wss' : 'ws'}://${u.host}`,
  };
}

/**
 * 这个页面正在连的游戏服务器：`?server=` 指定时用它，否则是页面自己的源。
 * @param {{protocol?: string, host?: string, search?: string, pathname?: string}} [loc]
 * @returns {{ host: string, hostname: string, encrypted: boolean, local: boolean, secure: boolean,
 *             scheme: 'http' | 'https', origin: string, ws: string, sameOrigin: boolean, pageOrigin: string }}
 */
export function gameServer(loc = globalThis.location) {
  const pageHost = String(loc?.host || '');
  const pageOrigin = loc?.host ? `${loc.protocol === 'https:' ? 'https:' : 'http:'}//${pageHost}` : '';
  const asked = parseServer(paramOf(loc?.search, SERVER_PARAM));
  if (asked && asked.host.toLowerCase() !== pageHost.toLowerCase()) {
    return { ...asked, sameOrigin: false, pageOrigin };
  }
  const encrypted = loc?.protocol === 'https:';
  const local = isLocalHostName(pageHost);
  return {
    host: pageHost,
    hostname: pageHost,
    encrypted,
    local,
    secure: encrypted || local,
    scheme: encrypted ? 'https' : 'http',
    origin: pageOrigin,
    ws: `${encrypted ? 'wss' : 'ws'}://${pageHost}`,
    sameOrigin: true,
    pageOrigin,
  };
}

/**
 * 页面 URL 换一个游戏服务器（保留 `room` 等其它参数），供开始界面的「连接」按钮使用。
 * @param {string} raw 新服务器地址
 * @param {{href: string}} [loc] 当前页面地址（默认 location）
 * @returns {string} '' 当地址不可用
 */
export function switchServerUrl(raw, loc = globalThis.location) {
  const srv = parseServer(raw);
  if (!srv) return '';
  let u;
  try { u = new URL(loc?.href || pageHref(loc)); } catch { return ''; }
  u.searchParams.set(SERVER_PARAM, srv.host);
  return u.href;
}

/** 去掉 `?server=`：回到「页面自己的服务器」。 @param {{href: string}} [loc] */
export function clearServerUrl(loc = globalThis.location) {
  try {
    const u = new URL(loc?.href || pageHref(loc));
    u.searchParams.delete(SERVER_PARAM);
    u.searchParams.delete(PUSH_ONLY_PARAM);
    return u.href;
  } catch {
    return '';
  }
}

/** @param {any} loc */
function pageHref(loc) {
  return loc?.host ? `${loc.protocol === 'https:' ? 'https:' : 'http:'}//${loc.host}${loc.pathname || '/'}${loc.search || ''}` : '';
}

/**
 * `GET /api/client-config` 的地址：**正在玩的那台服务器**（本机页面连远端时必须问远端）。
 * @param {ReturnType<typeof gameServer>} srv
 * @returns {string}
 */
export function clientConfigUrl(srv) {
  return `${srv.origin}/api/client-config`;
}