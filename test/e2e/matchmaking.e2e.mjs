// test/e2e/matchmaking.e2e.mjs — end-to-end checks for 同盟匹配 (DESIGN §26) that a unit test cannot reach: they drive
// a real browser against a real server.
//
//   node --test test/e2e/matchmaking.e2e.mjs        (or: node test/e2e/matchmaking.e2e.mjs)
//
// Needs Chrome: set CHROME_PATH (see test/e2e/client.mjs for the platform defaults). Two defects of the first release
// are locked down here:
//   1. 取消搜寻 swallowed by a half-open socket (the frame never reaches the server, the player stays queued and could
//      still be pulled into a match): the click must leave the search at once and the client must keep re-sending the
//      cancel until the server confirms.
//   2. A matched player whose match data stalls: the loading screen must name the file instead of spinning forever,
//      and the match must open once the file arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import { startRealServer, Client, CHROME, hasChrome, OUT } from './client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIFF = 'FUNNY';
const GAME_FILES = ['config', 'assets', 'chess', 'bonds', 'items', 'bands', 'enemies', 'bosses', 'stages', 'tokens',
  'choices', 'effects', 'garrisons', 'factions', 'local'];

/** Minimal protocol client: enough to fill a matchmaking pool. */
function searcher(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'queue.join', difficulty: DIFF })); });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, version: 1 })));
  return ws;
}

const queued = async (base) => (await (await fetch(`${base}/healthz`)).json()).queued;

test('同盟匹配: 取消搜寻 leaves the queue at once, and survives a frame the network swallowed', { timeout: 240_000 }, async (t) => {
  if (!hasChrome()) { t.skip(`no Chrome at ${CHROME}`); return; }
  const srv = await startRealServer({});
  const c = new Client(puppeteer, srv.base, 'A', { w: 1280, h: 720, prefix: 'mme2e' });
  try {
    await c.open();
    await c.enter('取消E2E');
    await c.hookRequests();
    await c.click('.mode-card', '同盟匹配');
    await c.click('button', '开始搜寻队友');
    await sleep(3400);
    assert.equal(await c.visible('.match-panel'), true, 'the search panel shows');
    assert.equal(await queued(srv.base), 1, 'the server has the session in the pool');

    // (1a) a normal cancel: the panel goes at once and the server drops the entry
    await c.click('button', '取消搜寻');
    await sleep(200);
    assert.equal(await c.visible('.match-panel'), false, 'the panel is gone on the click, not after the round trip');
    await sleep(1500);
    assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().queue), null);
    assert.equal(await queued(srv.base), 0, 'the server left the pool');

    // (1b) the socket swallows everything (a half-open connection): the client must reconnect and re-send the cancel
    await c.click('button', '开始搜寻队友');
    await sleep(3400);
    assert.equal(await queued(srv.base), 1);
    await c.page.evaluate(() => { const ws = globalThis.__SP__.net.ws; globalThis.__swallowed = []; ws.send = (d) => globalThis.__swallowed.push(String(d).slice(0, 40)); });
    await c.click('button', '取消搜寻');
    await sleep(200);
    assert.equal(await c.visible('.match-panel'), false, 'out of the search immediately');
    for (let i = 0; i < 20 && (await queued(srv.base)) !== 0; i++) await sleep(1000);
    assert.equal(await queued(srv.base), 0, 'the retry after the reconnect removed the pool entry');
    const swallowed = await c.page.evaluate(() => globalThis.__swallowed);
    assert.ok(swallowed.some((m) => m.includes('queue.leave')), `the first cancel was swallowed: ${JSON.stringify(swallowed)}`);
    assert.ok(await c.page.evaluate(() => globalThis.__SP__.net.snapshot().status) === 'online', 'the client is back online');
    assert.deepEqual(c.problems, [], 'no page errors');
  } finally {
    await c.close();
    await srv.stop();
  }
});

test('同盟匹配: a stalled match-data file is named on the loading screen and the match opens when it arrives', { timeout: 240_000 }, async (t) => {
  if (!hasChrome()) { t.skip(`no Chrome at ${CHROME}`); return; }
  const srv = await startRealServer({});
  const c = new Client(puppeteer, srv.base, 'A', { w: 1280, h: 720, prefix: 'mme2e' });
  const peers = [];
  const held = [];
  try {
    await c.open();
    await c.enter('载入E2E');
    // Hold one data file: its response headers never arrive, like a dropped tunnel.
    await c.page.setRequestInterception(true);
    c.page.on('request', (req) => {
      if (req.url().includes('/data/effects.json')) { held.push(req); return; }
      req.continue().catch(() => {});
    });
    await c.click('.mode-card', '同盟匹配');
    await c.click('button', '开始搜寻队友');
    await sleep(800);
    peers.push(searcher(srv.port, 'P2'), searcher(srv.port, 'P3'), searcher(srv.port, 'P4'));
    await sleep(3800);

    const screen = () => c.page.evaluate((names) => ({
      text: document.querySelector('.gload p')?.textContent ?? null,
      slow: document.querySelector('.gload__slow')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      pending: names.filter((n) => globalThis.__SP__.data.status(n) === 'loading'),
      inMatch: !!globalThis.__SP__.store.get().room?.inMatch,
    }), GAME_FILES);

    let s = await screen();
    assert.equal(s.inMatch, true, 'the match started');
    assert.equal(s.text, '正在载入模拟数据…');
    for (let i = 0; i < 12 && !(await screen()).slow; i++) await sleep(1000);
    s = await screen();
    assert.deepEqual(s.pending, ['effects'], 'the stalled file is the one still loading');
    assert.match(s.slow ?? '', /effects/, 'the screen names the file that did not arrive');
    assert.match(s.slow ?? '', /重试/, 'and offers a retry');
    await c.shot('stalled-data');

    for (const req of held) await req.continue().catch(() => {});
    for (let i = 0; i < 20 && (await screen()).text; i++) await sleep(1000);
    assert.equal((await screen()).text, null, 'the match opens once the file arrives');
    assert.deepEqual(c.problems, [], 'no page errors');
  } finally {
    for (const p of peers) p.close();
    await c.close();
    await srv.stop();
    console.log('screenshots in', OUT);
  }
});
