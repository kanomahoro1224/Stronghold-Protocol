// Real-browser check of a merged four-player demo (no server match, no login): the canonical document goes through
// the same openDemo path as a cloud download, renders the DEMO room, switches fields through the real g.replay request
// interception, and keeps the cursor frozen while paused.
//
// Run: SP_E2E=1 CHROME_PATH=/usr/local/bin/chromium node --test test/e2e/team-demo.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from './client.mjs';

const ENABLED = (process.env.SP_E2E === '1' || !process.env.NODE_TEST_CONTEXT) && hasChrome();

let puppeteer = null;
async function pptr() { if (!puppeteer) puppeteer = (await import('puppeteer-core')).default; return puppeteer; }

function canonical() {
  const players = [
    { playerId: 'p_a', seat: 0, name: 'A', isBot: false, alive: true, lp: 10, fieldId: 'n:p_a' },
    { playerId: 'p_b', seat: 1, name: 'B', isBot: false, alive: true, lp: 10, fieldId: 'n:p_b' },
    { playerId: 'p_c', seat: 2, name: 'C', isBot: false, alive: true, lp: 10, fieldId: 'n:p_c' },
    { playerId: 'p_d', seat: 3, name: 'D', isBot: false, alive: true, lp: 10, fieldId: 'n:p_d' },
  ];
  const pub = (round, at) => ({ t: 'm.public', phase: 'PREP', round, lastRound: 2, serverNow: 1000 + at, modeId: 'mode_multi_hard', difficulty: 'HARD', players, fields: players.map((p) => ({ fieldId: p.fieldId, kind: 'normal', players: [p.playerId], live: false })), teamLp: 40 });
  const fields = Object.fromEntries(players.map((p) => [`n:${p.playerId}`, {
    owner: p.playerId, kind: 'normal', fieldMeta: { fieldId: `n:${p.playerId}`, players: [p.playerId], kind: 'normal', stageId: 'stage_1' },
    frames: [{ at: 0, t: 'b.snap', m: { fieldId: `n:${p.playerId}`, units: [] } }],
  }]));
  return {
    version: 2, kind: 'team', matchId: 'm_E2E_1', startedAt: 1000, endedAt: 25000, mode: 'coop', difficulty: 'HARD', players,
    public: [
      { at: 0, t: 'm.public', m: pub(1, 0) },
      { at: 12000, t: 'm.public', m: pub(1, 12000) },
      { at: 20000, t: 'm.public', m: pub(2, 20000) },
    ],
    fields,
    privates: Object.fromEntries(players.map((p) => [`p_${p.playerId.slice(2)}`, [{ at: 0, t: 'm.private', m: { playerId: p.playerId, board: [], hand: [], temp: [], shop: {}, lp: 10, deployCap: 8, deployCount: 0, alive: true } }]])),
    marks: [{ at: 0, round: 1, phase: 'PREP' }, { at: 20000, round: 2, phase: 'PREP' }],
    result: {}, partial: false, availableFields: Object.keys(fields),
  };
}

test('team demo: real browser opens merged doc, renders DEMO, switches field, pauses without moving', { skip: !ENABLED, timeout: 8 * 60 * 1000 }, async () => {
  const srv = await startRealServer();
  const P = await pptr();
  const c = new Client(P, srv.base, 'team-demo', { w: 1600, h: 900, prefix: 'team-demo' });
  try {
    await c.open();
    const doc = canonical();
    await c.page.evaluate(async (doc) => {
      const cloud = await import('/js/ui/cloud.js');
      await cloud.openDemo(doc);
    }, doc);
    await c.page.waitForFunction(() => !!document.querySelector('.dr-bar'), { timeout: 15000 });
    await c.page.waitForFunction(() => globalThis.__SP__.store.get().room?.code === 'DEMO', { timeout: 15000 });
    await c.waitFor((s) => s.phase === 'PREP' && s.field === 'n:p_a', 'DEMO starts on viewer A field', 15000);

    // A real g.watch through the replay's net.request interception: no server, no re-simulation, only field rebuild.
    const switched = await c.page.evaluate(async () => {
      const r = await globalThis.__SP__.net.request('g.watch', { fieldId: 'n:p_b' });
      return r;
    });
    assert.equal(switched.ok, true);
    await c.waitFor((s) => s.field === 'n:p_b', 'switch to teammate B field', 10000);
    await c.page.waitForFunction(() => document.querySelector('.dr-bar .dr-round')?.textContent?.includes('1'), { timeout: 10000 });

    // Seek by dragging the visible track to the middle of the first round while paused: the clock changes and the field
    // rebuilt for the target cursor stays the teammate's field (no replay from 0:00).
    const track = await c.page.$('.dr-bar .dr-track');
    assert.ok(track, 'visible timeline track');
    const box = await track.boundingBox();
    assert.ok(box && box.width > 100, 'timeline track has a width');
    await c.page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await c.page.mouse.down();
    await c.page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 8 });
    await c.page.mouse.up();
    await sleep(500);
    const seeked = await c.page.evaluate(() => ({ time: document.querySelector('.dr-time')?.textContent, field: globalThis.__SP__.store.get().match.field?.fieldId }));
    assert.notEqual(seeked.time, '0:00 / 0:25', `seek moved the clock (${seeked.time})`);
    assert.equal(seeked.field, 'n:p_b', 'seek keeps the watched teammate field');

    // Pause through the visible control: the clock text and the store hold must not move.
    await c.click('button[title="播放/暂停"]');
    const before = await c.page.evaluate(() => ({ time: document.querySelector('.dr-time')?.textContent, cursor: globalThis.__SP__?.store?.get().clock }));
    await sleep(700);
    const after = await c.page.evaluate(() => ({ time: document.querySelector('.dr-time')?.textContent, cursor: globalThis.__SP__?.store?.get().clock }));
    assert.equal(after.time, before.time, 'paused clock text stays still');
    assert.deepEqual(after.cursor?.hold, before.cursor?.hold, 'clock hold stays at the same replay cursor');

    await c.shot('team-demo-paused');
    // This focused test runs without the downloaded art pack (public/assets is a local pack, not in git). Missing art,
    // audio, fonts and the accounts config are expected; page errors and application console errors are not.
    const expected = /\/assets\/|\/media\/|\/audio\/|\/fonts\/|\.css|\/api\/config|pageerror: Event|unhandled rejection \[object Event\]/;
    const fatal = problemsOf([c]).filter((p) => !expected.test(p));
    assert.deepEqual(fatal, [], 'no page errors, application console errors, failed requests or HTTP errors');
  } finally {
    console.log(c.log.join('\n'));
    if (c.problems.length) console.log(`team-demo problems:\n  ${c.problems.slice(0, 30).join('\n  ')}`);
    await c.close();
    await srv.stop();
  }
});
