import type { Store } from './store.js';

/** Spending limits are off in the local app: paid calls are recorded for Usage, not capped.
 * The public demo keeps them on, so visitors cannot spend without a ceiling. A saved
 * choice ({ on: boolean } in 'spending-limits'/'app') is where an optional limit comes back later. */
export function spendingLimitsOn(store: Store): boolean {
  if (process.env.ROS_PUBLIC_DEMO === '1') return true;
  const env = process.env.ROS_SPENDING_LIMITS?.trim().toLowerCase();
  if (env === 'on') return true;
  if (env === 'off') return false;
  return store.globalRecord<{ on: boolean }>('spending-limits', 'app')?.on === true;
}

/** What an unlimited status reports as remaining: large enough that no single request is refused. */
export const UNLIMITED_USD = 1_000_000;
export const UNLIMITED_REQUESTS = 1_000_000;
