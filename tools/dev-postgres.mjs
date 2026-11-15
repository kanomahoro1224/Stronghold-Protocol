// tools/dev-postgres.mjs — a local PostgreSQL for development and tests (embedded binaries, no root needed).
//
// The server itself never starts a database: DATABASE_URL points at whatever Postgres you run. This helper is only
// the "本机起一个" path from docs/ACCOUNTS.md:
//   node tools/dev-postgres.mjs            → initialise .pgdata (once), start on 127.0.0.1:55432, create `stronghold`
//   node tools/dev-postgres.mjs --print    → print the DATABASE_URL and exit (initialises + starts + creates)
//
// Credentials are the ones below (dev only); production uses its own server and puts the URL in SP_DATABASE_URL.

import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.SP_DEV_PG_PORT) || 55432;
const USER = process.env.SP_DEV_PG_USER || 'stronghold';
const PASSWORD = process.env.SP_DEV_PG_PASS || 'stronghold';
const DATABASE = process.env.SP_DEV_PG_DB || 'stronghold';
const DIR = process.env.SP_DEV_PG_DIR || new URL('../.pgdata', import.meta.url).pathname;

const pg = new EmbeddedPostgres({
  databaseDir: DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

async function main() {
  // initialise() runs initdb; an existing cluster makes initdb refuse (“exists but is not empty”). A PG_VERSION
  // marker means the cluster is already there, so only a fresh directory is initialised.
  if (!existsSync(`${DIR}/PG_VERSION`)) await pg.initialise();
  await pg.start();
  await pg.createDatabase(DATABASE).catch((e) => {
    if (!/already exists/i.test(String(e?.message || e))) throw e;
  });
  const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
  console.log(`[dev-postgres] ready: ${url}`);
  if (process.argv.includes('--print')) { await pg.stop(); return; }
  const stop = async () => { try { await pg.stop(); } finally { process.exit(0); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error('[dev-postgres] failed', e); process.exit(1); });
