// community/server/probe.js — live status probing for registered game servers.
//
// The list page must show each server's real-time state. We poll `<address>/healthz` (the game server's own
// status route, server/http/routes.js) rather than trusting anything stored in the DB.
//
// Design notes:
//   * Results are cached (TTL_MS default 10 s for a good answer, FAILED_TTL_MS default 30 s for a bad one) and
//     deduplicated by address, so N pages showing the same server cost one upstream request per window — a
//     community list must never hammer the game boxes, and one dead node must not drag every poll to the limit.
//   * A transport failure is retried: **three attempts**, and only all three failing paints a node as
//     unreachable (the user's rule: 超时一般不会三次都超时，只有三次都超时才判不正常). HTTP-layer answers are
//     final and never retried. The whole probe still fits in TOTAL_BUDGET_MS so the API cannot hang.
//   * Timeouts are bounded, the body is capped, and one dropped packet or one bad DNS answer must not paint a
//     node as offline (the player-facing status fallback in public/js/latency.js relies on our verdict being
//     right).
//   * The raw JSON is preserved verbatim (`raw`) so the list page can render the FULL healthz payload, which is
//     what the user asked for — we do not trim fields.
//   * https certificates: game nodes are frequently self-signed / behind a tunnel / reached through a name the
//     certificate was not issued for (the HK node answers on t44.sjcmc.cn:34046 with a *.kafuno.cn cert), so
//     TLS verification is relaxed ONLY here, and only for the probe. A red "offline" caused by a certificate
//     NAME is a worse failure than not validating the certificate of a node we already trust.
//   * Requests go through node:http/node:https rather than fetch precisely because the relaxation above has to
//     be per-request: fetch's dispatcher would need undici, and this app stays dependency-free.

import http from 'node:http';
import https from 'node:https';

const TTL_MS = Number(process.env.SP_COMMUNITY_PROBE_TTL_MS || 10_000);
/** 第 1 次尝试的超时。 */
const TIMEOUT_MS = Number(process.env.SP_COMMUNITY_PROBE_TIMEOUT_MS || 5_000);
/** 第 2、3 次尝试的超时（重试要快，但机会要给足）。 */
const RETRY_TIMEOUT_MS = Number(process.env.SP_COMMUNITY_PROBE_RETRY_TIMEOUT_MS || 2_500);
/** 尝试次数：用户明确要求「超时一般不会三次都超时，只有三次都超时才判不正常」⇒ 3 次，不是 2 次。 */
const ATTEMPTS = Number(process.env.SP_COMMUNITY_PROBE_ATTEMPTS || 3);
/** 三次尝试加起来的总预算，别让一个死节点把 /api/servers 拖住。 */
const TOTAL_BUDGET_MS = Number(process.env.SP_COMMUNITY_PROBE_BUDGET_MS || 10_000);
/** 失败结果的缓存比成功结果久：真不通的节点不该让每 10 秒一次的轮询都耗满预算。 */
const FAILED_TTL_MS = Number(process.env.SP_COMMUNITY_PROBE_FAILED_TTL_MS || 30_000);
const MAX_BODY = 64 * 1024;
const USER_AGENT = 'stronghold-community-probe/0.1';
const REDIRECTS = [301, 302, 303, 307, 308];

/** @type {Map<string, { at:number, result:object, ttl:number }>} */
const cache = new Map();
/** 同一地址同时只允许一次探测在飞（轮询重叠时复用同一份结果，不叠加请求）。 @type {Map<string, Promise<object>>} */
const inflight = new Map();

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

/**
 * One GET with a hard deadline. Certificate verification is deliberately off for https (see the header).
 * @returns {Promise<{ status:number, headers:object, body:string }>}
 */
function requestOnce(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isTls = url.protocol === 'https:';
    const req = (isTls ? https : http).request(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      ...(isTls ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size >= MAX_BODY) return; // 超出上限的部分直接丢，不缓存
        size += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).slice(0, MAX_BODY).toString('utf8'),
      }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('probe timeout')), timeoutMs);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/** GET following up to 3 redirects, all within one deadline. */
async function getFollowing(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current = url;
  let res = null;
  for (let hop = 0; hop <= 3; hop += 1) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('probe timeout');
    res = await requestOnce(current, left);
    const loc = res.headers && res.headers.location;
    if (!REDIRECTS.includes(res.status) || !loc) return res;
    current = new URL(loc, current);
  }
  return res;
}

/** @param {string} address @returns {Promise<object>} the parsed healthz JSON */
async function fetchHealthz(address) {
  const base = normalizeAddress(address);
  if (!base) return { ok: false, reachable: false, attempts: 0, error: '地址无效 · invalid address' };
  const url = new URL('healthz', base);
  const startedAll = Date.now();
  let attempts = 0;
  let last = { ok: false, reachable: false, attempts: 0, latencyMs: TIMEOUT_MS, error: '无法连接 · unreachable' };
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const left = TOTAL_BUDGET_MS - (Date.now() - startedAll);
    if (left <= 0) break;
    const budget = Math.min(attempt === 0 ? TIMEOUT_MS : RETRY_TIMEOUT_MS, left);
    const started = Date.now();
    attempts = attempt + 1;
    try {
      const res = await getFollowing(url, budget);
      const latencyMs = Date.now() - started;
      let json = null;
      try { json = JSON.parse(res.body); } catch { /* non-JSON body */ }
      const ok = res.status >= 200 && res.status < 300;
      if (!ok || !json) {
        // HTTP 层已经有明确结论（服务在，只是不满意），重试改变不了它，直接返回。
        return { ok: false, reachable: ok, status: res.status, latencyMs, attempts, error: json ? null : '响应不是 JSON · non-JSON body' };
      }
      return { ok: true, reachable: true, status: res.status, latencyMs, attempts, raw: json };
    } catch (e) {
      // 只有「压根没连上/超时」才重试：DNS 抖动、瞬时丢包不该一两次定生死（三次都超时才判不正常）。
      const latencyMs = Date.now() - started;
      const timedOut = /timeout/i.test(String(e?.message || '')) || e?.code === 'ETIMEDOUT' || e?.code === 'UND_ERR_CONNECT_TIMEOUT';
      last = { ok: false, reachable: false, attempts, latencyMs, error: timedOut ? '探测超时 · timeout' : '无法连接 · unreachable' };
    }
  }
  return last;
}

/**
 * Cached probe. Same address within TTL_MS → the previous result.
 * @param {string} address
 * @returns {Promise<object>} `{ ok, reachable, status?, latencyMs, raw?, error? }`
 */
export async function probe(address) {
  const key = canonicalAddress(address) || String(address);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;
  // 同地址并发复用一次探测：轮询重叠时不会叠加请求，也不会让同一节点被并行探多次。
  const running = inflight.get(key);
  if (running) return running;
  const run = (async () => {
    const result = await fetchHealthz(address);
    // 期间若被 invalidate（管理员改了地址）或已被更新的探测取代，就不要把旧结论钉回缓存。
    if (inflight.get(key) === run) cache.set(key, { at: Date.now(), result, ttl: result.ok ? TTL_MS : FAILED_TTL_MS });
    return result;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    if (inflight.get(key) === run) inflight.delete(key);
  }
}

/** Probe every server in parallel, preserving order. @param {Array<{address:string}>} servers */
export async function probeAll(servers) {
  return Promise.all(servers.map((s) => probe(s.address)));
}

/** Drop cache entries (used after a server is edited so the next poll is fresh). */
export function invalidate(address) {
  if (address == null) { cache.clear(); inflight.clear(); return; }
  const key = canonicalAddress(address) || String(address);
  cache.delete(key);
  inflight.delete(key);
}
