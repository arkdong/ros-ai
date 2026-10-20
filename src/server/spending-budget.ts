import type { Express } from 'express';
import { z } from 'zod';
import type { BudgetStatus, ProviderCredit } from '../shared/budget-report.js';
import type { UsageRecord } from '../shared/types.js';
import { usageProject } from './budget-report.js';
import { Store, StoreError } from './store.js';

/** An optional monthly budget for all projects and for each project, in USD.
 * A request counts its reported cost once settled and its reservation until then,
 * so parallel requests cannot spend past a budget. No budget set means no cap. */
type Saved = { monthlyUsd: number; updatedAt: string };
const amountSchema = z.number().finite().min(0.01).max(100000).nullable();
const counted = (row: UsageRecord) => row.status === 'settled' && typeof row.estimatedUsd === 'number' ? row.estimatedUsd : row.reservedUsd;
const monthStart = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), 1).getTime();

export class SpendingBudget {
  constructor(private readonly store: Store) {}
  private saved(scope: string) { return this.store.globalRecord<Saved | { monthlyUsd: null }>('spending-budget', scope)?.monthlyUsd ?? null; }
  private spent(projectId?: string) {
    const start = monthStart();
    return this.store.listUsage().filter(row => Date.parse(row.createdAt) >= start && (!projectId || usageProject(this.store, row) === projectId)).reduce((sum, row) => sum + counted(row), 0);
  }
  status(projectId?: string | null): BudgetStatus {
    const line = (monthlyUsd: number | null, spentUsd: number) => ({ monthlyUsd, spentUsd, leftUsd: monthlyUsd === null ? null : Math.max(0, monthlyUsd - spentUsd) });
    return { month: new Date(monthStart()).toISOString(), all: line(this.saved('all'), this.spent()), project: projectId ? line(this.saved(`project:${projectId}`), this.spent(projectId)) : null };
  }
  set(scope: 'all' | 'project', projectId: string | undefined, monthlyUsd: unknown) {
    const value = amountSchema.parse(monthlyUsd);
    if (scope === 'project') { if (!projectId) throw new StoreError('Choose a project for its budget.'); this.store.getProject(projectId); }
    this.store.saveGlobalRecord('spending-budget', scope === 'all' ? 'all' : `project:${projectId}`, value === null ? { monthlyUsd: null } : { monthlyUsd: value, updatedAt: new Date().toISOString() });
    return this.status(projectId);
  }
  /** Called inside the atomic admission of every paid request. */
  assertRoom(amountUsd: number, projectId: string | undefined) {
    const all = this.saved('all');
    if (all !== null && this.spent() + amountUsd > all) throw new StoreError(`This month's budget for all projects (US$${all.toFixed(2)}) has no room for this request. Raise it in Settings › General.`, 409);
    const own = projectId ? this.saved(`project:${projectId}`) : null;
    if (own !== null && this.spent(projectId) + amountUsd > own) throw new StoreError(`This project's monthly budget (US$${own.toFixed(2)}) has no room for this request. Raise it in Settings › General.`, 409);
  }

  /** Credit the person read from a provider's console; what ros.ai records afterwards is subtracted. */
  credit(provider: string): ProviderCredit | null {
    const saved = this.store.globalRecord<{ amountUsd: number; setAt: string } | null>('provider-credit', provider);
    if (!saved) return null;
    const since = Date.parse(saved.setAt), spentUsd = this.store.listUsage().filter(row => row.provider === provider && Date.parse(row.createdAt) >= since).reduce((sum, row) => sum + counted(row), 0);
    return { amountUsd: saved.amountUsd, setAt: saved.setAt, spentUsd, leftUsd: Math.max(0, saved.amountUsd - spentUsd) };
  }
  setCredit(provider: string, amountUsd: unknown) {
    const value = z.number().finite().min(0).max(1000000).nullable().parse(amountUsd);
    this.store.saveGlobalRecord('provider-credit', provider, value === null ? null : { amountUsd: value, setAt: new Date().toISOString() });
    return this.credit(provider);
  }
}

export function attachSpendingBudgetRoutes(app: Express, budget: SpendingBudget) {
  app.get('/api/settings/budget', (req, res) => res.json(budget.status(typeof req.query.projectId === 'string' ? req.query.projectId : null)));
  app.put('/api/settings/budget', (req, res) => {
    const body = z.object({ scope: z.enum(['all', 'project']), projectId: z.string().max(128).optional(), monthlyUsd: z.unknown() }).strict().parse(req.body);
    res.json(budget.set(body.scope, body.projectId, body.monthlyUsd));
  });
  app.put('/api/usage/credit/:provider', (req, res) => {
    const provider = z.enum(['nebius', 'openai', 'claude']).parse(req.params.provider);
    res.json({ credit: budget.setCredit(provider, z.object({ amountUsd: z.unknown() }).strict().parse(req.body).amountUsd) });
  });
}
