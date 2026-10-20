import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import { Authority } from './authority.js';
import { spendingLimitsOn } from './spending-limits.js';
import type { AgentScope } from '../shared/agent-runtime.js';
import type { CodexAllowanceLimits, CodexAllowanceResources, CodexAllowanceScope, CodexAllowanceStatus } from '../shared/agent-budget-settings.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const limitFields = {
  maxTurns: z.number().int().min(1).max(100), maxRuntimeSeconds: z.number().int().min(1).max(3600),
  maxToolCalls: z.number().int().min(0).max(1000), perTurnSeconds: z.number().int().min(1).max(300),
  perTurnToolCalls: z.number().int().min(0).max(20),
};
const limitsSchema = z.object(limitFields).strict();
export const codexAllowanceUpdateSchema = z.object({
  ...limitFields, enabled: z.literal(true), acknowledged: z.literal(true),
  nodeIds: z.array(id).max(500).optional(), artifactIds: z.array(id).max(10000).optional(),
}).strict();
const grantSchema = z.object({
  id, authorizedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  scope: z.string().trim().min(1).max(4000), projectIds: z.array(id).min(1).max(100),
  nodeIds: z.array(id).max(500), artifactIds: z.array(id).max(100), ...limitFields,
}).strict();
type AgentGrant = z.infer<typeof grantSchema>;
type Reservation = { requestId: string; projectId: string; at: string; seconds: number; toolCalls?: number };
type GrantLedger = { grant: AgentGrant; fingerprint: string; usedTurns: number; reservedSeconds: number; toolCalls: number; attempts: Reservation[] };
type ProjectUsage = CodexAllowanceResources & { reservations: Reservation[]; legacyToolUncertainty: boolean };
type AppAllowance = { version: 1; id: string; enabled: boolean; createdAt: string; updatedAt: string; acknowledgedAt: string | null; limits: CodexAllowanceLimits; scope: CodexAllowanceScope };
const zero = (): CodexAllowanceResources => ({ turns: 0, runtimeSeconds: 0, toolCalls: 0 });
const noScope = (): CodexAllowanceScope => ({ nodeIds: [], artifactIds: [], capturedAt: null, projectRevision: null });
const now = () => new Date().toISOString();
const remaining = (limits: CodexAllowanceLimits | null, used: CodexAllowanceResources): CodexAllowanceResources => limits ? {
  turns: Math.max(0, limits.maxTurns - used.turns), runtimeSeconds: Math.max(0, limits.maxRuntimeSeconds - used.runtimeSeconds), toolCalls: Math.max(0, limits.maxToolCalls - used.toolCalls),
} : zero();
const limitations = [
  'Allowance counts local agent turns, fully reserved wall-time and tool calls. It is not a USD, token or provider billing cap.',
  'Each admitted turn reserves its full per-turn time/tool allowance; failure, cancellation, unknown outcomes and restart retain it.',
  'Scope is a saved list of block and immutable artifact IDs. New cards, new versions, focus and grouping do not broaden it.',
  'Grant admission, native authentication, isolation and existing project authority/resources are independent. Saving allowance starts no inference.',
];

/** A live project allowance has one fixed durable identity. Pause never falls
 * back to the historical environment grant and reservations are never refunded.
 */
export class AgentBudget {
  constructor(private readonly store: Store, private readonly authority: Authority) {}
  private configured(): AgentGrant | null {
    const raw = process.env.ROS_CODEX_GRANT_JSON;
    if (!raw) return null;
    try { return grantSchema.parse(JSON.parse(raw)); }
    catch { throw new StoreError('ROS_CODEX_GRANT_JSON is invalid. A fresh bounded Codex grant is required.', 503); }
  }
  private ledger(): GrantLedger | null {
    const grant = this.configured();
    if (!grant) return null;
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.authorizedAt)) throw new StoreError('Codex grant expiry must follow its authorization time.', 503);
    const fingerprint = createHash('sha256').update(JSON.stringify(grant)).digest('hex');
    // The historical grant stays one fixed ledger across all scoped projects.
    const prior = this.store.record<GrantLedger>('agent-grant', grant.id);
    if (prior && prior.fingerprint !== fingerprint) throw new StoreError('Used Codex grant terms cannot change under the same ID or replenish resources.', 503);
    return prior ?? { grant, fingerprint, usedTurns: 0, reservedSeconds: 0, toolCalls: 0, attempts: [] };
  }
  private app(projectId: string): AppAllowance | undefined { return this.store.record<AppAllowance>('codex-allowance', projectId); }
  private usage(projectId: string): ProjectUsage {
    const saved = this.store.record<ProjectUsage>('codex-project-usage', projectId);
    if (saved) return saved;
    // Import retained legacy project admissions, including failures before an
    // agent-attempt record was saved. No first-save counter reset is permitted.
    const admissions = this.store.records<{ kind: string; fingerprint: string; runtimeSeconds?: number; at: string; amount?: { runtimeSeconds?: number } }>('admission', projectId).filter(value => value.kind === 'model' && value.fingerprint.startsWith('codex:'));
    const known = new Map<string, GrantLedger>();
    for (const attempt of this.store.records<{ grantId: string }>('agent-attempt', projectId)) {
      const ledger = this.store.record<GrantLedger>('agent-grant', attempt.grantId);
      if (ledger) known.set(ledger.grant.id, ledger);
    }
    try { const configured = this.configured(); if (configured) { const ledger = this.store.record<GrantLedger>('agent-grant', configured.id); if (ledger) known.set(configured.id, ledger); } } catch { /* Invalid env cannot erase old admissions or override an app allowance. */ }
    let legacyToolUncertainty = false;
    const reservations = admissions.map(admission => {
      const requestId = admission.fingerprint.slice('codex:'.length);
      const ledger = [...known.values()].find(value => value.attempts.some(attempt => attempt.requestId === requestId && attempt.projectId === projectId));
      const attempt = ledger?.attempts.find(value => value.requestId === requestId && value.projectId === projectId);
      if (!ledger) legacyToolUncertainty = true;
      return { requestId, projectId, at: admission.at, seconds: admission.runtimeSeconds ?? admission.amount?.runtimeSeconds ?? 300, toolCalls: attempt?.toolCalls ?? ledger?.grant.perTurnToolCalls ?? 20 };
    });
    return { turns: reservations.length, runtimeSeconds: reservations.reduce((sum, value) => sum + value.seconds, 0), toolCalls: reservations.reduce((sum, value) => sum + value.toolCalls, 0), reservations, legacyToolUncertainty };
  }
  private resourceReason(projectId: string, limits: CodexAllowanceLimits, used: CodexAllowanceResources): string | null {
    const left = remaining(limits, used), policy = this.authority.policy(projectId);
    if (left.turns < 1 || left.runtimeSeconds < limits.perTurnSeconds || left.toolCalls < limits.perTurnToolCalls) return 'The cumulative Codex turn/time/tool allowance cannot admit another full turn.';
    if (policy.stopped) return 'Project research is stopped. Resume it deliberately before new Codex work.';
    return null;
  }
  allowance(projectId: string): Omit<CodexAllowanceStatus, 'isolationReady' | 'available'> {
    this.store.getProject(projectId);
    const app = this.app(projectId), usage = this.usage(projectId);
    const used = { turns: usage.turns, runtimeSeconds: usage.runtimeSeconds, toolCalls: usage.toolCalls };
    const notes = usage.legacyToolUncertainty ? [...limitations, 'Some older admissions lack exact tool reservations; their maximum 20 calls remain conservatively reserved.'] : limitations;
    if (!spendingLimitsOn(this.store)) {
      // No allowance to set: turns still count, each within the largest per-turn time and tool bounds, over the whole project.
      const project = this.store.getProject(projectId), stopped = this.authority.policy(projectId).stopped;
      const limits: CodexAllowanceLimits = { maxTurns: used.turns + 100, maxRuntimeSeconds: used.runtimeSeconds + 30000, maxToolCalls: used.toolCalls + 2000, perTurnSeconds: 300, perTurnToolCalls: 20 };
      return { projectId, source: 'app', enabled: true, ready: !stopped, reason: stopped ? 'Project research is stopped. Resume it deliberately before new Codex work.' : 'No usage limit is set. Every turn is recorded.', grantId: app?.id ?? `unlimited-${projectId}`, limits, used, remaining: remaining(limits, used), scope: { nodeIds: project.canvas.nodes.map(node => node.id), artifactIds: this.store.listArtifacts(projectId).map(artifact => artifact.id), capturedAt: null, projectRevision: project.revision }, createdAt: app?.createdAt ?? null, updatedAt: app?.updatedAt ?? null, expiresAt: null, limitations: notes };
    }
    if (app) {
      const reason = !app.enabled ? 'This project Codex allowance is paused; the historical environment grant will not be used.' : this.resourceReason(projectId, app.limits, used);
      return { projectId, source: 'app', enabled: app.enabled, ready: reason === null, reason: reason ?? 'Explicit cumulative Codex allowance is available; authentication and isolation are checked separately.', grantId: app.id, limits: app.limits, used, remaining: remaining(app.limits, used), scope: app.scope, createdAt: app.createdAt, updatedAt: app.updatedAt, expiresAt: null, limitations: notes };
    }
    let ledger: GrantLedger | null;
    try { ledger = this.ledger(); }
    catch (error) { return { projectId, source: 'environment', enabled: false, ready: false, reason: (error as Error).message, grantId: null, limits: null, used, remaining: zero(), scope: noScope(), createdAt: null, updatedAt: null, expiresAt: null, limitations: notes }; }
    if (!ledger) return { projectId, source: 'none', enabled: false, ready: false, reason: 'No explicit bounded Codex allowance is configured. Native sign-in alone does not authorize a research turn.', grantId: null, limits: null, used, remaining: zero(), scope: noScope(), createdAt: null, updatedAt: null, expiresAt: null, limitations: notes };
    const g = ledger.grant, limits = limitsSchema.parse({ maxTurns: g.maxTurns, maxRuntimeSeconds: g.maxRuntimeSeconds, maxToolCalls: g.maxToolCalls, perTurnSeconds: g.perTurnSeconds, perTurnToolCalls: g.perTurnToolCalls });
    const sharedUsed = { turns: ledger.usedTurns, runtimeSeconds: ledger.reservedSeconds, toolCalls: ledger.toolCalls };
    const inProject = g.projectIds.includes(projectId);
    const valid = Date.now() >= Date.parse(g.authorizedAt) && Date.now() < Date.parse(g.expiresAt) && inProject;
    const reason = valid ? this.resourceReason(projectId, limits, sharedUsed) : 'The historical Codex grant is expired, not yet authorized, or outside this project.';
    const project = this.store.getProject(projectId), nodes = new Set(project.canvas.nodes.map(node => node.id));
    const artifacts = new Set(this.store.listArtifacts(projectId).map(artifact => artifact.id));
    return { projectId, source: 'environment', enabled: true, ready: reason === null, reason: reason ?? 'The historical explicit Codex allowance is available; shared grant resources are retained across its projects.', grantId: g.id, limits, used: sharedUsed, remaining: remaining(limits, sharedUsed), scope: inProject ? { nodeIds: g.nodeIds.filter(value => nodes.has(value)), artifactIds: g.artifactIds.filter(value => artifacts.has(value)), capturedAt: g.authorizedAt, projectRevision: null } : noScope(), createdAt: g.authorizedAt, updatedAt: ledger.attempts.at(-1)?.at ?? g.authorizedAt, expiresAt: g.expiresAt, limitations: [...notes, 'Historical environment allowance counters are shared across all projects named in that fixed grant.'] };
  }
  configure(projectId: string, supplied: unknown) {
    const value = codexAllowanceUpdateSchema.parse(supplied);
    return this.store.atomic(() => {
      const project = this.store.getProject(projectId), prior = this.app(projectId), used = this.usage(projectId);
      const limits = limitsSchema.parse({ maxTurns: value.maxTurns, maxRuntimeSeconds: value.maxRuntimeSeconds, maxToolCalls: value.maxToolCalls, perTurnSeconds: value.perTurnSeconds, perTurnToolCalls: value.perTurnToolCalls });
      if (limits.perTurnSeconds > limits.maxRuntimeSeconds || limits.perTurnToolCalls > limits.maxToolCalls) throw new StoreError('Per-turn time/tool reservations must fit within the total allowance.');
      if (limits.maxTurns < used.turns || limits.maxRuntimeSeconds < used.runtimeSeconds || limits.maxToolCalls < used.toolCalls) throw new StoreError('Codex allowance ceilings cannot be below retained usage. Editing, pausing and re-enabling never resets reservations.');
      const allNodes = project.canvas.nodes.map(node => node.id), allArtifacts = this.store.listArtifacts(projectId).map(artifact => artifact.id);
      const hasSnapshot = Boolean(prior?.scope.capturedAt);
      const nodeIds = [...new Set(value.nodeIds ?? (hasSnapshot ? prior!.scope.nodeIds : allNodes))];
      const artifactIds = [...new Set(value.artifactIds ?? (hasSnapshot ? prior!.scope.artifactIds : allArtifacts))];
      // Omitted stored IDs can reference retained deleted cards. Explicit new
      // scope selections must belong to the current saved project snapshot.
      if (!hasSnapshot || value.nodeIds !== undefined) for (const nodeId of nodeIds) if (!allNodes.includes(nodeId)) throw new StoreError('Codex scope contains a block outside the current project.');
      if (!hasSnapshot || value.artifactIds !== undefined) for (const artifactId of artifactIds) if (!allArtifacts.includes(artifactId)) throw new StoreError('Codex scope contains an artifact outside this project.');
      z.array(id).max(500).parse(nodeIds); z.array(id).max(10000).parse(artifactIds);
      const captured = !hasSnapshot || value.nodeIds !== undefined || value.artifactIds !== undefined, at = now();
      const record: AppAllowance = { version: 1, id: prior?.id ?? randomUUID(), enabled: true, createdAt: prior?.createdAt ?? at, updatedAt: at, acknowledgedAt: at, limits, scope: { nodeIds, artifactIds, capturedAt: captured ? at : prior!.scope.capturedAt, projectRevision: captured ? project.revision : prior!.scope.projectRevision } };
      this.store.saveRecord('codex-project-usage', projectId, projectId, used);
      this.store.saveRecord('codex-allowance', projectId, projectId, record);
      this.store.saveRecord('codex-allowance-change', randomUUID(), projectId, { at, action: 'configure', grantId: record.id, acknowledged: true, limits, scope: record.scope, retainedUsage: { turns: used.turns, runtimeSeconds: used.runtimeSeconds, toolCalls: used.toolCalls } });
      return this.allowance(projectId);
    });
  }
  pause(projectId: string) {
    return this.store.atomic(() => {
      const prior = this.app(projectId), before = this.allowance(projectId), at = now();
      const record: AppAllowance = prior ?? { version: 1, id: randomUUID(), enabled: false, createdAt: at, updatedAt: at, acknowledgedAt: null, limits: before.limits ?? { maxTurns: 1, maxRuntimeSeconds: 30, maxToolCalls: 3, perTurnSeconds: 30, perTurnToolCalls: 3 }, scope: before.scope };
      this.store.saveRecord('codex-project-usage', projectId, projectId, this.usage(projectId));
      this.store.saveRecord('codex-allowance', projectId, projectId, { ...record, enabled: false, updatedAt: at });
      this.store.saveRecord('codex-allowance-change', randomUUID(), projectId, { at, action: 'pause', grantId: record.id, detail: 'App pause takes precedence over any historical environment grant. All reservations are retained.' });
      return this.allowance(projectId);
    });
  }
  status(projectId: string) {
    const status = this.allowance(projectId);
    return { ready: status.ready, reason: status.reason, grant: status.grantId ? { id: status.grantId, remainingTurns: status.remaining.turns, remainingSeconds: status.remaining.runtimeSeconds, remainingToolCalls: status.remaining.toolCalls, expiresAt: status.expiresAt } : null };
  }
  reserve(scope: AgentScope, requestId: string) {
    return this.store.atomic(() => {
      const status = this.allowance(scope.projectId), app = this.app(scope.projectId), usage = this.usage(scope.projectId);
      if (!status.ready || !status.limits || !status.grantId) throw new StoreError(status.reason, 503);
      if (scope.nodeIds.some(value => !status.scope.nodeIds.includes(value)) || scope.artifactIds.some(value => !status.scope.artifactIds.includes(value))) throw new StoreError('Selected Codex context is outside the explicit allowance. Focus, grouping and new cards never broaden it.', 403);
      if (usage.reservations.some(value => value.requestId === requestId)) throw new StoreError('This Codex attempt was already admitted. Continue with a new recorded attempt.', 409);
      const limits = status.limits, at = now();
      // A shared modelCalls unit represents an agent turn, not hidden API calls.
      this.authority.reserve(scope.projectId, { kind: 'model', nodeId: scope.nodeIds[0] ?? 'project', fingerprint: `codex:${requestId}`, runtimeSeconds: limits.perTurnSeconds });
      const reservation = { requestId, projectId: scope.projectId, at, seconds: limits.perTurnSeconds, toolCalls: limits.perTurnToolCalls };
      this.store.saveRecord('codex-project-usage', scope.projectId, scope.projectId, { ...usage, turns: usage.turns + 1, runtimeSeconds: usage.runtimeSeconds + limits.perTurnSeconds, toolCalls: usage.toolCalls + limits.perTurnToolCalls, reservations: [...usage.reservations, reservation] });
      if (!app && status.source === 'environment') {
        const ledger = this.ledger()!;
        ledger.usedTurns++; ledger.reservedSeconds += limits.perTurnSeconds; ledger.toolCalls += limits.perTurnToolCalls; ledger.attempts.push(reservation);
        this.store.saveRecord('agent-grant', ledger.grant.id, ledger.grant.projectIds[0], ledger);
      }
      return { seconds: limits.perTurnSeconds, toolCalls: limits.perTurnToolCalls, grantId: status.grantId, scope: app || status.source === 'app' ? 'Local Codex collaboration in this project, restricted to its explicitly authorized saved block and artifact identifiers.' : this.ledger()!.grant.scope };
    });
  }
}
