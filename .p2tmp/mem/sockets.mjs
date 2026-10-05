// Socket/session/room plane of the real server, measured with clients in a SEPARATE process (their objects must not
// land in this process's heap). Run: node --expose-gc .p2tmp/mem/sockets.mjs [N]
import { spawn } from 'node:child_process';
import { startServer } from '../../server/index.js';
import { pinned, diff, line, mb } from './snap.mjs';

const N = Number(process.argv[2]) || 120;
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, log: { info() {}, warn() {}, error() {}, debug() {} } });
console.log(`local server on ${srv.url} (pid ${process.pid})`);
const base = await pinned();
console.log(`baseline (server up, 0 clients): heapUsed ${mb(base.heapUsed)} heapTotal ${mb(base.heapTotal)} rss ${mb(base.rss)} MB`);

const child = spawn(process.execPath, ['.p2tmp/mem/sockclients.mjs', String(srv.port), String(N)], { stdio: ['ignore', 'pipe', 'inherit'] });
let ready = null;
child.stdout.on('data', (d) => {
  const s = String(d);
  for (const lineTxt of s.trim().split('\n')) console.log(`  [clients] ${lineTxt}`);
  const m = /ready (\d+) conns (\d+) rooms/.exec(s);
  if (m) ready = { conns: Number(m[1]), rooms: Number(m[2]) };
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('clients did not report ready')), 60_000);
  const iv = setInterval(() => { if (ready) { clearTimeout(t); clearInterval(iv); res(); } }, 100);
});
await new Promise((r) => setTimeout(r, 1500)); // let the welcome/room.state frames drain
const withClients = await pinned();
line(`server after ${ready.conns} connections (${ready.rooms} rooms)`, diff(base, withClients), N);
console.log(`  abs: heapUsed ${mb(withClients.heapUsed)} heapTotal ${mb(withClients.heapTotal)} external ${mb(withClients.external)} rss ${mb(withClients.rss)} MB`);
console.log(`  per connection: heap ${Math.round(diff(base, withClients).heapUsed / ready.conns)} B, rss ${Math.round(diff(base, withClients).rss / ready.conns)} B`);
console.log(`  lobby stats: ${JSON.stringify(srv.lobby.stats())}`);

// what ONE room costs beyond its two connections: create a second batch of rooms with 1 human each
console.log('\n--- server-side objects only, one more batch of solo rooms ---');
const soloBefore = srv.lobby.stats();
const child2 = spawn(process.execPath, ['.p2tmp/mem/sockclients.mjs', String(srv.port), '40', 'solo'], { stdio: ['ignore', 'pipe', 'inherit'] });
let ready2 = null;
child2.stdout.on('data', (d) => {
  const s = String(d);
  for (const lineTxt of s.trim().split('\n')) console.log(`  [clients2] ${lineTxt}`);
  const m = /ready (\d+) conns (\d+) rooms/.exec(s);
  if (m) ready2 = { conns: Number(m[1]), rooms: Number(m[2]) };
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('second client batch did not report ready')), 60_000);
  const iv = setInterval(() => { if (ready2) { clearTimeout(t); clearInterval(iv); res(); } }, 100);
});
await new Promise((r) => setTimeout(r, 1000));
const solo = await pinned();
line('after 40 more solo connections/rooms', diff(withClients, solo), 40);
console.log(`  lobby stats: ${JSON.stringify(srv.lobby.stats())} (was ${JSON.stringify(soloBefore)})`);

child.kill(); child2.kill();
await new Promise((r) => setTimeout(r, 500));
const afterClose = await pinned();
console.log(`\nafter clients gone: heapUsed ${mb(afterClose.heapUsed)} rss ${mb(afterClose.rss)} MB (rss gave back ${mb(solo.rss - afterClose.rss)} of ${mb(solo.rss - base.rss)} MB)`);
await srv.close();
process.exit(0);
