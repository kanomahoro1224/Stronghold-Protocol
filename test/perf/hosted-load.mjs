// Manual performance probe for the multi-core work (DESIGN §23) — NOT part of `node --test`:
//
//   node test/perf/hosted-load.mjs [seconds] [fieldsPerMatch]
//
// Answers two questions with numbers, on this machine:
//   A. what one hosted battle tick costs (µs) for a light / mid / worst-case wave, and
//   B. at the server's real pump schedule (30 Hz interval, GAME_SPEED, up to maxTicksPerInterval ticks per pump,
//      every live field stepped in lockstep — exactly FieldRunner._tick), how much of ONE core K battles eat.
//
// From B: fields per core = K / coreFraction, matches per core = that / fieldsPerMatch. The live /healthz `fields`
// counter then says how many cores the box needs right now, which is what P2 (worker_threads) can and cannot buy.
import { Battle } from '../../server/sim/Battle.js';
import { getDefaultSource, spawnsFromTemplate } from '../../server/sim/simdata.js';
import { TICK, SNAPSHOT_EVERY } from '../../server/sim/constants.js';
import { GAME_SPEED, INTERVAL_MS, maxTicksPerInterval } from '../../server/match/fields.js';
import { loopStats } from '../../server/index.js';

const seconds = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 4;
const fieldsPerMatch = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 4;
const rehearsalOnly = process.argv.includes('--rehearsal');

const ds = getDefaultSource();
const quiet = { error() {}, warn() {} };
const LINEUP = [
  ['chess_char_1_02_a', 9, 7], ['chess_char_2_09_a', 9, 4], ['chess_char_4_09_a', 12, 5], ['chess_char_3_08_a', 12, 7],
  ['chess_char_1_01_a', 10, 4], ['chess_char_1_03_a', 11, 4], ['chess_char_2_02_a', 12, 4], ['chess_char_2_14_a', 10, 5],
  ['chess_char_5_12_a', 11, 5], ['chess_char_6_13_a', 9, 8],
];
const KEYS = ['enemy_1422_lrsldr', 'enemy_1427_lrnazg', 'enemy_1005_yokai', 'enemy_1042_frostd', 'enemy_1425_lrcmra', 'enemy_1040_bombd'];

/** A battle on the existing benchmark wave, scaled to `count` enemies and `hpMul`. */
function shape(count, hpMul, seed = 7) {
  const tpl = ds.getWave('act1autochess_h05');
  const { routes, maxPlayTime } = spawnsFromTemplate(tpl);
  const spawns = [];
  for (let i = 0; i < count; i++) {
    spawns.push({ time: (i % 10) * 0.2, enemyKey: KEYS[i % KEYS.length], routeIndex: i % routes.length, mods: { hpMul } });
  }
  return new Battle({
    seed, kind: 'normal', stageId: 'act2autochess_m01', routes, spawns, timeLimit: maxPlayTime,
    logger: quiet, quiet: true,
    players: [{ playerId: 'p', units: LINEUP.map(([chessId, row, col], i) => ({ uid: i + 1, kind: 'chess', chessId, row, col, abs: true })) }],
  });
}

/** Full run of one battle, snapshotting like the runner does. */
function runOnce(b) {
  let n = 0;
  const t0 = performance.now();
  while (!b.finished) {
    b.step();
    n++;
    if (n % SNAPSHOT_EVERY === 0) { b.snapshot(); b.drainEvents(); }
  }
  return { n, ms: performance.now() - t0 };
}

function benchPerTick(name, count, hpMul) {
  for (let i = 0; i < 2; i++) { const w = shape(count, hpMul, 100 + i); while (!w.finished) w.step(); }
  const r = runOnce(shape(count, hpMul));
  const us = (r.ms / r.n) * 1000;
  console.log(`${name.padEnd(22)} ${String(count).padStart(3)} spawns  ${String(r.n).padStart(4)} ticks  ${us.toFixed(1).padStart(8)} µs/tick`);
  return us;
}

if (rehearsalOnly) {
  // --- C. bot layout rehearsal: whole simulated battles per bot per prep round (Match.botRehearsal / SP_BOT_REHEARSAL).
  // A full 4-bot match on a virtual clock (battles run to their end synchronously) costs the same CPU as on the real
  // one, so the difference between the rows is the rehearsal's share of a match. That share is what a box short of
  // CPU can turn down without touching anything else.
  const { makeMatch } = await import('../match/harness.js');
  const cpuMs = (fn) => { const c0 = process.cpuUsage(); fn(); const c = process.cpuUsage(c0); return (c.user + c.system) / 1000; };
  console.log('\n--- C. CPU of one full 4-bot match by rehearsal setting (virtual clock, real battles) ---');
  let base = null;
  for (const n of [0, 1, 3]) {
    const ms = cpuMs(() => {
      const h = makeMatch({ mode: 'coop', humans: 0, bots: 4, seed: 900 + n, botRehearsal: n });
      h.m.start();
      try { h.runToEnd({ maxSteps: 5e6 }); } finally { h.m.dispose(); }
    });
    if (n === 0) base = ms;
    const share = base && n !== 0 ? `  (+${(ms - base).toFixed(0)} ms, ${(((ms - base) / ms) * 100).toFixed(0)}% of the match)` : '';
    console.log(`botRehearsal=${n}: ${ms.toFixed(0)} ms CPU per match${share}`);
  }
  process.exit(0);
}

console.log(`TICK=${TICK.toFixed(5)}s (${(1 / TICK).toFixed(0)} ticks/game-second)  GAME_SPEED=${GAME_SPEED}  pump=${INTERVAL_MS.toFixed(1)}ms  cap=${maxTicksPerInterval(GAME_SPEED)} ticks/pump`);
const perTicksPerSecond = (1 / TICK) * GAME_SPEED; // ticks a field needs per wall second
console.log(`=> one hosted field demands ${perTicksPerSecond.toFixed(0)} ticks/s (every field in a match steps in lockstep)`);
console.log('--- A. cost of one tick (snapshot every %d) ---', SNAPSHOT_EVERY);
const light = benchPerTick('light (early wave)', 10, 3);
const mid = benchPerTick('mid', 30, 6);
const heavy = benchPerTick('heavy (worst case)', 70, 10);
for (const [name, us] of [['light', light], ['mid', mid], ['heavy', heavy]]) {
  // ms of CPU per wall second for one field = ms/tick × ticks/s; as a share of one core = that / 1000.
  const perField = (us / 1000) * perTicksPerSecond;
  console.log(`${name.padEnd(6)}: ${(perField / 10).toFixed(2)}% of one core per hosted field (${perField.toFixed(1)} ms CPU per field-second)`);
}

// --- B. real pump: K heavy battles in lockstep, the way FieldRunner drives one match's fields ---
const K = Math.max(1, Number(process.env.K) > 0 ? Number(process.env.K) : 40);
const fields = [];
for (let i = 0; i < K; i++) fields.push(shape(70, 10, 5000 + i));
const cap = maxTicksPerInterval(GAME_SPEED);
let acc = 0;
let ticks = 0;
let steps = 0;
let busyMs = 0;
let last = performance.now();
loopStats(); // enable the monitor before the run
const cpu0 = process.cpuUsage();
const wall0 = performance.now();
const pump = () => {
  const now = performance.now();
  acc += ((now - last) / 1000) * GAME_SPEED;
  last = now;
  let n = Math.floor(acc / TICK + 1e-9);
  if (n > cap) { n = cap; acc = 0; } else acc -= n * TICK;
  const busy0 = performance.now();
  for (let i = 0; i < n; i++) {
    for (const b of fields) { if (!b.finished) { b.step(); steps++; } }
    ticks++;
  }
  busyMs += performance.now() - busy0;
};
const timer = setInterval(pump, INTERVAL_MS);
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(timer);
const wall = (performance.now() - wall0) / 1000;
const cpu = process.cpuUsage(cpu0);
const coreFraction = (cpu.user + cpu.system) / 1e6 / (wall * 1000);
const loop = loopStats();
const alive = fields.filter((b) => !b.finished).length;
console.log(`\n--- B. ${K} heavy battles at the real pump for ${wall.toFixed(1)}s (${alive} still alive) ---`);
console.log(`pumps stepped ${ticks} lockstep ticks = ${steps} battle steps (${(steps / wall).toFixed(0)}/s), busy ${busyMs.toFixed(0)}ms of ${(wall * 1000).toFixed(0)}ms wall`);
console.log(`CPU: ${(coreFraction * 100).toFixed(1)}% of one core (cpuUsage) vs ${((busyMs / (wall * 1000)) * 100).toFixed(1)}% (in-pump timing)`);
console.log(`event loop p99 ${loop.p99.toFixed(1)}ms / max ${loop.max.toFixed(1)}ms over ${(loop.windowMs / 1000).toFixed(1)}s`);
if (coreFraction > 0.02) {
  const perCore = K / coreFraction;
  console.log(`=> ONE core carries ~${perCore.toFixed(0)} such hosted battles (${(perCore / fieldsPerMatch).toFixed(1)} matches at ${fieldsPerMatch} fields each)`);
  console.log(`=> 2 vCPU carry ~${(perCore * 2).toFixed(0)} battles with nothing left for sockets/lobby`);
}
