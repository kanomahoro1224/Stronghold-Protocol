// server/accounts/db.js — PostgreSQL for the account service (accounts, e-mail codes, sessions, cloud saves, match records, demos).
//
// The server runs without a database: `createDb` returns null when no connection string is configured, and every
// caller treats null as "accounts are off" (the REST layer answers 503 with a clear message). docs/ACCOUNTS.md.
//
// Schema is applied once at boot (`ensureSchema`), idempotently: CREATE TABLE IF NOT EXISTS + indexes. No migration
// framework — the project has none and a single JSON state document is its only other store (server/persist.js).

import { Pool } from 'pg';

/** @typedef {{ query: (text: string, params?: any[]) => Promise<any>, pool: Pool, close: () => Promise<void> }} Db */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- password login (2026-11-15): scrypt hash; NULL for an older e-mail-code-only account, which may set one later
  password_hash text,
  -- doctor callsign and the #xxxx tag that follows the account (tag is globally unique)
  display_name text,
  tag          text
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tag text;
-- the 4-digit tag is globally unique; an older account without one is NULL and outside the index
CREATE UNIQUE INDEX IF NOT EXISTS accounts_tag_unique ON accounts (tag) WHERE tag IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_codes (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  purpose     text NOT NULL DEFAULT 'login',
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS email_codes_email_idx ON email_codes (email, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  ua           text
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);

CREATE TABLE IF NOT EXISTS profiles (
  account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  loadouts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_records (
  id         bigserial PRIMARY KEY,
  account_id bigint REFERENCES accounts(id) ON DELETE CASCADE,
  player_id  text,
  match_key  text,
  mode       text,
  difficulty text,
  version    text,
  result     text,
  summary    jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  ended_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_records_account_idx ON match_records (account_id, ended_at DESC);

CREATE TABLE IF NOT EXISTS demos (
  id         bigserial PRIMARY KEY,
  match_key  text UNIQUE,
  mode       text,
  difficulty text,
  version    text,
  seed       bigint,
  players    jsonb NOT NULL DEFAULT '[]'::jsonb,
  events     jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshots  jsonb NOT NULL DEFAULT '[]'::jsonb,
  frames     integer NOT NULL DEFAULT 0,
  bytes      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE demos ADD COLUMN IF NOT EXISTS snapshots jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS account_demos (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  demo_key    text NOT NULL,
  started_at  timestamptz,
  mode        text,
  difficulty  text,
  players     jsonb NOT NULL DEFAULT '[]'::jsonb,
  events      jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshots   jsonb NOT NULL DEFAULT '[]'::jsonb,
  wire        jsonb NOT NULL DEFAULT '[]'::jsonb,
  bytes       integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, demo_key)
);
ALTER TABLE account_demos ADD COLUMN IF NOT EXISTS wire jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS account_demos_account_idx ON account_demos (account_id, started_at DESC);

CREATE TABLE IF NOT EXISTS player_links (
  player_id  text PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  linked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_links_account_idx ON player_links (account_id);
`;

/**
 * Open the pool and apply the schema.
 * @param {{ url?: string | null, log?: { warn?: Function, info?: Function } }} opts
 * @returns {Promise<Db | null>}
 */
export async function createDb({ url = null, log = {} } = {}) {
  const conn = String(url || '').trim();
  if (!conn) return null;
  const pool = new Pool({ connectionString: conn, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', (e) => log.warn?.('[accounts] postgres pool error', e?.message || e));
  await pool.query(SCHEMA);
  log.info?.('[accounts] postgres connected, schema ready');
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}
