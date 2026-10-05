// .p2tmp/mm-loading2.mjs — the stuck-loading screen, on purpose: hold one data file's response, get matched, and
// watch what the player sees. Then release it and check the match opens.
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import { startRealServer, Client, CHROME, hasChrome, OUT } from '../test/e2e/client.mjs';

if (!hasChrome()) { console.error('no Chrome at', CHROME); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIFF = 'FUNNY';
const HELD = 'effects.json';

const srv = await startRealServer({});
const wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
const searcher = (name) => {
  const ws = new WebSocket(wsUrl);
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'queue.join', difficulty: DIFF })); });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, version: 1 })));
  return ws;
};

const a = new Client(puppeteer, srv.base, 'A', { w: 1280, h: 720, prefix: 'mmstuck' });
await a.open();
await a.enter('卡载入测试');

// hold one data file: the response headers never arrive, exactly like a dropped tunnel
const held = [];
await a.page.setRequestInterception(true);
a.page.on('request', (req) => {
  if (req.url().includes(`/data/${HELD}`)) { held.push(req); console.log('holding', req.url()); return; }
  req.continue().catch(() => {});
});

await a.click('.mode-card', '同盟匹配');
await a.click('button', '开始搜寻队友');
await sleep(800);
const peers = [searcher('P2'), searcher('P3'), searcher('P4')];
await sleep(2500);

const screen = () => a.page.evaluate(() => {
  const p = document.querySelector('.gload p');
  const slow = document.querySelector('.gload__slow');
  const pending = globalThis.__SP__.data ? ['config', 'assets', 'chess', 'bonds', 'items', 'bands', 'enemies', 'bosses', 'stages', 'tokens', 'choices', 'effects', 'garrisons', 'factions', 'local'].filter((n) => globalThis.__SP__.data.status(n) === 'loading') : [];
  const s = globalThis.__SP__.store.get();
  return { text: p?.textContent ?? null, slowShown: !!slow, slowText: slow?.textContent?.replace(/\s+/g, ' ').trim() ?? null, pending, route: s.room ? (s.room.inMatch ? 'match' : 'room') : 'lobby' };
});

for (const wait of [1500, 6000]) {
  await sleep(wait);
  console.log(`t+ ~${wait}ms:`, JSON.stringify(await screen()));
}
await a.shot('stuck-1-hint');

console.log('--- releasing the held file ---');
for (const req of held) await req.continue().catch(() => {});
await sleep(2500);
console.log('after release:', JSON.stringify(await screen()));
await a.shot('stuck-2-opened');

console.log('problems:', JSON.stringify(a.problems.slice(0, 6)));
for (const p of peers) p.close();
await a.close();
await srv.stop();
console.log('screenshots in', OUT);
