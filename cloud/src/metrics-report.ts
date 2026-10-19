import pg from 'pg';
import { METRICS_SQL, METRICS_VIEWS } from './metrics.js';

/** Prints the metrics views as tables: `npm run metrics` with DATABASE_URL set. Read-only apart
 * from refreshing the view definitions. */
// Dates print as 2026-10-19, not as midnight timestamps.
pg.types.setTypeParser(1082, value => value);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await pool.query(METRICS_SQL);
  for (const view of METRICS_VIEWS) {
    const { rows } = await pool.query(`select * from ${view} order by 1 desc limit 12`);
    console.log(`\n${view}`);
    if (rows.length) console.table(rows); else console.log('  (no rows yet)');
  }
} finally {
  await pool.end();
}
