// community/public/js/latency.js — client-side (browser-measured) latency to each game node.
//
// WHY THIS EXISTS
// The server's /healthz probe also returns a `latencyMs`, but that number is the round-trip between the
// COMMUNITY SERVER and the game node — it tells the user nothing about their own connection. What a player
// actually cares about is "how far am I from this server", so we measure it in their browser.
//
// HOW
//   * We time a real request from the page to `<address>/healthz` with `performance.now()`.
//   * `mode: 'no-cors'` lets us fire the request without the node sending CORS headers. The response is
//     opaque (we cannot read the body — and we don't need to: the server already gave us the payload),
//     but the *timing* is real and usable.
//   * A cache-busting query keeps the measurement out of the HTTP cache, otherwise a warm cache would
//     report ~0 ms and be meaningless.
//   * Several samples are taken and the MEDIAN is reported, so one slow DNS lookup or a stray GC pause
//     doesn't dominate.
//
// NOTE: an opaque response cannot distinguish "reached the node" from "reached some proxy". A browser
// that swallows the request (adblock, mixed-content block) yields no timing at all, in which case we
// return `null` and the UI falls back to describing the server-side reachability instead of inventing
// a number.

const SAMPLES = 3;
const SAMPLE_GAP_MS = 60;
/** Per-attempt cap. A node that never answers must not leave the UI spinning. */
const ATTEMPT_TIMEOUT_MS = 5000;

/** Append a cache-buster so each sample is a genuine network round-trip. */
function bust(url) {
  const u = new URL(url);
  u.searchParams.set('_sp', Math.random().toString(36).slice(2));
  return u.toString();
}

/**
 * One timed request. Resolves to the elapsed ms, or `null` when the browser gave us no usable timing.
 * @param {string} healthzUrl
 * @returns {Promise<number|null>}
 */
async function once(healthzUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
  const started = performance.now();
  try {
    await fetch(bust(healthzUrl), {
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'follow',
      signal: ac.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    // An opaque response still resolves with a Response object once the headers/body settle.
    return performance.now() - started;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The median of the samples that produced a timing. @param {number[]} xs */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Measure a player→node round-trip, in ms.
 * @param {string} address the stored node base URL, e.g. `https://t44.kafuno.cn:34046/`
 * @returns {Promise<number|null>} median ms, or null if the browser could not measure it
 */
export async function measure(address) {
  let healthz;
  try {
    healthz = new URL('healthz', address).toString();
  } catch {
    return null;
  }
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = await once(healthz);
    if (t != null) samples.push(t);
    if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS));
  }
  return median(samples);
}

/**
 * Measure every node in parallel, keyed by server id.
 * @param {Array<{id:number|string, address:string}>} servers
 * @returns {Promise<Record<string, number|null>>}
 */
export async function measureAll(servers) {
  const pairs = await Promise.all(
    servers.map(async (s) => [String(s.id), await measure(s.address)]),
  );
  return Object.fromEntries(pairs);
}

/** Colour band for a measured latency, used by the UI. @param {number|null} ms */
export function grade(ms) {
  if (ms == null) return 'none';
  if (ms < 80) return 'good';
  if (ms < 180) return 'fair';
  return 'poor';
}
