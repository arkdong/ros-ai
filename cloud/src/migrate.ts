import { getMigrations } from 'better-auth/db/migration';
import { auth, pool } from './auth.js';
import { LEDGER_SQL } from './ledger.js';

/** Creates or updates every table: Better Auth's (users, sessions, organisations, device codes)
 * and ros.ai's usage ledger. Safe to run on every deploy. */
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
console.log(`Better Auth: ${toBeCreated.length} tables to create, ${toBeAdded.length} to update.`);
await runMigrations();
await pool.query(LEDGER_SQL);
console.log('ros.ai cloud tables are up to date.');
await pool.end();
