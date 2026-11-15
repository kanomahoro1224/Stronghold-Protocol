// public/js/demoRecorder.js — records the player's own match for the local demo library.
//
// Everything happens in the browser (user decision 2026-11-15): the player's C2S actions (`g.*` sent through net.js),
// plus the `m.public` board frames the server already pushes, are appended to a document and saved to IndexedDB when
// the match ends. The server never stores or re-simulates demos; playback reads the local document and walks it.
//
// Wiring: `startDemoRecorder()` once at boot (main.js). It wraps `net.send` (so no other module has to know) and
// subscribes to `m.public` / `m.result` / `room.state` / the socket status. A new match starts the document at its
// first public frame; the result, leaving the room, 放弃模拟, a lost connection or the page going away closes it.
//
// How a match ends (user requirement 2026-11-15 「不管是模拟中断，还是中途退出啥的，通通记录」):
//   'result'   the settlement arrived — always kept, however short the match was;
//   'quit'     放弃模拟 / a seat given up (ui/matchChrome.js quitMatch);
//   'left'     the room went away under the match (closed, reset, kicked);
//   'disconnect' the socket dropped or the page was hidden — the document is FLUSHED (saved, still recording), so a
//                player who never comes back keeps the match; a player who does comes back finishes the same document
//                (same id, overwritten) instead of leaving two halves in the library;
//   'pagehide' the page is going away (bfcache / tab closed) — flushed like a disconnect.
// One rule cuts the other way (the same one the statistics use, ui/stats.js countsTowardStats): a match left before the
// player cleared the first round is not worth a demo and is dropped — nothing is written, and a flushed copy is deleted.
//
// The document id is handed to the statistics record (`demoId`, ui/stats.js) so 对局记录 can play the very demo of the
// row the player clicks (screens/stats.js). `currentDemoId()` is read by the record builder at the same moment.

import { net } from './net.js';
import { store } from './store.js';
import { putDemo, deleteDemo } from './demoStore.js';
import { clearedRounds } from './ui/stats.js';
import { PHASE } from '../../shared/constants.js';

const MAX_EVENTS = 20_000;
const MAX_FRAMES = 400;
const EVENT_BYTES_CAP = 2 * 1024 * 1024;
/** A hidden tab / a reconnect flushes at most this often (each flush rewrites the whole document). */
const FLUSH_GAP_MS = 8_000;
/** How long a just-finished id stays available to the record builder (listener order is not fixed). */
const HANDOFF_MS = 15_000;

/** @typedef {{ id: string, startedAt: number, endedAt: number|null, end: string|null, rounds: number, settled: boolean,
 *   mode: string|null, difficulty: string|null, players: any[], events: any[], snapshots: any[], bytes: number,
 *   closed: boolean }} DemoDoc */

/** @type {DemoDoc | null} */
let active = null;
let started = false;
let lastFlushAt = 0;
/** When the last settlement was saved: the frames of a result replay belong to it, not to a new match. */
let resultAt = 0;
/** The document just saved: `currentDemoId()` still answers with it while the match's record is being built. */
let handled = /** @type {{ id: string, at: number } | null} */ (null);

const slimFrame = (msg) => ({
  at: Date.now() - (active?.startedAt || Date.now()),
  phase: msg.phase ?? null, round: msg.round ?? null,
  modeId: msg.modeId ?? null, difficulty: msg.difficulty ?? null, teamLp: msg.teamLp ?? null,
  players: Array.isArray(msg.players) ? msg.players.map((p) => ({
    playerId: p.playerId, seat: p.seat, name: p.name, isBot: !!p.isBot,
    alive: !!p.alive, lp: p.lp, shopLevel: p.shopLevel, boardCount: p.boardCount,
    ready: !!p.ready, status: p.status || null,
  })) : [],
});

function begin(frame) {
  active = {
    id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    endedAt: null, end: null,
    // rounds the player has cleared so far — the same rule the statistics use for 中途退出 (ui/stats.js clearedRounds)
    rounds: 0,
    settled: false,
    mode: frame.modeId ?? null, difficulty: frame.difficulty ?? null,
    players: frame.players || [], events: [], snapshots: [], bytes: 0, closed: false,
  };
  active.players = (frame.players || []).map((p) => ({ playerId: p.playerId, seat: p.seat, name: p.name, isBot: !!p.isBot }));
  pushFrame(frame);
}

function pushFrame(msg) {
  if (!active || active.closed) return;
  const snap = slimFrame(msg);
  active.snapshots.push(snap);
  if (active.snapshots.length > MAX_FRAMES) active.snapshots.splice(0, active.snapshots.length - MAX_FRAMES);
  if (!active.mode && snap.modeId) active.mode = snap.modeId;
  if (!active.difficulty && snap.difficulty) active.difficulty = snap.difficulty;
  active.rounds = Math.max(active.rounds, clearedRounds(snap.phase, snap.round));
}

function recordAction(t, fields) {
  if (!active || active.closed) return;
  if (active.events.length >= MAX_EVENTS) return;
  const a = { ...(fields && typeof fields === 'object' ? fields : {}), t };
  const size = (() => { try { return JSON.stringify(a).length; } catch { return 0; } })();
  if (active.bytes + size > EVENT_BYTES_CAP) return;
  active.bytes += size;
  active.events.push({ at: Date.now() - active.startedAt, a });
}

/**
 * Whether a document is worth keeping: a settled match always is, otherwise the player must have cleared one round
 * (owner's rule, 2026-11-15: 「如果没有清完第一个回合就退出，不记录demo」).
 * @param {{ settled: boolean, rounds: number }} doc
 * @returns {boolean}
 */
export function keepsDemo(doc) {
  return !!doc && (!!doc.settled || (Number(doc.rounds) || 0) >= 1);
}

/** The snapshot written to IndexedDB (a copy: recording goes on for a flush). */
const copyOf = (doc, end) => ({
  ...doc, snapshots: doc.snapshots.slice(), events: doc.events.slice(), endedAt: Date.now(), end: doc.end || end,
});

/**
 * Save the match in progress without closing it (a dropped socket, a hidden tab): the document keeps recording and a
 * later finish overwrites the same id. Nothing is written before the first round is cleared.
 * @param {string} reason what the document says if the player never comes back
 * @param {{ force?: boolean }} [opts] `force` skips the throttle (the page is going away)
 * @returns {Promise<string|null>} the document id, or null when nothing was written
 */
export async function flushDemo(reason = 'disconnect', { force = false } = {}) {
  const doc = active;
  if (!doc || doc.closed || !keepsDemo(doc)) return null;
  const now = Date.now();
  if (!force && now - lastFlushAt < FLUSH_GAP_MS) return null;
  lastFlushAt = now;
  const copy = copyOf(doc, reason);
  copy.closed = false;
  const ok = await putDemo(copy).catch(() => false);
  return ok ? copy.id : null;
}

/**
 * Save and close the current document (no-op when nothing was recorded).
 * @param {'result'|'quit'|'left'|'disconnect'|'pagehide'|'replaced'|string} reason how the match ended
 * @returns {Promise<string|null>} the saved document's id, or null when nothing was kept
 */
export async function finishDemo(reason = 'left') {
  const doc = active;
  if (!doc || doc.closed) return null;
  active = null;
  doc.closed = true;
  doc.endedAt = Date.now();
  doc.end = reason;
  if (reason === 'result') { doc.settled = true; resultAt = Date.now(); }
  if (!keepsDemo(doc)) {
    // a match left before the first round was cleared: whatever a flush wrote goes too
    await deleteDemo(doc.id).catch(() => false);
    return null;
  }
  const ok = await putDemo(doc).catch(() => false);
  if (!ok) return null;
  handled = { id: doc.id, at: Date.now() };
  // 云端备份（每账号最新 10 局）；未登录会 401，静默忽略，本机记录保留
  import('./ui/cloud.js').then((m) => m.uploadDemo(doc)).catch(() => {});
  return doc.id;
}

/** Abandon a document without saving (left before playing). */
export function dropDemo() { if (active) active.closed = true; active = null; }

/**
 * The demo of the match being recorded, for the statistics record (ui/stats.js `demoId`): the live document's id, or
 * the one just saved (the result listener and the record builder run in no fixed order).
 * @returns {string|null}
 */
export function currentDemoId() {
  if (active && !active.closed) return active.id;
  if (handled && Date.now() - handled.at < HANDOFF_MS) return handled.id;
  return null;
}

export function startDemoRecorder() {
  if (started) return;
  started = true;

  // 1) every C2S action this player sends — the same frames the server's Match.handle receives
  const origSend = net.send.bind(net);
  net.send = (t, fields = {}) => {
    if (typeof t === 'string' && t.startsWith('g.')) {
      const me = store.get().me;
      if (me?.playerId && !isSpectator()) recordAction(t, fields);
    }
    return origSend(t, fields);
  };

  // 2) board frames: the first frame of a new match opens the document. A result replay's final frame (phase RESULT)
  //    and the frames a lobby reconnect pushes right after a settlement must not open one — the store knows the
  //    result too, but a recorder that trusts only its own state also works without main.js' patching.
  net.on('m.public', (msg) => {
    if (!msg || isSpectator()) return;
    if (msg.phase === PHASE.RESULT || msg.phase === PHASE.LOBBY) return;
    if (!active) {
      if (store.get().match?.result) return;
      if (resultAt && Date.now() - resultAt < 3000) return;
      begin(msg);
    } else pushFrame(msg);
  });

  // 3) the match ended (m.result for this player) → save, however the match went
  net.on('m.result', () => { finishDemo('result'); });

  // 4) left the room / the room reset / the match was abandoned → the match cannot continue
  net.on('room.state', (state) => {
    if (!state || !state.inMatch) finishDemo('left');
    else resultAt = 0; // a new match is on, its frames may open a document
  });

  // 5) the connection dropped (模拟中断): keep what there is at once — the tab may never come back — but stay open,
  //    so a reconnect continues the same document instead of leaving two halves in the library
  net.on('status', (snap) => {
    if (snap?.status === 'reconnecting' || snap?.status === 'closed') flushDemo('disconnect');
  });
  // another tab took the session over: this one will never see the match again
  net.on('replaced', () => { finishDemo('replaced'); });

  // 6) the page is going away (tab closed, bfcache, the phone locked): flush what has been recorded
  if (globalThis.addEventListener) {
    globalThis.addEventListener('pagehide', () => { flushDemo('pagehide', { force: true }); });
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (globalThis.document.visibilityState === 'hidden') flushDemo('hidden');
    });
  }
}

function isSpectator() {
  const s = store.get();
  return !!(s.room?.spectators && s.me?.playerId && s.room.spectators.some?.((x) => x.playerId === s.me.playerId));
}
