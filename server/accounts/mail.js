// server/accounts/mail.js — the e-mail verification code sender.
//
// Two modes:
//   * SMTP configured (SP_SMTP_HOST / SP_SMTP_PORT / SP_SMTP_USER / SP_SMTP_PASS / SP_SMTP_FROM): nodemailer sends
//     the code; STARTTLS is used when the server offers it (port 465 implies implicit TLS).
//   * not configured: the code is only logged (`[accounts] mail not configured`) and — when SP_ACCOUNTS_DEV=1 —
//     echoed in the API response so a local demo can be driven without a mail server. Never echoed otherwise.

import { createTransport } from 'nodemailer';
import { N_ } from '../../shared/i18n.js';

/**
 * @param {{ host?: string, port?: number, user?: string, pass?: string, from?: string, dev?: boolean,
 *           log?: { info?: Function, warn?: Function } }} opts
 */
export function createMailer(opts = {}) {
  const host = String(opts.host || '').trim();
  const port = Number(opts.port) || (host ? 465 : 0);
  const user = String(opts.user || '').trim();
  const pass = String(opts.pass || '');
  const from = String(opts.from || user || '').trim();
  const dev = opts.dev === true;
  const log = opts.log || {};
  const ready = !!(host && from);
  const transport = ready
    ? createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
    : null;

  return {
    ready,
    dev,
    /**
     * Send one code mail. Resolves { sent: boolean, dev: boolean } — never throws for the caller: a failed mail
     * becomes `sent:false` and is logged (the API then tells the client to retry).
     * @param {{ to: string, code: string, minutes: number, purpose?: string }} msg
     */
    async sendCode({ to, code, minutes, purpose = 'login' }) {
      const subject = purpose === 'register' ? N_('注册验证码 · Stronghold Protocol') : N_('登录验证码 · Stronghold Protocol');
      const text = [
        N_('你的验证码是 {code}，{minutes} 分钟内有效。').replace('{code}', code).replace('{minutes}', minutes),
        purpose === 'register' ? N_('用于注册 / 登录 Stronghold Protocol 账号。') : N_('用于登录 Stronghold Protocol 账号。'),
        N_('如果不是你本人操作，请忽略这封邮件。'),
        '',
        `Your verification code is ${code}. It expires in ${minutes} minutes.`,
        'If you did not request it, ignore this message.',
      ].join('\n');
      if (!ready) {
        log.warn?.(`[accounts] mail not configured, code for ${to}: ${dev ? code : '(hidden)'}`);
        return { sent: false, dev };
      }
      try {
        await transport.sendMail({ from, to, subject, text });
        return { sent: true, dev: false };
      } catch (e) {
        log.warn?.('[accounts] smtp send failed', e?.message || e);
        return { sent: false, dev: false };
      }
    },
    close() { try { transport?.close?.(); } catch { /* already closed */ } },
  };
}
