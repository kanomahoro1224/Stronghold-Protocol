// 公告 (announcement): the operator's own message, opened from the title screen. The 「公告」 button sits immediately
// beside 「玩法说明」 (ui/guide.js GuideButton) in the same row (.title-conn__actions) and mirrors it exactly: a
// ghost/sm Button with an icon, the same label / title / aria-label and a `notice-btn` class of its own. The panel is
// the project's standard dialog (components.js Modal — the settings / exit idiom), so it closes on exactly the
// affordances those dialogs use: its own 关闭 button, Escape, and a click outside the box. It is TWO columns — the
// notice text on the left, the sponsorship QR on the right (ui/sponsor.js) — and stacks on a narrow screen.
//
// Content: /data/notice.json, fetched at runtime, root-relative and with `cache: 'no-cache'`. That combination is
// deliberate: unlike the game data (data.js, whose base is the immutable code-version prefix in production and is
// therefore safe to cache hard), the notice is operator-editable and must reach players by republishing that ONE file —
// no client build, no server route, no restart; opening the panel re-reads it.
//
// Shape (documented in the file itself). Top level: { "title", "sections", "updatedAt" }.
//   "sections": [ { "label": "小节名", "lines": [ … ] }, … ]   rendered in order: the small dim label row, then its lines
// Each `lines` entry (and each legacy `body` entry) is ONE of:
//   "一行纯文本"                                        the original form, still the common case
//   { "segments": [ { "t": "文本" }, { "t": "文本", "href": "https://…" } ] }
//   { "spacer": true }                                  a blank line, so groups can be kept apart
// The OLDER `body` array (a flat list of the same entries, no sections) is still accepted: it renders as one unlabelled
// section, and `notice.body` keeps holding that flat list either way, so nothing that read it stops working. A `body`
// that is one string is still split on newlines.
//
// The SEGMENTS ARE STRUCTURED DATA, never markup: nothing is parsed for tags and no HTML string is ever built (no
// innerHTML, no dangerouslySetInnerHTML) — every segment becomes a text node, and a segment whose `href`
// safeNoticeHref() approves becomes an <a>. That check is the whitelist: https: only, on NOTICE_LINK_HOSTS, or a
// mailto: address — so a hostile or fat-fingered notice.json cannot smuggle javascript:, data:, a protocol-relative
// //host or an off-site link in; such an href silently renders as plain text. The check runs twice (normalize + render).
// Every failure — 404, network error, invalid JSON, a payload that is not an object — renders NOTICE_FALLBACK: a
// malformed or missing notice must never break the title screen. The rendered text is capped (NOTICE_MAX_LINES /
// NOTICE_MAX_LINE / NOTICE_MAX_CHARS — segment text counts too) so a 100 KB body cannot blow up the layout, and the
// dialog's body scrolls (components.css .modal__body { overflow: auto }).
//
// Injectable (fetch / url / warn / store) so test/ui/notice.test.js drives it without a browser or a network.

import { html, Modal, Button } from './components.js';
import { createStore, useStore } from '../store.js';
import { SponsorQr } from './sponsor.js';

/** Where the notice lives: a static file of the /data mount — no server route, no new endpoint. */
export const NOTICE_URL = '/data/notice.json';

/** Rendered-text caps: a huge body is truncated instead of stretching the dialog (the body scrolls anyway). */
export const NOTICE_MAX_LINES = 40;
export const NOTICE_MAX_LINE = 200;
export const NOTICE_MAX_CHARS = 4000;
/** Longest accepted inline title / timestamp (the title also has the dialog's width to fit into). */
export const NOTICE_MAX_TITLE = 60;
export const NOTICE_MAX_UPDATED = 40;
/** Section labels are one small row each: capped in length and in count (they are not part of `body`). */
export const NOTICE_MAX_LABEL = 40;
export const NOTICE_MAX_SECTIONS = 20;

/**
 * The ONLY hosts an inline notice link may point at (exact hostname match, https: only — see safeNoticeHref).
 * Everything else, including every subdomain spelling of them, renders as plain text.
 */
export const NOTICE_LINK_HOSTS = Object.freeze(['space.bilibili.com', 'ai.xiaolubao.com', 'wpa.qq.com', 'github.com']);
/** Longest accepted href: nothing legitimate here comes close, and a longer one is refused unread. */
export const NOTICE_MAX_HREF = 300;

/** Built-in content: shown when data/notice.json is missing, unreachable, invalid — or simply not edited yet. */
export const NOTICE_FALLBACK = Object.freeze({
  title: '公告',
  body: Object.freeze([
    '欢迎游玩 卫戍协议：盟约（非官方同人复刻）。',
    '本服务器为公益服务器，可能会不定期重启更新版本，由此造成的游戏中断敬请谅解。',
    '暂无更多公告内容。',
  ]),
  updatedAt: '',
});

const cx = (...parts) => parts.flat().filter(Boolean).join(' ');

/** Trim `text` and cut it to `max` UTF-16 units without splitting a surrogate pair (an emoji stays whole). */
function clamp(text, max) {
  if (typeof text !== 'string') return '';
  const s = text.trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trim();
}

/**
 * A fresh copy of the built-in notice: one unlabelled section, so the panel renders it like any other notice, plus the
 * legacy flat `body` (callers may keep or mutate the array).
 */
export function fallbackNotice() {
  return {
    title: NOTICE_FALLBACK.title,
    sections: [{ label: '', lines: [...NOTICE_FALLBACK.body] }],
    body: [...NOTICE_FALLBACK.body],
    updatedAt: '',
    fallback: true,
  };
}

/**
 * Approve an `href` for rendering as an <a>, or return null (the segment then renders as plain text). This is the
 * whole whitelist and the only way a link can exist:
 *   * https:// on a NOTICE_LINK_HOSTS host (exact name, default port, no credentials in the URL), or
 *   * a plain mailto: address.
 * Refused: javascript: / data: / vbscript: / file:, plain http:, protocol-relative `//host`, any other host, any
 * embedded whitespace or control character, anything absurdly long. Refusals are silent — the notice still renders,
 * as text, and nothing user-visible (or in the console) mentions the rejected value.
 * @param {any} href the raw value from the JSON
 * @returns {string|null} the href exactly as authored (never rewritten), or null
 */
export function safeNoticeHref(href) {
  if (typeof href !== 'string') return null;
  const s = href.trim();
  if (!s || s.length > NOTICE_MAX_HREF) return null;
  if (/[\u0000-\u0020\u007f]/.test(s)) return null; // no whitespace / control characters to smuggle with
  if (s.startsWith('//')) return null; // protocol-relative resolves against http(s) — refused by name
  if (/^mailto:/i.test(s)) return /^mailto:[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/i.test(s) ? s : null;
  if (!/^https:\/\//i.test(s)) return null; // http:, javascript:, data:, everything else
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  return NOTICE_LINK_HOSTS.includes(u.hostname.toLowerCase()) ? s : null;
}

/**
 * One structured line → its segments, or null when it holds nothing renderable. Segment text is capped to the line
 * budget (NOTICE_MAX_LINE characters in total), the line's outer whitespace is trimmed, and an href is kept only when
 * safeNoticeHref approves it (otherwise that segment stays plain text).
 * @param {any} raw the entry's `segments` array
 * @returns {Array<{ t: string, href?: string }>|null}
 */
function normalizeSegments(raw) {
  if (!Array.isArray(raw)) return null;
  const segments = [];
  let len = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const t = typeof item.t === 'string' ? item.t : '';
    if (!t) continue;
    const room = NOTICE_MAX_LINE - len;
    if (room <= 0) break;
    let text = t.length > room ? t.slice(0, room) : t;
    if (text.length < t.length && /[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    if (!text) break;
    const href = safeNoticeHref(item.href);
    segments.push(href ? { t: text, href } : { t: text });
    len += text.length;
  }
  if (!segments.length) return null;
  // trim only the line's outer edges: a segment's own spacing (and every U+3000 between words) is left verbatim
  segments[0] = { ...segments[0], t: segments[0].t.replace(/^[\s\u3000]+/, '') };
  const last = segments.length - 1;
  segments[last] = { ...segments[last], t: segments[last].t.replace(/[\s\u3000]+$/, '') };
  const kept = segments.filter((s) => s.t);
  return kept.length ? kept : null;
}

/**
 * Turn whatever /data/notice.json held into a renderable notice: never throws, always has at least one line.
 * Accepts `sections` (the current shape) and, unchanged, the legacy flat `body` — both feed the same line normalizer,
 * so a plain line stays a string (the form every previous version produced), a link / multi-part line becomes
 * `{ segments: [...] }` and a blank grouping line becomes `{ spacer: true }`. Non-strings and empty entries are
 * dropped, and the result is capped (lines / line length / total characters — segment text is measured too).
 * @param {any} raw parsed JSON (or anything else)
 * @returns {{ title: string, sections: Array<{label: string, lines: Array<any>}>, body: Array<any>, updatedAt: string,
 *   fallback: boolean }} `body` is every section's lines in order (the legacy flat view); `fallback` is true when
 *   nothing in the payload carried text (the built-in text is being shown).
 */
export function normalizeNotice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallbackNotice();
  let chars = 0;
  let lines = 0;
  let hasText = false;

  /** One raw line entry → a normalized line, honouring the global caps. Returns the line or null. */
  const line = (v) => {
    if (lines >= NOTICE_MAX_LINES) return null;
    if (typeof v === 'string') {
      const s = clamp(v, NOTICE_MAX_LINE);
      if (!s || chars + s.length > NOTICE_MAX_CHARS) return null;
      lines += 1;
      chars += s.length;
      hasText = true;
      return s;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (v.spacer === true) {
      lines += 1;
      return { spacer: true };
    }
    const segments = normalizeSegments(v.segments);
    if (!segments) {
      // a structured entry with nothing renderable is the author's blank line: keep the grouping, add no text
      if (Array.isArray(v.segments)) {
        lines += 1;
        return { spacer: true };
      }
      return null;
    }
    const len = segments.reduce((n, s) => n + s.t.length, 0);
    if (chars + len > NOTICE_MAX_CHARS) return null;
    lines += 1;
    chars += len;
    hasText = true;
    return { segments };
  };

  /** One raw section → { label, lines }, or null when it holds nothing to render. */
  const section = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const label = clamp(v.label, NOTICE_MAX_LABEL);
    const out = [];
    if (Array.isArray(v.lines)) for (const l of v.lines) { const n = line(l); if (n) out.push(n); }
    else if (typeof v.lines === 'string') for (const l of v.lines.split(/\r?\n/)) { const n = line(l); if (n) out.push(n); }
    if (!label && !out.length) return null;
    return { label, lines: out };
  };

  const build = (list) => {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const v of list) {
      if (out.length >= NOTICE_MAX_SECTIONS) break;
      const s = section(v);
      if (s) out.push(s);
    }
    return out;
  };

  // `sections` first (the current shape); the legacy flat `body` is used when the payload yielded no text at all
  // (a file that was not migrated, or a `sections` array that turned out to be unusable). Budgets restart for it.
  let sections = Array.isArray(raw.sections) ? build(raw.sections) : [];
  if (!hasText) {
    lines = 0;
    chars = 0;
    const flat = [];
    if (Array.isArray(raw.body)) for (const v of raw.body) { const n = line(v); if (n) flat.push(n); }
    else if (typeof raw.body === 'string') for (const v of raw.body.split(/\r?\n/)) { const n = line(v); if (n) flat.push(n); }
    if (flat.length) sections = [{ label: '', lines: flat }];
  }

  const title = clamp(raw.title, NOTICE_MAX_TITLE) || NOTICE_FALLBACK.title;
  const updatedAt = clamp(raw.updatedAt, NOTICE_MAX_UPDATED);
  if (!hasText) return { ...fallbackNotice(), title, updatedAt };
  return { title, sections, body: sections.flatMap((s) => s.lines), updatedAt, fallback: false };
}

/**
 * The plain text of one normalized line ('' for a spacer) — what the panel shows, links included.
 * @param {any} line
 * @returns {string}
 */
export function noticeLineText(line) {
  if (typeof line === 'string') return line;
  if (!line || line.spacer || !Array.isArray(line.segments)) return '';
  return line.segments.map((s) => s.t).join('');
}

/**
 * One normalized segment → a text node, or an <a> when its href is whitelisted. Pure (no DOM) so tests can inspect
 * the rendered node: the href is re-checked here, so even a hand-built notice cannot produce a link that
 * safeNoticeHref would refuse.
 * @param {{ t: string, href?: string }} seg
 * @returns {any} a string, or a Preact <a> vnode
 */
export function noticeSegmentNode(seg) {
  if (!seg || typeof seg.t !== 'string') return '';
  const href = safeNoticeHref(seg.href);
  if (!href) return seg.t;
  return html`<a class="notice__link" href=${href} target="_blank" rel="noopener noreferrer">${seg.t}</a>`;
}

/**
 * One normalized line → its <p> (a link-free line, a line of segments, or a blank spacer). Pure, so the render
 * path itself is unit-tested.
 * @param {any} line
 * @param {number|string} [key]
 * @returns {any} Preact vnode
 */
export function noticeLineNode(line, key) {
  if (typeof line === 'string') return html`<p class="notice__line" key=${key}>${line}</p>`;
  if (!line || line.spacer || !Array.isArray(line.segments) || !line.segments.length) {
    return html`<p class="notice__line notice__line--spacer" key=${key} aria-hidden="true"></p>`;
  }
  return html`<p class="notice__line" key=${key}>${line.segments.map((seg) => noticeSegmentNode(seg))}</p>`;
}

/**
 * One normalized section → its <div>: the small dim label row first (when the section has one), then its lines in
 * order. Pure, so the label→content order is unit-tested without a browser.
 * @param {{ label?: string, lines?: any[] }} section
 * @param {number|string} [key]
 * @returns {any} Preact vnode
 */
export function noticeSectionNode(section, key) {
  const label = typeof section?.label === 'string' ? section.label : '';
  const lines = Array.isArray(section?.lines) ? section.lines : [];
  return html`<div class="notice__section" key=${key}>
    ${label ? html`<p class="notice__label">${label}</p>` : null}
    ${lines.map((line, i) => noticeLineNode(line, i))}
  </div>`;
}

/**
 * The notice client: an observable store ({ open, status, notice }) plus the fetch around /data/notice.json.
 * @param {{ fetch?: typeof fetch, url?: string, warn?: (...a: any[]) => void, store?: object }} [opts]
 *   injectable for tests (the browser uses the defaults).
 * @returns {{ store: object, open: () => Promise<object>, close: () => void, toggle: () => any,
 *             refresh: () => Promise<object> }}
 */
export function createNoticeClient(opts = {}) {
  const doFetch = opts.fetch || ((url, init) => globalThis.fetch(url, init));
  const url = opts.url || NOTICE_URL;
  const warn = opts.warn || ((...a) => console.warn(...a));
  const store = opts.store || createStore({ open: false, status: 'idle', notice: fallbackNotice() });
  let inFlight = null;

  /** Read the file once (`no-cache`: a republished notice is picked up) and store the result — fallback on any error. */
  const refresh = () => {
    if (inFlight) return inFlight;
    store.set({ status: 'loading' });
    inFlight = (async () => {
      let notice;
      try {
        const res = await doFetch(url, { cache: 'no-cache' });
        if (!res || !res.ok) throw Object.assign(new Error(`HTTP ${res ? res.status : '???'}`), { status: res ? res.status : null });
        notice = normalizeNotice(await res.json());
        store.set({ status: 'ready', notice });
        if (notice.fallback) warn(`[notice] ${url} holds no usable text; showing the built-in notice`);
      } catch (err) {
        notice = fallbackNotice();
        store.set({ status: 'failed', notice });
        warn(`[notice] ${url} unavailable (${err?.message || err}); showing the built-in notice`);
      } finally {
        inFlight = null;
      }
      return notice;
    })();
    return inFlight;
  };

  /** Open the panel and (re)read the notice — the click path; returns the refresh promise (tests await it). */
  const open = () => {
    store.set({ open: true });
    return refresh();
  };
  const close = () => { store.set({ open: false }); };
  const toggle = () => (store.get().open ? close() : open());
  return { store, open, close, toggle, refresh };
}

/** The client the UI uses. */
export const noticeClient = createNoticeClient();
export const noticeStore = noticeClient.store;
export const openNotice = noticeClient.open;
export const closeNotice = noticeClient.close;

/** Standard 公告 trigger button — GuideButton's twin (same size / variant / label idiom). */
export function NoticeButton({ class: cls, size = 'sm', variant = 'ghost', label = '公告', square = false, onClick = openNotice }) {
  return html`<${Button} variant=${variant} size=${size} icon="info" square=${square} class=${cx('notice-btn', cls)}
    onClick=${onClick} title="公告" aria-label="公告">${square ? null : label}<//>`;
}

/** The panel (mounted once near the root): the shared Modal supplies the close affordances. Two columns — the notice
 *  text on the left, the sponsorship QR on the right (ui/sponsor.js, .notice__layout in css/screens/title.css). */
export function NoticeHost() {
  const { open, status, notice } = useStore((s) => s, Object.is, noticeStore);
  return html`<${Modal} open=${open} onClose=${closeNotice} title=${notice.title} micro="NOTICE // 公告" width="min(9.6rem, 94vw)"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${closeNotice}>关闭<//>`}>
    <div class="notice__layout">
      <div class="notice__body">
        ${status === 'loading' ? html`<p class="notice__hint">正在获取公告…</p>` : null}
        ${status === 'failed' ? html`<p class="notice__hint">公告暂时无法加载，以下为内置说明。</p>` : null}
        ${notice.sections.map((section, i) => noticeSectionNode(section, i))}
        ${notice.updatedAt ? html`<p class="notice__updated num">更新于 ${notice.updatedAt}</p>` : null}
      </div>
      <aside class="notice__side"><${SponsorQr} /></aside>
    </div>
  <//>`;
}
