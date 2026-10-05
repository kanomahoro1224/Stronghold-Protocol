// Emergency / maintenance banner (global chrome, mounted once by main.js).
//
// Issued by the operator only: the client reads /runtime/status.json once per page load. That file lives on the
// production server under public/runtime/ and is NOT part of the code deploy (deploys ship js|css|vendor only), so
// publishing or clearing a notice needs no republish, no version bump and no restart — whoever can write that file
// on the server is the only one who can issue it.
//
// Placement mirrors the connection banner: outside a match it sits at the top centre; in a match (html.sp-in-match,
// set by the match screen) it drops under the battle-report bar at 1.34rem so it never covers the combat view
// switcher. Dismissal is remembered per message id for the session, so a newly issued notice shows up again.
//
// File shape (all optional but text):
//   { "id": "2026-10-05-maint", "tone": "emergency" | "maintenance" | "info",
//     "text": "服务器异常，正在抢修", "detail": "预计 10 分钟" }

import { html, Icon } from './components.js';
import { useEffect, useState } from 'preact/hooks';

export const STATUS_SOURCE = '/runtime/status.json';
const DISMISS_KEY = 'sp.statusBanner.dismissed';

/** Badge label and icon per tone (the two the operator uses are 紧急 and 维护). */
const TONES = {
  emergency: { badge: '紧急', icon: 'info' },
  maintenance: { badge: '维护', icon: 'hourglass' },
  info: { badge: '公告', icon: 'info' },
};

/** Pure: raw JSON -> { id, tone, text, detail } | null (no banner without text). */
export function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tone = Object.prototype.hasOwnProperty.call(TONES, raw.tone) ? raw.tone : 'info';
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${tone}:${text}`;
  return { id, tone, text, detail };
}

function readDismissed() {
  try { return sessionStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
}

function rememberDismissed(id) {
  try { sessionStorage.setItem(DISMISS_KEY, id); } catch { /* private mode: the banner simply comes back */ }
}

export function StatusBanner() {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    let alive = true;
    fetch(STATUS_SOURCE, { cache: 'no-store' })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((raw) => { if (alive) setStatus(normalizeStatus(raw)); })
      .catch(() => { /* missing file / offline: no banner */ });
    return () => { alive = false; };
  }, []);
  if (!status || dismissed === status.id) return null;
  const tone = TONES[status.tone];
  const close = () => { rememberDismissed(status.id); setDismissed(status.id); };
  return html`<div class=${`status-banner status-banner--${status.tone}`} role="alert">
    <span class="status-banner__badge">${tone.badge}</span>
    <${Icon} name=${tone.icon} />
    <span class="status-banner__text">${status.text}</span>
    ${status.detail ? html`<span class="status-banner__sub">${status.detail}</span>` : null}
    <button class="status-banner__close" type="button" aria-label="关闭公告" onClick=${close}>×</button>
  </div>`;
}
