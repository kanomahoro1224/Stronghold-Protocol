// 用户 2026-10-16：把 fork 的大厅视频背景加回来（上限改成 200MB，分辨率仍 ≤1080p），仍然只存本机、不上传。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_VIDEO_BYTES, MAX_IMAGE_BYTES, sanitizeBackdrop,
} from '../../public/js/ui/hubAppearance.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const appearance = read('public/js/ui/hubAppearance.js');
const backdrop = read('public/js/ui/hubBackdrop.js');
const music = read('public/js/ui/lobbyMusic.js');
const css = read('public/css/screens/lobby.css');

test('the video cap is 200MB and the image cap stays 30MB', () => {
  assert.equal(MAX_VIDEO_BYTES, 200 * 1024 * 1024);
  assert.equal(MAX_IMAGE_BYTES, 30 * 1024 * 1024);
  assert.match(appearance, /MAX_VIDEO_BYTES = 200 \* 1024 \* 1024/);
  assert.match(appearance, /t\('视频太大（上限 200MB）'\)/);
  assert.doesNotMatch(appearance, /60 \* 1024 \* 1024/, 'the old 60MB cap is gone');
});

test('a video is validated by metadata, not re-encoded', () => {
  assert.match(appearance, /export function validateVideo\(file\)/);
  assert.match(appearance, /export async function prepareVideo\(file\)/);
  assert.match(appearance, /probe\.preload = 'metadata'/);
  assert.match(appearance, /probe\.videoWidth \* probe\.videoHeight > 1920 \* 1080/);
  assert.match(appearance, /Math\.max\(probe\.videoWidth, probe\.videoHeight\) > MAX_VIDEO_EDGE/);
  assert.match(appearance, /t\('请使用最高 1080p 的视频'\)/);
  // the stored blob may be an image (≤30MB) or a video (≤200MB), and nothing else
  assert.match(appearance, /if \(r\.blob\.type\.startsWith\('video\/'\)\) return r\.blob\.size <= MAX_VIDEO_BYTES;/);
  assert.match(appearance, /return \/\^image\\\/\/\.test\(r\.blob\.type\) && r\.blob\.size <= MAX_IMAGE_BYTES;/);
});

test('preferences carry the two video switches and old profiles still load', () => {
  assert.deepEqual(sanitizeBackdrop({ videoSound: true, videoPaused: true }),
    { ...sanitizeBackdrop({}), videoSound: true, videoPaused: true });
  assert.equal(sanitizeBackdrop(null).videoSound, false);
  assert.equal(sanitizeBackdrop({}).videoPaused, false);
  assert.equal(sanitizeBackdrop({ videoSound: 'yes' }).videoSound, false, 'non-boolean values are not trusted');
  // a stored video is reported as mediaKind 'video' so the renderer and the panel can branch
  assert.match(appearance, /mediaKind: image\.record\?\.blob && String\(image\.record\.blob\.type\)\.startsWith\('video\/'\) \? 'video' : 'image'/);
  assert.match(appearance, /if \(await images\.change\(\(\) => \(isVideo \? prepareVideo\(file\) : prepareBackdrop\(file\)\)\)\)/);
  assert.match(appearance, /update\(\{ theme: 'custom', videoPaused: false, videoSound: false \}\)/);
});

test('the renderer swaps the photo div for a looping muted video element', () => {
  assert.match(backdrop, /function HubVideo\(\{ bg \}\)/);
  assert.match(backdrop, /class="hub-bg__video"/);
  assert.match(backdrop, /loop playsInline preload="metadata" muted/);
  assert.match(backdrop, /video\.muted = !pref\.videoSound \|\| audio\.volumes\.muted/);
  assert.match(backdrop, /video\.volume = Math\.max\(0, Math\.min\(1, audio\.volumes\.bgm\)\)/);
  assert.match(backdrop, /if \(pref\.videoPaused \|\| document\.hidden\) \{ video\.pause\(\); claim\(false\); return; \}/);
  assert.match(backdrop, /const video = scene === 'photo' && bg\.mediaKind === 'video';/);
  assert.match(backdrop, /\$\{video \? html`<\$\{HubVideo\} key=\$\{bg\.imageUrl\} bg=\$\{bg\} \/>`/);
  // the file picker accepts videos and the panel marks a stored video with a play badge
  assert.match(backdrop, /accept="image\/\*,video\/mp4,video\/webm,\.mp4,\.webm,\.m4v"/);
  assert.match(backdrop, /bgset__plus">▶</);
  assert.match(backdrop, /t\('视频声音'\)/);
  assert.match(backdrop, /t\('暂停视频'\)/);
  assert.match(backdrop, /audio\._unlock\(\); update\(\{ videoSound: e\.currentTarget\.checked \}\)/);
  assert.match(backdrop, /t\('视频上限 200MB、最高 1080p，仅保存在当前浏览器。'\)/);
  assert.match(backdrop, /t\('视频处理中…'\)/);
  // blur/dim still apply to a video backdrop
  assert.match(backdrop, /style=\$\{\{ filter: `blur\(\$\{pref\.blur\}px\)` \}\}/);
  // the ui-unit (1920x1080 design unit) conversion of the old -32px bleed: 0.32 * var(--ui-unit, 1rem)
  assert.match(css, /\.hub-bg__video \{ position: absolute; inset: calc\(-0\.32 \* var\(--ui-unit, 1rem\)\);/);
  assert.match(css, /\.hub-bg__video \{[^}]*width: calc\(100% \+ 0\.64 \* var\(--ui-unit, 1rem\)\);/);
  assert.match(css, /\.hub-bg__video \{[^}]*height: calc\(100% \+ 0\.64 \* var\(--ui-unit, 1rem\)\);/);
});

test('video sound suspends the lobby music and restores it afterwards', () => {
  assert.match(music, /window\.addEventListener\('sp:lobby-video-audio'/);
  assert.match(music, /const paused = !!s\.record\?\.paused \|\| videoAudio;/);
  assert.match(music, /audio\.setLobbyMusic\(s\.url \? \{ url: s\.url, paused \} : null\)/);
  // the video announces its audio state, and the music module is the only consumer
  assert.match(backdrop, /window\.dispatchEvent\(new CustomEvent\('sp:lobby-video-audio', \{ detail: \{ active \} \}\)/);
  // the built-in lobby BGM has no media element to pause, so the hold has to reach AudioManager as well
  const audio = read('public/js/audio.js');
  assert.match(music, /audio\.setLobbyVideoAudio\(videoAudio\)/);
  assert.match(audio, /setLobbyVideoAudio\(active\) \{/);
  assert.match(audio, /_videoHolds\(key\) \{ return this\.lobbyVideoAudio && key === 'lobby'; \}/);
  assert.match(audio, /if \(this\._videoHolds\(current\.key\)\) \{ \+\+this\.bgmToken; this\._fadeOutBgm\(\); \}/);
  assert.match(audio, /if \(!next && this\.bgmKey === 'lobby'\) this\.playBgm\('lobby'\);/);
});

test('every pack carries the video strings', () => {
  const keys = ['请选择有效的视频文件', '视频太大（上限 200MB）', '请选择 MP4 或 WebM 视频', '视频读取超时，请换一个文件试试',
    '视频无效或时长不可读', '请使用最高 1080p 的视频', '浏览器无法播放该视频，请尝试 MP4 或 WebM', '请选择图片、MP4 或 WebM 视频',
    '视频声音', '暂停视频', '视频上限 200MB、最高 1080p，仅保存在当前浏览器。', '视频处理中…'];
  for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
    const pack = JSON.parse(read(`public/i18n/${lang}.json`));
    for (const key of keys) assert.equal(typeof pack[key], 'string', `${lang}: ${key}`);
  }
  const en = JSON.parse(read('public/i18n/en.json'));
  assert.equal(en['视频太大（上限 200MB）'], 'Video is too large (200MB limit)');
  assert.equal(en['暂停视频'], 'Pause video');
});
