// server/accounts/index.js — the account service factory (DB + mail + Turnstile + auth + REST + demo recorder).
//
// Everything is opt-in through the environment (docs/ACCOUNTS.md):
//   SP_DATABASE_URL       postgres://user:pass@host:port/db   (DATABASE_URL also accepted)
//   SP_SMTP_HOST/PORT/USER/PASS/FROM                          (absent ⇒ codes are logged, dev echo only with SP_ACCOUNTS_DEV=1)
//   SP_TURNSTILE_SITE / SP_TURNSTILE_SECRET                   (absent ⇒ Cloudflare's always-pass test keys)
//   SP_ACCOUNTS_PEPPER                                        (code/session hashing pepper; random when absent)
//   SP_ACCOUNTS_DEV=1                                         (echo codes when mail is not configured)
//   SP_ACCOUNTS_SERVER_DEMO=1                                 (optional: also record demos on the server)
//
// A server without a database still boots; the API answers 503 and the client hides the account UI.

import { createDb } from './db.js';
import { createMailer } from './mail.js';
import { createTurnstile } from './turnstile.js';
import { createAuth } from './auth.js';
import { createAccountApi } from './api.js';
import { createDemoRecorder } from './recorder.js';

/** @param {Record<string, string | undefined>} env */
function envConfig(env) {
  const dev = env.SP_ACCOUNTS_DEV === '1';
  return {
    databaseUrl: env.SP_DATABASE_URL || env.DATABASE_URL || '',
    smtp: {
      host: env.SP_SMTP_HOST || '',
      port: Number(env.SP_SMTP_PORT) || 0,
      user: env.SP_SMTP_USER || '',
      pass: env.SP_SMTP_PASS || '',
      from: env.SP_SMTP_FROM || '',
    },
    turnstile: { siteKey: env.SP_TURNSTILE_SITE || '', secret: env.SP_TURNSTILE_SECRET || '' },
    pepper: env.SP_ACCOUNTS_PEPPER || '',
    dev,
  };
}

/**
 * @param {{ registry: any, log?: any, env?: Record<string, string | undefined> }} deps
 */
export async function createAccounts({ registry, log = {}, env = process.env } = {}) {
  const cfg = envConfig(env);
  let db = null;
  try {
    db = await createDb({ url: cfg.databaseUrl, log });
  } catch (e) {
    log.warn?.('[accounts] database unavailable, account features disabled', e?.message || e);
    db = null;
  }
  if (!db) {
    log.info?.('[accounts] disabled (no SP_DATABASE_URL / DATABASE_URL)');
    return { db: null, api: null, recorder: null, auth: null, turnstile: null, mailer: null, enabled: false, close: async () => {} };
  }
  const mailer = createMailer({ ...cfg.smtp, dev: cfg.dev, log });
  const turnstile = createTurnstile({ ...cfg.turnstile, log });
  const auth = createAuth({ db, mailer, turnstile, pepper: cfg.pepper, log });
  // Demo 默认只存玩家浏览器（public/js/demoStore.js + demoRecorder.js）。服务端录制仅在显式开启时启用：
  // 老部署可以用它做线上排查，但默认不写库、不重跑，避免服务器承担回放运算。
  const recorder = env.SP_ACCOUNTS_SERVER_DEMO === '1' ? createDemoRecorder({ db, log }) : null;
  const api = createAccountApi({ db, auth, turnstile, mailer, registry, log, dev: cfg.dev });
  return {
    db, api, recorder, auth, turnstile, mailer, enabled: true,
    siteKey: turnstile.siteKey,
    close: async () => { try { mailer.close(); } catch { /* noop */ } await db.close().catch(() => {}); },
  };
}
