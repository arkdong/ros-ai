import type { BudgetReport, BudgetUsage } from '../shared/budget-report.js';
import type { ConnectionStatus, Run, UsageRecord } from '../shared/types.js';
import type { SandboxCostGate, RemoteExecutionState } from '../shared/experiments.js';
import { Authority } from './authority.js';
import { CombinedNebiusBudget, type CombinedNebiusBudgetStatus } from './combined-budget.js';
import type { Store } from './store.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
type SandboxAdmission = { runId: string; reservedUsd: number; at: string };

/** Explicit trace ownership is strongest. Older rows have only a saved run ID. */
export function usageProject(store: Store, row: UsageRecord): string | undefined {
  const trace = object(row.reportedUsage);
  if (typeof trace.projectId === 'string' && trace.projectId) return trace.projectId;
  if (row.runId) {
    try { return store.getRun(row.runId).projectId; } catch { /* Unattributed records stay outside project totals. */ }
  }
  if (typeof trace.assistantTurnId === 'string') {
    const turn = store.record<{ projectId: string }>('assistant-turn', trace.assistantTurnId);
    if (typeof turn?.projectId === 'string') return turn.projectId;
  }
  const admission = store.record<{ projectId: string }>('combined-nebius-admission', `inference-${row.id}`);
  if (typeof admission?.projectId === 'string') return admission.projectId;
  return undefined;
}

/** Read-only projection. Never return model prompts, responses, authorization IDs or credentials. */
export function projectBudgetReport(store: Store, projectId: string, options: {
  connections: ConnectionStatus[];
  combined?: CombinedNebiusBudgetStatus;
  sandbox?: SandboxCostGate;
  now?: Date;
}): BudgetReport {
  const project = store.getProject(projectId), policy = new Authority(store).policy(projectId);
  const projectRuns = new Map(store.listRuns(projectId).map(run => [run.id, run]));
  const owner = (row: UsageRecord) => usageProject(store, row);
  const nodeTitle = (run: Run | undefined) => run ? project.canvas.nodes.find(node => node.id === run.nodeId)?.title ?? run.node.title : null;
  const allUsage = store.listUsage();
  const entries: BudgetUsage[] = allUsage.filter(row => owner(row) === projectId).map(row => {
    const trace = object(row.reportedUsage), response = object(trace.response), usage = object(response.usage);
    return {
      id: row.id, provider: row.provider, purpose: row.purpose, at: row.createdAt, status: row.status,
      reservedUsd: amount(row.reservedUsd), estimatedUsd: amount(row.estimatedUsd),
      inputTokens: row.provider !== 'tavily' ? amount(usage.inputTokens) : null,
      outputTokens: row.provider !== 'tavily' ? amount(usage.outputTokens) : null,
      credits: row.provider === 'tavily' ? amount(response.credits ?? trace.credits) : null,
      rawCost: null, nodeTitle: nodeTitle(row.runId ? projectRuns.get(row.runId) : undefined),
    };
  });
  // Sandbox attempts have their own durable admissions, not UsageRecord rows.
  // Combined admissions repeat the same charge and must never be added again.
  for (const admission of store.records<SandboxAdmission>('sandbox-admission', projectId)) {
    const run = projectRuns.get(admission.runId);
    const remote = store.record<{ state: RemoteExecutionState }>('remote-recovery', admission.runId)?.state ?? object(run?.configuration.remote);
    entries.push({
      id: `sandbox:${admission.runId}`, provider: 'nebius-sandbox', purpose: 'Remote Python experiment', at: admission.at,
      status: remote.phase === 'uncertain' ? 'uncertain' : run?.status ?? 'uncertain',
      reservedUsd: amount(admission.reservedUsd), estimatedUsd: null,
      inputTokens: null, outputTokens: null, credits: null, rawCost: amount(remote.rawCost), nodeTitle: nodeTitle(run),
    });
  }
  const combined = options.combined ?? new CombinedNebiusBudget(store).status();
  return {
    projectId, generatedAt: (options.now ?? new Date()).toISOString(), limits: policy.limits, used: policy.used,
    remainingUsd: Math.max(0, policy.limits.spendUsd - policy.used.spendUsd), stopped: policy.stopped,
    entries: entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)),
    unattributedWorkspaceRequests: allUsage.filter(row => !owner(row)).length,
    providerAllowances: options.connections.filter(value => ['nebius', 'openai', 'tavily'].includes(value.provider)).map(value => ({
      name: value.provider === 'nebius' ? 'Nebius inference' : value.provider === 'openai' ? 'OpenAI inference' : 'Tavily search',
      ceilingUsd: value.limitUsd, accountedUsd: value.accountedUsd, remainingUsd: Math.max(0, value.limitUsd - value.accountedUsd),
      scope: value.provider !== 'tavily' ? 'Current inference authorization across projects' : 'Cumulative search allowance across projects',
    })),
    combined: { ceilingUsd: combined.maxUsd, accountedUsd: combined.accountedUsd, remainingUsd: combined.remainingUsd, enabled: combined.ready },
    sandbox: options.sandbox ? { remainingUsd: options.sandbox.remainingUsd, remainingRuns: options.sandbox.remainingRuns, perAttemptUsd: options.sandbox.maxCostPerRunUsd, enabled: options.sandbox.ready } : null,
    providerAccountCredit: null,
  };
}
