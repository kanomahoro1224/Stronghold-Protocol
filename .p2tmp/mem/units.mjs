// PART 1(e) + constructor plane: per-match GameData + SharedPool cost, and the Match record itself.
//   node --expose-gc .p2tmp/mem/units.mjs
import { performance } from 'node:perf_hooks';
import { getData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';
import { SharedPool } from '../../server/match/pool.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, snap, diff, line, mb, MB } from './snap.mjs';

const t0 = performance.now();
const BEFORE_DATA = await pinned();
const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const AFTER_DATA = await pinned();
console.log('--- process baseline ---');
console.log(`module load + data/*.json singleton (deep-frozen)   heap ${mb(AFTER_DATA.heapUsed)} MB, rss ${mb(AFTER_DATA.rss)} MB`);
console.log(`  of which the data singleton itself               heap ${mb(diff(BEFORE_DATA, AFTER_DATA).heapUsed)} MB`);
console.log(`  (import time ${Math.round(performance.now() - t0)} ms)`);
console.log(`  heap stats: totalHeap ${mb(AFTER_DATA.totalHeap)} MB nativeContexts ${AFTER_DATA.numberNativeContexts}`);

async function perUnit(label, N, build) {
  const keep = [];
  // warm-up so lazily created shapes / memo maps are not counted as growth of the first batch
  for (let i = 0; i < 3; i++) keep.push(build(i));
  keep.length = 0;
  const a = await pinned();
  const t = performance.now();
  for (let i = 0; i < N; i++) keep.push(build(i));
  const us = ((performance.now() - t) * 1000) / N;
  const b = await pinned();
  console.log(line(label, diff(a, b), N));
  console.log(`  construction time: ${us.toFixed(1)} µs each`);
  return { a, b, keep };
}

console.log('\n--- (e) per-match GameData + shared pool ---');
const g1 = await perUnit('new GameData(DATA, mode_multi_normal)', 300, () => new GameData(DATA, 'mode_multi_normal'));
const gd = g1.keep[0];
const g2 = await perUnit('new SharedPool(gd)  (unbanned)', 300, () => new SharedPool(gd));

// GameData holds per-instance arrays derived from the shared data: size of the derived index arrays
console.log(`\nshared data index sizes (per-instance arrays): visibleChess ${gd.visibleChess.length} ids, `
  + `bondIds ${gd.bondIds.length}, shopItemsByTier ${JSON.stringify(Object.fromEntries(Object.entries(gd.shopItemsByTier).map(([k, v]) => [k, v.length])))}`);
console.log(`pool entries of a real match: ${makeMatch({ humans: 1, bots: 1 }).m.pool.entries.size}`);

console.log('\n--- the Match record itself (constructor only, no play) ---');
const N = 60;
const one = await perUnit('Match 1 human (constructor)', N, (i) => makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 1000 + i, captureFrames: false }).m);
const two = await perUnit('Match 2 humans (constructor)', N, (i) => makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 2000 + i, captureFrames: false }).m);
const four = await perUnit('Match 4 bots (constructor)', N, (i) => makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 0, bots: 4, seed: 3000 + i, captureFrames: false }).m);
for (const m of [...one.keep, ...two.keep, ...four.keep]) m.dispose();

console.log('\n--- interpretation ---');
console.log('per-human-seat = (2 humans - 1 human) ; per-bot-seat = (4 bots - 4 seats of human baseline) — see report');
