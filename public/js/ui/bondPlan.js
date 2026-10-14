// 预选盟约 BOND PLAN：客户端状态、同步与选择弹窗 (user request 2026-10-13).
//
// The official mode lets a doctor announce the bond (盟约) they intend to build, so the team can spread out over the
// shared operator pool before the first shop. This is that: one bond id, chosen from the eight CORE bonds
// (data/bonds.json `isCore` — the list the official BOND PLAN grid shows), persisted per browser in localStorage and
// mirrored to the server through `room.bondPlan`.
//
// Like the operator skins (ui/skins.js) the choice is PUBLIC: the server puts it in `Match.publicView().players[]`,
// which is how a teammate reads it off the strategy-draft list and the team panel. It changes nothing in the match —
// no pool filtering, no layers, no activation, no scoring — it is communication, exactly as the official note says.

import { createStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';
import { html, Button, Icon, Modal } from './components.js';
import { BondGlyph } from './gameComponents.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
export const BOND_PLAN_PREF = 'bondPlan';
export const SYNC_DEBOUNCE_MS = 300;
export const RETRY_MS = 1500;

function readStored() {
  const raw = loadPref(BOND_PLAN_PREF, null);
  return typeof raw === 'string' && raw ? raw : null;
}

/** The pre-selected bond (per browser) and the sync state — kept out of the app store, like the skins. */
export const bondPlanStore = createStore({ bondId: readStored(), sync: 'idle' });

/** Pre-select a bond (persisted at once; the sync picks the change up). `null` clears it. */
export function setBondPlan(bondId) {
  const next = typeof bondId === 'string' && bondId ? bondId : null;
  savePref(BOND_PLAN_PREF, next);
  bondPlanStore.set({ bondId: next });
}

/** The bond this browser pre-selected, or null. */
export const myBondPlan = () => bondPlanStore.get().bondId || null;

/** Load what the picker needs (data/bonds.json). */
export function loadBondPlanData() {
  data.load('bonds').catch(() => {});
}

/**
 * The eight core bonds the picker offers, in data order.
 *
 * `bonds.json` is keyed by bond id and its insertion order is the official BOND PLAN order (炎, 萨尔贡, 维多利亚,
 * 谢拉格, 拉特兰, 阿戈尔, 叙拉古, 卡西米尔), so this deliberately does not re-sort: `bondOrder` is 2 for all eight.
 * @returns {{ bondId: string, name: string }[]}
 */
export function coreBonds() {
  const list = data.get('bonds');
  const out = [];
  if (list && typeof list === 'object') {
    for (const [bondId, b] of Object.entries(list)) {
      if (b && b.isCore) out.push({ bondId, name: b.name || bondId });
    }
  }
  return out;
}

/**
 * Small tag (glyph + name) showing a player's pre-selected bond — the strategy-draft list and the room seats.
 * @param {{ bondId?: string | null, class?: string, showName?: boolean }} props
 */
export function BondPlanBadge({ bondId, class: cls, showName = true }) {
  if (!bondId) return null;
  const b = data.lookup('bonds', bondId);
  const name = b?.name || bondId;
  return html`<span class=${cx('bplan-tag', cls)} data-testid="bond-plan-tag" title=${t('预选盟约：{name}', { name })}>
    <${BondGlyph} bondId=${bondId} class="bplan-tag__glyph" />${showName ? html`<span class="bplan-tag__name">${name}</span>` : null}
  </span>`;
}

/**
 * The 预选盟约 dialog: the eight core bonds as a grid, 不预选 and 关闭.
 *
 * A pick is applied at once (persisted and synced) — the official screen has no separate confirm step — and tapping
 * the selected bond again clears it, as does 不预选.
 * @param {{ open: boolean, onClose?: () => void, current?: string | null, onPick?: (id: string | null) => void }} props
 */
export function BondPlanDialog({ open, onClose, current = null, onPick = setBondPlan }) {
  if (!open) return null;
  const list = coreBonds();
  return html`<${Modal} open=${open} title=${t('预选盟约')} micro="BOND PLAN" tone="mint" width="560px"
      class="bplan" onClose=${onClose}
      actions=${html`<${Button} variant="secondary" icon="close" onClick=${onClose}>${t('关闭')}<//>`}>
    <p class="bplan__note">${t('选择你打算发展的盟约，队友都能看到。只作沟通，不影响对局。')}</p>
    <div class="bplan__grid" role="listbox" aria-label=${t('预选盟约')}>
      ${list.map((b) => {
        const on = b.bondId === current;
        return html`<button key=${b.bondId} type="button" role="option" aria-selected=${on ? 'true' : 'false'}
            class=${cx('bplan__cell', on && 'is-on')} data-testid=${`bond-plan-${b.bondId}`}
            title=${on ? t('取消预选「{name}」', { name: b.name }) : t('预选「{name}」', { name: b.name })}
            onClick=${() => onPick(on ? null : b.bondId)}>
          <${BondGlyph} bondId=${b.bondId} class="bplan__glyph" />
          <span class="bplan__name">${b.name}</span>
          ${on ? html`<span class="bplan__check"><${Icon} name="check" /></span>` : null}
        </button>`;
      })}
    </div>
    <div class="bplan__foot">
      <${Button} variant="ghost" icon="close" disabled=${!current} data-testid="bond-plan-clear"
        onClick=${() => onPick(null)}>${t('不预选')}<//>
    </div>
  <//>`;
}

/**
 * Keep the server's copy of this browser's 预选盟约 current.
 *
 * Mirrors installSkinsSync (ui/skins.js): sent after every welcome and after every edit, debounced, with the same
 * retry-on-transient-failure rule. The payload is a single id, so the whole state is one comparison.
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 * @returns {{ flush: () => Promise<void>, dispose: () => void }}
 */
export function installBondPlanSync({ net, timers } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let timer = null;
  let seq = 0;
  let pending = null;
  let lastSent = null;
  let disposed = false;

  const setState = (sync) => { if (bondPlanStore.get().sync !== sync) bondPlanStore.set({ sync }); };
  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed || net.status !== 'online') { setState('idle'); return; }
    const bondId = bondPlanStore.get().bondId || null;
    if (bondId === lastSent && pending === null) { setState('synced'); return; }
    const my = ++seq;
    pending = bondId;
    setState('sending');
    try {
      await net.request('room.bondPlan', { bondId });
      if (my !== seq) return;
      pending = null;
      lastSent = bondId;
      setState('synced');
    } catch (err) {
      if (my !== seq) return;
      pending = null;
      const code = err && err.code;
      if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') { schedule(RETRY_MS); return; }
      console.warn('[bondPlan] room.bondPlan refused', code, err && err.detail);
      setState('error');
    }
  }

  const offWelcome = net.on('welcome', () => { lastSent = null; pending = null; seq++; schedule(50); });
  const offStore = bondPlanStore.subscribe((s, prev) => { if (s.bondId !== prev.bondId) schedule(); });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStore?.();
    },
  };
}
