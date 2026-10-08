// community/server/db.js — SQLite store (node:sqlite, stdlib; no native deps).
//
// Three tables:
//   servers  — 社区注册的游戏服务器节点（名称 / 地址 / 区域），列表页据此实时探测 /healthz
//   accounts — 账号（仅管理员可在后台新建；关闭自助注册）。password_hash 用 scrypt
//   sessions — 登录会话（Cookie 存放的 token 的哈希）。关闭浏览器后按 expires_at 过期
//
// The DB file lives next to the service (community/data/community.db) and is created on first boot.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 全球地理大区（用户确认的划分方式）。value 落库，label 用于展示。 */
export const REGIONS = Object.freeze([
  { value: 'asia', label: '亚洲' },
  { value: 'europe', label: '欧洲' },
  { value: 'na', label: '北美' },
  { value: 'sa', label: '南美' },
  { value: 'oceania', label: '大洋洲' },
  { value: 'africa', label: '非洲' },
]);

export const REGION_VALUES = REGIONS.map((r) => r.value);
export const regionLabel = (v) => REGIONS.find((r) => r.value === v)?.label || v;

// ---- password hashing (scrypt, no external deps) ------------------------------------------------

/** @param {string} password @returns {string} `scrypt$<saltHex>$<hashHex>` */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** @param {string} password @param {string} stored @returns {boolean} */
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** session token → the hash we actually store (a leaked DB must not be a set of usable cookies). */
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// ---- schema -------------------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS servers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  -- 公开地址：玩家点「进入服务器」、浏览器测速用的那个。
  address     TEXT    NOT NULL,
  -- 实际探测地址：社区服务器探测 /healthz 时用的那个，留空 = 与 address 相同。
  -- 两者可能不一样：例如 DNS 从社区服务器解析到一个连不通的 IP（线上 t44 就是），而玩家侧一切正常。
  probe_address TEXT  NOT NULL DEFAULT '',
  region      TEXT    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name  TEXT    NOT NULL,
  login_name    TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  disabled      INTEGER NOT NULL DEFAULT 0,        -- 0 启用 / 1 停用
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_servers_region  ON servers(region);
`;

/**
 * Bring an existing database up to the current schema. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each
 * column is checked first; `CREATE TABLE IF NOT EXISTS` above only covers brand-new files.
 */
function migrate(db) {
  const addColumn = (table, name, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return !cols.includes(name);
  };
  return { addedProbeAddress: addColumn('servers', 'probe_address', "probe_address TEXT NOT NULL DEFAULT ''") };
}

/**
 * Open (and migrate) the database.
 * @param {{ file?: string }} [opts]
 */
export function openDatabase(opts = {}) {
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = opts.file || process.env.SP_COMMUNITY_DB || path.join(dataDir, 'community.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// ---- row → API shape (never leak password_hash) -------------------------------------------------

export const publicAccount = (row) => row && ({
  id: row.id,
  displayName: row.display_name,
  loginName: row.login_name,
  role: row.role,
  disabled: !!row.disabled,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at ?? null,
});

/**
 * The address the community server should actually probe: the explicit probe address when set, else the
 * public one. Everything that talks to the node from the server side goes through this.
 * @param {{ address?:string, probe_address?:string }} row
 */
export const probeTargetOf = (row) => (row && row.probe_address) || (row && row.address) || '';

/**
 * Row → API shape (never leak password_hash).
 *
 * `withProbe` is opt-in because `probe_address` is operator plumbing (it can be a bare IP or an internal
 * hostname), so only admin responses include it — the public list must not hand that out.
 */
export const publicServer = (row, { withProbe = false } = {}) => row && ({
  id: row.id,
  name: row.name,
  address: row.address,
  ...(withProbe ? { probeAddress: row.probe_address || '' } : {}),
  region: row.region,
  regionLabel: regionLabel(row.region),
  note: row.note,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
