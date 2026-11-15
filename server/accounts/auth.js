// server/accounts/auth.js — e-mail verification codes, passwordless accounts and cookie sessions.
//
// Flow (docs/ACCOUNTS.md):
//   1. POST /api/auth/code  { email, turnstileToken }  — Turnstile first, then a 6-digit code is mailed.
//   2. POST /api/auth/verify { email, code }           — consumes the newest code and issues a session.
//   3. the session is an HttpOnly cookie `sp_sid` (SameSite=Lax); every authenticated API call re-hashes it.
//
// Codes are stored hashed (sha256(email|code|pepper)); the pepper comes from SP_ACCOUNTS_PEPPER or a process-local
// random value (codes then survive a restart only within the same process — acceptable: they expire in 10 min).
// Attempts are capped per code (5) and codes are single-use.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_MIN_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const COOKIE_NAME = 'sp_sid';
const MAX_ATTEMPTS = 5;

/** Reasonable, deliberately loose address check — the mail itself is the proof. */
export function isEmail(value) {
  const s = String(value || '').trim();
  if (s.length < 6 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Await a promise while keeping its rejection out of the HTTP layer.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: any }>}
 */
async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; }
}

/**
 * @param {{ db: any, mailer: any, turnstile: any, pepper?: string,
 *           log?: { info?: Function, warn?: Function } }} deps
 */
export function createAuth({ db, mailer, turnstile, pepper = '', log = {} }) {
  const secret = String(pepper || '').trim() || randomBytes(16).toString('hex');
  const codeHash = (email, code) => sha(`${email}|${code}|${secret}`);
  const tokenHash = (token) => sha(`sid|${token}|${secret}`);

  /** @type {Map<string, number[]>} timestamps (ms) of recent sends, keyed by email and by ip */
  const sends = new Map();
  const RATE = { emailGapMs: 60_000, emailHourMax: 5, ipHourMax: 20 };

  function rateLimited(key, gapMs, hourMax) {
    const now = Date.now();
    const list = (sends.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (gapMs && list.length && now - list[list.length - 1] < gapMs) return 'rate';
    if (list.length >= hourMax) return 'rate';
    list.push(now);
    sends.set(key, list);
    if (sends.size > 5000) for (const [k, v] of sends) if (!v.some((t) => now - t < 60 * 60 * 1000)) sends.delete(k);
    return null;
  }

  return {
    cookieName: COOKIE_NAME,
    sessionTtlMs: SESSION_TTL_MS,

    /**
     * Issue a code.
     * @param {{ email: string, turnstileToken?: string, ip?: string }} input
     */
    async requestCode({ email, turnstileToken, ip } = {}) {
      const normalized = normalizeEmail(email);
      if (!isEmail(normalized)) return { ok: false, status: 400, code: 'EMAIL_INVALID' };
      const ts = await turnstile.verify({ token: turnstileToken, remoteIp: ip });
      if (!ts.ok) return { ok: false, status: 403, code: 'TURNSTILE_FAILED', detail: ts.codes || [] };
      if (rateLimited(`e:${normalized}`, RATE.emailGapMs, RATE.emailHourMax)
        || (ip && rateLimited(`i:${ip}`, 0, RATE.ipHourMax))) {
        return { ok: false, status: 429, code: 'RATE_LIMITED' };
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + CODE_TTL_MIN_MS);
      const res = await settle(() => db.query(
        `INSERT INTO email_codes (email, code_hash, purpose, expires_at) VALUES ($1, $2, 'login', $3) RETURNING id`,
        [normalized, codeHash(normalized, code), expiresAt]));
      if (!res.ok) {
        log.warn?.('[accounts] code insert failed', res.error?.message || res.error);
        return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      }
      const sent = await mailer.sendCode({ to: normalized, code, minutes: Math.round(CODE_TTL_MIN_MS / 60_000) });
      return {
        ok: true, email: normalized, expiresInMs: CODE_TTL_MIN_MS,
        sent: sent.sent,
        // only when mail is not configured AND dev mode is on: a local demo needs the code somewhere
        ...(sent.dev && !sent.sent ? { devCode: code } : {}),
      };
    },

    /**
     * Verify a code and open a session.
     * @param {{ email: string, code: string, ip?: string, ua?: string }} input
     */
    async verify({ email, code, ip, ua } = {}) {
      const normalized = normalizeEmail(email);
      const value = String(code || '').trim();
      if (!isEmail(normalized) || !/^\d{6}$/.test(value)) return { ok: false, status: 400, code: 'CODE_INVALID' };
      const res = await settle(() => db.query(
        `SELECT id, code_hash, attempts, consumed_at FROM email_codes
          WHERE email = $1 AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`, [normalized]));
      if (!res.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      const row = res.value.rows[0];
      if (!row) return { ok: false, status: 400, code: 'CODE_EXPIRED' };
      if (row.consumed_at) return { ok: false, status: 409, code: 'CODE_USED' };
      if (Number(row.attempts) >= MAX_ATTEMPTS) return { ok: false, status: 429, code: 'CODE_LOCKED' };
      const expected = Buffer.from(row.code_hash, 'hex');
      const actual = Buffer.from(codeHash(normalized, value), 'hex');
      const same = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!same) {
        await db.query(`UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]).catch(() => {});
        return { ok: false, status: 400, code: 'CODE_WRONG' };
      }
      const consumed = await settle(() => db.query(
        `UPDATE email_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [row.id]));
      if (!consumed.ok || !consumed.value.rowCount) return { ok: false, status: 409, code: 'CODE_USED' };
      const account = await settle(() => db.query(
        `INSERT INTO accounts (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET last_login_at = now()
         RETURNING id, email, created_at, last_login_at`, [normalized]));
      if (!account.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      const token = randomBytes(32).toString('base64url');
      const inserted = await settle(() => db.query(
        `INSERT INTO sessions (account_id, token_hash, expires_at, ip, ua) VALUES ($1, $2, $3, $4, $5)`,
        [account.value.rows[0].id, tokenHash(token), new Date(Date.now() + SESSION_TTL_MS), ip || null,
          String(ua || '').slice(0, 200)]));
      if (!inserted.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      return { ok: true, token, account: publicAccount(account.value.rows[0]) };
    },

    /** @param {string | undefined} token */
    async resolve(token) {
      if (!token) return null;
      const res = await settle(() => db.query(
        `SELECT a.id, a.email, a.created_at, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id
          WHERE s.token_hash = $1 AND s.expires_at > now() LIMIT 1`, [tokenHash(token)]));
      if (!res.ok || !res.value.rows[0]) return null;
      const row = res.value.rows[0];
      db.query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [tokenHash(token)])
        .catch(() => {});
      return publicAccount(row);
    },

    /** @param {string | undefined} token */
    async logout(token) {
      if (!token) return;
      await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(token)]).catch(() => {});
    },
  };
}

/** @param {any} row */
export function publicAccount(row) {
  return { id: String(row.id), email: row.email, createdAt: row.created_at || null };
}

/** Serialize a session cookie. `secure` only when the request was https (local http demos must work). */
export function sessionCookie(token, { maxAgeMs = SESSION_TTL_MS, secure = false } = {}) {
  const attrs = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.round(maxAgeMs / 1000)}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie({ secure = false } = {}) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** @param {string | undefined} header */
export function readCookie(header, name = COOKIE_NAME) {
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
