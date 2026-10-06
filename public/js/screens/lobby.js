// Lobby screen: pick 独立模拟 / 同盟模拟 and a difficulty (标准/险境/绝境/终极), create a room,
// or join one with a 同盟密钥 (recent codes remembered) — as a player (加入同盟) or in one of its MAX_SPECTATORS
// spectator seats (观战: room.spectate, also while its match runs; community report #26, a remake feature — the
// official room has none). Shows connection status + ping.
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MAX_SPECTATORS, modeIdFor } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Panel, TextField, PingPill, OnlinePill, AvatarFrame, Tooltip, Spinner, ProgressBar, DifficultyIcon, doctorNo } from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { NoticeButton } from '../ui/notice.js';
import { LoadoutButton } from './loadout.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref } from '../store.js';
import { getConfig, getMode, getStage, useData } from '../data.js';

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: '时长较短的模拟训练', effects: ['可以快速完成作战', '常规奖励'] },
    NORMAL: { code: 'AC-2', desc: '敌方攻击强度较高的模拟训练', effects: ['可使用盟约数增加', '大幅增加奖励'] },
    HARD: { code: 'AC-3', desc: '敌方攻击强度极高的模拟训练', effects: ['作战环境困难', '出现更加危险的敌人'] },
    ABYSS: { code: 'AC-4', desc: '敌方攻击强度到达极限的模拟训练', effects: ['作战环境无比困难', '出现极度危险的敌人'] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: '敌方攻击强度较低的模拟训练', effects: ['作战环境较为温和', '常规奖励'] },
    NORMAL: { code: 'AC-2', desc: '敌方攻击强度较高的模拟训练', effects: ['可使用盟约数增加', '大幅增加奖励'] },
    HARD: { code: 'AC-3', desc: '敌方攻击强度极高的模拟训练', effects: ['作战环境困难', '出现更加危险的敌人'] },
    ABYSS: { code: 'AC-4', desc: '敌方攻击强度到达极限的模拟训练', effects: ['作战环境无比困难', '出现极度危险的敌人'] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/**
 * How long 取消搜寻 waits for the server's reply before treating the socket as half-open (ms). A live connection
 * answers in milliseconds, so this is imperceptible; the retry it triggers is what actually cancels the search.
 */
export const CANCEL_REPLY_MS = 2500;
/** How long the reconnect that a failed 取消搜寻 triggers may take before the attempt is reported as failed (ms). */
export const CANCEL_RETRY_MS = 15_000;
/** How many times 取消搜寻 reconnects and asks again before it tells the player it could not get through. */
export const CANCEL_TRIES = 3;

/**
 * How long a fresh 开始搜寻队友 click waits locally before `queue.join` actually goes out (ms).
 *
 * The counter starts at once and the panel looks exactly as usual, so the delay is invisible to the player ("不告诉玩家
 * 任何行为即可"): it is there only so a misclick can be taken back by 取消搜寻 without the server ever hearing about it —
 * with four doctors already waiting, one stray tap would start a match at once. The gate is *this player's own* elapsed
 * local time (`>= QUEUE_GRACE_MS`), never the timer's own idea of the wait, so a coarse or early timer cannot join early.
 * A cancel (or leaving the screen) inside the window disarms the pending join, and nothing is sent at all.
 */
export const QUEUE_GRACE_MS = 3000;

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) return rec.name.split(/\s+/)[0];
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? `战场#${String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0')}` : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? `战场固定为 ${name}` : '战场固定'; }
    return ids.length > 1 ? `战场随机（共${ids.length}张）` : '';
  }
  return Number.isInteger(stages) && stages > 1 ? `战场随机（共${stages}张）` : '';
}

const MODE_CARDS = [
  {
    id: 'solo', name: '独立模拟', en: 'SOLO SIMULATION', icon: 'user',
    desc: '独自调配资金与干员，以自己的节奏完成整场模拟。',
    points: ['1 名博士', '休整期与机变阶段不限时'],
  },
  {
    id: 'coop', name: '同盟模拟', en: 'ALLIANCE SIMULATION', icon: 'users',
    desc: `与至多 ${MAX_SEATS - 1} 名博士组成同盟，共享干员池，联防协作抵御敌潮。`,
    points: [`1–${MAX_SEATS} 名博士 · 可由 AI 队友补位`, '联防阶段 · 最终攻势合并生命值'],
  },
  {
    // 搜寻队友 (official mode group 同盟模拟 → 搜寻队友, research 06 §3.3; DESIGN §23). The official 精确搜寻
    // (match by trophy level) needs progression data this build does not keep, so there is one fast search only.
    id: 'match', name: '同盟匹配', en: 'ALLIANCE MATCH', icon: 'search',
    desc: `搜寻其他博士组成同盟，凑齐 ${MAX_SEATS} 人即刻开始；暂时无人时由 AI 队友补位。`,
    points: [`1–${MAX_SEATS} 名博士 · 匹配其他真人`, '匹配成功直接开始 · 无需准备'],
  },
];

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty) {
  const fallback = MODE_TEXT[roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•\s]+/, '')).filter(Boolean)
    : fallback.effects;
  const rounds = Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : fallback.desc,
    effects,
    rounds,
    hidden: difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * A handler that Preact binds as `onClick=${fn}` receives the click EVENT as its first argument, and a default
 * parameter only applies to `undefined` — so `fn(c = code)` would normalise the event target into a nonsense code
 * (`String(el)` → `"[object HTMLElement]"` → "OBJE"). Only a string is ever a code; anything else falls back to the
 * input field. Returns null when neither yields a well-formed code.
 * @param {unknown} arg the argument a handler was called with
 * @param {string} field the current input-field value
 * @returns {string|null}
 */
export function codeArg(arg, field) {
  const k = normalizeCode(typeof arg === 'string' ? arg : field);
  return CODE_RE.test(k) ? k : null;
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

/** Recently joined/created co-op room codes (most recent first). */
export function recentRooms() {
  const list = loadPref('recentRooms', []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code) {
  if (!CODE_RE.test(code)) return;
  savePref('recentRooms', [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4));
}

const FALLBACK_TIPS = [
  '联合模拟在选择策略时可以进行一次跳过',
  '调度中心即使冻结，依然可以主动刷新',
  '两件同名装备可以合成一件更强力的装备',
  '只有达成完美作战的队友可以进行联防',
];
const TIP_ROTATE_MS = 5000; // matchingTipRotateInterval

/** Rotating tactical tips (config.json `tips`, weighted list of { tip, weight }). */
function TipsPanel() {
  const cfg = getConfig();
  const tips = Array.isArray(cfg?.tips)
    ? cfg.tips.map((t) => (typeof t === 'string' ? t : t?.tip)).filter((t) => typeof t === 'string' && t)
    : FALLBACK_TIPS;
  const list = tips.length ? tips : FALLBACK_TIPS;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * list.length));
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => i + 1), TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, []);
  const i = ((idx % list.length) + list.length) % list.length;
  return html`<div class="tips brackets">
    <div class="tips__head">
      <${Icon} name="info" />
      <span>作战提示</span>
      <${MicroLabel}>TACTICAL TIPS<//>
      <span class="tips__idx num">${String(i + 1).padStart(2, '0')}<span class="t-dim">/${String(list.length).padStart(2, '0')}</span></span>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i - 1 + list.length)} aria-label="上一条"><${Icon} name="chevronLeft" /></button>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i + 1)} aria-label="下一条"><${Icon} name="chevronRight" /></button>
    </div>
    <p key=${i} class="tips__text">${list[i]}</p>
  </div>`;
}

/**
 * The wait (ms) a 搜寻队友 panel shows for *this* player: measured from their own click (`localStart`, taken when they
 * pressed 开始搜寻队友) whenever this page knows it, and from the server's pool anchor (`q.since`, built in main.js from
 * `queue.state.waitedMs`) only when it does not.
 *
 * The local click must win: `waitedMs` is the pool's *oldest connected waiter* (server/lobby.js queueState), so on its
 * own it would show a newcomer the seconds somebody else has already waited — the count a late clicker used to see jump
 * to — and every later `queue.state` broadcast would jump the newcomer's counter forward again. `localStart` is null only
 * when this page never saw a click — a reload or reconnect re-attached to an entry that really has been waiting all
 * along, where the server's snapshot is the only and most consistent thing to resume from.
 * @param {{ since?: number } | null} q the store's queue slice (or the panel's local placeholder)
 * @param {number|null|undefined} localStart this player's own click time, when this page has one
 * @param {number} now
 * @returns {number} ms, never negative
 */
export function queueWaited(q, localStart, now = Date.now()) {
  const start = Number.isFinite(localStart) ? localStart : Number.isFinite(q?.since) ? q.since : now;
  return Math.max(0, now - start);
}

/**
 * MM:SS of a wait in ms — the panel's clock.
 * @param {number} ms
 * @returns {string}
 */
export function queueClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Arm one 开始搜寻队友 click: the local clock starts now (the returned `start`, which the panel counts from) and
 * `send(difficulty)` goes out only once QUEUE_GRACE_MS of local elapsed time has passed — a timer that fires early
 * re-arms for the remainder instead of joining too soon. `cancel()` (the player pressed 取消搜寻, or left the screen)
 * prevents the send entirely, so a click taken back inside the grace never reaches the server; `sent` flips only on a
 * real send, and one armed entry never sends twice.
 * `now` / `setTimer` / `clearTimer` are injectable so the tests can drive the grace with fake timers.
 * @param {{ difficulty: string, send: (difficulty: string) => void, now?: () => number,
 *           setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void, graceMs?: number }} opts
 * @returns {{ start: number, difficulty: string, sent: boolean, cancelled: boolean, timer: any, cancel: () => void }}
 */
export function armQueueJoin({ difficulty, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, graceMs = QUEUE_GRACE_MS }) {
  const entry = { start: now(), difficulty, sent: false, cancelled: false, timer: null };
  const fire = () => {
    entry.timer = null;
    if (entry.sent || entry.cancelled) return;
    const waited = now() - entry.start;
    if (waited < graceMs) { entry.timer = setTimer(fire, graceMs - waited); return; } // never join before the threshold
    entry.sent = true;
    send(entry.difficulty);
  };
  entry.timer = setTimer(fire, graceMs);
  entry.cancel = () => { entry.cancelled = true; if (entry.timer != null) clearTimer(entry.timer); entry.timer = null; };
  return entry;
}

/**
 * 搜寻队友 panel (matchmaking, DESIGN §23): what the left column shows while this player searches — from the click
 * itself (the grace window, before `queue.join` went out) and then while the server keeps the session in a pool. The
 * wait counts up from this player's own click (`start`, from armQueueJoin), falling back to the server's pool snapshot
 * (`q.since` through queueWaited) when this page has no click of its own; neither needs extra traffic.
 * Only 取消搜寻 is offered — nobody may cut another doctor's search short by starting the pool with AI, so a lone
 * searcher is pointed at 同盟模拟 (+ AI teammates) instead (the owner, 2026-10-04).
 * @param {{ q: { difficulty: string, size: number, max: number, solo: boolean, since: number },
 *           start?: number|null, busy?: string|null, onCancel: () => void }} props
 */
function MatchPanel({ q, start = null, busy = null, onCancel }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const clock = queueClock(queueWaited(q, start));
  const max = q.max || MAX_SEATS;
  const size = Math.min(Math.max(0, Number(q.size) || 0), max);
  return html`<${Panel} class="match-panel" tone="mint" title="正在搜寻队友" micro="SEARCHING FOR DOCTORS"
      actions=${html`<span class="match-panel__clock num">${clock}</span>`}>
    <div class="match-panel__status">
      <${Spinner} size="lg" label="SEARCHING" />
      <div class="match-panel__meta">
        <span class="match-panel__count num">${size}<span class="t-dim">/${max}</span> 名博士</span>
        <${MicroLabel}>${DIFFICULTY_NAMES[q.difficulty] || q.difficulty} · 快速搜寻<//>
      </div>
    </div>
    <${ProgressBar} value=${size} max=${max} segments=${max} tone="mint" />
    <p class="match-panel__note">
      ${q.solo
        ? '暂时只有你在搜寻，会一直为你匹配其他博士（可随时取消）；也可以取消后用「同盟模拟」和 AI 队友立刻开局。'
        : `正在和其他博士组队：凑齐 ${max} 人立即开始；人数不够会一直匹配下去，不用反复点。`}
    </p>
    <div class="match-panel__actions">
      <${Button} variant="ghost" size="lg" icon="chevronLeft" loading=${busy === 'cancel'} disabled=${!!busy} onClick=${onCancel}>取消搜寻<//>
    </div>
    <ul class="match-panel__facts">
      <li>匹配成功后直接进入模拟，无需准备</li>
      <li>同盟密钥在房间内仍然可见，可继续邀请好友</li>
    </ul>
  <//>`;
}

function ModeCard({ card, selected, onSelect }) {
  return html`<button type="button" class=${`mode-card brackets${selected ? ' is-selected' : ''}`} onClick=${() => onSelect(card.id)}
      aria-pressed=${selected ? 'true' : 'false'}>
    <span class="mode-card__bg" aria-hidden="true"></span>
    <span class="mode-card__icon"><${Icon} name=${card.icon} /></span>
    <span class="mode-card__text">
      <${MicroLabel} tone=${selected ? 'mint' : undefined}>${card.en}<//>
      <span class="mode-card__name">${card.name}</span>
      <span class="mode-card__desc">${card.desc}</span>
      <span class="mode-card__points">${card.points.map((p) => html`<span key=${p}>${p}</span>`)}</span>
    </span>
    <span class="mode-card__check" aria-hidden="true"><${Icon} name="check" />已选定</span>
  </button>`;
}

function DifficultyCard({ roomMode, difficulty, selected, disabled = false, onSelect }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`diff-card${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} disabled=${disabled} onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="diff-card__bar" aria-hidden="true"></span>
    <span class="diff-card__head">
      <${DifficultyIcon} difficulty=${difficulty} class="diff-card__glyph" />
      <span class="diff-card__name">${DIFFICULTY_NAMES[difficulty]}</span>
      <span class="diff-card__code num">${info.code}</span>
      <span class="diff-card__meta">
        <span class="num">${info.rounds}</span> 回合${info.hidden ? html`<span class="diff-card__hidden">+ 隐秘核心</span>` : null}
      </span>
    </span>
    <span class="diff-card__desc">${info.desc}</span>
    <span class="diff-card__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}${info.stageNote ? html`<span key="stage" class="diff-card__stage"><${Icon} name="rook" />${info.stageNote}</span>` : null}</span>
    <span class="diff-card__check" aria-hidden="true"><${Icon} name="check" /><span>已选定</span></span>
  </button>`;
}

/** Lobby screen component. */
export function LobbyScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  useData('config');
  const [roomMode, setRoomMode] = useState(() => {
    const m = loadPref('lobby.mode', 'coop');
    return m === 'solo' || m === 'match' ? m : 'coop';
  });
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', 'FUNNY');
    return DIFFICULTIES.includes(d) ? d : 'FUNNY';
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  // 取消搜寻 leaves the pool *now*: the panel goes away on the click (the player is out of the search), and the
  // client keeps re-sending `queue.leave` in the background until the server confirms it. Without this the player
  // stares at a searching panel that a swallowed frame never ends (the server would still have the session queued
  // and could still put it into a match).
  const [exiting, setExiting] = useState(false);
  // The client's own side of a 搜寻队友 click: `joinRef` holds the armed search (armQueueJoin) — this player's own click
  // time, which the panel's clock counts from, and the silently delayed `queue.join`. `pending` keeps the panel on
  // screen (and counting) during the grace window, before the server has an entry to report, so the wait looks
  // identical on both sides of the join.
  const joinRef = useRef(null);
  const [pending, setPending] = useState(false);
  const [recent] = useState(recentRooms);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  // Leaving the lobby inside the grace window must reach the server as nothing: disarm the pending join on unmount.
  useEffect(() => () => { alive.current = false; if (joinRef.current) joinRef.current.cancel(); joinRef.current = null; }, []);

  const online = conn.status === 'online';
  const codeOk = CODE_RE.test(code);
  const q = useStore((s) => s.queue, shallowEqual); // 搜寻队友 search state, or null (DESIGN §23)
  const searching = roomMode === 'match';
  // This player is searching: the local grace window (no server entry yet) or the server's pool. 取消搜寻 takes the
  // panel away at once (`exiting`) — the player is out of the search the moment they ask.
  const waiting = !!q || pending;
  const showPanel = waiting && !exiting;
  // What the panel renders from: the server's state once it has one, else the shape a lone searcher's `queue.state`
  // carries (this player alone — what the server reports for a pool of one, so a really lone search is identical
  // before and after the join). Its `since` is never used: the clock runs off the local click.
  const panelQ = q || { difficulty, size: 1, max: MAX_SEATS, solo: true, since: null };
  const panelStart = joinRef.current ? joinRef.current.start : null;

  const pickMode = (m) => { setRoomMode(m); savePref('lobby.mode', m); };
  const pickDifficulty = (d) => { setDifficulty(d); savePref('lobby.difficulty', d); };

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast('尚未连接到服务器，请稍候', 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  /**
   * The grace expired: this player really is joining the pool now. Only this callback sends `queue.join` — arming a
   * search is the only path to it, and a cancel inside the window disarms the entry before it can fire, so nothing is
   * sent at all. A join that never got through drops the local search (the player is back at 开始搜寻队友 and can try
   * again) instead of counting up in front of a panel the server knows nothing about.
   */
  const joinQueue = async (d) => {
    if (!alive.current) return;
    const back = () => { joinRef.current = null; if (alive.current) setPending(false); };
    if (store.get().connection.status !== 'online') { back(); toast('尚未连接到服务器，请稍候', 'warn'); return; }
    try {
      await net.request('queue.join', { difficulty: d });
    } catch (err) { back(); toastError(err); }
  };
  /** 开始搜寻队友: the clock starts now, `queue.join` leaves QUEUE_GRACE_MS later, and the panel tells the player nothing. */
  const armJoin = (d) => {
    joinRef.current = armQueueJoin({ difficulty: d, send: joinQueue });
    setPending(true);
  };
  const create = () => {
    // A search started right after 取消搜寻: stop the background cancel first, or its next retry would remove the
    // fresh pool entry (the player would look queued while the server had already dropped them).
    cancelRef.current.wanted = false;
    setExiting(false);
    if (!searching) return run('create', () => net.request('room.create', { mode: roomMode, difficulty }));
    // 搜寻队友: one click, at most one `queue.join`. A repeated click — or a click after a reconnect re-attached to an
    // entry this page did not create — must not add a second entry, so an armed (or sent) search is left alone.
    if (joinRef.current) return;
    armJoin(difficulty);
  };
  // 取消搜寻 must take the player out of the queue *now*, even when the frame cannot get through: on a half-open
  // socket (a phone network, a VPN, a proxy that swallowed it) `queue.leave` reaches nobody, the server keeps this
  // session queued and can still put it into a match — the player sees a button that does nothing and a clock that
  // never stops. So the click drops the search locally at once (`exiting` hides the panel, so the player is out of
  // the search the moment they ask) and this loop keeps re-sending `queue.leave` — reconnecting when a reply never
  // comes — until the server confirms it. `queue.state {active:false}` clears `q` and ends the loop; if every try
  // fails the panel comes back with what the server actually thinks, plus a toast.
  const cancelRef = useRef({ wanted: false, tries: 0 });
  // `q` turns null only when the server says the session left the pool (`queue.state {active:false}`, main.js), so
  // this is the confirmation that ends the retry loop — never a local guess.
  useEffect(() => {
    const c = cancelRef.current;
    // The server's entry arrived: the grace window is over. The armed entry stays (its `start` is this player's own
    // click, which the clock keeps counting from — a `queue.state` must never reset or jump it).
    if (q) { setPending(false); return; }
    // Out of the pool (never joined, cancelled, or matched): the next click starts a fresh local clock.
    joinRef.current = null;
    if (c.wanted) { c.wanted = false; setExiting(false); }
  }, [q]);
  useEffect(() => () => { cancelRef.current.wanted = false; }, []);
  const leaveSearch = async () => {
    const c = cancelRef.current;
    while (c.wanted && c.tries < CANCEL_TRIES) {
      c.tries += 1;
      try {
        await net.request('queue.leave', {}, { timeout: CANCEL_REPLY_MS });
        return; // the server answered; its `queue.state {active:false}` confirms and clears `exiting`
      } catch (err) {
        if (err?.code !== 'TIMEOUT') throw err;
        toast(c.tries === 1 ? '取消搜寻：连接好像断了，正在重连…' : `取消搜寻：还没成功，正在重试（${c.tries}/${CANCEL_TRIES}）…`, 'warn');
      }
      if (!alive.current) return;
      net.reconnectNow();
      if (!(await net.whenOnline(CANCEL_RETRY_MS))) continue; // still offline: the next pass tries again
    }
    if (c.wanted) {
      // Every try failed: show what the server actually thinks (still searching) instead of a lie.
      c.wanted = false;
      setExiting(false);
      throw new Error('取消搜寻失败：暂时连不上服务器，请稍后再试一次');
    }
  };
  const cancelSearch = () => {
    // Inside the grace window nothing has reached the server yet, so there is nothing to cancel: the click is simply
    // taken back (the armed join is disarmed, the panel goes) and *nothing* is sent — no `queue.leave` for an entry
    // that was never created. That is the whole point of the grace: a misclick must not put the player in the pool.
    const armed = joinRef.current;
    if (armed && !armed.sent) {
      armed.cancel();
      joinRef.current = null;
      setPending(false);
      return;
    }
    const c = cancelRef.current;
    if (c.wanted) return;
    c.wanted = true;
    c.tries = 0;
    setExiting(true); // out of the search at once; the server's active:false only confirms it
    run('cancel', leaveSearch);
  };
  const join = (c = code) => {
    // `onClick=${join}` hands the click EVENT as the first argument, and a default parameter only applies to
    // `undefined` — codeArg keeps an event target out of the key and falls back to the input field
    const k = codeArg(c, code);
    if (!k) { toast(`同盟密钥为 ${ROOM_CODE_LEN} 位字母或数字`, 'warn'); return; }
    run('join', () => net.request('room.join', { code: k }));
  };
  // a spectator seat: no player seat taken, nothing to do but watch (also a match already running)
  const spectate = (c = code) => {
    // same guard as join: `onClick=${spectate}` passes the click event, not a code
    const k = codeArg(c, code);
    if (!k) { toast(`同盟密钥为 ${ROOM_CODE_LEN} 位字母或数字`, 'warn'); return; }
    run('spectate', () => net.request('room.spectate', { code: k }).catch((err) => {
      // Clearer than the bare ERR_TEXT: the usual cause is a code that is not the host's (a remembered one from an
      // earlier room, or another machine's) — the server can only answer "no such room".
      if (err?.code === ERR.ROOM_NOT_FOUND) {
        toast(`没有找到密钥 ${k} 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）`, 'warn');
        return;
      }
      if (err?.code === ERR.ALREADY) {
        toast('你已经是该同盟的博士：先离开同盟，才能以观战身份进入', 'warn');
        return;
      }
      throw err;
    }));
  };
  const backToTitle = () => {
    identity.setEntered(false);
    store.set((s) => ({ session: { ...s.session, entered: false } }));
  };

  return html`<div class="screen lobby-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${backToTitle} title="返回标题">返回<//>
        <${PingPill} ms=${conn.ping} online=${online} />
        <${OnlinePill} count=${conn.onlineCount} />
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">SIMULATION PROTOCOL SELECT<//>
        <h1 class="topbar__title">选择模拟协议</h1>
      </div>
      <div class="topbar__right">
        <${NoticeButton} class="lobby-notice" variant="secondary" />
        <${GuideButton} class="lobby-guide" variant="secondary" />
        <${LoadoutButton} from="lobby" size="sm" class="lobby-loadout" />
        <div class="me-chip">
          <${AvatarFrame} size="sm" name=${me.name} seat=${0} self=${true} />
          <div class="me-chip__text">
            <span class="me-chip__name">${me.name || '博士'}</span>
            <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
          </div>
        </div>
      </div>
    </header>

    <div class="lobby-body screen__scroll">
      <section class="lobby-left">
        <div class="lobby-tip">
          <span class="lobby-tip__text">联机用分线：</span>
          <a
            class="lobby-tip__link"
            href="https://game.kafuno.cn"
            target="_blank"
            rel="noopener noreferrer"
            title="联机用分线：game.kafuno.cn"
          >game.kafuno.cn</a>
        </div>
        ${showPanel
          ? html`<${MatchPanel} q=${panelQ} start=${panelStart} busy=${busy} onCancel=${cancelSearch} />`
          : html`<div class="lobby-prep">
            <div class="section-label"><span class="section-label__idx num">01</span>模拟方式<${MicroLabel}>MODE<//></div>
            <div class="mode-cards">
              ${MODE_CARDS.map((c) => html`<${ModeCard} key=${c.id} card=${c} selected=${roomMode === c.id} onSelect=${pickMode} />`)}
            </div>

            <div class="section-label"><span class="section-label__idx num">03</span>加入同盟<${MicroLabel}>JOIN WITH ALLIANCE KEY<//></div>
            <${Panel} class="join-panel" tone="amber">
              <div class="join-row">
                <${TextField} size="code" icon="key" value=${code} placeholder="输入同盟密钥 / 粘贴邀请链接"
                  transform=${normalizeCode} onInput=${(v) => setCode(normalizeCode(v))} onEnter=${() => join()} />
                <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online} onClick=${() => join()}>加入同盟<//>
                <${Tooltip} text=${`以观战者身份进入：不占博士席位，只能观看（每个同盟最多 ${MAX_SPECTATORS} 名，模拟进行中也可进入）`}>
                  <${Button} variant="secondary" size="lg" icon="eye" class="join-spectate" loading=${busy === 'spectate'} disabled=${!codeOk || !online} onClick=${spectate}>观战<//>
                <//>
              </div>
              <div class="join-foot">
                ${recent.length ? html`<span class="t-lo">最近的同盟</span>
                  ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title="填入密钥（不会直接加入）"
                    onClick=${() => setCode(c)}>${c}</button>`)}`
                  : html`<span class="t-dim">向同伴索取 ${ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接</span>`}
              </div>
            <//>
          </div>`}
        <${TipsPanel} />
      </section>

      <section class="lobby-right">
        <div class="section-label"><span class="section-label__idx num">02</span>模拟难度<${MicroLabel}>DIFFICULTY<//></div>
        <div class="diff-list">
          ${DIFFICULTIES.map((d) => html`<${DifficultyCard} key=${d} roomMode=${roomMode} difficulty=${d} selected=${difficulty === d} disabled=${waiting} onSelect=${pickDifficulty} />`)}
        </div>
        <div class="create-box">
          ${showPanel
            ? html`<div class="create-box__searching">
                <${Spinner} size="sm" label="SEARCHING" />
                <span>正在搜寻其他博士…匹配成功后直接开始模拟</span>
              </div>`
            : html`<${Tooltip} block=${true} text=${online ? null : '正在连接服务器…'}>
                <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${busy === 'create'} disabled=${!online} onClick=${create}>
                  ${roomMode === 'solo' ? '开始独立模拟' : searching ? '开始搜寻队友' : '创建同盟'}
                <//>
              <//>
              <div class="create-box__hint">
                ${online
                  ? html`<span>${roomMode === 'solo'
                      ? '创建后即可开始模拟'
                      : searching ? '凑齐 4 名博士即刻开始，不足时 AI 队友补位' : '创建后可邀请好友或添加 AI 队友'}</span>`
                  : html`<${Spinner} size="sm" label="CONNECTING" />`}
              </div>`}
        </div>
      </section>
    </div>
  </div>`;
}
