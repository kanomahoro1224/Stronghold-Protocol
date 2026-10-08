// community/public/js/views/admin-shell.js — the console chrome (sidebar + main column) shared by both
// admin pages, so the two screens stay identical to the design draft.
import { html, BrandMark, IconServer, IconUser } from '../ui.js';
import { api } from '../api.js';

const NAV = [
  { id: 'servers', label: '服务器管理', path: '/admin', Icon: IconServer },
  { id: 'accounts', label: '账号管理', path: '/admin/accounts', Icon: IconUser },
  { id: 'downloads', label: '下载内容维护', path: null, Icon: null, badge: '未开放' },
];

export function AdminShell({ ctx, active, onNavigate, onSession, title, micro, actions, children }) {
  const logout = async () => {
    await api.logout();
    await onSession();
    onNavigate('/');
  };
  const initial = (ctx.account?.displayName || 'A').trim().charAt(0).toUpperCase();

  return html`
    <div class="console">
      <aside class="side">
        <div class="side__brand">
          <${BrandMark} size=${26} />
          <div class="brand__txt">
            <span class="brand__name" style="font-size:15px">${ctx.site?.name || '卫戍协议'}</span>
            <span class="brand__sub">控制台</span>
          </div>
        </div>

        <nav class="side__nav">
          ${NAV.map((item) => html`
            <button key=${item.id}
              class=${`side__item ${active === item.id ? 'is-active' : ''}`}
              disabled=${!item.path}
              onClick=${() => item.path && onNavigate(item.path)}>
              ${item.Icon ? html`<${item.Icon} size=${18} />` : html`<span style="width:18px"></span>`}
              <span>${item.label}</span>
              ${item.badge ? html`<span class="side__badge">${item.badge}</span>` : null}
            </button>`)}
        </nav>

        <div class="side__spacer"></div>

        <div class="side__user">
          <div class="side__avatar">${initial}</div>
          <div class="side__uinfo">
            <span class="side__uname">${ctx.account?.displayName}</span>
            <span class="side__urole">${ctx.account?.role === 'admin' ? '管理员' : '普通用户'}</span>
          </div>
          <button class="btn btn--ghost btn--sm" onClick=${logout} title="退出登录" style="margin-left:auto">退出</button>
        </div>
      </aside>

      <main class="main">
        <div class="main__head">
          <div class="main__title-group">
            <div class="micro t-mint">${micro}</div>
            <h1 class="main__title">${title}</h1>
          </div>
          <div style="display:flex;gap:10px">${actions}</div>
        </div>
        ${children}
      </main>
    </div>`;
}
