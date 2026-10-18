import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool } from './auth.js';
import { config } from './config.js';

/** One append-only row per model request. The free allowance is read from the same rows that
 * paid credits or metered billing will read later, so the business model can change without
 * a data migration. A request reserves its worst-case cost before it is sent and settles to the
 * reported cost after, so parallel requests can never overspend an allowance. */
export const LEDGER_SQL = `
create table if not exists ros_usage (
  id uuid primary key,
  org_id text not null,
  user_id text not null,
  session_id text not null,
  model text not null,
  upstream_model text not null,
  status text not null check (status in ('reserved', 'settled', 'failed')),
  reserved_usd numeric(12, 6) not null,
  cost_usd numeric(12, 6),
  input_tokens integer,
  output_tokens integer,
  upstream_request_id text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists ros_usage_org_day on ros_usage (org_id, created_at);
`;

/** What a row counts against an allowance: the settled cost, or the reservation while open. */
const counted = `coalesce(cost_usd, reserved_usd)`;

async function spent(db: Pick<pg.Pool, 'query'>, orgId: string) {
  const result = await db.query<{ today: string; pool: string }>(
    `select coalesce(sum(${counted}) filter (where org_id = $1 and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'), 0) as today,
            coalesce(sum(${counted}), 0) as pool from ros_usage where status <> 'failed'`, [orgId]);
  return { today: Number(result.rows[0].today), pool: Number(result.rows[0].pool) };
}

export type Allowance = { dailyUsd: number; usedTodayUsd: number; poolUsd: number; poolUsedUsd: number };

export async function allowance(orgId: string): Promise<Allowance> {
  const used = await spent(pool, orgId);
  return { dailyUsd: config.dailyUsd, usedTodayUsd: used.today, poolUsd: config.poolUsd, poolUsedUsd: used.pool };
}

export class AllowanceError extends Error {}

export async function reserve(input: { orgId: string; userId: string; sessionId: string; model: string; upstreamModel: string; reservedUsd: number }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // One lock for the whole pool keeps the check and the insert atomic across gateway instances.
    await client.query(`select pg_advisory_xact_lock(hashtext('ros_usage'))`);
    const { today, pool: total } = await spent(client, input.orgId);
    if (total + input.reservedUsd > config.poolUsd) throw new AllowanceError('The free ros.ai cloud allowance is used up for now. Use your own agent or download Ros to keep working.');
    if (today + input.reservedUsd > config.dailyUsd) throw new AllowanceError(`Today's free allowance of US$${config.dailyUsd.toFixed(2)} is used up. It resets at midnight UTC.`);
    const id = randomUUID();
    await client.query(`insert into ros_usage (id, org_id, user_id, session_id, model, upstream_model, status, reserved_usd) values ($1, $2, $3, $4, $5, $6, 'reserved', $7)`,
      [id, input.orgId, input.userId, input.sessionId, input.model, input.upstreamModel, input.reservedUsd]);
    await client.query('commit');
    return id;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

/** Settle with the provider's reported usage, or keep the full reservation when the outcome is unknown. */
export async function settle(id: string, outcome: { costUsd: number; inputTokens?: number; outputTokens?: number; upstreamRequestId?: string } | 'refused' | 'unknown') {
  if (outcome === 'unknown') await pool.query(`update ros_usage set status = 'settled', cost_usd = reserved_usd, settled_at = now() where id = $1`, [id]);
  else if (outcome === 'refused') await pool.query(`update ros_usage set status = 'failed', cost_usd = 0, settled_at = now() where id = $1`, [id]);
  else await pool.query(`update ros_usage set status = 'settled', cost_usd = $2, input_tokens = $3, output_tokens = $4, upstream_request_id = $5, settled_at = now() where id = $1`,
    [id, outcome.costUsd, outcome.inputTokens ?? null, outcome.outputTokens ?? null, outcome.upstreamRequestId ?? null]);
}
