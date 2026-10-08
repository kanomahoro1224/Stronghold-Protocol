// community/tools/check-admin.mjs — verify stored credentials for the master admin.

import { openDatabase, verifyPassword } from '../server/db.js';

const db = openDatabase();
const row = db.prepare("SELECT id, display_name, login_name, password_hash, role, disabled FROM accounts WHERE role='admin' ORDER BY id LIMIT 1").get();
db.close();

const [, , attempt] = process.argv;
console.log(`账号 #${row.id}  ${row.display_name}`);
console.log(`  登录名    ${row.login_name}`);
console.log(`  角色      ${row.role}   停用=${row.disabled}`);
console.log(`  新密码校验  ${attempt ? (verifyPassword(attempt, row.password_hash) ? '✓ 通过' : '✗ 失败') : '（未提供）'}`);
