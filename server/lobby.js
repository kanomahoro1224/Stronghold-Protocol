// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.addBot, room.removeBot, room.kick, room.start. ▸ Changing the difficulty
//     un-readies the other humans. ▸ room.start requires every other human to be connected and ready;
//     the host's start counts as the host's ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, AI
//     seats, start), leave it, or a new match starts. A human removed by the lobby grace gets them right after
//     `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the lobby drops the
//     match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout (stored for its session,
//     never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).

import { randomBytes, randomInt } from 'node:crypto';
import { ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor } from '../shared/constants.js';
import { checkLoadout } from '../shared/protocol.js';
import { encode, isDroppable, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { tokenHash } from './state/snapshot.js';
import { recordSeats, applyRecord } from './state/resume.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  // 搜寻队友 / matchmaking (research 06 §3.3, DESIGN §23)
  matchQueueMaxPerAddr: 8,      // queue entries from one client network at once (0 = unlimited)
  matchQueueMax: 128,           // entries per difficulty pool
  // Idle suspension (DESIGN §23, P1b): freeze a match whose humans are all disconnected — its takeover fields burn
  // a core for nobody. 0 disables it (Match.IDLE_PAUSE_MS / IDLE_CHECK_MS are the shared defaults).
  idlePauseMs: null,
  idleCheckMs: null,
});

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']);

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null }} Seat
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(MAX_SEATS).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    this.disposed = false;
  }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /** `room.state` frame (DESIGN §8.1) plus `inMatch`. */
  toState() {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      inMatch: !!this.match,
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected })),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   *   state?: import('./state/resume.js').StateBridge | null,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, options = {}, state = null }) {
    this.registry = registry;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    /**
     * Match-state persistence (server/state/resume.js, P0/P1). The lobby only ever calls it on its own lifecycle
     * edges and passes it into the match as `opts.stateSink`; `null` (tests, tools, SP_STATE=off) disables all of it.
     * @type {import('./state/resume.js').StateBridge | null}
     */
    this.state = state;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /**
     * 搜寻队友 pools by difficulty (DESIGN §23): `{ difficulty, entries: [{ session, at }] }`. A pool has no timer —
     * the search runs until four connected doctors are in it (or the searcher cancels), so nothing expires by itself.
     * @type {Map<string, { difficulty: string, entries: { session: any, at: number }[] }>}
     */
    this.queues = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  // ---------------------------------------------------------------------------------------------------
  // match-state persistence (server/state/resume.js, P0/P1)
  // ---------------------------------------------------------------------------------------------------

  /**
   * Durable identity of a returning client (called by server/net.js on a `hello` whose token this process does not
   * know — i.e. after a crash/restart). The persisted record holds `sha256(token)` per human seat, so the seat's
   * ORIGINAL playerId comes back and the match below can be rebuilt for it. One-shot: see StateBridge.claim.
   * @param {unknown} token the token the client presented
   * @returns {{ playerId: string, roomCode: string } | null}
   */
  adoptIdentity(token) {
    const hit = this.state && typeof this.state.claim === 'function' ? this.state.claim(token) : null;
    if (!hit) return null;
    return { playerId: hit.playerId, roomCode: hit.code };
  }

  /**
   * Hand a running match to the state bridge (opts.stateSink + the start/end edges). No I/O: the bridge only enqueues
   * on its single-writer queue, so this is safe from a phase transition.
   * @param {Room} room @param {any} match @param {string} reason
   */
  noteMatch(room, match, reason) {
    if (!this.state) return false;
    // a bot-only room, a room whose humans all departed, and a finished match are never persisted (design §8)
    if (!room || room.disposed || !room.activeHumans().length) return false;
    void reason;
    return this.state.noteMatch(match, {
      tokenHashOf: (playerId) => tokenHash(this.registry.byId(playerId)?.token),
      now: this.now(),
    });
  }

  /**
   * Hand a room whose match is NOT running to the state bridge (P2). Called from `broadcastState` — every room
   * lifecycle edge ends there (create, join, leave, ready, difficulty, bots, kick, spectate, match end, disconnect)
   * and the game loop never does, so this is the room's one write point.
   *
   * A room with a LIVE match is described by its MATCH record instead, which already carries the room's whole shape
   * (seats, names, loadouts, token hashes), so this refuses while one runs: both write the same key and the match's
   * document is the richer one. When the match ends its record is replaced by this one, in a single write.
   * @param {Room} room @param {string} reason
   */
  noteRoom(room, reason) {
    if (!this.state) return false;
    if (!room || room.disposed) return false;
    if (room.match && !room.match.ended && !room.match.disposed) return false;
    void reason;
    return this.state.noteRoom(room, {
      tokenHashOf: (playerId) => tokenHash(this.registry.byId(playerId)?.token),
      now: this.now(),
    });
  }

  /**
   * Rebuild the persisted room + match of `session.roomCode` because a human just came back (P0/P1, lazy). Called
   * only from onHello: a returning player is the trigger, so a rehydrated match never exists while nobody is there to
   * play it (and `idlePauseMs` still freezes it if that player drops again).
   * @param {import('./net.js').Session} session
   * @returns {boolean} true when the caller may continue down the normal resume path
   */
  rehydrate(session) {
    const code = session.roomCode;
    const rec = this.state && typeof this.state.record === 'function' ? this.state.record(code) : null;
    if (!rec) return false;
    if (this.rooms.has(code)) return true; // already rebuilt (a second tab of the same player)
    if (this.rooms.size >= this.opts.maxRooms) {
      this.limitWarn(`resume of ${code} refused: room limit (${this.opts.maxRooms}) reached`);
      return false;
    }
    const room = new Room(rec.code, rec.mode, rec.difficulty, this.now());
    // The room's own `ready` flag lives on the RECORD's seat rows (a match record keeps it in the seat payload instead,
    // which applyRecord applies). `recordSeats` is the Match-constructor view and deliberately does not carry it.
    const recordedSeat = new Map((Array.isArray(rec.seats) ? rec.seats : []).filter(Boolean).map((s) => [s.playerId, s]));
    for (const s of recordSeats(rec)) {
      room.seats[s.seat] = {
        seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot,
        // P2: a ROOM record is the lobby's own state, so its `ready` flag and a departed seat are part of what comes
        // back. A MATCH record overwrites both from its payloads (applyRecord), so the match path is unaffected.
        ready: !!(recordedSeat.get(s.playerId) || {}).ready, connected: false, left: !!s.left,
        loadout: s.loadout || null,
      };
    }
    // spectators are part of the room too (P2): they come back, and are re-attached by their own hello
    if (Array.isArray(rec.spectators)) {
      room.spectators = rec.spectators.map((s) => ({ playerId: s.playerId, name: s.name || '', connected: false }));
    }
    // the recorded host, when that seat is still in the room; otherwise the first human that is (host migration)
    const recordedHost = rec.host ? room.seatOf(rec.host) : null;
    const first = room.activeHumans()[0] || null;
    room.hostId = recordedHost && !recordedHost.left ? recordedHost.playerId : (first ? first.playerId : null);
    // a ROOM record counts FINISHED matches (`matchCount`), a MATCH record counts the one it is inside (`matchNo`)
    room.matchCount = rec.inMatch === false ? (Number.isInteger(rec.matchNo) ? rec.matchNo : 0)
      : Math.max(0, (rec.matchNo || 1) - 1);
    this.rooms.set(room.code, room);
    this.log.info(`[lobby] ${room.code} resuming match #${rec.matchNo ?? '?'} `
      + `(R${rec.round} ${rec.phase}, ${rec.mode}/${rec.difficulty}, seed ${rec.seed})`);
    // P2: a room whose match was not running is rebuilt as a ROOM. There is no round to re-enter and no payload to
    // apply — the returning players are back in their own lobby, on their own seats, with the flags they left.
    if (rec.inMatch === false) return true;
    if (this.resumeMatch(room, rec)) return true;
    // the record could not be rebuilt: drop it so a returning player is not trapped in a room that cannot exist
    room.disposed = true;
    this.rooms.delete(room.code);
    this.state.forget(room.code);
    return false;
  }

  /**
   * Construct the match of a persisted record (same seed / matchNo / seats ⇒ the same match the dead process ran),
   * start it, then re-enter the recorded round and apply the recorded per-player payload (server/state/resume.js).
   * @param {Room} room @param {any} rec
   */
  resumeMatch(room, rec) {
    const seats = recordSeats(rec).map((s) => ({
      seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected, loadout: s.loadout,
    }));
    if (!seats.length) return false;
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: rec.mode,
        difficulty: rec.difficulty,
        modeId: rec.modeId || modeIdFor(rec.mode, rec.difficulty),
        seats,
        spectators: room.spectators.map((s) => s.playerId),
        seed: rec.seed,
        matchNo: rec.matchNo || room.matchCount + 1,
        idlePauseMs: this.opts.idlePauseMs,
        idleCheckMs: this.opts.idleCheckMs,
        data: this.safeData(),
        log: this.log,
        now: this.now,
        stateSink: (reason, m) => this.noteMatch(room, m, reason),
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.replay = null;
      room.matchCount = rec.matchNo || room.matchCount + 1;
      match.start();
      // the recorded round + payload, unless start() already ended the match (unusable data, bot-only room)
      if (!match.ended && !match.disposed) applyRecord(match, rec);
      this.broadcastState(room);
      return true;
    } catch (e) {
      this.log.error(`[lobby] ${room.code} failed to resume its persisted match`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      return false;
    }
  }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let fields = 0;
    let fieldsIdle = 0;
    let fieldsInThread = 0;
    let fieldsPooled = 0;
    let paused = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) {
        matches++;
        // The server's own simulation load: battles it steps on its single core (DESIGN §23). `fieldsIdle` is the
        // subset nobody is watching — a match whose humans are all disconnected still steps their takeover fields
        // until the idle suspension (P1b) freezes it, which `paused` counts. `fieldsInThread` is the part of `fields`
        // the event loop itself advances (client-side combat: every bot seat / takeover field is a HeadlessJob),
        // `fieldsPooled` the part that runs in a worker (P2).
        if (typeof r.match.hostedFields === 'function') {
          const n = r.match.hostedFields();
          fields += n;
          if (typeof r.match.liveHumans === 'function' && r.match.liveHumans() === 0) fieldsIdle += n;
        }
        if (typeof r.match.hostedFieldStats === 'function') {
          const st = r.match.hostedFieldStats() || {};
          if (typeof st.inThread === 'number') fieldsInThread += st.inThread;
          if (typeof st.pooled === 'number') fieldsPooled += st.pooled;
        }
        if (r.match.paused) paused++;
      }
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      // a real Room always carries the array (constructor); a stub / predating room must not break the aggregation
      spectators += r.spectators?.length ?? 0;
    }
    return { rooms: this.rooms.size, matches, humans, bots, spectators, fields, fieldsIdle, fieldsInThread, fieldsPooled, paused, queued: this.queueSize() };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /** Entries waiting in every 搜寻队友 pool (healthz + the per-network cap). */
  queueSize() {
    let n = 0;
    for (const pool of this.queues.values()) n += pool.entries.length;
    return n;
  }

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    // P0/P1 (server/state/resume.js): a FRESH session may still be a returning player — net.js handed it the playerId
    // and room code a persisted record proves for the token it presented (adoptIdentity). Nothing is rebuilt until
    // exactly this moment: the lazy half of the design (boot only marks matches resumable).
    if (!resumed && !repeat) {
      if (!session.roomCode) return;
      if (!this.rehydrate(session)) { session.roomCode = null; return; }
    }
    const pool = this.queueOf(session);
    if (pool) {
      // Reconnected while searching: bring the 搜寻 panel back. The reconnect may also be the fourth doctor the pool
      // was waiting for — the pool has no timer, so a group only ever forms on an event like this one.
      this.pruneQueue(pool);
      if (this.connectedIn(pool) >= MAX_SEATS && this.formQueue(pool, 2)) return;
      this.sendQueue(pool, session);
    }
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, !resumed);
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  onMessage(session, msg) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.loadout': return this.loadout(session, msg);
      case 'queue.join': return this.queueJoin(session, msg);
      case 'queue.leave': return this.queueLeave(session);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.clearResync(session.playerId); // the next resume resyncs immediately
    // A searcher who drops keeps their pool entry (a reconnect resumes the search), but the doctors still waiting
    // must see the smaller count — and the solo hint — right away: with no deadline timer there is nothing else that
    // would tell them (DESIGN §23).
    const waiting = this.queueOf(session);
    if (waiting) {
      this.pruneQueue(waiting);
      this.broadcastQueue(waiting);
    }
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) { if (player) this.callMatch(room, 'onDisconnect', session.playerId); } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    this.dequeue(session, { notify: false }); // a search does not outlive the session that started it
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
    for (const pool of [...this.queues.values()]) this.clearPool(pool);
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty }) {
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human (a spectator is none).
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId) ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    // Only once the create can no longer fail: a refused create must not silently end a 搜寻队友 search, or the
    // client would be left showing a search panel the server has already forgotten (DESIGN §23).
    this.dequeue(session, { notify: false });
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now());
    room.ownerKey = key;
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}) by ${session.name}`);
    this.broadcastState(room);
    return OK;
  }

  join(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    // Only once the join can no longer fail: a refused join must not silently end a 搜寻队友 search (DESIGN §23).
    this.dequeue(session, { notify: false });
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    return OK;
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, connected: session.connected });
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.difficulty !== difficulty) {
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    if (this.seatBot(room) < 0) return fail(ERR.ROOM_FULL);
    this.broadcastState(room);
    return OK;
  }

  /**
   * Seat one AI teammate in the room's lowest free seat (room.addBot and 搜寻队友's fill-up, DESIGN §23).
   * @param {Room} room
   * @returns {number} the seat index, or -1 when the room has no free seat
   */
  seatBot(room) {
    const idx = room.freeSeat();
    if (idx < 0) return -1;
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    return idx;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout against the game data, store it on the session and the seat,
   * and — while a match runs — hand it to the match (accepted only during INFO_CHECK, see the header).
   */
  loadout(session, { entries }) {
    const data = this.safeData();
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const loadout = freezeLoadout(res.loadout);
    session.loadout = loadout;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.loadout = loadout;
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  // ---------------------------------------------------------------------------------------------------
  // 搜寻队友 / matchmaking (research 06 §3.3, DESIGN §23)
  // ---------------------------------------------------------------------------------------------------

  /**
   * `queue.join {difficulty}`: search for teammates in that difficulty's pool. One entry per session — an existing
   * lobby room is left first (like room.create) and searching while a match runs is refused. Four connected doctors
   * form a room at once; with fewer the pool simply keeps waiting (no deadline, no AI fill — the searcher cancels or
   * keeps waiting, DESIGN §23).
   */
  queueJoin(session, { difficulty }) {
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    const had = this.queueOf(session);
    if (had && had.difficulty === difficulty) { this.sendQueue(had, session); return OK; } // repeated click / reconnect
    if (had) this.dequeue(session, { notify: false });
    let entries = 0;
    let mine = 0;
    const key = session.limitKey || null;
    for (const pool of this.queues.values()) {
      this.pruneQueue(pool); // ghosts would count against the caps and could refuse a real searcher
      entries += pool.entries.length;
      if (key) for (const e of pool.entries) if (e.session.limitKey === key) mine++;
    }
    if (entries >= this.opts.matchQueueMax) return fail(ERR.RATE, 'the matchmaking queue is full');
    if (key && this.opts.matchQueueMaxPerAddr > 0 && mine >= this.opts.matchQueueMaxPerAddr) {
      this.limitWarn(`matchmaking queue limit (${this.opts.matchQueueMaxPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many search requests from your network');
    }
    if (cur) this.removeMember(cur, session.playerId);
    const pool = this.poolOf(difficulty);
    pool.entries.push({ session, at: this.now() });
    this.log.info(`[lobby] queue/${difficulty}: +${session.name} (${this.connectedIn(pool)}/${MAX_SEATS} 真人)`);
    // Four connected humans start at once. Fewer than that keep waiting: there is no deadline and no AI fill, so a
    // failed formation (room cap, code space) just leaves the pool for the next join / reconnect to retry.
    if (this.connectedIn(pool) >= MAX_SEATS && this.formQueue(pool, 2)) return OK;
    this.broadcastQueue(pool);
    return OK;
  }

  /**
   * `queue.leave`: cancel the search. Idempotent — the client may click twice, or cancel after a formation.
   * The log line is the only way to tell a cancel that arrived from one the network swallowed (a half-open
   * socket looks identical from the server's side), so keep it.
   */
  queueLeave(session) {
    const pool = this.queueOf(session);
    this.dequeue(session, { notify: true });
    if (pool) this.log.info(`[lobby] queue/${pool.difficulty}: -${session.name} (${this.connectedIn(pool)}/${MAX_SEATS} 真人)`);
    return OK;
  }

  /** The pool a session waits in, or null. Pools are tiny (≤ MAX_SEATS) and there is at most one per difficulty. */
  queueOf(session) {
    for (const pool of this.queues.values()) if (pool.entries.some((e) => e.session === session)) return pool;
    return null;
  }

  /** Humans still connected in a pool: what `queue.state.size` reports and who fills the room. */
  connectedIn(pool) {
    let n = 0;
    for (const e of pool.entries) if (e.session.connected) n++;
    return n;
  }

  /** The pool of a difficulty, created on demand. */
  poolOf(difficulty) {
    let pool = this.queues.get(difficulty);
    if (!pool) {
      pool = { difficulty, entries: [] };
      this.queues.set(difficulty, pool);
    }
    return pool;
  }

  /**
   * Earliest join time among the pool's **connected** members, or Infinity when nobody is connected. A member who
   * dropped keeps their entry (a reconnect resumes the search) but must not drive the count-up: otherwise a stale
   * entry would show the next searcher a wait that started before they arrived.
   */
  firstAt(pool) {
    let first = Infinity;
    for (const e of pool.entries) if (e.session.connected && e.at < first) first = e.at;
    return first;
  }

  /**
   * Drop entries whose session is gone from the registry. The registry evicts an old, disconnected, roomless
   * session without calling `onExpire`, so a queued ghost would otherwise keep counting against `matchQueueMax`
   * and `matchQueueMaxPerAddr` forever. Callers are the pool's write paths (join, formation, reconnect).
   * @returns {number} entries dropped
   */
  pruneQueue(pool) {
    const live = pool.entries.filter((e) => e.session.connected || this.registry.byId(e.session.playerId) === e.session);
    const dropped = pool.entries.length - live.length;
    if (dropped) pool.entries = live;
    return dropped;
  }

  /** Take a session out of its pool (cancel, room switch, expiry). */
  dequeue(session, { notify = true } = {}) {
    const pool = this.queueOf(session);
    if (!pool) {
      if (notify) sendSession(session, { t: 'queue.state', active: false });
      return false;
    }
    pool.entries = pool.entries.filter((e) => e.session !== session);
    if (pool.entries.length) this.broadcastQueue(pool);
    else this.clearPool(pool);
    if (notify) sendSession(session, { t: 'queue.state', active: false });
    return true;
  }

  /** Drop every entry (the pool formed a room, or emptied). */
  clearPool(pool) {
    pool.entries = [];
    this.queues.delete(pool.difficulty);
  }

  /**
   * `queue.state` for a pool: `waitedMs` lets the client count the search up without extra traffic. There is no
   * deadline — `solo` is just "you are the only one searching right now", recomputed on every send.
   * @returns {object | null} null when nobody in the pool is connected (nothing to report)
   */
  queueState(pool) {
    const first = this.firstAt(pool);
    if (first === Infinity) return null;
    const size = this.connectedIn(pool);
    return {
      t: 'queue.state',
      active: true,
      difficulty: pool.difficulty,
      size,
      max: MAX_SEATS,
      waitedMs: Math.max(0, this.now() - first),
      solo: size < 2,
    };
  }

  broadcastQueue(pool) {
    const st = this.queueState(pool);
    if (!st) return;
    for (const e of pool.entries) if (e.session.connected) sendSession(e.session, st);
  }

  sendQueue(pool, session) {
    const st = this.queueState(pool);
    if (st) sendSession(session, st);
  }

  /**
   * Form a co-op room out of a pool and start it: every connected member is seated, the free seats get AI teammates,
   * everyone is ready by construction (匹配成功直接开局, no ready check) and the match starts at once.
   * @param {{ difficulty: string, entries: { session: any, at: number }[] }} pool
   * @param {number} minHumans the connected humans a formation needs (2: the caller only forms a full pool)
   * @returns {boolean} whether a room was formed (false leaves the pool untouched)
   */
  formQueue(pool, minHumans) {
    this.pruneQueue(pool);
    const members = [];
    for (const e of pool.entries) {
      const s = e.session;
      // A member who dropped merely stops being counted (their entry stays, so a reconnect resumes the search);
      // anyone who started something else meanwhile is out.
      if (!s.connected) continue;
      const room = this.roomOf(s);
      if (room && room.match) continue;
      members.push(s);
    }
    if (members.length < minHumans) return false;
    if (this.rooms.size >= this.opts.maxRooms) {
      this.log.error(`[lobby] queue/${pool.difficulty}: ${this.rooms.size} rooms is the cap — not forming`);
      return false;
    }
    const code = this.genCode();
    if (!code) return false;
    const difficulty = pool.difficulty;
    // A room holds MAX_SEATS. More connected humans than that is only reachable through reconnects (queue.join forms
    // at four), and then the earliest four play while the rest keep searching instead of being dropped on the floor.
    const seated = members.slice(0, MAX_SEATS);
    pool.entries = pool.entries.filter((e) => !seated.includes(e.session));
    if (!pool.entries.length) this.clearPool(pool);
    const room = new Room(code, 'coop', difficulty, this.now());
    room.ownerKey = seated[0].limitKey || null;
    for (const s of seated) {
      const idx = room.freeSeat();
      if (idx < 0) break; // defensive: `seated` is capped at MAX_SEATS
      const seat = this.humanSeat(idx, s);
      seat.ready = true;
      room.seats[idx] = seat;
      s.roomCode = code;
      s.notice = null;
      s.pendingResult = null;
    }
    room.hostId = seated[0].playerId;
    this.rooms.set(code, room);
    while (this.seatBot(room) >= 0) { /* AI teammates fill the alliance up */ }
    const ai = room.seats.filter((s) => s && s.isBot).length;
    this.log.info(`[lobby] ${code} 搜寻队友 formed (${difficulty}: ${room.activeHumans().length} 真人 + ${ai} AI)`);
    // The search is over for everyone seated: clear the clients' 搜寻 panel before the room.state that replaces the
    // screen. Whoever is left waiting gets the smaller pool instead.
    for (const s of seated) sendSession(s, { t: 'queue.state', active: false });
    if (pool.entries.length) this.broadcastQueue(pool);
    this.broadcastState(room); // every client switches to the room screen on this frame
    this.startMatch(room, this.matchKeyFor(seated));
    return true;
  }

  /**
   * Per-network match attribution of a formed group: the earliest member's network. Attributed unconditionally, so a
   * formed match always counts against `maxMatchesPerAddr` — returning null when every member's network was at its
   * cap would let one network keep forming groups past it. The group itself is never refused because of a
   * teammate's network: the queue's own `matchQueueMaxPerAddr` entry cap already bounds that.
   */
  matchKeyFor(members) {
    for (const m of members) if (m.limitKey) return m.limitKey;
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    const seats = room.seats.filter(Boolean).map((s) => ({
      seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
      // DESIGN §16: the human's checked operator loadout (bots fight with the defaults)
      loadout: s.isBot ? null : s.loadout || null,
    }));
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        modeId: modeIdFor(room.mode, room.difficulty),
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        // idle suspension (DESIGN §23, P1b); null lets Match fall back to SP_IDLE_PAUSE_MS / its defaults
        idlePauseMs: this.opts.idlePauseMs,
        idleCheckMs: this.opts.idleCheckMs,
        data: this.safeData(),
        log: this.log,
        now: this.now,
        // match-state persistence (P0/P1): the match calls this at ROUND_START / SETTLE and every few seconds in
        // between; the lobby turns it into a record on the write queue (never I/O in the match)
        stateSink: (reason, m) => this.noteMatch(room, m, reason),
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      this.broadcastState(room);
      match.start();
      // match-state persistence (P0/P1): the record is created when the match starts, so a crash in the first seconds
      // of a match is still resumable (the phase transitions below only refresh it)
      this.noteMatch(room, match, 'start');
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    // the match is over: its persisted record must not survive it (P0/P1 — a finished match is never resumable)
    if (this.state) this.state.forget(room.code);
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  routeGame(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    // a disposed room has nothing to come back to (P0/P1): delete its record now, not on the next TTL sweep
    if (this.state) this.state.forget(room.code);
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    // P2: this is the room's single lifecycle edge — every room change ends here and the game loop never calls it —
    // so it is also where the room's OWN record is kept in step (noteRoom skips a room whose match is running).
    this.noteRoom(room, 'broadcast');
    const data = encode(room.toState());
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
  }

  sendState(room, session) {
    sendSession(session, room.toState());
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const droppable = isDroppable(msg);
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, { droppable });
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}
