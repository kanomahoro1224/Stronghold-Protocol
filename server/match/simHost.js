// server/match/simHost.js — worker entry of the simulation pool (DESIGN §23).
//
// A field nobody watches is simulated by the server in wall-clock slices on the MAIN thread today (fields.js
// HeadlessJob), on the same core that answers players and moves JSON; at ~700 concurrent matches that is what
// saturates the box. This worker runs one such job on another core instead. The main thread (simPool.js) owns the
// clock and grants one slice at a time, so a frozen match is simply a match whose slices are not granted: the worker
// has no timer of its own and never self-advances — it is idle, not spinning, between `slice` messages.
//
// Protocol. main → worker:
//   { t: 'start',  jobId, spec, players }  build the battle from the spec (mirrors Match._specBattle)
//   { t: 'slice',  jobId, budgetMs }       step it until it ends or the budget is used (HeadlessJob.run discipline)
//   { t: 'cancel', jobId }                 forget the job; no reply
// worker → main:
//   { t: 'progress', jobId, timeline?, gt, killed, total }   timeline: only the samples new since the last frame
//   { t: 'done',     jobId, result, digest, timeline, crashed, time }
//   { t: 'error',    jobId, message, stack }
// `timeline` is a DELTA on progress frames and the WHOLE array on `done`: the main thread appends progress samples to
// the field's growing timeline and takes the finished one from `done`. `time` is the battle's end clock, the same
// number Match puts in `f.endGt` when it steps a field in-thread.
//
// The result is a pure function of the spec: the battle is built from the spec's own JSON with the same
// createBattleFromSpec / HeadlessJob the main thread uses, and the sim itself reads no wall clock and no RNG. The
// slice budget is the only time this file ever consults, and it decides WHEN to hand the core back, never WHAT is
// simulated: the job is resumed on the next `slice` and runs to its end, so the digest cannot depend on where the
// slices fell. A battle that blows up mid-step is absorbed exactly as today's HeadlessJob absorbs it (force-end, then
// a DeadBattle stand-in) and the job still reports `done` with `crashed: true` — only a failure of the scaffolding
// itself (module load, battle construction, digest) is reported as `error`.
//
// It lives under server/match/ on purpose: server/sim/** is served to browsers and must stay free of `node:` imports.
import { parentPort } from 'node:worker_threads';

/** Log sink of the battles built here: a worker has no match log, and logging never affects the result. */
const QUIET = Object.freeze({ info() {}, debug() {}, warn() {}, error() {} });

/** @type {Map<number, { job: import('./fields.js').HeadlessJob, spec: any, sent: number }>} */
const jobs = new Map();
/** Requests are handled in arrival order: a `slice` must never overtake the `start` it belongs to. */
let chain = Promise.resolve();

/** The sim modules and the process-wide DataSource: built once per worker and kept for its lifetime. */
let loaded = null;
function sim() {
  if (!loaded) {
    loaded = (async () => {
      const [fields, spec, simdata] = await Promise.all([
        import('./fields.js'),
        import('../sim/spec.js'),
        // Node's default source lazily loads the multi-MB data/*.json (server/sim/nodeData.js): one load per worker,
        // shared by every job it ever runs — the reason the first job of a worker warms up and the rest do not.
        import('../sim/simdata.js'),
      ]);
      return { fields, spec, ds: simdata.getDefaultSource() };
    })();
  }
  return loaded;
}

const errorFrame = (jobId, e) => ({
  t: 'error', jobId,
  message: String((e && e.message) || e),
  stack: String((e && e.stack) || ''),
});

function send(frame) {
  try { parentPort.postMessage(frame); } catch { /* the main thread is gone: nothing left to report to */ }
}

async function onStart(msg) {
  const m = await sim();
  const spec = msg.spec && typeof msg.spec === 'object' ? msg.spec : {};
  let battle;
  try {
    battle = m.spec.createBattleFromSpec(spec, m.ds, { logger: QUIET, recordEvents: false });
  } catch (e) {
    // Match._specBattle's own construction failure path: a battle that cannot be built becomes a finished DeadBattle,
    // so the job still ends with the synthetic result instead of taking the worker down with it.
    battle = new m.fields.DeadBattle({
      fieldId: spec.fieldId ?? null, kind: spec.kind ?? 'normal', players: spec.players || [],
      rect: spec.rect ?? null, stageId: spec.stageId ?? null,
    }, 'forced');
  }
  const job = new m.fields.HeadlessJob(battle, { players: Array.isArray(msg.players) ? msg.players : [] });
  jobs.set(msg.jobId, { job, spec: m.spec, sent: 0 });
}

function onSlice(msg) {
  const rec = jobs.get(msg.jobId);
  if (!rec) return; // cancelled or already finished: a late `slice` is a no-op (the main thread stops granting them)
  const budgetMs = Number.isFinite(msg.budgetMs) ? msg.budgetMs : Infinity;
  let finished;
  try {
    finished = rec.job.run(budgetMs);
  } catch (e) {
    jobs.delete(msg.jobId);
    send(errorFrame(msg.jobId, e));
    return;
  }
  if (!finished) {
    const b = rec.job.battle;
    const frame = { t: 'progress', jobId: msg.jobId, gt: Number(b.time) || 0, killed: Number(b.killed) || 0, total: Number(b.total) || 0 };
    // Only the samples the main thread has not seen yet: it appends them to the field's growing timeline, so sending
    // the whole array again would duplicate every earlier sample in the progress the teammates read.
    if (rec.job.timeline.length !== rec.sent) {
      frame.timeline = rec.job.timeline.slice(rec.sent);
      rec.sent = rec.job.timeline.length;
    }
    send(frame);
    return;
  }
  const out = rec.job.output();
  let digest;
  try {
    digest = rec.spec.resultDigest(out.result).hash;
  } catch (e) {
    jobs.delete(msg.jobId);
    send(errorFrame(msg.jobId, e));
    return;
  }
  jobs.delete(msg.jobId);
  // `time` = what Match reads as `f.endGt` for an in-thread field (`Number(run.battle.time) || 0`); the battle object
  // itself cannot cross the worker boundary, so its end clock travels next to the result.
  send({
    t: 'done', jobId: msg.jobId, result: out.result, digest, timeline: out.timeline, crashed: !!out.crashed,
    time: Number(out.battle && out.battle.time) || 0,
  });
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'start': return onStart(msg);
    case 'slice': return onSlice(msg);
    case 'cancel': jobs.delete(msg.jobId); return;
    default: return;
  }
}

// Registered before any heavy module is loaded (everything above is dynamically imported): a `start` posted while the
// worker is still reading data/*.json is queued by the port and handled as soon as this listener exists.
if (parentPort) {
  parentPort.on('message', (msg) => {
    chain = chain.then(async () => {
      try {
        await handle(msg);
      } catch (e) {
        // A scaffolding failure (module load, digest) belongs to the job, not to the worker: report it, keep serving.
        jobs.delete(msg && msg.jobId);
        if (msg && msg.jobId != null) send(errorFrame(msg.jobId, e));
      }
    });
  });
}
