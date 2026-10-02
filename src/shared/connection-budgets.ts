export const connectionBudgetProviders = ['nebius', 'openai', 'tavily'] as const;
export type ConnectionBudgetProvider = typeof connectionBudgetProviders[number];
export type ConnectionBudgetStatus = {
  provider: ConnectionBudgetProvider;
  source: 'app' | 'environment' | 'none';
  enabled: boolean;
  ready: boolean;
  limitUsd: number;
  accountedUsd: number;
  remainingUsd: number;
  maxRequests: number;
  usedRequests: number;
  remainingRequests: number;
  reason: string;
  revision: number | null;
  updatedAt: string | null;
};
export type ConnectionBudgetInput = {
  limitUsd: number;
  maxRequests: number;
  enabled: true;
  acknowledged: true;
};
