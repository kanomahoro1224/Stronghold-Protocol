// .p2tmp/emote-probe.mjs — Phase 4 instrument for "the 交流 button lost its sprite and the panel is invisible".
// Drives a real Chrome through a real local match and reports exactly what the client resolved for the UI sprites:
// the manifest status, the URL it put in --ewheel-btn, whether that URL loads in the page, and any broken <img>.
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import { startRealServer, Client, hasChrome, CHROME } from '../test/e2e/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIFF = 'FUNNY';

function searcher(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'queue.join', difficulty: DIFF })); });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, version: 1 })));
  return ws;
}

const probeWheel = (c) => c.page.evaluate(async () => {
  const d = globalThis.__SP__?.data;
  const btn = document.querySelector('.ewheel__btn');
  const panel = document.querySelector('.ewheel__panel');
  const loadTest = (url) => new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ url, ok: true, w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => res({ url, ok: false });
    i.src = url;
  });
  const urls = ['/assets/local/ui/battle/emoji_btn.png', '/assets/local/ui/battle/emoji_bkg.png', '/assets/local/ui/battle/emoji_cell_bkg.png'];
  return {
    hasSP: !!globalThis.__SP__,
    localStatus: d?.status?.('local') ?? null,
    assetsStatus: d?.status?.('assets') ?? null,
    manifestEntry: d?.get?.('local')?.groups?.['ui/battle']?.emoji_btn ?? null,
    hasWheel: !!document.querySelector('.ewheel'),
    btnClass: btn?.className ?? null,
    btnVar: (btn?.style?.getPropertyValue('--ewheel-btn') || '').trim() || null,
    btnBg: btn ? getComputedStyle(btn).backgroundImage : null,
    btnText: btn?.textContent?.trim() ?? null,
    btnHasSvg: btn ? !!btn.querySelector('svg') : null,
    panelClass: panel?.className ?? null,
    panelVar: (panel?.style?.getPropertyValue('--ewheel-bg') || '').trim() || null,
    imgTests: await Promise.all(urls.map(loadTest)),
    brokenImgs: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src).slice(0, 6),
    cssLinks: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => getComputedStyle(l).href || l.href).slice(0, 8),
  };
});

// Where does the "交流" text live, and is anything around it broken? This is the element the user is looking at.
const dumpLabel = (c) => c.page.evaluate(() => {
  const hits = [...document.querySelectorAll('*')].filter((e) => (e.textContent || '').trim() === '交流' && e.children.length <= 2);
  return hits.slice(0, 3).map((e) => ({
    tag: e.tagName,
    cls: e.className?.toString?.() ?? null,
    outer: e.outerHTML.slice(0, 400),
    parentCls: e.parentElement?.className?.toString?.() ?? null,
    parentOuter: e.parentElement?.outerHTML.slice(0, 400) ?? null,
  }));
});

const state = (c) => c.page.evaluate(() => {
  const s = globalThis.__SP__?.store?.get?.() ?? {};
  return {
    inMatch: !!s.room?.inMatch,
    phase: s.match?.phase ?? null,
    view: globalThis.__SP_VIEW__?.kind ?? null,
    wheel: !!document.querySelector('.ewheel'),
    gload: document.querySelector('.gload')?.textContent?.slice(0, 40) ?? null,
  };
});

const srv = await startRealServer({});
const c = new Client(puppeteer, srv.base, 'A', { w: 1280, h: 720, prefix: 'emoteprobe' });
const peers = [];
try {
  if (!hasChrome()) throw new Error(`no Chrome at ${CHROME}`);
  await c.open();
  await c.enter('表情探针');
  await c.click('.mode-card', '同盟匹配');
  await c.click('button', '开始搜寻队友');
  await sleep(900);
  peers.push(searcher(srv.port, 'P2'), searcher(srv.port, 'P3'), searcher(srv.port, 'P4'));
  // The wheel only mounts with the field host, i.e. once the draft is over and prep/combat runs. Drive the draft.
  const advance = async (c) => {
    for (const [sel, text] of [['.draft-detail__btns .btn--primary', '确认选择'], ['.brief__foot .btn--primary', '准备就绪'],
      ['.draft-card', null], ['.btn--primary', null]]) {
      try { await c.click(sel, text, { timeout: 1200, optional: true }); return `${sel}${text ? ' ' + text : ''}`; } catch { /* not this one */ }
    }
    return null;
  };
  let st = null;
  for (let i = 0; i < 180; i++) {
    st = await state(c);
    if (st.wheel) break;
    if (i % 4 === 3) { const what = await advance(c); if (i % 20 === 19) console.log(`[t=${i / 2}s]`, JSON.stringify(st), what ?? ''); }
    await sleep(500);
  }
  console.log('=== state when the wheel appeared ===');
  console.log(JSON.stringify(st));
  console.log('=== elements carrying the 交流 label ===');
  console.log(JSON.stringify(await dumpLabel(c), null, 1));

  console.log('=== wheel closed ===');
  console.log(JSON.stringify({ probe: await probeWheel(c), problems: c.problems }, null, 1));
  await c.shot('emote-closed');

  await c.click('.ewheel__btn');
  await sleep(600);
  console.log('=== wheel open ===');
  console.log(JSON.stringify({ probe: await probeWheel(c), problems: c.problems }, null, 1));
  await c.shot('emote-open');
} finally {
  for (const p of peers) p.close();
  await c.close();
  await srv.stop();
}
