// community/public/js/main.js — app bootstrap + a tiny hash-free router.
//
// Routes:
//   /               前台 · 服务器列表
//   /admin          后台 · 登录（未登录时）/ 服务器管理（已登录）
//   /admin/accounts 后台 · 账号管理
//
// The server boots the SPA shell for any extension-less path, so a hard refresh on /admin works.

import { render, h } from '/vendor/preact.module.js';
import { useEffect, useState, useCallback } from '/vendor/hooks.module.js';
import { html, ToastHost } from './ui.js';
import { api } from './api.js';
import { ServerList } from './views/server-list.js';
import { AdminLogin } from './views/admin-login.js';
import { AdminServers } from './views/admin-servers.js';
import { AdminAccounts } from './views/admin-accounts.js';

const App = () => {
  const [route, setRoute] = useState(() => window.location.pathname);
  const [ctx, setCtx] = useState(null);   // { site, regions, account, isAdmin }
  const [ready, setReady] = useState(false);

  const navigate = useCallback((to, { replace = false } = {}) => {
    if (replace) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);
    setRoute(to);
    window.scrollTo(0, 0);
  }, []);

  const refreshSession = useCallback(async () => {
    const data = await api.bootstrap();
    setCtx(data);
    return data;
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onPop);
    refreshSession().finally(() => setReady(true));
    return () => window.removeEventListener('popstate', onPop);
  }, [refreshSession]);

  if (!ready) {
    return html`<div class="state"><div class="state__hex"></div><div class="state__big">正在载入…</div></div>`;
  }

  const path = route.replace(/\/+$/, '') || '/';
  let view;
  if (path === '/') {
    view = html`<${ServerList} ctx=${ctx} onNavigate=${navigate} onSession=${refreshSession} />`;
  } else if (path === '/admin' || path === '/admin/') {
    view = ctx.isAdmin
      ? html`<${AdminServers} ctx=${ctx} onNavigate=${navigate} onSession=${refreshSession} />`
      : html`<${AdminLogin} ctx=${ctx} onNavigate=${navigate} onSession=${refreshSession} />`;
  } else if (path === '/admin/accounts') {
    view = ctx.isAdmin
      ? html`<${AdminAccounts} ctx=${ctx} onNavigate=${navigate} onSession=${refreshSession} />`
      : html`<${AdminLogin} ctx=${ctx} onNavigate=${navigate} onSession=${refreshSession} />`;
  } else {
    view = html`<div class="wrap"><div class="state"><div class="state__big">页面不存在</div><p>返回 <a href="/" style="color:var(--mint-500)">服务器列表</a></p></div></div>`;
  }

  return html`<${ToastHost} />${view}`;
};

render(h(App), document.getElementById('app'));
// 告诉 js/boot-guard.js 模块图确实跑起来了（它只在 8 秒内一直没渲染时才在页面上报警）。
document.documentElement.dataset.appReady = '1';
