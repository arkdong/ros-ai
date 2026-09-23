import { createHash } from 'node:crypto';
import { Store, StoreError } from './store.js';

/** This build's new authorization is additional to, and cannot rewrite, old grants. */
export const COMBINED_NEBIUS_BUILD_SCOPE = 'continuous-collaborator-2026-09-22';
export const COMBINED_NEBIUS_MAX_USD = 10;
const UNITS_PER_USD = 1_000_000_000;

export type CombinedNebiusBudgetOptions = { authorizationId?: string; maxUsd?: number };
export type CombinedNebiusReservation = {
  kind: 'inference' | 'sandbox';
  /** Inference uses its immutable usage-row ID; sandbox uses its attempt/run ID. */
  attemptId: string;
  projectId: string;
  amountUsd: number;
  basis: string;
};
export type CombinedNebiusAdmission = CombinedNebiusReservation & {
  authorizationId: string;
  scope: typeof COMBINED_NEBIUS_BUILD_SCOPE;
  reservedUsd: number;
  reservedUnits: number;
  createdAt: string;
};
type Configuration = { authorizationId: string; maxUsd: number; signature: string };
type Grant = Configuration & { admissions: CombinedNebiusAdmission[] };
export type CombinedNebiusBudgetStatus = {
  ready: boolean;
  reason: string;
  authorizationId: string | null;
  maxUsd: number;
  accountedUsd: number;
  remainingUsd: number;
};

function environment(): CombinedNebiusBudgetOptions {
  const value = process.env.ROS_NEBIUS_COMBINED_AUTHORIZED_USD;
  return {
    authorizationId: process.env.ROS_NEBIUS_COMBINED_AUTHORIZATION_ID,
    maxUsd: value?.trim() ? Number(value) : undefined,
  };
}

// Round charges up and ceilings down; a floating-point tolerance must not admit
// spending above the authorized ceiling. Integer arithmetic also survives restart.
const chargeUnits = (usd: number) => Math.ceil(usd * UNITS_PER_USD);
const ceilingUnits = (usd: number) => Math.floor(usd * UNITS_PER_USD);

/** One durable ceiling across inference and remote experiments in every project.
 * Call reserve inside the same Store.atomic as provider/project admission. The
 * nested transaction rolls everything back when dispatch is known not to occur.
 * There is intentionally no release/reset API: cancelled and uncertain attempts
 * keep the full reserve, and changing identifiers cannot create another grant.
 */
export class CombinedNebiusBudget {
  private readonly options: CombinedNebiusBudgetOptions;

  constructor(private readonly store: Store, options?: CombinedNebiusBudgetOptions) {
    this.options = { ...(options ?? environment()) };
  }

  private configured(): Configuration | undefined {
    const authorizationId = this.options.authorizationId?.trim();
    const maxUsd = this.options.maxUsd;
    if (!authorizationId || !/^[a-zA-Z0-9_-]{1,120}$/.test(authorizationId) ||
      !Number.isFinite(maxUsd) || maxUsd! <= 0 || maxUsd! > COMBINED_NEBIUS_MAX_USD || ceilingUnits(maxUsd!) < 1) return;
    const data = { authorizationId, maxUsd: maxUsd! };
    return { ...data, signature: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
  }

  private saved(): Grant | undefined {
    return this.store.record<Grant>('combined-nebius-grant', COMBINED_NEBIUS_BUILD_SCOPE);
  }

  private accountedUnits(saved = this.saved()): number {
    const usage = new Map(this.store.listUsage().filter(row => row.provider === 'nebius').map(row => [row.id, row]));
    return (saved?.admissions ?? []).reduce((total, admission) => {
      const row = admission.kind === 'inference' ? usage.get(admission.attemptId) : undefined;
      // Reported higher usage is additional evidence, never a reason to refund a
      // smaller successful response or an uncertain outcome's reservation.
      return total + Math.max(admission.reservedUnits, chargeUnits(row?.reservedUsd ?? 0), chargeUnits(row?.estimatedUsd ?? 0));
    }, 0);
  }

  status(requiredUsd = 1 / UNITS_PER_USD): CombinedNebiusBudgetStatus {
    const config = this.configured(), saved = this.saved();
    const accounted = this.accountedUnits(saved);
    const limit = ceilingUnits((saved ?? config)?.maxUsd ?? 0);
    const base = {
      authorizationId: (saved ?? config)?.authorizationId ?? null,
      maxUsd: limit / UNITS_PER_USD,
      accountedUsd: accounted / UNITS_PER_USD,
      remainingUsd: Math.max(0, limit - accounted) / UNITS_PER_USD,
    };
    if (!config) return { ...base, ready: false, reason: 'New Nebius work needs the explicit combined inference and sandbox authorization, capped at US$10 for this build. Historical grants and account balances do not enable it.' };
    if (saved && saved.signature !== config.signature) return { ...base, ready: false, reason: 'This build already used a different combined Nebius authorization or ceiling. Restore its original settings; changing identifiers or limits cannot replenish it.' };
    if (!Number.isFinite(requiredUsd) || requiredUsd < 0 || accounted > limit || chargeUnits(requiredUsd) > limit - accounted) return { ...base, ready: false, reason: 'The combined Nebius budget cannot admit this charge. Inference, sandbox attempts, retries and uncertain outcomes share the same retained ceiling.' };
    return { ...base, ready: true, reason: 'One retained conservative ceiling covers all new Nebius inference and sandbox attempts across projects. It is admission accounting, not an account balance or invoice.' };
  }

  fingerprint(): string { return this.configured()?.signature ?? 'unconfigured'; }

  reserve(input: CombinedNebiusReservation): CombinedNebiusAdmission {
    return this.store.atomic(() => {
      if (!['inference', 'sandbox'].includes(input.kind) || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.attemptId) ||
        !Number.isFinite(input.amountUsd) || input.amountUsd < 0 || (input.kind === 'inference' && input.amountUsd === 0) ||
        !input.basis.trim() || input.basis.length > 4000) throw new StoreError('Invalid combined Nebius budget reservation.', 400);
      this.store.getProject(input.projectId);
      const config = this.configured(), saved = this.saved();
      const status = this.status(input.amountUsd);
      if (!config || (saved && saved.signature !== config.signature)) throw new StoreError(status.reason, 409);
      const existing = saved?.admissions.find(row => row.kind === input.kind && row.attemptId === input.attemptId);
      if (existing) {
        if (existing.projectId !== input.projectId || existing.amountUsd !== input.amountUsd || existing.basis !== input.basis) throw new StoreError('A combined Nebius admission cannot be reused for different request terms.', 409);
        return structuredClone(existing);
      }
      if (!status.ready) throw new StoreError(status.reason, 409);
      const admission: CombinedNebiusAdmission = {
        ...input,
        authorizationId: config.authorizationId,
        scope: COMBINED_NEBIUS_BUILD_SCOPE,
        reservedUsd: chargeUnits(input.amountUsd) / UNITS_PER_USD,
        reservedUnits: chargeUnits(input.amountUsd),
        createdAt: new Date().toISOString(),
      };
      this.store.saveRecord('combined-nebius-grant', COMBINED_NEBIUS_BUILD_SCOPE, input.projectId, {
        ...config, admissions: [...(saved?.admissions ?? []), admission],
      } satisfies Grant);
      this.store.saveRecord('combined-nebius-admission', `${input.kind}-${input.attemptId}`, input.projectId, admission);
      return structuredClone(admission);
    });
  }
}
