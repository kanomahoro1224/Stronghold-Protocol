// .tools/edge-shim.mjs — local stand-in for the planned nginx rule.
//
// Same behaviour as the production config we are about to add:
//   /assets/ /fonts/ /vendor/ /media/  -> 302 to the R2 custom domain (cross-origin)
//   everything else (http + websocket) -> proxied to the local game server
//
// Used to verify in a real browser that cross-origin assets still work (CORS + WebGL textures)
// before touching the live nginx.
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.SHIM_PORT || 8899);
const UP_HOST = '127.0.0.1';
const UP_PORT = Number(process.env.SHIM_UPSTREAM_PORT || 3100);
const R2 = process.env.SHIM_R2 || 'https://local.xiaolubao.com/Stronghold-Protocol';
// Bumpable cache key. Cloudflare caches static extensions for the full max-age of the object, and we have no
// API token to purge it, so the redirect carries a version query: bumping it invalidates the whole edge cache.
// Invisible to the app — the browser follows the 302 internally, JS keeps the original same-origin URL.
const VER = process.env.SHIM_R2_VERSION || '';
// /vendor/ is deliberately NOT offloaded: js/main.js imports ../vendor/preact.module.js while
// vendor/hooks.module.js imports ./preact.module.js, and a module's relative imports resolve against the
// URL it was *served* from. Behind a redirect that is the R2 URL, so preact ends up with two module
// identities and hooks lose currentComponent ("Cannot read properties of undefined (reading '__H')").
// Vendor is ~1.6% of egress — keep it same-origin.
const PREFIXES = (process.env.SHIM_PREFIXES || '/assets/,/media/,/fonts/').split(',').filter(Boolean);
const REDIRECT_TTL = process.env.SHIM_REDIRECT_TTL || '300';
const target = (url) => R2 + url + (VER ? (url.includes('?') ? '&' : '?') + 'r2v=' + VER : '');

const redirects = [];
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (PREFIXES.some((p) => path.startsWith(p))) {
    redirects.push(req.url);
    res.writeHead(302, { Location: target(req.url), 'Cache-Control': `public, max-age=${REDIRECT_TTL}` });
    res.end();
    return;
  }
  const pr = http.request(
    { host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers: { ...req.headers, host: `${UP_HOST}:${UP_PORT}` } },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    },
  );
  pr.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('shim proxy error: ' + e.message); });
  req.pipe(pr);
});

// websocket upgrade -> plain TCP pipe to the game server
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(UP_PORT, UP_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers)) raw += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[shim] listening on http://127.0.0.1:${PORT}  upstream=${UP_HOST}:${UP_PORT}  r2=${R2}`);
});
process.on('SIGTERM', () => { console.log('[shim] redirects served:', redirects.length); process.exit(0); });
process.on('SIGINT', () => { console.log('[shim] redirects served:', redirects.length); process.exit(0); });
