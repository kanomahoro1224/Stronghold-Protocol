// .tools/revert-room-start-e2e.mjs — every e2e site that clicks 开始匹配 creates a 同盟模拟 room (co-op with 准备, an
// invited guest and AI fill), so its start button is 开始模拟 again: the pool now follows the card (Room.pool), and
// only a room made from the 同盟匹配 card offers 开始匹配. The AI-fill clicks in front of each site stay — that is what
// fills the room so facts.canStart is true.
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = [
  'test/ui/real.e2e.test.js',
  'test/ui/spectator.e2e.test.js',
  'test/ui/watch-bonds.e2e.test.js',
  'test/ui/teammate-loadout.e2e.test.js',
  'test/ui/playtest2.real.e2e.test.js',
];

let total = 0;
for (const f of FILES) {
  const before = readFileSync(f, 'utf8');
  const after = before.replaceAll("'.room-bar__right button', '开始匹配'", "'.room-bar__right button', '开始模拟'");
  const n = (before.match(/开始匹配/g) || []).length;
  if (after !== before) {
    writeFileSync(f, after);
    total += n;
    console.log(`  ${f}: ${n} site(s)`);
  } else {
    console.log(`  ${f}: none`);
  }
}
console.log(`  total reverted: ${total}`);
