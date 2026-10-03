// Title screen: season-style backdrop, big title 卫戍协议：盟约, remembered nickname, 开始.
//
// Pressing 开始 validates the nickname (1..NAME_MAX_LEN chars, no control characters), stores it,
// marks this tab as "entered" (so reloads skip the title) and hands the name to net.js, which
// sends `hello` (now, or as soon as the socket is open). The router then shows the lobby.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.

import { useMemo, useState, useEffect } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, APP_VERSION } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill } from '../ui/components.js';
import { GuideButton } from '../ui/guide.js';
import { toast } from '../ui/toasts.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, detectFeatures } from '../ui/device.js';
import { gameServer, parseServer, switchServerUrl, clearServerUrl, clientConfigUrl, paramOf, PUSH_ONLY_PARAM, showServerPicker } from '../gameserver.js';

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_LEN UTF-16 code units — the
 * protocol's `hello.name` limit — without splitting a surrogate pair.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN);
    // Don't leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;

// ---- 开始界面的服务器选择（docs/WINDOWS.md） ------------------------------------------------------------------
// 「本机当服务器」：这台电脑既发页面又跑对局（页面自己的源，`http://127.0.0.1:3000`）。
// 「连接服务器」：在**本机页面**上填远端地址，页面与素材仍从本机读，只有游戏数据连远端
//   （`?server=<host>`，见 public/js/gameserver.js）。这样不必为了连别人的服务器再下载几十 MB 素材，
//   也正好配合服务器的省流量模式（战斗由服务器模拟并推流，客户端只发操作）。
// 省流量模式（`SP_PUSH_ONLY`，见 server/net.js）只接受安全连接：https，或浏览器所在的本机。不满足时开始
// 界面弹黄条警告并禁止开始（服务器侧同时以 403 拒绝 WebSocket 升级）。

/** 上次手填的服务器地址（只用于输入框预填，不影响连哪台服务器）。 */
export const SERVER_ADDR_KEY = 'sp.serverAddr';
/** 本机服务器的端口——server/index.js 的 `PORT`，默认 3000。 */
const LOCAL_PORT = '3000';

/** 本机（页面所在机器）的游戏服务器地址。 */
export function localServerUrl() {
  try { return `http://127.0.0.1:${location.port || LOCAL_PORT}/`; } catch { return `http://127.0.0.1:${LOCAL_PORT}/`; }
}

/** @returns {string} */
export function loadServerAddr() {
  try { return localStorage.getItem(SERVER_ADDR_KEY) || ''; } catch { return ''; }
}

/** @param {string} value */
export function saveServerAddr(value) {
  try { localStorage.setItem(SERVER_ADDR_KEY, String(value ?? '')); } catch { /* private mode: ignore */ }
}

/**
 * 开始按钮该不该拦下来：开了省流量模式、而这条到游戏服务器的连接又不是安全连接（https，或本机）。
 * 与 server/net.js 的 requestSecure 同一套判断。
 * @param {{ pushOnly?: boolean } | null} cfg
 * @param {ReturnType<typeof gameServer>} srv
 * @returns {boolean}
 */
export const isStartBlocked = (cfg, srv) => !!cfg?.pushOnly && !srv.secure;

/**
 * `GET <游戏服务器>/api/client-config`：省流量模式与它决定的战斗模式。
 * 远端服务器未开放跨域时读不到，此时退回启动器预读的 `?pushOnly=` 参数。
 * 加载中与读不到都返回 null。
 * @returns {null | { ok: boolean, pushOnly: boolean, combatMode: 'client' | 'server', secure: boolean }}
 */
export function useClientConfig() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    let alive = true;
    const srv = gameServer();
    const asked = paramOf(location.search, PUSH_ONLY_PARAM);
    if (asked !== '') setCfg({ ok: true, pushOnly: /^(1|true|yes|on)$/i.test(asked), secure: srv.secure, endpoint: 'url' });
    let req;
    try { req = fetch(clientConfigUrl(srv), { headers: { accept: 'application/json' }, cache: 'no-store' }); } catch { return undefined; }
    req.then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j && j.ok) setCfg(j); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return cfg;
}

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  net.setName(name);
  return true;
}

// data/assets.json `ui` keys are 'group/key' (docs/ASSETS.md).
const BACKDROP_KEYS = ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02'];
const RIDGE_KEYS = ['titleRidges', 'entry/bg_mountains_tiled'];

/**
 * Find a UI image URL in data/assets.json (tolerant of a few plausible shapes).
 * @param {any} assets
 * @param {string[]} names
 * @returns {string|null}
 */
export function findUiAsset(assets, names) {
  if (!assets || typeof assets !== 'object') return null;
  const asUrl = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url || v.path || v.src || null;
    return null;
  };
  const ui = assets.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    for (const n of names) {
      const u = asUrl(ui[n]);
      if (u) return u;
    }
  }
  const lists = [Array.isArray(ui) ? ui : null, Array.isArray(assets.files) ? assets.files : null].filter(Boolean);
  for (const list of lists) {
    for (const n of names) {
      const hit = list.map(asUrl).find((u) => typeof u === 'string' && u.includes('/ui/') && u.toLowerCase().split('/').pop().startsWith(n.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

// Dot-matrix watchtower emblem (13×14 bitmap; dots grow toward the base for depth).
const EMBLEM = [
  'XXX..XXX..XXX',
  'XXX..XXX..XXX',
  'XXXXXXXXXXXXX',
  '.XXXXXXXXXXX.',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXX.XXXX..',
  '..XXXX.XXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX',
  'XXXXXXXXXXXXX',
];

function Emblem() {
  const dots = useMemo(() => {
    const out = [];
    EMBLEM.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== 'X') return;
        const rad = 0.2 + (r / (EMBLEM.length - 1)) * 0.2;
        const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
        out.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent, d: (r * 13 + c) % 7 });
      });
    });
    return out;
  }, []);
  return html`<div class="emblem" aria-hidden="true">
    <span class="emblem__bracket emblem__bracket--l"></span>
    <svg class="emblem__svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map((d, i) => html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : `d${d.d}`} />`)}
    </svg>
    <span class="emblem__bracket emblem__bracket--r"></span>
  </div>`;
}

function Ridges() {
  return html`<svg class="title-bg__ridges" viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#16231f" /><stop offset="1" stop-color="#0a0e0d" />
      </linearGradient>
      <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0f1714" /><stop offset=".6" stop-color="#080b0a" />
      </linearGradient>
      <linearGradient id="ridge-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17f9b7" stop-opacity="0" />
        <stop offset=".3" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset=".7" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset="1" stop-color="#17f9b7" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="ridge ridge--far" fill="url(#ridge-far)" stroke="url(#ridge-edge)"
      d="M0 420V250l120-40 90 30 90-70 60 20 80-70 80 55 80-25 90 70 90-20 80 50 100-15 90 25 90-55 90-55 70-55 70 45 80-20 90 65 80-20 100 55 100-20 100 40v180z" />
    <path class="ridge ridge--near" fill="url(#ridge-near)" stroke="url(#ridge-edge)"
      d="M0 420V322l160-32 100 20 120-50 90 40 130-20 120 50 140-30 140 35 120-35 140 20 140-50 120 30 120-20 120 40 160-20v147z" />
  </svg>`;
}

const STATUS_TEXT = {
  idle: '准备连接', connecting: '正在连接服务器', connected: '已连接服务器', handshaking: '正在验证身份',
  online: '已连接服务器', reconnecting: '连接中断，正在重连', closed: '连接已关闭',
};

/** Title screen component. */
export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  const [name, setName] = useState(() => store.get().me.name || identity.loadName() || '');
  const assetsSettled = useData('assets');
  const assets = data.get('assets');
  const backdrop = findUiAsset(assets, BACKDROP_KEYS);
  const ridges = findUiAsset(assets, RIDGE_KEYS);
  // Track load/fail per URL (not as booleans reset in effects: an image can load before an effect runs).
  const [bgLoadedUrl, setBgLoadedUrl] = useState(null);
  const [ridgesLoadedUrl, setRidgesLoadedUrl] = useState(null);
  const [ridgesFailedUrl, setRidgesFailedUrl] = useState(null);
  const bgLoaded = !!backdrop && bgLoadedUrl === backdrop;
  const ridgesLoaded = !!ridges && ridgesLoadedUrl === ridges;
  const ridgesFailed = !!ridges && ridgesFailedUrl === ridges;
  // CSS ridgelines only when there is no ridge art (avoids a swap flash when the art arrives).
  const cssRidges = assetsSettled && (!ridges || ridgesFailed);

  const cfg = useClientConfig();
  const srv = gameServer();
  // 省流量模式：服务器模拟战斗并推流，只接受安全连接（https 或本机）——不满足就禁用「开始」。
  const pushOnly = !!cfg?.pushOnly;
  const blocked = isStartBlocked(cfg, srv);
  const [addr, setAddr] = useState(() => loadServerAddr());
  const typed = parseServer(addr);
  // 页面与游戏服务器不是同一台：提示一下素材来自哪里、对局在哪里跑。
  const remote = !srv.sameOrigin;
  const pageIsLocal = parseServer(srv.pageOrigin)?.local ?? false;
  // 「本机当服务器 / 连接服务器」只对 Windows 便携版与局域网自建服有意义：公网域名上直连进来的玩家面前
  // 没有第二台服务器，摆个地址框只会让人以为要跑去别处玩（也不该把访客引到他自己的 127.0.0.1）。判定有单测。
  const picker = showServerPicker();

  const valid = isValidName(name);
  const start = () => {
    if (blocked) { toast('游戏服务器已开启省流量模式，请通过 https（或本机）访问后再开始游戏', 'warn'); return; }
    if (!valid) { toast('请输入博士代号', 'warn'); return; }
    enterSession(name);
  };
  const goTo = (url) => { if (url) { try { location.href = url; } catch { /* ignore */ } } };
  // 「连接」：不跳转到对方网页，而是让**当前这个页面**去连它（素材仍从本机读）。
  const connectRemote = () => {
    if (!typed) { toast('请输入有效的服务器地址，例如 game.example.com', 'warn'); return; }
    saveServerAddr(addr);
    const url = switchServerUrl(addr);
    if (!url) { toast('服务器地址无法识别', 'warn'); return; }
    goTo(url);
  };

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  return html`<div class="screen title-screen">
    <div class=${`title-bg${bgLoaded ? ' has-art' : ''}${ridgesLoaded ? ' has-ridges' : ''}`} aria-hidden="true">
      ${backdrop ? html`<img class="title-bg__art" src=${backdrop} alt="" draggable=${false}
        onLoad=${() => setBgLoadedUrl(backdrop)} />` : null}
      <div class="title-bg__glow"></div>
      <div class="title-bg__radar"><div class="title-bg__sweep"></div></div>
      <div class="title-bg__target"></div>
      ${cssRidges ? html`<${Ridges} />` : null}
      ${ridges && !ridgesFailed ? html`<div class="title-bg__ridge-art" style=${`background-image:url("${ridges}")`}>
        <img src=${ridges} alt="" hidden onLoad=${() => setRidgesLoadedUrl(ridges)} onError=${() => setRidgesFailedUrl(ridges)} />
      </div>` : null}
      <div class="title-bg__haze"></div>
      <span class="cross" style="left:7%;top:22%"></span>
      <span class="cross" style="left:93%;top:30%"></span>
      <span class="cross" style="left:14%;top:70%"></span>
      <span class="cross" style="left:88%;top:62%"></span>
      <span class="cross" style="left:60%;top:12%"></span>
    </div>

    <div class="title-corner title-corner--tl">
      <span class="title-corner__mark"></span>
      <div><${MicroLabel} tone="mint">RHODES ISLAND // SIMULATION SERVICE<//><br /><${MicroLabel}>TACTICAL CO-OP NODE · 02<//></div>
    </div>
    <div class="title-corner title-corner--tr">
      <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
    </div>

    <main class="title-main">
      <${Emblem} />
      <div class="title-en">
        <span class="title-en__a">STRONGHOLD PROTOCOL</span>
        <span class="title-en__b">ALLIANCE</span>
      </div>
      <h1 class="title-cn">卫戍协议<span class="title-cn__colon">：</span><em>盟约</em></h1>
      <p class="title-tag">调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。</p>

      <div class="title-net">
        <div class="title-net__row">
          <span class="title-net__label">游戏服务器</span>
          <span class="title-net__host">${srv.sameOrigin ? `${srv.local ? '本机 ' : ''}${srv.host}` : `${srv.origin}`}</span>
          ${pushOnly ? html`<span class="title-net__badge" title="省流量模式：战斗由服务器模拟并推流，本机只发送操作"><${Icon} name="signal" class="title-net__badge-icon" />省流量模式<//>` : null}
        </div>
        ${remote ? html`<div class="title-net__row title-net__note">
          <span>${pageIsLocal ? '页面与素材来自本机' : `页面来自 ${srv.pageOrigin}`} · 对局数据走上面的服务器（最省带宽）</span>
        </div>` : null}
        ${picker ? html`<div class="title-net__row title-net__row--pick">
          <${Button} size="sm" icon="signal" active=${srv.sameOrigin} disabled=${srv.sameOrigin} title="在这台电脑上开一个服务器（Windows 便携版启动器里选「本机当服务器」）"
            onClick=${() => goTo(localServerUrl())}>本机当服务器<//>
          <${TextField} size="sm" value=${addr} onInput=${setAddr} onEnter=${connectRemote} class="title-net__addr"
            placeholder="连接服务器：game.example.com" />
          <${Button} size="sm" variant="primary" icon="link" disabled=${!typed} onClick=${connectRemote}>连接<//>
          ${remote ? html`<${Button} size="sm" variant="ghost" square=${true} icon="close" aria-label="不再指定服务器，回到本页面自己的服务器"
            title="取消指定，回到本页面自己的服务器" onClick=${() => goTo(clearServerUrl())} />` : null}
        </div>` : null}
      </div>

      ${blocked ? html`<div class="title-warn" role="alert">
        <${Icon} name="warn" class="title-warn__icon" />
        <div class="title-warn__body">
          <b>游戏服务器已开启省流量模式</b>
          <span>该模式由服务器模拟战斗并推流，要求加密连接，当前到 <b>${srv.host}</b> 的连接不安全，无法开始游戏。${srv.encrypted
            ? ''
            : html`请改用 <a href=${`https://${srv.host}/`}>https://${srv.host}/</a>（本机 127.0.0.1 不受影响）。`}</span>
        </div>
      </div>` : null}

      <div class="title-login">
        ${pendingJoin ? html`<div class="title-invite">
          <${Icon} name="key" />
          <span>收到同盟邀请</span><b class="num">${pendingJoin}</b><span class="t-lo">· 输入代号后将自动加入</span>
        </div>` : null}
        <${TextField} label="博士代号" micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
          placeholder="输入你的代号（最多 ${NAME_MAX_LEN} 字）" autoFocus=${!touchUi}
          onInput=${setName} onEnter=${start} />
        <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" disabled=${!valid || blocked} onClick=${start}>开始<//>
        <div class="title-conn">
          <span class=${`status-dot ${dotClass}`}></span>
          <span>${STATUS_TEXT[conn.status] || conn.status}</span>
          ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
          <${GuideButton} class="title-guide" />
          <${FullscreenButton} class="title-fs" />
        </div>
      </div>
    </main>

    <footer class="title-foot">
      <span>非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有</span>
      <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
    </footer>
  </div>`;
}
