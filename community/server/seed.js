// community/server/seed.js — first-boot sample data.
//
// Runs ONLY when the tables are empty, so it never fights an operator's real data. It exists so the console
// and the list page are not blank on a fresh clone, and so the initial admin account is discoverable.
//
// The initial admin's password comes from SP_COMMUNITY_ADMIN_PASSWORD; when unset a random one is generated and
// printed once to the console. It is never written to disk in plaintext.

import { randomBytes } from 'node:crypto';
import { hashPassword } from './db.js';

/** The four nodes shown in the design draft. */
const SAMPLE_SERVERS = [
  { name: '主节点 · 华东一线', address: 'https://t44.kafuno.cn:34046/', region: 'asia', note: '官方主节点', sortOrder: 0 },
  { name: '东京节点 · JP-Tokyo', address: 'https://jp1.stronghold-protocol.net:34046/', region: 'asia', note: '', sortOrder: 10 },
  { name: '法兰克福节点 · EU-Frankfurt', address: 'https://eu1.stronghold-protocol.net:34046/', region: 'europe', note: '', sortOrder: 20 },
  { name: '纽约节点 · NA-New York', address: 'https://na1.stronghold-protocol.net:34046/', region: 'na', note: '', sortOrder: 30 },
];

/**
 * Populate empty tables. @returns {boolean} whether anything was written
 */
export function seedIfEmpty(db, log = console) {
  const serverCount = db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
  const accountCount = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  if (serverCount > 0 && accountCount > 0) return false;

  const now = Date.now();

  if (serverCount === 0) {
    const ins = db.prepare(`INSERT INTO servers (name, address, region, note, sort_order, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const s of SAMPLE_SERVERS) ins.run(s.name, s.address, s.region, s.note, s.sortOrder, now, now);
  }

  if (accountCount === 0) {
    const provided = process.env.SP_COMMUNITY_ADMIN_PASSWORD;
    const password = provided || randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO accounts (display_name, login_name, password_hash, role, disabled, created_at)
                VALUES (?, ?, ?, 'admin', 0, ?)`)
      .run('系统管理员 · master', 'admin', hashPassword(password), now);
    if (!provided) {
      log.info('');
      log.info('  ┌────────────────────────────────────────────────────────────┐');
      log.info('  │  初始管理员账号已创建（请立即登录后台修改密码）            │');
      log.info(`  │  登录名：admin                                             │`);
      log.info(`  │  密码：  ${password.padEnd(49)}│`);
      log.info('  └────────────────────────────────────────────────────────────┘');
      log.info('');
    }
  }

  return true;
}

export { SAMPLE_SERVERS };
