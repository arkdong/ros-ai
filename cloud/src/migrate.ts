import { getMigrations } from 'better-auth/db/migration';
import { auth, pool } from './auth.js';
import { LEDGER_SQL } from './ledger.js';
import { METRICS_SQL } from './metrics.js';

/** Creates or updates every table: Better Auth's (users, sessions, organisations, device codes)
 * ros.ai's usage ledger and the metrics views. Safe to run on every deploy. */
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
console.log(`Better Auth: ${toBeCreated.length} tables to create, ${toBeAdded.length} to update.`);
await runMigrations();
await pool.query(LEDGER_SQL);
await pool.query(METRICS_SQL);
console.log('ros.ai cloud tables are up to date.');
await pool.end();
