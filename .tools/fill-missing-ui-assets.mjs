// .tools/fill-missing-ui-assets.mjs — the preload stalls at 99% because 55 manifest entries have no file anywhere:
// the 36 战斗表情 (ui/emoticon/*) and the 19 图鉴 (ui/guide/*) that the live origin (R2) does not carry either.
//
// Both groups DO exist in the local extraction under public/assets/local/<same subpath> — same names, byte-identical
// candidates for the /assets/ui/... paths the manifest asks for. This script checks that mapping (dry run) and, with
// --write, copies them into place. Nothing here is game logic: the files are ignored by git, exactly like the rest of
// public/assets, and reach the box through the deploy's asset upload.
import { readFileSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const manifest = JSON.parse(readFileSync('data/assets.json', 'utf8'));
const urls = [];
(function walk(node) {
  if (typeof node === 'string') { if (/^\/(assets|fonts)\//.test(node)) urls.push(node); }
  else if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === 'object') Object.values(node).forEach(walk);
})(manifest);

const missing = [...new Set(urls)].filter((u) => {
  const p = path.join('public', u);
  return !existsSync(p) || statSync(p).size === 0;
});

let ok = 0;
const noSource = [];
const todo = [];
for (const u of missing) {
  // /assets/ui/emoticon/basic/pic_happy_battle.png -> public/assets/local/emoticon/basic/pic_happy_battle.png
  // (the local extraction has no `ui/` level: local/<group>/<name> mirrors ui/<group>/<name>)
  const src = path.join('public', 'assets', 'local', u.replace(/^\/assets\/(ui\/)?/, ''));
  const dst = path.join('public', u);
  if (existsSync(src) && statSync(src).size > 0) {
    ok++;
    todo.push([src, dst]);
  } else {
    noSource.push(u);
  }
}

console.log(`${WRITE ? 'WRITE' : 'DRY RUN'}  manifest missing: ${missing.length}   with a local source: ${ok}   without: ${noSource.length}`);
for (const u of noSource) console.log(`  NO SOURCE  ${u}`);
const groups = new Map();
for (const [src] of todo) {
  const g = path.dirname(src).replace(/\\/g, '/');
  groups.set(g, (groups.get(g) || 0) + 1);
}
for (const [g, n] of groups) console.log(`  ${n}  ${g} -> public${g.replace('public', '').replace('assets/local', 'assets/ui')}`);

if (WRITE) {
  let copied = 0;
  for (const [src, dst] of todo) {
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied++;
  }
  console.log(`  copied ${copied} files`);
}
