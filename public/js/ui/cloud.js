// public/js/ui/cloud.js — 云端账号（邮箱验证码 + Turnstile）、云同步与历史战绩 / Demo 播放。
//
// The server side lives in server/accounts/* (docs/ACCOUNTS.md). Every call is same-origin; the session is an
// HttpOnly cookie, so this module never touches the token. A server without a database answers
// GET /api/config {accounts:false} and this module hides itself (the local account in ui/accounts.js keeps working).
//
// 云同步：loadout (`sp.pref.loadout`) 与设置 (`sp.pref.settings`) 两份本地文档原样上传/恢复，冲突时由玩家点按钮
// 决定方向，不自动合并（localStorage 是玩家的本机副本，云端不会悄悄覆盖它）。
//
// Demo：/api/history 列出本账号参与过的对局；/api/demo/:id 取回 { seed, players, events }，播放器按录制时的
// 毫秒偏移重放动作时间轴。可视化重演（服务端按 seed 重跑并推帧）仍待接入，见 docs/ACCOUNTS.md「已知边界」。

import { html, Modal, Button, MicroLabel } from './components.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { render } from '../../vendor/preact.module.js';
import { store, loadPref, savePref } from '../store.js';
import { listDemos, deleteDemo, putDemo } from '../demoStore.js';
import { t } from '../../../shared/i18n.js';
import { toast } from './toasts.js';

// 与 server/accounts/auth.js 的 PASSWORD_MIN / PASSWORD_MAX 一致：前端只做按钮可用性判断，真正的校验在服务端
const PW_MIN = 6;
const PW_MAX = 64;

let configPromise = null;
/** GET /api/config once; null when the endpoint is missing (not a Stronghold server) or the fetch fails. */
export function cloudConfig() {
  if (!configPromise) {
    configPromise = fetch('/api/config', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return configPromise;
}

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  // 两套错误键：账号接口（server/accounts/auth.js）回 `code`，其它接口回 `error`。统一成 `error`，
  // 调用方只判一个字段就不会漏掉「验证码不对 / 识别号被占用」这类具体原因。
  if (data && data.ok === false && data.error == null && data.code != null) data.error = data.code;
  return { status: res.status, ok: res.ok && !!data?.ok, data: data || {} };
}

/** 当前账号或 null。 */
export async function me() {
  const r = await api('/api/auth/me');
  return r.ok ? r.data.account : null;
}

/** 把 WS 会话绑定到当前账号（登录后调用；换 playerId 后需重绑）。 */
export async function linkCurrentPlayer() {
  const m = store.get().me;
  if (!m?.playerId || !m?.token) return { ok: false, error: 'NO_PLAYER' };
  return api('/api/link', { method: 'POST', body: { playerId: m.playerId, playerToken: m.token } });
}

/**
 * 保存博士代号 / #识别号到当前账号（标题页的输入框在登录后调用）。
 * 服务端只填空白位：识别号一旦跟着账号定下就不再改（409 TAG_TAKEN 表示这个号被占了）。
 */
export async function saveProfile(patch) {
  return api('/api/profile', { method: 'PUT', body: patch });
}

// ---- Turnstile widget ------------------------------------------------------------------------------------------------
let turnstileReady = null;
function loadTurnstile() {
  if (turnstileReady) return turnstileReady;
  turnstileReady = new Promise((resolve) => {
    if (globalThis.turnstile?.render) { resolve(globalThis.turnstile); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = () => resolve(globalThis.turnstile || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return turnstileReady;
}

/** 把当前本机编队/设置/统计整包上传（登录成功后自动跑一次；按钮也复用同一份逻辑）。 */
export async function uploadCurrentSave() {
  return api('/api/cloud', { method: 'PUT', body: {
    loadouts: loadPref('loadout', null),
    settings: loadPref('settings', null),
    stats: loadPref('stats', null),
  } });
}

/** 上传一局本机 Demo 到账号（云端只保留最新 10 局；本机不受限）。未登录返回 401，调用方静默忽略。 */
export async function uploadDemo(doc) {
  if (!doc) return { ok: false, error: 'NO_DOC' };
  // 四人局：上传自己的一份 part，服务端按 matchId 归组并只合并 JSON；单人局继续走旧接口
  if (doc.isTeam && doc.matchId && doc.playerId) {
    return api(`/api/team-demos/${encodeURIComponent(doc.matchId)}/parts`, { method: 'POST', body: { playerId: doc.playerId, doc } });
  }
  return api('/api/cloud/demos', { method: 'POST', body: doc });
}

/** 云端 Demo 完整文档下载；成功后写入本机 IndexedDB 再播放（播放仍在客户端）。 */
async function downloadDemo(id) {
  const team = String(id).match(/^team_(\d+)$/);
  const r = team ? await api(`/api/team-demos/${team[1]}`) : await api(`/api/cloud/demos/${id}`);
  if (!r.ok) return null;
  await putDemo(r.data.demo).catch(() => {});
  return r.data.demo;
}

// ---- login / account modal -------------------------------------------------------------------------------------------
/**
 * 登录 / 退出后换一条新握手。`sp_sid` 是 HttpOnly cookie，只在 WS 升级请求里送给服务端
 * （server/net.js 的 gateHello 用它判断有没有登录）；页面加载时开的 socket 早于登录，握手请求里没有它，
 * 不重连就会一直收到 LOGIN_REQUIRED。已经在局内（session.entered）时不重连，避免打断对局。
 */
async function reconnectSocket() {
  if (store.get().session?.entered) return;
  try {
    const { net } = await import('../net.js');
    net.reconnectNow();
  } catch { /* a page without the game shell (tests) */ }
}

/**
 * 邮箱验证码 / 密码登录表单（注册与登录同一个入口）。弹窗（LoginPanel）和标题页右侧的账号面板共用。
 * `mode` 只在标题页的两个按钮里给：'login' / 'register' 让服务端拒绝「没注册过的邮箱」/「已注册的邮箱」，
 * 并决定是否显示密码输入：
 *   - register：验证码 + 可选密码（设了以后能直接密码登录）
 *   - login：邮箱 + 密码直接登录，也可以改用验证码
 * 不传 mode 时（弹窗）保持旧语义——验证码即注册即登录，没有密码。
 * @param {{ onDone?: (account: any, linked?: boolean) => void, mode?: '' | 'login' | 'register',
 *           profile?: () => { name?: string, tag?: string } | null }} props
 *   `profile` 在登录成功时调用一次，把标题页输入框里的博士代号 / #识别号补到账号上（只补空位）。
 */
export function LoginForm({ onDone, mode = '', profile = null }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('email'); // email → code
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [token, setToken] = useState('');
  const [dev, setDev] = useState(false);
  const [testKeys, setTestKeys] = useState(false);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const box = useState(() => {
    const el = document.createElement('div');
    el.className = 'cloud-ts';
    return el;
  })[0];

  useEffect(() => {
    let widget = null;
    let cancelled = false;
    (async () => {
      const cfg = await cloudConfig();
      setDev(!!cfg?.dev);
      setTestKeys(cfg?.turnstileConfigured === false);
      if (!cfg?.accounts) { setNote(t('账号服务未启用（服务器没有配置数据库）')); return; }
      // 服务器没配真实 secret 时用的是 Cloudflare 官方测试密钥（任意 token 都通过）：不渲染挂件，
      // 否则本机 demo 会挂出一块与游戏界面无关的白色验证框。
      if (cfg?.turnstileConfigured === false) return;
      if (!box) return;
      const ts = await loadTurnstile();
      if (cancelled) return;
      if (!ts?.render) { setWidgetFailed(true); return; }
      widget = ts.render(box, {
        sitekey: cfg.turnstileSiteKey, theme: 'dark',
        callback: (v) => setToken(v), 'expired-callback': () => setToken(''),
        'error-callback': () => setWidgetFailed(true),
      });
    })();
    return () => { cancelled = true; if (widget != null) globalThis.turnstile?.remove?.(widget); };
  }, []);

  // 标题页把表单直接内嵌在 .title-auth 里（不经过 mount()），所以这里自己保证样式已注入
  useEffect(ensureStyle, []);

  // 切换「登录 / 注册」时回到第一步：上一个流程的验证码不该被带过去
  useEffect(() => {
    setStep('email'); setCode(''); setNote('');
    setPassword(mode === 'login' ? '' : password);
  }, [mode]);

  /** 登录成功后的共同收尾：补账号资料 → 绑定本局玩家 → 换新握手 → 上传本机存档。 */
  const finish = async (accountIn) => {
    let account = accountIn;
    // 老账号（注册时没填代号 / 识别号）在这里补上；服务端只填空位，已有值不会被覆盖
    const extra = (typeof profile === 'function' ? profile() : null) || {};
    const patch = {};
    if (extra.name && !account?.name) patch.name = extra.name;
    if (extra.tag && !account?.tag) patch.tag = extra.tag;
    if (Object.keys(patch).length) {
      const p = await api('/api/profile', { method: 'PUT', body: patch });
      if (p.ok) account = p.data.account;
      else if (p.data?.error === 'TAG_TAKEN') toast(t('识别号 {tag} 已被占用，未保存', { tag: patch.tag }), 'warn');
    }
    const link = await linkCurrentPlayer();
    // 登录后换一条新握手，升级请求才带得上刚下发的 sp_sid（服务端 gateHello 读它）
    reconnectSocket();
    // 登录后先把这台设备上的编队/设置传上去，换设备时才有东西可恢复
    uploadCurrentSave().catch(() => {});
    onDone?.(account, link.ok);
  };

  const noteForError = (error) => (error === 'RATE_LIMITED' ? t('操作太频繁，请稍后再试')
    : error === 'TURNSTILE_FAILED' ? t('人机验证未通过，请重试')
      : error === 'ACCOUNT_EXISTS' ? t('该邮箱已经注册过了，请直接登录')
        : error === 'ACCOUNT_NOT_FOUND' ? t('该邮箱还没有注册，请先注册')
          : error === 'EMAIL_INVALID' ? t('邮箱格式不正确')
            : error === 'PASSWORD_WEAK' ? t('密码至少 {n} 位', { n: PW_MIN })
              : error === 'TAG_TAKEN' ? t('这个识别号已经被占用，换一个')
                : error === 'TAG_INVALID' ? t('识别号是 4 位数字')
                  : error === 'BAD_CREDENTIALS' ? t('邮箱或密码不对')
                    : error === 'CODE_WRONG' ? t('验证码不正确')
                      : error === 'CODE_EXPIRED' ? t('验证码已过期，请重新获取')
                        : error === 'CODE_LOCKED' ? t('尝试次数过多，请重新获取验证码')
                          : t('操作失败，请稍后再试'));

  const send = async () => {
    setBusy(true); setNote('');
    const r = await api('/api/auth/code', { method: 'POST', body: { email, turnstileToken: token || (testKeys ? 'test' : widgetFailed && dev ? 'dev' : ''), ...(mode ? { mode } : {}) } });
    setBusy(false);
    if (!r.ok) { setNote(noteForError(r.data.error)); return; }
    setStep('code');
    setNote(r.data.devCode ? t('开发模式验证码：{code}', { code: r.data.devCode })
      : r.data.sent ? t('验证码已发送，请查收邮件') : t('邮件未配置，验证码已写入服务器日志'));
  };

  /** 邮箱 + 密码直接登录（注册时设过密码的账号）。 */
  const loginWithPassword = async () => {
    setBusy(true); setNote('');
    const r = await api('/api/auth/password', { method: 'POST', body: { email, password } });
    setBusy(false);
    if (!r.ok) { setNote(noteForError(r.data.error)); return; }
    await finish(r.data.account);
  };

  const verify = async () => {
    setBusy(true); setNote('');
    const body = { email, code };
    if (mode === 'register') {
      if (password) body.password = password;
      const extra = (typeof profile === 'function' ? profile() : null) || {};
      if (extra.name) body.name = extra.name;
      if (extra.tag) body.tag = extra.tag;
    }
    const r = await api('/api/auth/verify', { method: 'POST', body });
    setBusy(false);
    if (!r.ok) { setNote(noteForError(r.data.error)); return; }
    await finish(r.data.account);
  };

  const pwTooShort = password.length > 0 && password.length < PW_MIN;
  const registerReady = code.length === 6 && !pwTooShort;

  return html`<div class="cloud">
      ${step === 'email' ? html`
        <p class="cloud__note">${mode === 'register' ? t('输入邮箱获取一次性验证码，验证后即完成注册。')
          : mode === 'login' ? t('用邮箱和密码登录；忘记密码可以改用验证码。')
            : t('输入邮箱获取一次性验证码，注册与登录是同一个入口。')}</p>
        <label class="cloud__label">${t('邮箱')}</label>
        <input class="cloud__input" type="email" inputmode="email" value=${email} placeholder="you@example.com"
          onInput=${(e) => setEmail(e.currentTarget.value)} />
        ${mode ? html`<label class="cloud__label">${t('密码')}${mode === 'login' ? html`<span class="cloud__opt">${t('（没有密码可留空）')}</span>` : html`<span class="cloud__opt">${t('（可选）')}</span>`}</label>
        <input class="cloud__input" type="password" value=${password} maxlength=${PW_MAX}
          autocomplete=${mode === 'login' ? 'current-password' : 'new-password'}
          placeholder=${mode === 'register' ? t('至少 {n} 位', { n: PW_MIN }) : '••••••'}
          onInput=${(e) => setPassword(e.currentTarget.value)} />` : null}
        <div ref=${(el) => { if (el && box.parentNode !== el) el.append(box); }}></div>
        ${widgetFailed ? html`<p class="cloud__warn">${dev ? t('人机验证组件未加载；开发模式将跳过验证') : t('人机验证组件未加载，请检查网络')}</p>` : null}
        ${mode === 'login' ? html`<div class="cloud__row">
            <${Button} variant="primary" loading=${busy} disabled=${!email || password.length < PW_MIN} onClick=${loginWithPassword}>${t('登录')}<//>
            <${Button} variant="ghost" loading=${busy} disabled=${!email} onClick=${send}>${t('用验证码登录')}<//>
          </div>` : html`<${Button} variant="primary" loading=${busy} disabled=${!email} onClick=${send}>${t('获取验证码')}<//>`}
      ` : html`
        <p class="cloud__note">${t('验证码已发往 {email}，10 分钟内有效。', { email })}</p>
        <label class="cloud__label">${t('验证码')}</label>
        <input class="cloud__input cloud__input--code" inputmode="numeric" maxlength="6" value=${code}
          onInput=${(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))} />
        ${mode === 'register' ? html`<label class="cloud__label">${t('密码')}<span class="cloud__opt">${t('（可选）')}</span></label>
        <input class="cloud__input" type="password" value=${password} maxlength=${PW_MAX} autocomplete="new-password"
          placeholder=${t('至少 {n} 位', { n: PW_MIN })}
          onInput=${(e) => setPassword(e.currentTarget.value)} />` : null}
        ${pwTooShort ? html`<p class="cloud__warn">${t('密码至少 {n} 位', { n: PW_MIN })}</p>` : null}
        <div class="cloud__row">
          <${Button} variant="primary" loading=${busy} disabled=${mode === 'register' ? !registerReady : code.length !== 6} onClick=${verify}>${mode === 'register' ? t('注册') : t('登录')}<//>
          <${Button} variant="ghost" onClick=${() => { setStep('email'); setCode(''); }}>${t('更换邮箱')}<//>
        </div>
      `}
      ${note ? html`<p class="cloud__note">${note}</p>` : null}
    </div>`;
}

/** 弹窗形态的登录（云账号入口 / 设置里打开）；内嵌到标题页时直接用 LoginForm。 */
function LoginPanel({ onDone, onClose }) {
  return html`<${Modal} open=${true} title=${t('云端账号')} micro=${t('账号 · 邮箱验证码')} onClose=${onClose}>
    <${LoginForm} onDone=${onDone} />
  <//>`;
}

// ---- account / sync modal --------------------------------------------------------------------------------------------
function AccountPanel({ account, onClose, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [histOpen, setHistOpen] = useState(false);

  const upload = async () => {
    setBusy(true); setNote('');
    const r = await uploadCurrentSave();
    setBusy(false);
    setNote(r.ok ? t('已上传到云端') : t('上传失败：{error}', { error: r.data.error || r.status }));
  };
  const restore = async () => {
    setBusy(true); setNote('');
    const r = await api('/api/cloud');
    setBusy(false);
    if (!r.ok) { setNote(t('读取失败：{error}', { error: r.data.error || r.status })); return; }
    if (r.data.loadouts != null) savePref('loadout', r.data.loadouts);
    if (r.data.settings != null) savePref('settings', r.data.settings);
    if (r.data.stats != null) savePref('stats', r.data.stats);
    setNote(t('已从云端恢复编队与设置，刷新页面后生效'));
  };
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    reconnectSocket(); // 退出后同样要换握手：旧 socket 仍带着已注销的会话
    onRefresh?.(null);
  };

  return html`<${Modal} open=${true} title=${t('云端账号')} micro="CLOUD ACCOUNT" onClose=${onClose}>
    <div class="cloud">
      <p class="cloud__who"><b>${account.email}</b><br /><${MicroLabel}>${t('已绑定本局玩家')}<//></p>
      <${Button} variant="secondary" icon="chart" onClick=${() => setHistOpen(true)}>${t('历史战绩 / Demo')}<//>
      <div class="cloud__row">
        <${Button} variant="primary" loading=${busy} onClick=${upload}>${t('上传到云端')}<//>
        <${Button} variant="ghost" loading=${busy} onClick=${restore}>${t('从云端恢复')}<//>
      </div>
      <${Button} variant="ghost" onClick=${logout}>${t('退出登录')}<//>
      ${note ? html`<p class="cloud__note">${note}</p>` : null}
      ${histOpen ? html`<${HistoryPanel} onClose=${() => setHistOpen(false)} />` : null}
    </div>
  <//>`;
}

// ---- history + demo player -------------------------------------------------------------------------------------------
const dateOf = (v) => { try { return new Date(v).toLocaleString(); } catch { return String(v || ''); } };

function HistoryPanel({ onClose }) {
  const [local, setLocal] = useState(null);
  const [cloud, setCloud] = useState(null);
  const [cloudDemos, setCloudDemos] = useState(null);
  const [teamDemos, setTeamDemos] = useState(null);
  useEffect(() => {
    listDemos().then(setLocal, () => setLocal([]));
    api('/api/history?limit=50').then((r) => setCloud(r.ok ? (r.data.matches || []) : []), () => setCloud([]));
    api('/api/cloud/demos').then((r) => setCloudDemos(r.ok ? (r.data.demos || []) : []), () => setCloudDemos([]));
    api('/api/team-demos').then((r) => setTeamDemos(r.ok ? (r.data.demos || []) : []), () => setTeamDemos([]));
  }, []);
  const remove = async (id) => { await deleteDemo(id); setLocal((rows) => (rows || []).filter((d) => d.id !== id)); };
  return html`<${Modal} open=${true} title=${t('历史战绩 / Demo')} micro="LOCAL DEMOS" onClose=${onClose}>
    <div class="cloud">
      <p class="cloud__note">${t('Demo 存在这台设备的浏览器里（IndexedDB），播放也在本机完成；登录后最新 10 局会备份到账号，换设备能下载播放。')}</p>
      <h4 class="cloud__h">${t('本机 Demo')}</h4>
      ${local == null ? html`<p class="cloud__note">${t('读取中…')}</p>`
        : local.length === 0 ? html`<p class="cloud__note">${t('还没有本机 Demo：对局会自动记录每一步操作与棋盘帧，第一个回合都没清完就退出的除外。')}</p>`
          : html`<ul class="cloud__list">${local.map((d) => html`<li key=${d.id}>
              <span class="cloud__when">${dateOf(d.startedAt)}</span>
              <span>${t('{mode} · {diff} · {n} 步', { mode: d.mode || '', diff: d.difficulty || '', n: (d.events || []).length })}</span>
              <${Button} size="sm" variant="primary" onClick=${() => openDemo(d)}>${t('播放')}<//>
              <${Button} size="sm" variant="ghost" onClick=${() => remove(d.id)}>${t('删除')}<//>
            </li>`)}</ul>`}
      <h4 class="cloud__h">${t('联机合并 Demo')}</h4>
      ${teamDemos == null ? html`<p class="cloud__note">${t('读取中…')}</p>`
        : teamDemos.length === 0 ? html`<p class="cloud__note">${t('还没有联机合并 Demo：四人局结算后每人自动上传自己的视角，服务端按 matchId 合并。')}</p>`
          : html`<ul class="cloud__list">${teamDemos.map((d) => html`<li key=${`team_${d.id}`}>
              <span class="cloud__when">${dateOf(d.createdAt)}</span>
              <span>${t('联机 · {n} 个视角', { n: (d.availableFields || []).length })}${d.partial ? t(' · 部分视角') : ''}</span>
              <${Button} size="sm" variant="ghost" onClick=${async () => { const doc = await downloadDemo(`team_${d.id}`); if (doc) openDemo(doc); }}>${t('下载并播放')}<//>
            </li>`)}</ul>`}
      <h4 class="cloud__h">${t('云端 Demo（最新 10 局）')}</h4>
      ${cloudDemos == null ? html`<p class="cloud__note">${t('读取中…')}</p>`
        : cloudDemos.length === 0 ? html`<p class="cloud__note">${t('云端还没有 Demo。')}</p>`
          : html`<ul class="cloud__list">${cloudDemos.map((d) => html`<li key=${d.id}>
              <span class="cloud__when">${dateOf(d.startedAt)}</span>
              <span>${t('{mode} · {diff} · {n} 步', { mode: d.mode || '', diff: d.difficulty || '', n: d.events })}</span>
              <${Button} size="sm" variant="ghost" onClick=${async () => { const doc = await downloadDemo(d.id); if (doc) openDemo(doc); }}>${t('下载并播放')}<//>
            </li>`)}</ul>`}
      <h4 class="cloud__h">${t('云端战绩（账号）')}</h4>
      ${cloud == null ? html`<p class="cloud__note">${t('读取中…')}</p>`
        : cloud.length === 0 ? html`<p class="cloud__note">${t('还没有云端战绩：完成一局并绑定账号后会自动记录。')}</p>`
          : html`<ul class="cloud__list">${cloud.map((m) => html`<li key=${m.id}>
              <span class="cloud__when">${dateOf(m.endedAt)}</span>
              <span>${m.mode || ''} · ${m.difficulty || ''} ${m.result || ''}</span>
            </li>`)}</ul>`}
    </div>
  <//>`;
}

function DemoPlayer({ doc, onClose }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const events = doc?.events || [];
  const snaps = doc?.snapshots || [];
  useEffect(() => {
    if (!playing) return undefined;
    if (idx >= events.length - 1) { setPlaying(false); return undefined; }
    const gap = Math.min(2000, Math.max(60, (events[idx + 1]?.at || 0) - (events[idx]?.at || 0)));
    const timer = setTimeout(() => setIdx((i) => i + 1), gap);
    return () => clearTimeout(timer);
  }, [playing, idx, events]);
  const ev = events[idx];
  const snap = (() => {
    const at = ev?.at || 0;
    let cur = null;
    for (const f of snaps) { if ((f.at || 0) <= at) cur = f; else break; }
    return cur || snaps[0] || null;
  })();
  return html`<${Modal} open=${true} title=${t('Demo 回放')} micro=${doc ? t('{n} 动作 · {n2} 帧', { n: events.length, n2: snaps.length }) : 'DEMO'} onClose=${onClose}>
    <div class="cloud">
      ${events.length === 0 ? html`<p class="cloud__note">${t('这一局没有记录到动作。')}</p>` : html`
        <div class="cloud__row">
          <${Button} size="sm" variant="secondary" disabled=${!idx} onClick=${() => setIdx(0)}>${t('开头')}<//>
          <${Button} size="sm" variant="secondary" disabled=${!idx} onClick=${() => setIdx((i) => Math.max(0, i - 1))}>${t('上一步')}<//>
          <${Button} size="sm" variant="primary" onClick=${() => setPlaying((p) => !p)}>${playing ? t('暂停') : t('播放')}<//>
          <${Button} size="sm" variant="ghost" disabled=${idx >= events.length - 1} onClick=${() => setIdx((i) => Math.min(events.length - 1, i + 1))}>${t('下一步')}<//>
        </div>
        <p class="cloud__note">${t('第 {i} / {n} 步 · {sec}s', { i: idx + 1, n: events.length, sec: ((ev?.at || 0) / 1000).toFixed(1) })}</p>
        ${snap ? html`<div class="cloud__board">
          <div class="cloud__board-head">${t('第 {round} 回合 · 阶段 {phase}', { round: snap.round ?? '-', phase: snap.phase ?? '-' })}${snap.teamLp != null ? t(' · 队伍 LP {lp}', { lp: snap.teamLp }) : ''}</div>
          <div class="cloud__seats">${(snap.players || []).map((p) => html`<div key=${p.seat} class="cloud__seat ${p.alive ? '' : 'cloud__seat--dead'}">
            <b>${p.name}</b><span>LP ${p.lp}</span><span>${t('商店 {lvl}', { lvl: p.shopLevel })}</span><span>${t('场上 {n}', { n: p.boardCount })}</span><span>${p.status}</span>
          </div>`)}</div>
        </div>` : html`<p class="cloud__note">${t('这一局没有录制到棋盘帧，仅能看操作时间轴。')}</p>`}
        <pre class="cloud__event">${ev ? `${ev.a?.t || ''}\n${JSON.stringify(ev.a, null, 2)}` : ''}</pre>
      `}
    </div>
  <//>`;
}

// ---- entry points ----------------------------------------------------------------------------------------------------
function ensureStyle() {
  if (document.getElementById('cloud-acct-style')) return;
  const st = document.createElement('style');
  st.id = 'cloud-acct-style';
  st.textContent = `
.cloud{display:flex;flex-direction:column;gap:.16rem;min-width:min(9rem,86vw)}
.cloud__label{display:flex;align-items:baseline;gap:.06rem;font-size:.18rem;font-weight:800;opacity:.8}
.cloud__opt{font-weight:600;font-size:.14rem;opacity:.6}
.cloud__input{font:inherit;font-size:.22rem;padding:.1rem .14rem;border-radius:.1rem;border:1px solid rgba(127,127,127,.45);background:rgba(0,0,0,.18);color:inherit}
.cloud__input--code{letter-spacing:.12em;font-variant-numeric:tabular-nums}
.cloud__row{display:flex;flex-wrap:wrap;gap:.1rem}
.cloud__note{margin:0;font-size:.17rem;line-height:1.55;opacity:.75}
.cloud__warn{margin:0;font-size:.17rem;line-height:1.55;color:#ff9b8a}
.cloud__who{line-height:1.6}
.cloud__h{margin:.18rem 0 0;font-size:.19rem;font-weight:900;letter-spacing:.02em}
.cloud__list{margin:0;padding-left:.3rem;display:flex;flex-direction:column;gap:.1rem;font-size:.18rem}
.cloud__list li{display:flex;align-items:center;gap:.12rem;flex-wrap:wrap}
.cloud__when{opacity:.7;font-variant-numeric:tabular-nums}
.cloud__event{max-height:2.4rem;overflow:auto;font-size:.17rem;line-height:1.5;background:rgba(0,0,0,.22);padding:.12rem;border-radius:.1rem;white-space:pre-wrap}
.cloud-ts{margin:.08rem 0}
.cloud__board{display:flex;flex-direction:column;gap:.08rem;background:rgba(0,0,0,.18);border-radius:.1rem;padding:.12rem}
.cloud__board-head{font-size:.17rem;font-weight:800;opacity:.85}
.cloud__seats{display:grid;grid-template-columns:repeat(auto-fit,minmax(1.6rem,1fr));gap:.08rem}
.cloud__seat{display:flex;flex-direction:column;gap:.03rem;font-size:.16rem;line-height:1.35;border:1px solid rgba(127,127,127,.35);border-radius:.08rem;padding:.08rem}
.cloud__seat b{font-size:.17rem}
.cloud__seat--dead{opacity:.45;filter:grayscale(1)}
`;
  document.head.appendChild(st);
}

let host = null;
function mount() {
  ensureStyle();
  if (!host) { host = document.createElement('div'); host.className = 'cloud-acct-host'; document.body.appendChild(host); }
  const close = () => render(null, host);
  return { host, close };
}

/**
 * 打开登录框；成功后 `onDone(account, linked)`。
 * `panel: false` 用于「登录后直接进入游戏」这类流程——不再自动弹出账号面板。
 */
export async function openLogin(onDone, { panel = true } = {}) {
  const { host: h, close } = mount();
  render(html`<${LoginPanel} onClose=${() => { close(); }} onDone=${(account, linked) => {
    close();
    onDone?.(account, linked);
    if (account && panel) openAccountPanel(account);
  }} />`, h);
}

/** 打开账号面板（已登录时）。 */
export function openAccountPanel(account) {
  const { host: h, close } = mount();
  const refresh = (next) => {
    close();
    if (next) openAccountPanel(next); else openLogin();
  };
  render(html`<${AccountPanel} account=${account} onClose=${close} onRefresh=${refresh} />`, h);
}

/** 标题页 / 设置里的入口：未登录 → 登录框；已登录 → 面板。 */
export async function openCloudAccount() {
  const account = await me();
  if (account) openAccountPanel(account); else openLogin();
}

/**
 * 播放一局 Demo（统计数据页的对局记录里点「播放」时用）：文档来自本机 IndexedDB 或云端下载。
 * 不经过账号 / 登录，纯本机回放。
 * @param {any} doc public/js/demoRecorder.js 的文档
 */
export async function openDemo(doc) {
  if (!doc) return;
  // 有 wire 流（m.* / b.* 原始帧）→ 游戏内可视化回放；旧文档退回文字时间轴
  const replay = await import('../demoReplay.js').catch(() => null);
  if (replay?.canReplayVisual?.(doc) && replay.startDemoReplay(doc)) return;
  const { host: h, close } = mount();
  render(html`<${DemoPlayer} doc=${doc} onClose=${() => close()} />`, h);
}

/** Demo 库（本机 + 云端 + 云端战绩）：账号面板里同一块内容，单独打开。 */
export function openDemoLibrary() {
  const { host: h, close } = mount();
  render(html`<${HistoryPanel} onClose=${() => close()} />`, h);
}

/** 服务器是否提供账号功能（标题页据此决定是否显示入口）。 */
export async function accountsAvailable() {
  const cfg = await cloudConfig();
  return !!cfg?.accounts;
}
