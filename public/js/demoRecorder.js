// public/js/demoRecorder.js — records the player's own match for the local demo library.
//
// Everything happens in the browser (user decision 2026-11-15): the player's C2S actions (`g.*` sent through net.js),
// plus the `m.public` board frames the server already pushes, are appended to a document and saved to IndexedDB when
// the match ends. The server never stores or re-simulates demos; playback reads the local document and walks it.
//
// Wiring: `startDemoRecorder()` once at boot (main.js). It wraps `net.send` (so no other module has to know) and
// subscribes to `m.public` / `m.result` / `room.state`. A new match starts the document at its first public frame; the
// result, leaving the room or the next match's first frame closes it.

import { net } from './net.js';
import { store } from './store.js';
import { putDemo } from './demoStore.js';

const MAX_EVENTS = 20_000;
const MAX_FRAMES = 400;
const EVENT_BYTES_CAP = 2 * 1024 * 1024;

/** @typedef {{ id: string, startedAt: number, mode: string|null, difficulty: string|null, players: any[], events: any[], snapshots: any[], bytes: number, closed: boolean }} DemoDoc */

/** @type {DemoDoc | null} */
let active = null;
let started = false;

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

/** Save and close the current document (no-op when nothing was recorded). */
export async function finishDemo() {
  if (!active || active.closed) return null;
  const doc = active;
  doc.closed = true;
  active = null;
  if (!doc.events.length && !doc.snapshots.length) return null;
  const ok = await putDemo(doc).catch(() => false);
  if (ok) {
    // 云端备份（每账号最新 10 局）；未登录会 401，静默忽略，本机记录保留
    import('./ui/cloud.js').then((m) => m.uploadDemo(doc)).catch(() => {});
  }
  return ok ? doc.id : null;
}

/** Abandon a document without saving (left before playing). */
export function dropDemo() { if (active) active.closed = true; active = null; }

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

  // 2) board frames: the first frame of a new match opens the document
  net.on('m.public', (msg) => {
    if (!msg || isSpectator()) return;
    if (!active) begin(msg); else pushFrame(msg);
  });

  // 3) the match ended (m.result for this player) → save
  net.on('m.result', () => { finishDemo(); });

  // 4) left the room / the room reset → the match cannot continue
  net.on('room.state', (state) => {
    if (!state || !state.inMatch) finishDemo();
  });
}

function isSpectator() {
  const s = store.get();
  return !!(s.room?.spectators && s.me?.playerId && s.room.spectators.some?.((x) => x.playerId === s.me.playerId));
}
