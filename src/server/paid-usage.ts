import { randomUUID } from 'node:crypto';
import type { UsageRecord } from '../shared/types.js';
import { Store, StoreError } from './store.js';
import { SpendingBudget } from './spending-budget.js';

const UNITS_PER_USD = 1_000_000_000;
type Reservation = { provider: string; amountUsd: number; purpose: string; basis: string; runId?: string; trace?: Record<string, unknown> };

/** Every paid request is written to Usage before it is sent, at the most it can cost. The optional monthly budget
 * is the only cap: a request it has no room for is refused here, before anything is spent. */
export function reservePaidUsage(store: Store, input: Reservation): UsageRecord {
  return store.atomic(() => {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) throw new StoreError('The cost of this request could not be estimated, so it was not sent.', 409);
    if (!input.purpose.trim() || input.purpose.length > 4000 || !input.basis.trim() || input.basis.length > 4000) throw new StoreError('Invalid request purpose or pricing basis.');
    new SpendingBudget(store).assertRoom(input.amountUsd, typeof input.trace?.projectId === 'string' ? input.trace.projectId : undefined);
    // Rounded up to a billionth of a dollar, so a reservation never reads below its estimate.
    const reservedUsd = Math.ceil(input.amountUsd * UNITS_PER_USD) / UNITS_PER_USD;
    const usage: UsageRecord = { id: randomUUID(), provider: input.provider, purpose: input.purpose, ...(input.runId ? { runId: input.runId } : {}), reservedUsd, estimatedUsd: null, reportedUsage: input.trace ?? {}, status: 'reserved', basis: input.basis, createdAt: new Date().toISOString() };
    store.addUsage(usage);
    return usage;
  });
}

/** Replaces a reservation by the cost the provider reported for a request that completed.
 * Failed, stopped and uncertain requests keep their full reservation. */
export function settlePaidUsage(store: Store, usageId: string, reportedUsd: number, reportedUsage: Record<string, unknown>) {
  if (!Number.isFinite(reportedUsd) || reportedUsd < 0) throw new StoreError('Reported request cost is unreadable; the full reservation stays counted.', 500);
  store.atomic(() => {
    const row = store.getUsage(usageId);
    if (!row || row.status === 'settled') throw new StoreError('This request reservation is missing or already settled.', 409);
    store.updateUsage(usageId, { estimatedUsd: reportedUsd, status: 'settled', reportedUsage: { ...(row.reportedUsage as Record<string, unknown> | null ?? {}), ...reportedUsage } });
  });
}
