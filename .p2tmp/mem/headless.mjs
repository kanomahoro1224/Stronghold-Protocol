// PART 1(d): what a server-run field holds — HeadlessJob + its battle graph, while running and after it completes.
//   node --expose-gc .p2tmp/mem/headless.mjs
import { performance } from 'node:perf_hooks';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { createBattleFromSpec } from '../../server/sim/spec.js';
import { HeadlessJob, runHeadless } from '../../server/match/fields.js';
import { pinned, diff, line, mb } from './snap.mjs';

// one real bot-field spec out of a real match (rounds 1..3 so the shape is representative)
function specFor(round) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 0, bots: 4, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed: 91001 });
  h.autoHumans();
  const drive = (pred) => {
    for (let i = 0; i < 6e6; i++) {
      h.sent.length = 0; h.bc.length = 0;
      if (pred()) return true;
      if (!h.sched.runNext()) return false;
    }
    return false;
  };
  h.m.start();
  drive(() => h.m.phase === PHASE.COMBAT && h.m.round === round);
  const f = h.m.fields.find((x) => x.mode === 'server') || h.m.fields[0];
  const out = { spec: f.spec, ds: h.m.ds, gd: h.m.gd, round: h.m.round };
  h.m.dispose();
  return out;
}

const { spec, ds } = specFor(1);
console.log(`spec: kind=${spec.kind} spawns=${spec.spawns.length} timeLimit=${spec.timeLimit} stageId=${spec.stageId} jsonLen=${JSON.stringify(spec).length} B`);

const mk = () => createBattleFromSpec(spec, ds, { recordEvents: false, quiet: true });
const stepTo = (b, gt) => { while (!b.finished && b.time < gt) b.step(); return b; };

async function perUnit(label, N, build) {
  const keep = [];
  for (let i = 0; i < 2; i++) keep.push(build(i));
  keep.length = 0;
  const a = await pinned();
  const t = performance.now();
  for (let i = 0; i < N; i++) keep.push(build(i));
  const us = ((performance.now() - t) * 1000) / N;
  const b = await pinned();
  const d = diff(a, b);
  console.log(line(label, d, N));
  console.log(`    ${us.toFixed(0)} µs each; heapTotal ${mb(b.heapTotal)} rss ${mb(b.rss)} MB`);
  return keep;
}

const N = 12;
console.log('\n--- the battle graph of one server-run field ---');
await perUnit('battle freshly built (gt 0)', N, () => mk());
await perUnit('battle stepped to gt 10 s', N, () => stepTo(mk(), 10));
const mid = await perUnit('battle stepped to gt 45 s (mid round)', N, () => stepTo(mk(), 45));
await perUnit('battle at gt 88 s (late round)', N, () => stepTo(mk(), 88));
const done = await perUnit('battle run to the end (finished)', N, () => { const b = mk(); while (!b.finished) b.step(); return b; });

const limit = spec.timeLimit;
console.log(`\nspec.timeLimit = ${limit} game s (${limit / 2} real s at 2x)`);
console.log('unit counts of the mid-round battle:');
for (const b of mid.slice(0, 1)) {
  const keys = Object.keys(b);
  console.log(`  battle fields: ${keys.length} keys; units=${(b.units || b.actors || []).length}; spawns=${(b.spawns || []).length}`);
}

console.log('\n--- HeadlessJob wrapper / output retention ---');
await perUnit('HeadlessJob(fresh battle) — job + timeline', N, () => new HeadlessJob(mk(), { players: ['ai_0'] }));
await perUnit('finished battle + HeadlessJob.run() output kept', N, () => {
  const b = mk(); while (!b.finished) b.step();
  const job = new HeadlessJob(b, { players: ['ai_0'] });
  job.run(Infinity);
  return job; // the field keeps job.output(): { battle, result, timeline }
});
const outputs = await perUnit('runHeadless() output object (battle+result+timeline)', N, () => runHeadless(mk(), { players: ['ai_0'] }));
{
  const o = outputs[0];
  console.log(`  timeline samples: ${o.timeline.length}; result.perPlayer keys: ${Object.keys(o.result.perPlayer).length}`);
}
await perUnit('result + timeline only (battle released)', N, () => {
  const o = runHeadless(mk(), { players: ['ai_0'] });
  return { result: o.result, timeline: o.timeline };
});
await perUnit('BattleSpec object alone (JSON clone, as f.spec holds it)', N, () => JSON.parse(JSON.stringify(spec)));
