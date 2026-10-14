// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) and the asset index's state for a loopback or private-network client
//     only — the maintainer's decision of 2026-10-12: the figures are the host's, so any other client, also one a
//     tunnel or proxy on this machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY
//     like the WebSocket limits);
//   * GET /metrics → the detailed JSON of docs/DEPLOY.md §5 (on demand only; /healthz is polled every 60 s);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { performance } from 'node:perf_hooks';
import { parseBotRehearsal, parseCombat, parseVerify } from '../match/Match.js';
import { WS_DEFLATE_THRESHOLD } from './websocket.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, sendJsonBody, splitUrl } from './common.js';
import { clientAddress, isLocalIp } from '../net.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null }} health
 * @param {boolean} [withTraffic]
 * @param {object} [counters] the lobby counters (the cached body reuses the ones it already read)
 * @param {string} [build]
 * @param {(() => object) | null} [memStats] RSS / used heap in MB (`server/index.js` `memStats`)
 */
export function healthReport({ startedAt, network, registry, lobby, traffic, assetIndex, views }, withTraffic = false, counters = lobby.stats(), build = buildTag(), memStats = null) {
  // `mem` is the load signal an operator reads first (RSS / used heap in MB, whole numbers, one
  // `process.memoryUsage()` per poll). Never takes /healthz down: any throw is a null.
  let mem = null;
  try { mem = typeof memStats === 'function' ? memStats() : null; } catch { mem = null; }
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    mem,
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build,
    sockets: network.connectionCount, sessions: registry.size, ...counters,
  };
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}

/** One bounded per-server snapshot. HTTP clients still receive no-store.
 * Room/queue topology changes invalidate it immediately; seat/match changes inside
 * existing rooms refresh within one second. Cheap counts and uptime remain current.
 * The monotonic expiry is independent of wall-clock corrections.
 */
export function createHealthBody(health, { now = () => performance.now(), maxAgeMs = 1000, memStats = null } = {}) {
  const { network, registry, lobby } = health;
  const build = buildTag();
  let counters = null, expiresAt = -Infinity;
  let roomCount = -1, queueMatches = -1, queuedPlayers = -1;
  let body = null, sockets = -1, sessions = -1, uptimeSec = -1;
  return () => {
    const at = now();
    const rooms = lobby.rooms.size;
    const matches = lobby.activeQueueMatches.size;
    const queued = lobby.queueByPlayer.size;
    let changed = false;
    if (!counters || at >= expiresAt || rooms !== roomCount || matches !== queueMatches || queued !== queuedPlayers) {
      counters = lobby.stats();
      expiresAt = at + maxAgeMs;
      roomCount = rooms;
      queueMatches = matches;
      queuedPlayers = queued;
      changed = true;
    }
    const currentSockets = network.connectionCount;
    const currentSessions = registry.size;
    const currentUptime = Math.round((Date.now() - health.startedAt) / 1000);
    if (!body || changed || currentSockets !== sockets || currentSessions !== sessions || currentUptime !== uptimeSec) {
      const report = healthReport(health, false, counters, build, memStats);
      // Use the values already read, including one wall-clock sample for uptime.
      report.sockets = sockets = currentSockets;
      report.sessions = sessions = currentSessions;
      report.uptimeSec = uptimeSec = currentUptime;
      body = Buffer.from(JSON.stringify(report));
    }
    return body;
  };
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], serveApi?: Function | null, diagnostics?: object,
 *           log: object, memStats?: (() => object) | null, trustProxy?: 'auto' | boolean }} deps
 *   serveApi: the public HTTP API and the name review route (server/index.js)
 *   diagnostics: the /metrics extras (persistence, workers, announcements, CDN, static cache)
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, serveApi = null, diagnostics = {}, log, memStats = null, trustProxy = 'auto' }) {
  const healthBody = createHealthBody(health, { memStats });
  function serveHealth(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    // ?traffic=1 from a loopback / private-network client gets the live report (the traffic counters and the asset
    // index's state); everyone else gets the cached body — no-store, and at most one lobby scan per second.
    if (wantsTraffic(splitUrl(url)?.query) && isLocalIp(clientAddress(req, trustProxy).ip)) {
      sendJson(req, res, 200, healthReport(health, true));
      return;
    }
    sendJsonBody(req, res, 200, healthBody());
  }
  function failed(req, res, e) {
    log.error('[http] request failed', e);
    sendError(req, res, 500, '服务器内部错误 · Internal error');
  }

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (parts.rawPath === '/healthz') { serveHealth(req, res, url); return; }
    if (serveApi && await serveApi(req, res, parts.rawPath)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/metrics') {
      const { network, lobby } = health;
      const { persister, workerPool, matchWorkerPool, announcements, wsCompression, assetsCdn, dataCdn, serveStatic } = diagnostics;
      const socketUsage = network.usage();
      sendJson(req, res, 200, {
        ...healthReport(health),
        persist: persister ? { redis: true, writes: persister.writes, checkpoints: persister.checkpointKeys.size,
          snapshotBytes: persister.encoder.seed?.bytes.byteLength || 0, workerMemory: persister.encoder.memory } : null,
        workers: workerPool?.stats() || null,
        ...(matchWorkerPool ? { matchWorkers: matchWorkerPool.stats() } : {}),
        announcements: announcements.stats(),
        // rss is process-wide (all Workers); other counters describe this main thread, in bytes.
        memory: process.memoryUsage(),
        staticCache: serveStatic.cacheStats(),
        socketBuffers: network.bufferedBytes(),
        websocket: { compression: wsCompression, threshold: WS_DEFLATE_THRESHOLD,
          diagnostics: network.diagnostics.stats() },
        assetsCdn: assetsCdn || null,
        dataCdn: dataCdn || null,
        limits: {
          maxRooms: lobby.opts.maxRooms,
          maxRoomsPerAddr: lobby.opts.maxRoomsPerAddr,
          maxMatchesPerAddr: lobby.opts.maxMatchesPerAddr,
          maxConnections: network.opts.maxConnections,
          maxConnectionsPerAddr: network.opts.maxConnectionsPerAddr,
        },
        // The engine-side knobs that decide how much CPU a match costs (docs/DEPLOY.md §3.4): env-level truth, i.e.
        // what a match adopts when startServer/the lobby do not pass an explicit option.
        tuning: {
          combat: parseCombat(process.env.SP_COMBAT),
          verify: parseVerify(process.env.SP_VERIFY),
          botRehearsal: parseBotRehearsal(process.env.SP_BOT_REHEARSAL),
        },
        // How close the busiest client network is to a cap (docs/DEPLOY.md §3.4). No addresses: /metrics is public and
        // the refusal logs (`room limit (16) reached for <ip>`) already name the network when it matters.
        usage: {
          ...lobby.usage(),
          socketNetworks: socketUsage.networks,
          worstSockets: socketUsage.worstSockets,
          overSockets: socketUsage.overSockets,
        },
      });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    // every response's body bytes count in the traffic counters (traffic.js)
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    const url = req.url || '/';
    if (url.length <= MAX_URL_LENGTH && (url === '/healthz' || url.startsWith('/healthz?') || url.startsWith('/healthz#'))) {
      try { serveHealth(req, res, url); } catch (e) { failed(req, res, e); }
      return;
    }
    handleRequest(req, res).catch((e) => failed(req, res, e));
  };
}
