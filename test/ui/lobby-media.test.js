// test/ui/lobby-media.test.js — 自定义大厅背景与音乐 (PR #643 split 8): which files a slot takes (type, extension, size
// limits, empty), the saved switches sanitised, the audio manager playing the player's own lobby track from its bytes
// (never fetched, only for the 'lobby' key, through the BGM gain; off → the manifest's track; a file that will not decode
// → the official track and onLobbyTrackFailed; a track already decoded by the file's check is not decoded again), the
// buffer cache's budget around it (#814 review: a superseded own track's read / decode that finishes late records nothing,
// so the budget never leaks; a track larger than the whole budget no longer flushes every sound and then itself; an idle
// track leaves first), the picture / video / music guards (moving pictures sniffed, 2560 px, 1080p, 6 minutes, the
// storage messages), and the lobby css following 文字大小 without !important. (The browser side: test/ui/lobby-media.e2e.test.js.)
//
// This file also carries the branch's own suite (ui/localMedia.js, ui/hubAppearance.js, ui/lobbyMusic.js,
// ui/hubBackdrop.js, audio.js setLobbyMusic / setLobbyVideoAudio). The two lobby-media implementations were
// merged side by side (main.js installs both installLobbyMusic and installLobbyMedia, lobby.js nests
// LobbyScene / OwnBackdrop inside the branch HubBackdrop), so both suites have to run here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalMedia, mediaStorage } from '../../public/js/ui/localMedia.js';
import { MAX_IMAGE_BYTES, sanitizeBackdrop, validateImage, prepareBackdrop, backdropTheme } from '../../public/js/ui/hubAppearance.js';
import { MAX_MUSIC_BYTES, validateMusicFile, prepareMusic } from '../../public/js/ui/lobbyMusic.js';
import { HubBackdrop, HubRadar } from '../../public/js/ui/hubBackdrop.js';
import { AudioManager } from '../../public/js/audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const {
  classifyFile, loadMediaPrefs, MEDIA_LIMITS, MAX_EDGE, MUSIC_MAX_S, isAnimatedImage, fitEdge, videoTooLarge, storageError,
} = await import('../../public/js/ui/lobbyMedia.js');
const { LOCAL_BGM } = await import('../../public/js/audio.js');
const { mediaUrl } = await import('../../public/js/media.js');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
const MB = 1024 * 1024;
const file = (name, type, size = 1000) => ({ name, type, size });

// ---- the branch's own lobby media: localMedia / hubAppearance / lobbyMusic / hubBackdrop --------------------
const record = (name = 'song.mp3') => ({ name, blob: new Blob(['song'], { type: 'audio/mpeg' }), paused: false });
function localStore(storage) {
  let next = 0;
  const revoked = [];
  const store = createLocalMedia({ storage, valid: (r) => r?.blob instanceof Blob,
    urls: { createObjectURL: () => `blob:${++next}`, revokeObjectURL: (url) => revoked.push(url) } });
  return { store, revoked };
}

test('late storage restore cannot replace a newer song; pause keeps the object URL and reset releases it', async () => {
  let restore, disk;
  const { store, revoked } = localStore(async (write, value) => {
    if (write) { disk = value; return; }
    return new Promise((resolve) => { restore = resolve; });
  });
  const loading = store.load();
  const chosen = record();
  await store.change(() => chosen);
  restore(record('old.mp3')); await loading;
  assert.equal(store.get().record, chosen);
  assert.equal(disk, chosen);
  const url = store.get().url;
  await store.change(() => ({ ...chosen, paused: true }));
  assert.equal(store.get().url, url);
  assert.deepEqual(revoked, []);
  await store.change(() => null);
  assert.equal(store.get().record, null); assert.equal(disk, null);
  assert.deepEqual(revoked, [url]);
});

test('concurrent imports are rejected and a failed save retains the current file and releases the busy state', async () => {
  let fail = false, complete;
  const { store } = localStore(async () => { if (fail) throw Error('quota'); });
  const first = record(); await store.change(() => first);
  const pending = store.change(() => new Promise((resolve) => { complete = resolve; }));
  assert.equal(await store.change(() => null), false);
  fail = true; complete(record('next.mp3'));
  await assert.rejects(pending, /quota/);
  assert.equal(store.get().record, first);
  assert.equal(store.get().busy, false);
});

test('refresh restores the stored Blob while absent or inaccessible IndexedDB keeps defaults', async () => {
  let disk = null;
  const storage = async (write, value) => write ? (disk = value) : disk;
  await localStore(storage).store.change(() => record());
  const { store } = localStore(storage); await store.load();
  assert.equal(store.get().record.name, 'song.mp3'); assert.ok(store.get().url);
  const unavailable = localStore(async () => { throw Error('denied'); }).store;
  await unavailable.load(); assert.equal(unavailable.get().ready, true); assert.equal(unavailable.get().url, null);
  if (!globalThis.indexedDB) await assert.rejects(mediaStorage('db', 'table', 'key')(), /浏览器无法保存/);
});

test('file type/size boundaries and saved background settings are validated', () => {
  const music = { name: 'song.mp3', type: 'audio/mpeg', size: MAX_MUSIC_BYTES };
  assert.doesNotThrow(() => validateMusicFile(music));
  assert.throws(() => validateMusicFile({ ...music, size: MAX_MUSIC_BYTES + 1 }), /20MB/);
  assert.throws(() => validateMusicFile({ ...music, size: 0 }), /有效/);
  assert.throws(() => validateMusicFile({ ...music, name: 'file.html', type: 'text/html' }), /音频/);
  assert.doesNotThrow(() => validateImage({ type: 'image/png', size: MAX_IMAGE_BYTES }));
  assert.throws(() => validateImage({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }), /30MB/);
  assert.throws(() => validateImage({ type: 'video/mp4', size: 200 }), /图片/);
  // videoSound/videoPaused belong to the local video backdrop (ported back from the fork) and default to off
  assert.deepEqual(sanitizeBackdrop({ theme: 'external', dim: 200, blur: -1, overlay: false, motion: false }),
    { theme: 'night', dim: 85, blur: 0, overlay: false, motion: false, videoSound: false, videoPaused: false });
  assert.equal(sanitizeBackdrop({ dim: null, blur: NaN }).dim, 45);
});

test('image preparation scales to 2560px and releases its temporary URL; undecodable music never reaches storage', async (ctx) => {
  const originalImage = globalThis.Image, originalDocument = globalThis.document, originalAudio = globalThis.Audio;
  const revoked = [], draws = [], canvas = { getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }),
    toBlob(fn, mime) { fn(new Blob(['image'], { type: mime })); } };
  ctx.mock.method(URL, 'createObjectURL', () => 'blob:probe');
  ctx.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  globalThis.Image = class { naturalWidth = 5120; naturalHeight = 2880; set src(_) { queueMicrotask(() => this.onload()); } };
  globalThis.document = { createElement: () => canvas };
  globalThis.Audio = class {
    duration = 0;
    set src(_) { queueMicrotask(() => this.onerror?.()); }
    removeAttribute() {} load() {}
  };
  try {
    const image = await prepareBackdrop(new Blob(['png'], { type: 'image/png' }));
    assert.equal(canvas.width, 2560); assert.equal(canvas.height, 1440);
    assert.deepEqual(draws[0].slice(1), [0, 0, 2560, 1440]);
    assert.equal(image.blob.type, 'image/jpeg');
    await assert.rejects(prepareMusic(new File(['bad'], 'bad.mp3', { type: 'audio/mpeg' })), /无法播放/);
    globalThis.Audio = class {
      duration = 10;
      set src(_) { queueMicrotask(() => this.onloadedmetadata?.()); }
      removeAttribute() {} load() {}
    };
    const file = new File(['song'], `${'a'.repeat(200)}.mp3`, { type: 'audio/mpeg' });
    const song = await prepareMusic(file);
    assert.equal(song.name, file.name);
    assert.doesNotThrow(() => validateMusicFile({ size: song.blob.size, type: song.blob.type, name: song.name }));
    assert.deepEqual(revoked, ['blob:probe', 'blob:probe', 'blob:probe']);
  } finally { globalThis.Image = originalImage; globalThis.document = originalDocument; globalThis.Audio = originalAudio; }
});

function* walk(v) {
  if (Array.isArray(v)) { for (const child of v) yield* walk(child); return; }
  if (!v || typeof v !== 'object') return;
  yield v; yield* walk(v.props?.children);
}
test('custom backgrounds keep the shade and disable motion/grid; missing files fall back to night', () => {
  const bg = { pref: sanitizeBackdrop({ theme: 'custom', motion: false, overlay: false, dim: 70, blur: 5 }),
    imageUrl: 'blob:local', ready: true };
  const tree = HubBackdrop({ bg }), nodes = [...walk(tree)];
  assert.equal(tree.props['data-motion'], 'off'); assert.equal(tree.props['aria-hidden'], 'true');
  assert.equal(nodes.find((v) => v.props?.class === 'hub-bg__photo').props.style.filter, 'blur(5px)');
  assert.equal(nodes.find((v) => v.props?.class === 'hub-bg__shade').props.style.opacity, .7);
  assert.equal(nodes.some((v) => v.props?.class === 'hub-bg__grid'), false);
  assert.equal([...walk(HubRadar({ bg }))].some((v) => v.props?.class === 'hub-radar__sweep'), false);
  assert.equal(backdropTheme({ ...bg, imageUrl: null }), 'night');
  assert.equal(HubBackdrop({ bg: { ...bg, imageUrl: null, ready: false } }).props['data-scene'], 'blank');
});

function audioHarness() {
  const streams = [], decoded = [];
  const gain = () => ({ gain: { value: 1, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {}, disconnect() {} });
  const win = { document: { hidden: false }, addEventListener() {}, removeEventListener() {},
    Audio: class {
      constructor() { this.paused = true; streams.push(this); }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
      removeAttribute() {} load() {}
    },
  };
  const manager = new AudioManager({ win, getManifest: () => ({ audio: { bgm: { lobby: { loop: '/default.mp3' }, prep: { loop: '/prep.mp3' }, combat: { loop: '/battle.mp3' } } } }) });
  const ctx = { currentTime: 0, state: 'running', createGain: gain, createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {} }),
    resume: () => Promise.resolve(), suspend: () => Promise.resolve() };
  manager._buffer = async (url) => { decoded.push(url); return { duration: 1 }; };
  return { manager, streams, decoded, unlock() { manager.ctx = ctx; manager.bgmGain = gain(); } };
}

test('local music waits for unlock, shares mute/volume/visibility, pauses without restarting, and streams outside the buffer cache', () => {
  const { manager: a, streams, decoded, unlock } = audioHarness();
  a.playBgm('lobby'); a.setLobbyMusic({ url: 'blob:song' });
  assert.equal(streams.length, 0); unlock(); a.playBgm('lobby');
  assert.equal(streams.length, 1); assert.equal(streams[0].paused, false); assert.equal(streams[0].loop, true);
  assert.deepEqual(decoded, []);
  a.playBgm('lobby'); a.setLobbyMusic({ url: 'blob:song', paused: true });
  assert.equal(streams.length, 1); assert.equal(streams[0].paused, true);
  a.setLobbyMusic({ url: 'blob:song', paused: false }); assert.equal(streams[0].paused, false);
  a.setVolumes({ muted: true }); assert.equal(streams[0].paused, true);
  a.setVolumes({ muted: false, bgm: 0 }); assert.equal(streams[0].paused, true);
  a.setVolumes({ bgm: .6 }); assert.equal(streams[0].paused, false);
  a.win.document.hidden = true; a._onVis(); assert.equal(streams[0].paused, true);
  a.win.document.hidden = false; a._onVis(); assert.equal(streams[0].paused, false);
  a.bgm.stop();
});

test('late song restore cannot replace battle music; returning to the lobby selects it and reset restores official music', async () => {
  const { manager: a, unlock } = audioHarness(); unlock();
  a.playBgm('combat:1'); a.setLobbyMusic({ url: 'blob:song' }); await Promise.resolve(); await Promise.resolve();
  assert.equal(a.bgmKey, 'combat:1'); assert.equal(a.lobbyMusic.url, 'blob:song');
  a.playBgm('lobby'); assert.equal(a.bgm.loopUrl, 'blob:song');
  a.setLobbyMusic(null); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(a.bgm.loopUrl, '/default.mp3');
});

test('muted songs do not start a media request; failed songs fall back without reviving a previous route', async () => {
  const { manager: a, unlock, streams } = audioHarness(); unlock();
  a.setVolumes({ muted: true }); a.setLobbyMusic({ url: 'blob:bad' }); a.playBgm('lobby');
  assert.equal(streams.length, 0);
  a.setVolumes({ muted: false }); const oldError = streams[0].onerror;
  oldError(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(a.lobbyMusic, null); assert.equal(a.bgm.loopUrl, '/default.mp3');
  a.playBgm('prep'); oldError(); assert.equal(a.bgmKey, 'prep');
});

test('a lobby video with sound holds the built-in lobby BGM, and only the lobby one', async () => {
  const { manager: a, unlock } = audioHarness(); unlock();
  a.playBgm('lobby'); await Promise.resolve(); await Promise.resolve();
  assert.equal(a.bgm.loopUrl, '/default.mp3', 'the manifest track, not a local file');
  assert.equal(a.bgm.media, undefined, 'the built-in track is a Web Audio buffer, which cannot pause');
  a.setLobbyVideoAudio(true);
  assert.equal(a.bgm, null, 'the lobby track fades out while the video has sound');
  a.playBgm('lobby'); // a store update asks for the lobby track again
  assert.equal(a.bgm, null, 'the hold survives a later playBgm');
  a.setLobbyVideoAudio(false); await Promise.resolve(); await Promise.resolve();
  assert.equal(a.bgm.loopUrl, '/default.mp3', 'the lobby track comes back when the video stops');
  // battle music is never held, and the flag only clears once
  a.playBgm('combat:1'); await Promise.resolve(); await Promise.resolve();
  const battle = a.bgm;
  a.setLobbyVideoAudio(true); assert.equal(a.bgm, battle, 'battle music keeps playing');
  a.setLobbyVideoAudio(false); assert.equal(a.bgm, battle, 'and is not restarted');
});

test('a held lobby track still yields to the battle, and a local song pauses through its media element', async () => {
  const { manager: a, streams, unlock } = audioHarness(); unlock();
  a.playBgm('lobby'); await Promise.resolve(); await Promise.resolve();
  a.setLobbyVideoAudio(true); assert.equal(a.bgm, null);
  a.playBgm('prep'); await Promise.resolve(); await Promise.resolve();
  assert.equal(a.bgm.loopUrl, '/prep.mp3', 'the video does not hold the prep screen');
  a.setLobbyVideoAudio(false); assert.equal(a.bgm.loopUrl, '/prep.mp3', 'and releasing it does not restart the lobby');
  // an imported song is a media element: it pauses in place instead of fading out
  a.playBgm('lobby'); a.setLobbyMusic({ url: 'blob:song' });
  assert.equal(streams.length, 1); assert.equal(streams[0].paused, false);
  a.setLobbyVideoAudio(true); assert.equal(streams[0].paused, true, 'the local song pauses');
  assert.equal(a.bgm.loopUrl, 'blob:song', 'and is not torn down');
  a.setLobbyVideoAudio(false); assert.equal(streams[0].paused, false, 'and resumes');
  a.bgm.stop();
});

test('lobby media uses existing modal management and audio bootstrap without changing battle choices', () => {
  const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  assert.match(read('public/js/main.js'), /installLobbyMusic\(\)/);
  assert.match(read('public/js/screens/lobby.js'), /title=\$\{t\('大厅背景'\)\}/);
  assert.match(read('public/js/screens/lobby.js'), /open=\$\{bgOpen\} utility=\$\{true\}/);
  assert.match(read('public/js/ui/lobbyMusic.js'), /open=\$\{open\} utility=\$\{true\}/);
  // the video's sound hold reaches the built-in track too, not only an imported song
  assert.match(read('public/js/ui/lobbyMusic.js'), /audio\.setLobbyVideoAudio\(videoAudio\)/);
  assert.match(read('public/js/audio.js'), /setLobbyVideoAudio\(active\)/);
  assert.match(read('public/js/audio.js'), /_videoHolds\(key\) \{ return this\.lobbyVideoAudio && key === 'lobby'; \}/);
});


// ---- upstream v0.3.3 lobby media: ui/lobbyMedia.js and audio.js setLobbyTrack ------------------------------
describe('which files a slot takes', () => {
  test('the backdrop: a picture or an MP4 / WebM video, by type, else by extension', () => {
    for (const [f, kind] of [
      [file('a.png', 'image/png'), 'image'], [file('a.jpg', 'image/jpeg'), 'image'], [file('a.webp', 'image/webp'), 'image'],
      [file('a.gif', 'image/gif'), 'image'], [file('a.avif', 'image/avif'), 'image'], [file('b.mp4', 'video/mp4'), 'video'],
      [file('b.webm', 'video/webm'), 'video'], [file('noType.JPEG', ''), 'image'], [file('noType.m4v', ''), 'video'],
    ]) assert.deepEqual(classifyFile(f, 'backdrop'), { ok: true, kind }, f.name);
    for (const f of [file('a.svg', 'image/svg+xml'), file('a.mov', 'video/quicktime'), file('a.mp3', 'audio/mpeg'), file('a.png', 'text/plain'), file('x', '')]) {
      const r = classifyFile(f, 'backdrop');
      assert.equal(r.ok, false, f.name);
      // the refusal names every picture type it takes
      for (const kind of ['PNG', 'JPG', 'WebP', 'GIF', 'AVIF', 'MP4', 'WebM']) assert.ok(r.reason.includes(kind), `${f.name}: ${kind}`);
    }
  });
  test('the music: an audio type, or a known audio extension without a usable type', () => {
    for (const f of [file('a.mp3', 'audio/mpeg'), file('a.m4a', 'audio/mp4'), file('a.ogg', 'audio/ogg'), file('a.wav', 'audio/wav'),
      file('a.flac', 'audio/flac'), file('a.opus', ''), file('a.webm', 'video/webm'), file('a.ogg', 'application/ogg')]) {
      assert.deepEqual(classifyFile(f, 'music'), { ok: true, kind: 'music' }, `${f.name} ${f.type}`);
    }
    for (const f of [file('a.png', 'image/png'), file('a.mp4', 'video/mp4'), file('a.txt', ''), file('a.mid', 'text/plain')]) {
      assert.equal(classifyFile(f, 'music').ok, false, f.name);
    }
  });
  test('the size limits (20 / 60 / 20 MB) and an empty file', () => {
    assert.deepEqual(MEDIA_LIMITS, { image: 20 * MB, video: 60 * MB, music: 20 * MB });
    assert.equal(classifyFile(file('a.png', 'image/png', 20 * MB), 'backdrop').ok, true);
    assert.match(classifyFile(file('a.png', 'image/png', 20 * MB + 1), 'backdrop').reason, /20 MB/);
    assert.equal(classifyFile(file('a.mp4', 'video/mp4', 60 * MB), 'backdrop').ok, true);
    assert.match(classifyFile(file('a.mp4', 'video/mp4', 60 * MB + 1), 'backdrop').reason, /60 MB/);
    assert.match(classifyFile(file('a.mp3', 'audio/mpeg', 20 * MB + 1), 'music').reason, /20 MB/);
    for (const f of [null, file('a.png', 'image/png', 0)]) assert.equal(classifyFile(f, 'backdrop').ok, false);
  });
  test('the saved switches are sanitised (off by default, 暗度 0–0.8)', () => {
    assert.deepEqual(loadMediaPrefs(null), { backdrop: false, music: false, dim: 0.35, scene: 'official' });
    assert.deepEqual(loadMediaPrefs({ backdrop: true, music: 'yes', dim: 3, scene: 'frost' }), { backdrop: true, music: false, dim: 0.8, scene: 'frost' });
    assert.deepEqual(loadMediaPrefs({ dim: -1, scene: 'sunny' }), { backdrop: false, music: false, dim: 0, scene: 'official' }, 'an unknown scene is the official backdrop');
    assert.deepEqual(loadMediaPrefs({ dim: 'x' }).dim, 0.35);
  });
});

// ---- the audio manager with a fake Web Audio ---------------------------------------------------------------------------
/** `bufFor(ab)`: the AudioBuffer a decode makes (default 10 frames); `hold(ab)`: a decode to finish later (made.release). */
function fakeWindow({ decodeFails = () => false, bufFor = () => ({ duration: 2, length: 10, numberOfChannels: 2 }), hold = () => false } = {}) {
  const made = { started: 0, decoded: [], held: [] };
  made.release = () => { for (const fn of made.held.splice(0)) fn(); };
  class Param { constructor() { this.value = 1; } setValueAtTime(v) { this.value = v; } linearRampToValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } cancelScheduledValues() {} }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Src extends Node { constructor() { super(); this.playbackRate = new Param(); } start() { made.started++; } stop() {} }
  class Ctx {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createGain() { return new Gain(); }
    createBufferSource() { return new Src(); }
    decodeAudioData(ab, ok, bad) {
      made.decoded.push(ab.byteLength);
      const finish = () => { if (decodeFails(ab)) bad(new Error('codec')); else ok(bufFor(ab)); };
      if (hold(ab)) made.held.push(finish); else finish();
    }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  }
  const listeners = new Map();
  return {
    made,
    win: { AudioContext: Ctx, document: { hidden: false, addEventListener() {} }, addEventListener(t, fn) { listeners.set(t, fn); }, removeEventListener(t) { listeners.delete(t); } },
    fire(t) { listeners.get(t)?.(); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

describe('the player\'s own lobby music (audio.js setLobbyTrack)', () => {
  test('plays from its bytes for the lobby key only; off → the manifest\'s track', async () => {
    const fw = fakeWindow();
    const origFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (u) => { urls.push(u); return { ok: true, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new ArrayBuffer(8) }; };
    try {
      const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
      a.install();
      fw.fire('pointerdown');
      let reads = 0;
      a.setLobbyTrack({ id: '42', read: async () => { reads++; return new ArrayBuffer(1234); } });
      a.playBgm('lobby');
      await tick();
      assert.equal(a.bgm?.loopUrl, `${LOCAL_BGM}42`);
      assert.equal(reads, 1);
      assert.ok(fw.made.decoded.includes(1234), 'decoded from the bytes');
      const lobby = manifest.audio.bgm.lobby;
      assert.ok(!urls.some((u) => u === mediaUrl(lobby.loop) || u === lobby.loop), 'the official lobby track is not fetched');
      assert.ok(!urls.some((u) => String(u).startsWith(LOCAL_BGM)), 'the own track is never a request');
      // another screen's music is the manifest's
      a.playBgm('prep');
      await tick();
      assert.equal(a.bgm?.loopUrl, manifest.audio.bgm.prep.loop);
      // back in the lobby: the cached own track, not read again
      a.playBgm('lobby');
      await tick();
      assert.equal(a.bgm?.loopUrl, `${LOCAL_BGM}42`);
      assert.equal(reads, 1);
      // switched off: the screen's track changes at once to the official one
      a.setLobbyTrack(null);
      await tick();
      assert.equal(a.bgm?.loopUrl, lobby.loop);
      // a new file: a new id, read again
      a.setLobbyTrack({ id: '43', read: async () => { reads++; return new ArrayBuffer(99); } });
      await tick();
      assert.equal(a.bgm?.loopUrl, `${LOCAL_BGM}43`);
      assert.equal(reads, 2);
      assert.ok(!a.buffers.has(`${LOCAL_BGM}42`), 'the old file\'s buffer is dropped');
    } finally { globalThis.fetch = origFetch; }
  });
  test('silent while muted (nothing read); a file that will not decode → the official track and onLobbyTrackFailed', async () => {
    const fw = fakeWindow({ decodeFails: (ab) => ab.byteLength === 7 });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new ArrayBuffer(8) });
    try {
      const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
      a.install();
      fw.fire('pointerdown');
      let reads = 0;
      a.setVolumes({ muted: true });
      a.setLobbyTrack({ id: 'm', read: async () => { reads++; return new ArrayBuffer(5); } });
      a.playBgm('lobby');
      await tick();
      assert.equal(reads, 0, 'muted: the file is not even read');
      a.setVolumes({ muted: false });
      await tick();
      assert.equal(a.bgm?.loopUrl, `${LOCAL_BGM}m`);
      let failed = 0;
      a.onLobbyTrackFailed = () => { failed++; };
      a.setLobbyTrack({ id: 'bad', read: async () => new ArrayBuffer(7) });
      await tick();
      assert.equal(failed, 1);
      assert.equal(a.lobbyTrack, null);
      assert.equal(a.bgm?.loopUrl, manifest.audio.bgm.lobby.loop, 'the official track plays instead');
    } finally { globalThis.fetch = origFetch; }
  });
});

// ---- the buffer cache around the own track (#814 review) --------------------------------------------------------------
const SMALL = { duration: 2, length: 10, numberOfChannels: 2 };
/** A fake AudioBuffer holding `mib` MiB of PCM (stereo float32). */
const pcm = (mib) => ({ duration: 200, length: Math.round((mib * MB) / 8), numberOfChannels: 2 });
const bytesOf = (a) => [...a.bufBytes.values()].reduce((x, y) => x + y, 0);
/** fetch answering every URL with audio bytes of `sizeOf(url)` (default 8). */
function stubFetch(sizeOf = () => 8) {
  const orig = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return { ok: true, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new ArrayBuffer(sizeOf(u)) }; };
  return { urls, restore: () => { globalThis.fetch = orig; } };
}
const unlocked = (fw) => {
  const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
  a.install();
  fw.fire('pointerdown');
  return a;
};
const SFX = ['/assets/audio/sfx/t1.mp3', '/assets/audio/sfx/t2.mp3', '/assets/audio/sfx/t3.mp3'];

describe('the buffer cache around the own track (audio.js _buffer / _trimBuffers)', () => {
  test('an own track switched off, deleted or replaced while its file is read or decoded records nothing: the budget never leaks', async () => {
    // 9001 / 9003 bytes decode to 88 MiB of PCM (a 4 min song), over the whole 64 MiB budget; 9003 decodes when released
    const fw = fakeWindow({ bufFor: (ab) => (ab.byteLength >= 9000 ? pcm(88) : SMALL), hold: (ab) => ab.byteLength === 9003 });
    const f = stubFetch();
    try {
      const a = unlocked(fw);
      // switched off (setMediaOn, or 删除 → keepMusic(null)) while the file is still being read
      let finishRead = null;
      a.setLobbyTrack({ id: 'reading', read: () => new Promise((r) => { finishRead = () => r(new ArrayBuffer(9001)); }) });
      a.playBgm('lobby');
      await tick();
      assert.equal(typeof finishRead, 'function', 'the file is being read');
      a.setLobbyTrack(null);
      finishRead();
      await tick();
      // another file chosen while the previous one is still decoding
      a.setLobbyTrack({ id: 'decoding', read: async () => new ArrayBuffer(9003) });
      await tick();
      assert.equal(fw.made.held.length, 1, 'its decode is pending');
      a.setLobbyTrack({ id: 'next', read: async () => new ArrayBuffer(16) });
      fw.made.release();
      await tick();
      assert.equal(a.bgm?.loopUrl, `${LOCAL_BGM}next`);
      for (const id of ['reading', 'decoding']) {
        assert.ok(!a.bufBytes.has(LOCAL_BGM + id), `no size kept for ${id}`);
        assert.ok(!a.buffers.has(LOCAL_BGM + id), `no entry for ${id}`);
      }
      for (const url of a.bufBytes.keys()) assert.ok(a.buffers.has(url), `${url}: a size only beside its entry`);
      assert.ok(bytesOf(a) < 1 * MB, `the budget holds (${bytesOf(a)} bytes)`);
      // so a sound effect stays cached: added, then another sound decoded (a trim) — it is not evicted, nor fetched again
      a.preload([SFX[0]]);
      await tick();
      a.preload([SFX[1]]);
      await tick();
      assert.ok(a.buffers.has(SFX[0]) && a.buffers.has(SFX[1]));
      const fetched = f.urls.length;
      a.preload([SFX[0]]);
      await tick();
      assert.equal(f.urls.length, fetched, 'played again from the cache');
    } finally { f.restore(); }
  });

  test('a track larger than the whole budget: the sounds stay cached and so does the track while it plays; idle, it leaves first', async () => {
    const lobby = manifest.audio.bgm.lobby;
    // the official lobby loop as 70 MiB of PCM, the player's own track as 92 MiB, everything else small
    const fw = fakeWindow({ bufFor: (ab) => (ab.byteLength === 9001 ? pcm(92) : ab.byteLength === 9002 ? pcm(70) : SMALL) });
    const f = stubFetch((u) => (u === lobby.loop || u === mediaUrl(lobby.loop) ? 9002 : 8));
    try {
      const a = unlocked(fw);
      a.preload(SFX);
      await tick();
      // (before: `bgm` is still null while a track loads, so it flushed every sound and then itself)
      a.playBgm('lobby');
      await tick();
      assert.equal(a.bgm?.loopUrl, lobby.loop);
      assert.ok(a.buffers.has(lobby.loop), 'the playing loop stays cached');
      for (const u of SFX) assert.ok(a.buffers.has(u), u);
      let reads = 0;
      a.setLobbyTrack({ id: 'big', read: async () => { reads++; return new ArrayBuffer(9001); } });
      await tick();
      assert.equal(a.bgm?.loopUrl, `${LOCAL_BGM}big`);
      assert.ok(a.buffers.has(`${LOCAL_BGM}big`), 'the own track stays cached while it plays');
      assert.ok(!a.buffers.has(lobby.loop), 'the official loop, idle now, left first');
      for (const u of SFX) assert.ok(a.buffers.has(u), u);
      // the cache still works while the big track plays
      a.preload(['/assets/audio/sfx/t4.mp3']);
      await tick();
      for (const u of [...SFX, '/assets/audio/sfx/t4.mp3']) assert.ok(a.buffers.has(u), u);
      assert.ok(bytesOf(a) - a.bufBytes.get(`${LOCAL_BGM}big`) <= 64 * MB);
      // another lobby screen: the same track, not read again
      a.playBgm('lobby');
      await tick();
      assert.equal(reads, 1);
      // another screen's music: the idle own track leaves first, the sounds stay
      a.playBgm('prep');
      await tick();
      assert.equal(a.bgm?.loopUrl, manifest.audio.bgm.prep.loop);
      assert.ok(!a.buffers.has(`${LOCAL_BGM}big`));
      for (const u of SFX) assert.ok(a.buffers.has(u), u);
    } finally { f.restore(); }
  });

  test('a track the file check already decoded (decodeBytes) is cached as it is: not read, not decoded again', async () => {
    const fw = fakeWindow();
    const f = stubFetch();
    try {
      assert.equal(await new AudioManager({ win: fw.win }).decodeBytes(new ArrayBuffer(4)), null, 'no context before a gesture');
      const a = unlocked(fw);
      assert.deepEqual(await a.decodeBytes(new ArrayBuffer(4)), SMALL);
      a.playBgm('lobby');
      await tick();
      const decodes = fw.made.decoded.length;
      let reads = 0;
      a.setLobbyTrack({ id: 'checked', read: async () => { reads++; return new ArrayBuffer(5); }, decoded: { duration: 3, length: 100, numberOfChannels: 2 } });
      await tick();
      assert.equal(a.bgm?.loopUrl, `${LOCAL_BGM}checked`);
      assert.equal(reads, 0);
      assert.equal(fw.made.decoded.length, decodes);
      assert.equal(a.bufBytes.get(`${LOCAL_BGM}checked`), 800);
    } finally { f.restore(); }
  });
});

describe('the picture / video / music guards (ui/lobbyMedia.js)', () => {
  const bytes = (...parts) => new Uint8Array(parts.flatMap((x) => (typeof x === 'string' ? [...Buffer.from(x, 'latin1')] : x)));
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, len) => [...u32(len), ...Buffer.from(type, 'latin1'), ...new Array(len).fill(0), 0, 0, 0, 0];
  const PNG = [0x89, ...Buffer.from('PNG\r\n\x1a\n', 'latin1')];
  test('a picture that may move is told from its first bytes (GIF, APNG, animated WebP, AVIF sequence)', () => {
    assert.equal(isAnimatedImage(bytes(PNG, chunk('IHDR', 13), chunk('IDAT', 20), chunk('IEND', 0))), false, 'a PNG');
    assert.equal(isAnimatedImage(bytes(PNG, chunk('IHDR', 13), chunk('acTL', 8), chunk('fcTL', 26), chunk('IDAT', 20))), true, 'an APNG');
    assert.equal(isAnimatedImage(bytes(PNG, chunk('IHDR', 13), chunk('IDAT', 20), chunk('acTL', 8))), false, 'acTL after IDAT is not an APNG');
    assert.equal(isAnimatedImage(bytes('GIF89a', new Array(20).fill(0))), true, 'any GIF');
    const webp = (fourcc, flags) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', fourcc, [10, 0, 0, 0], [flags, 0, 0, 0], new Array(10).fill(0));
    assert.equal(isAnimatedImage(webp('VP8 ', 0)), false, 'a lossy WebP');
    assert.equal(isAnimatedImage(webp('VP8X', 0x10)), false, 'a WebP with alpha');
    assert.equal(isAnimatedImage(webp('VP8X', 0x12)), true, 'the WebP animation flag');
    const ftyp = (major, ...compat) => bytes(u32(16 + compat.length * 4), 'ftyp', major, [0, 0, 0, 0], ...compat, new Array(8).fill(0));
    assert.equal(isAnimatedImage(ftyp('avif', 'mif1', 'miaf')), false, 'an AVIF image');
    assert.equal(isAnimatedImage(ftyp('avis', 'msf1', 'avif')), true, 'an AVIF sequence');
    assert.equal(isAnimatedImage(ftyp('msf1', 'avis')), true, 'avis among the compatible brands');
    assert.equal(isAnimatedImage(bytes([0xff, 0xd8, 0xff, 0xe0], new Array(20).fill(0))), false, 'a JPEG');
    for (const b of [null, undefined, new Uint8Array(3)]) assert.equal(isAnimatedImage(b), false);
  });
  test('the kept sizes: a picture\'s longest edge 2560 px, a video up to 1080p (#643), music up to 6 minutes', () => {
    assert.equal(MAX_EDGE, 2560);
    assert.equal(MUSIC_MAX_S, 6 * 60);
    assert.deepEqual(fitEdge(4032, 3024), { w: 2560, h: 1920 }, 'a phone photo');
    assert.deepEqual(fitEdge(3000, 10000), { w: 768, h: 2560 });
    assert.deepEqual(fitEdge(1920, 1080), { w: 1920, h: 1080 }, 'kept as it is');
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1280, 720]]) assert.equal(videoTooLarge(w, h), false, `${w}×${h}`);
    for (const [w, h] of [[2560, 1440], [1920, 1200], [2048, 800], [3840, 2160]]) assert.equal(videoTooLarge(w, h), true, `${w}×${h}`);
  });
  test('a save that fails says 存储空间不足 only for a full quota', () => {
    assert.match(storageError({ name: 'QuotaExceededError' }), /存储空间不足/);
    assert.match(storageError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), /存储空间不足/);
    for (const err of [{ name: 'InvalidStateError' }, { name: 'UnknownError' }, new Error('IndexedDB open timed out'), null]) {
      assert.match(storageError(err), /存储不可用/);
    }
  });
});

test('lobby.css: the own backdrop and its dialog follow 文字大小, no !important / :has()', () => {
  const css = readFileSync(path.join(ROOT, 'public/css/screens/lobby.css'), 'utf8');
  const start = css.indexOf('/* ---- 大厅背景与音乐');
  assert.ok(start > 0);
  const block = css.slice(start, css.indexOf('/* ----', start + 10));
  const sizes = [...block.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(sizes.length >= 5);
  for (const v of sizes) assert.match(v, /^calc\(\.\d+ \* var\(--t\)\)$/, v);
  assert.ok(!/!important|:has\(/.test(block));
  assert.match(block, /\.hub-bg__own::after[^}]*var\(--own-dim/);
  assert.match(css.slice(css.lastIndexOf('prefers-reduced-motion')), /\.hub-bg__own/);
});
