// .tools/fix-room-start-e2e.mjs — adapt the opt-in browser suites to the new room start rule.
//
// 同盟匹配 (user request) moved the start into the room: a co-op room's 开始匹配 sends room.matchmake, which starts the
// match at once when the alliance is FULL and otherwise puts it in the public pool. Solo rooms keep 开始模拟
// (room.start). The suites therefore need two things:
//
//   1. a solo site (`开始独立模拟` created the room) clicks 开始模拟, not 开始匹配;
//   2. a co-op site fills the empty seats with AI before the click, so 开始匹配 starts immediately — exactly the
//      "满员即自动开始" the host gets after 开始匹配 + AI 补位 in the real flow.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = 'test/ui';
const CLICK = /(\w+)\.click\('\.room-bar__right button', '开始匹配'/g;
const FILL = (v) => `for (let i = 0; i < 4; i++) await ${v}.click('button', '添加 AI 队友', { optional: true, timeout: 1500 });`;

let soloFixed = 0;
let coopFixed = 0;
const files = (await readdir(DIR)).filter((f) => f.endsWith('.e2e.test.js'));

for (const file of files) {
  const full = path.join(DIR, file);
  const src = await readFile(full, 'utf8');
  let out = '';
  let last = 0;
  let touched = false;
  for (const m of src.matchAll(CLICK)) {
    const [whole, varName] = m;
    const before = src.slice(Math.max(0, m.index - 900), m.index);
    const solo = before.includes(`${varName}.click('.create-box button', '开始独立模拟')`);
    // the line the statement starts on, so the insert keeps the file's own indentation
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const indent = src.slice(lineStart, m.index).match(/^[ \t]*/)[0];
    out += src.slice(last, lineStart);
    if (solo) {
      out += src.slice(lineStart, m.index) + whole.replace("'开始匹配'", "'开始模拟'");
      soloFixed++;
    } else {
      out += `${indent}${FILL(varName)}\n`;
      out += src.slice(lineStart, m.index) + whole;
      coopFixed++;
    }
    last = m.index + whole.length;
    touched = true;
  }
  if (touched) {
    out += src.slice(last);
    await writeFile(full, out, 'utf8');
    console.log(`  ${file}`);
  }
}
console.log(`  solo sites -> 开始模拟: ${soloFixed}`);
console.log(`  co-op sites -> AI fill first: ${coopFixed}`);
