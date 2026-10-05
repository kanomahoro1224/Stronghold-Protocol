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
// minOnline retires an emergency notice by itself: while the server is busier than that, the banner shows; once the
// live online count (the same number as the 在线 pill) falls below it, the notice is done and stays gone for the rest
// of the session — the operator does not have to remember to withdraw it. Re-issuing with a new id shows it again.
//
// File shape (text is required, everything else optional):
//   { "id": "2026-10-05-load",
//     "tone": "emergency" | "maintenance" | "info",
//     "text": "服务器资源吃紧，与朋友联机请前往分线：",
//     "link": { "label": "game.kafuno.cn", "href": "https://game.kafuno.cn" },
//     "detail": "匹配可留在此服务器",
//     "minOnline": 1900 }

import { html, Icon } from './components.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../store.js';

export const STATUS_SOURCE = '/runtime/status.json';
const DISMISS_KEY = 'sp.statusBanner.dismissed';
const RETIRED_KEY = 'sp.statusBanner.retired';

/** Badge label and icon per tone (the two the operator uses are 紧急 and 维护). */
const TONES = {
  emergency: { badge: '紧急', icon: 'info' },
  maintenance: { badge: '维护', icon: 'hourglass' },
  info: { badge: '公告', icon: 'info' },
};

/** https only, and the label falls back to the host, so an operator typo can never inject a javascript: URL. */
export function normalizeLink(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const href = typeof raw.href === 'string' ? raw.href.trim() : '';
  if (!/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?$/i.test(href)) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : href.replace(/^https:\/\//, '').split('/')[0];
  return { label, href };
}

/** Pure: raw JSON -> { id, tone, text, detail, link, minOnline } | null (no banner without text). */
export function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tone = Object.prototype.hasOwnProperty.call(TONES, raw.tone) ? raw.tone : 'info';
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${tone}:${text}`;
  const minOnline = Number.isInteger(raw.minOnline) && raw.minOnline > 0 ? raw.minOnline : 0;
  return { id, tone, text, detail, link: normalizeLink(raw.link), minOnline };
}

/** Whether a notice with minOnline should already be retired at this online count. */
export function retireByOnline(minOnline, online) {
  return !!minOnline && online > 0 && online < minOnline;
}

function readSession(key) {
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}

function writeSession(key, id) {
  try { sessionStorage.setItem(key, id); } catch { /* private mode: worst case the banner comes back */ }
}

export function StatusBanner() {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(() => readSession(DISMISS_KEY));
  const [retired, setRetired] = useState(() => readSession(RETIRED_KEY));
  const online = useStore((s) => (s.connection && s.connection.onlineCount) || 0);
  useEffect(() => {
    let alive = true;
    fetch(STATUS_SOURCE, { cache: 'no-store' })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((raw) => { if (alive) setStatus(normalizeStatus(raw)); })
      .catch(() => { /* missing file / offline: no banner */ });
    return () => { alive = false; };
  }, []);
  const gone = !!status && (dismissed === status.id || (retired === status.id && status.minOnline > 0));
  useEffect(() => {
    if (!status || !status.minOnline || gone) return;
    if (retireByOnline(status.minOnline, online)) { writeSession(RETIRED_KEY, status.id); setRetired(status.id); }
  }, [status, online, gone]);
  if (!status || gone) return null;
  const tone = TONES[status.tone];
  const close = () => { writeSession(DISMISS_KEY, status.id); setDismissed(status.id); };
  return html`<div class=${`status-banner status-banner--${status.tone}`} role="alert">
    <span class="status-banner__badge">${tone.badge}</span>
    <${Icon} name=${tone.icon} />
    <span class="status-banner__text">${status.text}</span>
    ${status.link ? html`<a
      class="status-banner__link"
      href=${status.link.href}
      target="_blank"
      rel="noopener noreferrer"
    >${status.link.label}</a>` : null}
    ${status.detail ? html`<span class="status-banner__sub">${status.detail}</span>` : null}
    <button class="status-banner__close" type="button" aria-label="关闭公告" onClick=${close}>×</button>
  </div>`;
}
