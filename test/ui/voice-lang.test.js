// 配音语言 — the dual-track operator battle voice (中文 + 日本語) and its per-slot CN fallback.
//
// The manifest keeps `audio.voice` exactly as it was (CN: every current consumer reads it) and adds
// `audio.voiceAlt[<lang>]` beside it, same shape, holding only the slots that alternate dump carries
// (docs/ASSETS.md "Manifest schema" and "干员战斗语音, two tracks"). One run builds both:
// `node tools/fetch-assets.mjs --voice-langs=cn,jp` (the first language is the primary table). The client picks the
// table with the settings `voiceLang` (设置 → 配音语言) and falls back to `audio.voice` for a slot the chosen dub
// lacks — a partially dubbed operator still speaks, and a manifest without `voiceAlt` at all silently stays CN.
//
// Here: the plan/tooling side (buildPlan voiceLangs, resolveTemplate, the shrink guard, parseArgs), the settings
// contract (ui/gameLogic/settings.js sanitizeSettings → ui/settings.js row → audio.setVoiceLang), and the four packs.
// The client resolution itself (voiceLines / AudioManager.voice) lives in test/ui/audio.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../../tools/assets/plan.mjs';
import { indexAudio, VOICE_DIRS } from '../../tools/assets/audio.mjs';
import { collectLeaves, resolveTemplate, droppedEntries } from '../../tools/assets/manifest.mjs';
import { parseArgs, shrinkGuard } from '../../tools/fetch-assets.mjs';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../public/js/ui/gameLogic.js';
import { VOICE_LANGS, voiceLines } from '../../public/js/audio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** A charword_table.json with the CN slots of two operators (the CN table drives BOTH dumps: same slots, same file names). */
const charword = { charWords: {
  w1: { charId: 'char_a', wordKey: 'char_a', placeType: 'BATTLE_START', voiceId: 'CN_019', voiceIndex: 1, voiceAsset: 'char_a/CN_019' },
  w2: { charId: 'char_a', wordKey: 'char_a', placeType: 'BATTLE_SELECT', voiceId: 'CN_020', voiceIndex: 2, voiceAsset: 'char_a/CN_020' },
  w3: { charId: 'char_b', wordKey: 'char_b', placeType: 'BATTLE_START', voiceId: 'CN_030', voiceIndex: 1, voiceAsset: 'char_b/CN_030' },
} };

/** The plan template of a two-operator fixture (the same shape tools/fetch-assets.mjs plans). */
const plan = (opts = {}) => buildPlan({
  assets07: { operators: { char_a: {}, char_b: {} } }, ops03: {}, enemies05: {}, maps05: {},
  audio: indexAudio({}), modelsData: {}, charword, ...opts,
}).template;

/** Walk every leaf path of a template. */
const leafPaths = (template) => collectLeaves(template).map((l) => l.path);
/** Create an empty file (and its folders) under `root`. */
const touch = (root, rel) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), 'x'); };
/** A throwaway asset root, removed by the caller. */
const tempRoot = () => mkdtempSync(join(tmpdir(), 'sp-voice-'));

describe('the plan: one run, two voice tables (tools/assets/plan.mjs voiceLangs)', () => {
  test('the first language fills audio.voice, the others audio.voiceAlt[<lang>] — and a plain run has no alt table', () => {
    const one = plan();
    assert.deepEqual(Object.keys(one.audio.voice).sort(), ['char_a', 'char_b']);
    assert.equal(one.audio.voiceAlt, undefined, 'no voiceLangs: exactly the template a single --voice-lang run built');
    assert.equal(one.audio.voice.char_a.start.alts[0].rel, 'audio/voice/cn/char_a/cn_019.mp3');

    const two = plan({ voiceLangs: ['cn', 'jp'] });
    assert.deepEqual(Object.keys(two.audio.voiceAlt), ['jp']);
    assert.equal(two.audio.voice.char_a.start.alts[0].rel, 'audio/voice/cn/char_a/cn_019.mp3', 'the primary table is untouched');
    assert.equal(two.audio.voiceAlt.jp.char_a.start.alts[0].rel, 'audio/voice/jp/char_a/cn_019.mp3');
    assert.match(two.audio.voiceAlt.jp.char_a.start.alts[0].urls[0], /\/voice\/char_a\/cn_019\.mp3$/, `the JP dump folder ${VOICE_DIRS.jp}`);
    // the file name is the CN one (upstream keeps one file per line per dub), and both tables plan the same slots
    assert.deepEqual(Object.keys(two.audio.voiceAlt.jp.char_a), Object.keys(two.audio.voice.char_a));
    const paths = leafPaths(two);
    const alt = paths.filter((p) => p.startsWith('audio.voiceAlt.'));
    const cn = paths.filter((p) => p.startsWith('audio.voice.'));
    assert.ok(cn.includes('audio.voice.char_b.start') && alt.includes('audio.voiceAlt.jp.char_b.start'), 'both dumps are planned');
    assert.equal(alt.length, cn.length, `${cn.length} lines per dump, downloaded in that one run`);
    // the first language is the primary table, whatever it is (--voice-langs=jp,cn would flip them)
    assert.equal(plan({ voiceLangs: ['jp'] }).audio.voice.char_a.start.alts[0].rel, 'audio/voice/jp/char_a/cn_019.mp3');
    assert.deepEqual(Object.keys(plan({ voiceLangs: ['jp', 'cn'] }).audio.voiceAlt), ['cn']);
  });

  test('resolveTemplate: the alt table keeps only the lines on disk; with no JP file at all the whole key disappears', () => {
    const t = plan({ voiceLangs: ['cn', 'jp'] });
    const full = tempRoot();
    const cnOnly = tempRoot();
    try {
      for (const l of collectLeaves(t)) if (l.path.startsWith('audio.voice.')) touch(full, l.leaf.alts[0].rel);
      touch(full, 'audio/voice/jp/char_a/cn_019.mp3');   // the JP dump has char_a's 行动出发 only
      const r = resolveTemplate(t, { root: full, spine: new Map() });
      assert.equal(r.value.audio.voiceAlt.jp.char_a.start, '/assets/audio/voice/jp/char_a/cn_019.mp3');
      assert.equal(r.value.audio.voiceAlt.jp.char_a.select, undefined, 'a JP line not on disk is dropped, never faked');
      assert.equal(r.value.audio.voiceAlt.jp.char_b, undefined, 'nor is an operator the JP dump does not carry');
      assert.equal(r.value.audio.voice.char_a.select, '/assets/audio/voice/cn/char_a/cn_020.mp3', 'the CN table itself is complete');

      // CN on disk, no JP file at all (a deployment that never ran the alternate fetch): the key is not in the manifest
      for (const l of collectLeaves(t)) if (l.path.startsWith('audio.voice.')) touch(cnOnly, l.leaf.alts[0].rel);
      const r2 = resolveTemplate(t, { root: cnOnly, spine: new Map() });
      assert.equal(r2.value.audio.voiceAlt, undefined, 'no JP file: the manifest has no voiceAlt key at all');
      assert.ok(!('voiceAlt' in r2.value.audio));
      assert.equal(r2.value.audio.voice.char_a.start, '/assets/audio/voice/cn/char_a/cn_019.mp3', 'and the CN table is untouched');
      assert.equal(r2.misses.filter((m) => m.startsWith('audio.voiceAlt')).length, 3, 'the three JP lines are misses');
    } finally {
      rmSync(full, { recursive: true, force: true });
      rmSync(cnOnly, { recursive: true, force: true });
    }
  });

  test('the shrink guard protects the alternate table too (a run that lost the JP files keeps the committed manifest)', () => {
    const withAlt = { audio: { voice: { c: { start: '/cn.mp3' } }, voiceAlt: { jp: { c: { start: '/jp.mp3' } } } } };
    const withoutAlt = { audio: { voice: { c: { start: '/cn.mp3' } } } };
    assert.deepEqual(droppedEntries(withAlt, withoutAlt), ['audio.voiceAlt.jp.c.start']);
    assert.equal(shrinkGuard(withAlt, withoutAlt, parseArgs([])).write, false, 'not written without --allow-shrink');
    assert.equal(shrinkGuard(withAlt, withoutAlt, parseArgs(['--allow-shrink'])).write, true);
    assert.equal(shrinkGuard(withoutAlt, withAlt, parseArgs([])).write, true, 'gaining the JP table is never a shrink');
  });
});

describe('--voice-langs (tools/fetch-assets.mjs)', () => {
  test('several dumps in one run; --voice-lang keeps working exactly as before', () => {
    assert.deepEqual(parseArgs([]).voiceLangs, ['cn'], 'the old default: CN only, no alternate table');
    assert.equal(parseArgs([]).voiceLang, 'cn');
    const both = parseArgs(['--voice-langs=cn,jp']);
    assert.deepEqual(both.voiceLangs, ['cn', 'jp']);
    assert.equal(both.voiceLang, 'cn', 'voiceLang names the primary table (plan.mjs and the summary line)');
    assert.deepEqual(parseArgs(['--voice-langs=cn,cn,jp']).voiceLangs, ['cn', 'jp'], 'deduplicated');
    assert.deepEqual(parseArgs(['--voice-langs= cn , jp ']).voiceLangs, ['cn', 'jp'], 'spaces tolerated');
    assert.deepEqual(parseArgs(['--voice-lang=jp']).voiceLangs, ['jp'], 'the single-language flag is a one-entry list');
    assert.deepEqual(parseArgs(['--voice-lang=jp']).voiceLang, 'jp');
    assert.deepEqual(parseArgs(['--voice-langs=cn,jp', '--voice-lang=en']).voiceLangs, ['en'], 'the last flag wins');
    assert.equal(parseArgs(['--voice-langs=jp,cn']).voiceLang, 'jp', 'the first entry is the primary, whatever it is');
    assert.throws(() => parseArgs(['--voice-langs=cn,xx']), /unknown --voice-langs xx \(cn \| jp \| en \| kr\)/);
    assert.throws(() => parseArgs(['--voice-langs=']), /--voice-langs needs one or more languages/);
    assert.deepEqual(parseArgs(['--voice-langs=cn,']).voiceLangs, ['cn'], 'a trailing comma is just dropped');
  });
});

describe('the settings row (设置 → 配音语言)', () => {
  test('it sits right under the 干员语音 slider, offers exactly the languages the client knows, and writes through updateSettings', () => {
    const src = read('public/js/ui/settings.js');
    const slider = src.indexOf("t('干员语音')");
    const row = src.indexOf("t('配音语言')");
    assert.ok(slider > 0, 'the 干员语音 volume slider is there');
    assert.ok(row > slider, 'the 配音语言 row follows it');
    assert.match(src, /const VOICE_LANG_OPTIONS = \[\['cn', N_\('中文'\)\], \['jp', N_\('日本語'\)\]\]/);
    assert.deepEqual([...src.matchAll(/\['(cn|jp)', N_\(/g)].map((m) => m[1]), [...VOICE_LANGS],
      'the options are audio.js VOICE_LANGS: the row can never offer a language the client cannot resolve');
    assert.match(src, /updateSettings\(\{ voiceLang: id \}\)/, 'the same store helper as the neighbouring rows');
    assert.match(src, /data-voice-lang=\$\{id\}/);
    assert.match(src, /aria-checked=\$\{s\.voiceLang === id \? 'true' : 'false'\}/, 'a radiogroup, marked like 画面质量');
    assert.match(src, /audio\.setVoiceLang\(s\.voiceLang\)/, 'the store pushes it to the audio manager on every change');
    assert.match(read('public/js/main.js'), /settings: settingsStore\.get\(\)/, 'and main.js hands the settings to installAudio');
    assert.equal(DEFAULT_SETTINGS.voiceLang, VOICE_LANGS[0], 'the default is CN');
  });

  test('sanitizeSettings: only a known language survives, anything else (absent, unknown, mistyped) plays CN', () => {
    assert.equal(sanitizeSettings({ voiceLang: 'jp' }).voiceLang, 'jp');
    assert.equal(sanitizeSettings({ voiceLang: 'cn' }).voiceLang, 'cn');
    for (const bad of [undefined, null, '', 'cn ', 'CN', 'kr', 'en', 'ja', 0, 1, true, {}, ['jp'], { lang: 'jp' }]) {
      assert.equal(sanitizeSettings({ voiceLang: bad }).voiceLang, 'cn', `voiceLang=${JSON.stringify(bad)}`);
    }
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, voiceLang: 'jp' }).voiceLang, 'jp', 'the rest of the profile is untouched');
  });

  test('voiceLines is the only table lookup (a second reader would drift from the fallback)', () => {
    const src = read('public/js/audio.js');
    assert.match(src, /const line = voiceLines\(this\.getManifest\(\), charId, slot, this\.voiceLang\)/);
    assert.ok(!/audio\?\.voice\?\.\[charId\]/.test(src), 'no direct audio.voice[charId] read is left in the manager');
    assert.equal(voiceLines({ audio: { voice: { c: { start: '/cn.mp3' } } } }, 'c', 'start', 'cn'), '/cn.mp3');
  });
});

describe('the new msgids (all four packs, docs/I18N.md)', () => {
  const IDS = ['配音语言', '中文', '日本語'];

  test('every pack carries the three strings, none of them empty', () => {
    for (const code of ['en', 'ja', 'ko', 'zh-TW']) {
      const json = JSON.parse(read(`public/i18n/${code}.json`));
      for (const id of IDS) {
        assert.equal(typeof json[id], 'string', `${code}: ${id}`);
        assert.ok(json[id].trim().length > 0, `${code}: ${id} is not empty`);
      }
      assert.equal(json._meta.complete, true, `${code} stays a complete pack`);
    }
    assert.equal(JSON.parse(read('public/i18n/ja.json'))['日本語'], '日本語', 'a Japanese player sees their own dub name');
    assert.equal(JSON.parse(read('public/i18n/en.json'))['中文'], 'Chinese');
  });
});
