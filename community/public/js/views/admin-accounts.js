// community/public/js/views/admin-accounts.js — 后台 · 账号管理页.
// The ONLY place accounts can be created (self-registration is off). Mirrors the draft: stat cards,
// account table (账号名称/登录名/角色/状态/操作) and the 新建账号 modal with a plaintext-password notice.
import { useState, useEffect, useCallback, useMemo } from '/vendor/hooks.module.js';
import { api, ApiError } from '../api.js';
import { html, Modal, Field, toast, IconPlus, IconUsers, IconUser, IconShield, IconOff, relativeTime } from '../ui.js';
import { AdminShell } from './admin-shell.js';

function CreateAccountModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ displayName: '', loginName: '', password: '', role: 'user' });
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }));

  const save = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.createAccount(form);
      toast.ok('账号已创建');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally { setBusy(false); }
  };

  return html`
    <${Modal} micro="CREATE ACCOUNT" title="新建账号" onClose=${onClose}
      footer=${html`
        <button class="btn" onClick=${onClose} type="button">取消</button>
        <button class="btn btn--primary" form="acct-form" type="submit" disabled=${busy}>${busy ? '创建中…' : '创建账号'}</button>`}>
      <form id="acct-form" onSubmit=${save} style="display:contents">
        ${error ? html`<div class="notice notice--red">${error}</div>` : null}
        <${Field} label="账号名称">
          <input class="input" placeholder="如：前线指挥官 · Grayson" value=${form.displayName} onInput=${set('displayName')} required maxlength="40" />
        </${Field}>
        <${Field} label="登录名" hint="3–32 位字母、数字或 _ . @ -">
          <input class="input" placeholder="grayson" value=${form.loginName} onInput=${set('loginName')} required autocomplete="off" />
        </${Field}>
        <${Field} label="初始密码" hint="至少 8 位。创建后请安全地告知本人">
          <div class="input-wrap">
            <input class="input" type=${showPw ? 'text' : 'password'} placeholder="设置一个初始密码"
                   value=${form.password} onInput=${set('password')} required autocomplete="new-password" />
            <button type="button" class="input-wrap__btn" onClick=${() => setShowPw((v) => !v)}>${showPw ? '隐藏' : '显示'}</button>
          </div>
        </${Field}>
        <${Field} label="角色">
          <div class="role-pick">
            <button type="button" class=${`role-opt ${form.role === 'user' ? 'is-active' : ''}`} onClick=${() => setForm((f) => ({ ...f, role: 'user' }))}>
              <span class="role-opt__dot"></span>普通用户
            </button>
            <button type="button" class=${`role-opt ${form.role === 'admin' ? 'is-active' : ''}`} onClick=${() => setForm((f) => ({ ...f, role: 'admin' }))}>
              <span class="role-opt__dot"></span>管理员
            </button>
          </div>
        </${Field}>
        <div class="notice notice--amber">
          站点关闭自助注册。账号仅能由管理员在此手动创建，创建后请将初始密码安全地告知本人。
        </div>
      </form>
    </${Modal}>`;
}

function ResetPasswordModal({ account, onClose, onSaved }) {
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      await api.resetAccountPassword(account.id, password);
      toast.ok('密码已重置，该账号的登录状态已失效');
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : '重置失败'); }
    finally { setBusy(false); }
  };

  return html`
    <${Modal} micro="RESET PASSWORD" title="重置密码" onClose=${onClose}
      footer=${html`
        <button class="btn" onClick=${onClose} type="button">取消</button>
        <button class="btn btn--primary" form="pw-form" type="submit" disabled=${busy}>${busy ? '提交中…' : '确认重置'}</button>`}>
      <form id="pw-form" onSubmit=${save} style="display:contents">
        ${error ? html`<div class="notice notice--red">${error}</div>` : null}
        <div class="cell-mono">目标账号：${account.displayName}（${account.loginName}）</div>
        <${Field} label="新密码" hint="至少 8 位。重置后该账号需重新登录">
          <div class="input-wrap">
            <input class="input" type=${showPw ? 'text' : 'password'} placeholder="设置新密码"
                   value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} required autocomplete="new-password" />
            <button type="button" class="input-wrap__btn" onClick=${() => setShowPw((v) => !v)}>${showPw ? '隐藏' : '显示'}</button>
          </div>
        </${Field}>
      </form>
    </${Modal}>`;
}

export function AdminAccounts({ ctx, onNavigate, onSession }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(null);
  const [pending, setPending] = useState(null);

  const load = useCallback(async () => {
    try {
      const { accounts: list } = await api.listAccounts();
      setAccounts(list);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { await onSession(); onNavigate('/admin'); return; }
      toast.err(e.message || '加载失败');
    } finally { setLoading(false); }
  }, [onSession, onNavigate]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => ({
    total: accounts.length,
    active: accounts.filter((a) => !a.disabled).length,
    disabled: accounts.filter((a) => a.disabled).length,
    admins: accounts.filter((a) => a.role === 'admin').length,
  }), [accounts]);

  const toggleDisabled = async (account) => {
    try {
      await api.updateAccount(account.id, { disabled: !account.disabled });
      toast.ok(account.disabled ? '账号已启用' : '账号已停用');
      load();
    } catch (e) { toast.err(e.message || '操作失败'); }
  };

  const remove = async (account) => {
    try {
      await api.deleteAccount(account.id);
      toast.ok('账号已删除');
      setPending(null);
      load();
    } catch (e) { toast.err(e.message || '删除失败'); }
  };

  return html`
    <${AdminShell} ctx=${ctx} active="accounts" onNavigate=${onNavigate} onSession=${onSession}
      micro="ACCOUNT CONTROL" title="账号管理"
      actions=${html`<button class="btn btn--primary" onClick=${() => setCreating(true)}>
        <span class="btn__icon"><${IconPlus} size=${15} /></span>新建账号
      </button>`}>

      <div class="main__stats">
        <div class="stat stat--mint">
          <div class="stat__icon"><${IconUsers} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.total}</span><span class="stat__label">账号总数</span></div>
        </div>
        <div class="stat stat--mint">
          <div class="stat__icon"><${IconUser} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.active}</span><span class="stat__label">可登录账号</span></div>
        </div>
        <div class="stat stat--gold">
          <div class="stat__icon"><${IconOff} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.disabled}</span><span class="stat__label">已停用</span></div>
        </div>
        <div class="stat stat--ice">
          <div class="stat__icon"><${IconShield} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.admins}</span><span class="stat__label">管理员账号</span></div>
        </div>
      </div>

      <div class="table">
        <div class="table__row table__head table__cols--accounts">
          <div class="table__cell">账号名称</div>
          <div class="table__cell">登录名</div>
          <div class="table__cell">角色</div>
          <div class="table__cell">状态</div>
          <div class="table__cell" style="text-align:right">操作</div>
        </div>

        ${loading
          ? html`<div class="table__row table__cols--accounts"><div class="table__cell" style="grid-column:1/-1;padding:40px 0;text-align:center;color:var(--text-dim)">载入中…</div></div>`
          : accounts.length === 0
            ? html`<div class="table__row table__cols--accounts"><div class="table__cell" style="grid-column:1/-1;padding:40px 0;text-align:center;color:var(--text-dim)">还没有账号</div></div>`
            : accounts.map((a) => html`
              <div class="table__row table__cols--accounts" key=${a.id}>
                <div class="table__cell cell-name">
                  <span class=${`cell-name__dot ${a.disabled ? 'is-offline' : ''}`}></span>
                  <span class="cell-name__txt" style=${a.disabled ? 'color:var(--text-lo)' : ''}>${a.displayName}</span>
                </div>
                <div class="table__cell cell-mono">${a.loginName}</div>
                <div class="table__cell">
                  <span class=${`tag ${a.role === 'admin' ? 'tag--role' : 'tag--muted'}`}>${a.role === 'admin' ? '管理员' : '普通用户'}</span>
                </div>
                <div class="table__cell">
                  <span class="cell-status">
                    <span class=${`cell-status__main ${a.disabled ? 't-lo' : 't-mint'}`}>${a.disabled ? '已停用' : '启用中'}</span>
                    <span class="cell-status__sub">${relativeTime(a.lastLoginAt)}</span>
                  </span>
                </div>
                <div class="table__cell cell-actions">
                  <button class="btn btn--sm" onClick=${() => setResetting(a)}>重置密码</button>
                  <button class="btn btn--sm" onClick=${() => toggleDisabled(a)}>${a.disabled ? '启用' : '停用'}</button>
                  <button class="btn btn--danger-ghost btn--sm" onClick=${() => setPending(a)}>删除</button>
                </div>
              </div>`)}
      </div>

      ${creating ? html`<${CreateAccountModal} onClose=${() => setCreating(false)} onSaved=${() => { setCreating(false); load(); }} />` : null}
      ${resetting ? html`<${ResetPasswordModal} account=${resetting} onClose=${() => setResetting(null)} onSaved=${() => setResetting(null)} />` : null}
      ${pending ? html`<${Modal} micro="CONFIRM" title="删除账号" onClose=${() => setPending(null)}
        footer=${html`
          <button class="btn" onClick=${() => setPending(null)}>取消</button>
          <button class="btn btn--danger" onClick=${() => remove(pending)}>确认删除</button>`}>
        <div class="notice notice--red">确定要删除账号「${pending.displayName}」吗？该操作不可撤销，其登录状态会立即失效。</div>
      </${Modal}>` : null}
    </${AdminShell}>`;
}
