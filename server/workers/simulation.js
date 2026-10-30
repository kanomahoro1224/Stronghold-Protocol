import { parentPort, workerData } from 'node:worker_threads';
import { setData } from '../data.js';
import { memorySample } from './memory.js';

// Content imports getData() too: never read a different on-disk version when this thread starts later.
setData(workerData.data);
// Both rehearsal channels run here: the branch ships candidate options as JSON and scores them with the same
// createWorkerRehearsalJob the main thread uses, upstream ships BattleSpecs that RehearsalRun builds lazily (no live
// boss pool crosses the thread). A payload carries one shape or the other, never both.
const [{ Battle }, { DataSource }, { createBattleFromSpec }, { HeadlessJob }, { createWorkerRehearsalJob: createRehearsalJob }, { RehearsalRun }] = await Promise.all([
  import('../sim/Battle.js'), import('../sim/simdata.js'), import('../sim/spec.js'),
  import('../match/fields.js'), import('../match/bot.js'), import('../sim/rehearsal.js'),
]);
const ds = new DataSource(workerData.data, null);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

parentPort.on('message', ({ id, type, payload, cancel }) => {
  const flag = new Int32Array(cancel);
  const cancelled = () => Atomics.load(flag, 0) !== 0;
  try {
    if (cancelled()) throw new Error('cancelled');
    let value;
    if (type === 'battle') {
      const battle = createBattleFromSpec(payload.spec, ds, { recordEvents: false, logger: quiet });
      const job = new HeadlessJob(battle, { players: payload.players });
      let sent = 0, lastProgress = performance.now();
      while (!job.run(4)) {
        if (cancelled()) throw new Error('cancelled');
        if (payload.progress && performance.now() - lastProgress >= 100) {
          parentPort.postMessage({ id, progress: { reset: sent === 0, samples: job.timeline.slice(sent) } });
          sent = job.timeline.length;
          lastProgress = performance.now();
        }
      }
      const out = job.output();
      value = { result: out.result, timeline: out.timeline, time: out.battle.time, errors: out.battle.errors,
        crashed: out.crashed };
    } else if (type === 'rehearsal') {
      if (Array.isArray(payload.specs)) {
        // BattleSpecs remove live boss pools and construct candidates lazily, like local/adaptive rehearsals.
        const factories = payload.specs.map((spec) => () => createBattleFromSpec(spec, ds, { logger: quiet }));
        const run = new RehearsalRun(factories, payload.playerId, payload.cap, payload.limits || {});
        while (!run.run(cancelled)) if (cancelled()) throw new Error('cancelled');
        value = { bestIndex: run.score.index, stats: { totalTicks: run.totalTicks, completed: run.completed,
          considered: run.index, stopReason: run.stopReason, choice: run.score.index, candidates: factories.length } };
      } else {
        // the branch's channel: whole battle options, built here and scored by the shared rehearsal algorithm
        const battles = payload.options.map((opts) => new Battle({ ...opts, data: ds, logger: quiet }));
        const plans = battles.map((_, i) => i);
        const job = createRehearsalJob(battles, [], plans, payload.playerId, payload.cap, quiet);
        while (!job.run(4)) if (cancelled()) throw new Error('cancelled');
        value = { bestIndex: job.best };
      }
    } else throw new Error(`unknown simulation task: ${type}`);
    parentPort.postMessage({ id, value, memory: memorySample() });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message, memory: memorySample() });
  }
});
