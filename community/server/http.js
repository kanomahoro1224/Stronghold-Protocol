// community/server/http.js — tiny node:http toolkit: security headers, JSON/cookie helpers, static files.
// Kept deliberately framework-free to match the game server (server/http/*) — plain node:http, no deps.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** Security headers shared by every response (mirrors the game server's policy, minus the WS-only bits). */
export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // The pages import no third-party code; fonts are served locally.
  // `script-src` allows exactly one inline script — the import map in index.html — by its SHA-256 hash
  // (no 'unsafe-inline'). If that file's import map changes, recompute the hash:
  //   node -e "..." (see community/README.md) — the server will otherwise refuse it and the module graph fails.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'sha256-jlCLpiCzO1FNxwHLbWhVuGhQfa18ZX/jqpJeyPnWvME='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // `connect-src` must permit the game nodes: the list page measures player→node latency straight from
    // the browser (public/js/latency.js), which is an outbound request to whatever address an operator
    // registered. Those hosts are user data, so no fixed allowlist can work — http:/https: is the
    // narrowest rule that still allows the feature. Nothing is exfiltrated: the request is a plain
    // `no-cors` GET whose opaque response the page cannot read.
    "connect-src 'self' http: https:",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
}

/** @param {import('node:http').ServerResponse} res */
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** An API error shaped `{ error: { code, message } }` so the client can branch on `code`. */
export function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { error: { code, message } }, headers);
}

/** Parse and size-limit a JSON request body. @returns {Promise<object>} @throws {{ status:number, message:string }} */
export async function readJsonBody(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error('请求体过大 · Payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('请求体必须是 JSON 对象 · Body must be a JSON object');
      err.status = 400;
      throw err;
    }
    return parsed;
  } catch (e) {
    if (e.status) throw e;
    const err = new Error('请求体不是合法 JSON · Malformed JSON');
    err.status = 400;
    throw err;
  }
}

// ---- cookies ------------------------------------------------------------------------------------

/** @returns {Record<string,string>} */
export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path: p = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge != null) bits.push(`Max-Age=${Math.floor(maxAge)}`);
  return bits.join('; ');
}

export const clearCookie = (name) => `${name}=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0`;

// ---- static files -------------------------------------------------------------------------------

/** Resolve `urlPath` under `rootDir`, refusing traversal. @returns {string|null} */
export function safeJoin(rootDir, urlPath) {
  const decoded = (() => { try { return decodeURIComponent(urlPath); } catch { return null; } })();
  if (decoded == null || decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(rootDir, rel);
  const rootAbs = path.resolve(rootDir);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

/** Serve a file from disk with ETag/304. @returns {boolean} whether a response was sent. */
export function serveFile(req, res, absPath, { cache = 'no-cache' } = {}) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(absPath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': cache,
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(absPath).on('error', () => res.end()).pipe(res);
  return true;
}
