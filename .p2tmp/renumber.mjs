// .p2tmp/renumber.mjs — our matchmaking section moved from §22 to §23 (upstream master owns §22 now).
// Only files whose every §22 reference means OUR section may be rewritten wholesale.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'F:/WeChat/Stronghold-Protocol/';
const FILES = [
  'server/lobby.js',
  'public/js/screens/lobby.js',
  'public/js/main.js',
  'public/js/store.js',
  'shared/protocol.js',
  'test/lobby-matchmaking.test.js',
  'test/docs-consistency.test.js', // verified below: only line 750 keeps an upstream §22.12 ref
];

for (const f of FILES) {
  const p = ROOT + f;
  const src = readFileSync(p, 'utf8');
  const hits = [...src.matchAll(/§22(\.\d+)?/g)].map((m) => m[0]);
  const upstream = hits.filter((h) => h !== '§22');
  if (upstream.length) {
    console.log(`SKIP  ${f}: carries upstream refs ${[...new Set(upstream)].join(', ')}`);
    continue;
  }
  const out = src.replace(/§22/g, '§23');
  const n = (src.match(/§22/g) || []).length;
  writeFileSync(p, out);
  console.log(`OK    ${f}: ${n} ref(s) §22 → §23`);
}
