// PART 1(a)(b)(c): per-match cost of an ACTIVE client-combat match, and of the same match IDLE-PAUSED.
//   node --expose-gc .p2tmp/mem/combat.mjs E1|E2|E3|E4|E5|E6
// One batch per stage: stripClients() kills the SimClients, so a batch is measured at exactly one stage then disposed.
// Harness captures (h.sent/h.bc/SimClient.log) are cleared every callback — they are harness-only and would otherwise
// dominate the measurement (the live server keeps none of them).
import { performance } from 'node:perf_hooks';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';
import { pinned, diff, line, mb } from './snap.mjs';

const which = (process.argv[2] || 'E1').toUpperCase();

function drive(h, pred, maxSteps = 6e6) {
  if (!h._started) { h._started = true; h.m.start(); }
  for (let i = 0; i < maxSteps; i++) {
    h.sent.length = 0;
    h.bc.length = 0;
    if (h.clients) for (const c of h.clients.values()) { c.log.length = 0; c.starts.length = 0; c.ends.length = 0; c.pools.length = 0; }
    if (pred()) return true;
    if (!h.sched.runNext()) return !!pred();
  }
  return !!pred();
}

/** Drop what exists only because a *browser* is stood up inside this process (the real client's battle is elsewhere). */
function stripClients(h) {
  h.sent.length = 0;
  h.bc.length = 0;
  if (!h.clients) return;
  for (const c of h.clients.values()) {
    c.log.length = 0;
    for (const e of c.battles.values()) { e.battle = null; e.meter = null; e.spec = null; }
    c.battles.clear();
  }
}

/** Freeze a match while its in-thread HeadlessJob is still mid-battle (the worst retained graph). */
function freezeMidSlice(h, slices = 6) {
  for (const f of h.m.fields) {
    for (let i = 0; i < slices; i++) {
      const t = f.sliceTimer;
      if (!t) break;
      f.sliceTimer = null;
      try { t.fn(); } catch { /* ignore */ }
    }
  }
  h.m._freeze();
  return h.m.fields.filter((f) => f.job).length;
}

function build(cfg, N) {
  const list = [];
  for (let i = 0; i < N; i++) {
    const h = makeMatch({ ...cfg, seed: cfg.seed0 + i, captureFrames: false });
    h.autoHumans();
    list.push(h);
  }
  return list;
}

function dump(tag, d, N, s) {
  console.log(line(`  ${tag}`, d, N));
  console.log(`    abs: heapUsed ${mb(s.heapUsed)} heapTotal ${mb(s.heapTotal)} external ${mb(s.external)} arrBuf ${mb(s.arrayBuffers)} malloced ${mb(s.malloced)} rss ${mb(s.rss)} MB`
    + ` | ${Object.entries(s.spaces).map(([k, v]) => `${k.replace('_space', '')}=${mb(v)}`).join(' ')}`);
}

async function stage(label, cfg, N, stageFn, { dispose = true } = {}) {
  console.log(`\n===== ${label} (N=${N}) =====`);
  const batch = build(cfg, N);
  const s0 = await pinned();
  const t = performance.now();
  const info = await stageFn(batch);
  const s = await pinned();
  dump(label, diff(s0, s), N, s);
  console.log(`  (${info}; drive ${((performance.now() - t) / 1000).toFixed(1)} s)`);
  if (dispose) for (const h of batch) { try { h.m.dispose(); } catch { /* ignore */ } }
  return { batch, s0, s };
}

const A2B2 = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0: 4100 };
const BOT = (bots, seed0) => ({ mode: 'coop', difficulty: 'NORMAL', humans: 0, bots, clientCombat: true, pace: 'paced', headlessSliceMs: 8, seed0 });
const toCombat = (h) => drive(h, () => h.m.phase === PHASE.COMBAT);

if (which === 'E1') {
  await stage('(b) 1 bot seat (1 server-run field) in COMBAT R1 +10 s', BOT(1, 8100), 16, (b) => {
    for (const h of b) { toCombat(h); h.sched.advance(10_000); }
    return 'ok';
  });
}
if (which === 'E2') {
  await stage('(b) 4 bot seats (4 server-run fields) in COMBAT R1 +10 s', BOT(4, 7300), 16, (b) => {
    for (const h of b) { toCombat(h); h.sched.advance(10_000); }
    const st = b.map((h) => h.m.hostedFieldStats());
    console.log(`  hosted inThread ${st.map((x) => x.inThread).join(',')} (0 = job completed, battle still retained on the field)`);
    return 'ok';
  });
}
if (which === 'E3') {
  const r = await stage('(a) 2 humans + 2 bots in COMBAT R1 +10 s, browser stand-ins stripped', A2B2, 16, (b) => {
    for (const h of b) { toCombat(h); h.sched.advance(10_000); }
    return 'driven';
  }, { dispose: false });
  const sFull = await pinned();
  for (const h of r.batch) stripClients(h);
  const sSrv = await pinned();
  dump('same stage, server-side only', diff(r.s0, sSrv), 16, sSrv);
  console.log(`  SimClient stand-ins (2 client battles/match) held ${mb(diff(r.s0, sFull).heapUsed - diff(r.s0, sSrv).heapUsed)} MB total`);
  for (const h of r.batch) h.m.dispose();
}
if (which === 'E4') {
  await stage('(c) 2 humans + 2 bots, IDLE-PAUSED with the in-thread jobs still mid-battle (server-side)', A2B2, 16, (b) => {
    let live = 0;
    for (const h of b) { toCombat(h); stripClients(h); live += freezeMidSlice(h); }
    return `${live} live jobs parked across 16 matches`;
  });
}
if (which === 'E4b') {
  await stage('(c) 2 humans + 2 bots, IDLE-PAUSED after +10 s (jobs already completed), server-side', A2B2, 16, (b) => {
    for (const h of b) { toCombat(h); h.sched.advance(10_000); stripClients(h); h.m._freeze(); }
    return `${b.filter((h) => h.m.paused).length}/16 paused`;
  });
}
if (which === 'E5') {
  const r = await stage('(a) 2 humans + 2 bots played to the END', A2B2, 16, (b) => {
    let n = 0;
    for (const h of b) if (drive(h, () => h.m.ended != null)) n++;
    console.log(`  ended ${n}/16; final rounds ${b.map((h) => h.m.round).join(',')}`);
    return `${n}/16 ended`;
  }, { dispose: false });
  const sFull = await pinned();
  for (const h of r.batch) stripClients(h);
  const sSrv = await pinned();
  dump('same stage, server-side only', diff(r.s0, sSrv), 16, sSrv);
  console.log(`  SimClient stand-ins held ${mb(diff(r.s0, sFull).heapUsed - diff(r.s0, sSrv).heapUsed)} MB total`);
  for (const h of r.batch) h.m.dispose();
}
if (which === 'E6') {
  await stage('(a) 2 humans + 2 bots driven to COMBAT R7+ (deep round), server-side', A2B2, 12, (b) => {
    let n = 0;
    for (const h of b) {
      drive(h, () => h.m.ended || (h.m.phase === PHASE.COMBAT && h.m.round >= 7));
      if (h.m.round >= 7) n++;
      stripClients(h);
    }
    console.log(`  rounds ${b.map((h) => h.m.round).join(',')}`);
    return `${n}/12 reached R7`;
  });
}
