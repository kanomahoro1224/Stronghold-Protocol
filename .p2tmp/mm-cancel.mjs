// .p2tmp/mm-cancel.mjs — reproduce the owner's report: 取消搜寻 does nothing, the search keeps running.
// Drives the real UI in real Chrome (no net.request shortcuts) and records every intent the UI sends, the
// toasts, the client store's queue, and the server's own /healthz `queued`.
import puppeteer from 'puppeteer-core';
import { startRealServer, Client, CHROME, hasChrome, OUT } from '../test/e2e/client.mjs';

if (!hasChrome()) { console.error('no Chrome at', CHROME); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startRealServer({});
const a = new Client(puppeteer, srv.base, 'A', { w: 1280, h: 720, prefix: 'mmcancel' });
await a.open();
await a.enter('取消测试');
await a.hookRequests();

const queued = async () => (await (await fetch(`${srv.base}/healthz`)).json()).queued;

// 1) pick 同盟匹配 (third card) and start the search
await a.click('.mode-card', '同盟匹配');
await a.shot('1-match-picked');
await a.click('button', '开始搜寻队友');
await sleep(1500);
const panelUp = await a.visible('.match-panel');
const q1 = await a.page.evaluate(() => globalThis.__SP__.store.get().queue);
console.log('after 开始搜寻队友: panel=%s queue=%j server.queued=%d', panelUp, q1, await queued());
await a.shot('2-searching');

// 2) click 取消搜寻 exactly like a player: a real mouse click on the visible button
const clicked = await a.click('button', '取消搜寻', { timeout: 5000, optional: true });
console.log('clicked 取消搜寻: %s', clicked);
if (clicked) await a.shot('3-after-click');
await sleep(2500);

const panelAfter = await a.visible('.match-panel');
const q2 = await a.page.evaluate(() => globalThis.__SP__.store.get().queue);
console.log('after 取消搜寻 2.5s: panel=%s queue=%j server.queued=%d', panelAfter, q2, await queued());
console.log('intents sent:', JSON.stringify(await a.requests()));
console.log('toasts:', JSON.stringify(await a.toasts()));
console.log('problems:', JSON.stringify(a.problems.slice(0, 8)));
await a.shot('4-final');

// 3) what the page thinks: the store, plus whether the panel is still rendered
console.log('panel html:', (await a.page.evaluate(() => document.querySelector('.match-panel')?.innerText?.slice(0, 120) || null)));
console.log('server log tail:', JSON.stringify(srv.logs.slice(-6)));

await a.close();
await srv.stop();
console.log('screenshots in', OUT);
