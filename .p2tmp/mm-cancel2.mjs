// .p2tmp/mm-cancel2.mjs — what the owner saw: the search never stops. Reproduce the production-shaped cases the
// happy path does not cover — a silently dead socket (frames go nowhere, no close event), and a reconnect — and
// report what the UI does in each. Nothing here talks to production.
import puppeteer from 'puppeteer-core';
import { startRealServer, Client, CHROME, hasChrome, OUT } from '../test/e2e/client.mjs';

if (!hasChrome()) { console.error('no Chrome at', CHROME); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queued = async (base) => (await (await fetch(`${base}/healthz`)).json()).queued;

const srv = await startRealServer({});
const a = new Client(puppeteer, srv.base, 'A', { w: 1280, h: 720, prefix: 'mmcancel2' });
await a.open();
await a.enter('取消测试');
await a.hookRequests();

const state = async (tag) => {
  const panel = await a.visible('.match-panel');
  const q = await a.page.evaluate(() => globalThis.__SP__.store.get().queue);
  const status = await a.page.evaluate(() => globalThis.__SP__.net.snapshot());
  console.log(`${tag}: panel=${panel} queue=${q ? `${q.size}/${q.max}` : 'null'} status=${status.status} server.queued=${await queued(srv.base)} toasts=${JSON.stringify(await a.toasts())}`);
};

// --- case 1: a socket that silently swallows everything (dead TCP, no close event) -------------------------------
await a.click('.mode-card', '同盟匹配');
await a.click('button', '开始搜寻队友');
await sleep(1200);
await state('C1 searching          ');

console.log('-- swallowing outgoing frames (the socket looks open, nothing reaches the server) --');
await a.page.evaluate(() => { const ws = globalThis.__SP__.net.ws; globalThis.__swallowed = []; ws.send = (d) => { globalThis.__swallowed.push(String(d).slice(0, 60)); }; });
const t0 = Date.now();
const clickedOk = await a.click('button', '取消搜寻', { timeout: 5000, optional: true });
console.log(`C1 clicked=${clickedOk}`);
await sleep(16000); // longer than the request timeout: what does the player see, and what does the server think?
await state('C1 after cancel (16s)');
console.log('swallowed frames:', JSON.stringify(await a.page.evaluate(() => globalThis.__swallowed || [])));
await a.shot('C1-dead-socket');

// --- case 2: the same click, but now the client knows it is disconnected (reconnecting) --------------------------
console.log('-- forcing a real reconnect and cancelling during it --');
await a.page.evaluate(() => { globalThis.__SP__.net.reconnectNow(); });
const clicked2 = await a.click('button', '取消搜寻', { timeout: 8000, optional: true });
console.log(`C2 clicked=${clicked2}`);
await sleep(4000);
await state('C2 after cancel       ');
await a.shot('C2-after-reconnect');

console.log('intents sent:', JSON.stringify(await a.requests()));
console.log('problems:', JSON.stringify(a.problems.slice(0, 6)));
await a.close();
await srv.stop();
console.log('screenshots in', OUT);
