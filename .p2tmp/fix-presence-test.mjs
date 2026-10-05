// .p2tmp/fix-presence-test.mjs — make test/online-presence.test.js's count() helper race-free.
// The count is pushed on connect, on hello and on close (coalesced), so a frame the socket already buffered can be
// from an earlier moment. Under a loaded machine a delayed close let such a stale frame satisfy the wait, and the
// assertion that followed it (session.connected === false) then ran too early. First wait for the server's own
// value, then for the frame.
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'F:/WeChat/Stronghold-Protocol/test/online-presence.test.js';
let src = readFileSync(p, 'utf8');

const OLD = `/**
 * Wait until this socket is told the expected number (earlier frames it saw while the count was lower are
 * skipped), then check the frame carries nothing but the aggregate.
 */
async function count(c, expected) {
  const msg = await c.waitFor('presence', (m) => m.onlineCount === expected);
  assert.deepEqual(Object.keys(msg).sort(), ['onlineCount', 't'], 'only an aggregate is exposed');
  return msg;
}`;

const NEW = `/**
 * Wait until this socket is told the expected number, after the server itself reports it: the count is pushed on
 * connect, on hello and on close (coalesced), so a frame the socket already buffered can be from an earlier moment
 * — on a loaded machine a delayed close used to let such a stale frame satisfy the wait.
 * @param {any} c @param {any} srv @param {number} expected @param {string} [message]
 */
async function count(c, srv, expected, message) {
  const deadline = Date.now() + 5000;
  while (srv.network.onlineCount !== expected) {
    if (Date.now() > deadline) throw new Error(\`\${message ?? 'presence'}: the server never reported \${expected} online (now \${srv.network.onlineCount})\`);
    await new Promise((r) => setTimeout(r, 5));
  }
  const msg = await c.waitFor('presence', (m) => m.onlineCount === expected);
  assert.deepEqual(Object.keys(msg).sort(), ['onlineCount', 't'], 'only an aggregate is exposed');
  return msg;
}`;

if (!src.includes(OLD)) throw new Error('the count() helper is not the expected revision');
src = src.replace(OLD, NEW);

const before = (src.match(/await count\(/g) || []).length;
src = src.replace(/await count\(([A-Za-z]+), (\d+)/g, 'await count($1, srv, $2');
src = src.replace(/await count\(([A-Za-z]+), (\d+), /g, 'await count($1, srv, $2, ');
const after = (src.match(/await count\([A-Za-z]+, srv, /g) || []).length;
if (before !== after) throw new Error(`call sites: ${before} found, ${after} rewritten`);
if (/await count\([A-Za-z]+, \d/.test(src)) throw new Error('a call site still lacks srv');

writeFileSync(p, src);
console.log(`ok: helper rewritten, ${after} call site(s) updated`);
