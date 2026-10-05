// .p2tmp/classify.mjs — how do the pre-deploy live tree (bk04, carries the 在线人数 feature) and this repo checkout
// differ? Classify every file as mine / theirs / both, so the merge can be done file by file.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = 'F:/WeChat/Stronghold-Protocol';
const BK = 'F:/WeChat/.p2tmp/bk04';
const SKIP = new Set(['node_modules', '.git', '.p2tmp', 'assets', 'fonts', 'vendor']);

function walk(root, rel = '') {
  const out = [];
  for (const name of readdirSync(path.join(root, rel))) {
    if (SKIP.has(name)) continue;
    const r = rel ? rel + '/' + name : name;
    const full = path.join(root, r);
    if (statSync(full).isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}
const MINE = /queue\.join|MatchPanel|同盟匹配|matchQueueMax|MATCH_QUEUE|queue\.state/;
const THEIRS = /onlineCount|OnlinePill|presence/;

const bk = new Set(walk(BK));
const repo = new Set(walk(REPO));
const rows = [];
for (const f of bk) {
  const b = path.join(BK, f);
  if (!repo.has(f)) { rows.push({ f, kind: 'THEIRS-ONLY', markers: marks(readFileSync(b, 'utf8')) }); continue; }
  const a = readFileSync(path.join(REPO, f));
  const bb = readFileSync(b);
  if (a.equals(bb)) continue;
  rows.push({ f, kind: 'DIFF', markers: marks(bb.toString('utf8')), sizeA: a.length, sizeB: bb.length });
}
for (const f of repo) if (!bk.has(f)) rows.push({ f, kind: 'REPO-ONLY', markers: marks(readFileSync(path.join(REPO, f), 'utf8')) });

function marks(s) {
  return { mine: MINE.test(s), theirs: THEIRS.test(s) };
}
rows.sort((x, y) => x.kind.localeCompare(y.kind) || x.f.localeCompare(y.f));
for (const r of rows) {
  const tag = r.kind === 'DIFF' ? (r.markers.mine && r.markers.theirs ? 'DIFF BOTH ' : r.markers.theirs ? 'DIFF theirs' : r.markers.mine ? 'DIFF mine  ' : 'DIFF plain ') : r.kind.padEnd(11);
  console.log(`${tag} ${r.f}${r.sizeA ? `  (${r.sizeA} -> ${r.sizeB})` : ''}`);
}
console.log('\ncounts:', rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {}));
