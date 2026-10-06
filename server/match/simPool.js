// server/match/simPool.js — main-thread pool of simulation workers (DESIGN §23), OFF by default.
//
// At peak this box runs ~700 concurrent matches on 2 vCPU: a field nobody watches is simulated by the server on the
// MAIN thread (fields.js HeadlessJob, in wall-clock slices), on the same core that answers players and moves JSON.
// The pool moves that work into worker_threads, where it cannot starve the event loop. Only a field that is *not*
// driven by a human may be handed here, and only with the stock sim (see "Caller contract" below).
//
// The switch is `SP_SIM_WORKERS`: unset / `0` / unparseable means the pool is never created, nothing is spawned and
// every field runs exactly as it does today — that is the default and the rollback. The value is read once by the
// caller (as Match reads SP_IDLE_PAUSE_MS / SP_BOT_REHEARSAL) and parsed by parseSimWorkers below; no other module
// reads it. Enable with `SP_SIM_WORKERS=N`, N clamped to one less than the cores available so the main thread keeps a
// core of its own.
//
// Caller contract (enforced by the caller, not here — this module runs whatever spec it is handed):
//   * never a boss / hidden spec: those share the match's live pool object, which cannot cross a worker boundary;
//   * never a Match built with a custom BattleClass (tests inject a FakeBattle): the worker always builds the real one;
//   * `run()` returns null when the pool cannot take the job (disabled, degraded, no live worker) — the caller keeps
//     its in-thread HeadlessJob path for exactly that case.
//
// The worker advances only when it is granted a slice, so `pause()` is "stop granting" — but it ALSO hands the worker
// back to the queue: a paused job that kept its slot blocked every field behind it (with the production `SP_SIM_WORKERS=1`
// that is the whole pool), which is how a live match's 联防 field hung at a 0 countdown on 2026-10-05. `resume()`
// re-queues the job in front, which re-`start`s it from its spec — a pure function of the spec, so the result and the
// digest are the ones the unpaused run would have produced. The main thread owns the clock throughout.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { HEADLESS_SLICE_MS } from './fields.js';

/**
 * Wall-clock work granted to a worker per slice. The same 8 ms as the in-thread slice (fields.js HEADLESS_SLICE_MS)
 * on purpose: a pooled field holds a core for no longer than today's main-thread slice held the event loop, so a
 * low-power host stays as responsive as it is now. Overridable per pool and per job.
 */
export const DEFAULT_SLICE_MS = Number.isFinite(HEADLESS_SLICE_MS) && HEADLESS_SLICE_MS > 0 ? HEADLESS_SLICE_MS : 8;

/** Worker deaths tolerated in a row (each is replaced) before the pool is declared degraded. */
const RESPAWN_LIMIT = 3;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * A worker with no job must not hold the process open, and one that owns a job must: a pool is created once and shared
 * (Match builds it lazily and has no owner that ever closes it), so a permanently ref'd worker would keep a test
 * runner, a tool or a script alive after its work is done, while an unref'd one could let a running field's process
 * exit before the field finished. Ref/unref per job gives both: idle = free, busy = pinned.
 */
const unrefIdle = (worker) => { try { worker.unref?.(); } catch { /* the worker is already gone */ } };
const refBusy = (worker) => { try { worker.ref?.(); } catch { /* the worker is already gone */ } };

/** A worker entry as a file URL: URL and path forms are both accepted (a test injects its own worker). */
function workerUrl(workerFile) {
  if (workerFile instanceof URL) return workerFile;
  const s = workerFile == null ? '' : String(workerFile);
  if (!s) return new URL('./simHost.js', import.meta.url);
  if (path.isAbsolute(s)) return pathToFileURL(s);
  try {
    const u = new URL(s);
    if (u.protocol === 'file:' || u.protocol === 'node:' || u.protocol === 'data:') return u;
  } catch { /* a relative path, not a URL */ }
  return new URL(s, import.meta.url);
}

/** `SP_SIM_WORKERS` → worker count. See the header: 0 is the default, the disabled value and the rollback. */
export function parseSimWorkers(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return 0;
  if (n === 0) return 0;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus() || []).length;
  return Math.max(1, Math.min(n, cores - 1)); // the main thread keeps a core: never spawn on all of them
}

/**
 * @param {{ size?: number, log?: object, workerFile?: URL|string, sliceMs?: number }} [opts]
 *   size: workers to spawn (0 = disabled, the default). workerFile: the worker entry (tests inject one).
 *   sliceMs: the default slice budget handed to each worker (override per job with run(spec, { sliceMs })).
 * @returns {{ enabled: boolean, size: number, run: Function, stats: Function, close: Function }}
 */
export function createSimPool({ size = 0, log = console, workerFile = null, sliceMs = DEFAULT_SLICE_MS } = {}) {
  const file = workerUrl(workerFile);
  const target = Number.isInteger(size) && size > 0 ? size : 0;
  const defaultSliceMs = Number.isFinite(sliceMs) && sliceMs > 0 ? sliceMs : DEFAULT_SLICE_MS;

  /** @type {Array<{ worker: Worker, job: object|null, alive: boolean }>} */
  const slots = [];
  /** @type {object[]} FIFO of jobs waiting for a free worker */
  const queue = [];
  /** @type {Map<number, object>} every job that has not settled yet (a worker death settles its own) */
  const live = new Map();
  let nextJobId = 1;
  let jobs = 0;
  let busyMs = 0;
  let deaths = 0;
  let degraded = false;
  let closing = false;
  let closed = null;

  function settleError(job, err) {
    if (!job || job.settled) return; // exactly once, and never an onDone after it
    job.settled = true;
    live.delete(job.id);
    clearTimer(job);
    try { job.onError?.(err); } catch (e) { log.warn?.('[sim] onError threw', e); }
  }

  const failQueue = (err) => {
    for (const job of queue.splice(0, queue.length)) settleError(job, err);
  };

  const spawn = () => {
    const worker = new Worker(file, { name: `sp-sim-${slots.length + 1}` });
    const slot = { worker, job: null, alive: true };
    worker.on('message', (msg) => onMessage(slot, msg));
    worker.on('error', (err) => onLost(slot, err));
    worker.on('exit', (code) => onLost(slot, new Error(`sim worker exited (code ${code})`)));
    // An IDLE worker must not hold the process open: a pool that is created once and shared (the one Match builds
    // lazily) has no owner that ever closes it, and a forgotten ref would keep a test runner or a tool alive forever.
    // One that owns a job is ref'd again in assign(), so a running field can never be abandoned mid-flight.
    unrefIdle(worker);
    slots.push(slot);
    return slot;
  };

  /**
   * Give a job's worker back without settling it (pause / cancel). The worker is told to forget the job — messages are
   * ordered per worker, so the `start` of whatever takes the slot next is built after that cancel — and the slot is
   * freed for the queue at once. `resume()` re-queues the job, which re-`start`s it from its spec; the sim is a pure
   * function of the spec (simHost header: no wall clock, no RNG), so the result and the digest come back exactly as if
   * the job had never been parked.
   */
  const detach = (job) => {
    const slot = job.slot;
    if (!slot) return false;
    try { slot.worker.postMessage({ t: 'cancel', jobId: job.id }); } catch { /* the worker is gone */ }
    if (slot.job === job) { slot.job = null; unrefIdle(slot.worker); }
    job.slot = null;
    return true;
  };

  const assign = () => {
    // One bounded pass over the jobs queued right now. A paused job is NEVER handed a worker: with `SP_SIM_WORKERS=1`
    // (the 2-vCPU production box) a frozen match's job used to keep the only slot, so every field queued behind it —
    // the 联防 field a live match handed over, 2026-10-05 — waited for a match nobody was connected to. It stays
    // queued (or is re-queued by `resume()`), and `release()` calls this again when a slot frees.
    for (let n = queue.length; n > 0; n--) {
      const slot = slots.find((s) => s.alive && !s.job);
      if (!slot) return;
      const job = queue.shift();
      if (job.settled || job.cancelled) continue;
      if (job.paused) { queue.push(job); continue; }
      slot.job = job;
      job.slot = slot;
      refBusy(slot.worker);
      // `start` builds the battle once (and pays the worker's one-time data load); every later slice just steps it.
      slot.worker.postMessage({ t: 'start', jobId: job.id, spec: job.spec, players: job.players });
      grant(job);
    }
  };

  /** Hand the worker one slice. The worker answers with `progress` or `done`, which grants the next one. */
  const grant = (job) => {
    if (job.settled || job.cancelled || job.paused || !job.slot || closing) return;
    job.grantedAt = now();
    try {
      job.slot.worker.postMessage({ t: 'slice', jobId: job.id, budgetMs: job.sliceMs });
    } catch (e) {
      // The worker is gone (an `error`/`exit` is on its way): let that path settle the job, never this one.
      job.grantedAt = null;
      log.warn?.('[sim] could not grant a slice', e);
    }
  };

  const pump = (job) => {
    if (job.settled || job.cancelled || job.paused || !job.slot || closing) return;
    // setImmediate, never setInterval: the next slice follows the worker's own answer (or resume()), so the worker is
    // never handed work it did not ask for. REF'D on purpose — an unref'd immediate scheduled while the rest of the
    // loop is idle (a resumed job on a quiet server) is only run once something else wakes the loop: measured 4 s late
    // in a minimal worker-idle repro and 7.6 s in this pool, which would leave a live field hanging. A pending pump
    // exists only while a job is actually running, and close() clears it, so it cannot keep a finished pool alive.
    job.timer = setImmediate(() => { job.timer = null; grant(job); });
  };

  const clearTimer = (job) => {
    if (job.timer) { clearImmediate(job.timer); job.timer = null; }
  };

  /** Free the worker a settled job held, and hand it to the next queued job (FIFO). */
  const release = (job) => {
    const slot = job.slot;
    job.slot = null;
    if (slot && slot.job === job) {
      slot.job = null;
      unrefIdle(slot.worker); // no job: it must not keep the process up (assign() re-refs it if the queue has work)
      assign();
    }
  };

  const settleDone = (job, frame) => {
    if (job.settled) return;
    job.settled = true;
    live.delete(job.id);
    clearTimer(job);
    const out = { result: frame.result, digest: frame.digest, timeline: frame.timeline, crashed: !!frame.crashed, time: Number(frame.time) || 0 };
    try { job.onDone?.(out); } catch (e) { log.warn?.('[sim] onDone threw', e); }
  };

  const account = (job) => {
    if (job.grantedAt != null) { busyMs += Math.max(0, now() - job.grantedAt); job.grantedAt = null; }
  };

  const onMessage = (slot, msg) => {
    if (!msg || typeof msg !== 'object') return;
    deaths = 0; // the worker is alive and speaking the protocol
    const job = msg.jobId != null ? live.get(msg.jobId) : null;
    if (!job || job.settled) return; // a cancelled or settled job: nothing more is delivered for it
    account(job);
    if (msg.t === 'progress') {
      // A paused job reports nothing: pause() must leave the caller's view exactly where it was, and the next progress
      // after resume() carries the whole timeline anyway, so nothing is lost.
      if (job.paused) return;
      job.onProgress?.(msg);
      pump(job);
      return;
    }
    if (msg.t === 'done') {
      release(job); // free the worker (and its queue) before the caller is told: onDone may start the next job
      settleDone(job, msg);
      return;
    }
    if (msg.t === 'error') {
      const err = new Error(String(msg.message || 'sim worker job failed'));
      if (msg.stack) err.stack = String(msg.stack);
      release(job); // the worker dropped the job itself: it is healthy and free for the next one
      settleError(job, err);
    }
  };

  /** A worker died: everything it owned fails exactly once, then it is replaced (or the pool is declared degraded). */
  const onLost = (slot, err) => {
    if (!slot.alive) return; // 'error' is followed by 'exit': one death, one settlement
    slot.alive = false;
    unrefIdle(slot.worker);
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    const job = slot.job;
    slot.job = null;
    if (job) settleError(job, err);
    if (closing) return;
    deaths++;
    if (deaths > RESPAWN_LIMIT) {
      degraded = true;
      log.error?.(`[sim] pool degraded after ${deaths} worker deaths (${err && err.message}); no sim worker left`);
      failQueue(new Error('sim pool degraded: no live sim worker'));
      return;
    }
    log.warn?.(`[sim] sim worker lost (${err && err.message}); replacing it`);
    try {
      spawn();
    } catch (e) {
      log.warn?.('[sim] respawn failed', e);
      deaths++;
      if (deaths > RESPAWN_LIMIT) { degraded = true; failQueue(new Error('sim pool degraded: respawn failed')); }
      return;
    }
    assign();
  };

  if (target > 0) {
    try {
      for (let i = 0; i < target; i++) spawn();
    } catch (e) {
      log.warn?.('[sim] could not start sim workers; the pool stays disabled', e);
      for (const s of slots) { s.alive = false; s.worker.terminate().catch(() => {}); }
      slots.length = 0;
      degraded = true;
    }
  }

  return {
    /** True only when workers were asked for and at least one is live: the caller's "may I use the pool?" answer. */
    get enabled() { return !degraded && slots.length > 0; },
    /** Workers alive right now (the pool never spawns more than `size`). */
    get size() { return slots.length; },

    /**
     * Take a field's spec and drive it in a worker.
     * @param {object} spec JSON-safe BattleSpec (never a boss / hidden one: see the caller contract above)
     * @param {{ players?: string[], onProgress?: (p: object) => void, onDone?: (o: object) => void,
     *           onError?: (e: Error) => void, sliceMs?: number }} [opts]
     *   onProgress gets the worker's own frame ({ gt, killed, total, timeline? }) where `timeline` holds only the
     *   samples new since the previous frame (the caller appends them to the field's growing timeline); onDone gets
     *   `{ result, digest, timeline, crashed, time }` once — `timeline` whole, `time` the battle's end clock; onError
     *   gets an Error once and is never followed by onDone.
     * @returns {{ pause(): void, resume(): void, cancel(): void }|null} null when the pool cannot take the job
     */
    run(spec, { players = [], onProgress = null, onDone = null, onError = null, sliceMs: jobSliceMs = defaultSliceMs } = {}) {
      if (closing || degraded || slots.length === 0) return null;
      const budget = Number.isFinite(jobSliceMs) && jobSliceMs > 0 ? jobSliceMs : defaultSliceMs;
      const job = {
        id: nextJobId++, spec, players: Array.isArray(players) ? players : [],
        onProgress, onDone, onError, sliceMs: budget,
        slot: null, timer: null, grantedAt: null, paused: false, cancelled: false, settled: false,
      };
      live.set(job.id, job);
      queue.push(job);
      jobs++;
      assign();
      return {
        /**
         * Stop granting slices AND give the worker back: a paused job must never hold a slot, or a frozen match (idle
         * suspension, ~125 of them in a 3-hour production window) blocks every field queued behind it — including the
         * 联防 field of a live match, whose phase then never ends and whose countdown sits at 0.
         */
        pause() {
          if (job.settled || job.cancelled || job.paused) return;
          job.paused = true;
          if (detach(job)) assign();
        },
        resume() {
          if (job.settled || job.cancelled || !job.paused) return;
          job.paused = false;
          if (job.slot) { pump(job); return; }
          // no slot: the pause handed it back. In front of the queue — it was already running before the freeze.
          if (!queue.includes(job)) queue.unshift(job);
          assign();
        },
        /** Abandon the job: no further callbacks, and the worker is freed for the next queued one. */
        cancel() {
          if (job.settled || job.cancelled) return;
          job.cancelled = true;
          job.settled = true; // nothing is ever delivered for it again
          live.delete(job.id);
          clearTimer(job);
          const qi = queue.indexOf(job);
          if (qi >= 0) queue.splice(qi, 1);
          if (detach(job)) assign();
        },
      };
    },

    /** Observability: live workers, jobs accepted, and the accumulated wall-clock time the workers spent stepping. */
    stats() {
      return { size: slots.length, jobs, busyMs: Math.round(busyMs * 1000) / 1000 };
    },

    /** Terminate every worker. Safe to call twice; resolves once they have all stopped. */
    close() {
      if (!closed) {
        closing = true;
        closed = (async () => {
          // nothing may be left hanging on a pool that is going away
          for (const job of [...live.values()]) settleError(job, new Error('sim pool closed'));
          failQueue(new Error('sim pool closed'));
          const workers = slots.map((s) => s.worker);
          slots.length = 0;
          queue.length = 0;
          live.clear();
          await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
        })();
      }
      return closed;
    },
  };
}
