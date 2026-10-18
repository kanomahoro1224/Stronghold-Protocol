// server/http/healthUsage.js — what the process itself is costing, for GET /healthz (docs/DEPLOY.md §5).
//
// The room / match / socket counts say how much work there is; these say what that work costs. A heap that keeps growing
// between two health checks, or CPU that stays pegged while nothing is running, is the difference between "busy" and
// "leaking", and it is the first thing to look at when a deploy gets slower without an obvious reason.
//
// The CPU numbers are the delta since the previous sample (the first sample reports the process total): a cumulative
// counter answers no operational question, it cannot tell an idle server from one that has been saturating a core.

/** @type {{ user: number, system: number, at: number } | null} */
let previous = null;

/**
 * A sample of the process: resident and heap bytes, and the CPU spent since the previous call.
 * @param {number} [now] injectable clock (milliseconds, tests)
 * @returns {{ memory: { rss: number, heapUsed: number, heapTotal: number, external: number, arrayBuffers: number },
 *             cpu: { userMicros: number, systemMicros: number, sinceMs: number, percent: number } }}
 */
export function usageSnapshot(now = Date.now()) {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const sinceMs = previous ? Math.max(0, now - previous.at) : 0;
  const userMicros = previous ? cpu.user - previous.user : cpu.user;
  const systemMicros = previous ? cpu.system - previous.system : cpu.system;
  previous = { ...cpu, at: now };
  // percent of one core; cpuUsage() sums every thread, so a worker-heavy process reports more than 100
  const percent = sinceMs > 0 ? Math.round(((userMicros + systemMicros) / 1000 / sinceMs) * 1000) / 10 : 0;
  return {
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers },
    cpu: { userMicros, systemMicros, sinceMs, percent },
  };
}

/** Forgets the previous sample (tests: the next call is a baseline again). */
export function resetUsageSnapshot() {
  previous = null;
}
