// server/match/match/clientCombat.js — Match methods: client-side combat bookkeeping (DESIGN §14) — field records (the
// JSON BattleSpec + the authority / result state), spec battles on the server, the field clock, the authority (the
// lowest connected seat), b.start per recipient, result deadlines and releases, server runs (headless slices,
// takeovers), field completion → the phase end, and the timers of it all.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE } from '../../../shared/constants.js';
import { Battle } from '../../sim/Battle.js';
import { DeadBattle, syntheticResult, RESULT_GRACE_MS, HARD_CAP_SECONDS, HeadlessJob } from '../fields.js';
import { buildBattleSpec, createBattleFromSpec } from '../../sim/spec.js';
import { createSimPool, parseSimWorkers } from '../simPool.js';

/**
 * The worker-thread simulation pool (DESIGN §26 P2, `SP_SIM_WORKERS`), one per process and OFF by default: `0` keeps
 * every field on the event loop exactly as before, which is also the rollback. Created lazily, because the many
 * processes that never run a real-scheduler match (the whole test suite, tools/matchrun, the balance sims) must not
 * pay for workers they cannot use — and every virtual-scheduler match stays in-thread by construction (see
 * `_runOnServer`). A disabled pool answers `run()` with `null` so callers need no null checks.
 */
let simPool = null;
function sharedSimPool() {
  if (simPool) return simPool;
  const size = parseSimWorkers(typeof process !== 'undefined' && process.env ? process.env.SP_SIM_WORKERS : undefined);
  simPool = size
    ? createSimPool({ size, log: console })
    : { enabled: false, size: 0, run: () => null, stats: () => ({ size: 0, jobs: 0, busyMs: 0 }), close: () => Promise.resolve() };
  return simPool;
}

export class MatchClientCombat {
  /** Stop every client-combat timer and the headless pacer (phase end, finish, dispose). */
  _stopClientCombat() {
    if (this._progressTimer) { this.cancel(this._progressTimer); this._progressTimer = null; }
    if (this._bossClock) { this.cancel(this._bossClock); this._bossClock = null; }
    this._bossClockOn = false;
    // a pending throttled boss refresh: the merged team LP is written back now (m.result / settlement read it)
    if (this._bossPubTimer) { this.cancel(this._bossPubTimer); this._bossPubTimer = null; this._syncTeamLp(); this.markPublic(); }
    this._clearPause();
    if (this._poolTimer) { this.cancel(this._poolTimer); this._poolTimer = null; }
    if (this.pacer) { try { this.pacer.stop(); } catch { /* ignore */ } this.pacer = null; }
    for (const f of this.fields) this._clearFieldTimers(f);
  }

  _clearFieldTimers(f) {
    if (!f || !f.cc) return;
    for (const k of ['deadlineTimer', 'doneTimer', 'waitTimer', 'sliceTimer']) if (f[k]) { this.cancel(f[k]); f[k] = null; }
    f.sliceStep = null; // the slice chain of a server-run field is dead with its job
    f.job = null;
  }

  /**
   * Battles the server itself is stepping for this match: a FieldRunner steps every live field in lockstep, a
   * HeadlessPacer fast-forwards one more while a takeover catches up to the wall clock, and — under client-side
   * combat (DESIGN §14) — every field the server took over is a `HeadlessJob` on this thread (`_runOnServer`) or a
   * worker-pool job (P2). `/healthz` sums this over all matches — it is the server's simulation load (DESIGN §26),
   * the input to the multi-core work. A frozen match's runner (and, with it, this number) reports 0: nothing steps.
   */
  hostedFields() {
    let n = this.runner ? this.runner.hosted : 0;
    if (this.pacer && !this.pacer.stopped) n += 1;
    const st = this.hostedFieldStats();
    return n + st.inThread + st.pooled;
  }

  /**
   * `hostedFields()` split by where the server steps each battle: `inThread` are the `HeadlessJob`s the event loop
   * itself advances (a field with no connected human — every bot seat, every mid-disconnect takeover — under
   * client-side combat), `pooled` their worker-pool twins (P2, `SP_SIM_WORKERS`; off by default). The runner / pacer
   * battles are the pool's remainder (`hostedFields() - inThread - pooled`). `f.job` is the signal — the job is held
   * on the field (`f.poolJob` marks the worker one) — and a paused match's parked jobs are still counted: `/healthz`
   * `paused` says how many matches are frozen by the owner's solo pause, and a parked job takes no steps.
   * @returns {{ inThread: number, pooled: number }}
   */
  hostedFieldStats() {
    let inThread = 0;
    let pooled = 0;
    for (const f of this.fields) {
      if (!f.cc || f.done || !f.job) continue;
      if (f.poolJob) pooled++;
      else inThread++;
    }
    return { inThread, pooled };
  }

  /** A client-combat field record: the JSON BattleSpec of its Battle options plus the authority / result state. */
  _ccField({ fieldId, kind, players, opts, boss = null }) {
    const seq = `${this.battlePrefix}.${this.round}.${++this._battleSeq}`;
    // protocol ids are ≤ 64 chars (shared/protocol.js isId): the field id is informational, the sequence is unique
    const battleId = seq.length + 1 + String(fieldId).length <= 64 ? `${seq}.${fieldId}` : seq;
    const spec = buildBattleSpec({ ...opts, battleId, fieldId, kind, content: this.battleContent, boss });
    let total = 0;
    for (const x of spec.spawns) if (x && x.tag !== 'boss' && x.tag !== 'part') total += Math.max(1, Math.floor(Number(x.count) || 1));
    return {
      cc: true, fieldId, kind, players: players.slice(), battleId, spec, battle: null, battleErrors: null, live: true, done: false,
      mode: null, authority: null, startAt: this.sched.now(), result: null, resultSource: null, timeline: null, endGt: null,
      progress: { gt: 0, killed: 0, total, leaks: 0, done: false }, lastProgressAt: this.sched.now(),
      bossAcked: 0, bossBy: {}, lpAcked: 0, lpCum: 0, deadlineTimer: null, doneTimer: null, waitTimer: null,
      // the in-thread headless job of a server-run field and the pause/resume bookkeeping of its slice chain:
      // `job` is the live job, `sliceStep` its next-slice closure, `rearmSlice` that `_freeze` stopped it mid-chain
      job: null, sliceTimer: null, sliceStep: null, rearmSlice: false,
      // boss fields: the latest client reports (re-credited as the plausibility budget grows), the server run's
      // CreditPool, humans demoted for an implausible result (never the authority of this field again), a 'cleared'
      // b.result waiting for the budget to credit the pool it emptied (`heldResult`, _onResult)
      bossReported: null, lpReported: 0, credit: null, demoted: new Set(), heldResult: null,
    };
  }

  /** A battle built from a spec on the server (headless / takeover / verification); never throws. */
  _specBattle(spec, { sharedBoss = null } = {}) {
    try {
      return createBattleFromSpec(spec, this.ds, { BattleClass: this.BattleClass, sharedBoss, logger: this.log, recordEvents: false });
    } catch (e) {
      this.reportError(`battle ${spec && spec.fieldId} construct`, e);
      return new DeadBattle({ fieldId: spec && spec.fieldId, kind: spec && spec.kind, players: (spec && spec.players) || [], rect: spec && spec.rect, stageId: spec && spec.stageId }, 'forced');
    }
  }

  /** Game seconds a field has run (its clock; a finished field: its final time). */
  _fieldElapsed(f) {
    if (f.done && f.result && Number.isFinite(f.result.time)) return f.result.time;
    const gt = Math.max(0, ((this._clockNow() - f.startAt) / 1000) * this.gameSpeed);
    if (f.endGt != null) return Math.min(gt, f.endGt);
    const lim = f.spec && f.spec.timeLimit > 0 ? f.spec.timeLimit : HARD_CAP_SECONDS;
    return Math.min(gt, lim);
  }

  /** The connected human who simulates a field: lowest seat among its players (normal: the owner). */
  _authorityFor(f, exclude = null) {
    let best = null;
    for (const pid of f.players) {
      if (pid === exclude || (f.demoted && f.demoted.has(pid))) continue;
      const ps = this.players.get(pid);
      if (!ps || ps.isBot || ps.left || !ps.connected) continue;
      if (!best || ps.seat < best.seat) best = ps;
    }
    return best ? best.playerId : null;
  }

  /** b.start of a field for one recipient (`watch`: not a player of the field). */
  _startMsg(f, pid, { watch = false } = {}) {
    return {
      t: 'b.start', battleId: f.battleId, fieldId: f.fieldId, kind: f.kind,
      spec: this.spectators.has(pid) ? this._spectatorSpec(f) : f.spec,
      authoritative: !!(!f.done && f.mode === 'client' && f.authority === pid && !watch),
      startAt: f.startAt, serverNow: this.sched.now(), elapsed: Math.round(this._fieldElapsed(f) * 1000) / 1000,
      speed: this.gameSpeed, watch: !!watch, done: !!f.done,
    };
  }

  _sendStart(pid, f, opts = {}) {
    const ps = this.players.get(pid) || this.spectators.get(pid);
    if (!ps || ps.isBot || ps.left || !ps.connected) return false;
    return this.sendTo(pid, this._startMsg(f, pid, opts));
  }

  /** Give every field its authority (a connected human) or run it on the server. */
  _launch(fields) {
    const now = this.sched.now();
    this.fields = fields;
    for (const f of fields) { f.startAt = now; f.lastProgressAt = now; }
    for (const f of fields) {
      const auth = this._authorityFor(f);
      if (auth) this._assignClient(f, auth);
      else this._runOnServer(f, 'no-human');
    }
  }

  _assignClient(f, pid) {
    f.mode = 'client';
    f.authority = pid;
    f.lastProgressAt = this.sched.now();
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    if (f.kind === 'boss' || f.kind === 'hidden') return; // the pool / team LP / silence watchdog end those
    if (this.paused) { f.rearmDeadline = true; return; }
    this._armDeadline(f);
  }

  /** A client field's result deadline: its time limit on the field clock + RESULT_GRACE_MS (then the server takes over). */
  _armDeadline(f) {
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    const lim = f.spec.timeLimit > 0 ? f.spec.timeLimit : 60;
    const at = f.startAt + Math.round((lim / this.gameSpeed) * 1000) + RESULT_GRACE_MS;
    f.deadlineTimer = this.later(Math.max(0, at - this.sched.now()), () => {
      f.deadlineTimer = null;
      if (f.done || f.mode !== 'client') return;
      this._runOnServer(f, 'timeout');
    });
  }

  /** A server-run normal / 联防 field's result is released at the battle's natural end on the field clock. */
  _armRelease(f) {
    if (f.doneTimer) { this.cancel(f.doneTimer); f.doneTimer = null; }
    if (f.done || f.result == null) return;
    if (this.paused) { f.rearmRelease = true; return; }
    const doneAt = f.startAt + Math.round(((f.endGt || 0) / this.gameSpeed) * 1000);
    const wait = this.sched.instant ? 0 : Math.max(0, doneAt - this.sched.now());
    f.doneTimer = this.later(wait, () => { f.doneTimer = null; this._fieldDone(f); });
  }

  /**
   * The server simulates a field: normal / 联防 headlessly at once (the result is released at the battle's natural end
   * on the field's clock, so the teammates' progress UI and the round pacing stay as if it ran live); boss fields in
   * real time on the pacer (they share the pool), fast-forwarded to the field's clock on a takeover.
   */
  _runOnServer(f, reason) {
    const prev = f.mode === 'client' ? f.authority : null;
    if (prev) {
      this.verifyStats.takeovers++;
      this.log.info?.(`[match ${this.roomCode}] ${f.fieldId} R${this.round}: server takeover from ${prev} (${reason})`);
    }
    f.mode = 'server';
    f.authority = null;
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    // the former authority (still online after a timeout / an invalid result) stops reporting and keeps its view
    if (prev) this.sendTo(prev, { t: 'b.end', battleId: f.battleId, fieldId: f.fieldId, reason: 'takeover' });
    if (f.kind === 'boss' || f.kind === 'hidden') { this._bossServerRun(f); return; }
    // P2 (SP_SIM_WORKERS > 0, off by default): a field nobody is watching may be simulated in a worker instead of on
    // the event loop. Only a real-scheduler match with the stock Battle is eligible — virtual time (tests, tools) and
    // an injected BattleClass always stay in-thread — and boss/hidden fields returned above because they share the
    // boss pool object with the main thread, which cannot cross a worker boundary. A FROZEN match never takes a worker:
    // the in-thread chain parks itself (`if (this.paused) f.rearmSlice = true` below) and `_unfreeze` owes it the
    // first slice, so handing the pool a job it would immediately pause only wastes a worker's data load. A field the
    // pool already lost once (`f.noPool`, see `_runFieldInPool`) never goes back: the retry stays on this thread.
    if (f.cc && !f.noPool && !this.paused && !this.sched.virtual && Number.isFinite(this.headlessSliceMs) && this.BattleClass === Battle) {
      const pool = sharedSimPool();
      if (pool.enabled && this._runFieldInPool(f, pool)) { this._armProgressTicker(); return; }
    }
    const job = new HeadlessJob(this._specBattle(f.spec), { onError: (e) => this.reportError(`field ${f.fieldId} step`, e), players: f.players });
    f.job = job;
    f.battle = job.battle;
    f.timeline = job.timeline; // grows while the job runs (the teammates' progress UI reads it on the field clock)
    if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; }
    f.sliceStep = null; // a previous slice chain of this field died with its job
    const complete = () => {
      if (f.job !== job || f.done) return;
      f.job = null;
      f.sliceStep = null;
      const run = job.output();
      f.battle = run.battle;
      f.result = run.result;
      f.resultSource = 'server';
      f.timeline = run.timeline;
      f.endGt = Number(run.battle.time) || 0;
      // P2: the finished battle graph is released now, not at the phase end (see _releaseFieldBattle)
      this._releaseFieldBattle(f, run);
      this._armRelease(f);
    };
    if (!Number.isFinite(this.headlessSliceMs)) {
      job.run(Infinity);
      complete();
    } else {
      // a real host: wall-clock-bounded slices in callbacks of their own (3 bot fields at combat start would otherwise
      // block the event loop for ~0.2–0.5 s here, seconds on a low-power mini PC)
      const slice = () => {
        f.sliceTimer = null;
        if (f.job !== job || f.done) return;
        // a frozen match (the owner's solo pause, an idle suspension) must not keep simulating its bot / takeover
        // battles: park the chain and let the resume hand it its next slice (server/match/match/state.js `_unfreeze`
        // reads `f.rearmSlice` / `f.sliceStep`). The sim is tick-based, so a resumed field carries on from where it was.
        if (this.paused) { f.rearmSlice = true; return; }
        if (job.run(this.headlessSliceMs)) complete();
        else f.sliceTimer = this.later(0, slice);
      };
      f.sliceStep = slice;
      if (this.paused) { f.rearmSlice = true; f.sliceTimer = null; }
      else f.sliceTimer = this.later(0, slice);
    }
    this._armProgressTicker();
  }

  /**
   * Release a server-run field's finished battle graph (P2). Called from `complete()` the moment the field's
   * `HeadlessJob` is done — the job was the only thing stepping it, and everything the match still reads travels
   * beside it: `f.result` (settlement / LP / lastResults), `f.timeline` (the teammates' progress UI on the field
   * clock), `f.endGt` (what `_armRelease` waits for) and `f.battleErrors` (the engine-error records
   * `_collectSimErrors` folds into `m.simErrorLog`). Keeping the whole graph until the phase end — `f.result` is
   * released at the battle's natural end on the field clock, up to a whole battle's length later — cost one bot seat
   * ~100 KB at R1 and ~200-400 KB at R7/R13 per match (`.p2tmp/mem2`, marginal-slope method). A field handed to the
   * worker pool (`_runFieldInPool`) already leaves `f.battle` null for its whole life, so every reader tolerates this.
   *
   * Overridable (a test keeps the graph to compare the two paths); it changes no recorded value.
   */
  _releaseFieldBattle(f, run) {
    f.battleErrors = Array.isArray(run.battle && run.battle.errors) ? run.battle.errors : null;
    f.battle = null;
  }

  /**
   * Simulate a server-run field in a worker (P2) instead of on the event loop. The worker advances only while it is
   * being granted slices, so `_freeze`/`_unfreeze` stop and resume it exactly like the in-thread job and a frozen
   * match costs no CPU there either; the main thread keeps every socket, the field clocks and the release timing, and
   * the worker's progress samples are pushed into the same growing `f.timeline` array the progress UI reads.
   *
   * Returns false when the pool refused the job (all workers gone), so the caller falls back in-thread.
   */
  _runFieldInPool(f, pool) {
    const timeline = [];
    f.timeline = timeline;
    let job = null;
    // The ownership token is this stable wrapper, created BEFORE `pool.run()` and compared by identity in the guards
    // below. It used to be built *after* the call, from the handle `run()` returned, while the guards compared
    // `f.poolJob` (the wrapper) against that handle — two different objects, so `f.poolJob !== job` was always true,
    // `onDone` always returned early and a pooled field never took its result: the worker finished the battle, the
    // phase went on waiting for that field and every countdown sat at 0 (owner report 2026-10-06
    // 「只要有人退了，整个游戏就无法推进（时间到0无法继续下一回合）」). A departure is what puts a field here:
    // `_authorityLost` hands the leaver's field to `_runOnServer`, which prefers the pool in production.
    const handle = {
      pause: () => job?.pause(),
      // A pause hands the worker back (simPool `pause()`), so a resume re-`start`s the job from its spec and its
      // progress frames begin at t = 0 again: drop the samples already reported, or the field's timeline rewinds for
      // the UI. The result is unaffected — the sim is a pure function of the spec, so it is the same run as before.
      resume: () => { timeline.length = 0; job?.resume(); },
      cancel: () => job?.cancel(),
    };
    const onDone = (run) => {
      if (f.poolJob !== handle || f.done) return;
      f.poolJob = null;
      f.job = null;
      f.battle = null; // the battle lived in the worker; nothing on this thread has to be released
      f.result = run.result;
      f.resultSource = 'server';
      f.timeline = Array.isArray(run.timeline) && run.timeline.length ? run.timeline : timeline;
      // the battle's own end clock: the worker reports it, and the last progress sample is the same number
      f.endGt = Number(run.time) || Number(f.timeline[f.timeline.length - 1]?.gt) || 0;
      this._armRelease(f);
    };
    // simPool's contract: `onError` is delivered once and is NEVER followed by `onDone` (a job error, a dead worker, a
    // degraded pool). Reporting it and stopping there left the field with no result and nothing armed — the takeover
    // above already cancelled the field's own deadline — so the phase waited on it forever. Run it on this thread
    // instead, exactly like a pool that refused the job at hand-over; `noPool` keeps `_runOnServer` from handing the
    // same spec straight back to the pool that just lost it.
    const onError = (e) => {
      this.reportError(`field ${f.fieldId} worker`, e);
      if (f.poolJob !== handle || f.done) return;
      f.poolJob = null;
      f.job = null;
      f.noPool = true;
      // A callback that throws here would propagate into the pool's message handler, so the fallback is guarded — and
      // it must not be able to strand the field either: whatever happens, this field ends up with a result and
      // `_fieldDone`, because the phase above is waiting on exactly that and has no timer of its own any more.
      // `running` (a job was created) is the difference between "the fallback will report" — on a real host its slices
      // are still pending, so `f.result` is legitimately null here — and "the fallback never started".
      let running = false;
      try {
        this._runOnServer(f, 'worker-lost');
        running = !!f.job;
      } catch (err) {
        this.reportError(`field ${f.fieldId} worker fallback`, err);
      }
      if (!running && !f.done && f.result == null) {
        f.result = syntheticResult(f.players);
        f.resultSource = 'server';
        this._fieldDone(f);
      }
    };
    f.poolJob = handle;
    job = pool.run(f.spec, {
      players: f.players,
      onProgress: (s) => { if (Array.isArray(s?.timeline) && s.timeline.length) timeline.push(...s.timeline); },
      onDone,
      onError,
    });
    if (!job) { f.poolJob = null; return false; }
    f.job = job; // the guards elsewhere compare f.job identity; a pool job settles once, like a HeadlessJob
    f.battle = null;
    if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; }
    if (this.paused) job.pause(); // the match may already be frozen when the field is handed over
    return true;
  }

  /** m.public ~1 Hz while server-run fields progress along their timelines. */
  _armProgressTicker() {
    if (this._progressTimer || this.sched.instant) return;
    // a frozen match (the owner's solo pause, an idle suspension) wakes up for nothing: the chain parks on `paused` and
    // `_unfreeze` hands it its next tick exactly once (server/match/match/state.js)
    if (this.paused) { this._progressWanted = true; return; }
    const tick = () => {
      this._progressTimer = null;
      if (this.paused) { this._progressWanted = true; return; }
      if (!this.fields.some((f) => f.cc && f.mode === 'server' && !f.done && f.timeline)) return;
      this.markPublic();
      this._progressTimer = this.later(1000, tick);
    };
    this._progressTimer = this.later(1000, tick);
  }

  /** A field has its final result. */
  _fieldDone(f) {
    if (!f || f.done) return;
    f.done = true;
    f.live = false;
    this._clearFieldTimers(f);
    if (!f.result) f.result = syntheticResult(f.players, { bossBy: f.bossBy });
    f.progress.done = true;
    this.markPublic();
    this._maybeFieldsDone();
  }

  _maybeFieldsDone() {
    if (!this.fields.length || this.fields.some((f) => f.cc && !f.done)) return;
    if (!this.fields.every((f) => f.cc)) return;
    if (this.phase === PHASE.COMBAT) this._finishCombat((f) => f.result);
    else if (this.phase === PHASE.UNITE) this._finishUniteClient();
    else if (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) this._finishFinal(this.phase === PHASE.HIDDEN_CORE, (f) => f.result);
  }

  /** An authoritative human disconnected / left: normal & 联防 fields → server takeover; boss → the partner or the server. */
  _authorityLost(ps, why) {
    for (const f of this.fields) {
      if (!f.cc || f.done || f.mode !== 'client' || f.authority !== ps.playerId) continue;
      if (f.kind === 'boss' || f.kind === 'hidden') this._bossHandover(f, why);
      else this._runOnServer(f, why);
    }
  }
}
