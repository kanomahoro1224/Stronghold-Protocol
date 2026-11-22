// server/accounts/auth.js — e-mail verification codes, password login/reset and cookie sessions.
//
// Flow (docs/ACCOUNTS.md):
//   1. POST /api/auth/code           { email, turnstileToken, mode? } — Turnstile first, then a 6-digit code is mailed.
//   2. POST /api/auth/verify         { email, code, password? }       — consumes a login-purpose code and issues a session (register/modal).
//   3. POST /api/auth/password       { email, password }              — password login, no code, issues a session.
//   4. POST /api/auth/reset-password { email, code, password }        — consumes a reset-purpose code, replaces the hash, no session.
//   5. the session is an HttpOnly cookie `sp_sid` (SameSite=Lax); every authenticated API call re-hashes it.
//
// Codes are stored hashed (sha256(email|code|pepper)); the pepper comes from SP_ACCOUNTS_PEPPER or a process-local
// random value (codes then survive a restart only within the same process — acceptable: they expire in 10 min).
// Attempts are capped per code (5) and codes are single-use.

import { createHash, randomBytes, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const CODE_TTL_MIN_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const COOKIE_NAME = 'sp_sid';
const MAX_ATTEMPTS = 5;

/** 密码登录（2026-11-15 用户要求）：scrypt(N=16384, r=8, p=1) + 每条独立盐，存成 `scrypt$N$r$p$salt$hash`。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${Buffer.from(key).toString('base64')}`;
}

/** @param {string} password @param {string | null | undefined} stored */
export async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const want = Buffer.from(keyB64, 'base64');
  if (!want.length) return false;
  const got = Buffer.from(await scrypt(String(password), Buffer.from(saltB64, 'base64'), want.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** 4 位数字识别号（#0427）：跟着账号、全局唯一。 */
export const isTag = (value) => typeof value === 'string' && /^\d{4}$/.test(value);
export const isPassword = (value) => typeof value === 'string' && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;

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
  const RATE = { emailGapMs: 60_000, emailHourMax: 5, ipHourMax: 20, passwordHourMax: 10, passwordIpHourMax: 60 };

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
     * Issue a code. `mode: 'reset'` stores a reset-purpose code and checks that the account exists; reset codes
     * can never be spent by verify() to open a session.
     * @param {{ email: string, turnstileToken?: string, ip?: string, mode?: 'register' | 'login' | 'reset' }} input
     */
    async requestCode({ email, turnstileToken, ip, mode } = {}) {
      const normalized = normalizeEmail(email);
      if (!isEmail(normalized)) return { ok: false, status: 400, code: 'EMAIL_INVALID' };
      const ts = await turnstile.verify({ token: turnstileToken, remoteIp: ip });
      if (!ts.ok) return { ok: false, status: 403, code: 'TURNSTILE_FAILED', detail: ts.codes || [] };
      // 标题页右侧的「登录」「注册」「忘记密码」三个入口（用户 2026-11-15 / 2026-11-22）：注册拒绝已存在的邮箱，
      // 登录和重置都拒绝没注册过的邮箱。不带 mode（弹窗入口、旧客户端）保持原样——验证码即注册即登录。
      // 放在人机验证之后，避免免验证枚举。
      if (mode === 'register' || mode === 'login' || mode === 'reset') {
        const exists = await settle(() => db.query('SELECT 1 FROM accounts WHERE email = $1 LIMIT 1', [normalized]));
        if (!exists.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
        const found = !!exists.value.rows[0];
        if (mode === 'register' && found) return { ok: false, status: 409, code: 'ACCOUNT_EXISTS' };
        if ((mode === 'login' || mode === 'reset') && !found) return { ok: false, status: 404, code: 'ACCOUNT_NOT_FOUND' };
      }
      if (rateLimited(`e:${normalized}`, RATE.emailGapMs, RATE.emailHourMax)
        || (ip && rateLimited(`i:${ip}`, 0, RATE.ipHourMax))) {
        return { ok: false, status: 429, code: 'RATE_LIMITED' };
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + CODE_TTL_MIN_MS);
      // 注册沿用 login purpose（verify 仍用它完成注册 / 弹窗登录）；只有忘记密码写 reset。
      const purpose = mode === 'reset' ? 'reset' : 'login';
      const res = await settle(() => db.query(
        `INSERT INTO email_codes (email, code_hash, purpose, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [normalized, codeHash(normalized, code), purpose, expiresAt]));
      if (!res.ok) {
        log.warn?.('[accounts] code insert failed', res.error?.message || res.error);
        return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      }
      const sent = await mailer.sendCode({
        to: normalized, code, minutes: Math.round(CODE_TTL_MIN_MS / 60_000), purpose,
      });
      return {
        ok: true, email: normalized, expiresInMs: CODE_TTL_MIN_MS,
        sent: sent.sent,
        // only when mail is not configured AND dev mode is on: a local demo needs the code somewhere
        ...(sent.dev && !sent.sent ? { devCode: code } : {}),
      };
    },

    /**
     * Verify a code and open a session. Registration is the same call: an optional password / 博士代号 / #tag is
     * stored on a new account and fills the gaps of an older one (never overwrites an existing value).
     * @param {{ email: string, code: string, ip?: string, ua?: string,
     *           password?: string, name?: string, tag?: string }} input
     */
    async verify({ email, code, ip, ua, password, name, tag } = {}) {
      const normalized = normalizeEmail(email);
      const value = String(code || '').trim();
      if (!isEmail(normalized) || !/^\d{6}$/.test(value)) return { ok: false, status: 400, code: 'CODE_INVALID' };
      if (password != null && password !== '' && !isPassword(password)) return { ok: false, status: 400, code: 'PASSWORD_WEAK' };
      if (tag != null && tag !== '' && !isTag(tag)) return { ok: false, status: 400, code: 'TAG_INVALID' };
      const res = await settle(() => db.query(
        `SELECT id, code_hash, attempts, consumed_at FROM email_codes
          WHERE email = $1 AND purpose = 'login' AND expires_at > now()
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
      // 识别号先查占用再消费验证码：撞号时玩家换个号重提，同一个验证码还能用（否则要等 60 秒再收一封）
      if (isTag(tag)) {
        const taken = await settle(() => db.query('SELECT 1 FROM accounts WHERE tag = $1 LIMIT 1', [tag]));
        if (!taken.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
        if (taken.value.rows[0]) return { ok: false, status: 409, code: 'TAG_TAKEN' };
      }
      const consumed = await settle(() => db.query(
        `UPDATE email_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [row.id]));
      if (!consumed.ok || !consumed.value.rowCount) return { ok: false, status: 409, code: 'CODE_USED' };
      const passHash = password ? await hashPassword(password) : null;
      const cleanName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
      const tagValue = isTag(tag) ? tag : null;
      const account = await settle(() => db.query(
        `INSERT INTO accounts (email, password_hash, display_name, tag, last_login_at)
         VALUES ($1, $2, NULLIF($3, ''), $4, now())
         ON CONFLICT (email) DO UPDATE SET
           last_login_at = now(),
           password_hash = COALESCE(accounts.password_hash, EXCLUDED.password_hash),
           display_name  = COALESCE(accounts.display_name, EXCLUDED.display_name),
           tag           = COALESCE(accounts.tag, EXCLUDED.tag)
         RETURNING id, email, created_at, last_login_at, display_name, tag`, [normalized, passHash, cleanName, tagValue]));
      if (!account.ok) {
        // 4 位识别号的唯一索引（accounts_tag_unique）撞了：换一个号
        if (account.error?.code === '23505') return { ok: false, status: 409, code: 'TAG_TAKEN' };
        return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      }
      const token = randomBytes(32).toString('base64url');
      const inserted = await settle(() => db.query(
        `INSERT INTO sessions (account_id, token_hash, expires_at, ip, ua) VALUES ($1, $2, $3, $4, $5)`,
        [account.value.rows[0].id, tokenHash(token), new Date(Date.now() + SESSION_TTL_MS), ip || null,
          String(ua || '').slice(0, 200)]));
      if (!inserted.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      return { ok: true, token, account: publicAccount(account.value.rows[0]) };
    },

    /**
     * 忘记密码（2026-11-22 用户要求）：只消费 purpose=reset 的验证码，覆盖 password_hash，但绝不建会话。
     * 账号不存在时在验证码哈希通过后才回 CODE_WRONG（与验证码错误同一个对外表现），且不消费验证码，
     * 不给未登录调用方一个提前枚举邮箱的接口。
     * @param {{ email: string, code: string, password: string }} input
     */
    async resetPassword({ email, code, password } = {}) {
      const normalized = normalizeEmail(email);
      const value = String(code || '').trim();
      if (!isEmail(normalized) || !/^\d{6}$/.test(value)) return { ok: false, status: 400, code: 'CODE_INVALID' };
      if (!isPassword(password)) return { ok: false, status: 400, code: 'PASSWORD_WEAK' };
      const res = await settle(() => db.query(
        `SELECT id, code_hash, attempts, consumed_at FROM email_codes
          WHERE email = $1 AND purpose = 'reset' AND expires_at > now()
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
      // 验证码对了也先确认账号存在：不存在就按「验证码不对」返回，不透露邮箱是否注册，也不消费验证码。
      const found = await settle(() => db.query('SELECT id FROM accounts WHERE email = $1 LIMIT 1', [normalized]));
      if (!found.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      const account = found.value.rows[0];
      if (!account) return { ok: false, status: 400, code: 'CODE_WRONG' };
      const passHash = await hashPassword(password);
      // 消费验证码与覆盖密码放在同一条语句：并发点击只有一个请求能成功，另一个回 CODE_USED。
      const saved = await settle(() => db.query(
        `WITH consumed AS (
           UPDATE email_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id
         )
         UPDATE accounts SET password_hash = $2
          WHERE id = $3 AND EXISTS (SELECT 1 FROM consumed)
          RETURNING id`, [row.id, passHash, account.id]));
      if (!saved.ok) {
        log.warn?.('[accounts] password reset failed', saved.error?.message || saved.error);
        return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      }
      if (!saved.value.rowCount) return { ok: false, status: 409, code: 'CODE_USED' };
      return { ok: true };
    },

    /**
     * 密码登录（2026-11-15）：邮箱 + 密码，省去每次都收验证码。失败一律 BAD_CREDENTIALS，不区分
     * 「没有这个邮箱」和「密码不对」，避免被用来枚举账号。
     * @param {{ email: string, password: string, ip?: string, ua?: string }} input
     */
    async loginWithPassword({ email, password, ip, ua } = {}) {
      const normalized = normalizeEmail(email);
      if (!isEmail(normalized) || !password) return { ok: false, status: 401, code: 'BAD_CREDENTIALS' };
      if (rateLimited(`p:${normalized}`, 0, RATE.passwordHourMax)
        || (ip && rateLimited(`pi:${ip}`, 0, RATE.passwordIpHourMax))) {
        return { ok: false, status: 429, code: 'RATE_LIMITED' };
      }
      const found = await settle(() => db.query(
        `SELECT id, email, created_at, last_login_at, password_hash, display_name, tag FROM accounts WHERE email = $1`, [normalized]));
      if (!found.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      const row = found.value.rows[0];
      if (!row?.password_hash) return { ok: false, status: 401, code: 'BAD_CREDENTIALS' };
      if (!(await checkPassword(password, row.password_hash))) return { ok: false, status: 401, code: 'BAD_CREDENTIALS' };
      await db.query(`UPDATE accounts SET last_login_at = now() WHERE id = $1`, [row.id]).catch(() => {});
      const token = randomBytes(32).toString('base64url');
      const inserted = await settle(() => db.query(
        `INSERT INTO sessions (account_id, token_hash, expires_at, ip, ua) VALUES ($1, $2, $3, $4, $5)`,
        [row.id, tokenHash(token), new Date(Date.now() + SESSION_TTL_MS), ip || null, String(ua || '').slice(0, 200)]));
      if (!inserted.ok) return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      return { ok: true, token, account: publicAccount(row) };
    },

    /**
     * 保存博士代号 / #tag（登录后调用）。只补空位，不覆盖已有值：识别号一旦定下就跟着账号走。
     * @param {{ account: any, name?: string, tag?: string }} input
     */
    async setProfile({ account, name, tag } = {}) {
      if (!account?.id) return { ok: false, status: 401, code: 'NOT_LOGGED_IN' };
      if (tag != null && tag !== '' && !isTag(tag)) return { ok: false, status: 400, code: 'TAG_INVALID' };
      const cleanName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
      const res = await settle(() => db.query(
        `UPDATE accounts SET
           display_name = COALESCE(display_name, NULLIF($2, '')),
           tag = COALESCE(tag, $3)
         WHERE id = $1
         RETURNING id, email, created_at, last_login_at, display_name, tag`,
        [account.id, cleanName, isTag(tag) ? tag : null]));
      if (!res.ok) {
        if (res.error?.code === '23505') return { ok: false, status: 409, code: 'TAG_TAKEN' };
        return { ok: false, status: 503, code: 'DB_UNAVAILABLE' };
      }
      return { ok: true, account: publicAccount(res.value.rows[0] || {}) };
    },

    /** @param {string | undefined} token */
    async resolve(token) {
      if (!token) return null;
      const res = await settle(() => db.query(
        `SELECT a.id, a.email, a.created_at, a.display_name, a.tag, s.expires_at
           FROM sessions s JOIN accounts a ON a.id = s.account_id
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
  return {
    id: String(row.id), email: row.email, createdAt: row.created_at || null,
    name: row.display_name || null, tag: row.tag || null,
  };
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
