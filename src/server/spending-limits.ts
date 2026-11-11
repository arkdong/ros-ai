import type { Store } from './store.js';

/** Spending limits are off: paid calls are recorded for Usage, not capped. A saved
 * choice ({ on: boolean } in 'spending-limits'/'app') is where an optional limit comes back later. */
export function spendingLimitsOn(store: Store): boolean {
  const env = process.env.ROS_SPENDING_LIMITS?.trim().toLowerCase();
  if (env === 'on') return true;
  if (env === 'off') return false;
  return store.globalRecord<{ on: boolean }>('spending-limits', 'app')?.on === true;
}

/** What an unlimited status reports as remaining: large enough that no single request is refused. */
export const UNLIMITED_USD = 1_000_000;
export const UNLIMITED_REQUESTS = 1_000_000;
