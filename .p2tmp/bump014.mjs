// .p2tmp/bump014.mjs — set the version to 0.1.4 in the four places the project keeps it. Written as a script because
// PowerShell's Set-Content re-encoded the UTF-8 files and mangled the Chinese text.
import { readFileSync, writeFileSync } from 'node:fs';

const EDITS = [
  ['package.json', [['"version": "0.1.3"', '"version": "0.1.4"']]],
  ['package-lock.json', [['"version": "0.1.3"', '"version": "0.1.4"']]],
  ['shared/constants.js', [["export const APP_VERSION = '0.1.3';", "export const APP_VERSION = '0.1.4';"]]],
  ['README.md', [
    ['badge/version-0.1.3-', 'badge/version-0.1.4-'],
    ['- 当前版本 0.1.3：', '- 当前版本 0.1.4：'],
    ['最新版本（v0.1.3）', '最新版本（v0.1.4）'],
  ]],
];

for (const [file, pairs] of EDITS) {
  let text = readFileSync(file, 'utf8');
  let touched = 0;
  for (const [from, to] of pairs) {
    const n = text.split(from).length - 1;
    if (n === 0) continue;
    text = text.split(from).join(to);
    touched += n;
  }
  writeFileSync(file, text, 'utf8');
  console.log(`${file}: ${touched} replacement(s)`);
}
