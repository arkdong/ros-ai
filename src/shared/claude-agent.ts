import type { AgentModel } from './agent-models.js';

/** The models ros.ai offers Claude Code when it cannot read Claude Code's own list. Their ids are Claude Code's aliases,
 * which it resolves to the newest model of each kind; it starts Opus, Sonnet and Haiku 5.5 on medium effort, others on high. */
export const CLAUDE_MODELS: AgentModel[] = [
  { id: 'opus', label: 'Opus', detail: 'Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'fable', label: 'Fable', detail: 'Most capable for the hardest, longest tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'sonnet', label: 'Sonnet', detail: 'Efficient for routine tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'haiku', label: 'Haiku', detail: 'Fastest for quick answers', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
];
/** One of Claude Code's model aliases (CLAUDE_MODELS, or another its own list offers). */
export type ClaudeModel = string;
/** Who pays for a Claude Code turn: the Claude API key on the Agents page, or the person's own Claude subscription.
 * Each is its own agent, 'claude' and 'claude-plan' (IN_APP_AGENTS in assistant.ts), picked per project in the Ros bar. */
export type ClaudeBilling = 'api-key' | 'plan';
/** Where Claude Code looks things up on the web: its own search and page reading, or ros.ai's search plan on the
 * search service from the Plugins page (Tavily, Exa or Brave), which starts at once as notes on the map.
 * On a Claude plan it always uses its own: that costs nothing beyond the plan's usage limits. */
export type ClaudeWebSearch = 'own' | 'ros';
export type ClaudePlanStatus = { state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable'; email?: string | null; plan?: string | null; message?: string | null };
export type ClaudePlanLogin = { state: 'waiting' | 'completed' | 'failed' | 'cancelled'; message: string; command: string | null };
/** model: on the API key; planModel: on the subscription. Each agent's effort and the models it offers come from /api/agents/claude/model. */
export type ClaudeAgentSettings = { model: ClaudeModel; planModel: ClaudeModel; webSearch: ClaudeWebSearch; planAllowed: boolean; plan: ClaudePlanStatus; login: ClaudePlanLogin | null; turnUsd: number; sdkVersion: string; apiKeyConfigured: boolean; allowanceReady: boolean };
