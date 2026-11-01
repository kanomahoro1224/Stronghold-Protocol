// Real-server browser E2E — 大厅背景与音乐 (one topbar button, 2026-11-01). The lobby's 大厅背景与音乐 dialog is the
// project's Modal and holds the 大厅背景 panel (ui/hubBackdrop.js BackdropSettings) plus the player's own music
// (ui/lobbyMedia.js). The panel offers four generated scenes (夜巡 / 霜原 / 烬野 / 静默: one shows at once and is kept),
// ten built-in 鹿乃 photos, and the player's own picture or video through its file input: it covers the official backdrop
// at once, 暗化 darkens it, and it is still there after a reload (IndexedDB). A WebM video (recorded in the page)
// replaces it and plays muted under the site CSP. A file that is not what it says is refused in the panel and changes
// nothing. Own music (a WAV written here) becomes the lobby's track (played when the page's audio runs) and switching it
// off gives the official track back; the switches survive a reload. 移除背景 / 删除 each give the default back. Esc closes
// the dialog and gives the focus back; on a phone in landscape the dialog stays on screen. No console error (a CSP
// refusal is one).
// The guards (#643's limits, #814 review): a still picture past 2560 px is scaled down to 2560 (re-encoded as JPEG on the
// hub's ground colour), a video past 1080p (1952 px wide) and music longer than 6 minutes (told by its metadata, or by its
// decode) are refused with their own message.
//
//   SP_E2E=1 node --test test/ui/lobby-media.e2e.test.js
//
// Screenshots: test/e2e/out/lobby-media-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, ROOT, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));

/** A mono 16-bit WAV of a sine (`seconds` long). */
function wav(seconds = 1, rate = 22050) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  return b;
}
/** A PNG (or a WebM) of w×h drawn in the page; `clear`: the left quarter left transparent. */
const canvasFile = (c, { kind = 'png', w, h, clear = false }) => c.page.evaluate(async ({ kind, w, h, clear }) => {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  const paint = (k) => { g.clearRect(0, 0, w, h); g.fillStyle = `hsl(${(k * 50) % 360} 60% 45%)`; g.fillRect(clear ? w / 4 : 0, 0, w, h); };
  let blob;
  if (kind === 'png') { paint(1); blob = await new Promise((r) => cv.toBlob(r, 'image/png')); } else {
    const rec = new MediaRecorder(cv.captureStream(10), { mimeType: 'video/webm' });
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    for (let k = 0; k < 6; k++) { paint(k); await new Promise((r) => setTimeout(r, 100)); }
    rec.stop();
    await stopped;
    blob = new Blob(parts, { type: 'video/webm' });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}, { kind, w, h, clear }).then((b64) => Buffer.from(b64, 'base64'));

/**
 * The page's problems, less the reads it cancels itself: a check stops reading a chosen file once its metadata answers
 * (a video's size, the music's length), and the browser reports the rest of that blob: read as aborted.
 */
const pageProblems = (c) => problemsOf([c]).filter((p) => !/requestfailed: blob:\S+ net::ERR_ABORTED$/.test(p));
const toastWith = (c, re) => c.page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), { timeout: 30000 }, re.source);
/** The panel's own refusal line (BackdropSettings keeps the thrown message in .lobby-media-error). */
const panelErrorWith = (c, re) => c.page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.lobby-media-error')?.textContent ?? ''), { timeout: 30000 }, re.source);

/** The hub backdrop and the dialog's readout, as the page sees them. */
const media = (c) => c.page.evaluate(async () => {
  const { audio } = await import('/js/audio.js');
  const bg = document.querySelector('.hub-bg');
  const photo = bg?.querySelector('.hub-bg__photo'), video = bg?.querySelector('.hub-bg__video');
  const shade = bg?.querySelector('.hub-bg__shade');
  const selected = document.querySelector('.bgset__theme.is-selected');
  return {
    scene: bg?.dataset.scene ?? null,
    motion: bg?.dataset.motion ?? null,
    own: photo ? 'image' : video ? 'video' : null,
    photoUrl: photo ? getComputedStyle(photo).backgroundImage : null,
    video: video ? { ready: video.readyState, muted: video.muted, loop: video.loop, w: video.videoWidth } : null,
    dim: shade ? getComputedStyle(shade).opacity : null,
    theme: selected?.dataset.theme ?? null,
    musicName: document.querySelector('[data-testid="media-music-name"]')?.textContent ?? null,
    lobbyTrack: audio.lobbyTrack ? audio.lobbyTrack.id : null,
    lobbyLoop: audio._bgmTrack('lobby')?.loop ?? null,
    playing: audio.bgm?.loopUrl ?? null,
    ctx: audio.ctx?.state ?? null,
    musicPref: localStorage.getItem('sp.pref.lobby.media'),
    bgPref: localStorage.getItem('sp.pref.hub.backdrop'),
  };
});
const openDialog = async (c) => {
  await c.click('[data-testid="lobby-media"]');
  await c.page.waitForSelector('.modal__box.lmedia', { visible: true });
};
const upload = async (c, slot, file) => {
  const input = await c.page.$(`[data-testid="media-${slot}-file"]`);
  await input.uploadFile(file);
};
/** The backdrop picture as the page shows it: its natural size and one pixel of it (the re-encode keeps no alpha). */
const shownPicture = (c) => c.page.evaluate(async () => {
  const el = document.querySelector('.hub-bg__photo');
  const url = /url\("?([^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage)?.[1];
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0);
  return { w: img.naturalWidth, h: img.naturalHeight, corner: [...g.getImageData(2, 2, 1, 1).data] };
});

describe('自定义大厅背景与音乐 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('one button: scenes, the player\'s own picture / video / music, kept after a reload, switched off, removed; a phone', { timeout: 4 * 60 * 1000 }, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobby-media-e2e-'));
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'media', { prefix: 'lobby-media' });
    try {
      await c.open();
      await c.enter('凯尔希');
      const files = {
        png: path.join(tmp, '我的背景.png'), webm: path.join(tmp, 'loop.webm'), wav: path.join(tmp, '大厅曲.wav'), fake: path.join(tmp, 'not-a-picture.png'),
      };
      writeFileSync(files.png, await canvasFile(c, { w: 320, h: 180 }));
      writeFileSync(files.webm, await canvasFile(c, { kind: 'webm', w: 320, h: 180 }));
      writeFileSync(files.wav, wav());
      writeFileSync(files.fake, 'this is text, not a picture');

      // the dialog: the defaults (夜巡 over the official layers), 完成 has the focus
      await openDialog(c);
      let m = await media(c);
      assert.equal(m.own, null);
      assert.equal(m.scene, 'night');
      assert.equal(m.theme, 'night');
      assert.equal(m.musicName, '默认音乐');
      assert.equal(await c.page.evaluate(() => document.activeElement?.textContent?.trim()), '完成');

      // 大厅场景: a generated scene at once, kept in the pref; 夜巡 takes it back
      await c.click('.bgset__theme[data-theme="frost"]');
      await c.page.waitForFunction(() => document.querySelector('.hub-bg')?.dataset.scene === 'frost');
      assert.equal(JSON.parse(await c.page.evaluate(() => localStorage.getItem('sp.pref.hub.backdrop'))).theme, 'frost');
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.modal__box.lmedia'));
      await c.shot('hub-scene-frost');
      await openDialog(c);
      await c.click('.bgset__theme[data-theme="night"]');
      await c.page.waitForFunction(() => document.querySelector('.hub-bg')?.dataset.scene === 'night');

      // own picture: over the official backdrop at once; 暗化 darkens it
      await upload(c, 'backdrop', files.png);
      await c.page.waitForFunction(() => document.querySelector('.hub-bg__photo'), { timeout: 15000 });
      m = await media(c);
      assert.equal(m.own, 'image');
      assert.equal(m.theme, 'custom');
      assert.equal(m.dim, '0.45', 'sanitizeBackdrop\'s default 暗化');
      await c.page.$eval('[data-testid="media-dim"]', (el) => { el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await c.page.waitForFunction(() => getComputedStyle(document.querySelector('.hub-bg__shade')).opacity === '0.6');
      await c.shot('dialog');

      // a file that is not what it says: refused in the panel, nothing changes
      await upload(c, 'backdrop', files.fake);
      await panelErrorWith(c, /请选择图片、MP4 或 WebM 视频/);
      assert.equal((await media(c)).own, 'image');

      // own music: the lobby's track, played from its bytes (test/ui/lobby-media.test.js: never a request)
      await upload(c, 'music', files.wav);
      await c.page.waitForFunction(async () => (await import('/js/audio.js')).audio.lobbyTrack != null, { timeout: 15000 });
      m = await media(c);
      assert.equal(m.musicName, '大厅曲.wav');
      assert.match(m.lobbyLoop, /^local-bgm:/);
      if (m.ctx === 'running') {
        await c.page.waitForFunction(async () => /^local-bgm:/.test((await import('/js/audio.js')).audio.bgm?.loopUrl || ''), { timeout: 10000 });
      }
      // off: the official track again; the choice is kept
      await c.click('[data-testid="media-music-on"]');
      m = await media(c);
      assert.equal(m.lobbyTrack, null);
      assert.equal(m.musicName, '默认音乐');
      assert.deepEqual(JSON.parse(m.musicPref), { music: false });

      // Esc closes it and gives the focus back
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.modal__box.lmedia'));
      assert.equal(await c.page.evaluate(() => document.activeElement?.dataset?.testid || null), 'lobby-media');
      await c.shot('hub-own-picture');

      // a reload: the picture (IndexedDB) and the switches stay; music on again
      await c.page.reload({ waitUntil: 'domcontentloaded' });
      await c.page.waitForSelector('.lobby-screen');
      await c.page.waitForFunction(() => document.querySelector('.hub-bg__photo'), { timeout: 15000 });
      await openDialog(c);
      m = await media(c);
      assert.equal(m.own, 'image');
      assert.equal(m.dim, '0.6');
      assert.equal(m.lobbyTrack, null);
      await c.click('[data-testid="media-music-on"]');
      await c.page.waitForFunction(async () => (await import('/js/audio.js')).audio.lobbyTrack != null);

      // a video instead of the picture: muted, looping, playing under the site CSP
      await upload(c, 'backdrop', files.webm);
      await c.page.waitForFunction(() => document.querySelector('.hub-bg__video')?.readyState >= 2, { timeout: 15000 });
      m = await media(c);
      assert.equal(m.own, 'video');
      assert.ok(m.video.muted && m.video.loop && m.video.w > 0, JSON.stringify(m.video));

      // a phone in landscape: the dialog stays on screen
      // (switching to a touch viewport reloads the page: the files come back from IndexedDB)
      await c.page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
      await c.page.waitForFunction(() => document.querySelector('.hub-bg__video')?.readyState >= 2, { timeout: 15000 });
      await openDialog(c);
      const box = await c.page.$eval('.modal__box.lmedia', (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight }; });
      assert.ok(box.l >= 0 && box.t >= 0 && box.r <= box.w + 0.5 && box.b <= box.h + 0.5, JSON.stringify(box));
      await c.page.screenshot({ path: path.join(ROOT, 'test/e2e/out/lobby-media-phone.png') });
      await c.page.setViewport({ width: 1920, height: 1080, isMobile: false, hasTouch: false });
      await c.page.waitForSelector('.lobby-screen');
      await openDialog(c);

      // 移除背景 / 删除: back to the default backdrop and the official music
      await c.click('[data-testid="media-backdrop-remove"]');
      await c.click('[data-testid="media-music-remove"]');
      await c.page.waitForFunction(() => !document.querySelector('[data-testid="media-backdrop-remove"], [data-testid="media-music-remove"]'));
      await c.page.waitForFunction(() => document.querySelector('.hub-bg')?.dataset.scene === 'night');
      m = await media(c);
      assert.equal(m.own, null);
      assert.equal(m.lobbyTrack, null);
      assert.equal(m.musicName, '默认音乐');

      assert.deepEqual(pageProblems(c), []);
    } finally {
      await c.close();
      await srv.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  test('the guards: a large picture scaled down; a video past 1080p and long music refused', { timeout: 4 * 60 * 1000 }, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobby-media-e2e-'));
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'guards', { prefix: 'lobby-media-guards' });
    try {
      await c.open();
      await c.enter('凯尔希');
      const files = {
        big: path.join(tmp, 'wide.png'), videoWide: path.join(tmp, 'wide.webm'),
        long: path.join(tmp, 'long.wav'), longish: path.join(tmp, 'longish.wav'),
      };
      writeFileSync(files.big, await canvasFile(c, { w: 3000, h: 600, clear: true }));
      // past MAX_VIDEO_EDGE's 1920 px edge but cheap to encode: a 2560×1440 recording came out as an empty 110-byte WebM
      // on a loaded machine (the 1080p message never came; the pixel-count branch is unit-tested in lobby-video.test.js)
      const wide = await canvasFile(c, { kind: 'webm', w: 1952, h: 208 });
      assert.ok(wide.length > 1000, `the video fixture recorded frames (${wide.length} bytes)`);
      writeFileSync(files.videoWide, wide);
      writeFileSync(files.long, wav(400, 8000)); // 6 min 40 s: its metadata says too long, nothing decoded
      writeFileSync(files.longish, wav(370, 8000)); // 6 min 10 s: decoded, then refused by its decoded length
      await openDialog(c);

      // a still picture past 2560 px: scaled down to 2560 on its longest side and re-encoded on the hub's ground colour
      await upload(c, 'backdrop', files.big);
      await c.page.waitForFunction(() => document.querySelector('.hub-bg__photo'), { timeout: 20000 });
      const shown = await shownPicture(c);
      assert.deepEqual({ w: shown.w, h: shown.h }, { w: 2560, h: 512 });
      assert.equal(shown.corner[3], 255, 'a transparent picture is re-encoded onto the hub ground colour');
      assert.equal((await media(c)).theme, 'custom');

      // refused, each with its own reason; the picture stays
      await upload(c, 'backdrop', files.videoWide);
      await panelErrorWith(c, /1080p/);
      assert.equal((await media(c)).own, 'image');
      await upload(c, 'music', files.long);
      await toastWith(c, /6 分钟/);
      await c.page.waitForFunction(async () => (await import('/js/ui/lobbyMedia.js')).mediaStore.get().busy == null);
      // (the same text again while it shows would only count up on that toast: wait until it is gone)
      await c.page.waitForFunction(() => ![...document.querySelectorAll('.toast')].some((t) => /6 分钟/.test(t.textContent)), { timeout: 15000 });
      await upload(c, 'music', files.longish);
      await toastWith(c, /6 分钟/);
      await c.page.waitForFunction(async () => (await import('/js/ui/lobbyMedia.js')).mediaStore.get().busy == null);
      assert.equal((await media(c)).musicName, '默认音乐');

      assert.deepEqual(pageProblems(c), []);
    } finally {
      await c.close();
      await srv.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
