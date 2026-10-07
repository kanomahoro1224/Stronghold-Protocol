// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST 0.0.0.0, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB;
//                      refused at upgrade with 404 / 429 per network / 503)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser stand-in,
//                      the content packs (/packs/index.json, /packs/<id>/<file> — the registry is packs.js)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/state.js      match-state persistence (server/state/*, P0/P1): the StateBridge handed to the lobby, the boot
//                      scan that reads the persisted index back after `listen`, and /healthz.state
//   http/routes.js     the request listener: security headers, 414 / 400 / 405, GET /healthz → JSON status, else static
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT / SIGTERM
//
// Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
// (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import { getData, loadData } from './data.js';
import { ROOT, listenAddress, serveDirs, makeLogger, parseTrustProxy } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createStateBridge, runBootScan, stateStats, setStateProbe } from './http/state.js';
import { createRequestHandler } from './http/routes.js';
import { answerClientError } from './http/common.js';
import { lanUrls, isProcessEntry, runMain } from './http/boot.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy, stateStats,
};

/**
 * Process memory for `/healthz.mem`, reduced to two small numbers in MB: the resident set (what the box pays for) and
 * the used heap (what the GC will hand back). One `process.memoryUsage()` call is cheap and /healthz is polled every
 * 60 s by every open page, so nothing more verbose (no heap spaces, no external/arrayBuffers) goes over the wire.
 */
export function memStats() {
  const m = process.memoryUsage();
  const mb = (bytes) => Math.round((Number(bytes) || 0) / 1048576);
  return { rss: mb(m.rss), heap: mb(m.heapUsed) };
}

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   state?: false | { backend?: string, dir?: string, maxPending?: number, resume?: boolean },
 * }} [opts] `state` configures match-state persistence (server/http/state.js, server/state/*): omitted = the env
 *   defaults (SP_STATE, SP_STATE_DIR, SP_STATE_MAX_PENDING, SP_STATE_RESUME), `false` = off (tests keep an untouched
 *   working tree).
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPackRegistry>,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const { publicDir, dataDir, sharedDir, packsDir } = serveDirs(opts);

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz. It is also the
  // build half of the resume version gate, so it must be read before the state bridge is built.
  resetBuildTag();
  buildTag();
  // Match-state persistence (server/http/state.js, P0/P1). The bridge exists before the lobby (the lobby hands it to
  // every Match as opts.stateSink); the persisted index is only READ after `listen` below, so boot never waits for the
  // disk.
  const state = createStateBridge({ config: opts.state, log });
  setStateProbe(state);
  const { registry, lobby, network } = createSessionStack(opts, { data, log, state });
  // the TTL sweeper may never delete the record of a room this process still holds (a frozen match writes nothing)
  state.isLive = (code) => lobby.rooms.has(String(code));
  // content packs (docs/PACKS.md): scanned now — the start log names them — and again whenever their folders change
  const packs = createPackRegistry({ publicDir, dataDir, packsDir }, { log });
  packs.refresh(true);
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log });
  const startedAt = Date.now();

  const server = http.createServer(createRequestHandler({ serveStatic, health: { startedAt, network, registry, lobby, stateStats, memStats }, log }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log });

  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    try { state.close(); } catch { /* ignore */ }
    setStateProbe(null);
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  // The persisted index is read AFTER `listen` — boot never waits for the disk — and lazily: a record is only marked
  // resumable, nothing is rebuilt until a player actually comes back (server/lobby.js `rehydrate`). See
  // server/http/state.js `runBootScan` for the pacing, the cap and what the report on /healthz.state.scan carries.
  // Fire-and-forget on purpose: a shutdown must not wait for a paced directory scan.
  runBootScan({ state, opts, log });

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      // the queue's final drain (the room disposal above only ENQUEUES the record deletions) is bounded by flushMs
      try { state.close(); await state.persist?.close(); } catch (e) { log.error('[shutdown] state', e); }
      setStateProbe(null);
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  return { port: actualPort, host, url, server, wss, lobby, network, registry, packs, close };
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(startServer);
