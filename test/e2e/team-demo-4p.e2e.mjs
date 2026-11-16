// Four real Chromium clients on the real server: lobby → 4-human room → briefing → band draft → fast round 1 → RESULT,
// checking that every browser recorded its own team demo part with the same stamped matchId (the server-side merge is
// covered by test/accounts-team-db.test.js and the replay by team-demo.e2e.mjs).
//
// Run: SP_E2E=1 CHROME_PATH=/usr/local/bin/chromium node --test test/e2e/team-demo-4p.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, sleep, hasChrome, startRealServer, problemsOf } from './client.mjs';
import { mergeTeamDemos } from '../../server/accounts/teamDemos.js';

const ENABLED = (process.env.SP_E2E === '1' || !process.env.NODE_TEST_CONTEXT) && hasChrome();
let puppeteer = null;
async function pptr() { if (!puppeteer) puppeteer = (await import('puppeteer-core')).default; return puppeteer; }

test('four browser clients finish one team match and each records the same matchId', { skip: !ENABLED, timeout: 12 * 60 * 1000 }, async () => {
  const srv = await startRealServer({ fast: { timerScale: 0.08, combatSpeed: 16, kit: 8, autoPlace: true, finishAfter: 1 } });
  const P = await pptr();
  const clients = ['A', 'B', 'C', 'D'].map((name) => new Client(P, srv.base, `p${name}`, { w: 1280, h: 720, prefix: 'team4p' }));
  try {
    await clients[0].open();
    await clients[0].enter('甲');
    const room = await clients[0].createCoop();
    for (const c of clients.slice(1)) {
      await c.open(`?room=${room.code}`);
      await c.enter(`乙${c.label}`);
      await c.waitFor((s) => s.room?.code === room.code, `${c.label} joined`, 30000);
    }
    for (const c of clients.slice(1)) await c.click('.room-bar__right button', '准备就绪');
    await clients[0].waitFor((s) => s.room?.inMatch === false, 'room before start', 15000).catch(() => {});
    await clients[0].click('.room-bar__right button', '开始模拟', { timeout: 20000 });

    // Some rulesets go straight to PREP; when the briefing / draft exists, take it.
    for (const c of clients) await c.waitFor((s) => ['INFO_CHECK', 'BAND_DRAFT', 'PREP'].includes(s.phase), 'match started', 30000);
    for (const c of clients) {
      const s = await c.st();
      if (s.phase === 'INFO_CHECK') await c.click('.brief__foot .btn--primary', '准备就绪');
    }
    for (const c of clients) await c.waitFor((s) => s.phase !== 'INFO_CHECK', 'briefing done', 45000);

    // Four humans draft in turn. Skip while the button is enabled; the last one still to pick chooses a free band.
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      let anyDraft = false;
      for (const c of clients) {
        const s = await c.st();
        if (s.phase !== 'BAND_DRAFT') continue;
        anyDraft = true;
        if (s.draft?.turn !== s.me) continue;
        await sleep(350); // let the turn's UI render after the previous player's pick
        const canSkip = await c.page.evaluate(() => [...document.querySelectorAll('.dturn .draft-skip')].some((b) => b.textContent.includes('跳过') && !b.disabled));
        if (canSkip) { await c.click('.dturn .draft-skip', '跳过'); continue; }
        const band = await c.page.evaluate(() => {
          const el = [...document.querySelectorAll('.dband:not(.is-taken)')].find((x) => x.querySelector('.dband__name')?.textContent.trim() !== '老鲤');
          el?.scrollIntoView({ block: 'nearest' });
          return el?.querySelector('.dband__name')?.textContent.trim() || null;
        });
        if (!band) { await sleep(400); continue; } // the turn banner can arrive before the grid
        await sleep(100);
        await c.click('.dband:not(.is-taken)', band);
        await sleep(150);
        await c.click('.draft-detail__btns .btn--primary', '确认选择');
      }
      if (!anyDraft) break;
      await sleep(200);
    }
    // A ruleset without a band draft goes straight to PREP; the loop above exits at once.
    for (const c of clients) await c.waitFor((s) => s.phase === 'PREP', 'prep', 60000);
    for (const c of clients) {
      const before = await c.st();
      if (before.phase !== 'PREP' || before.ready) continue;
      try { await c.click('.readybtn'); }
      catch (e) {
        const after = await c.st();
        if (after.phase !== 'PREP' || after.result || after.ready) continue; // the round started/ended while the funds dialog was closing
        const dump = await c.page.evaluate(() => ({ state: globalThis.__SP__.store.get().match.private?.ready, phase: globalThis.__SP__.store.get().match.public?.phase, modal: document.querySelector('.modal__box')?.textContent, buttons: [...document.querySelectorAll('.modal__actions button')].map((b) => ({ text: b.textContent, disabled: b.disabled })) }));
        console.log(`${c.label} ready failed: ${JSON.stringify(dump)}`);
        throw e;
      }
    }
    for (const c of clients) await c.waitFor((s) => s.result || s.phase === 'RESULT', 'result after round 1', 90000);

    const docs = [];
    for (const c of clients) {
      const d = await c.page.evaluate(async () => {
        const store = await import('/js/demoStore.js');
        const rows = await store.listDemos();
        const latest = rows[0] && await store.getLocalDemo(rows[0].id);
        return latest ? { id: latest.id, matchId: latest.matchId, matchToken: latest.matchToken, isTeam: latest.isTeam, playerId: latest.playerId, players: (latest.players || []).map((p) => p.playerId), wire: (latest.wire || []).length, fieldCount: Object.keys(latest.fields || {}).length, privates: Object.keys(latest.privates || {}).length, raw: latest } : null;
      });
      assert.ok(d, `${c.label}: a local demo was recorded`);
      assert.equal(d.isTeam, true, `${c.label}: recorded as a team demo`);
      assert.equal(d.players.length, 4, `${c.label}: four human players`);
      assert.ok(d.matchId, `${c.label}: matchId stamped`);
      assert.ok(d.matchToken, `${c.label}: signed upload token stamped`);
      assert.ok(d.wire > 0, `${c.label}: raw S2C wire saved`);
      docs.push(d);
      await c.shot(`result-${c.label}`);
    }
    const ids = [...new Set(docs.map((d) => d.matchId))];
    assert.equal(ids.length, 1, `all four parts share one matchId (${ids.join(', ')})`);
    assert.equal(new Set(docs.map((d) => d.matchToken)).size, 1, 'all four parts share one server-signed token');
    // Merge the four documents exactly as the server does (pure JSON; no battle re-simulation). Local documents store
    // their frames in `wire`; the canonical fills `fields` from those frames, so `fieldCount` on a part may be 0.
    const merged = mergeTeamDemos(docs.map((d) => ({ playerId: d.playerId, doc: d.raw })), { matchId: ids[0] });
    assert.equal(Object.keys(merged.fields).length, 4, 'one canonical field per player');
    for (const [fid, f] of Object.entries(merged.fields)) {
      assert.ok(f.owner, `${fid}: an owner`);
      assert.ok(f.frames.length > 0, `${fid}: recorded frames`);
    }
    assert.ok(merged.public.length > 0, 'public timeline');
    assert.equal(Object.keys(merged.privates).length, 4, 'four private streams');
    console.log(`four-player demo parts: ${docs.map((d) => `${d.id}:${d.wire} frames`).join(' ')}; merged ${Object.keys(merged.fields).length} fields, ${merged.public.length} public, ${Object.keys(merged.privates).length} privates`);

    // The no-asset CI environment lacks art/audio/fonts; page errors and application errors are still fatal.
    const expected = /\/assets\/|\/media\/|\/audio\/|\/fonts\/|\.css|\/api\/config|pageerror: Event|unhandled rejection \[object Event\]/;
    for (const c of clients) assert.deepEqual(problemsOf([c]).filter((p) => !expected.test(p)), [], `${c.label}: no page/application errors`);
  } finally {
    console.log(clients.map((c) => c.log).flat().join('\n'));
    for (const c of clients) if (c.problems.length) console.log(`${c.label} problems:\n  ${c.problems.slice(0, 20).join('\n  ')}`);
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await srv.stop();
  }
});
