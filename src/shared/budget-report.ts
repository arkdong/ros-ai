import type { ResearchUsage } from './research.js';

export type BudgetPeriod = 'hour' | 'today' | 'day';
export type BudgetUsage = {
  id: string;
  provider: string;
  purpose: string;
  at: string;
  status: string;
  reservedUsd: number | null;
  estimatedUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  credits: number | null;
  rawCost: number | null;
  nodeTitle: string | null;
};
export type ProviderAllowance = {
  name: string;
  ceilingUsd: number;
  accountedUsd: number;
  remainingUsd: number;
  scope: string;
};
export type TavilyUsageScope = {
  usage: number | null;
  limit: number | null;
  operations: Record<'search' | 'extract' | 'crawl' | 'map' | 'research', number | null>;
};
export type TavilyAccountUsage = {
  status: 'unconfigured' | 'disabled' | 'fresh' | 'stale' | 'error';
  fetchedAt: string | null;
  attemptedAt: string | null;
  error: string | null;
  key: TavilyUsageScope | null;
  account: { plan: string | null; planUsage: number | null; planLimit: number | null; paygoUsage: number | null; paygoLimit: number | null; operations: TavilyUsageScope['operations'] } | null;
};
export type ManualProviderCredit = {
  amountUsd: number;
  approximate: boolean;
  source: 'user-reported';
  reportedOn: string;
  observedAt: string | null;
};
export type ProviderAccounts = { tavily: TavilyAccountUsage; nebius: ManualProviderCredit | null };
export type BudgetReport = {
  projectId: string;
  generatedAt: string;
  used: ResearchUsage;
  stopped: boolean;
  entries: BudgetUsage[];
  unattributedWorkspaceRequests: number;
  providerAllowances: ProviderAllowance[];
  combined: { ceilingUsd: number; accountedUsd: number; remainingUsd: number; enabled: boolean };
  sandbox: { remainingUsd: number; remainingRuns: number; perAttemptUsd: number | null; enabled: boolean } | null;
  providerAccountCredit: null;
  providerAccounts?: ProviderAccounts;
};

/** Date setters use the viewer's local calendar, including 23/25-hour DST days. */
export function budgetPeriodStart(period: BudgetPeriod, now: Date): number {
  if (period === 'hour') return now.getTime() - 60 * 60 * 1000;
  if (period === 'day') return now.getTime() - 24 * 60 * 60 * 1000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

export function summarizeBudgetPeriod(entries: readonly BudgetUsage[], period: BudgetPeriod, now: Date) {
  const start = budgetPeriodStart(period, now), end = now.getTime();
  const selected = entries.filter(entry => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at >= start && at <= end;
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  const sum = (key: 'estimatedUsd' | 'reservedUsd' | 'inputTokens' | 'outputTokens' | 'credits') => selected.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  return {
    entries: selected,
    knownEstimatedUsd: sum('estimatedUsd'),
    unknownEstimates: selected.filter(entry => entry.estimatedUsd === null).length,
    retainedUsd: sum('reservedUsd'),
    unknownReservations: selected.filter(entry => entry.reservedUsd === null).length,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), credits: sum('credits'),
  };
}

/** One paid or recorded request, for the Usage page. No prompts, responses or credentials. */
export type UsageEvent = {
  id: string;
  at: string;
  provider: string;
  providerName: string;
  model: string | null;
  task: string;
  projectId: string | null;
  projectTitle: string | null;
  nodeTitle: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type UsageAnalytics = { generatedAt: string; events: UsageEvent[] };
