// .tools/missing-assets.mjs — which manifest entries have no file on disk (the preload's 99%).
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(readFileSync('data/assets.json', 'utf8'));
const urls = [];
(function walk(node) {
  if (typeof node === 'string') { if (/^\/(assets|fonts)\//.test(node)) urls.push(node); }
  else if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === 'object') Object.values(node).forEach(walk);
})(manifest);

const all = [...new Set(urls)];
const missing = all.filter((u) => {
  const p = path.join('public', u);
  return !existsSync(p) || statSync(p).size === 0;
});

const groups = new Map();
for (const u of missing) {
  const g = u.split('/').slice(0, 4).join('/');
  groups.set(g, (groups.get(g) || 0) + 1);
}
console.log(`manifest urls: ${all.length}   missing on disk: ${missing.length}`);
console.log('--- by group ---');
for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${g}`);
console.log('--- the missing files ---');
for (const u of missing) console.log(`  ${u}`);
