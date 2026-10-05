// .p2tmp/fix-presence-test2.mjs — the Promise.all(...) call sites have no leading `await`, so the first pass missed them.
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'F:/WeChat/Stronghold-Protocol/test/online-presence.test.js';
let src = readFileSync(p, 'utf8');
const before = (src.match(/count\(/g) || []).length;
src = src.replace(/(?<!function )count\(([A-Za-z]+), (\d+)/g, 'count($1, srv, $2');
const bad = src.match(/count\([A-Za-z]+, \d/g) || [];
if (bad.length) throw new Error(`still missing srv: ${bad.join(', ')}`);
writeFileSync(p, src);
console.log(`ok: ${before} count( occurrences, remaining bare call sites: ${bad.length}`);
