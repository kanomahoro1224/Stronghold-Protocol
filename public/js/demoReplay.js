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
import { battleRunner, keepsState } from './battle/runner.js';
import { t } from '../../shared/i18n.js';
import { PHASE } from '../../shared/constants.js';

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
  const hold = (!s.playing || s.paused) ? startedAt + s.cursor : null;
  if (force || Math.abs((store.get().clock?.offset || 0) - off) > 100 || store.get().clock?.hold !== hold) {
    store.patch('clock', { offset: off, synced: true, hold });
  }
}
const speedLabel = (v) => (v === 0.25 ? '¼×' : v === 0.5 ? '½×' : `${v}×`);

/** 这条帧会结束一场战斗 / 整局：必须等本地战斗真的打完再发，否则怪还在打就弹出「完美作战」。 */
const ENDS_BATTLE = (f) => f.t === 'b.end' || f.t === 'm.result' || (f.t === 'm.public' && f.m?.phase === PHASE.RESULT);
/** A seek / catch-up may be genuinely long (a stale page loading a battle), but the progress bar must not run to the
 *  result while the sim is still behind it. The end wait has no time cap: a battle that is still running is not a
 *  result, and showing 「完美作战」 early is exactly the report this guards. */
const CATCHUP_WAIT_MS = 120_000;

/** 本地战斗 sim 是否还没结束（回放按真实战斗动画等待，不抢跑结算）。 */
function battleStillRunning() {
  try {
    const st0 = battleRunner?.state?.();
    if (st0?.loading) return true; // b.start 的 sim 还在加载/准备
    const entries = battleRunner?._entries;
    if (entries && entries.size) {
      for (const e of entries.values()) if (e && e.battle && !e.done) return true;
      return false;
    }
    const st = battleRunner?.state?.();
    return !!st && st.done === false;
  } catch { return false; }
}

/** 跳转后战斗 sim 是否已快进到目标时刻（entries 还没建出来 = 继续等）。 */
function catchUpDone(s) {
  const entries = battleRunner?._entries;
  if (!entries) return true;
  for (const t of s.catchTargets.values()) {
    let seen = false;
    for (const e of entries.values()) {
      if (!e || e.battleId !== t.battleId) continue;
      seen = true;
      if (e.done) continue;
      const ticks = e.battle?.tickCount || 0;
      const expected = t.elapsed * 30; // runner: t0 = clock - elapsed/speed*1000 ⇒ 目标 tick = elapsed / (1/30)
      if (ticks + 1 < expected) return false;
    }
    if (!seen) return false; // 还在 pending / 下载内容
  }
  return true;
}

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
      <span class="dr-time">${s.catchingUp ? t('战斗快进中…') : `${fmt(s.cursor)} / ${fmt(total)}`}</span>
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
  if (session?.paused) return; // 暂停期间任何已排队帧都不再派发
  try { net._emit(frame.t, frame.m); } catch (e) { console.warn('[demo] frame failed', frame.t, e); }
}

/**
 * Game 的 b.snap/b.ev 订阅在 view 挂载后才建立（真实 Chromium 验证：刚进 DEMO 的 300ms 内可能还没好）。
 * 等订阅出现再喂战斗帧；否则 m.field 已进 store，但 spawn / snapshot 全丢，画面只剩棋盘。
 */
function afterFramesReady(s, fn) {
  clearTimeout(s.readyTimer);
  const seq = (s.readySeq || 0) + 1;
  s.readySeq = seq;
  const began = Date.now();
  const poll = () => {
    if (session !== s || s.readySeq !== seq) return;
    const listeners = net._listeners?.get('b.snap')?.size || 0;
    if (listeners > 0 || Date.now() - began > 10_000) { fn(); return; }
    s.readyTimer = setTimeout(poll, 40);
  };
  poll();
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
    if (s.snapshotMode && f.t === 'b.start') { s.idx++; continue; } // 新 Demo 直接放录下的战斗帧，不重跑模拟
    if (!s.snapshotMode && ENDS_BATTLE(f)) {
      const now = Date.now();
      // 本地战斗没打完 → 等；刚打完也留 300ms 给死亡动画，避免「怪还在」就弹完美作战。
      // No timeout here: the old 20 s fallback could dispatch the result while a long battle was still running.
      if (battleStillRunning()) {
        if (!s.waiting) { s.waiting = true; s.waitAt = now; }
        s.onTick?.();
        return;
      } else if (!s.endGraceAt) {
        s.endGraceAt = now;
        s.waiting = true;
        s.waitAt = now;
        s.onTick?.();
        return;
      } else if (now - s.endGraceAt < 300) {
        s.waiting = true;
        s.onTick?.();
        return;
      }
      s.endGraceAt = 0;
    }
    s.waiting = false;
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
    syncReplayClock(s, true);
    holdClock(s);
  }
}

function tick() {
  if (!session || !session.playing) return;
  const s = session;
  if (s.catchingUp) {
    // 跳转后先让战斗 sim 真正算到目标时刻，再继续放帧；否则进度条会跑到结算，战斗还在后面追。
    // A failed/missing sim must not freeze the player forever; after the guard the loop refuses to dispatch a result
    // until the battle itself is done (runTo's end wait), so the bar cannot claim a perfect clear early.
    if (!catchUpDone(s) && Date.now() - (s.catchSince || 0) < CATCHUP_WAIT_MS) {
      syncReplayClock(s);
      s.timer = setTimeout(tick, 40);
      return;
    }
    s.catchingUp = false;
    s.base = Date.now() - s.cursor / s.speed;
    s.onTick?.();
  }
  if (s.waiting) {
    // 等战斗结束期间冻结进度与时钟，结束后把等待时长从 base 里补掉。No timeout: see runTo.
    if (battleStillRunning()) {
      syncReplayClock(s);
      s.timer = setTimeout(tick, 40);
      return;
    }
    s.waiting = false;
    s.base += Date.now() - (s.waitAt || Date.now());
  }
  const el = (Date.now() - s.base) * s.speed;
  runTo(s, Math.min(s.duration, el));
  syncReplayClock(s);
  if (s.playing) s.timer = setTimeout(tick, 40);
}

/** 暂停期间 serverNow = Date.now() + offset 仍会随墙钟走：持续把 offset 拉回游标位置，右上角才真的停住。 */
function holdClock(s) {
  clearInterval(s.clockTimer);
  s.clockTimer = setInterval(() => { if (session === s) syncReplayClock(s, true); else clearInterval(s.clockTimer); }, 250);
}

function pause(s) {
  if (!s.playing) return;
  s.paused = true;
  s.playing = false;
  clearTimeout(s.timer);
  s.timer = 0;
  // 真暂停：冻结战斗 sim 时钟与回放时钟（右上角倒计时停在同一秒）
  battleRunner?.setPaused?.(true);
  syncReplayClock(s, true);
  holdClock(s);
  s.onTick?.();
}

function play(s) {
  if (s.playing) return;
  s.paused = false;
  clearInterval(s.clockTimer);
  if (s.idx >= (s.doc.wire || []).length) { seek(s, 0, true); return; }
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
function seek(s, ms, autoplay = s.playing) {
  clearInterval(s.clockTimer);
  s.paused = false;
  s.waiting = false;
  s.endGraceAt = 0;
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
  const latestSnap = new Map(); // 快照模式 seek：只补目标时刻最近一张，不重放整段动画
  const stateEvents = []; // 只补 spawn/deploy/die/status 等状态事件（与 runner 的 catch-up 同一规则）
  s.active = active;
  let idx = 0;
  for (; idx < wire.length; idx++) {
    const f = wire[idx];
    if ((f.at || 0) > target) break;
    if (f.t === 'b.start' && f.m?.fieldId) active.set(f.m.fieldId, f);
    else if (f.t === 'b.end' && f.m?.fieldId) active.delete(f.m.fieldId);
    if (s.snapshotMode) {
      if (f.t === 'b.snap') latestSnap.set(f.m?.fieldId || '', f);
      else if (f.t === 'b.ev') {
        const ev = (f.m?.ev || []).filter(keepsState);
        if (ev.length) stateEvents.push({ t: 'b.ev', m: { ...f.m, ev } });
      } else if (f.t === 'b.start') { /* 快照模式不重跑模拟 */ }
      else dispatch(f);
    } else if (f.t !== 'b.start' && f.t !== 'b.snap' && f.t !== 'b.ev' && f.t !== 'b.end' && f.t !== 'b.pool') dispatch(f);
  }
  s.active = active;
  s.idx = idx;
  s.cursor = target;
  s.catchingUp = true; // 等 Game 订阅就绪（条上显示「战斗快进中…」）
  syncReplayClock(s, true);
  s.onTick?.();
  afterFramesReady(s, () => {
    for (const f of stateEvents) dispatch(f);
    for (const f of latestSnap.values()) dispatch(f);
    const catchTargets = new Map();
    for (const f of s.snapshotMode ? [] : active.values()) {
      const elapsed = (Number(f.m.elapsed) || 0) + (target - (f.at || 0)) / 1000;
      dispatch({ t: 'b.start', m: { ...f.m, elapsed: Math.max(0, elapsed), replaySeek: true } });
      if (f.m.battleId) catchTargets.set(f.m.battleId, { battleId: f.m.battleId, elapsed: Math.max(0, elapsed) });
    }
    s.catchTargets = catchTargets;
    s.catchingUp = catchTargets.size > 0;
    s.catchSince = Date.now();
    s.base = Date.now() - s.cursor / s.speed;
    s.onTick?.();
    if (autoplay && s.cursor < s.duration) play(s);
    else {
      s.paused = true;
      s.playing = false;
      syncReplayClock(s, true);
      holdClock(s); // 暂停中拖动：停在目标帧，不擅自恢复播放
      s.onTick?.();
    }
  });
}

/** Switch a paused or playing team replay to another field without moving the cursor / clock. */
function switchTeamField(s, fieldId) {
  const target = Number(s.cursor) || 0;
  const wasPlaying = s.playing;
  s.team.fieldId = fieldId;
  s.doc = { ...s.doc, wire: teamWireFor(s.team.source, fieldId) };
  s.battleMarks = battleMarksOf(s.doc, s.duration);
  const fields = teamFields(s.team.source);
  s.team.fields = fields;
  // seek rebuilds the selected field from its own frames; autoplay follows the previous play/pause state
  seek(s, target, wasPlaying);
}

/** A team document's viewer: the server already filtered privates to this account, so its only key is the viewer. */
export function teamViewerId(doc) {
  const keys = Object.keys(doc?.privates || {});
  if (keys.length) return keys[0];
  return (doc?.players || []).find((p) => p && !p.isBot)?.playerId || null;
}

/** Available fields of a team document, owner first. */
export function teamFields(doc) {
  return Object.entries(doc?.fields || {}).map(([fieldId, f]) => ({ fieldId, owner: f.owner || null, degraded: !!f.degraded }));
}

/**
 * Turn one team field into the same flat wire stream the single-player replay already understands:
 * public timeline + this field's frames + this viewer's private frames. Switching a field just rebuilds this array.
 */
export function teamWireFor(doc, fieldId) {
  const f = doc?.fields?.[fieldId];
  if (!f) return [];
  const meta = f.initialFieldMeta || f.fieldMeta || {};
  const frames = (f.frames || []).map((x) => ({ at: x.at, t: x.t, m: x.m }));
  const viewer = teamViewerId(doc);
  const privateFrames = (doc.privates?.[viewer] || []).map((x) => ({ at: x.at, t: x.t, m: x.m }));
  // The settlement must be the last frame the replay reaches — after the final snapshot and any private frame. If it
  // shares a timestamp with the final snapshot, a stable sort would otherwise deliver it first and show "完美作战"
  // while the recorded enemies are still standing.
  const lastDataAt = Math.max(
    frames.reduce((m, x) => Math.max(m, Number(x.at) || 0), 0),
    (doc.public || []).reduce((m, x) => Math.max(m, Number(x.at) || 0), 0),
    privateFrames.reduce((m, x) => Math.max(m, Number(x.at) || 0), 0),
  );
  const resultAt = Math.max(Number(doc.result?.at) || 0, lastDataAt);
  const resultFrame = doc.result?.t ? { at: resultAt, t: doc.result.t, m: doc.result.m } : null;
  // A public RESULT frame recorded before the final data would switch the screen to the result while the final
  // enemies are still on it; clamp end-of-match public frames.
  const isEndPublic = (x) => x.t === 'm.public' && x.m?.phase === PHASE.RESULT;
  const publicFrames = (doc.public || []).map((x) => (isEndPublic(x) ? { at: Math.max(Number(x.at) || 0, lastDataAt), t: x.t, m: x.m } : { at: x.at, t: x.t, m: x.m }));
  const wire = [
    ...publicFrames,
    // A recorder's local battle flag must not make the replay ask the runner to re-show a live sim; this field is a
    // recorded frame stream played back through the normal renderer.
    { at: 0, t: 'm.field', m: { ...meta, fieldId, local: false } },
    ...frames,
    ...privateFrames,
  ];
  if (resultFrame) wire.push(resultFrame);
  // At an equal timestamp the settlement must still be the last frame, or the final snapshot would precede
  // "完美作战" and the result card would show before the last enemies die.
  const endFrame = (f) => f === resultFrame || isEndPublic(f);
  wire.sort((a, b) => (a.at || 0) - (b.at || 0) || (endFrame(a) ? 1 : 0) - (endFrame(b) ? 1 : 0));
  return wire;
}

/** The synthetic single-field doc used by the existing replay engine. */
function teamViewDoc(doc, fieldId) {
  const viewer = teamViewerId(doc);
  const owner = (doc.players || []).find((p) => p.playerId === (doc.fields?.[fieldId]?.owner || viewer));
  return {
    ...doc,
    id: doc.id || `team_${doc.matchId || ''}`,
    owner: { playerId: viewer, name: owner?.name || null },
    wire: teamWireFor(doc, fieldId),
  };
}

export function canReplayVisual(doc) {
  return (Array.isArray(doc?.wire) && doc.wire.length > 0)
    || !!(doc?.kind === 'team' && doc?.fields && doc?.public);
}
export function isReplaying() { return !!session; }

/**
 * Start an in-game replay. Returns false when the document has no wire stream (old text-only demo).
 * @param {any} doc demo document (local IndexedDB or cloud download)
 */
export function startDemoReplay(input) {
  if (!canReplayVisual(input)) return false;
  const team = input?.kind === 'team' ? input : null;
  const viewer = team ? teamViewerId(team) : null;
  const fields = team ? teamFields(team) : [];
  const firstField = fields.find((f) => f.owner === viewer)?.fieldId || fields[0]?.fieldId || null;
  const doc = team ? teamViewDoc(team, firstField) : input;
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
    doc, team: team ? { source: team, viewer, fieldId: firstField, fields } : null,
    snapshotMode: team ? true : (doc.wire || []).some((f) => f.local), idx: 0, cursor: 0, duration, playing: true, speed: 1,
    base: Date.now(), timer: 0, clockTimer: 0, prev, onTick: null, active: new Map(), lastSync: 0,
    marks: marksOf(doc).filter((m) => m.at <= duration), battleMarks: battleMarksOf(doc, duration), drag: false, paused: false, waiting: false, waitAt: 0, endGraceAt: 0, catchingUp: false, catchTargets: new Map(), catchSince: 0,
  };
  session = s;

  s.exit = () => stopDemoReplay();
  s.toggle = () => (s.playing ? pause(s) : (s.idx >= (s.doc.wire || []).length ? seek(s, 0, true) : play(s)));
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
  // 游戏自己的暂停按钮 / 空格发的是 g.pause：回放里改成控制回放；其余 g.* 一律不发服务器
  const origRequest = net.request.bind(net);
  net.request = (type, fields) => {
    if (session === s && typeof type === 'string' && type.startsWith('g.')) {
      if (type === 'g.pause') {
        // 游戏按钮 / 空格的 on 状态依赖 m.public.paused（回放里不会变），这里一律按「切换」处理
        if (s.playing) pause(s); else play(s);
      } else if (type === 'g.watch') {
        if (!s.team) return Promise.resolve({ ok: false, replay: true, error: 'REPLAY_NO_TEAM' });
        const target = fields && typeof fields === 'object' ? fields.fieldId : null;
        if (!target || !s.team.fields.some((f) => f.fieldId === target)) return Promise.resolve({ ok: false, replay: true, error: 'REPLAY_NO_FIELD' });
        switchTeamField(s, target);
      }
      return Promise.resolve({ ok: true, replay: true });
    }
    return origRequest(type, fields);
  };
  s.restoreRequest = () => { net.request = origRequest; };

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
  afterFramesReady(s, () => { if (s.playing) { s.base = Date.now() - s.cursor / s.speed; tick(); } });
  return true;
}

/** Stop playback and restore the screen the player came from. */
export function stopDemoReplay() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timer);
  clearTimeout(s.readyTimer);
  s.readySeq = (s.readySeq || 0) + 1;
  clearInterval(s.clockTimer);
  try { s.unsub?.(); } catch { /* ignore */ }
  try { s.restoreRequest?.(); } catch { /* ignore */ }
  try { render(null, uiHost); } catch { /* host gone */ }
  try { uiHost?.remove(); } catch { /* ignore */ }
  uiHost = null;
  try { battleRunner?.setPaused?.(false); } catch { /* ignore */ }
  try { battleRunner?.clear?.(); } catch { /* ignore */ }
  try { store.set(s.prev); } catch { /* the app is gone */ }
}
