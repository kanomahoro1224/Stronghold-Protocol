// server/accounts/turnstile.js — Cloudflare Turnstile verification.
//
// The browser widget posts a token with the code request; the server checks it against
// https://challenges.cloudflare.com/turnstile/v0/siteverify. When no secret is configured the official *test*
// secret is used (Cloudflare's always-pass key `1x0000000000000000000000000000000AA`), which is what a local demo
// and the tests run with. A configured secret that Cloudflare rejects yields `{ ok:false, codes }`.

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Cloudflare's documented test keys：site 1x00000000000000000000AA（visible, always passes）. */
export const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

/**
 * @param {{ secret?: string, enabled?: boolean, timeoutMs?: number, log?: { warn?: Function } }} opts
 */
export function createTurnstile(opts = {}) {
  const secret = String(opts.secret || '').trim() || TEST_SECRET;
  const enabled = opts.enabled !== false;
  const timeoutMs = Number(opts.timeoutMs) || 8_000;
  const log = opts.log || {};
  return {
    siteKey: String(opts.siteKey || '').trim() || TEST_SITE_KEY,
    /** false ⇒ the official test keys are in use（本机 demo / 测试）: 任意 token 都能通过，客户端不必渲染挂件. */
    configured: !!String(opts.secret || '').trim(),
    /** @param {{ token?: string, remoteIp?: string }} input */
    async verify({ token, remoteIp } = {}) {
      if (!enabled) return { ok: true, skipped: true };
      const t = String(token || '').trim();
      if (!t) return { ok: false, codes: ['missing-input-response'] };
      const body = new URLSearchParams({ secret, response: t });
      if (remoteIp) body.set('remoteip', remoteIp);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(SITEVERIFY, { method: 'POST', body, signal: ctrl.signal });
        const json = await res.json().catch(() => ({}));
        if (!json.success) return { ok: false, codes: json['error-codes'] || ['invalid-input-response'] };
        return { ok: true, hostname: json.hostname || null, action: json.action || null };
      } catch (e) {
        log.warn?.('[accounts] turnstile verify failed', e?.message || e);
        return { ok: false, codes: ['internal-error'] };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
