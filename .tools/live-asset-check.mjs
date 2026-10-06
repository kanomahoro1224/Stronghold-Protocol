// .tools/live-asset-check.mjs — does the live origin serve what data/assets.json lists?
// Prints one line per sampled path; the 55 files nothing ships should be the only 404s.
import { readFileSync } from 'node:fs';

const HOSTS = ['https://game.xiaolubao.com', 'https://local.xiaolubao.com'];
const manifest = JSON.parse(readFileSync('data/assets.json', 'utf8'));

// pick real manifest paths, one per interesting area
const pick = [];
const push = (u) => { if (typeof u === 'string' && u.startsWith('/assets/') && !pick.includes(u)) pick.push(u); };
const charIds = Object.keys(manifest.chars).slice(0, 2);
for (const id of charIds) { push(manifest.chars[id].avatar); push(manifest.chars[id].portrait); }
for (const k of ['emoticon/basic/pic_happy_battle', 'guide/autochess_home_1']) {
  const v = manifest.ui?.[k];
  if (v) push(typeof v === 'string' ? v : v.path || Object.values(v)[0]);
}
const bgm = manifest.audio?.bgm;
if (bgm) push(typeof bgm === 'string' ? bgm : Object.values(bgm)[0]);
const voice = manifest.audio?.voice;
if (voice) { const first = Object.values(voice)[0]; push(typeof first === 'string' ? first : Object.values(first || {})[0]); }
for (const u of ['/assets/ui/hudPanel/bg_battle.png']) push(u);

// plus the exact files this session copied in
for (const u of ['/assets/ui/emoticon/basic/pic_happy_battle.png', '/assets/ui/guide/autochess_home_1.png']) push(u);

console.log(`sampled ${pick.length} manifest paths`);
for (const u of pick) {
  const line = [];
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + u, { method: 'HEAD' });
      line.push(`${new URL(h).hostname}=${r.status}`);
    } catch (e) { line.push(`${new URL(h).hostname}=ERR`); }
  }
  console.log(`  ${line.join('  ')}  ${u}`);
}
