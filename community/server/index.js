// community/server/index.js — process entry. A standalone companion service for the game server:
//
//   community/server/db.js      SQLite store (servers / accounts / sessions) + password hashing
//   community/server/auth.js    sessions, login, admin guard, password policy
//   community/server/probe.js   cached /healthz probing of every registered game node
//   community/server/api.js     the /api/* JSON surface
//   community/server/http.js    security headers, JSON/cookies, static files
//   community/public/**         the UI (Preact + htm, same stack & theme as the game client)
//
// Why separate from server/index.js: the game server is a GET/HEAD-only static + WebSocket host with a
// documented module flow (server/http/*). The community site needs POST/PUT/DELETE, a SQLite store and an
// admin console, so it runs as its own process on its own port and consumes the game nodes' /healthz.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase, ROOT as SERVICE_ROOT } from './db.js';
import { createApi } from './api.js';
import { setSecurityHeaders, sendError, safeJoin, serveFile, sendJson } from './http.js';
import { seedIfEmpty } from './seed.js';

const PUBLIC_DIR = path.join(SERVICE_ROOT, 'public');
export { SERVICE_ROOT, PUBLIC_DIR };

function makeLogger(quiet) {
  if (quiet) return { info() {}, warn() {}, error() {}, debug() {} };
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}

/** Which host to bind and port to use (PORT/HOST env, else 3100 on 0.0.0.0). */
function listenAddress(opts) {
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 3100);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  return { port, host };
}

/**
 * Build and start the community service.
 * @param {{ port?:number, host?:string, quiet?:boolean, log?:object, dbFile?:string, seed?:boolean }} [opts]
 */
export async function startCommunity(opts = {}) {
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const secure = process.env.SP_COMMUNITY_INSECURE_COOKIE !== '1' && process.env.NODE_ENV === 'production';

  const db = openDatabase({ file: opts.dbFile });
  if (opts.seed !== false) {
    const created = seedIfEmpty(db, log);
    if (created) log.info('[community] 已写入初始示例数据（可在后台删除）');
  }

  const handleApi = createApi({ db, secure });

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    let url;
    try { url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); }
    catch { sendError(res, 400, 'BAD_URL', '请求地址无效'); return; }

    try {
      // API first
      if (await handleApi(req, res, url, { log })) return;

      // method gate for the static surface
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
        return;
      }

      // /healthz of our own service (monitoring parity with the game server)
      if (url.pathname === '/healthz') {
        const counts = {
          servers: db.prepare('SELECT COUNT(*) AS n FROM servers').get().n,
          accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
        };
        sendJson(res, 200, { ok: true, app: 'stronghold-community', version: '0.1.0', uptimeSec: Math.round((Date.now() - startedAt) / 1000), ...counts });
        return;
      }

      // static files under public/
      const abs = safeJoin(PUBLIC_DIR, url.pathname);
      if (abs && serveFile(req, res, abs)) return;

      // SPA fallback: extension-less paths render index.html so /admin works on a hard refresh
      if (!path.extname(url.pathname)) {
        const index = path.join(PUBLIC_DIR, 'index.html');
        if (fs.existsSync(index) && serveFile(req, res, index)) return;
      }

      sendError(res, 404, 'NOT_FOUND', '页面不存在');
    } catch (e) {
      log.error('[community] request failed', e);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务器内部错误');
      else try { res.end(); } catch { /* ignore */ }
    }
  });

  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  server.on('error', (e) => log.error('[community] server error', e));

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;

  return {
    port: actualPort, host, url: `http://${display}:${actualPort}`, server, db,
    close: () => new Promise((resolve) => {
      server.close(() => { try { db.close(); } catch { /* ignore */ } resolve(); });
      server.closeIdleConnections?.();
    }),
  };
}

// `node community/server/index.js` / npm start in community/
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const banner = (u) => {
    console.log('');
    console.log('  ▗▄▖ 卫戍协议 · 社区站点');
    console.log(`  ▝▜▌  前台   ${u}/`);
    console.log(`   ▐▌  后台   ${u}/admin`);
    console.log(`       状态   ${u}/healthz`);
    console.log('');
  };
  startCommunity()
    .then((srv) => {
      banner(srv.url);
      let closing = false;
      const stop = async () => {
        if (closing) return; closing = true;
        console.log('\n[community] 正在关闭…');
        await srv.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      console.error('[community] 启动失败', e);
      process.exit(1);
    });
}
