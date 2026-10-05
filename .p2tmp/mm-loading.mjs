// .p2tmp/mm-loading.mjs — reproduce "匹配成功之后一直显示正在载入模拟数据…".
// One real browser searches in the lobby; three raw WS clients join the same pool; the fourth join forms the room
// and the match starts at once. Then we ask the page which in-match data file never settles.
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import { startRealServer, Client, CHROME, hasChrome, OUT } from '../test/e2e/client.mjs';

if (!hasChrome()) { console.error('no Chrome at', CHROME); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIFF = process.env.SP_DIFF || 'FUNNY';

const srv = await startRealServer({});
const wsUrl = `ws://127.0.0.1:${srv.port}/ws`;

/** A minimal protocol client (hello → queue.join), enough to fill the pool. */
function searcher(name) {
  const ws = new WebSocket(wsUrl);
  const seen = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); seen.push(m.t); if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'queue.join', difficulty: DIFF })); });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, version: 1 })));
  return { ws, seen, close: () => ws.close() };
}

const a = new Client(puppeteer, srv.base, 'A', { w: 1280, h: 720, prefix: 'mmload' });
await a.open();
await a.enter('载入测试');
await a.page.evaluate(() => { globalThis.__spData = []; });
await a.hookRequests();

await a.click('.mode-card', '同盟匹配');
await a.click('button', '开始搜寻队友');
await sleep(1200);
console.log('browser searching, server queued =', (await (await fetch(`${srv.base}/healthz`)).json()).queued);
await a.shot('1-searching');

const peers = [searcher('P2'), searcher('P3'), searcher('P4')];
await sleep(2500);
console.log('after 3 peers, server queued =', (await (await fetch(`${srv.base}/healthz`)).json()).queued);

// what the page sees now, and which files are still loading
const probe = () => a.page.evaluate(() => {
  const s = globalThis.__SP__.store.get();
  const d = globalThis.__SP__.data;
  const names = ['config', 'assets', 'chess', 'bonds', 'items', 'bands', 'enemies', 'bosses', 'stages', 'tokens', 'choices', 'effects', 'garrisons', 'factions', 'local'];
  const status = {};
  for (const n of names) status[n] = d.status(n);
  const notReady = Object.entries(status).filter(([, v]) => v !== 'ready' && v !== 'missing').map(([k, v]) => `${k}:${v}`);
  return {
    route: s.room ? (s.room.inMatch ? 'match' : 'room') : 'lobby',
    room: s.room ? s.room.code : null,
    inMatch: !!s.room?.inMatch,
    hasPublic: !!s.match.public,
    phase: s.match.public?.phase ?? null,
    notReady,
    status,
    loadingText: document.querySelector('.gload p')?.textContent ?? null,
  };
});

for (let i = 0; i < 8; i++) {
  await sleep(2500);
  const p = await probe();
  console.log(`t+${(i + 1) * 2.5}s route=${p.route} room=${p.room} inMatch=${p.inMatch} public=${p.hasPublic} phase=${p.phase} text=${JSON.stringify(p.loadingText)} notReady=${JSON.stringify(p.notReady)}`);
  if (i === 1) await a.shot('2-after-match-start');
  if (i === 4) console.log('   full status:', JSON.stringify(p.status));
}
await a.shot('3-stuck');

const reqs = await a.page.evaluate(() => (globalThis.__spReqLog || []).slice(-20));
console.log('problems:', JSON.stringify(a.problems.slice(0, 10)));
console.log('page requests seen by the harness:', JSON.stringify(reqs));
console.log('server log tail:', JSON.stringify(srv.logs.slice(-6)));

for (const p of peers) p.close();
await a.close();
await srv.stop();
console.log('screenshots in', OUT);
