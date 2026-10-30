import { length } from '../helpers/css-values.js';
// Node/vnode + CSS-contract regressions; not a browser/real-device layout test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import {
  BondPanel, BandPanel, EnemyPanel,
  enemyGrade, codexEnemies, bossEnemyKeys,
} from '../../public/js/screens/sweep.js';
import { data } from '../../public/js/data.js';
import { loadoutStore, closeLoadout } from '../../public/js/ui/loadoutSync.js';
import { AchievementView } from '../../public/js/ui/achievements.js';
import { achievementStats } from '../../public/js/ui/achievementModel.js';

// S.W.E.E.P.报告 (screens/sweep.js) after the 2026-10-29 ruling: the report and the enemy codex are the upstream
// v0.3.3 full-screen Modals (ui/components.js Modal: focus trap, Esc, focus restored), while this branch keeps two
// of its own behaviours — the lobby still loads the screen on demand (`import('./sweep.js')`, test/vite.test.js's
// dynamic-entry assertion) and a bond member still opens the existing 干员调配 over the report. The letter grades
// are the official handbook bands from data/factions.json `handbookLevels`, not a local scale.

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
before(async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(read(`data/${String(url).split('/').pop()}`)) });
  try { await data.loadAll('bonds', 'bands', 'bosses', 'factions', 'enemies', 'chess', 'assets', 'local', 'backups', 'effects', 'garrisons'); }
  finally { globalThis.fetch = saved; }
});

function* walk(v) {
  if (Array.isArray(v)) { for (const child of v) yield* walk(child); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const text = (v) => v == null || typeof v === 'boolean' ? '' : typeof v !== 'object' ? String(v)
  : Array.isArray(v) ? v.map(text).join('') : text(v.props?.children);
const has = (v, cls) => String(v.props?.class || '').split(/\s+/).includes(cls);
const find = (v, predicate) => [...walk(v)].find(predicate);

// Read the generated table straight from disk: `data.get` is only populated inside the before() hook below.
const LEVELS = JSON.parse(read('data/factions.json')).handbookLevels;
const STATS = ['maxHp', 'atk', 'def', 'res', 'moveSpeed', 'interval', 'elementRes', 'elementDmgRes'];

test('handbookLevels: the official ten grades, weakest first, each stat a [min, max) band that meets the next', () => {
  assert.deepEqual(LEVELS.map((l) => l.level), ['E', 'D', 'C', 'B', 'B+', 'A', 'A+', 'S', 'S+', 'SS']);
  for (const l of LEVELS) for (const k of STATS) assert.ok(Array.isArray(l[k]) && l[k].length === 2, `${l.level} ${k}`);
  for (const k of STATS) {
    const bands = LEVELS.map((l) => l[k]);
    if (k === 'interval') {
      // shorter is stronger: SS starts at 0, E is open-ended
      assert.equal(bands.at(-1)[0], 0);
      assert.equal(bands[0][1], null);
      for (let i = 1; i < bands.length; i++) assert.equal(bands[i][1], bands[i - 1][0], `${k} ${LEVELS[i].level}`);
    } else {
      assert.equal(bands[0][0], 0);
      assert.equal(bands.at(-1)[1], null);
      for (let i = 1; i < bands.length; i++) assert.equal(bands[i][0], bands[i - 1][1], `${k} ${LEVELS[i].level}`);
    }
  }
  // spot checks against the table (enemy_handbook_table.json levelInfoList)
  assert.deepEqual(LEVELS.find((l) => l.level === 'B').maxHp, [5000, 8000]);
  assert.deepEqual(LEVELS.find((l) => l.level === 'A+').def, [1200, 2000]);
  assert.deepEqual(LEVELS.find((l) => l.level === 'S+').interval, [0.5, 0.8]);
});

test('enemyGrade: the band a value falls in; an edge starts the next band; the interval runs the other way', () => {
  assert.equal(enemyGrade('maxHp', 999, LEVELS), 'E');
  assert.equal(enemyGrade('maxHp', 1000, LEVELS), 'D');
  assert.equal(enemyGrade('maxHp', 7999, LEVELS), 'B');
  assert.equal(enemyGrade('maxHp', 500000, LEVELS), 'SS');
  assert.equal(enemyGrade('atk', 0, LEVELS), 'E');
  assert.equal(enemyGrade('res', 50, LEVELS), 'A');
  assert.equal(enemyGrade('moveSpeed', 1.9, LEVELS), 'S+');
  assert.equal(enemyGrade('interval', 0.4, LEVELS), 'SS');
  assert.equal(enemyGrade('interval', 1.7, LEVELS), 'B+');
  assert.equal(enemyGrade('interval', 9, LEVELS), 'E');
  assert.equal(enemyGrade('atk', null, LEVELS), '—', 'never attacks');
  assert.equal(enemyGrade('moveSpeed', undefined, LEVELS), '—');
  assert.equal(enemyGrade('atk', -5, LEVELS), '—', 'in no band');
  assert.equal(enemyGrade('atk', 300, null), '—', 'no table loaded');
  assert.equal(enemyGrade('atk', 300, 'nope'), '—', 'a table that is not a list');
  // the default is `data.get('factions')?.handbookLevels`: omitting the argument (or passing undefined, which is the
  // same thing) uses the installed table, so the loaded case is asserted instead of a missing one.
  assert.equal(enemyGrade('atk', 300), 'C');
  assert.equal(enemyGrade('nope', 300, LEVELS), '—');
});

test("enemyGrade grades every codex enemy's numbers (no gaps in the table)", () => {
  for (const e of codexEnemies(data.list('enemies') || [])) {
    for (const k of ['maxHp', 'atk', 'def', 'res', 'elementRes', 'elementDmgRes']) {
      const v = e.stats?.[k] ?? 0;
      assert.notEqual(enemyGrade(k, v, LEVELS), '—', `${e.key} ${k}=${v}`);
    }
  }
});

test('codexEnemies: one per 图鉴 number, no summon-only enemy; bossEnemyKeys: the leader, then its escorts', () => {
  const list = codexEnemies(data.list('enemies') || []);
  assert.ok(list.length > 50);
  assert.ok(list.every((e) => !e.tokenOnly));
  const ids = list.map((e) => (e.handbookIndex ? `${e.handbookIndex}|${e.name}` : e.key));
  assert.equal(new Set(ids).size, ids.length);
  const boss = { enemyKey: 'a', escortsByTemplate: { t1: [{ key: 'b' }, { key: 'a' }], t2: [{ key: 'c' }, null] } };
  assert.deepEqual(bossEnemyKeys(boss), ['a', 'b', 'c']);
  assert.deepEqual(bossEnemyKeys(null), []);
  assert.deepEqual(codexEnemies(null), []);
  // real installed data: a leader's keys start with its own enemy and cover every escort
  const real = data.list('bosses').find((b) => !b.hidden);
  const keys = bossEnemyKeys(real);
  assert.equal(keys[0], real.enemyKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const group of Object.values(real.escortsByTemplate)) for (const e of group) assert.ok(keys.includes(e.key));
});

test('bond report shows actual members/thresholds, ownership and opens the selected operator in the existing loadout', () => {
  const bond = data.list('bonds').find((b) => b.visibleMembers?.length);
  const id = bond.visibleMembers[0];
  const tree = BondPanel({ bond, m: null, notOwned: [id] });
  assert.match(text(tree), /激活所需人数/);
  assert.ok(text(tree).includes(bond.thresholds.join(' / ')));
  const member = find(tree, (v) => v.type === 'button' && v.key === id);
  assert.ok(member, 'the real data member is offered');
  assert.ok(has(member, 'is-standin'));
  const old = loadoutStore.get(), entries = JSON.stringify(old.entries);
  try {
    member.props.onClick();
    assert.equal(loadoutStore.get().open, true);
    assert.equal(loadoutStore.get().from, 'sweep');
    assert.equal(loadoutStore.get().sel, id);
    assert.equal(loadoutStore.get().tab, 'loadout');
    assert.equal(JSON.stringify(loadoutStore.get().entries), entries, 'viewing a member does not edit settings');
    closeLoadout();
  } finally { loadoutStore.set(old); }
  assert.match(read('public/js/screens/loadout.js'), /useState\(\(\) => st\.from === 'sweep' && !!st\.sel\)/);
});

test('strategy report reads the installed LP/effect/mode data and does not derive new gameplay values', () => {
  const band = data.list('bands').find((b) => b.modeTypeList.includes('SINGLE') && b.modeTypeList.includes('MULTI'));
  const tree = BandPanel({ band, m: null });
  assert.ok(text(tree).includes(String(band.totalHp)));
  assert.match(text(tree), /独立模拟.*同盟模拟/);
  const effect = find(tree, (v) => v.props?.text === (band.descRaw || band.desc));
  assert.ok(effect);
  assert.equal(find(tree, (v) => v.type?.name === 'Hero').props.name, band.name);
});

test('boss/escort and training-group details open the correct codex scope, including real installed data', () => {
  const boss = data.list('bosses').find((b) => !b.hidden);
  const keys = bossEnemyKeys(boss);
  let scope;
  const bossTree = EnemyPanel({ sel: { kind: 'boss', id: boss.bossId }, m: null, onCodex: (v) => { scope = v; } });
  find(bossTree, (v) => has(v, 'sw-look')).props.onClick();
  assert.deepEqual(scope.keys, keys);
  assert.equal(scope.key, boss.enemyKey);
  const f = Object.values(data.get('factions').types)[0];
  const group = EnemyPanel({ sel: { kind: 'type', id: f.type }, m: null, onCodex: (v) => { scope = v; } });
  find(group, (v) => has(v, 'sw-look')).props.onClick();
  assert.ok(scope.keys.length > 0);
  assert.ok(scope.keys.every((k) => f.pool.includes(k) || f.entries.includes(k)));
  assert.ok(scope.keys.every((k) => data.lookup('enemies', k)));
});

test('achievement canvas is upstream\'s .achv Modal, without altering original stats or battle roots', () => {
  const view = AchievementView({ ready: true, gd: {}, s: achievementStats([]), local: {}, onClose() {} });
  assert.equal(view.type.name, 'Modal', 'the project Modal owns the focus trap, Escape and the veil');
  assert.equal(view.props.class, 'achv');
  assert.equal(view.props.veilClass, 'achv-veil');
  assert.ok(find(view, (v) => v.props?.['data-testid'] === 'achievement-dialog'));
  // the 2026-10-29 ruling: the branch keeps its own records inside, not a second window geometry beside upstream's
  assert.doesNotMatch(read('public/css/screens/lobby.css'), /\.ach__box|\.ach__pending|\.ach \{/);
  const stats = postcss.parse(read('public/css/screens/stats.css'));
  const box = [];
  stats.walkRules((r) => { if (r.selector === '.modal__box.achv') box.push(r); });
  assert.equal(box.length, 1);
  assert.equal(box[0].parent.type, 'root', 'the canvas does not jump at a mobile breakpoint');
  const widths = [], heights = [];
  box[0].walkDecls('width', (d) => widths.push(d.value));
  box[0].walkDecls('height', (d) => heights.push(d.value));
  // the global root follows 文字大小, and the vw/vh clamp keeps the window inside a short or narrow viewport
  assert.ok(Math.abs(length(widths.at(-1), { rem: 100 }) - 1300) < 1e-7, widths.at(-1));
  assert.ok(Math.abs(length(heights.at(-1), { rem: 100 }) - 880) < 1e-7, heights.at(-1));
  assert.ok(Math.abs(length(widths.at(-1), { rem: 100 }, { width: 800, height: 400 }) - 752) < 1e-7);
  assert.ok(Math.abs(length(heights.at(-1), { rem: 100 }, { width: 800, height: 400 }) - 360) < 1e-7);
  assert.doesNotMatch([...widths, ...heights].join(' '), /\b(?:1080|720)px\b/);
  assert.doesNotMatch(box[0].toString(), /transform|zoom|--t:/);
  const compact = [];
  stats.walkRules((r) => { if (r.selector === '.st:not(.st--replay)') compact.push(r); });
  assert.equal(compact.length, 1);
  assert.equal(compact[0].parent.type, 'root', 'history dimensions no longer jump at a mobile breakpoint');
  assert.match(compact[0].toString(), /width: min\(calc\(12 \* var\(--ui-unit, 1rem\)\)/);
  assert.match(compact[0].toString(), /height: min\(calc\(8 \* var\(--ui-unit, 1rem\)\)/);
  assert.doesNotMatch(compact[0].toString(), /transform|zoom|--t:/);
  assert.equal(compact[0].selector.includes('combat-metrics'), false);
});

test('the report is read-only, a full-screen Modal, still loaded on demand, and the lobby opens it (source contract)', () => {
  const src = read('public/js/screens/sweep.js');
  assert.match(src, /<\$\{Modal\} open=\$\{true\} onClose=\$\{onClose\} class="sw"/);
  assert.match(src, /<\$\{Modal\} open=\$\{true\} onClose=\$\{onClose\} class="sw-codex"/);
  assert.doesNotMatch(src, /savePref\((?!TAB_PREF)|net\.|room\./, 'nothing but the remembered tab is written');
  assert.doesNotMatch(src, /name="box"|name="dice"/, 'only icons of the project\'s set');
  assert.doesNotMatch(src, /sweepEscapeAction|SweepShell|SweepView|sw-report-page|sweep-host/,
    'the Modal owns the focus trap, Escape and the focus restore');
  // 2026-10-29 ruling, kept branch behaviour 2: a bond member still opens the existing 干员调配 over the report
  assert.match(src, /openLoadout\('sweep', c\.chessId, 'loadout'\)/,
    'the loadout click-through the user kept on 2026-10-29');
  assert.match(read('public/js/screens/loadout.js'), /st\.from === 'sweep' && !!st\.sel/);
  // kept branch behaviour 1: the lobby still imports the screen on demand (test/vite.test.js dynamic entry)
  const lobby = read('public/js/screens/lobby.js');
  assert.match(lobby, /import\('\.\/sweep\.js'\)/);
  assert.doesNotMatch(lobby, /import \{ SweepReport \} from '\.\/sweep\.js';/);
  assert.match(lobby, /<\$\{sweepModule\.SweepReport\} onClose=\$\{\(\) => setSweepOpen\(false\)\}/);
  assert.match(lobby, /hub-plate hub-plate--sweep/);
  assert.match(read('public/index.html'), /<link rel="stylesheet" href="\/css\/screens\/sweep\.css" \/>/);
});
