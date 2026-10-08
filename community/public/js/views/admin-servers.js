// community/public/js/views/admin-servers.js — 后台 · 服务器管理控制台.
// Table CRUD over /api/servers, mirroring the draft: stat cards, table (名称/地址/区域/实时状态/操作), 添加服务器 modal.
import { useState, useEffect, useCallback, useMemo, useRef } from '/vendor/hooks.module.js';
import { api, ApiError } from '../api.js';
import { measureAll } from '../latency.js';
import { html, Modal, Field, toast, IconPlus, IconServer, IconOff, IconGlobe, relativeTime } from '../ui.js';
import { AdminShell } from './admin-shell.js';

const emptyForm = { name: '', address: '', probeAddress: '', region: 'asia', note: '' };

function ServerModal({ server, regions, onClose, onSaved }) {
  const [form, setForm] = useState(server
    ? { name: server.name, address: server.address, probeAddress: server.probeAddress || '', region: server.region, note: server.note || '' }
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
        <${Field} label="服务器地址" hint="形如 https://t44.kafuno.cn:34046/ —— 玩家点「进入服务器」用它，浏览器测速也用它">
          <input class="input" placeholder="https://example.com:34046/" value=${form.address} onInput=${set('address')} required />
        </${Field}>
        <${Field} label="实际探测地址（可选）"
          hint="留空＝就探测上面的服务器地址。只有当社区服务器连不上公开地址时才需要填这里（例如 DNS 从社区服务器解析到连不通的 IP），填社区服务器能直连的地址，如 https://1.2.3.4:34046/">
          <input class="input" placeholder="留空则用服务器地址" value=${form.probeAddress} onInput=${set('probeAddress')} />
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

const StatusCell = ({ health, clientMs, measuring }) => {
  if (!health) return html`<span class="cell-status cell-status--stack"><span class="cell-status__main t-dim">探测中…</span></span>`;
  const localOk = clientMs != null;
  // 这一列把**两侧**分开写：服务端探到的结果，和这个浏览器自己实测的结果。判定口径与前台一致 ——
  // 只要有一侧连得上就是可用（管理员不会因为社区服务器出口不通就误删一个玩家能进的节点）。
  return html`<span class="cell-status cell-status--stack">
    <span class="cell-status__row" title="自社区服务器发起的探测（节点列表里的公开地址）">
      <span class="cell-status__k">服务端</span>
      <span class=${`cell-status__main ${health.ok ? 't-mint' : 't-red'}`}>${health.ok ? '运行正常' : '不可达'}</span>
      <span class="cell-status__sub">${health.ok ? `${health.latencyMs}ms` : (health.error || '--')}</span>
    </span>
    <span class="cell-status__row" title="由你这个浏览器实测到该节点的往返时间">
      <span class="cell-status__k">本机</span>
      <span class=${`cell-status__main ${localOk ? 't-mint' : 't-dim'}`}>${measuring ? '测速中…' : localOk ? `${Math.round(clientMs)} ms` : '未测到'}</span>
      ${!health.ok && localOk ? html`<span class="cell-status__sub t-amber">节点可用</span>` : null}
    </span>
  </span>`;
};

export function AdminServers({ ctx, onNavigate, onSession }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | { } | server object
  const [pending, setPending] = useState(null); // server pending delete confirm
  const [latency, setLatency] = useState({});
  const [measuring, setMeasuring] = useState(false);
  const serversRef = useRef([]);

  const load = useCallback(async () => {
    try {
      const { servers: list } = await api.listServers({ probe: true });
      serversRef.current = list;
      setServers(list);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { await onSession(); onNavigate('/admin'); return; }
      toast.err(e.message || '加载失败');
    } finally { setLoading(false); }
  }, [onSession, onNavigate]);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  /** 后台也量一次本机延迟：管理员看到的「不可达」只代表社区服务器那一侧。 */
  const measureNow = useCallback(async () => {
    const list = serversRef.current;
    if (!list.length) return;
    setMeasuring(true);
    try {
      // 注意：state 更新函数必须是同步的，await 要在外面先取好。
      const result = await measureAll(list);
      setLatency((prev) => ({ ...prev, ...result }));
    } finally { setMeasuring(false); }
  }, []);

  useEffect(() => { const t = setInterval(measureNow, 30000); return () => clearInterval(t); }, [measureNow]);
  useEffect(() => { if (servers.length) measureNow(); }, [servers.length, measureNow]);

  const stats = useMemo(() => {
    const online = servers.filter((s) => s.health?.ok || latency[String(s.id)] != null).length;
    return {
      total: servers.length,
      online,
      offline: servers.length - online,
      regions: new Set(servers.map((s) => s.region)).size,
    };
  }, [servers, latency]);

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

      <div class="main__stats">
        <div class="stat stat--mint">
          <div class="stat__icon"><${IconServer} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.total}</span><span class="stat__label">服务器总数</span></div>
        </div>
        <div class="stat stat--mint">
          <div class="stat__icon"><${IconServer} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.online}</span><span class="stat__label">在线运行</span></div>
        </div>
        <div class="stat stat--red">
          <div class="stat__icon"><${IconOff} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.offline}</span><span class="stat__label">离线 / 异常</span></div>
        </div>
        <div class="stat stat--ice">
          <div class="stat__icon"><${IconGlobe} size=${18} /></div>
          <div class="stat__body"><span class="stat__val">${stats.regions}</span><span class="stat__label">覆盖大区</span></div>
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
                <div class="table__cell cell-mono" title=${s.address}>
                  <span style="display:block">${s.address}</span>
                  ${s.probeAddress && s.probeAddress !== s.address
                    ? html`<span style="display:block;color:var(--text-dim);font-size:11px" title="服务端 /healthz 探测走这个地址">探测 → ${s.probeAddress}</span>`
                    : null}
                </div>
                <div class="table__cell"><span class=${`tag tag--${s.region}`}>${s.regionLabel}</span></div>
                <div class="table__cell"><${StatusCell} health=${s.health} clientMs=${latency[String(s.id)]} measuring=${measuring} /></div>
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
