/** Read-only views for the numbers we report: sign-ups, weekly active people, retention and use
 * per person. They read Better Auth's tables and the usage ledger, so nothing extra is collected.
 * Weeks start on Monday (UTC); "active" means at least one settled hosted Ros request. */
export const METRICS_SQL = `
create or replace view metrics_signups_daily as
  select date_trunc('day', "createdAt" at time zone 'utc')::date as day, count(*)::int as signups
  from "user" group by 1;

create or replace view metrics_active_weekly as
  select date_trunc('week', created_at at time zone 'utc')::date as week,
         count(distinct user_id)::int as active_users,
         count(*)::int as requests,
         round(count(*)::numeric / count(distinct user_id), 1) as requests_per_user,
         round(sum(cost_usd), 4) as cost_usd,
         round(sum(cost_usd) / count(distinct user_id), 4) as cost_per_user_usd
  from ros_usage where status = 'settled' group by 1;

create or replace view metrics_retention as
  with cohort as (select id, date_trunc('week', "createdAt" at time zone 'utc') as week from "user"),
       active as (select distinct user_id, date_trunc('week', created_at at time zone 'utc') as week from ros_usage where status = 'settled')
  select c.week::date as signup_week,
         count(*)::int as signups,
         count(*) filter (where exists (select 1 from active a where a.user_id = c.id and a.week = c.week))::int as active_first_week,
         count(*) filter (where exists (select 1 from active a where a.user_id = c.id and a.week = c.week + interval '1 week'))::int as active_week_1,
         count(*) filter (where exists (select 1 from active a where a.user_id = c.id and a.week = c.week + interval '4 weeks'))::int as active_week_4
  from cohort c group by 1;
`;

/** The views in the order the report prints them. */
export const METRICS_VIEWS = ['metrics_signups_daily', 'metrics_active_weekly', 'metrics_retention'] as const;
