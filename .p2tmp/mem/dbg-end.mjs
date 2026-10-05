// Debug: why does a 2H+2B client-combat match end at round 0 under my driver?
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';

const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed: 4100, captureFrames: false });
h.autoHumans();
h.m.start();
let i = 0;
for (; i < 200000; i++) {
  if (h.ended != null) break;
  if (!h.sched.runNext()) break;
  if (i % 2000 === 0) console.log(`step ${i} phase=${h.m.phase} round=${h.m.round} paused=${h.m.paused} ended=${!!h.ended}`);
}
console.log(`stopped at step ${i}: phase=${h.m.phase} round=${h.m.round} ended=${JSON.stringify(h.ended)} errors=${h.m.errorCount} schedErrors=${h.sched.errors.length}`);
if (h.sched.errors.length) console.log(String(h.sched.errors[0].stack || h.sched.errors[0]).split('\n').slice(0, 4).join('\n'));
console.log(`client count=${h.clients ? h.clients.size : 0}`);
for (const [pid, c] of h.clients || []) console.log(`  ${pid}: starts=${c.starts.length} battles=${c.battles.size} ends=${c.ends.length}`);
