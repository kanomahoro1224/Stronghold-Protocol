// Real PostgreSQL integration for team demo parts: schema, gzip storage, four-link sharing, private filtering.
// Run with SP_TEST_DATABASE_URL (a throwaway database); without it the file skips, like test/accounts.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../server/accounts/db.js';
import { linkPlayer, accountOfPlayer } from '../server/accounts/store.js';
import { putTeamDemoPart, getTeamDemoStatus, mergeTeamDemo, getTeamDemoForViewer, listTeamDemosForAccount } from '../server/accounts/teamStore.js';
import { createAccountApi } from '../server/accounts/api.js';
import { createServer } from 'node:http';

const CONN = process.env.SP_TEST_DATABASE_URL || '';
let db;
const accounts = {};

before(async () => {
  if (!CONN) return;
  db = await createDb({ url: CONN, log: {} });
  await db.query(`TRUNCATE accounts, email_codes, sessions, profiles, match_records, demos, player_links, team_demo_parts, team_demos, team_demo_links RESTART IDENTITY CASCADE`);
  for (const [name, email] of [['a', 'team-a@x.co'], ['b', 'team-b@x.co']]) {
    const r = await db.query(`INSERT INTO accounts (email) VALUES ($1) RETURNING id`, [email]);
    accounts[name] = String(r.rows[0].id);
  }
  await linkPlayer(db, accounts.a, 'p_a');
  await linkPlayer(db, accounts.b, 'p_b');
});
after(async () => { await db?.close(); });

const frame = (at, t, m) => ({ at, t, m });
const part = (playerId, over = {}) => ({
  matchId: 'm_T_1', startedAt: 1000, endedAt: 5000, mode: 'coop', difficulty: 'HARD',
  players: [{ playerId: 'p_a', seat: 0, name: 'A', isBot: false }, { playerId: 'p_b', seat: 1, name: 'B', isBot: false }],
  marks: [], wire: [
    frame(0, 'm.public', { serverNow: 1000, phase: 'prep', round: 1 }),
    frame(100, 'm.field', { fieldId: `n:${playerId}`, players: [playerId], kind: 'normal' }),
    frame(100, 'b.snap', { fieldId: `n:${playerId}`, units: [{ id: `${playerId}_1`, x: 1 }] }),
    frame(0, 'm.private', { playerId, hand: [playerId] }),
  ], ...over,
});

test('team demo DB: parts → waiting → merge → links → filtered viewer', { skip: !CONN }, async () => {
  const a = part('p_a');
  const b = part('p_b');
  await putTeamDemoPart(db, { matchId: 'm_T_1', playerId: 'p_a', accountId: accounts.a, doc: a });
  let status = await getTeamDemoStatus(db, 'm_T_1');
  assert.deepEqual(status.uploaded, ['p_a']);
  assert.deepEqual(status.missing, ['p_b']);
  assert.equal(status.merged, false);
  assert.deepEqual((await accountOfPlayer(db, 'p_a')).accountId, accounts.a);

  await putTeamDemoPart(db, { matchId: 'm_T_1', playerId: 'p_b', accountId: accounts.b, doc: b });
  status = await getTeamDemoStatus(db, 'm_T_1');
  assert.deepEqual(status.missing, []);
  const merged = await mergeTeamDemo(db, 'm_T_1');
  assert.equal(merged.ok, true);
  assert.equal(merged.partial, false);
  assert.equal(merged.links.length, 2);

  const va = await getTeamDemoForViewer(db, accounts.a, merged.id);
  const vb = await getTeamDemoForViewer(db, accounts.b, merged.id);
  assert.ok(va && vb);
  assert.deepEqual(Object.keys(va.privates), ['p_a'], 'A receives only A private');
  assert.deepEqual(Object.keys(vb.privates), ['p_b'], 'B receives only B private');
  assert.deepEqual(va.availableFields.sort(), ['n:p_a', 'n:p_b']);
  assert.deepEqual((await listTeamDemosForAccount(db, accounts.a)).map((d) => d.id), [merged.id]);
  assert.equal(await getTeamDemoForViewer(db, accounts.a, '999999'), null, 'other / unknown id is not readable');
});

test('team demo DB: force merge after missing participant is partial and only uses the uploaded field', { skip: !CONN }, async () => {
  const c = part('p_a', { matchId: 'm_T_2', players: [
    { playerId: 'p_a', seat: 0, name: 'A', isBot: false },
    { playerId: 'p_b', seat: 1, name: 'B', isBot: false },
    { playerId: 'p_c', seat: 2, name: 'C', isBot: false },
  ] });
  await putTeamDemoPart(db, { matchId: 'm_T_2', playerId: 'p_a', accountId: accounts.a, doc: c });
  const merged = await mergeTeamDemo(db, 'm_T_2', { force: true });
  assert.equal(merged.ok, true);
  assert.equal(merged.partial, true);
  assert.deepEqual(merged.availableFields, ['n:p_a']);
});

test('team demo DB: a part cannot claim a playerId linked to another account', { skip: !CONN }, async () => {
  await assert.rejects(
    putTeamDemoPart(db, { matchId: 'm_T_3', playerId: 'p_b', accountId: accounts.a, doc: part('p_b', { matchId: 'm_T_3' }) }),
    /PLAYER_NOT_LINKED/);
});


test('team demo API: upload part, wait, merge all, list, filtered download; non-participant 404', { skip: !CONN }, async () => {
  const auth = { cookieName: 'sp_sid', resolve: async (token) => (token === 'a' ? { id: Number(accounts.a), email: 'team-a@x.co' } : token === 'b' ? { id: Number(accounts.b), email: 'team-b@x.co' } : null) };
  const api = createAccountApi({ db, auth, turnstile: { configured: true }, mailer: {}, registry: { byId: () => null }, log: {}, dev: true });
  const server = createServer((req, res) => { api(req, res, new URL(req.url, 'http://x').pathname); });
  let base = '';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(undefined); }));
  const docA = part('p_a', { matchId: 'm_API_1' });
  const docB = part('p_b', { matchId: 'm_API_1' });
  try {
    const post = (doc, cookie) => fetch(`${base}/api/team-demos/m_API_1/parts`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `sp_sid=${cookie}` }, body: JSON.stringify({ playerId: doc.players.find((p) => p.playerId === (cookie === 'a' ? 'p_a' : 'p_b')).playerId, doc }) });
    let r = await post(docA, 'a');
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.waitingFor, ['p_b']);
    r = await post(docB, 'b');
    body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.merged, true);
    assert.ok(body.id);

    const status = await (await fetch(`${base}/api/team-demos/m_API_1/status`, { headers: { cookie: 'sp_sid=a' } })).json();
    assert.equal(status.ok, true);
    assert.equal(status.merged, true);
    assert.deepEqual(status.missing, []);

    const list = await (await fetch(`${base}/api/team-demos`, { headers: { cookie: 'sp_sid=a' } })).json();
    assert.ok(list.demos.some((d) => d.matchId === 'm_API_1'), 'this match is linked to A');
    const got = await (await fetch(`${base}/api/team-demos/${body.id}`, { headers: { cookie: 'sp_sid=a' } })).json();
    assert.equal(got.ok, true);
    assert.deepEqual(Object.keys(got.demo.privates), ['p_a']);
    assert.equal(got.demo.fields['n:p_b'].owner, 'p_b');

    const outsider = await fetch(`${base}/api/team-demos/${body.id}`, { headers: { cookie: 'sp_sid=none' } });
    assert.equal(outsider.status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


test('team demo DB: a missing participant turns into partial after the 5 minute timeout', { skip: !CONN }, async () => {
  const doc = part('p_a', { matchId: 'm_TO_1', players: [
    { playerId: 'p_a', seat: 0, name: 'A', isBot: false },
    { playerId: 'p_b', seat: 1, name: 'B', isBot: false },
    { playerId: 'p_c', seat: 2, name: 'C', isBot: false },
  ] });
  await putTeamDemoPart(db, { matchId: 'm_TO_1', playerId: 'p_a', accountId: accounts.a, doc });
  await db.query(`UPDATE team_demo_parts SET uploaded_at = now() - interval '6 minutes' WHERE match_id = 'm_TO_1'`);
  const status = await getTeamDemoStatus(db, 'm_TO_1');
  assert.equal(status.merged, true);
  assert.equal(status.partial, true);
  assert.deepEqual(status.missing, ['p_b', 'p_c']);
});
