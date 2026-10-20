import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { connectionBudgetProviders, type ConnectionBudgetProvider, type ConnectionBudgetStatus } from '../shared/connection-budgets.js';
import type { UsageRecord } from '../shared/types.js';
import { Store, StoreError } from './store.js';
import { spendingLimitsOn, UNLIMITED_REQUESTS, UNLIMITED_USD } from './spending-limits.js';
import { SpendingBudget } from './spending-budget.js';

const providerSchema = z.enum(connectionBudgetProviders);
const inputSchema = z.object({ limitUsd: z.number().finite().min(0.000001).max(1000), maxRequests: z.number().int().min(1).max(10000), enabled: z.literal(true), acknowledged: z.literal(true) }).strict();
const namespace = 'connection-allowance';
const UNITS_PER_USD = 1_000_000_000;
// Ceil charges and floor ceilings. Unknown/out-of-range accounting closes the
// gate; floating-point tolerances never authorize additional spending.
const chargeUnits = (usd: number) => Number.isFinite(usd) && usd >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(usd * UNITS_PER_USD)) : Number.MAX_SAFE_INTEGER;
const limitUnits = (usd: number) => Math.floor(usd * UNITS_PER_USD);
// settledUnits is set only when the provider reported a completed request's cost (see settle).
type Admission = { usageId: string; reservedUnits: number; createdAt: string; settledUnits?: number };
type Allowance = { provider: ConnectionBudgetProvider; grantId: string; limitUsd: number; maxRequests: number; enabled: boolean; revision: number; createdAt: string; updatedAt: string; admissions: Admission[] };
export type EnvironmentConnectionBudget = Pick<ConnectionBudgetStatus, 'source' | 'enabled' | 'ready' | 'limitUsd' | 'accountedUsd' | 'maxRequests' | 'usedRequests' | 'reason'>;
type Reservation = { provider: ConnectionBudgetProvider; amountUsd: number; purpose: string; basis: string; runId?: string; trace?: Record<string, unknown> };

/** A user-managed connection grant across local projects, separate from project
 * permissions, account credit and historical environment/sandbox allowances.
 * There is no reset/delete/identifier API. Every dispatch retains its admission
 * after failure, pause, edits, credential replacement and service restart. */
export class ConnectionBudgets {
  constructor(private readonly store: Store, private readonly environment?: (provider: ConnectionBudgetProvider) => EnvironmentConnectionBudget, private readonly appBlocker?: () => string | null) {}

  private saved(provider: ConnectionBudgetProvider) { return this.store.globalRecord<Allowance>(namespace, provider); }
  private accounted(saved: Allowance): number {
    const usage = new Map(this.store.listUsage().filter(row => row.provider === saved.provider).map(row => [row.id, row]));
    return saved.admissions.reduce((total, admission) => {
      const row = usage.get(admission.usageId);
      if (admission.settledUnits !== undefined) return Math.min(Number.MAX_SAFE_INTEGER, total + Math.max(admission.settledUnits, chargeUnits(row?.estimatedUsd ?? 0)));
      return Math.min(Number.MAX_SAFE_INTEGER, total + Math.max(admission.reservedUnits, chargeUnits(row?.reservedUsd ?? 0), chargeUnits(row?.estimatedUsd ?? 0)));
    }, 0);
  }

  status(provider: ConnectionBudgetProvider, requiredUsd = 1 / UNITS_PER_USD): ConnectionBudgetStatus {
    const saved = this.saved(provider);
    if (!spendingLimitsOn(this.store)) {
      // No ceiling: every request is still recorded, so Usage shows what was spent.
      const blocker = this.appBlocker?.() ?? null;
      return { provider, source: 'app', enabled: true, ready: !blocker, limited: false, limitUsd: 0, accountedUsd: saved ? this.accounted(saved) / UNITS_PER_USD : 0, remainingUsd: UNLIMITED_USD, maxRequests: 0, usedRequests: saved?.admissions.length ?? 0, remainingRequests: UNLIMITED_REQUESTS, reason: blocker ?? 'No spending limit is set. Every request is recorded in Usage.', revision: saved?.revision ?? null, updatedAt: saved?.updatedAt ?? null };
    }
    if (!saved) {
      const environment = this.environment?.(provider) ?? { source: 'none' as const, enabled: false, ready: false, limitUsd: 0, accountedUsd: 0, maxRequests: 0, usedRequests: 0, reason: 'Save an explicit connection allowance before paid research. A credential or account balance does not authorize spending.' };
      const remainingUsd = Math.max(0, limitUnits(environment.limitUsd) - chargeUnits(environment.accountedUsd)) / UNITS_PER_USD;
      const remainingRequests = Math.max(0, environment.maxRequests - environment.usedRequests);
      const ready = environment.ready && remainingRequests > 0 && Number.isFinite(requiredUsd) && requiredUsd > 0 && chargeUnits(requiredUsd) <= limitUnits(remainingUsd);
      return { provider, ...environment, remainingUsd, remainingRequests, ready, revision: null, updatedAt: null };
    }
    const accounted = this.accounted(saved), remainingUnits = Math.max(0, limitUnits(saved.limitUsd) - accounted);
    const usedRequests = saved.admissions.length, remainingRequests = Math.max(0, saved.maxRequests - usedRequests);
    const blocker=this.appBlocker?.();
    let reason = 'App allowance active across local projects. Project permissions still apply; retained reservations are admission accounting, not account credit or an invoice.';
    if (blocker) reason=blocker;
    else if (!saved.enabled) reason = 'Connection allowance paused. Retained reservations and request counts are unchanged; environment grants cannot replace a saved app allowance.';
    else if (remainingRequests === 0) reason = 'Connection request limit reached. Failed and uncertain requests count; editing the ceiling retains previous use.';
    else if (!Number.isFinite(requiredUsd) || requiredUsd <= 0 || chargeUnits(requiredUsd) > remainingUnits) reason = 'The conservative request reservation exceeds the connection allowance. Previous, failed and uncertain requests remain accounted.';
    const ready = !blocker && saved.enabled && remainingRequests > 0 && Number.isFinite(requiredUsd) && requiredUsd > 0 && chargeUnits(requiredUsd) <= remainingUnits;
    return { provider, source: 'app', enabled: saved.enabled, ready, limitUsd: saved.limitUsd, accountedUsd: accounted / UNITS_PER_USD, remainingUsd: remainingUnits / UNITS_PER_USD, maxRequests: saved.maxRequests, usedRequests, remainingRequests, reason, revision: saved.revision, updatedAt: saved.updatedAt };
  }
  statuses() { return connectionBudgetProviders.map(provider => this.status(provider)); }

  save(provider: ConnectionBudgetProvider, supplied: unknown) {
    providerSchema.parse(provider);
    const input = inputSchema.parse(supplied);
    return this.store.atomic(() => {
      const saved = this.saved(provider), at = new Date().toISOString();
      if(saved&&limitUnits(input.limitUsd)<this.accounted(saved))throw new StoreError('The connection spending ceiling cannot be below retained usage. Previous reservations never reset; pause the allowance to stop new dispatch.',409);
      if(saved&&input.maxRequests<saved.admissions.length)throw new StoreError('The connection request ceiling cannot be below already admitted requests. Pause the allowance to stop new dispatch.',409);
      this.store.saveGlobalRecord(namespace, provider, { provider, grantId: saved?.grantId ?? randomUUID(), limitUsd: input.limitUsd, maxRequests: input.maxRequests, enabled: true, revision: (saved?.revision ?? 0) + 1, createdAt: saved?.createdAt ?? at, updatedAt: at, admissions: saved?.admissions ?? [] } satisfies Allowance);
      return this.status(provider);
    });
  }
  pause(provider: ConnectionBudgetProvider, supplied: unknown) {
    providerSchema.parse(provider); z.object({}).strict().parse(supplied);
    return this.store.atomic(() => {
      const saved = this.saved(provider), at = new Date().toISOString();
      // Persist a tombstone even before the first grant, preventing environment
      // fallback after the user deliberately pauses this connection.
      this.store.saveGlobalRecord(namespace, provider, { provider, grantId: saved?.grantId ?? randomUUID(), limitUsd: saved?.limitUsd ?? 0, maxRequests: saved?.maxRequests ?? 0, enabled: false, revision: (saved?.revision ?? 0) + 1, createdAt: saved?.createdAt ?? at, updatedAt: at, admissions: saved?.admissions ?? [] } satisfies Allowance);
      return this.status(provider);
    });
  }
  assertRevision(provider: ConnectionBudgetProvider, expected: number | null) {
    if ((this.saved(provider)?.revision ?? null) !== expected) throw new StoreError('The connection allowance changed while preparing this request. No paid dispatch occurred; start a new request under its current terms.', 409);
  }
  reserve(input: Reservation, expectedRevision: number | null): UsageRecord {
    return this.store.atomic(() => {
      this.assertRevision(input.provider, expectedRevision);
      const status = this.status(input.provider, input.amountUsd), unlimited = !spendingLimitsOn(this.store);
      let saved = this.saved(input.provider);
      if (!status.ready || (!saved && !unlimited)) throw new StoreError(status.reason, 409);
      if (!saved) {
        // The first request without a limit opens the ledger that records this connection's use.
        const created = new Date().toISOString();
        saved = { provider: input.provider, grantId: randomUUID(), limitUsd: 0, maxRequests: 0, enabled: true, revision: 1, createdAt: created, updatedAt: created, admissions: [] };
      }
      if (!input.purpose.trim() || input.purpose.length > 4000 || !input.basis.trim() || input.basis.length > 4000) throw new StoreError('Invalid connection reservation purpose or pricing basis.');
      new SpendingBudget(this.store).assertRoom(input.amountUsd, typeof input.trace?.projectId === 'string' ? input.trace.projectId : undefined);
      const at = new Date().toISOString(), units = chargeUnits(input.amountUsd);
      const usage: UsageRecord = { id: randomUUID(), provider: input.provider, purpose: input.purpose, ...(input.runId ? { runId: input.runId } : {}), reservedUsd: units / UNITS_PER_USD, estimatedUsd: null, reportedUsage: { ...(input.trace ?? {}), connectionBudgetSource: 'app', connectionBudgetGrantId: saved.grantId, connectionBudgetRevision: saved.revision }, status: 'reserved', basis: input.basis, createdAt: at };
      this.store.addUsage(usage);
      this.store.saveGlobalRecord(namespace, input.provider, { ...saved, admissions: [...saved.admissions, { usageId: usage.id, reservedUnits: units, createdAt: at }] } satisfies Allowance);
      return usage;
    });
  }
  /** Replaces a reservation by the cost the provider reported for a request that
   * completed. Failed, stopped and uncertain requests keep their full reservation. */
  settle(provider: ConnectionBudgetProvider, usageId: string, reportedUsd: number, reportedUsage: Record<string, unknown>) {
    if (!Number.isFinite(reportedUsd) || reportedUsd < 0) throw new StoreError('Reported request cost is unreadable; the full reservation stays counted.', 500);
    return this.store.atomic(() => {
      const saved = this.saved(provider), admission = saved?.admissions.find(item => item.usageId === usageId);
      if (!saved || !admission || admission.settledUnits !== undefined) throw new StoreError('This request reservation is missing or already settled.', 409);
      const row = this.store.listUsage().find(item => item.id === usageId);
      this.store.updateUsage(usageId, { estimatedUsd: reportedUsd, status: 'settled', reportedUsage: { ...(row?.reportedUsage as Record<string, unknown> | null ?? {}), ...reportedUsage } });
      this.store.saveGlobalRecord(namespace, provider, { ...saved, admissions: saved.admissions.map(item => item === admission ? { ...item, settledUnits: chargeUnits(reportedUsd) } : item) } satisfies Allowance);
      return this.status(provider);
    });
  }
}

/** Attach only to the private local app, after its host/origin/JSON guards. */
export function attachConnectionBudgetRoutes(app: Express, budgets: ConnectionBudgets) {
  app.get('/api/connections/budgets', (_req, res) => res.json({ budgets: budgets.statuses() }));
  app.put('/api/connections/budgets/:provider', (req, res) => {
    if (!req.is('application/json')) throw new StoreError('Send a JSON connection allowance.', 415);
    res.json(budgets.save(providerSchema.parse(req.params.provider), req.body));
  });
  app.post('/api/connections/budgets/:provider/pause', (req, res) => {
    if (!req.is('application/json')) throw new StoreError('Send a JSON connection allowance pause.', 415);
    res.json(budgets.pause(providerSchema.parse(req.params.provider), req.body));
  });
}
