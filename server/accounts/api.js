// server/accounts/api.js — the account / cloud / replay REST surface, mounted before the static handler.
//
// Routes (all JSON; responses never carry the session token in a body — it is only ever the HttpOnly cookie):
//   GET  /api/config                 → { accounts: bool, turnstileSiteKey, mail: bool, dev: bool }
//   POST /api/auth/code              { email, turnstileToken, mode? } → { ok, email, expiresInMs, sent, devCode? }
//   POST /api/auth/verify            { email, code, password?, name?, tag? } → { ok, account } + Set-Cookie
//   POST /api/auth/password          { email, password } → { ok, account } + Set-Cookie
//   POST /api/auth/logout            → { ok }
//   GET  /api/auth/me                → { ok, account } | 401
//   PUT  /api/profile                { name?, tag? } → { ok, account } — 只补空位
//   GET  /api/cloud                  → { ok, loadouts, settings, stats, updatedAt }
//   PUT  /api/cloud                  { loadouts?, settings?, stats? } → { ok, updatedAt }
//   POST /api/link                   { playerId, playerToken } — verify the WS secret, then bind playerId
//   GET  /api/history?limit=50       → { ok, matches: [...] }
//   GET  /api/demo/:id               → { ok, demo }
//   POST /api/team-demos/:matchId/parts { playerId, doc } → { ok, waitingFor, merged, id }
//   GET  /api/team-demos/:matchId/status → { participants, uploaded, missing, merged }
//   GET  /api/team-demos/:id         → { ok, demo } (only this viewer's m.private)
//
// A server without DATABASE_URL still answers /api/config (accounts:false) and every other route with 503 — the
// client hides the account UI in that case instead of failing silently.

import { sendJson } from '../http/common.js';
import { N_ } from '../../shared/i18n.js';
import { readCookie, sessionCookie, clearCookie } from './auth.js';
import { listMatches, getDemo, canWatchDemo, getProfile, putProfile, linkPlayer, putAccountDemo, listAccountDemos, getAccountDemo, MAX_CLOUD_DEMO_BYTES } from './store.js';
import { putTeamDemoPart, getTeamDemoStatus, mergeTeamDemo, pruneTeamParts, getTeamDemoForViewer, listTeamDemosForAccount, teamMatchForAccount } from './teamStore.js';
import { MAX_TEAM_PART_JSON } from './teamDemos.js';

const MAX_BODY = 64 * 1024;

/** @returns {Promise<any | null>} parsed JSON body, or null for an invalid/oversized one */
async function readJson(req, maxBytes = MAX_BODY) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  // .length is UTF-16 code units; the team endpoint accepts a 24 MB UTF-8 JSON body, so count the actual bytes.
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    // Decode after the whole body: decoding each chunk separately can split a UTF-8 character and corrupt JSON
    // (Chinese names in a team Demo part are exactly that case).
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buf.length;
    if (bytes > maxBytes) return null;
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Same-origin guard for state-changing requests: browsers send Origin on cross-site POSTs. A missing Origin
 * (curl, tests, same-origin GET) passes.
 */
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = String(req.headers.host || '');
    return !host || u.host === host;
  } catch { return false; }
}

/**
 * @param {{ db: any, auth: any, turnstile: any, mailer: any, registry: any, log?: object, dev?: boolean }} deps
 */
export function createAccountApi({ db, auth, turnstile, mailer, registry, log = {}, dev = false, requireAccount = false }) {
  const off = () => ({ ok: false, error: 'ACCOUNTS_OFF', message: N_('账号服务未启用：服务端没有配置 DATABASE_URL') });

  async function accountOf(req) {
    if (!db) return null;
    const token = readCookie(req.headers?.cookie, auth.cookieName);
    return auth.resolve(token);
  }

  function json(res, status, body, extraHeaders = {}) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    sendJson({ method: 'GET' }, res, status, body); // sendJson only needs req.method for HEAD suppression
  }

  return async function handle(req, res, pathname) {
    const path = pathname.replace(/\/$/, '') || '/';
    if (!path.startsWith('/api/')) return false;
    const method = String(req.method || 'GET').toUpperCase();

    // /api/config is public and works without a database
    if (path === '/api/config' && (method === 'GET' || method === 'HEAD')) {
      json(res, 200, {
        ok: true, accounts: !!db, mail: !!mailer?.ready, dev: !!dev,
        // The title screen hides 「登录 / 注册」 and gates 开始 only when the server itself enforces it
        // (SP_REQUIRE_ACCOUNT=1, server/index.js). A database-less server can never require an account.
        requireAccount: !!(db && requireAccount),
        // false = 官方测试密钥（任意 token 通过）：客户端不必渲染 Cloudflare 挂件
        turnstileConfigured: !!turnstile.configured,
        turnstileSiteKey: turnstile.siteKey,
      });
      return true;
    }

    if (!db) { json(res, 503, off()); return true; }

    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
      json(res, 403, { ok: false, error: 'ORIGIN' });
      return true;
    }

    try {
      if (path === '/api/auth/code' && method === 'POST') {
        const body = await readJson(req);
        if (!body) { json(res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
        const ip = req.socket?.remoteAddress || undefined;
        const r = await auth.requestCode({ email: body.email, turnstileToken: body.turnstileToken, ip, mode: body.mode });
        json(res, r.ok ? 200 : r.status || 400, r);
        return true;
      }

      if (path === '/api/auth/verify' && method === 'POST') {
        const body = await readJson(req);
        if (!body) { json(res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
        const ip = req.socket?.remoteAddress || undefined;
        const ua = req.headers?.['user-agent'];
        // 注册时可以带密码 / 博士代号 / #识别号（2026-11-15）；老账号只补空位，不覆盖
        const r = await auth.verify({
          email: body.email, code: body.code, ip, ua,
          password: body.password, name: body.name, tag: body.tag,
        });
        if (!r.ok) { json(res, r.status || 400, r); return true; }
        const secure = String(req.headers?.['x-forwarded-proto'] || '') === 'https';
        json(res, 200, { ok: true, account: r.account },
          { 'Set-Cookie': sessionCookie(r.token, { secure }) });
        return true;
      }

      // 密码登录：邮箱 + 密码，免收验证码。失败一律 BAD_CREDENTIALS（不区分邮箱不存在 / 密码不对）
      if (path === '/api/auth/password' && method === 'POST') {
        const body = await readJson(req);
        if (!body) { json(res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
        const r = await auth.loginWithPassword({
          email: body.email, password: body.password,
          ip: req.socket?.remoteAddress || undefined, ua: req.headers?.['user-agent'],
        });
        if (!r.ok) { json(res, r.status || 401, r); return true; }
        const secure = String(req.headers?.['x-forwarded-proto'] || '') === 'https';
        json(res, 200, { ok: true, account: r.account },
          { 'Set-Cookie': sessionCookie(r.token, { secure }) });
        return true;
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        const token = readCookie(req.headers?.cookie, auth.cookieName);
        await auth.logout(token);
        json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
        return true;
      }

      if (path === '/api/auth/me' && (method === 'GET' || method === 'HEAD')) {
        const account = await accountOf(req);
        if (!account) { json(res, 401, { ok: false, error: 'NOT_LOGGED_IN' }); return true; }
        json(res, 200, { ok: true, account });
        return true;
      }

      // everything below needs a session
      const account = await accountOf(req);
      if (!account) { json(res, 401, { ok: false, error: 'NOT_LOGGED_IN' }); return true; }

      // 博士代号 + #识别号：登录后在标题页输入框里填，存进账号，下次登录自动带回（auth.setProfile）
      if (path === '/api/profile' && (method === 'PUT' || method === 'POST')) {
        const body = await readJson(req);
        if (!body) { json(res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
        const r = await auth.setProfile({ account, name: body.name, tag: body.tag });
        if (!r.ok) { json(res, r.status || 400, r); return true; }
        json(res, 200, { ok: true, account: r.account });
        return true;
      }

      if (path === '/api/cloud' && (method === 'GET' || method === 'HEAD')) {
        const p = await getProfile(db, account.id);
        json(res, 200, { ok: true, ...p });
        return true;
      }

      if (path === '/api/cloud' && (method === 'PUT' || method === 'POST')) {
        const body = await readJson(req);
        if (!body) { json(res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
        const r = await putProfile(db, account.id, { loadouts: body.loadouts, settings: body.settings, stats: body.stats });
        if (!r.ok) { json(res, r.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: r.code }); return true; }
        json(res, 200, { ok: true });
        return true;
      }

      if (path === '/api/link' && method === 'POST') {
        const body = await readJson(req);
        if (!body) { json(res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
        const session = body.playerId ? registry?.byId?.(String(body.playerId)) : null;
        if (!session || !body.playerToken || session.token !== String(body.playerToken)) {
          json(res, 403, { ok: false, error: 'PLAYER_TOKEN' });
          return true;
        }
        await linkPlayer(db, account.id, session.playerId);
        json(res, 200, { ok: true, playerId: session.playerId });
        return true;
      }

      // 云端 Demo：本机录制，上传一份做跨设备备份；每账号只保留最新 10 局（store.js CLOUD_DEMOS）
      if (path === '/api/cloud/demos' && (method === 'GET' || method === 'HEAD')) {
        const demos = await listAccountDemos(db, account.id);
        json(res, 200, { ok: true, demos });
        return true;
      }

      if (path === '/api/cloud/demos' && method === 'POST') {
        const body = await readJson(req, MAX_CLOUD_DEMO_BYTES + 64 * 1024);
        if (!body) { json(res, 413, { ok: false, error: 'BAD_BODY' }); return true; }
        const r = await putAccountDemo(db, account.id, body);
        if (!r.ok) { json(res, r.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: r.code }); return true; }
        json(res, 200, { ok: true, id: r.id });
        return true;
      }

      const cloudDemo = path.match(/^\/api\/cloud\/demos\/([0-9]+)$/);
      if (cloudDemo && (method === 'GET' || method === 'HEAD')) {
        const doc = await getAccountDemo(db, account.id, cloudDemo[1]);
        if (!doc) { json(res, 404, { ok: false, error: 'NOT_FOUND' }); return true; }
        json(res, 200, { ok: true, demo: doc });
        return true;
      }

      // ---- 四人联机 Demo：每玩家上传自己的 part，全部到齐后服务端只合并 JSON（不重跑战斗） ----
      if (path === '/api/team-demos' && (method === 'GET' || method === 'HEAD')) {
        json(res, 200, { ok: true, demos: await listTeamDemosForAccount(db, account.id) });
        return true;
      }

      const teamPart = path.match(/^\/api\/team-demos\/([^/]+)\/parts$/);
      if (teamPart && method === 'POST') {
        const matchId = decodeURIComponent(teamPart[1]);
        const body = await readJson(req, MAX_TEAM_PART_JSON + 64 * 1024);
        if (!body) { json(res, 413, { ok: false, error: 'BAD_BODY' }); return true; }
        try {
          const r = await putTeamDemoPart(db, { matchId, playerId: body.playerId, accountId: account.id, doc: body.doc });
          await pruneTeamParts(db).catch(() => {});
          const status = await getTeamDemoStatus(db, matchId);
          // Re-merge on every upload, not only the first complete set: a re-uploaded part must replace the canonical
          // copy too, otherwise an old video stays linked forever. getTeamDemoStatus also merges on a plain status
          // query when no canonical exists / only a stale partial does, but that alone would not refresh a full one.
          let merged = null;
          if (!status.missing.length) merged = await mergeTeamDemo(db, matchId, { force: false });
          json(res, 200, { ok: true, partId: String(account.id), waitingFor: status.waitingFor, merged: !!merged?.ok, id: merged?.ok ? merged.id : null });
          return true;
        } catch (e) {
          const code = e?.code || 'BAD_PART';
          json(res, code.startsWith('TOO_LARGE') ? 413 : code === 'PLAYER_NOT_LINKED' ? 403 : 400, { ok: false, error: code });
          return true;
        }
      }

      const teamStatus = path.match(/^\/api\/team-demos\/([^/]+)\/status$/);
      if (teamStatus && (method === 'GET' || method === 'HEAD')) {
        const matchId = decodeURIComponent(teamStatus[1]);
        // Uploaders / linked participants can inspect a match's upload progress; an unrelated account must not learn
        // the participant and uploaded/missing sets from a guessed matchId.
        if (!await teamMatchForAccount(db, account.id, matchId)) {
          json(res, 404, { ok: false, error: 'NOT_FOUND' }); return true;
        }
        json(res, 200, await getTeamDemoStatus(db, matchId));
        return true;
      }

      const teamDemo = path.match(/^\/api\/team-demos\/([0-9]+)$/);
      if (teamDemo && (method === 'GET' || method === 'HEAD')) {
        const doc = await getTeamDemoForViewer(db, account.id, teamDemo[1]);
        if (!doc) { json(res, 404, { ok: false, error: 'NOT_FOUND' }); return true; }
        json(res, 200, { ok: true, demo: doc });
        return true;
      }

      if (path === '/api/history' && (method === 'GET' || method === 'HEAD')) {
        const url = new URL(req.url, 'http://local');
        const matches = await listMatches(db, account.id, {
          limit: url.searchParams.get('limit'), before: url.searchParams.get('before'),
        });
        json(res, 200, { ok: true, matches });
        return true;
      }

      const demo = path.match(/^\/api\/demo\/([0-9]+)$/);
      if (demo && (method === 'GET' || method === 'HEAD')) {
        const id = demo[1];
        const allowed = await canWatchDemo(db, account.id, id);
        if (!allowed) { json(res, 403, { ok: false, error: 'DEMO_FORBIDDEN' }); return true; }
        const doc = await getDemo(db, id);
        if (!doc) { json(res, 404, { ok: false, error: 'NOT_FOUND' }); return true; }
        json(res, 200, { ok: true, demo: doc });
        return true;
      }

      json(res, 404, { ok: false, error: 'NOT_FOUND' });
      return true;
    } catch (e) {
      log.error?.('[accounts] api failed', e);
      json(res, 500, { ok: false, error: 'INTERNAL' });
      return true;
    }
  };
}
