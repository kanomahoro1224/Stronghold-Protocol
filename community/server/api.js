// community/server/api.js — the JSON API (mounted at /api/*).
//
// Surface (all JSON; errors are `{ error: { code, message } }`):
//   GET    /api/bootstrap          site config + regions + session (who am I)
//   GET    /api/servers            public list; ?probe=1 adds live /healthz results
//                                  (probeAddress is returned to admins only)
//   GET    /api/servers/:id        one server + its live probe
//   POST   /api/auth/login         { loginName, password } → sets session cookie
//   POST   /api/auth/logout
//   GET    /api/auth/me
//
//   admin only (403 otherwise):
//   POST   /api/servers            { name, address, region, note?, probeAddress? }
//   PUT    /api/servers/:id        partial update
//   DELETE /api/servers/:id
//   GET    /api/accounts
//   POST   /api/accounts           { displayName, loginName, password, role }
//   PUT    /api/accounts/:id       { displayName?, role?, disabled? }
//   POST   /api/accounts/:id/password  { password }   (admin reset, no current password needed)
//   DELETE /api/accounts/:id
//
// The server never exposes password hashes, and the last enabled admin can be neither disabled nor deleted.

import { REGIONS, REGION_VALUES, publicServer, publicAccount, hashPassword, probeTargetOf } from './db.js';
import { currentAccount, endSession, isAdmin, login, validatePassword, killSessions } from './auth.js';
import { probe, probeAll, invalidate, canonicalAddress, isValidAddress } from './probe.js';
import { sendJson, sendError, readJsonBody } from './http.js';

const NAME_MAX = 40;
const LOGIN_MAX = 32;
const NOTE_MAX = 120;
const ADDRESS_MAX = 200;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (Number.isInteger(v) ? v : Number.parseInt(String(v), 10));

// ---- validation helpers -------------------------------------------------------------------------

/** @returns {{ ok:true, value:object } | { ok:false, message:string }} */
export function readServerInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = str(body.name, NAME_MAX);
    if (!name) return { ok: false, message: '请填写服务器名称' };
    out.name = name;
  }
  if (!partial || body.address !== undefined) {
    const address = canonicalAddress(body.address);
    if (!isValidAddress(body.address)) return { ok: false, message: '服务器地址无效，请填写形如 https://t44.kafuno.cn:34046/ 的地址' };
    out.address = address;
  }
  // 实际探测地址：可选。留空（或显式传空串）＝ 用上面的服务器地址探测。
  if (body.probeAddress !== undefined) {
    const raw = str(body.probeAddress, ADDRESS_MAX);
    if (!raw) {
      out.probeAddress = '';
    } else if (!isValidAddress(raw)) {
      return { ok: false, message: '实际探测地址无效，请填写形如 https://1.2.3.4:34046/ 的地址（留空则用服务器地址）' };
    } else {
      out.probeAddress = canonicalAddress(raw);
    }
  }
  if (!partial || body.region !== undefined) {
    const region = str(body.region, 20);
    if (!REGION_VALUES.includes(region)) return { ok: false, message: '请选择有效的服务器区域' };
    out.region = region;
  }
  if (body.note !== undefined) out.note = str(body.note, NOTE_MAX);
  if (body.sortOrder !== undefined) out.sortOrder = int(body.sortOrder) || 0;
  if (!Object.keys(out).length) return { ok: false, message: '没有可更新的字段' };
  return { ok: true, value: out };
}

// ---- route table --------------------------------------------------------------------------------

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, secure: boolean }} ctx
 * @returns {(req, res, url: URL, deps: object) => Promise<boolean>} handler; returns false when unrouted
 */
export function createApi({ db, secure }) {
  const listRows = () => db.prepare('SELECT * FROM servers ORDER BY sort_order ASC, id ASC').all();
  const getRow = (id) => db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  const listServers = (withProbe = false) => listRows().map((r) => publicServer(r, { withProbe }));
  const getServer = (id, withProbe = false) => publicServer(getRow(id), { withProbe });
  const getAccount = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  const countActiveAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND disabled = 0").get().n;

  /** Guard: admin session required. Returns the account, or sends 401/403 and returns null. */
  function requireAdmin(req, res) {
    const account = currentAccount(db, req);
    if (!account) { sendError(res, 401, 'UNAUTHENTICATED', '请先登录管理员账号'); return null; }
    if (!isAdmin(account)) { sendError(res, 403, 'FORBIDDEN', '需要管理员权限'); return null; }
    return account;
  }

  return async function handleApi(req, res, url, deps) {
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) return false;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const seg = pathname.slice('/api/'.length).split('/').filter(Boolean); // e.g. ['servers','3']
    const [head, param] = seg;

    try {
      // ---- site bootstrap ---------------------------------------------------------------------
      if (head === 'bootstrap' && method === 'GET') {
        const account = currentAccount(db, req);
        sendJson(res, 200, {
          site: {
            name: '卫戍协议',
            subtitle: 'STRONGHOLD PROTOCOL',
            registrationOpen: false, // 自助注册永久关闭：账号只能由管理员创建
          },
          regions: REGIONS,
          account,
          isAdmin: isAdmin(account),
        });
        return true;
      }

      // ---- auth -------------------------------------------------------------------------------
      if (head === 'auth' && method === 'GET' && param === 'me') {
        sendJson(res, 200, { account: currentAccount(db, req) });
        return true;
      }
      if (head === 'auth' && method === 'POST' && param === 'login') {
        const body = await readJsonBody(req);
        const result = login(db, res, body.loginName, body.password, { secure });
        if (!result.ok) { sendError(res, 401, result.code, result.message); return true; }
        sendJson(res, 200, { account: result.account });
        return true;
      }
      if (head === 'auth' && method === 'POST' && param === 'logout') {
        endSession(db, req, res);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- servers (public read) ----------------------------------------------------------------
      if (head === 'servers' && method === 'GET' && !param) {
        const rows = listRows();
        const servers = listServers(isAdmin(currentAccount(db, req)));
        if (url.searchParams.get('probe') === '1') {
          // 服务端探测走「实际探测地址」（留空则是公开地址）——玩家点击用的始终是公开地址。
          const probes = await probeAll(rows.map((r) => ({ address: probeTargetOf(r) })));
          sendJson(res, 200, { servers: servers.map((s, i) => ({ ...s, health: probes[i] })) });
        } else {
          sendJson(res, 200, { servers });
        }
        return true;
      }
      if (head === 'servers' && method === 'GET' && param) {
        const row = getRow(int(param));
        if (!row) { sendError(res, 404, 'NOT_FOUND', '服务器不存在'); return true; }
        const server = getServer(row.id, isAdmin(currentAccount(db, req)));
        sendJson(res, 200, { server: { ...server, health: await probe(probeTargetOf(row)) } });
        return true;
      }

      // ---- servers (admin write) ------------------------------------------------------------------
      if (head === 'servers' && method === 'POST' && !param) {
        if (!requireAdmin(req, res)) return true;
        const body = await readJsonBody(req);
        const parsed = readServerInput(body);
        if (!parsed.ok) { sendError(res, 400, 'INVALID', parsed.message); return true; }
        const { name, address, region, note = '', probeAddress = '', sortOrder = 0 } = parsed.value;
        const dup = db.prepare('SELECT id FROM servers WHERE address = ?').get(address);
        if (dup) { sendError(res, 409, 'DUPLICATE', '该地址的服务器已存在'); return true; }
        const now = Date.now();
        const info = db.prepare(`INSERT INTO servers (name, address, probe_address, region, note, sort_order, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, address, probeAddress, region, note, sortOrder, now, now);
        invalidate(probeTargetOf({ address, probe_address: probeAddress }));
        sendJson(res, 201, { server: getServer(Number(info.lastInsertRowid), true) });
        return true;
      }
      if (head === 'servers' && method === 'PUT' && param) {
        if (!requireAdmin(req, res)) return true;
        const id = int(param);
        const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
        if (!row) { sendError(res, 404, 'NOT_FOUND', '服务器不存在'); return true; }
        const body = await readJsonBody(req);
        const parsed = readServerInput(body, { partial: true });
        if (!parsed.ok) { sendError(res, 400, 'INVALID', parsed.message); return true; }
        const v = parsed.value;
        if (v.address && v.address !== row.address) {
          const dup = db.prepare('SELECT id FROM servers WHERE address = ? AND id != ?').get(v.address, id);
          if (dup) { sendError(res, 409, 'DUPLICATE', '该地址的服务器已存在'); return true; }
        }
        const next = {
          name: v.name ?? row.name,
          address: v.address ?? row.address,
          probe_address: v.probeAddress ?? row.probe_address,
          region: v.region ?? row.region,
          note: v.note ?? row.note,
          sort_order: v.sortOrder ?? row.sort_order,
        };
        db.prepare(`UPDATE servers SET name=?, address=?, probe_address=?, region=?, note=?, sort_order=?, updated_at=? WHERE id=?`)
          .run(next.name, next.address, next.probe_address, next.region, next.note, next.sort_order, Date.now(), id);
        // 公开地址或探测地址一变，两边的探测缓存都要立刻失效，否则最长 10s 内还是旧目标的结论。
        invalidate(probeTargetOf(row)); invalidate(probeTargetOf(next));
        sendJson(res, 200, { server: getServer(id, true) });
        return true;
      }
      if (head === 'servers' && method === 'DELETE' && param) {
        if (!requireAdmin(req, res)) return true;
        const id = int(param);
        const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
        if (!row) { sendError(res, 404, 'NOT_FOUND', '服务器不存在'); return true; }
        db.prepare('DELETE FROM servers WHERE id = ?').run(id);
        invalidate(probeTargetOf(row));
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- accounts (admin only) --------------------------------------------------------------------
      if (head === 'accounts' && method === 'GET' && !param) {
        if (!requireAdmin(req, res)) return true;
        const rows = db.prepare('SELECT * FROM accounts ORDER BY id ASC').all().map(publicAccount);
        sendJson(res, 200, { accounts: rows });
        return true;
      }
      if (head === 'accounts' && method === 'POST' && !param) {
        const admin = requireAdmin(req, res);
        if (!admin) return true;
        const body = await readJsonBody(req);
        const displayName = str(body.displayName, NAME_MAX);
        const loginName = str(body.loginName, LOGIN_MAX);
        const role = str(body.role, 10) || 'user';
        if (!displayName) { sendError(res, 400, 'INVALID', '请填写账号名称'); return true; }
        if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(loginName)) { sendError(res, 400, 'INVALID', '登录名需为 3–32 位字母、数字或 _ . @ -'); return true; }
        if (!['admin', 'user'].includes(role)) { sendError(res, 400, 'INVALID', '角色无效'); return true; }
        const pwErr = validatePassword(body.password);
        if (pwErr) { sendError(res, 400, 'INVALID', pwErr); return true; }
        const dup = db.prepare('SELECT id FROM accounts WHERE lower(login_name) = ?').get(loginName.toLowerCase());
        if (dup) { sendError(res, 409, 'DUPLICATE', '该登录名已被占用'); return true; }
        const now = Date.now();
        const info = db.prepare(`INSERT INTO accounts (display_name, login_name, password_hash, role, disabled, created_at)
                                 VALUES (?, ?, ?, ?, 0, ?)`).run(displayName, loginName, hashPassword(body.password), role, now);
        sendJson(res, 201, { account: publicAccount(getAccount(Number(info.lastInsertRowid))) });
        return true;
      }
      if (head === 'accounts' && param && method === 'POST' && seg[2] === 'password') {
        if (!requireAdmin(req, res)) return true;
        const id = int(param);
        const row = getAccount(id);
        if (!row) { sendError(res, 404, 'NOT_FOUND', '账号不存在'); return true; }
        const body = await readJsonBody(req);
        const pwErr = validatePassword(body.password);
        if (pwErr) { sendError(res, 400, 'INVALID', pwErr); return true; }
        db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), id);
        killSessions(db, id); // a reset invalidates existing sessions
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (head === 'accounts' && method === 'PUT' && param) {
        const admin = requireAdmin(req, res);
        if (!admin) return true;
        const id = int(param);
        const row = getAccount(id);
        if (!row) { sendError(res, 404, 'NOT_FOUND', '账号不存在'); return true; }
        const body = await readJsonBody(req);
        const next = { display_name: row.display_name, role: row.role, disabled: row.disabled };
        if (body.displayName !== undefined) {
          const displayName = str(body.displayName, NAME_MAX);
          if (!displayName) { sendError(res, 400, 'INVALID', '账号名称不能为空'); return true; }
          next.display_name = displayName;
        }
        if (body.role !== undefined) {
          const role = str(body.role, 10);
          if (!['admin', 'user'].includes(role)) { sendError(res, 400, 'INVALID', '角色无效'); return true; }
          if (row.role === 'admin' && role !== 'admin' && row.disabled === 0 && countActiveAdmins() <= 1) {
            sendError(res, 409, 'LAST_ADMIN', '至少需保留一个启用中的管理员账号'); return true;
          }
          next.role = role;
        }
        if (body.disabled !== undefined) {
          const disabled = body.disabled ? 1 : 0;
          if (disabled && row.role === 'admin' && row.disabled === 0 && countActiveAdmins() <= 1) {
            sendError(res, 409, 'LAST_ADMIN', '至少需保留一个启用中的管理员账号'); return true;
          }
          if (disabled && id === admin.id) { sendError(res, 409, 'SELF', '不能停用当前登录的账号'); return true; }
          next.disabled = disabled;
        }
        db.prepare('UPDATE accounts SET display_name=?, role=?, disabled=? WHERE id=?')
          .run(next.display_name, next.role, next.disabled, id);
        if (next.disabled) killSessions(db, id);
        sendJson(res, 200, { account: publicAccount(getAccount(id)) });
        return true;
      }
      if (head === 'accounts' && method === 'DELETE' && param) {
        const admin = requireAdmin(req, res);
        if (!admin) return true;
        const id = int(param);
        const row = getAccount(id);
        if (!row) { sendError(res, 404, 'NOT_FOUND', '账号不存在'); return true; }
        if (id === admin.id) { sendError(res, 409, 'SELF', '不能删除当前登录的账号'); return true; }
        if (row.role === 'admin' && row.disabled === 0 && countActiveAdmins() <= 1) {
          sendError(res, 409, 'LAST_ADMIN', '至少需保留一个启用中的管理员账号'); return true;
        }
        db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
        sendJson(res, 200, { ok: true });
        return true;
      }

      sendError(res, 404, 'NO_ROUTE', '接口不存在');
      return true;
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) deps.log.error('[api]', e);
      sendError(res, status, status === 500 ? 'INTERNAL' : 'BAD_REQUEST', e?.message || '服务器内部错误');
      return true;
    }
  };
}
