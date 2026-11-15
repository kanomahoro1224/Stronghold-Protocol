// public/js/demoReplay.js — in-game visual replay (like a CS demo): the recorded S2C stream is fed back through the
// client's own message bus, so the ordinary Game screen renders the match again — no server re-simulation, no client
// re-simulation, just the frames the player's own client received while playing (user requirement 2026-11-15).
//
// A demo document carries `wire` ([{ at, t, m }]) recorded by demoRecorder.js and `marks` (round boundaries). Playback
// swaps the store into a synthetic DEMO room + match, dispatches each frame through net._emit (the same handlers
// main.js / game.js / the battle runner subscribe to), and restores the previous state on exit.
//
// Controls follow the owner's reference (screenshot 2026-11-15): a thin ticked timeline with one white dot per round,
// `time / total`, −15 s / +15 s, previous / next round, `回合: N`, and ¼× ½× 1× 2× 4× 8× speed buttons.

import { html } from './ui/components.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { render } from '../vendor/preact.module.js';
import { net } from './net.js';
import { store, emptyMatch, selectRoute } from './store.js';
import { battleRunner } from './battle/runner.js';
import { t } from '../shared/i18n.js';

let session = null;
let uiHost = null;

function ensureStyle() {
  if (document.getElementById('demo-replay-style')) return;
  const st = document.createElement('style');
  st.id = 'demo-replay-style';
  st.textContent = `
.dr-bar{position:fixed;left:0;right:0;bottom:0;z-index:120;background:rgba(12,15,18,.92);border-top:1px solid rgba(255,255,255,.14);
  color:#e9f2f0;font:600 .18rem/1.3 system-ui,sans-serif;padding:.1rem .22rem .12rem;backdrop-filter:blur(6px);
  display:flex;flex-direction:column;gap:.08rem}
.dr-track{position:relative;height:.14rem;cursor:pointer;touch-action:none}
.dr-track::before{content:'';position:absolute;inset:.03rem 0 .02rem;background:
  repeating-linear-gradient(90deg,rgba(255,255,255,.22) 0 1px,transparent 1px 2.06%);border-radius:.02rem}
.dr-fill{position:absolute;left:0;top:.03rem;bottom:.02rem;background:rgba(120,220,255,.28);pointer-events:none}
.dr-mark{position:absolute;top:0;bottom:0;width:.07rem;margin-left:-.035rem;background:#fff;border-radius:.05rem;pointer-events:auto}
.dr-mark--battle{top:.035rem;bottom:.025rem;width:2px;margin-left:-1px;border-radius:1px;background:rgba(255,255,255,.92)}
.dr-head{position:absolute;top:-.02rem;bottom:-.02rem;width:2px;margin-left:-1px;background:#7fe0ff;pointer-events:none}
.dr-row{display:flex;align-items:center;gap:.12rem;flex-wrap:wrap}
.dr-time{font-variant-numeric:tabular-nums;opacity:.92;font-size:.18rem;min-width:1.1rem}
.dr-btn{font:inherit;color:#cfd8d6;background:transparent;border:0;padding:.02rem .05rem;cursor:pointer;border-radius:.06rem}
.dr-btn:hover{color:#fff;background:rgba(255,255,255,.1)}
.dr-spd{font:inherit;color:#9fb0ad;background:transparent;border:0;padding:.02rem .06rem;cursor:pointer;font-variant-numeric:tabular-nums}
.dr-spd--on{color:#fff;font-weight:900}
.dr-round{margin-left:.08rem;opacity:.8;font-size:.17rem;min-width:1.1rem;text-align:center}
.dr-exit{margin-left:auto;font:inherit;color:#ffb1a1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:.08rem;padding:.05rem .12rem;cursor:pointer}
`;
  document.head.appendChild(st);
}

const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

/** HUD 的回合倒计时读 serverNow()：把全局时钟偏移调到「录制开始 + 回放游标」，右上角时间才会随回放流动。 */
function syncReplayClock(s, force = false) {
  const startedAt = Number(s.doc.startedAt);
  if (!Number.isFinite(startedAt)) return;
  const now = Date.now();
  if (!force && now - (s.clockAt || 0) < 200) return;
  s.clockAt = now;
  const off = startedAt + s.cursor - Date.now();
  if (force || Math.abs((store.get().clock?.offset || 0) - off) > 100) store.patch('clock', { offset: off, synced: true });
}
const speedLabel = (v) => (v === 0.25 ? '¼×' : v === 0.5 ? '½×' : `${v}×`);

/** 回合标记：优先用录制时记下的 marks；老文档从 wire 的 m.public 回合变化推导。 */
/** 战斗开始短标：从 wire 的 b.start 帧推导（每场战斗一条），老 Demo 也有。 */
function battleMarksOf(doc, duration) {
  const seen = new Set();
  const out = [];
  for (const f of doc.wire || []) {
    if (f.t !== 'b.start') continue;
    const at = Math.max(0, Number(f.at) || 0);
    if (at > duration) continue;
    const key = f.m?.battleId ? `${f.m.fieldId || ''}:${f.m.battleId}` : `${f.m?.fieldId || ''}:${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at, fieldId: f.m?.fieldId || '' });
  }
  return out.slice(0, 400);
}

function marksOf(doc) {
  if (Array.isArray(doc.marks) && doc.marks.length) {
    const seen = new Set();
    return doc.marks.map((m) => ({ at: Math.max(0, Number(m.at) || 0), round: m.round ?? 0 }))
      .filter((m) => (seen.has(m.round) ? false : seen.add(m.round)))
      .sort((a, b) => a.at - b.at);
  }
  const out = [];
  let last = null;
  for (const f of doc.wire || []) {
    if (f.t !== 'm.public' || !Number.isInteger(f.m?.round)) continue;
    if (f.m.round !== last) { last = f.m.round; out.push({ at: f.at || 0, round: f.m.round }); }
  }
  return out;
}

function Bar({ s }) {
  const [, bump] = useState(0);
  useEffect(() => { s.onTick = () => bump((v) => v + 1); return () => { s.onTick = null; }; }, [s]);
  const total = s.duration || 1;
  const pct = Math.min(100, (s.cursor / total) * 100);
  const curRound = (() => {
    let r = 0;
    for (const m of s.marks) if (m.at <= s.cursor) r = m.round;
    return r;
  })();
  const at = (clientX, el) => {
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
  };
  return html`<div class="dr-bar">
    <div class="dr-track" onPointerDown=${(e) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      s.drag = true;
      s.preview(at(e.clientX, e.currentTarget));
    }} onPointerMove=${(e) => { if (s.drag) s.preview(at(e.clientX, e.currentTarget)); }}
      onPointerUp=${(e) => {
        if (!s.drag) return;
        s.drag = false;
        s.seek(at(e.clientX, e.currentTarget));
      }} onPointerCancel=${() => { s.drag = false; }}>
      <div class="dr-fill" style=${`width:${pct}%`}></div>
      ${s.battleMarks.map((m) => html`<span class="dr-mark dr-mark--battle" style=${`left:${(m.at / total) * 100}%`}
        title=${t('战斗开始')}></span>`)}
      ${s.marks.map((m) => html`<span key=${m.round} class="dr-mark" style=${`left:${(m.at / total) * 100}%`}
        title=${t('回合 {n} 开始', { n: m.round })}></span>`)}
      <div class="dr-head" style=${`left:${pct}%`}></div>
    </div>
    <div class="dr-row">
      <span class="dr-time">${fmt(s.cursor)} / ${fmt(total)}</span>
      <button type="button" class="dr-btn" onClick=${() => s.seek(s.cursor - 15000)}>-15s</button>
      <button type="button" class="dr-btn" title=${t('播放/暂停')} onClick=${() => s.toggle()}>${s.playing ? '❚❚' : '▶'}</button>
      <button type="button" class="dr-btn" onClick=${() => s.seek(s.cursor + 15000)}>+15s</button>
      <button type="button" class="dr-btn" title=${t('上一回合')} onClick=${() => s.prevRound()}>⏮</button>
      <span class="dr-round">${t('回合')}: ${curRound}</span>
      <button type="button" class="dr-btn" title=${t('下一回合')} onClick=${() => s.nextRound()}>⏭</button>
      ${SPEEDS.map((v) => html`<button type="button" class=${`dr-spd ${s.speed === v ? 'dr-spd--on' : ''}`}
        onClick=${() => s.setSpeed(v)}>${speedLabel(v)}</button>`)}
      <button type="button" class="dr-exit" onClick=${() => s.exit()}>${t('退出')}</button>
    </div>
  </div>`;
}

/** Dispatch one recorded frame through the client bus (main.js / game.js / battle runner all listen there). */
function dispatch(frame) {
  try { net._emit(frame.t, frame.m); } catch (e) { console.warn('[demo] frame failed', frame.t, e); }
}

/** 记录一条已派发的战斗开始/结束帧（用于倍速对齐与跳转）。 */
function noteBattle(s, frame) {
  if (frame.t === 'b.start' && frame.m?.fieldId) s.active.set(frame.m.fieldId, frame);
  else if (frame.t === 'b.end' && frame.m?.fieldId) s.active.delete(frame.m.fieldId);
}

/** Advance to `target` ms, dispatching every frame in order. */
function runTo(s, target) {
  const wire = s.doc.wire || [];
  while (s.idx < wire.length && (wire[s.idx].at || 0) <= target) {
    const f = wire[s.idx];
    dispatch(f);
    noteBattle(s, f);
    s.idx++;
  }
  s.cursor = Math.min(target, s.duration);
  s.onTick?.();
  if (s.idx >= wire.length) {
    s.playing = false;
    s.cursor = s.duration;
    // 播完停在最后一帧：冻结战斗 sim，不继续在后台空跑
    battleRunner?.setPaused?.(true);
    s.onTick?.();
  }
}

function tick() {
  if (!session || !session.playing) return;
  const s = session;
  const el = (Date.now() - s.base) * s.speed;
  runTo(s, Math.min(s.duration, el));
  syncReplayClock(s);
  if (s.playing) s.timer = setTimeout(tick, 40);
}

function pause(s) {
  if (!s.playing) return;
  s.playing = false;
  clearTimeout(s.timer);
  // 真暂停：冻结战斗 sim 时钟与回放时钟（右上角倒计时停在同一秒）
  battleRunner?.setPaused?.(true);
  syncReplayClock(s, true);
  s.onTick?.();
}

function play(s) {
  if (s.playing) return;
  if (s.idx >= (s.doc.wire || []).length) { seek(s, 0); return; }
  battleRunner?.setPaused?.(false);
  s.playing = true;
  s.base = Date.now() - s.cursor / s.speed;
  tick();
  s.onTick?.();
}

/**
 * 跳到 `ms`：不从战斗第 0 秒重放。
 *   1) 只重发非战斗帧（m.public / m.private / m.field / m.result / m.ticker）到目标时刻，重建棋盘；
 *   2) 对目标时刻仍在进行的战斗，重发一条 b.start，并把 `elapsed` 加上「战斗开始 → 目标时刻」的秒数，
 *      让战斗 runner 从该时刻快进（runner 的 existing.elapsed / t0 会按新值对齐）；
 *   3) 游标从目标时刻之后继续播放。
 * 这样拖到某一回合中间，单位位置、战斗进度与进度条一致，而不是每次从头打。
 */
function seek(s, ms) {
  const target = Math.max(0, Math.min(s.duration, ms));
  s.playing = false;
  clearTimeout(s.timer);
  // 先恢复战斗时钟再重建：否则暂停期间的 setPaused(false) 会把新 b.start 的 t0 平移整个暂停时长
  try { battleRunner?.setPaused?.(false); } catch { /* ignore */ }
  // 清掉上一位置的战斗 sim，避免拖动时新旧战斗重叠
  try { battleRunner?.clear?.(); } catch { /* ignore */ }
  store.set({ match: emptyMatch() });
  const wire = s.doc.wire || [];
  /** @type {Map<string, any>} fieldId → 该战斗最近一次 b.start 帧（b.end 前的） */
  const active = new Map();
  s.active = active;
  let idx = 0;
  for (; idx < wire.length; idx++) {
    const f = wire[idx];
    if ((f.at || 0) > target) break;
    if (f.t === 'b.start' && f.m?.fieldId) active.set(f.m.fieldId, f);
    else if (f.t === 'b.end' && f.m?.fieldId) active.delete(f.m.fieldId);
    if (f.t !== 'b.start' && f.t !== 'b.snap' && f.t !== 'b.ev' && f.t !== 'b.end' && f.t !== 'b.pool') dispatch(f);
  }
  for (const f of active.values()) {
    const elapsed = (Number(f.m.elapsed) || 0) + (target - (f.at || 0)) / 1000;
    dispatch({ t: 'b.start', m: { ...f.m, elapsed: Math.max(0, elapsed), replaySeek: true } });
  }
  s.active = active;
  s.idx = idx;
  s.cursor = target;
  syncReplayClock(s);
  s.onTick?.();
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
  const ownerId = doc.owner?.playerId
    || (doc.wire || []).find((f) => f.t === 'm.private' && f.m?.playerId)?.m.playerId
    || (doc.players || []).find((p) => !p.isBot)?.playerId || 'p_demo';
  const ownerName = doc.owner?.name || (doc.players || []).find((p) => p.playerId === ownerId)?.name
    || (doc.players || []).find((p) => !p.isBot)?.name || t('博士');
  const seats = (doc.players || []).map((p, i) => ({
    seat: Number.isInteger(p.seat) ? p.seat : i, playerId: p.playerId, name: p.name,
    isBot: !!p.isBot, connected: true, ready: true,
  }));
  const me = { ...prev.me, playerId: ownerId, name: ownerName, token: null };
  const room = {
    ...prev.room, code: 'DEMO', inMatch: true, seats, spectators: [], mode: 'coop',
    difficulty: doc.difficulty || prev.room?.difficulty || 'NORMAL', hostId: ownerId, matchCount: 1,
  };
  try { battleRunner?.clear?.(); } catch { /* ignore */ }
  store.set({ me, room, match: emptyMatch(), session: { ...prev.session, entered: true } });

  ensureStyle();
  if (!uiHost) { uiHost = document.createElement('div'); uiHost.className = 'demo-replay-host'; document.body.appendChild(uiHost); }

  const last = (doc.wire || []).reduce((max, f) => Math.max(max, f.at || 0), 0);
  const endAt = Number.isFinite(Number(doc.endedAt)) ? Number(doc.endedAt) - Number(doc.startedAt) : 0;
  const duration = Math.max(last, endAt, (doc.snapshots || []).reduce((m, f) => Math.max(m, f.at || 0), 0));
  const s = {
    doc, idx: 0, cursor: 0, duration, playing: true, speed: 1,
    base: Date.now(), timer: 0, prev, onTick: null, active: new Map(), lastSync: 0,
    marks: marksOf(doc).filter((m) => m.at <= duration), battleMarks: battleMarksOf(doc, duration), drag: false,
  };
  session = s;

  s.exit = () => stopDemoReplay();
  s.toggle = () => (s.playing ? pause(s) : (s.idx >= (s.doc.wire || []).length ? seek(s, 0) : play(s)));
  s.preview = (ms) => { s.cursor = Math.max(0, Math.min(s.duration, ms)); s.onTick?.(); };
  s.setSpeed = (v) => { s.speed = v; if (s.playing) s.base = Date.now() - s.cursor / s.speed; s.onTick?.(); };
  s.seek = (ms) => seek(s, ms);
  s.prevRound = () => {
    let target = 0;
    for (const m of s.marks) if (m.at < s.cursor - 1500) target = m.at;
    seek(s, target);
  };
  s.nextRound = () => {
    const next = s.marks.find((m) => m.at > s.cursor + 1500);
    seek(s, next ? next.at : s.duration);
  };

  // 老 Demo 的 wire 从第二条消息起录（首帧 m.public 漏录）：用首张快照补一条，保证回放直接进对局画面
  const first = (doc.wire || [])[0];
  const snap0 = (doc.snapshots || [])[0];
  if (snap0 && first?.t !== 'm.public') {
    dispatch({ t: 'm.public', m: { ...snap0, players: doc.players || snap0.players || [] } });
  }
  syncReplayClock(s);
  // 玩家从游戏自己的「离开」退出（而不是回放条）时，回放必须跟着结束，否则 timer 会继续喂帧把人拉回对局
  s.unsub = store.subscribe(() => {
    if (session !== s || s.suppress) return;
    const st = store.get();
    if (st.room?.code !== 'DEMO' || !st.session?.entered || selectRoute(st) !== 'game') {
      s.suppress = true;
      stopDemoReplay();
      s.suppress = false;
    }
  });

  render(html`<${Bar} s=${s} />`, uiHost);
  tick();
  return true;
}

/** Stop playback and restore the screen the player came from. */
export function stopDemoReplay() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timer);
  try { s.unsub?.(); } catch { /* ignore */ }
  try { render(null, uiHost); } catch { /* host gone */ }
  try { uiHost?.remove(); } catch { /* ignore */ }
  uiHost = null;
  try { battleRunner?.setPaused?.(false); } catch { /* ignore */ }
  try { battleRunner?.clear?.(); } catch { /* ignore */ }
  try { store.set(s.prev); } catch { /* the app is gone */ }
}
