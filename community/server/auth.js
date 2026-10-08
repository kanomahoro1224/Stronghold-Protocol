// community/server/auth.js — sessions & guards.
//
// Self-registration is OFF by design: accounts exist only because an admin created them in the console.
// A successful login mints a random token; only its SHA-256 is stored (db.js hashToken), and the token travels
// in an HttpOnly cookie. Expired sessions are swept lazily on read.

import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, hashToken, publicAccount } from './db.js';
import { parseCookies, serializeCookie, clearCookie } from './http.js';

export const SESSION_COOKIE = 'sp_community_sid';
const SESSION_TTL_MS = Number(process.env.SP_COMMUNITY_SESSION_TTL_MS || 7 * 24 * 3600 * 1000); // 7 days
const COOKIE_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

// ---- sessions -----------------------------------------------------------------------------------

/** Mint a session for `accountId` and set the cookie. @returns {string} the raw token (only time it exists) */
export function startSession(db, res, accountId, { secure = false } = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), accountId, now, now + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: COOKIE_MAX_AGE_S, secure }));
  return token;
}

/** End the session named by the request cookie. */
export function endSession(db, req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE));
}

/**
 * The account behind this request, or null. Sweeps an expired row when it finds one.
 * @returns {object|null} public account shape
 */
export function currentAccount(db, req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT a.*, s.expires_at AS _expires
    FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!row) return null;
  if (row._expires < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  if (row.disabled) return null; // a disabled account loses its sessions immediately
  return publicAccount(row);
}

/** Every session of an account (used when disabling / deleting a user). */
export function killSessions(db, accountId) {
  db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
}

/** Remove expired session rows. Cheap; called opportunistically on login. */
export function sweepExpired(db) {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch { /* ignore */ }
}

// ---- login / guards -----------------------------------------------------------------------------

/**
 * Verify credentials and start a session. `loginName` is case-insensitive.
 * @returns {{ ok: true, account: object } | { ok: false, code: string, message: string }}
 */
export function login(db, res, loginName, password, { secure = false } = {}) {
  sweepExpired(db);
  const name = String(loginName || '').trim().toLowerCase();
  if (!name || !password) return { ok: false, code: 'MISSING_FIELDS', message: '请输入登录名与密码' };
  const row = db.prepare('SELECT * FROM accounts WHERE lower(login_name) = ?').get(name);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return { ok: false, code: 'BAD_CREDENTIALS', message: '登录名或密码不正确' };
  }
  if (row.disabled) return { ok: false, code: 'DISABLED', message: '该账号已被停用，请联系管理员' };
  db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
  startSession(db, res, row.id, { secure });
  return { ok: true, account: publicAccount({ ...row, last_login_at: Date.now() }) };
}

/** @returns {boolean} whether the request carries an admin session */
export const isAdmin = (account) => !!account && account.role === 'admin' && !account.disabled;

/** Change an account's password (requires the current one). */
export function changePassword(db, accountId, currentPassword, newPassword) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!row) return { ok: false, code: 'NOT_FOUND', message: '账号不存在' };
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return { ok: false, code: 'BAD_PASSWORD', message: '当前密码不正确' };
  }
  const err = validatePassword(newPassword);
  if (err) return { ok: false, code: 'WEAK_PASSWORD', message: err };
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), accountId);
  return { ok: true };
}

/**
 * Password policy. Deliberately modest — an admin hands these out; length is the main defence.
 * @returns {string|null} an error message, or null when acceptable
 */
export function validatePassword(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) return '密码至少 8 位';
  if (s.length > 200) return '密码过长';
  return null;
}

export { hashPassword };
