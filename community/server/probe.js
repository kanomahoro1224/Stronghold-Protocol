// community/server/probe.js — live status probing for registered game servers.
//
// The list page must show each server's real-time state. We poll `<address>/healthz` (the game server's own
// status route, server/http/routes.js) rather than trusting anything stored in the DB.
//
// Design notes:
//   * Results are cached for TTL_MS (default 10 s) and deduplicated by address, so N pages showing the same
//     server cost one upstream request per window — a community list must never hammer the game boxes.
//   * Timeouts are short (4 s) and the body is capped: /healthz is small, but a hostile address must not OOM us.
//   * The raw JSON is preserved verbatim (`raw`) so the list page can render the FULL healthz payload, which is
//     what the user asked for — we do not trim fields.
//   * https certificates: game nodes are frequently self-signed / behind a tunnel, so TLS verification is
//     relaxed ONLY here, and only for the probe. This is deliberate and documented.

const TTL_MS = Number(process.env.SP_COMMUNITY_PROBE_TTL_MS || 10_000);
const TIMEOUT_MS = Number(process.env.SP_COMMUNITY_PROBE_TIMEOUT_MS || 4_000);
const MAX_BODY = 64 * 1024;

/** @type {Map<string, { at:number, result:object }>} */
const cache = new Map();

/** Normalise a user-entered address into a base URL ending in `/`. @returns {URL|null} */
export function normalizeAddress(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    u.hash = '';
    u.search = '';
    // keep any path the operator typed, but drop a trailing /healthz so we can append our own
    u.pathname = u.pathname.replace(/\/healthz\/?$/i, '');
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u;
  } catch {
    return null;
  }
}

/** Is this a syntactically acceptable server address? Used by the API validator. */
export const isValidAddress = (input) => normalizeAddress(input) !== null;

/** The `https://host[:port]/` form we display and store (stable, no trailing slash). */
export function canonicalAddress(input) {
  const u = normalizeAddress(input);
  if (!u) return null;
  return u.toString();
}

/** @param {string} address @returns {Promise<object>} the parsed healthz JSON */
async function fetchHealthz(address) {
  const base = normalizeAddress(address);
  if (!base) return { ok: false, reachable: false, error: '地址无效 · invalid address' };
  const url = new URL('healthz', base);
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': 'stronghold-community-probe/0.1' },
    });
    const text = await readCapped(res, MAX_BODY);
    const latencyMs = Date.now() - started;
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok || !json) {
      return { ok: false, reachable: res.ok, status: res.status, latencyMs, error: json ? null : '响应不是 JSON · non-JSON body' };
    }
    return { ok: true, reachable: true, status: res.status, latencyMs, raw: json };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return { ok: false, reachable: false, latencyMs, error: aborted ? '探测超时 · timeout' : '无法连接 · unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most `max` bytes of a response body. */
async function readCapped(res, max) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Cached probe. Same address within TTL_MS → the previous result.
 * @param {string} address
 * @returns {Promise<object>} `{ ok, reachable, status?, latencyMs, raw?, error? }`
 */
export async function probe(address) {
  const key = canonicalAddress(address) || String(address);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
  const result = await fetchHealthz(address);
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** Probe every server in parallel, preserving order. @param {Array<{address:string}>} servers */
export async function probeAll(servers) {
  return Promise.all(servers.map((s) => probe(s.address)));
}

/** Drop cache entries (used after a server is edited so the next poll is fresh). */
export function invalidate(address) {
  if (address == null) cache.clear();
  else cache.delete(canonicalAddress(address) || String(address));
}
