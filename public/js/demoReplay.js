// public/js/demoReplay.js — in-game visual replay (like a CS demo): the recorded S2C stream is fed back through the
// client's own message bus, so the ordinary Game screen renders the match again — no server re-simulation, no client
// re-simulation, just the frames the player's own client received while playing (user requirement 2026-11-15).
//
// A demo document carries `wire` ([{ at, t, m }]) recorded by demoRecorder.js. Playback swaps the store into a synthetic
// DEMO room + match, dispatches each frame through net._emit (the same handlers main.js/game.js/battle runner subscribe
// to), and restores the previous state on exit. Controls are a fixed bar; playback pauses/scrubs by restarting the
// dispatch cursor against a new base time.

import { html } from './ui/components.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { render } from '../vendor/preact.module.js';
import { net } from './net.js';
import { store, emptyMatch } from './store.js';
import { t } from '../shared/i18n.js';

let session = null;
let uiHost = null;

function ensureStyle() {
  if (document.getElementById('demo-replay-style')) return;
  const st = document.createElement('style');
  st.id = 'demo-replay-style';
  st.textContent = `
.dr-bar{position:fixed;left:50%;bottom:.28rem;transform:translateX(-50%);z-index:120;display:flex;align-items:center;gap:.12rem;
  padding:.12rem .18rem;border-radius:.16rem;background:rgba(10,14,18,.86);border:1px solid rgba(255,255,255,.16);
  color:#e9f2f0;font:600 .2rem/1.2 system-ui,sans-serif;backdrop-filter:blur(6px);max-width:94vw}
.dr-bar button{font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);
  border-radius:.1rem;padding:.08rem .14rem;cursor:pointer}
.dr-bar button:hover{background:rgba(255,255,255,.16)}
.dr-range{width:min(5rem,38vw);accent-color:#4cc9a7}
.dr-time{font-variant-numeric:tabular-nums;opacity:.85;font-size:.18rem}
.dr-tag{opacity:.65;font-size:.17rem}
`;
  document.head.appendChild(st);
}

const fmt = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

function Bar({ s, onToggle, onExit, onSeek, onSpeed }) {
  const [, bump] = useState(0);
  useEffect(() => { s.onTick = () => bump((v) => v + 1); return () => { s.onTick = null; }; }, [s]);
  const total = s.duration || 1;
  return html`<div class="dr-bar">
    <button type="button" onClick=${onToggle} title=${s.playing ? t('暂停') : t('播放')}>${s.playing ? '❚❚' : '▶'}</button>
    <span class="dr-time">${fmt(s.cursor)}</span>
    <input class="dr-range" type="range" min="0" max=${total} step="10" value=${Math.min(total, s.cursor)}
      onInput=${(e) => onSeek(Number(e.currentTarget.value))} />
    <span class="dr-time">${fmt(total)}</span>
    <button type="button" onClick=${() => onSpeed(s.speed === 1 ? 2 : s.speed === 2 ? 4 : 1)}>${s.speed}×</button>
    <span class="dr-tag">${t('Demo 回放')}</span>
    <button type="button" onClick=${onExit} title=${t('退出回放')}>${t('退出')}</button>
  </div>`;
}

/** Dispatch one recorded frame through the client bus (main.js / game.js / battle runner all listen there). */
function dispatch(frame) {
  try { net._emit(frame.t, frame.m); } catch (e) { console.warn('[demo] frame failed', frame.t, e); }
}

/** Advance to `target` ms, dispatching every frame in order. */
function runTo(s, target) {
  const wire = s.doc.wire || [];
  while (s.idx < wire.length && (wire[s.idx].at || 0) <= target) {
    dispatch(wire[s.idx]);
    s.idx++;
  }
  s.cursor = target;
  s.onTick?.();
  if (s.idx >= wire.length) {
    s.playing = false;
    s.cursor = s.duration;
    s.onTick?.();
  }
}

function tick() {
  if (!session || !session.playing) return;
  const s = session;
  const el = (Date.now() - s.base) * s.speed;
  runTo(s, Math.min(s.duration, el));
  if (s.playing) s.timer = setTimeout(tick, 40);
}

function pause(s) {
  if (!s.playing) return;
  s.playing = false;
  clearTimeout(s.timer);
  s.onTick?.();
}

function play(s) {
  if (s.playing || s.idx >= (s.doc.wire || []).length) return;
  s.playing = true;
  s.base = Date.now() - s.cursor / s.speed;
  tick();
  s.onTick?.();
}

function seek(s, ms) {
  // restart the stream from the beginning up to the target; recorded frames replay fast (no rendering cost beyond events)
  s.idx = 0;
  s.playing = false;
  clearTimeout(s.timer);
  store.set({ match: emptyMatch() });
  runTo(s, Math.max(0, Math.min(s.duration, ms)));
  s.base = Date.now() - s.cursor / s.speed;
  if (s.cursor < s.duration) play(s);
}

export function canReplayVisual(doc) { return Array.isArray(doc?.wire) && doc.wire.length > 0; }
export function isReplaying() { return !!session; }

/**
 * Start an in-game replay. Returns false when the document has no wire stream (old text-only demo).
 * @param {any} doc demo document (local IndexedDB or cloud download)
 */
export function startDemoReplay(doc) {
  if (!canReplayVisual(doc)) return false;
  stopDemoReplay();
  const prev = store.get();
  const owner = doc.owner?.playerId || (doc.players || []).find((p) => !p.isBot)?.playerId || 'p_demo';
  const name = doc.owner?.name || (doc.players || []).find((p) => !p.isBot)?.name || t('博士');
  const seats = (doc.players || []).map((p, i) => ({
    seat: Number.isInteger(p.seat) ? p.seat : i, playerId: p.playerId, name: p.name,
    isBot: !!p.isBot, connected: true, ready: true,
  }));
  const me = { ...prev.me, playerId: owner, name, token: null };
  const room = {
    ...prev.room, code: 'DEMO', inMatch: true, seats, spectators: [], mode: 'coop',
    difficulty: doc.difficulty || prev.room?.difficulty || 'NORMAL', hostId: owner, matchCount: 1,
  };
  store.set({ me, room, match: emptyMatch(), session: { ...prev.session, entered: true } });

  ensureStyle();
  if (!uiHost) { uiHost = document.createElement('div'); uiHost.className = 'demo-replay-host'; document.body.appendChild(uiHost); }

  const last = (doc.wire || []).reduce((max, f) => Math.max(max, f.at || 0), 0);
  /** @type {any} */
  const s = {
    doc, idx: 0, cursor: 0, duration: last, playing: true, speed: 1,
    base: Date.now(), timer: 0, prev, onTick: null,
  };
  session = s;

  const exit = () => stopDemoReplay();
  const toggle = () => (s.playing ? pause(s) : play(s));
  const speed = (v) => { s.speed = v; if (s.playing) s.base = Date.now() - s.cursor / s.speed; s.onTick?.(); };
  render(html`<${Bar} s=${s} onToggle=${toggle} onExit=${exit} onSeek=${(ms) => seek(s, ms)} onSpeed=${speed} />`, uiHost);

  tick();
  return true;
}

/** Stop playback and restore the screen the player came from. */
export function stopDemoReplay() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timer);
  try { render(null, uiHost); } catch { /* host gone */ }
  try { uiHost?.remove(); } catch { /* ignore */ }
  uiHost = null;
  try { store.set(s.prev); } catch { /* the app is gone */ }
}
