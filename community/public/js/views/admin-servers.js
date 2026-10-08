// community/public/js/views/admin-servers.js — 后台 · 服务器管理控制台.
// Table CRUD over /api/servers, mirroring the draft: stat cards, table (名称/地址/区域/实时状态/操作), 添加服务器 modal.
import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { html, Modal, Field, toast, IconPlus, IconServer, IconOff, IconGlobe, relativeTime } from '../ui.js';
import { AdminShell } from './admin-shell.js';

const emptyForm = { name: '', address: '', region: 'asia', note: '' };

function ServerModal({ server, regions, onClose, onSaved }) {
  const [form, setForm] = useState(server
    ? { name: server.name, address: server.address, region: server.region, note: server.note || '' }
    : emptyForm);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }));

  const save = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      if (server) await api.updateServer(server.id, form);
      else await api.createServer(form);
      toast.ok(server ? '已保存修改' : '服务器已添加');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally { setBusy(false); }
  };

  return html`
    <${Modal}
      micro=${server ? 'EDIT SERVER' : 'ADD SERVER'}
      title=${server ? '编辑服务器' : '添加服务器'}
      onClose=${onClose}
      footer=${html`
        <button class="btn" onClick=${onClose} type="button">取消</button>
        <button class="btn btn--primary" form="server-form" type="submit" disabled=${busy}>${busy ? '保存中…' : (server ? '保存修改' : '添加服务器')}</button>`}>
      <form id="server-form" onSubmit=${save} style="display:contents">
        ${error ? html`<div class="notice notice--red">${error}</div>` : null}
        <${Field} label="服务器名称">
          <input class="input" placeholder="如：前线节点 · 华东二线" value=${form.name} onInput=${set('name')} required maxlength="40" />
        </${Field}>
        <${Field} label="服务器地址" hint="形如 https://t44.kafuno.cn:34046/ —— 系统会自动探测其 /healthz 接口">
          <input class="input" placeholder="https://example.com:34046/" value=${form.address} onInput=${set('address')} required />
        </${Field}>
        <${Field} label="服务器区域">
          <select class="input" value=${form.region} onChange=${set('region')}>
            ${regions.map((r) => html`<option key=${r.value} value=${r.value}>${r.label}</option>`)}
          </select>
        </${Field}>
        <${Field} label="备注（可选）">
          <input class="input" placeholder="如：官方主节点 / 测试服" value=${form.note} onInput=${set('note')} maxlength="120" />
        </${Field}>
      </form>
    </${Modal}>`;
}

const StatusCell = ({ health }) => {
  if (!health) return html`<span class="cell-status"><span class="cell-status__main t-dim">探测中…</span></span>`;
  if (health.ok) return html`<span class="cell-status"><span class="cell-status__main t-mint">运行正常</span><span class="cell-status__sub">${health.latencyMs}ms</span></span>`;
  return html`<span class="cell-status"><span class="cell-status__main t-red">离线无响应</span><span class="cell-status__sub">--</span></span>`;
};

export function AdminServers({ ctx, onNavigate, onSession }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | { } | server object
  const [pending, setPending] = useState(null); // server pending delete confirm

  const load = useCallback(async () => {
    try {
      const { servers: list } = await api.listServers({ probe: true });
      setServers(list);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { await onSession(); onNavigate('/admin'); return; }
      toast.err(e.message || '加载失败');
    } finally { setLoading(false); }
  }, [onSession, onNavigate]);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const stats = useMemo(() => {
    const online = servers.filter((s) => s.health?.ok).length;
    return {
      total: servers.length,
      online,
      offline: servers.length - online,
      regions: new Set(servers.map((s) => s.region)).size,
    };
  }, [servers]);

  const remove = async (server) => {
    try {
      await api.deleteServer(server.id);
      toast.ok('已删除');
      setPending(null);
      load();
    } catch (e) { toast.err(e.message || '删除失败'); }
  };

  return html`
    <${AdminShell} ctx=${ctx} active="servers" onNavigate=${onNavigate} onSession=${onSession}
      micro="SERVER MANAGEMENT" title="服务器管理"
      actions=${html`<button class="btn btn--primary" onClick=${() => setEditing({})}>
        <span class="btn__icon"><${IconPlus} size=${15} /></span>添加服务器
      </button>`}>

      <div class="stats">
        <div class="stat stat--mint">
          <div class="stat__icon"><${IconServer} size=${22} /></div>
          <div><div class="stat__val">${stats.total}</div><div class="stat__label">服务器总数</div></div>
        </div>
        <div class="stat stat--mint" style="--stat-bg:var(--mint-900)">
          <div class="stat__icon"><${IconServer} size=${22} /></div>
          <div><div class="stat__val t-mint">${stats.online}</div><div class="stat__label">在线运行</div></div>
        </div>
        <div class="stat stat--red">
          <div class="stat__icon"><${IconOff} size=${22} /></div>
          <div><div class="stat__val t-red">${stats.offline}</div><div class="stat__label">离线 / 异常</div></div>
        </div>
        <div class="stat stat--ice">
          <div class="stat__icon"><${IconGlobe} size=${22} /></div>
          <div><div class="stat__val t-ice">${stats.regions}</div><div class="stat__label">覆盖大区</div></div>
        </div>
      </div>

      <div class="table">
        <div class="table__row table__head table__cols--servers">
          <div class="table__cell">服务器名称</div>
          <div class="table__cell">地址</div>
          <div class="table__cell">区域</div>
          <div class="table__cell">实时状态</div>
          <div class="table__cell" style="text-align:right">操作</div>
        </div>

        ${loading
          ? html`<div class="table__row table__cols--servers"><div class="table__cell" style="grid-column:1/-1;padding:40px 0;text-align:center;color:var(--text-dim)">载入中…</div></div>`
          : servers.length === 0
            ? html`<div class="table__row table__cols--servers"><div class="table__cell" style="grid-column:1/-1;padding:40px 0;text-align:center;color:var(--text-dim)">还没有服务器，点击右上角「添加服务器」</div></div>`
            : servers.map((s) => html`
              <div class="table__row table__cols--servers" key=${s.id}>
                <div class="table__cell cell-name">
                  <span class=${`cell-name__dot ${s.health?.ok ? '' : 'is-err'}`}></span>
                  <span class="cell-name__txt">${s.name}</span>
                </div>
                <div class="table__cell cell-mono" title=${s.address}>${s.address}</div>
                <div class="table__cell"><span class=${`tag tag--${s.region}`}>${s.regionLabel}</span></div>
                <div class="table__cell"><${StatusCell} health=${s.health} /></div>
                <div class="table__cell cell-actions">
                  <button class="btn btn--sm" onClick=${() => setEditing(s)}>编辑</button>
                  <button class="btn btn--danger-ghost btn--sm" onClick=${() => setPending(s)}>删除</button>
                </div>
              </div>`)}
      </div>

      ${editing ? html`<${ServerModal} server=${editing.id ? editing : null} regions=${ctx.regions} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); load(); }} />` : null}

      ${pending ? html`<${Modal} micro="CONFIRM" title="删除服务器" onClose=${() => setPending(null)}
        footer=${html`
          <button class="btn" onClick=${() => setPending(null)}>取消</button>
          <button class="btn btn--danger" onClick=${() => remove(pending)}>确认删除</button>`}>
        <div class="notice notice--red">确定要删除「${pending.name}」吗？该操作不可撤销。</div>
        <div class="cell-mono">${pending.address}</div>
      </${Modal}>` : null}
    </${AdminShell}>`;
}
