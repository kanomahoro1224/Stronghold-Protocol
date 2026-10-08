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
// A FAILED LOCAL SAMPLE IS NOT EVIDENCE THAT THE NODE IS DOWN
// From inside the page, an adblocker, a captive portal, mixed-content blocking, a DNS hiccup and a single
// dropped request all look exactly the same as a dead node. So:
//   * a round that produced no timing at all is retried once (`ROUNDS`) before we accept `null`;
//   * when a node still has no local timing, the list page asks the SERVER for its verdict (see
//     `views/server-list.js`) and `statusFor()` below renders that instead of implying "unreachable";
//   * the mirror case counts too: when the SERVER cannot reach a node but this browser just did, the card says
//     「本机可达」 instead of 「离线无响应」 — the community server's own egress (DNS answer, blocked route, 4 s
//     timeout) is fallible in exactly the same way;
//   * consequently the ONLY thing that may paint a node as offline is the server's probe result AND the browser
//     having nothing to say.
//
// NOTE: an opaque response cannot distinguish "reached the node" from "reached some proxy". A browser that
// swallows the request yields no timing at all, in which case we return `null` and the UI falls back to
// describing the server-side reachability instead of inventing a number.

const SAMPLES = 3;
const SAMPLE_GAP_MS = 60;
/** Per-attempt cap. A node that never answers must not leave the UI spinning. */
const ATTEMPT_TIMEOUT_MS = 5000;
/** A round with no timing at all is retried once, after this pause, before we give up on the browser. */
const RETRY_GAP_MS = 400;
const ROUNDS = 2;

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
  for (let round = 0; round < ROUNDS; round += 1) {
    const samples = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const t = await once(healthz);
      if (t != null) samples.push(t);
      if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS));
    }
    const ms = median(samples);
    if (ms != null) return ms;
    if (round < ROUNDS - 1) await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
  }
  return null;
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

/** Tone suffixes the stylesheet understands, keyed by the state a node is in. */
const TONE = {
  pending: { main: 't-dim', sub: '' },
  ok: { main: 't-mint', sub: 'mint' },
  local: { main: 't-mint', sub: 'dim' },
  reachable: { main: 't-amber', sub: 'amber' },
  warn: { main: 't-amber', sub: 'amber' },
  off: { main: 't-red', sub: 'red' },
};

/**
 * What the status pill should say, given BOTH verdicts (the server's probe and this browser's timing).
 *
 * `clientMs` uses three states on purpose:
 *   `undefined` — not measured yet, `null` — measured and the browser got nothing, a number — the real figure.
 *
 * @param {{ health?: {ok?:boolean, latencyMs?:number, error?:string}|null, clientMs?: number|null, measuring?: boolean }} [input]
 * @returns {{ state:'pending'|'ok'|'local'|'reachable'|'warn'|'off', main:string, mainTone:string, sub:string|null, subTone:string, subTitle:string }}
 */
export function statusFor({ health, clientMs, measuring = false } = {}) {
  // No server verdict yet: say nothing about reachability.
  if (!health) {
    return { state: 'pending', main: '探测中…', mainTone: TONE.pending.main, sub: null, subTone: '', subTitle: '' };
  }
  const serverMs = Number.isFinite(health.latencyMs) ? Math.round(health.latencyMs) : null;

  // The server could not reach it. If THIS browser just did, the node is not down — say what we actually know,
  // because the server's own egress is fallible too (a DNS answer that changed, a blocked route, a 4 s timeout)
  // and calling a node the visitor is connected to "offline" is exactly the wrong judgement.
  if (!health.ok && clientMs != null) {
    return {
      state: 'reachable',
      main: '本机可达',
      mainTone: TONE.reachable.main,
      sub: `${health.error || '服务端探测失败'} · 本机 ${Math.round(clientMs)} ms`,
      subTone: TONE.reachable.sub,
      subTitle: '社区服务器探测该节点失败（可能是社区服务器的出口网络或 DNS 问题），但你的浏览器刚刚连通了它',
    };
  }

  // The server could not reach it — the only evidence that justifies calling a node offline.
  if (!health.ok) {
    const stale = /版本|更新/.test(health.error || '');
    return stale
      ? { state: 'warn', main: '版本待更新', mainTone: TONE.warn.main, sub: health.error || '服务端探测异常', subTone: TONE.warn.sub, subTitle: '社区服务器探测该节点时的返回' }
      : { state: 'off', main: '离线无响应', mainTone: TONE.off.main, sub: health.error || '服务端探测不可达', subTone: TONE.off.sub, subTitle: '社区服务器探测该节点时的返回' };
  }

  // The node is up (server says so). Report the player's own figure when we have one.
  if (clientMs != null) {
    return {
      state: 'local',
      main: '运行正常',
      mainTone: TONE.local.main,
      sub: `本机 ${Math.round(clientMs)} ms`,
      subTone: grade(clientMs),
      subTitle: '由你的浏览器实测到该节点的往返时间',
    };
  }

  // No local figure: fall back to the server's result instead of leaving it looking unreachable.
  return {
    state: 'ok',
    main: '运行正常',
    mainTone: TONE.ok.main,
    sub: measuring
      ? '本机测速中…'
      : (serverMs == null ? '本机未测到 · 服务端正常' : `本机未测到 · 服务端 ${serverMs} ms`),
    subTone: TONE.local.sub,
    subTitle: '你的浏览器没测到往返时间（可能被拦截或瞬时不通）；这里显示的是服务端探测该节点的结果，不是你的本机延迟',
  };
}
