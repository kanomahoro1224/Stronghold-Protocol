// community/public/js/views/server-list.js — 前台 · 服务器列表页.
// Mirrors the Ardot draft: nav (服务器 / 下载[hidden] / 关于), hero stats, region filters, node cards with the
// FULL healthz JSON panel, and a 「进入服务器」 jump button on each card.

import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import {
  html, BrandMark, IconServer, IconUsers, IconShield, IconGlobe, IconRefresh, IconCaret, IconArrow, JsonBlock,
  formatUptime, toast,
} from '../ui.js';

const POLL_MS = 15000;
const TABS = [{ id: 'servers', label: '服务器' }, { id: 'downloads', label: '下载', hidden: true }, { id: 'about', label: '关于' }];

/** Derive the headline numbers for the hero from the probed list. */
function summarize(servers) {
  let online = 0, humans = 0, matches = 0;
  const regions = new Set();
  for (const s of servers) {
    if (s.health?.ok) {
      online += 1;
      humans += Number(s.health.raw?.humans) || 0;
      matches += Number(s.health.raw?.matches) || 0;
    }
    if (s.health?.ok) regions.add(s.region);
  }
  return { total: servers.length, online, humans, matches, regions: regions.size };
}

const StatusView = ({ health }) => {
  if (!health) return html`<div class="card__status"><span class="card__status-main t-dim">探测中…</span></div>`;
  if (health.ok) {
    return html`<div class="card__status">
      <span class="card__status-main t-mint">运行正常</span>
      <span class="card__status-sub">${health.latencyMs} ms</span>
    </div>`;
  }
  return html`<div class="card__status">
    <span class="card__status-main t-red">离线无响应</span>
    <span class="card__status-sub">${health.error || '不可达'}</span>
  </div>`;
};

const ServerCard = ({ server }) => {
  const [open, setOpen] = useState(false);
  const h = server.health;
  const raw = h?.raw;
  const online = !!h?.ok;
  const metrics = raw ? [
    ['HUMANS', raw.humans], ['ROOMS', raw.rooms], ['MATCHES', raw.matches],
    ['SOCKETS', raw.sockets], ['SESSIONS', raw.sessions], ['UPTIME', formatUptime(raw.uptimeSec)], ['RSS', `${raw.mem?.rss ?? '–'}MB`],
  ] : [];

  return html`
    <article class=${`card ${online ? 'is-online' : 'is-offline'}`}>
      <div class="card__main">
        <div class="card__id">
          <span class=${`card__dot ${online ? 'is-online' : 'is-offline'}`}></span>
          <div class="card__names">
            <div class="card__name">${server.name}</div>
            <div class="card__addr">${server.address}</div>
          </div>
        </div>

        <div class="card__tags">
          <span class=${`tag tag--${server.region}`}>${server.regionLabel}</span>
          ${raw ? html`<span class="tag tag--muted">v${raw.app || raw.version || '?'}</span>` : null}
        </div>

        <${StatusView} health=${h} />

        ${metrics.length ? html`<div class="card__metrics">
          ${metrics.map(([k, v]) => html`<div class="metric" key=${k}><span class="metric__v">${v ?? '–'}</span><span class="metric__k">${k}</span></div>`)}
        </div>` : html`<div class="card__metrics"></div>`}

        <div class="card__actions">
          ${online
            ? html`<a class="btn btn--primary btn--sm" href=${server.address} target="_blank" rel="noopener noreferrer">
                <span class="btn__icon"><${IconArrow} size=${14} /></span>进入服务器
              </a>`
            : html`<button class="btn btn--sm" disabled>不可用</button>`}
        </div>
      </div>

      ${raw ? html`<div class="card__expand">
        <div class=${`card__expand-head`} onClick=${() => setOpen((o) => !o)} role="button" tabindex="0"
             onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}>
          <span class="card__expand-title">HEALTHZ · 原始数据（全量）</span>
          <span class="toolbar__meta">${Object.keys(raw).length} 个字段</span>
          <span class=${`card__expand-caret ${open ? 'is-open' : ''}`}><${IconCaret} size=${18} /></span>
        </div>
        ${open ? html`<div class="json"><${JsonBlock} value=${raw} /></div>` : null}
      </div>` : null}
    </article>`;
};

export function ServerList({ ctx, onNavigate, onSession }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [region, setRegion] = useState('all');
  const [tab, setTab] = useState('servers');
  const timer = useRef(null);

  const load = useCallback(async (initial = false) => {
    if (!initial) setRefreshing(true);
    try {
      const { servers: list } = await api.listServers({ probe: true });
      setServers(list);
    } catch (e) {
      if (initial) toast.err(e.message || '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(true);
    timer.current = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(timer.current);
  }, [load]);

  const regions = ctx.regions || [];
  const filtered = useMemo(
    () => (region === 'all' ? servers : servers.filter((s) => s.region === region)),
    [servers, region],
  );
  const stats = useMemo(() => summarize(servers), [servers]);

  const doLogout = async () => { await api.logout(); await onSession(); toast.ok('已退出登录'); };

  return html`
    <div class="page">
      <header class="nav">
        <div class="wrap nav__in">
          <a class="brand" href="/" onClick=${(e) => { e.preventDefault(); onNavigate('/'); }}>
            <${BrandMark} size=${30} />
            <span class="brand__txt">
              <span class="brand__name">${ctx.site?.name || '卫戍协议'}</span>
              <span class="brand__sub">Community</span>
            </span>
          </a>

          <nav class="tabs">
            ${TABS.filter((t) => !t.hidden).map((t) => html`
              <button key=${t.id} class=${`tab ${tab === t.id ? 'is-active' : ''}`} onClick=${() => setTab(t.id)}>${t.label}</button>`)}
          </nav>

          <div class="nav__spacer"></div>

          <div class="nav__right">
            ${ctx.account
              ? html`<span class="chip"><span class="chip__dot is-on"></span>${ctx.account.displayName}</span>`
              : html`<span class="chip"><span class="chip__dot"></span>游客</span>`}
            ${ctx.isAdmin
              ? html`<button class="btn btn--sm" onClick=${() => onNavigate('/admin')}>管理控制台</button>
                     <button class="btn btn--ghost btn--sm" onClick=${doLogout}>退出</button>`
              : html`<button class="btn btn--sm" onClick=${() => onNavigate('/admin')}>
                       <span class="btn__icon"><${IconShield} size=${14} /></span>管理入口
                     </button>`}
          </div>
        </div>
      </header>

      <main class="wrap">
        ${tab === 'about' ? html`
          <section class="hero">
            <div class="hero__title">关于本站</div>
            <p class="hero__desc" style="margin-top:16px">
              这是《卫戍协议》的社区服务器聚合站，用于汇总公开的联机节点。列表页实时探测各节点的
              <code style="color:var(--mint-500)">/healthz</code> 状态，并完整展示其原始数据。
              本站关闭自助注册，账号仅能由管理员在后台创建。
            </p>
          </section>` : html`
          <section class="hero">
            <div class="hero__head">
              <div>
                <div class="micro t-mint" style="margin-bottom:10px">SERVER DIRECTORY</div>
                <h1 class="hero__title">服务器列表</h1>
                <p class="hero__desc">实时探测各公开联机节点的运行状态，数据每 ${POLL_MS / 1000} 秒自动刷新。</p>
              </div>
              <div class="hero__actions">
                <button class="btn btn--primary" onClick=${() => load(false)} disabled=${refreshing}>
                  <span class="btn__icon"><${IconRefresh} size=${15} /></span>${refreshing ? '刷新中…' : '刷新状态'}
                </button>
              </div>
            </div>

            <div class="stats">
              <div class="stat stat--mint">
                <div class="stat__icon"><${IconServer} size=${22} /></div>
                <div><div class="stat__val">${stats.online}<span style="font-size:18px;color:var(--text-dim)"> / ${stats.total}</span></div><div class="stat__label">在线节点</div></div>
              </div>
              <div class="stat stat--ice">
                <div class="stat__icon"><${IconUsers} size=${22} /></div>
                <div><div class="stat__val">${stats.humans.toLocaleString()}</div><div class="stat__label">在线玩家</div></div>
              </div>
              <div class="stat stat--gold">
                <div class="stat__icon"><${IconShield} size=${22} /></div>
                <div><div class="stat__val">${stats.matches.toLocaleString()}</div><div class="stat__label">进行中对局</div></div>
              </div>
              <div class="stat stat--mint">
                <div class="stat__icon"><${IconGlobe} size=${22} /></div>
                <div><div class="stat__val">${stats.regions}</div><div class="stat__label">可用大区</div></div>
              </div>
            </div>
          </section>

          <div class="toolbar">
            <div class="filters">
              <button class=${`filter ${region === 'all' ? 'is-active' : ''}`} onClick=${() => setRegion('all')}>全部区域</button>
              ${regions.map((r) => html`<button key=${r.value} class=${`filter ${region === r.value ? 'is-active' : ''}`} onClick=${() => setRegion(r.value)}>${r.label}</button>`)}
            </div>
            <div class="toolbar__spacer"></div>
            <div class="toolbar__meta">共 ${filtered.length} 个节点</div>
          </div>

          ${loading
            ? html`<div class="state"><div class="state__hex"></div><div class="state__big">正在探测服务器状态…</div></div>`
            : filtered.length === 0
              ? html`<div class="state"><div class="state__big">该区域暂无服务器</div><p>换一个区域试试，或等待管理员添加。</p></div>`
              : html`<div class="cards">${filtered.map((s) => html`<${ServerCard} key=${s.id} server=${s} />`)}</div>`}
        `}
      </main>

      <footer class="foot">
        <div class="wrap foot__in">
          <span>《卫戍协议》非官方同人项目 · 社区聚合站</span>
          <span>账号仅限管理员创建 · 本站不提供自助注册</span>
        </div>
      </footer>
    </div>`;
}
