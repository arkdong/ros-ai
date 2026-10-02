import { createHash } from 'node:crypto';
import type { ModelSelection } from '../shared/model-settings.js';
import type { UsageRecord } from '../shared/types.js';
import { Store, StoreError } from './store.js';

// A separately authorized, one-time comparison. It never reuses or resets the
// September 22 combined grant. These terms are intentionally not configurable.
export const COMPARISON_SCOPE = 'three-model-comparison-2026-09-23';
export const COMPARISON_AUTHORIZATION_ID = 'benchmark-20260923-v1';
export const COMPARISON_RERUN_SCOPE = 'three-model-comparison-2026-09-23-v2';
export const COMPARISON_RERUN_AUTHORIZATION_ID = 'benchmark-20260923-v2';
const TERMS = {
  openai: { provider: 'openai', model: 'gpt-5.4', maxUsd: 10 },
  nemotron: { provider: 'nebius', model: 'nvidia/Nemotron-3-Ultra-550b-a55b', maxUsd: 20 },
  kimi: { provider: 'nebius', model: 'moonshotai/Kimi-K2.7-Code', maxUsd: 10 },
} as const;
type Key = keyof typeof TERMS;
type ComparisonTerms = Record<Key, { provider: 'openai' | 'nebius'; model: string; maxUsd: number }>;
type GrantTerms = { scope: string; authorizationId: string; maxUsd: 40 | 90; nebiusUsd: number; openaiUsd: number; outputTokenCap: number; terms: ComparisonTerms };
const GRANTS: Record<string, GrantTerms> = {
  [COMPARISON_AUTHORIZATION_ID]: { scope: COMPARISON_SCOPE, authorizationId: COMPARISON_AUTHORIZATION_ID, maxUsd: 40, nebiusUsd: 30, openaiUsd: 10, outputTokenCap: 1400, terms: TERMS },
  [COMPARISON_RERUN_AUTHORIZATION_ID]: {
    scope: COMPARISON_RERUN_SCOPE, authorizationId: COMPARISON_RERUN_AUTHORIZATION_ID, maxUsd: 90, nebiusUsd: 60, openaiUsd: 30, outputTokenCap: 8000,
    terms: { openai: { ...TERMS.openai, maxUsd: 30 }, nemotron: { ...TERMS.nemotron, maxUsd: 30 }, kimi: { ...TERMS.kimi, maxUsd: 30 } },
  },
};
type Projects = Record<Key, string>;
type Admission = { usageId: string; key: Key; projectId: string; reservedUnits: number; createdAt: string };
type Grant = { signature: string; projects: Projects; authorizationId: string; maxUsd: 40 | 90; admissions: Admission[] };
const UNITS_PER_USD = 1_000_000_000;
const units = (usd: number) => Math.ceil(usd * UNITS_PER_USD);

export class ComparisonBudget {
  private readonly signature: string;
  private constructor(private readonly store: Store, private readonly projects: Projects, private readonly grant: GrantTerms) {
    this.signature = createHash('sha256').update(JSON.stringify({ projects, terms: grant.terms, authorizationId: grant.authorizationId })).digest('hex');
  }

  get outputTokenCap(): number { return this.grant.outputTokenCap; }

  static fromEnvironment(store: Store): ComparisonBudget | undefined {
    const authorizationId = process.env.ROS_MODEL_COMPARISON_AUTHORIZATION_ID?.trim();
    if (!authorizationId) return;
    const grant = Object.hasOwn(GRANTS, authorizationId) ? GRANTS[authorizationId] : undefined;
    if (!grant) throw new Error('Unknown three-model comparison authorization; identifiers cannot create another grant.');
    const value = JSON.parse(process.env.ROS_MODEL_COMPARISON_PROJECTS || '{}') as Record<string, unknown>;
    if (!value || Object.keys(value).length !== 3 || Object.keys(TERMS).some(key => typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value[key] as string)) || new Set(Object.values(value)).size !== 3) throw new Error('Comparison authorization requires the three distinct saved project IDs.');
    // Canonical key order makes equivalent environment JSON produce the same grant.
    return new ComparisonBudget(store, { openai: value.openai as string, nemotron: value.nemotron as string, kimi: value.kimi as string }, grant);
  }

  validateProviderSettings(nebiusId: string | undefined, nebiusUsd: number, openaiId: string | undefined, openaiUsd: number): void {
    if (nebiusId !== `${this.grant.authorizationId}-nebius` || openaiId !== `${this.grant.authorizationId}-openai` || nebiusUsd !== this.grant.nebiusUsd || openaiUsd !== this.grant.openaiUsd) throw new Error(`Comparison requires its retained provider identifiers and exactly US$${this.grant.nebiusUsd} Nebius plus US$${this.grant.openaiUsd} OpenAI ceilings.`);
  }

  private saved(): Grant | undefined { return this.store.record<Grant>('model-comparison-grant', this.grant.scope); }
  private key(projectId: string | undefined, selection: ModelSelection | undefined): Key | undefined {
    return (Object.keys(TERMS) as Key[]).find(key => this.projects[key] === projectId && this.grant.terms[key].provider === selection?.provider && this.grant.terms[key].model === selection.model);
  }
  private accounted(admissions: Admission[]): number {
    const usage = new Map(this.store.listUsage().map(row => [row.id, row]));
    return admissions.reduce((total, admission) => {
      const row = usage.get(admission.usageId);
      return total + Math.max(admission.reservedUnits, units(row?.reservedUsd ?? 0), units(row?.estimatedUsd ?? 0));
    }, 0);
  }

  status(projectId?: string, selection?: ModelSelection, requiredUsd = 1 / UNITS_PER_USD) {
    const saved = this.saved(), key = this.key(projectId, selection), admissions = saved?.admissions ?? [];
    const accountedUsd = this.accounted(admissions) / UNITS_PER_USD;
    const base = { scope: this.grant.scope, maxUsd: this.grant.maxUsd, accountedUsd, remainingUsd: Math.max(0, this.grant.maxUsd - accountedUsd) };
    if (saved && saved.signature !== this.signature) return { ...base, ready: false, reason: 'The saved comparison grant belongs to different project IDs. Restore its settings; moving projects cannot replenish it.' };
    if (!key) return { ...base, ready: false, reason: 'This authorization covers only the three saved comparison projects with their exact approved models.' };
    const modelAdmissions = admissions.filter(item => item.key === key);
    if (modelAdmissions.length >= 2) return { ...base, ready: false, reason: 'This model has used its two comparison requests. Failures and uncertain outcomes retain their admission.' };
    if (!Number.isFinite(requiredUsd) || requiredUsd <= 0 || this.accounted(admissions) + units(requiredUsd) > units(this.grant.maxUsd) || this.accounted(modelAdmissions) + units(requiredUsd) > units(this.grant.terms[key].maxUsd)) return { ...base, ready: false, reason: 'The conservative reservation exceeds the comparison total or model allocation.' };
    return { ...base, ready: true, reason: `Separate one-time comparison: US$${this.grant.maxUsd} total, two requests per model, retained reservations, no automatic retries.` };
  }

  assertScope(projectId: string | undefined, selection: ModelSelection | undefined): void {
    const status = this.status(projectId, selection);
    if (!status.ready) throw new StoreError(status.reason, 409);
  }

  reserve(projectId: string, selection: ModelSelection, usage: UsageRecord): void {
    this.store.atomic(() => {
      const saved = this.saved(), status = this.status(projectId, selection, usage.reservedUsd), key = this.key(projectId, selection);
      const existing = saved?.admissions.find(item => item.usageId === usage.id);
      if (existing) {
        if (saved?.signature !== this.signature || existing.key !== key || existing.projectId !== projectId || existing.reservedUnits !== units(usage.reservedUsd)) throw new StoreError('Comparison admission cannot be reused for different request terms.', 409);
        return;
      }
      if (!status.ready || !key) throw new StoreError(status.reason, 409);
      if (usage.provider !== selection.provider || (usage.reportedUsage as { authorizationId?: string } | null)?.authorizationId !== `${this.grant.authorizationId}-${selection.provider}`) throw new StoreError('Comparison usage must retain the approved provider authorization.', 409);
      this.store.saveRecord('model-comparison-grant', this.grant.scope, projectId, {
        signature: this.signature, projects: this.projects, authorizationId: this.grant.authorizationId, maxUsd: this.grant.maxUsd,
        admissions: [...(saved?.admissions ?? []), { usageId: usage.id, key, projectId, reservedUnits: units(usage.reservedUsd), createdAt: new Date().toISOString() }],
      } satisfies Grant);
    });
  }
}
