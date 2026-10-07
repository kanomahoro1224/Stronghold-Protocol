// server/match/match/state.js — Match methods: match-state persistence (server/state/*, P0/P1/P2a) and the freeze
// primitive that parks it. The engine itself stays I/O-FREE: a phase transition only calls the injected
// `opts.stateSink(reason, match)` (fire-and-forget — the sink owns the disk, server/state/persist.js), and a rebuilt
// match is put back where a record left it by `restoreRunState` (the volatile run state: the six random streams, the
// uid / battle counters, the shared pool and the recorded round's waves) plus the per-seat payload the caller applies.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE } from '../../../shared/constants.js';
import { BOSS_CLOCK_MS } from './common.js';

/**
 * Match-state persistence heartbeat: while a round is active the match hands its state to the injected
 * `opts.stateSink` (reason 'heartbeat') every this-many ms. That write is what a resume usually sees — an untimed
 * lone-human PREP lasts minutes and the record on disk is refreshed every few seconds — and it is re-enterable
 * (server/state/resume.js `resumePlan` includes PREP), so a crash loses at most a few seconds of a prep. A crash
 * mid-COMBAT still loses the round itself: a battle in flight is not persisted. The heartbeat rides the match's own
 * scheduler (`later`, unref'd) and parks on a frozen match like the 1 Hz progress ticker — the game loop still never
 * awaits a disk write; the sink is fire-and-forget.
 */
export const STATE_HEARTBEAT_MS = 4000;

export class MatchState {
  /**
   * Re-enter the round a persisted record stopped in, as the caller read it back from the record
   * (server/state/resume.js `applyRecord` → `resumePlan`).
   *
   * @param {number} round @param {{ playerStart?: boolean, drawWave?: boolean, wave?: any, bossWaves?: any,
   *          intoPrep?: boolean, rewind?: boolean }} [opts]
   *   `playerStart:false` keeps `PlayerState.startRound` (income / upgrade price / shop roll) from running a second
   *   time on top of a payload that already contains it; `drawWave:false` keeps `this.wave` / `this.bossWaves` the
   *   caller restored from the record (they are the recorded round's enemies, restored BY VALUE — a fresh draw would
   *   build the NEXT round's wave) instead of drawing them; `intoPrep` (a PREP record): the recorded phase is the OPEN
   *   prep, so the round start must neither replay this round's 机变 draft (a second card) nor re-run the prep entry (a
   *   cleared `ready`, a second `onPrepStart`); `rewind` (a COMBAT / UNITE / FINAL_ASSAULT record, P2b): the round was
   *   already fought, so the draft is skipped the same way, but the prep entry RUNS — the round is refought from the
   *   same prep (see `afterRoundStart`).
   * @returns {boolean} false when the match is already over (or round is unusable)
   */
  resumeAt(round, { playerStart = true, drawWave = true, wave = undefined, bossWaves = undefined, intoPrep = false, rewind = false } = {}) {
    if (this.disposed || this.ended) return false;
    const r = Number.isInteger(round) && round > 0 ? Math.min(round, this.gd.lastRound) : 1;
    this.cancel(this._phaseTimer);
    this._phaseTimer = null;
    this.draft = null;
    this.sp = null;
    // the briefing is over: a seat that never sent g.infoReady must not hold a rebuilt round back
    for (const ps of this.order) { if (!ps.isBot && !ps.left) ps.infoReady = true; }
    // the recorded round's enemies are RESTORED, not re-drawn: the record was written after rngWaves consumed the
    // recorded round's draw, so a fresh draw would build the next round's wave (P2a persists the wave by value rather
    // than rewinding the stream — see server/state/snapshot.js)
    if (!drawWave) {
      this.wave = wave === undefined ? null : wave;
      this.bossWaves = bossWaves === undefined ? null : bossWaves;
    }
    this.startRound(r, { playerStart, drawWave, intoPrep, rewind });
    return true;
  }

  /**
   * Hand a snapshot request to the injected sink. Fire-and-forget by contract: the sink may not throw and may not
   * await anything of this match — the queue behind it owns the disk (server/state/persist.js). A missing sink (tests,
   * tools, simulations) makes this a no-op.
   *
   * A FROZEN match (`_freeze`, the owner's solo pause / an idle suspension) writes nothing at all: the record on disk
   * is the state of a match that is not running, and the resume refreshes it. The gate lives here rather than in the
   * three call sites so a phase the engine still walks through while frozen (the transition already armed when it was
   * frozen) cannot write either — the freeze is the whole contract, not only the heartbeat.
   * @param {string} reason 'round_start' | 'settle' | 'heartbeat'
   */
  _persistState(reason) {
    const sink = this.stateSink;
    if (!sink || this._frozen || this.paused) return;
    try { sink(reason, this); } catch (e) { this.reportError('stateSink', e); }
  }

  /**
   * The volatile RUN state a persisted record has to carry on top of the per-seat payload (server/state/snapshot.js,
   * record v2 / P2a). A rebuilt match re-derives everything the constructor derives from the seed, but NOT:
   *   * the six random streams (rng.js mulberry32 `state()` / `setState()`), each one a single uint32 — a rebuilt match
   *     would otherwise replay the setup stream from the start;
   *   * `uidSeq` and `_battleSeq` (piece uids, battleIds) — restored so the rebuilt match allocates exactly the ids the
   *     recording process would have allocated next (`battlePrefix` is seed-derived; it rides along for completeness);
   *   * the shared pool's remaining copies (`pool.snapshot()`, restored by `pool.restore()` clamps);
   *   * the recorded round's enemies BY VALUE: at a ROUND_START record rngWaves has already consumed that round's draw,
   *     so re-drawing would build the NEXT round's wave — the wave is captured instead (P2a's choice; the alternative,
   *     a pre-round rng rewind, needs a per-round snapshot and still re-draws).
   * A match without a pool (the platform stub) captures nothing: `null` means "no engine state", which is what the
   * re-entry gate in resume.js reads.
   * @returns {object | null}
   */
  captureRunState() {
    if (!this.pool || typeof this.pool.snapshot !== 'function' || !this.rngSetup || typeof this.rngSetup.state !== 'function') return null;
    return {
      rng: {
        setup: this.rngSetup.state(),
        shop: this.rngShop.state(),
        waves: this.rngWaves.state(),
        draft: this.rngDraft.state(),
        bots: this.rngBots.state(),
        meta: this.rngMeta.state(),
      },
      uidSeq: this.uidSeq,
      battleSeq: this._battleSeq,
      battlePrefix: this.battlePrefix,
      pool: this.pool.snapshot(),
      // undefined → null on purpose: the record goes through JSON, where `undefined` disappears and would read back as
      // "draw a fresh wave" instead of "this round had no wave" (a boss round keeps its enemies in `bossWaves`)
      wave: this.wave ?? null,
      bossWaves: this.bossWaves ?? null,
    };
  }

  /**
   * Put a rebuilt match back where `captureRunState` recorded it. No randomness is consumed here, so a caller may
   * restore the streams both before a transition it wants REPLAYED (a SETTLE record → the next round start draws from
   * the recorded position) and after one it wants DISCARDED (a ROUND_START record → the payload is the state, the
   * effects' own draws must not move the stream).
   * @param {object | null} state
   * @returns {number} how many random streams were restored
   */
  restoreRunState(state) {
    if (!state || typeof state !== 'object') return 0;
    const rng = state.rng && typeof state.rng === 'object' ? state.rng : {};
    const streams = {
      setup: this.rngSetup, shop: this.rngShop, waves: this.rngWaves,
      draft: this.rngDraft, bots: this.rngBots, meta: this.rngMeta,
    };
    let n = 0;
    for (const [name, fn] of Object.entries(streams)) {
      if (Number.isFinite(rng[name]) && fn && typeof fn.setState === 'function') { fn.setState(rng[name]); n++; }
    }
    if (Number.isInteger(state.uidSeq) && state.uidSeq >= 0) this.uidSeq = state.uidSeq;
    if (Number.isInteger(state.battleSeq) && state.battleSeq >= 0) this._battleSeq = state.battleSeq;
    if (typeof state.battlePrefix === 'string' && state.battlePrefix) this.battlePrefix = state.battlePrefix;
    if (this.pool && typeof this.pool.restore === 'function' && state.pool) this.pool.restore(state.pool);
    this.wave = state.wave ?? null;
    this.bossWaves = state.bossWaves ?? null;
    return n;
  }

  /** Stop the persistence heartbeat (the round ended / the match is over). */
  _stopStateHeartbeat() {
    if (this._stateTimer) { this.cancel(this._stateTimer); this._stateTimer = null; }
    this._stateWanted = false;
  }

  /**
   * Start (or keep) the mid-round persistence heartbeat (STATE_HEARTBEAT_MS). Like the 1 Hz progress ticker it
   * schedules nothing while a frozen match would otherwise wake up every few seconds for nothing: the tick parks on
   * `paused` and `_unfreeze` hands it the next one exactly once. (Unlike the progress ticker it is NOT skipped on an
   * instant scheduler: the sink itself is the gate — a virtual-clock run without one schedules nothing.)
   */
  _armStateHeartbeat() {
    if (!this.stateSink || this._stateTimer) return;
    if (this.paused || this._frozen) { this._stateWanted = true; return; }
    const tick = () => {
      this._stateTimer = null;
      if (this.disposed || this.ended) return;
      if (this.paused || this._frozen) { this._stateWanted = true; return; }
      this._persistState('heartbeat');
      this._armStateHeartbeat();
    };
    this._stateTimer = this.later(STATE_HEARTBEAT_MS, tick);
  }

  /**
   * Freeze the field clocks, the client-combat deadlines/releases and the boss clock — the primitive behind the owner's
   * solo pause (`setPause`, pause.js) and behind an idle suspension. No-op when already frozen; nothing here shifts a
   * clock (`_unfreeze` does that, by the paused duration). A frozen match is also silent for the persistence
   * subsystem: the heartbeat tick parks on `paused`/`_frozen` (remembering `_stateWanted`) and `_persistState` refuses
   * outright, so a transition the engine still walks through while frozen writes nothing — the resume hands the
   * heartbeat exactly one next tick.
   */
  _freeze() {
    this._frozen = true;
    if (this.paused) return;
    this.paused = true;
    this._pausedAt = this.sched.now();
    for (const f of this.fields) {
      if (!f.cc) continue;
      if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; f.rearmDeadline = true; }
      if (f.doneTimer) { this.cancel(f.doneTimer); f.doneTimer = null; f.rearmRelease = true; }
      // An in-thread headless job (`_runOnServer`) is stepped by a `later(0)` slice chain — ~1 ms of gap after every
      // ~8 ms slice, a ~90% duty cycle — so a frozen match would otherwise keep simulating its bot / takeover battles
      // to the end. Cancel the pending slice; `_unfreeze` hands the SAME closure (`f.sliceStep`) its next one. The sim
      // is tick-based, so a resumed field carries on where its shifted `startAt` says it should.
      if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; f.rearmSlice = true; }
      // P2: a worker-run field stops being granted slices, so a frozen match costs no CPU in a worker either.
      if (f.poolJob) f.poolJob.pause();
    }
    if (this._bossClock) { this.cancel(this._bossClock); this._bossClock = null; }
    this.markPublic();
  }

  /**
   * The actual resume: every clock / deadline moves on by the paused time, the parked tickers (the 1 Hz progress
   * ticker and the persistence heartbeat) get their next tick, and the rearmed deadlines/releases are armed again.
   * No-op when the match is not frozen.
   */
  _unfreeze() {
    // the freeze flag is cleared even when the pause itself is already over (an ending battle phase calls _clearPause,
    // pause.js, which drops `paused` without knowing about `_freeze`) — the chain that parked on the freeze is still
    // owed its next tick, so the thaw below must not be the only way out of here
    this._frozen = false;
    if (this.paused) {
      const d = Math.max(0, this.sched.now() - this._pausedAt);
      this.paused = false;
      this._pausedAt = 0;
      this.pausedMs += d;
      if (this.deadline) this.deadline += d;
      if (this.overtimeAt) this.overtimeAt += d;
      if (this._bossStartAt != null) this._bossStartAt += d;
      for (const f of this.fields) {
        if (!f.cc || f.done) continue;
        f.startAt += d;
        f.lastProgressAt += d;
        if (f.rearmDeadline && f.mode === 'client') this._armDeadline(f);
        if (f.rearmRelease && f.mode === 'server') this._armRelease(f);
        // restart the slice chain of an in-thread server-run field `_freeze` stopped (unfinished job only): it is still
        // owed exactly the slices its clock did not get, and nothing was simulated while it was parked
        if (f.rearmSlice && f.mode === 'server' && f.job && !f.poolJob && f.sliceStep) f.sliceTimer = this.later(0, f.sliceStep);
        if (f.poolJob) f.poolJob.resume(); // P2: the worker was only paused, its battle state never moved on
        f.rearmDeadline = false;
        f.rearmRelease = false;
        f.rearmSlice = false;
      }
      if (this._bossClockOn && !this._bossClock && (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE)) {
        this._bossClock = this.later(BOSS_CLOCK_MS, () => this._bossClockTick());
      }
    }
    // the 1 Hz progress ticker of a frozen match parked on `_progressWanted`: give the chain its next tick now —
    // exactly once (`_armProgressTicker` is a no-op while a tick is already armed)
    if (this._progressWanted) { this._progressWanted = false; this._armProgressTicker(); }
    // the persistence heartbeat parks the same way (P0/P1): a frozen match writes nothing while frozen
    if (this._stateWanted) { this._stateWanted = false; this._armStateHeartbeat(); }
    this.markPublic();
  }
}
