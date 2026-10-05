// server/state/snapshot.js — a Match → persisted record (version 2) and the per-player payload that rides with it.
//
// This module only READS a running match (plus the `apply` half used on resume). It never awaits, never touches the
// disk and never mutates the match, so it may be called from a phase transition (see Match._persistState).
//
// What the record is FOR: after a crash/restart the process knows nothing, so a record must let it (a) recognise that
// the match existed and is still resumable, and (b) reconstruct it. Everything the Match constructor derives from
// (mode, difficulty, modeId, seed, matchNo, seats) is captured exactly; the round index and the phase say where the
// match was; the per-player payload carries the plain-JSON progress (LP, band, funds, bond layers, counters, stats,
// loadout, shop level) AND — record v2, P2a — the full engine state of the seat: hand / temp / board, the shop with its
// slots, offers, effects, bounties, temp dues, overrides, stats, counters and the piece graphs behind them
// (server/state/playerstate.js, a generic own-property serializer).
//
// v2 also carries `state` (the volatile RUN state of the match: the six random-stream positions, `uidSeq`, the battle
// sequence, the shared pool's remaining copies and the recorded round's waves — Match.captureRunState) and the two
// properties the re-entry gate needs (`loneHuman`, `phase`). A v1 record has neither and is REFUSED by the version gate
// in server/state/resume.js: it must never be read as v2 (its `players[].props` would be missing and its `state` null).
//
// What is still NOT captured: the in-flight battles (a battle is a pure function of its JSON spec + tick count, so a
// rebuilt match derives it again), `lastResult`, and the PlayerState caches (`_deployMap`, `_deployField`,
// `_legalityStale`, `_botPrepToken`) — see the header of playerstate.js.

import { createHash } from 'node:crypto';
import { captureProps, hasEngineShape } from './playerstate.js';

/** Bumped whenever the record shape changes incompatibly — a mismatching record is refused, never guessed at. */
export const RECORD_VERSION = 2;

/** `sha256(token)` truncated: the durable per-seat identity a returning client proves (see resume.js/StateBridge). */
export function tokenHash(token) {
  if (typeof token !== 'string' || !token) return null;
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Plain copy of the frozen loadout `{ [chessId]: { skill, module } }`. */
function plainLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) {
    if (!e || typeof e !== 'object') continue;
    out[id] = { skill: Number(e.skill) || 0, module: typeof e.module === 'string' ? e.module : null };
  }
  return out;
}

/** Shallow numeric copy (drops nothing that is not a finite number, so `undefined`/NaN never reach JSON). */
function numMap(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

/** The seat row of the record: who sat where, and (for humans) the token hash that proves the identity on return. */
export function captureSeat(ps, hash = null) {
  return {
    seat: ps.seat,
    playerId: ps.playerId,
    name: ps.name,
    isBot: !!ps.isBot,
    connected: !!ps.connected && !ps.left,
    // a departed human is not awaited: the seat is recorded for completeness, `left` keeps it out of the claim index
    left: !!ps.left,
    tokenHash: ps.isBot ? null : hash,
    bandId: ps.bandId ?? null,
  };
}

/**
 * The per-player payload: the plain-JSON progress of one seat plus (v2, P2a) its full engine state under `props`.
 * Every field here is JSON-safe by construction and is restored by `applyPayload` / `playerstate.applyPlayerState`.
 */
export function capturePlayer(ps) {
  return {
    playerId: ps.playerId,
    seat: ps.seat,
    name: ps.name,
    isBot: !!ps.isBot,
    alive: !!ps.alive,
    eliminatedRound: Number.isInteger(ps.eliminatedRound) ? ps.eliminatedRound : null,
    lp: Number.isFinite(ps.lp) ? ps.lp : 0,
    bandId: ps.bandId ?? null,
    funds: Number.isFinite(ps.funds) ? ps.funds : 0,
    pendingFunds: Number.isFinite(ps.pendingFunds) ? ps.pendingFunds : 0,
    prepsEnded: Number.isInteger(ps.prepsEnded) ? ps.prepsEnded : 0,
    ready: !!ps.ready,
    infoReady: !!ps.infoReady,
    autoplay: !!ps.autoplay,
    deployCapBonus: Number.isFinite(ps.deployCapBonus) ? ps.deployCapBonus : 0,
    deployCapMin: Number.isFinite(ps.deployCapMin) ? ps.deployCapMin : 0,
    layers: numMap(ps.layers),
    bondCountBonus: numMap(ps.bondCountBonus),
    counters: numMap(ps.counters),
    round: numMap(ps.round),
    stats: numMap(ps.stats),
    shop: {
      level: Number.isFinite(ps.shop?.level) ? ps.shop.level : 1,
      upgradePrice: Number.isFinite(ps.shop?.upgradePrice) ? ps.shop.upgradePrice : 0,
      freeRefreshes: Number.isFinite(ps.shop?.freeRefreshes) ? ps.shop.freeRefreshes : 0,
    },
    loadout: plainLoadout(ps.loadout),
    /** v2: the full engine state of the seat (`null` for a match implementation without PlayerState — the stub) */
    props: hasEngineShape(ps) ? captureProps(ps) : null,
  };
}

/**
 * The match-level RUN state of a record (v2): whatever `Match.captureRunState` hands over — the six rng positions, the
 * uid / battle counters, the shared pool's remaining copies and the recorded round's waves. `null` for a match that
 * exposes none (the platform stub): such a record carries no engine state to re-enter, which the re-entry gate in
 * resume.js reads as "not a P2a record" instead of guessing.
 */
function captureRunState(match) {
  if (!match || typeof match.captureRunState !== 'function') return null;
  try { return match.captureRunState() || null; } catch { return null; }
}

/**
 * Build the record for one match.
 * @param {import('../match/Match.js').Match} match
 * @param {{ build?: string | null, rulesHash?: string | null, now?: number, tokenHashOf?: (playerId: string) => string | null }} [opts]
 */
export function buildRecord(match, { build = null, rulesHash = null, now = Date.now(), tokenHashOf = null } = {}) {
  const players = [];
  const seats = [];
  // `order` is the real engine's seat order; a platform stub may only expose `players` (the documented interface), so
  // fall back to its values rather than writing an empty — and therefore useless — record.
  const rows = Array.isArray(match.order) && match.order.length
    ? match.order
    : (match.players instanceof Map ? [...match.players.values()] : []);
  for (const ps of rows) {
    let hash = null;
    if (!ps.isBot && typeof tokenHashOf === 'function') {
      try { hash = tokenHashOf(ps.playerId) || null; } catch { hash = null; }
    }
    seats.push(captureSeat(ps, hash));
    players.push(capturePlayer(ps));
  }
  return {
    version: RECORD_VERSION,
    // the code is the room identity and the record key; matchNo tells two matches of one room apart
    code: match.roomCode,
    matchNo: Number.isInteger(match.opts?.matchNo) ? match.opts.matchNo
      : (Number.isInteger(match.matchNo) ? match.matchNo : null),
    mode: match.mode,
    difficulty: match.difficulty,
    modeId: match.modeId,
    seed: match.seed,
    round: Number.isInteger(match.round) ? match.round : 0,
    phase: match.phase,
    deadline: Number.isFinite(match.deadline) ? match.deadline : 0,
    paused: !!match.paused,
    ended: !!match.ended,
    startedAt: Number.isFinite(match.startedAt) ? match.startedAt : null,
    /**
     * v2: one human seat at the start of the match (Match.loneHuman). P2a only re-enters a lone-human match — a co-op
     * seat depends on teammates that are not rebuilt — so the flag rides with the record for the gate to read.
     */
    loneHuman: match.loneHuman != null ? !!match.loneHuman : rows.filter((p) => p && !p.isBot).length === 1,
    /**
     * v2: the mode's round boundaries. The re-entry gate refuses a record at/after the Hidden Core chapter, because
     * that chapter is entered from the VISIBLE final assault's live outcome (team LP, the shared boss pool, the layer
     * sum) which a record does not hold (see resume.js `resumePlan`).
     */
    lastRound: Number.isInteger(match.gd?.lastRound) ? match.gd.lastRound : null,
    hiddenRound: Number.isInteger(match.gd?.hiddenRound) ? match.gd.hiddenRound : null,
    seats,
    players,
    /** v2: the volatile run state (rng / pool / counters / waves) — `null` when the match exposes none (stub) */
    state: captureRunState(match),
    build: build ?? null,
    rulesHash: rulesHash ?? null,
    updatedAt: now,
  };
}

/** True when the record describes at least one human seat that has not departed (the only resumable kind). */
export function hasHuman(record) {
  return !!record && Array.isArray(record.seats) && record.seats.some((s) => s && !s.isBot && !s.left);
}

/**
 * Restore the payload captured by `capturePlayer` onto a rebuilt PlayerState. Assigns only fields this module
 * captured (never a piece collection), and only onto containers the seat actually has — a match implementation with a
 * narrower player shape (the platform stub) is left with what it supports instead of throwing mid-resume.
 * @param {import('../match/PlayerState.js').PlayerState} ps @param {any} payload
 * @returns {boolean} true when something was applied
 */
export function applyPayload(ps, payload) {
  if (!ps || !payload || typeof payload !== 'object' || payload.playerId !== ps.playerId) return false;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  /** Merge numeric maps into an existing container (a missing container is simply not restorable). */
  const merge = (target, src) => { if (target && typeof target === 'object') Object.assign(target, numMap(src)); };
  ps.lp = num(payload.lp, ps.lp);
  ps.bandId = typeof payload.bandId === 'string' ? payload.bandId : ps.bandId;
  ps.funds = num(payload.funds, ps.funds);
  ps.pendingFunds = num(payload.pendingFunds, ps.pendingFunds);
  ps.prepsEnded = Number.isInteger(payload.prepsEnded) ? payload.prepsEnded : ps.prepsEnded;
  ps.ready = !!payload.ready;
  ps.infoReady = !!payload.infoReady;
  ps.autoplay = !!payload.autoplay;
  ps.deployCapBonus = num(payload.deployCapBonus, ps.deployCapBonus);
  ps.deployCapMin = num(payload.deployCapMin, ps.deployCapMin);
  merge(ps.layers, payload.layers);
  merge(ps.bondCountBonus, payload.bondCountBonus);
  merge(ps.counters, payload.counters);
  merge(ps.round, payload.round);
  if (ps.stats && typeof ps.stats === 'object') {
    for (const [k, v] of Object.entries(numMap(payload.stats))) if (k in ps.stats) ps.stats[k] = v;
  }
  if (payload.shop && typeof payload.shop === 'object' && ps.shop && typeof ps.shop === 'object') {
    ps.shop.level = num(payload.shop.level, ps.shop.level);
    ps.shop.upgradePrice = num(payload.shop.upgradePrice, ps.shop.upgradePrice);
    ps.shop.freeRefreshes = num(payload.shop.freeRefreshes, ps.shop.freeRefreshes);
  }
  const loadout = plainLoadout(payload.loadout);
  if (Object.keys(loadout).length && typeof ps.setLoadout === 'function') ps.setLoadout(loadout);
  if (payload.alive === false && ps.alive && typeof ps.eliminate === 'function') {
    // `eliminate(round)` also clears the board/hand and dispatches nothing: safe on a freshly rebuilt seat
    ps.eliminate(Number.isInteger(payload.eliminatedRound) ? payload.eliminatedRound : 0);
  }
  return true;
}
