// community/public/js/ui.js — shared primitives: icons, toast, modal, brand, JSON pretty-printer.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

// ---- brand mark (hexagon shield + lattice, echoing the game's dot-matrix emblem) ----------------
export const BrandMark = ({ size = 30 }) => html`
  <svg class="brand__mark" width=${size} height=${size * 1.13} viewBox="0 0 30 34" fill="none" aria-hidden="true">
    <path d="M15 1.5 L28 9 L28 25 L15 32.5 L2 25 L2 9 Z" stroke="#4ed8af" stroke-width="1.6" fill="rgba(78,216,175,.06)"/>
    <path d="M15 7 L23 11.5 L23 22 L15 26.5 L7 22 L7 11.5 Z" fill="#4ed8af" opacity=".16"/>
    <g fill="#4ed8af">
      <circle cx="15" cy="12" r="1.5"/><circle cx="20" cy="15" r="1.5"/><circle cx="20" cy="20" r="1.5"/>
      <circle cx="15" cy="23" r="1.5"/><circle cx="10" cy="20" r="1.5"/><circle cx="10" cy="15" r="1.5"/>
    </g>
  </svg>`;

// ---- icons --------------------------------------------------------------------------------------
const svg = (paths, size = 18) => html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const IconServer = ({ size }) => svg(html`<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r=".9" fill="currentColor"/><circle cx="7" cy="16.5" r=".9" fill="currentColor"/>`, size);
export const IconUser = ({ size }) => svg(html`<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6"/>`, size);
export const IconUsers = ({ size }) => svg(html`<circle cx="9" cy="8" r="3.2"/><path d="M2.5 19.5c0-3.3 2.9-5.2 6.5-5.2s6.5 1.9 6.5 5.2"/><path d="M17 5.2a3.2 3.2 0 0 1 0 6.2"/><path d="M18.5 14.6c2.2.6 3.5 2.1 3.5 4.4"/>`, size);
export const IconShield = ({ size }) => svg(html`<path d="M12 2.5 L20 6 v6c0 5-3.4 8.3-8 9.5C7.4 20.3 4 17 4 12V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>`, size);
export const IconGlobe = ({ size }) => svg(html`<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 3 2.6 15 0 18-2.6-3-2.6-15 0-18z"/>`, size);
export const IconRefresh = ({ size }) => svg(html`<path d="M20 11a8 8 0 1 0-1.5 5.3"/><path d="M20 5v6h-6"/>`, size);
export const IconPlus = ({ size }) => svg(html`<path d="M12 5v14M5 12h14"/>`, size);
export const IconCaret = ({ size }) => svg(html`<path d="M6 9l6 6 6-6"/>`, size);
export const IconX = ({ size }) => svg(html`<path d="M6 6l12 12M18 6L6 18"/>`, size);
export const IconOff = ({ size }) => svg(html`<path d="M12 3v9"/><path d="M6.5 6.8a7.5 7.5 0 1 0 11 0"/>`, size);
export const IconArrow = ({ size }) => svg(html`<path d="M5 12h13M13 6l6 6-6 6"/>`, size);

// ---- toast --------------------------------------------------------------------------------------
let pushToast = () => {};
export function ToastHost() {
  const [list, setList] = useState([]);
  useEffect(() => {
    pushToast = (message, kind = 'ok') => {
      const id = Math.random().toString(36).slice(2);
      setList((l) => [...l, { id, message, kind }]);
      setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 3200);
    };
    return () => { pushToast = () => {}; };
  }, []);
  return html`<div class="toasts">${list.map((t) => html`<div key=${t.id} class=${`toast toast--${t.kind}`}>${t.message}</div>`)}</div>`;
}
export const toast = {
  ok: (m) => pushToast(m, 'ok'),
  err: (m) => pushToast(m, 'err'),
};

// ---- modal --------------------------------------------------------------------------------------
export function Modal({ title, micro, onClose, children, footer, width }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  return html`
    <div class="scrim" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal" style=${width ? `max-width:${width}px` : ''} role="dialog" aria-modal="true">
        <div class="modal__accent"></div>
        <div class="modal__head">
          <div>
            ${micro ? html`<div class="micro t-mint" style="margin-bottom:5px">${micro}</div>` : null}
            <div class="modal__title">${title}</div>
          </div>
          <button class="modal__close" onClick=${onClose} aria-label="关闭"><${IconX} size=${16} /></button>
        </div>
        <div class="modal__body">${children}</div>
        ${footer ? html`<div class="modal__foot">${footer}</div>` : null}
      </div>
    </div>`;
}

// ---- field --------------------------------------------------------------------------------------
export function Field({ label, hint, children }) {
  return html`<div class="field">
    ${label ? html`<label class="field__label">${label}</label>` : null}
    ${children}
    ${hint ? html`<div class="field__hint">${hint}</div>` : null}
  </div>`;
}

// ---- JSON pretty printer (syntax-coloured, full payload) -----------------------------------------
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/** Serialize any JSON value with colour classes; prints the WHOLE object (the user asked for full data). */
export function JsonBlock({ value }) {
  const out = [];
  const walk = (v, indent, key) => {
    const pad = '  '.repeat(indent);
    const keyHtml = key !== undefined ? `<span class="k">"${escapeHtml(key)}"</span><span class="nl">: </span>` : '';
    if (v === null) out.push(`${pad}${keyHtml}<span class="nl">null</span>`);
    else if (typeof v === 'string') out.push(`${pad}${keyHtml}<span class="s">"${escapeHtml(v)}"</span>`);
    else if (typeof v === 'number') out.push(`${pad}${keyHtml}<span class="n">${v}</span>`);
    else if (typeof v === 'boolean') out.push(`${pad}${keyHtml}<span class="b">${v}</span>`);
    else if (Array.isArray(v)) {
      if (!v.length) { out.push(`${pad}${keyHtml}<span class="nl">[]</span>`); return; }
      out.push(`${pad}${keyHtml}<span class="nl">[</span>`);
      v.forEach((item, i) => walk(item, indent + 1, undefined));
      out.push(`${pad}<span class="nl">]</span>`);
    } else if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) { out.push(`${pad}${keyHtml}<span class="nl">{}</span>`); return; }
      out.push(`${pad}${keyHtml}<span class="nl">{</span>`);
      keys.forEach((k, i) => walk(v[k], indent + 1, k));
      out.push(`${pad}<span class="nl">}</span>`);
    }
  };
  walk(value, 0, undefined);
  return html`<pre dangerouslySetInnerHTML=${{ __html: out.join('\n') }} />`;
}

// ---- formatting ----------------------------------------------------------------------------------
export function formatUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export function relativeTime(ts) {
  if (!ts) return '从未登录';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}
