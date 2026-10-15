// 头像 P2P 端到端（需要 Chrome，约 60 s）:
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/peer-avatars.e2e.test.js
//
// 头像不经服务器：两个浏览器同房，各自的头像走 WebRTC DataChannel 直接到对方座位上（ui/peerAvatars.js），
// 服务器只转发 SDP/ICE（server/lobby.js rtcSignal）。这个 e2e 用两个独立浏览器上下文（各自的 localStorage）
// 走真实 WS + 真实 WebRTC：断言对方座位拿到的是**本机那张图**，断言 WS 出站帧里出现过 rtc.signal、但从未出现
// 头像本身，并断言关掉「头像 P2P」后不再互传。截图写 test/e2e/out/p2p-*.png。静态对照 test/ui/peer-avatars.test.js。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const shot = (name) => fileURLToPath(new URL(`../e2e/out/${name}.png`, import.meta.url));

describe('头像 P2P between two browsers in one room (headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    // clientBuild: false — the source modules are what this feature lives in (and what the page under test loads)
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, clientBuild: false });
    const P = (await import('puppeteer-core')).default;
    browser = await P.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
    mkdirSync(new URL('../e2e/out/', import.meta.url), { recursive: true });
  });

  after(async () => { await browser?.close(); await srv?.close(); });

  /** A returning player with their own avatar (an 8×8 canvas: a valid, distinct PNG data URL) and optional settings. */
  async function open(name, color, tag, settings = null) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument((n, c, tg, s) => {
      localStorage.setItem('sp.name', n);
      sessionStorage.setItem('sp.entered', '1');
      if (s) localStorage.setItem('sp.pref.settings', JSON.stringify(s));
      const cv = document.createElement('canvas'); cv.width = cv.height = 8;
      const ctx = cv.getContext('2d'); ctx.fillStyle = c; ctx.fillRect(0, 0, 8, 8);
      localStorage.setItem('sp.pref.localAccount', JSON.stringify({ tag: tg, avatar: cv.toDataURL('image/png') }));
      // every frame this page puts on the socket: the avatar must never be among them
      globalThis.__sent = [];
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) { try { globalThis.__sent.push(String(data)); } catch { /* ignore */ } return orig.call(this, data); };
    }, name, color, tag, settings);
    await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.lobby-screen', { timeout: 30000 });
    return { context, page, problems };
  }

  const send = (page, t, fields) => page.evaluate(async (tt, ff) => {
    const { net } = await import('/js/net.js');
    net.send(tt, ff);
  }, t, fields);
  const roomCode = (page) => page.evaluate(async () => (await import('/js/store.js')).store.get().room?.code || null);
  /** The seats as the screen shows them: name, the avatar's own data URL (or ''), and the #tag. */
  const seats = (page) => page.evaluate(() => [...document.querySelectorAll('.rseat')].map((s) => ({
    name: (s.querySelector('.rseat__name')?.textContent || '').trim(),
    src: s.querySelector('.avatar__img img')?.getAttribute('src') || '',
    tag: s.querySelector('.acct-tag')?.textContent || '',
  })));
  const seatOf = (rows, name) => rows.find((r) => r.name.includes(name)) || {};
  const waitAvatar = (page, other) => page.waitForFunction((nm) => {
    for (const seat of document.querySelectorAll('.rseat')) {
      if (!(seat.querySelector('.rseat__name')?.textContent || '').includes(nm)) continue;
      const img = seat.querySelector('.avatar__img img');
      if (img && /^data:image\/png/.test(img.getAttribute('src') || '')) return true;
    }
    return false;
  }, { timeout: 30000, polling: 250 }, other);

  async function room(t) {
    const a = await open('A博士', '#ff0044', '1111');
    const b = await open('B博士', '#00aaff', '2222');
    t.after(async () => { await a.context.close(); await b.context.close(); });
    await send(a.page, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
    const code = await a.page.waitForFunction(async () => (await import('/js/store.js')).store.get().room?.code || null,
      { timeout: 20000, polling: 200 }).then(() => roomCode(a.page));
    assert.ok(code, 'the host must get a room');
    await send(b.page, 'room.join', { code });
    await b.page.waitForFunction(async () => {
      const { store } = await import('/js/store.js');
      return (store.get().room?.seats || []).filter(Boolean).length === 2;
    }, { timeout: 20000, polling: 200 });
    return { a, b, code };
  }

  test('teammates see each other\'s avatar, and the server only ever carried the signaling', async (t) => {
    const { a, b } = await room(t);
    await Promise.all([waitAvatar(a.page, 'B博士'), waitAvatar(b.page, 'A博士')]);

    const rowsA = await seats(a.page), rowsB = await seats(b.page);
    const mineA = seatOf(rowsA, 'A博士'), theirsA = seatOf(rowsA, 'B博士');
    const mineB = seatOf(rowsB, 'B博士'), theirsB = seatOf(rowsB, 'A博士');
    // A holds A's own avatar, B holds B's — and each one sees the other's, over the DataChannel
    assert.match(mineA.src, /^data:image\/png/, JSON.stringify(rowsA));
    assert.match(theirsA.src, /^data:image\/png/, JSON.stringify(rowsA));
    assert.match(mineB.src, /^data:image\/png/, JSON.stringify(rowsB));
    assert.match(theirsB.src, /^data:image\/png/, JSON.stringify(rowsB));
    assert.equal(theirsA.src, mineB.src, 'A must show exactly the image B owns');
    assert.equal(theirsB.src, mineA.src, 'B must show exactly the image A owns');
    assert.notEqual(mineA.src, theirsA.src, 'the two avatars are different pictures');
    // the #tag travels with it (it is part of the same account payload)
    assert.equal(theirsA.tag, '#2222');
    assert.equal(theirsB.tag, '#1111');

    // the socket carried the signaling, never the avatar
    const sentA = await a.page.evaluate(() => globalThis.__sent || []);
    const sentB = await b.page.evaluate(() => globalThis.__sent || []);
    for (const [label, frames] of [['A', sentA], ['B', sentB]]) {
      assert.equal(frames.some((f) => f.includes('rtc.signal')), true, `${label} must have sent signaling`);
      assert.equal(frames.some((f) => f.includes('data:image/')), false, `${label} sent the avatar over the socket`);
      assert.equal(frames.some((f) => f.includes('base64')), false, `${label} sent image bytes over the socket`);
    }
    assert.deepEqual(a.problems, []);
    assert.deepEqual(b.problems, []);

    await a.page.screenshot({ path: shot('p2p-a') });
    await b.page.screenshot({ path: shot('p2p-b') });
  });

  test('设置 →「头像 P2P」 off: nothing is exchanged, the seat falls back to the namecard', async (t) => {
    const a = await open('A博士', '#ff0044', '1111');
    // B turned the feature off: no mesh, so B neither sends nor accepts an avatar
    const b = await open('B博士', '#00aaff', '2222', { p2pAvatar: false });
    t.after(async () => { await a.context.close(); await b.context.close(); });
    await send(a.page, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
    const code = await a.page.waitForFunction(async () => (await import('/js/store.js')).store.get().room?.code || null,
      { timeout: 20000, polling: 200 }).then(() => roomCode(a.page));
    await send(b.page, 'room.join', { code });
    await b.page.waitForFunction(async () => {
      const { store } = await import('/js/store.js');
      return (store.get().room?.seats || []).filter(Boolean).length === 2;
    }, { timeout: 20000, polling: 200 });

    // give the mesh every chance to form before asserting it did not
    await new Promise((r) => setTimeout(r, 7000));
    const rowsA = await seats(a.page), rowsB = await seats(b.page);
    assert.equal(seatOf(rowsA, 'B博士').src, '', JSON.stringify(rowsA));
    assert.equal(seatOf(rowsB, 'A博士').src, '', JSON.stringify(rowsB));
    // each page still shows its own avatar (the local account is untouched)
    assert.match(seatOf(rowsA, 'A博士').src, /^data:image\/png/);
    assert.equal(seatOf(rowsA, 'B博士').tag, '');
    assert.deepEqual(a.problems, []);
    assert.deepEqual(b.problems, []);
  });
});
