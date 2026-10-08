// community/public/js/views/admin-login.js — 后台 · 管理员登录页.
import { useState, useRef, useEffect } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { html, BrandMark, IconShield, toast } from '../ui.js';

export function AdminLogin({ ctx, onNavigate, onSession }) {
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstField = useRef(null);

  useEffect(() => { firstField.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.login(loginName.trim(), password);
      await onSession();
      toast.ok('登录成功');
      onNavigate('/admin', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="login">
      <form class="login__card" onSubmit=${submit}>
        <div class="login__accent"></div>
        <div class="login__body">
          <div class="login__emblem"><${BrandMark} size=${40} /></div>
          <div>
            <h1 class="login__title">管理员登录</h1>
            <div class="login__sub">Admin Console</div>
          </div>

          <div class="login__form">
            ${error ? html`<div class="login__err">${error}</div>` : null}

            <div class="field">
              <label class="field__label" for="login-name">账号</label>
              <input ref=${firstField} id="login-name" class="input" autocomplete="username" placeholder="登录名"
                     value=${loginName} onInput=${(e) => setLoginName(e.currentTarget.value)} required />
            </div>

            <div class="field">
              <label class="field__label" for="login-pass">密码</label>
              <input id="login-pass" class="input" type="password" autocomplete="current-password" placeholder="密码"
                     value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} required />
            </div>

            <label class="checkline">
              <input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.currentTarget.checked)} />
              记住登录状态
            </label>

            <button class="btn btn--primary btn--block" type="submit" disabled=${busy}>
              <span class="btn__icon"><${IconShield} size=${16} /></span>${busy ? '登录中…' : '登 录'}
            </button>

            <div class="login__note">
              <span class="login__note-icon"><${IconShield} size=${15} /></span>
              <span>本站关闭自助注册。账号只能由管理员在控制台中手动创建，请联系管理员获取登录凭证。</span>
            </div>
          </div>
        </div>
        <div class="login__foot">© ${new Date().getFullYear()} 卫戍协议社区 · 仅限授权管理员访问</div>
      </form>
    </div>`;
}
