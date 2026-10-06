// The room's host button was renamed 开始模拟 → 开始匹配; the browser suites click it by its label.
// Only the room-bar clicks are touched: `.room-bar__right button` + the old label, nothing else.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'test/ui');
const OLD = `'.room-bar__right button', '开始模拟'`;
const NEW = `'.room-bar__right button', '开始匹配'`;

let files = 0;
let hits = 0;
for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.e2e.test.js')) continue;
  const p = path.join(DIR, name);
  const src = readFileSync(p, 'utf8');
  const n = src.split(OLD).length - 1;
  if (!n) continue;
  writeFileSync(p, src.split(OLD).join(NEW));
  files += 1;
  hits += n;
  console.log(`  ${name}: ${n}`);
}
console.log(`  total: ${hits} clicks in ${files} files`);
