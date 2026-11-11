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

/** What a connected provider says is left, or that it does not say. Never a key or account id. */
export type ProviderBalance = {
  id: 'ros-cloud' | 'nebius' | 'openai' | 'claude' | 'codex' | 'tavily';
  name: string;
  /** Headline such as "US$4.20 left today"; null when the provider reports nothing. */
  left: string | null;
  detail: string;
  link: string | null;
  checkedAt: string | null;
  /** Set when the person typed in this provider's credit. */
  credit?: ProviderCredit | null;
};
export type CodexRateLimit = { usedPercent: number; windowMinutes: number | null; resetsAt: string | null };
export type CodexRateLimits = { primary: CodexRateLimit | null; secondary: CodexRateLimit | null };
/** How much of a Claude or ChatGPT subscription's usage windows is used, as Claude Code and Codex report it on this computer. */
export type PlanWindow = { label: string; usedPercent: number; resetsAt: string | null };
export type PlanUsage = { id: 'claude' | 'codex'; name: string; plan: string | null; state: 'ready' | 'signed-out' | 'unavailable'; windows: PlanWindow[]; message: string | null; checkedAt: string };
/** "5-hour", "Weekly": a rolling window named by its length. */
export const windowLabel = (minutes: number | null) => minutes === null ? 'Plan' : minutes >= 1440 * 6 ? 'Weekly' : minutes >= 1440 ? `${Math.round(minutes / 1440)}-day` : minutes >= 60 ? `${Math.round(minutes / 60)}-hour` : `${minutes}-minute`;

/** Spend this calendar month against an optional monthly budget. */
export type BudgetLine = { monthlyUsd: number | null; spentUsd: number; leftUsd: number | null };
export type BudgetStatus = { month: string; all: BudgetLine; project: BudgetLine | null };
/** Credit typed in from a provider's console, less what ros.ai recorded since. An estimate. */
export type ProviderCredit = { amountUsd: number; setAt: string; spentUsd: number; leftUsd: number };
