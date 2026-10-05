// Fixed terms: bare node, server modules, the data/*.json singleton, and a booted (empty) server.
//   node --expose-gc .p2tmp/mem/baseline.mjs
import { pinned, diff, line, mb } from './snap.mjs';

const s0 = await pinned();
console.log(`A. bare node (this script only):        heapUsed ${mb(s0.heapUsed)} heapTotal ${mb(s0.heapTotal)} rss ${mb(s0.rss)} MB`);

const data = await import('../../server/data.js');
const s1 = await pinned();
line('B. + server/data.js module', diff(s0, s1), 1);
console.log(`   abs: heapUsed ${mb(s1.heapUsed)} rss ${mb(s1.rss)} MB`);

const D = data.getData({ log: { warn() {}, error() {}, info() {} } });
const s2 = await pinned();
line('C. + data/*.json parsed + deep-frozen (18 files, 4.15 MB on disk)', diff(s1, s2), 1);
console.log(`   abs: heapUsed ${mb(s2.heapUsed)} rss ${mb(s2.rss)} MB`);

const idx = await import('../../server/index.js');
const s3 = await pinned();
line('D. + server/index.js module graph (all server/**)', diff(s2, s3), 1);
console.log(`   abs: heapUsed ${mb(s3.heapUsed)} rss ${mb(s3.rss)} MB`);

const srv = await import('../../server/index.js').then((m) => m.startServer({ port: 0, host: '127.0.0.1', quiet: true, log: { info() {}, warn() {}, error() {}, debug() {} } }));
const s4 = await pinned();
line('E. + booted empty HTTP+WS server (lobby, net, static handler)', diff(s3, s4), 1);
console.log(`   abs: heapUsed ${mb(s4.heapUsed)} heapTotal ${mb(s4.heapTotal)} rss ${mb(s4.rss)} MB`);
console.log(`   => fixed baseline a live box pays before any room exists: RSS ${mb(s4.rss)} MB, live heap ${mb(s4.heapUsed)} MB`);
console.log(`   heapTotal:heapUsed = ${(s4.heapTotal / s4.heapUsed).toFixed(2)}, rss:heapUsed = ${(s4.rss / s4.heapUsed).toFixed(2)}`);
console.log(`   lobby stats: ${JSON.stringify(srv.lobby.stats())}`);
void idx;
await srv.close();
process.exit(0);
