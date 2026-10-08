// community/tools/set-admin.mjs — one-shot: rename the master admin's login and reset its password.
//
//   node tools/set-admin.mjs <loginName> <password>
//
// Keeps the LAST_ADMIN guardrails intact (role / disabled untouched). Existing sessions of that
// account are dropped so the new credentials take effect immediately on every device.

import { openDatabase, hashPassword } from '../server/db.js';

const [, , loginName, password] = process.argv;
if (!loginName || !password) {
  console.error('用法: node tools/set-admin.mjs <登录名> <密码>');
  process.exit(1);
}

const db = openDatabase();

const admin = db.prepare("SELECT id, display_name, login_name FROM accounts WHERE role = 'admin' ORDER BY id LIMIT 1").get();
if (!admin) {
  console.error('没有找到管理员账号。');
  process.exit(1);
}

const clash = db.prepare('SELECT id FROM accounts WHERE login_name = ? AND id <> ?').get(loginName, admin.id);
if (clash) {
  console.error(`登录名「${loginName}」已被账号 #${clash.id} 占用。`);
  process.exit(1);
}

db.prepare('UPDATE accounts SET login_name = ?, password_hash = ? WHERE id = ?')
  .run(loginName, hashPassword(password), admin.id);

const killed = db.prepare('DELETE FROM sessions WHERE account_id = ?').run(admin.id).changes;

db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();

console.log('已更新管理员账号：');
console.log(`  id          #${admin.id}`);
console.log(`  显示名      ${admin.display_name}`);
console.log(`  登录名      ${admin.login_name} → ${loginName}`);
console.log(`  密码        （已重置，scrypt 哈希写入）`);
console.log(`  已失效会话  ${killed} 条`);
