// public/js/ui/resourcePanel.js — the faces of the optional preload (docs/ASSETS.md「Preload」):
//   * ResourceRow      — the 「预载资源」 row of the settings modal (switch + inline progress);
//   * ResourceLauncher — the compact pill the title screen shows in its bottom-right corner (the settings modal is only
//                        reachable inside a match, so the home screen needs its own way in);
//   * ResourceHost     — the resource manager both of them open: the essential/optional categories with their counts,
//                        sizes and progress, the ZIP import/export and 清理缓存 (mounted once in main.js).
// All three drive public/js/resources/index.js and render its state; nothing here runs while the switch is off.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Modal, ProgressBar } from './components.js';
import { createStore, useStore } from '../store.js';
import { formatBytes } from '../resources/common.js';
import { clearResources, exportResources, importResources, inspectResources, pauseResources,
  resourceState, startResources, subscribeResources, syncResources } from '../resources/index.js';
import { t } from '../../../shared/i18n.js';

/**
 * `1.2 GiB / 2.4 GiB` when the server could size the files, `2.4 GiB` when it could not, '' when it knows nothing.
 * @param {any} st state from public/js/resources/index.js
 */
export function byteText(st) {
  const total = Number.isFinite(st.totalBytes) && st.totalBytes > 0 ? st.totalBytes : 0;
  if (!total) return '';
  const done = Number.isFinite(st.bytes) ? st.bytes : 0;
  return st.sizedTotal ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(total);
}

/** `必需 120/456 · 全部 800/3959 · 1.2 GiB / 2.4 GiB` — `全部` counts the entries the origin 404'd as settled. */
export function detailText(st) {
  if (!st.total) return '';
  return [
    st.tier1Total ? t('必需 {tier1Done}/{tier1Total}', { tier1Done: st.tier1Done, tier1Total: st.tier1Total }) : '',
    t('全部 {0}/{total}', { 0: st.done + (st.gone || 0), total: st.total }),
    byteText(st),
  ].filter(Boolean).join(' · ');
}

/** Percent cached: by bytes when every file has a size, by file count otherwise (0..100, for the progress bar). */
export function percent(st) {
  if (!st.total) return 0;
  // Every settleable entry is settled: store.js counts the 404s (`gone`) towards `complete`, so the bar must not stick
  // just below the end forever. A partly sized manifest — or one with missing files — is measured in files.
  if (st.complete) return 100;
  const gone = st.gone || 0;
  const byBytes = gone === 0 && st.totalBytes > 0 && st.sizedTotal === st.total;
  const pct = byBytes ? (st.bytes / st.totalBytes) * 100 : ((st.done + gone) / Math.max(1, st.wanted || st.total)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

const busy = (st) => !!st.archive || st.phase === 'download' || st.phase === 'checking';
/** Another tab of this browser owns the download (Web Locks): pause/continue would be meaningless here. */
const otherTab = (st) => st.phase === 'foreign';

/** 暂停 / 继续下载 / 清理缓存 (+ 关闭预载 where the caller can turn the setting off). */
function ResourceActions({ st, onClose }) {
  return html`<div class="res-actions">
    ${busy(st)
      ? html`<${Button} variant="secondary" size="sm" icon="hourglass" onClick=${() => pauseResources()}>${st.archive ? t('取消处理') : t('暂停')}<//>`
      : st.complete
        ? html`<${Button} variant="secondary" size="sm" icon="check" onClick=${() => { void clearResources(); }}>${t('清理缓存')}<//>`
        : html`<${Button} variant="secondary" size="sm" icon="play" onClick=${() => startResources()}>${otherTab(st) ? t('再检查一次') : t('继续下载')}<//>`}
    ${busy(st) || st.complete ? null : html`<button type="button" class="res-link" onClick=${() => { void clearResources(); }}>${t('清理缓存')}</button>`}
    ${onClose ? html`<button type="button" class="res-link" onClick=${onClose}>${t('关闭预载')}</button>` : null}
  </div>`;
}

/** The manager's state line: what the preload is doing right now. */
function stateText(st, enabled) {
  if (st.archive) return st.archive === 'import' ? t('正在导入') : t('正在导出');
  if (otherTab(st)) return t('另一标签页处理中');
  if (busy(st)) return t('处理中');
  if (st.complete) return t('全部已保存');
  if (st.selectionComplete && st.tier1Total) return t('必备已保存');
  return enabled ? t('已暂停') : t('未开启');
}

const resourceUi = createStore({ open: false });
export const openResources = () => resourceUi.set({ open: true });
export const closeResources = () => resourceUi.set({ open: false });

function useResources() {
  const [st, setSt] = useState(() => resourceState());
  useEffect(() => subscribeResources(setSt), []);
  return st;
}

/**
 * One tier of the manager: its categories with their counts, sizes and progress. A category the manifest splits across
 * tiers (operator avatars are essential, their portraits optional) is listed in both, each with its own numbers.
 * @param {{ st: any, tier: number, optional?: boolean, onOptional?: (v: boolean) => void, disabled?: boolean }} props
 */
function ResourceTier({ st, tier, optional, onOptional, disabled }) {
  const groups = st.groups.filter((g) => g.tier === tier);
  const total = groups.reduce((n, g) => n + g.wanted, 0);
  const done = groups.reduce((n, g) => n + g.present, 0);
  const bytes = groups.reduce((n, g) => n + g.bytes, 0);
  const totalBytes = groups.reduce((n, g) => n + g.totalBytes, 0);
  const unknown = groups.some((g) => g.unknownSize);
  return html`<section class="resource-tier">
    <header class="resource-tier__head">
      <div><h3>${tier === 1 ? t('必备资源') : t('可选资源')}</h3>
        <p>${groups.map((g) => t(g.name)).join(' · ')}</p></div>
      ${tier === 2 ? html`<label class="resource-choice"><input type="checkbox" checked=${optional} disabled=${disabled}
        onChange=${(e) => onOptional(e.currentTarget.checked)} />${t('同时预载')}</label>` : html`<${MicroLabel}>REQUIRED<//>`}
    </header>
    <div class="resource-tier__summary"><span class="num">${t('{done} / {total} 个文件', { done, total })}</span>
      <span class="num">${unknown ? t('部分大小未知') : `${formatBytes(bytes)} / ${formatBytes(totalBytes)}`}</span></div>
    <${ProgressBar} value=${done} max=${Math.max(1, total)} size="sm" tone=${tier === 1 ? 'mint' : 'amber'} />
    <ul class="resource-tier__list">
      ${groups.map((group) => html`<li key=${group.gid}
        class=${st.archivePhase === 'import' && st.archiveGroup === group.id ? 'is-importing' : ''}><span>${t(group.name)}
          ${st.archivePhase === 'import' && st.archiveGroup === group.id ? html`<small>${t('正在导入')}</small>` : null}</span>
        <span class="num">${group.present}/${group.wanted}</span>
        <span class="num">${group.unknownSize ? t('大小待确认') : formatBytes(group.totalBytes)}</span></li>`)}
    </ul>
  </section>`;
}

/** @param {{ enabled: boolean, onChange: (v: boolean) => void }} props */
export function ResourceRow({ enabled, onChange }) {
  const st = useResources();
  useEffect(() => { syncResources(enabled).catch(() => {}); }, [enabled]);
  const detail = detailText(st);

  return html`<div class="set-res">
    <div class="set-row">
      <span class="set-row__label">${t('预载资源')}<${MicroLabel}>PRELOAD<//></span>
      <${Button} variant="secondary" size="sm" icon="expand" onClick=${openResources}>${t('资源管理')}<//>
      <button type="button" class=${`set-toggle${enabled ? ' is-on' : ''}`} role="switch" aria-checked=${enabled ? 'true' : 'false'}
        disabled=${!enabled && !st.supported ? 'disabled' : null} onClick=${() => onChange(!enabled)}><i></i><span>${enabled ? t('开启') : t('关闭')}</span></button>
    </div>
    ${enabled || st.done
      ? html`<div class="set-res__body">
          ${st.supported ? html`<${ProgressBar} size="sm" value=${percent(st)} max=${100} tone=${st.error ? 'amber' : 'mint'} />` : null}
          <div class="set-res__line">
            <span class="set-res__text">${st.message || (busy(st) ? t('正在后台预载…') : detail)}</span>
            ${detail && st.supported ? html`<span class="set-res__num num">${detail}</span>` : null}
          </div>
          ${st.supported ? html`<${ResourceActions} st=${st} />` : null}
          ${st.worker ? html`<p class="set-hint set-res__warn">${st.worker}</p>` : null}
          ${st.gone ? html`<p class="set-hint">${t('{gone} 个文件源站没有（已跳过，不影响使用）', { gone: st.gone })}</p>` : null}
          ${st.failed ? html`<p class="set-hint set-res__warn">${t('{failed} 个文件未完成（下次继续时重试）', { failed: st.failed })}</p>` : null}
        </div>`
      : html`<p class="set-hint">${t('开启后会把对局需要的素材（字体、界面、立绘、小人、音效）保存到本机缓存，进入战斗不再等待下载；关闭时一切照旧按需加载。需要 HTTPS。')}</p>`}
  </div>`;
}

/**
 * The title-screen pill. Collapsed while off (one click starts the preload and writes the setting), expanded while on:
 * progress, what is left and the same 暂停 / 清理缓存 / 关闭预载 actions. A browser that cannot keep the resources
 * (plain-HTTP LAN) shows nothing at all unless the switch is already on.
 * @param {{ enabled: boolean, onChange: (v: boolean) => void }} props
 */
export function ResourceLauncher({ enabled, onChange }) {
  const st = useResources();
  useEffect(() => { syncResources(enabled).catch(() => {}); }, [enabled]);
  if (!enabled && !st.supported) return null;
  const detail = detailText(st);
  const state = !enabled ? t('预载')
    : otherTab(st) ? t('另一标签页预载中')
      : busy(st) ? t('预载中 {0}%', { 0: percent(st) })
        : st.complete ? t('已保存')
          : st.error ? t('未完成') : t('已暂停');

  return html`<div class=${`res-pill${enabled ? ' is-on' : ''}`}>
    <button type="button" class="res-pill__head" disabled=${enabled ? 'disabled' : null}
      title=${enabled ? st.message || t('预载资源已开启，可用下方按钮暂停或清理') : t('把对局素材存到本机，进入战斗不再等待下载')}
      onClick=${() => { if (!enabled) onChange(true); }}>
      <span class="res-pill__label">${t('预载资源')}<${MicroLabel}>PRELOAD<//></span>
      <span class="res-pill__state">${state}</span>
    </button>
    ${enabled
      ? html`<div class="res-pill__body">
          ${st.supported ? html`<${ProgressBar} size="sm" value=${percent(st)} max=${100} tone=${st.error ? 'amber' : 'mint'} />` : null}
          <p class="res-pill__text">${st.message || detail || t('正在准备…')}</p>
          ${st.message && detail ? html`<p class="res-pill__text is-dim">${detail}</p>` : null}
          ${st.worker ? html`<p class="res-pill__text is-warn">${st.worker}</p>` : null}
          ${st.gone ? html`<p class="res-pill__text is-dim">${t('{gone} 个文件源站没有（已跳过）', { gone: st.gone })}</p>` : null}
          ${st.supported
            ? html`<${ResourceActions} st=${st} onClose=${() => onChange(false)} />`
            : html`<div class="res-actions"><button type="button" class="res-link" onClick=${() => onChange(false)}>${t('关闭预载')}</button></div>`}
          <button type="button" class="res-link" onClick=${openResources}>${t('资源管理')}</button>
        </div>`
      : html`<p class="res-pill__hint">${t('提前把对局素材存到本机，进入战斗不再等待下载')}</p>`}
  </div>`;
}

/**
 * The resource manager. Mounted once in main.js, above all screens including the settings modal (its own switch and the
 * pill only open it). 清理缓存, 暂停下载, 关闭预载 and the ZIP import/export live here; closing it leaves a running
 * download running.
 * @param {{ enabled: boolean, optional: boolean, onChange: (v: boolean) => void, onOptional: (v: boolean) => void }} props
 */
export function ResourceHost({ enabled, optional, onChange, onOptional }) {
  const { open } = useStore((s) => s, Object.is, resourceUi);
  const st = useResources();
  const fileInput = useRef(null);
  useEffect(() => { if (open) void inspectResources().catch(() => {}); }, [open]);
  const archiveBusy = !!st.archive;
  const importFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try { await importResources(file); if (!enabled) onChange(true); } catch { /* controller displays the error */ }
  };
  const exportFile = async () => {
    try {
      const { blob, version } = await exportResources();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stronghold-resources-${version.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* controller displays the error */ }
  };
  return html`<${Modal} open=${open} onClose=${closeResources} title=${t('预载资源管理')} micro="RESOURCE MANAGER" class="resource-modal"
    actions=${html`
      ${busy(st) ? html`<${Button} variant="secondary" icon="hourglass" onClick=${pauseResources}>${archiveBusy ? t('取消处理') : t('暂停下载')}<//>`
        : html`<${Button} variant="primary" icon="play" disabled=${!st.supported}
          onClick=${() => enabled ? startResources() : onChange(true)}>${st.selectionComplete ? t('检查资源') : enabled ? t('继续下载') : t('开始预载')}<//>`}
      <${Button} variant="secondary" onClick=${closeResources}>${t('关闭')}<//>`}>
    <div class="resource-manager">
      <p class="resource-manager__intro">${t('先预载必备资源；可选资源可按需加载。关闭此窗口后，下载会在后台继续。')}</p>
      <div class="resource-manager__tiers">
        <${ResourceTier} st=${st} tier=${1} />
        <${ResourceTier} st=${st} tier=${2} optional=${optional} onOptional=${onOptional} disabled=${archiveBusy} />
      </div>
      <p class=${`resource-manager__status${st.error ? ' is-error' : ''}`} role="status" aria-live="polite">
        ${st.message || (enabled ? t('预载已开启') : t('选择下载范围，然后开始预载；也可以直接导入资源包。'))}</p>
      ${st.worker ? html`<p class="resource-manager__warn">${st.worker}</p>` : null}
      ${st.failed ? html`<p class="resource-manager__warn">${t('{failed} 个文件下载失败，继续下载时重试。', { failed: st.failed })}</p>` : null}
      ${st.gone ? html`<p class="resource-manager__warn">${t('{gone} 个文件源站没有（已跳过，不影响使用）', { gone: st.gone })}</p>` : null}
      ${st.skipped ? html`<p class="resource-manager__warn">${t('{skipped} 个文件超过单文件缓存上限，使用时按需加载。', { skipped: st.skipped })}</p>` : null}
      <section class="resource-archive">
        <h3>${t('ZIP 资源包')}</h3>
        <p>${t('可将已缓存的资源导出为 ZIP 分享给他人，也可以导入他人分享的资源包。支持导入旧版本资源包；导入会校验完整性，只复用当前版本仍有效的文件，并增量下载缺少的资源。')}</p>
        ${st.archive ? html`<${ProgressBar} value=${st.archivePercent} max=${100} size="sm" tone="mint" />` : null}
        <input ref=${fileInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange=${importFile} />
        <div class="res-actions">
          <${Button} variant="secondary" disabled=${archiveBusy || !st.supported} onClick=${() => fileInput.current?.click()}>${t('导入 ZIP')}<//>
          <${Button} variant="secondary" disabled=${archiveBusy || !st.supported || !st.done} onClick=${exportFile}>${t('导出 ZIP')}<//>
        </div>
      </section>
      <div class="resource-manager__maintenance">
        <button type="button" class="res-link" disabled=${archiveBusy} onClick=${() => { void clearResources(); }}>${t('清理缓存')}</button>
        ${enabled ? html`<button type="button" class="res-link" onClick=${() => onChange(false)}>${t('关闭预载')}</button>` : null}
        <span>${t('关闭预载会保留已缓存资源。')}</span>
      </div>
    </div>
  <//>`;
}
