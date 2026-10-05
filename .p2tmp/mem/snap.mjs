// .p2tmp/mem/snap.mjs — memory snapshot helpers for the OOM decomposition (local scratch, never committed).
// Run every probe with:  node --expose-gc <probe>.mjs
import v8 from 'node:v8';

export const MB = 1024 * 1024;
export const mb = (n) => Math.round((n / MB) * 1000) / 1000;

export function gcNow() {
  if (typeof global.gc !== 'function') throw new Error('run with --expose-gc');
  global.gc({ type: 'major', execution: 'sync' });
  global.gc({ type: 'major', execution: 'sync' });
}

const tick = () => new Promise((r) => setImmediate(r));

export function snap() {
  const m = process.memoryUsage();
  const h = v8.getHeapStatistics();
  const s = v8.getHeapSpaceStatistics();
  const spaces = {};
  for (const sp of s) spaces[sp.space_name] = sp.space_used_size;
  return {
    rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers,
    usedHeap: h.used_heap_size, totalHeap: h.total_heap_size, malloced: h.malloced_memory,
    numberNativeContexts: h.number_of_native_contexts, numberDetachedContexts: h.number_of_detached_contexts,
    spaces,
  };
}

/** Snapshot after two synchronous major GCs (and one turn of the loop, so finalizers run). */
export async function pinned() {
  gcNow();
  await tick();
  gcNow();
  return snap();
}

export function diff(a, b) {
  const out = {};
  for (const k of Object.keys(a)) {
    if (typeof a[k] === 'number') out[k] = b[k] - a[k];
  }
  out.spaces = {};
  for (const k of Object.keys(a.spaces || {})) out.spaces[k] = (b.spaces[k] || 0) - (a.spaces[k] || 0);
  return out;
}

export const line = (label, d, n = 1) => {
  const per = (x) => (n === 1 ? mb(x) : mb(x / n));
  return `${label.padEnd(46)} total heap ${String(mb(d.heapUsed)).padStart(8)} MB | rss ${String(mb(d.rss)).padStart(8)} MB`
    + ` | per-unit heap ${String(per(d.heapUsed)).padStart(8)} MB (${String(Math.round((d.heapUsed / n))).padStart(8)} B)`
    + ` | per-unit rss ${String(per(d.rss)).padStart(8)} MB`;
};

export const fmt = (n) => `${mb(n)} MB`;
export const bytes = (n) => `${Math.round(n)} B`;
