// test/match/simPool.test.js — the worker_threads simulation pool (server/match/simPool.js + simHost.js).
//
// The acceptance gate is determinism parity: a real field spec stepped through the pool must produce the very digest
// the in-thread HeadlessJob produces (test/match/clientCombat-review.test.js compares result digests the same way).
// Around that: the env knob and its OFF default, a disabled pool taking no job, pause() really stopping the worker,
// and a worker that dies mid-job settling its field with onError exactly once while the pool keeps working.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
import { runHeadless, DeadBattle } from '../../server/match/fields.js';
import { parseSimWorkers, createSimPool, DEFAULT_SLICE_MS } from '../../server/match/simPool.js';
import { makeMatch } from './harness.js';

/** The pool logs a replaced worker; that is expected here and would only pollute the TAP output. */
const silent = { info() {}, debug() {}, warn() {}, error() {} };

/** Every callback a pool job can make, so a second delivery (or an onDone after an onError) is visible as a length > 1. */
function sink() {
  const seen = { progress: [], done: [], error: [] };
  let settle;
  const settled = new Promise((r) => { settle = r; });
  return {
    seen, settled,
    opts: {
      onProgress: (p) => seen.progress.push(p),
      onDone: (o) => { seen.done.push(o); settle('done'); },
      onError: (e) => { seen.error.push(e); settle('error'); },
    },
  };
}

/**
 * Real field specs of one real-data match, captured exactly as test/match/clientCombat-review.test.js does it (the
 * b.start of the client-authoritative fields), plus the match's own DataSource for the in-thread comparison.
 */
function fieldSpecs(n = 3) {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 3, bots: 1, seed: 9411, captureFrames: false, clientCombat: true });
  h.autoHumans();
  const specs = [];
  h.onSend.push((pid, msg) => {
    if (specs.length < n && msg.t === 'b.start' && msg.authoritative && (msg.kind === 'normal' || msg.kind === 'unite')) specs.push(msg.spec);
  });
  const ds = h.m.ds;
  h.m.start();
  h.run(() => specs.length >= n || h.ended != null, { maxSteps: 5e6 });
  h.m.dispose();
  return { specs, ds };
}

const ids = (spec) => (spec.players || []).map((p) => p.playerId);

// ---- the env knob and the OFF default --------------------------------------------------------------------------

test('parseSimWorkers: 0 / unset / junk / negative → 0 (the default rollback); N > 0 clamps below the core count', () => {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus() || []).length;
  assert.equal(parseSimWorkers(undefined), 0, 'unset = off');
  assert.equal(parseSimWorkers(null), 0);
  assert.equal(parseSimWorkers(''), 0);
  assert.equal(parseSimWorkers('abc'), 0);
  assert.equal(parseSimWorkers('-1'), 0);
  assert.equal(parseSimWorkers('-100'), 0);
  assert.equal(parseSimWorkers('1.5'), 0, 'not a whole number of workers');
  assert.equal(parseSimWorkers('0'), 0, '0 = disabled, the documented default');
  assert.equal(parseSimWorkers(0), 0);
  assert.equal(parseSimWorkers('1'), 1);
  assert.equal(parseSimWorkers(2), Math.max(1, Math.min(2, cores - 1)));
  const huge = parseSimWorkers('1000000');
  assert.equal(huge, Math.max(1, cores - 1), 'clamped to one less than the cores available');
  if (cores > 1) assert.ok(huge < cores, `the main thread keeps a core (${huge} < ${cores})`);
  assert.equal(DEFAULT_SLICE_MS, 8, 'the same slice budget as the in-thread HeadlessJob slice');
});

test('a disabled pool spawns nothing, takes no job, and close() is safe twice', async () => {
  const pool = createSimPool({ size: 0, log: silent });
  assert.equal(pool.enabled, false);
  assert.equal(pool.size, 0);
  assert.deepEqual(pool.stats(), { size: 0, jobs: 0, busyMs: 0 });
  assert.equal(pool.run({ fieldId: 'n:p_0', kind: 'normal', players: [] }, {}), null, 'the caller keeps its in-thread path');
  await pool.close();
  await pool.close();
  assert.equal(pool.enabled, false);
  assert.deepEqual(pool.stats(), { size: 0, jobs: 0, busyMs: 0 });
});

// ---- determinism parity (the acceptance gate) ------------------------------------------------------------------

test('parity: the same real field specs give the same result digest in the pool as in-thread', async () => {
  const { specs, ds } = fieldSpecs(3);
  assert.ok(specs.length >= 2, `real field specs captured (${specs.length})`);
  const pool = createSimPool({ size: 2, log: silent });
  assert.equal(pool.enabled, true);
  assert.equal(pool.size, 2);
  const digests = [];
  try {
    for (const spec of specs) {
      const players = ids(spec);
      const inThread = runHeadless(createBattleFromSpec(spec, ds, { recordEvents: false, quiet: true }), { players });
      const s = sink();
      const handle = pool.run(spec, { players, ...s.opts });
      assert.ok(handle, 'the pool took the job');
      assert.equal(await s.settled, 'done', `${spec.fieldId} R${spec.round}: settled with done`);
      assert.equal(s.seen.done.length, 1);
      assert.deepEqual(s.seen.error, []);
      const got = s.seen.done[0];
      assert.deepEqual(Object.keys(got).sort(), ['crashed', 'digest', 'result', 'time', 'timeline']);
      assert.equal(got.digest, resultDigest(inThread.result).hash, `${spec.fieldId} R${spec.round}: pool digest = in-thread digest`);
      assert.equal(got.digest, resultDigest(got.result).hash, 'the digest the worker sent describes the result it sent');
      assert.equal(got.crashed, inThread.crashed);
      assert.equal(got.time, Number(inThread.battle.time) || 0, 'the end clock the caller puts in f.endGt travels too');
      assert.deepEqual(got.timeline, inThread.timeline, 'the progress timeline travels whole');
      // ... and the same spec at a different slice budget: where the slices fell must not change what was simulated
      const tiny = sink();
      assert.ok(pool.run(spec, { players, sliceMs: 1, ...tiny.opts }), 'the pool took the same spec at a 1 ms budget');
      assert.equal(await tiny.settled, 'done');
      assert.equal(tiny.seen.done[0].digest, got.digest, 'the slice budget does not change the result');
      assert.deepEqual(tiny.seen.done[0].timeline, got.timeline, 'nor the timeline');
      digests.push(`${spec.fieldId}:${got.digest}`);
    }
  } finally {
    await pool.close();
  }
  assert.equal(digests.length, specs.length);
  assert.ok(pool.stats().busyMs > 0, 'the workers did the stepping (busyMs is the granted work)');
  assert.ok(pool.stats().jobs >= specs.length);
  assert.equal(pool.stats().size, 0, 'everything is torn down');
  // eslint-disable-next-line no-console
  console.log(`# parity digests: ${digests.join(' ')}`);
});

test('queueing: more jobs than workers still all finish, FIFO, with the in-thread digests', async () => {
  const { specs, ds } = fieldSpecs(2);
  assert.ok(specs.length >= 2, `two field specs captured (${specs.length})`);
  const pool = createSimPool({ size: 1, log: silent });
  try {
    const expected = specs.map((spec) => resultDigest(runHeadless(createBattleFromSpec(spec, ds, { recordEvents: false, quiet: true }), { players: ids(spec) }).result).hash);
    const sinks = specs.map(() => sink());
    const handles = specs.map((spec, i) => pool.run(spec, { players: ids(spec), ...sinks[i].opts }));
    assert.ok(handles.every(Boolean));
    for (const [i, s] of sinks.entries()) {
      assert.equal(await s.settled, 'done', `job ${i} finished`);
      assert.equal(s.seen.done[0].digest, expected[i], `job ${i} digest`);
    }
    assert.ok(pool.stats().jobs >= 2);
    assert.equal(pool.stats().size, 1, 'never more workers than asked for');
  } finally {
    await pool.close();
  }
});

// ---- pause / resume / cancel -----------------------------------------------------------------------------------

test('pause() stops the worker (no progress, no CPU) and resume() lets the same job finish', async () => {
  const { specs } = fieldSpecs(1);
  assert.equal(specs.length, 1, 'one real field spec captured');
  const spec = specs[0];
  const pool = createSimPool({ size: 1, log: silent });
  try {
    const seen = { progress: [], done: [], error: [] };
    let settle;
    const settled = new Promise((r) => { settle = r; });
    let pauseReached;
    const reached = new Promise((r) => { pauseReached = () => r('paused'); });
    let handle = null;
    handle = pool.run(spec, {
      players: ids(spec),
      sliceMs: 2, // small slices: the pause has to land in the middle of a field that needs several of them
      onProgress: (p) => {
        seen.progress.push(p);
        if (handle && seen.progress.length === 1) { handle.pause(); pauseReached(); }
      },
      onDone: (o) => { seen.done.push(o); settle('done'); },
      onError: (e) => { seen.error.push(e); settle('error'); },
    });
    assert.ok(handle, 'the pool took the job');
    assert.equal(await Promise.race([reached, settled]), 'paused', 'a whole field never fits in a single 2 ms slice');
    assert.deepEqual(seen.done, [], 'the field is still running');
    const frames = seen.progress.length;
    const busy = pool.stats().busyMs;
    await delay(60);
    assert.equal(seen.progress.length, frames, 'no progress is reported while paused');
    assert.equal(pool.stats().busyMs, busy, 'the worker is idle while paused, not spinning');
    assert.deepEqual(seen.done, [], 'still not finished');
    assert.deepEqual(seen.error, []);
    handle.resume();
    // Bounded on purpose: a pump timer that the idle event loop does not run (an unref'd immediate on a quiet loop,
    // measured at 7.6 s here) leaves the field hanging with no progress at all — that must fail loudly, not slowly.
    assert.equal(await Promise.race([settled, delay(3000).then(() => 'timeout')]), 'done', 'resume() re-feeds the worker promptly');
    assert.ok(seen.progress.length > frames, 'progress flows again after resume()');
    assert.equal(resultDigest(seen.done[0].result).hash, seen.done[0].digest);
    assert.ok(Array.isArray(seen.done[0].timeline) && seen.done[0].timeline.length >= 2, 'the final timeline is whole');
    // The append contract the caller relies on: a progress frame carries only the samples new since the last one, so
    // concatenating them is a prefix of the finished timeline — never a re-send of the samples already reported.
    const deltas = seen.progress.flatMap((p) => (Array.isArray(p.timeline) ? p.timeline : []));
    const whole = seen.done[0].timeline;
    assert.ok(deltas.length > 0, `progress samples were reported (${deltas.length})`);
    // pause() hands the worker back (simPool), so the resumed job re-`start`s from its spec and its frames begin at
    // t = 0 again: `deltas` is not one prefix any more, it is the abandoned run's samples followed by the new run's.
    // The caller drops its accumulated timeline on resume for exactly this reason (Match._runFieldInPool). Both runs
    // are the same pure function of the same spec, so the samples agree — that is what makes the restart safe.
    const restart = deltas.findIndex((s, i) => i > 0 && Number(s[0]) === 0);
    assert.ok(restart > 0, `the resumed run reports from t = 0 again (${JSON.stringify(deltas.slice(0, 3))})`);
    const first = deltas.slice(0, restart);
    const second = deltas.slice(restart);
    assert.deepEqual(second, whole.slice(0, second.length), 'the resumed run reports the whole run from t = 0');
    assert.deepEqual(first, second.slice(0, first.length), 'the abandoned run had reported the same prefix (deterministic)');
    assert.ok(Number(seen.done[0].time) > 0, 'the battle end clock came back');
  } finally {
    await pool.close();
  }
});

// Community report (2026-10-05): in a co-op match the 联防 phase ran its countdown to 0 and the match never advanced.
// Production evidence: `/healthz` showed fieldsPooled 11 with SP_SIM_WORKERS=1 and 8 paused (idle-suspended) matches —
// a frozen match's paused pool job KEEPS its worker (`pause()` only stops granting slices) and `assign()` only ever
// looks for a slot whose `job` is null, so every field queued behind a frozen match waits for it to wake up. The 联防
// field of a live match is exactly such a job (a takeover / a field with no connected authority) — it never finishes,
// so the phase never ends and the countdown sits at 0.
test('REPRO: a paused job must not hold the only worker — a field queued behind a frozen match still finishes', async () => {
  const { specs } = fieldSpecs(2);
  assert.ok(specs.length >= 2, `two field specs captured (${specs.length})`);
  const pool = createSimPool({ size: 1, log: silent });
  try {
    // A owns the single worker and belongs to a match that gets frozen before the field ends (idle suspension)
    const a = sink();
    let handleA = null;
    let pauseReached;
    const reached = new Promise((r) => { pauseReached = () => r('paused'); });
    handleA = pool.run(specs[0], {
      players: ids(specs[0]),
      sliceMs: 1, // many slices: the pause has to land in the middle of the field
      ...a.opts,
      onProgress: (p) => {
        a.seen.progress.push(p);
        if (a.seen.progress.length === 1) { handleA.pause(); pauseReached(); }
      },
    });
    assert.ok(handleA, 'the pool took the first job');
    assert.equal(await Promise.race([reached, a.settled]), 'paused', 'the first field is paused mid-flight');
    assert.deepEqual(a.seen.done, [], 'and it is not finished');
    const frames = a.seen.progress.length;

    // B is a live match's 联防 field handed to the pool while A's match is frozen
    const b = sink();
    const handleB = pool.run(specs[1], { players: ids(specs[1]), sliceMs: 2, ...b.opts });
    assert.ok(handleB, 'the pool took the second job');
    assert.equal(await Promise.race([b.settled, delay(5000).then(() => 'timeout')]), 'done',
      'a field queued behind a frozen match must not wait for that match to wake up');
    assert.equal(resultDigest(b.seen.done[0].result).hash, b.seen.done[0].digest);

    // and the frozen match still resumes where it stood
    assert.equal(a.seen.progress.length, frames, 'A reported nothing while paused');
    handleA.resume();
    assert.equal(await Promise.race([a.settled, delay(5000).then(() => 'timeout')]), 'done', 'A finishes after resume()');
    assert.equal(resultDigest(a.seen.done[0].result).hash, a.seen.done[0].digest);
    assert.deepEqual(a.seen.error, []);
  } finally {
    await pool.close();
  }
});

test('a job paused while it is still queued is not lost: it starts as soon as a worker frees', async () => {
  const { specs } = fieldSpecs(2);
  assert.ok(specs.length >= 2);
  const pool = createSimPool({ size: 1, log: silent });
  try {
    const a = sink();
    const handleA = pool.run(specs[0], { players: ids(specs[0]), sliceMs: 2, ...a.opts });
    assert.ok(handleA);
    const b = sink();
    const handleB = pool.run(specs[1], { players: ids(specs[1]), sliceMs: 2, ...b.opts });
    assert.ok(handleB, 'queued: the only worker is busy');
    handleB.pause(); // queued, never started
    handleB.resume();
    assert.equal(await Promise.race([a.settled, delay(5000).then(() => 'timeout')]), 'done', 'the first field finishes');
    assert.equal(await Promise.race([b.settled, delay(5000).then(() => 'timeout')]), 'done',
      'the queued-then-resumed field runs once the worker frees');
    assert.deepEqual(b.seen.error, []);
  } finally {
    await pool.close();
  }
});

test('cancel() abandons a job (no further callbacks) and frees the worker for the next one', async () => {
  const { specs } = fieldSpecs(1);
  assert.equal(specs.length, 1);
  const pool = createSimPool({ size: 1, log: silent });
  try {
    const first = sink();
    const handle = pool.run(specs[0], { players: ids(specs[0]), sliceMs: 1, ...first.opts });
    assert.ok(handle);
    // wait for the job to be under way, then drop it
    for (let i = 0; i < 200 && !first.seen.progress.length && !first.seen.done.length; i++) await delay(5);
    assert.ok(first.seen.progress.length > 0, 'the job was running');
    const before = first.seen.progress.length;
    handle.cancel();
    await delay(60);
    assert.equal(first.seen.progress.length, before, 'a cancelled job reports nothing more');
    assert.deepEqual(first.seen.done, []);
    assert.deepEqual(first.seen.error, []);
    // the worker is free again
    const second = sink();
    const handle2 = pool.run(specs[0], { players: ids(specs[0]), sliceMs: 2, ...second.opts });
    assert.ok(handle2, 'the pool is usable after a cancel');
    assert.equal(await second.settled, 'done');
    assert.equal(resultDigest(second.seen.done[0].result).hash, second.seen.done[0].digest);
  } finally {
    await pool.close();
  }
});

// ---- a worker that dies mid-job ---------------------------------------------------------------------------------

/**
 * A throwaway protocol worker written OUTSIDE the repository (the suite may not add fixture files to it): it speaks
 * the pool protocol, and dies on an uncaught throw for the spec whose fieldId is 'boom' — what a crashed worker looks
 * like from the pool's side. Every other job it answers with one progress and one done.
 */
const FIXTURE_SRC = [
  "import { parentPort } from 'node:worker_threads';",
  'let spec = null;',
  "parentPort.on('message', (m) => {",
  "  if (m.t === 'start') { spec = m.spec; return; }",
  "  if (m.t !== 'slice') return;",
  "  if (spec && spec.fieldId === 'err') { parentPort.postMessage({ t: 'error', jobId: m.jobId, message: 'fixture job failed', stack: 'at fixture' }); return; }",
  "  if (spec && spec.fieldId === 'boom') throw new Error('fixture worker exploded');",
  "  parentPort.postMessage({ t: 'progress', jobId: m.jobId, gt: 1, killed: 0, total: 1 });",
  "  parentPort.postMessage({ t: 'done', jobId: m.jobId, result: { perPlayer: {} }, digest: 'fixture', timeline: [[0, 0, 0]], crashed: false });",
  '});',
  '',
].join('\n');

let fixtureDir = null;
async function fixtureWorkerFile() {
  if (!fixtureDir) {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'sp-simpool-'));
    const file = path.join(fixtureDir, 'fixtureWorker.mjs');
    await writeFile(file, FIXTURE_SRC, 'utf8');
  }
  return path.join(fixtureDir, 'fixtureWorker.mjs');
}

after(async () => { if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }); });

/** Run a throwaway module in a child process; resolves with its exit code, or 'timeout' when it never leaves. */
function runChild(childFile, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [childFile], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', (e) => { clearTimeout(timer); resolve(`spawn failed: ${e.message}`); });
  });
}

test('a busy worker is held, an idle one is not: a shared pool nobody closes never hangs the process', async () => {
  // The real wiring builds one pool per process and nothing ever closes it (Match.js has no close hook), so the pool
  // must leave the event loop able to exit once its work is done — otherwise every runner that ran a pooled field
  // hangs at the end — while a field that is still running must never be abandoned by a process exiting under it.
  // The child has no sockets and no timers of its own: it only starts a job and writes a marker when it is done.
  const file = await fixtureWorkerFile();
  const marker = path.join(fixtureDir, 'idle-pool-exit.txt');
  const childFile = path.join(fixtureDir, 'idlePoolChild.mjs');
  const host = new URL('../../server/match/simPool.js', import.meta.url).href;
  await writeFile(childFile, [
    "import { writeFileSync } from 'node:fs';",
    `import { createSimPool } from ${JSON.stringify(host)};`,
    `const pool = createSimPool({ size: 1, workerFile: ${JSON.stringify(file)}, log: { warn() {}, error() {}, info() {}, debug() {} } });`,
    `await new Promise((res, rej) => pool.run({ fieldId: 'ok', kind: 'normal', players: [] }, { onDone: res, onError: rej }));`,
    `writeFileSync(${JSON.stringify(marker)}, 'job finished');`,
    '// deliberately no pool.close(): the idle worker must not keep this process alive',
    '',
  ].join('\n'), 'utf8');
  assert.equal(await runChild(childFile, 30000), 0, 'the child exited by itself instead of hanging on an idle worker');
  assert.equal(await readFile(marker, 'utf8'), 'job finished', 'and only after the job had finished (the busy worker held it)');
});

test('a worker killed mid-job: onError exactly once, never onDone, and the pool keeps working', async () => {
  const file = await fixtureWorkerFile();
  const pool = createSimPool({ size: 1, log: silent, workerFile: file });
  try {
    assert.equal(pool.enabled, true);
    const bad = sink();
    const h1 = pool.run({ fieldId: 'boom', kind: 'normal', players: [] }, bad.opts);
    assert.ok(h1, 'the pool took the job');
    assert.equal(await bad.settled, 'error', 'the dead worker settles its job with an error');
    await delay(25); // the 'exit' that follows the 'error' must not settle the job a second time
    assert.equal(bad.seen.error.length, 1, 'onError exactly once');
    assert.equal(bad.seen.done.length, 0, 'never an onDone after an onError');
    assert.ok(bad.seen.error[0] instanceof Error);
    assert.equal(pool.size, 1, 'the worker was replaced');
    const good = sink();
    const h2 = pool.run({ fieldId: 'ok', kind: 'normal', players: [] }, good.opts);
    assert.ok(h2, 'the pool is usable after a worker death');
    assert.equal(await good.settled, 'done');
    assert.equal(good.seen.done[0].digest, 'fixture');
    assert.deepEqual(good.seen.done[0].timeline, [[0, 0, 0]]);
    assert.deepEqual(good.seen.error, []);
  } finally {
    await pool.close();
  }
  assert.equal(pool.enabled, false, 'closed: no live worker');
});

test('a worker that reports an `error` frame settles that job once and keeps serving', async () => {
  // A worker-side scaffolding failure (`{t:'error'}`) is the job's problem, not the worker's: the pool must settle it
  // and go on using the same worker — replacing a healthy worker would cost every queued job the multi-MB data load.
  const file = await fixtureWorkerFile();
  const pool = createSimPool({ size: 1, log: silent, workerFile: file });
  try {
    const bad = sink();
    assert.ok(pool.run({ fieldId: 'err', kind: 'normal', players: [] }, bad.opts), 'the pool took the job');
    assert.equal(await bad.settled, 'error');
    await delay(25);
    assert.equal(bad.seen.error.length, 1, 'onError exactly once');
    assert.equal(bad.seen.done.length, 0, 'never an onDone after an onError');
    assert.equal(pool.size, 1, 'the worker was kept, not replaced');
    assert.equal(pool.enabled, true);
    const good = sink();
    assert.ok(pool.run({ fieldId: 'ok', kind: 'normal', players: [] }, good.opts), 'the same worker takes the next job');
    assert.equal(await good.settled, 'done');
    assert.equal(good.seen.done[0].digest, 'fixture');
  } finally {
    await pool.close();
  }
});

test('a spec the sim cannot even build ends as the synthetic stand-in, exactly like the in-thread DeadBattle path', async () => {
  // The worker must absorb a job it cannot build (here: a spec whose cycle the sim's own JSON clone rejects — a spec is
  // JSON-safe in production, this is the handle to reach the catch) instead of dying: Match._specBattle answers that
  // case with a finished DeadBattle, so the pool must report the same synthetic result, not an error.
  const spec = { fieldId: 'n:unbuildable', kind: 'normal', players: [{ playerId: 'p', units: [] }] };
  spec.cycle = spec;
  const pool = createSimPool({ size: 1, log: silent });
  try {
    const s = sink();
    assert.ok(pool.run(spec, { players: ['p'], ...s.opts }), 'the pool took the job');
    assert.equal(await s.settled, 'done', 'a bad spec still ends the job');
    assert.deepEqual(s.seen.error, []);
    const got = s.seen.done[0];
    // the in-thread answer for the same input: what Match._specBattle does when createBattleFromSpec throws
    const dead = new DeadBattle({
      fieldId: spec.fieldId ?? null, kind: spec.kind ?? 'normal', players: spec.players || [],
      rect: spec.rect ?? null, stageId: spec.stageId ?? null,
    }, 'forced');
    const inThread = runHeadless(dead, { players: ['p'] });
    assert.equal(got.result.synthetic, true);
    assert.equal(got.result.reason, 'forced');
    assert.deepEqual(got.result, inThread.result, 'the synthetic stand-in is the same object graph');
    assert.equal(got.digest, resultDigest(inThread.result).hash, 'and the same digest');
    assert.equal(got.time, Number(inThread.battle.time) || 0, 'and the same end clock');
    assert.equal(got.crashed, inThread.crashed);
    assert.equal(pool.size, 1, 'the worker survived the bad job');
    const good = sink();
    assert.ok(pool.run({ fieldId: 'n:p_0', kind: 'normal', players: [] }, good.opts), 'and is still usable');
    assert.equal(await good.settled, 'done');
  } finally {
    await pool.close();
  }
});

test('a worker that cannot even load is retried a few times, then the pool degrades and fails its queue', async () => {
  // `workerFile` exercises the retry budget the pool has for a worker whose module never loads — a job must never hang.
  const pool = createSimPool({ size: 1, log: silent, workerFile: path.join(os.tmpdir(), 'sp-simpool-does-not-exist.mjs') });
  try {
    const bad = sink();
    const handle = pool.run({ fieldId: 'n:p_0', kind: 'normal', players: [] }, bad.opts);
    assert.ok(handle, 'the pool accepted the job while it still believed it had a worker');
    assert.equal(await bad.settled, 'error', 'the job a dead worker owned is settled, never left hanging');
    assert.equal(bad.seen.error.length, 1);
    assert.equal(bad.seen.done.length, 0);
    // every death is retried, so the pool needs a few rounds before it gives up (the box may be busy: poll, do not sleep)
    for (let i = 0; i < 400 && pool.enabled; i++) await delay(10);
    assert.equal(pool.enabled, false, 'the pool degraded instead of respawning forever');
    assert.equal(pool.size, 0);
    assert.equal(pool.run({ fieldId: 'n:p_1', players: [] }, {}), null, 'a degraded pool takes no job');
  } finally {
    await pool.close();
  }
});
