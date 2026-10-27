export const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet', detail: 'Balanced quality and cost' },
  { id: 'opus', label: 'Opus', detail: 'Strongest, costs more per turn' },
  { id: 'haiku', label: 'Haiku', detail: 'Fastest and cheapest' },
] as const;
export type ClaudeModel = typeof CLAUDE_MODELS[number]['id'];
/** Who pays for Claude Code turns: the Claude API key on the Agents page, or the person's own Claude plan. */
export type ClaudeBilling = 'api-key' | 'plan';
/** Where Claude Code looks things up on the web: its own search and page reading, or ros.ai's search plan on the
 * search service from the Plugins page (Tavily, Exa or Brave), which the researcher approves with its price first.
 * On a Claude plan it always uses its own: that costs nothing beyond the plan's usage limits. */
export type ClaudeWebSearch = 'own' | 'ros';
export type ClaudePlanStatus = { state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable'; email?: string | null; plan?: string | null; message?: string | null };
export type ClaudePlanLogin = { state: 'waiting' | 'completed' | 'failed' | 'cancelled'; message: string; command: string | null };
export type ClaudeAgentSettings = { model: ClaudeModel; models: typeof CLAUDE_MODELS; billing: ClaudeBilling; webSearch: ClaudeWebSearch; planAllowed: boolean; plan: ClaudePlanStatus; login: ClaudePlanLogin | null; turnUsd: number; sdkVersion: string; apiKeyConfigured: boolean; allowanceReady: boolean };
