// .p2tmp/merge8.mjs — three-way merge for the files both lineages touched.
//   mine   = this repo's 0.1.2 working state (matchmaking), from the pre-restore snapshot
//   base   = HEAD (their tree differs from HEAD only by their presence work, verified by diff)
//   theirs = the live 06:04 tree (presence / 在线人数)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = 'F:/WeChat/Stronghold-Protocol';
const MINE = 'F:/WeChat/.p2tmp/mine012';
const THEIRS = 'F:/WeChat/.p2tmp/bk04';
const TMP = 'F:/WeChat/.p2tmp/merge';

const FILES = [
  'README.md',
  'docs/DESIGN.md',
  'public/css/screens/lobby.css',
  'public/js/main.js',
  'public/js/screens/lobby.js',
  'public/js/store.js',
  'server/index.js',
  'shared/protocol.js',
];

mkdirSync(path.join(TMP, 'base'), { recursive: true });
mkdirSync(path.join(TMP, 'out'), { recursive: true });
mkdirSync(path.join(TMP, 'mine'), { recursive: true });
mkdirSync(path.join(TMP, 'theirs'), { recursive: true });

let conflicts = 0;
for (const f of FILES) {
  // base from the object store, byte-exact
  const base = execFileSync('git', ['show', `HEAD:${f}`], { cwd: REPO, maxBuffer: 1 << 28 });
  writeFileSync(path.join(TMP, 'base', path.basename(f)), base);
  writeFileSync(path.join(TMP, 'mine', path.basename(f)), readFileSync(path.join(MINE, f)));
  writeFileSync(path.join(TMP, 'theirs', path.basename(f)), readFileSync(path.join(THEIRS, f)));

  let out = '';
  let code = 0;
  try {
    out = execFileSync('git', ['merge-file', '-p',
      path.join(TMP, 'mine', path.basename(f)),
      path.join(TMP, 'base', path.basename(f)),
      path.join(TMP, 'theirs', path.basename(f))],
    { maxBuffer: 1 << 28 }).toString('utf8');
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout ?? Buffer.alloc(0)).toString('utf8');
  }
  writeFileSync(path.join(TMP, 'out', f.replace(/\//g, '__')), out);
  const marks = (out.match(/^<{7}|^={7}|^>{7}/gm) || []).length;
  if (code !== 0 || marks) conflicts++;
  console.log(`${code === 0 && !marks ? 'CLEAN   ' : 'CONFLICT'} ${f}  out=${out.length}b conflictMarks=${marks}`);
}

// their version of a file both sides touched but where merging is trivially "take mine" (e.g. README badge)
console.log('\n--- files present in both, not merged here (verify by hand) ---');
for (const f of ['CHANGELOG.md', 'package.json', 'package-lock.json', 'shared/constants.js', 'public/css/devices.css',
  'test/docs-consistency.test.js', 'tools/assets/fonts.mjs', 'server/lobby.js', 'public/css/screens/title.css']) {
  const a = readFileSync(path.join(MINE, f));
  const b = readFileSync(path.join(THEIRS, f));
  console.log(`  ${f}: mine=${a.length}b theirs=${b.length}b identical=${a.equals(b)}`);
}
console.log('\nconflicts:', conflicts);
