export const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet', detail: 'Balanced quality and cost' },
  { id: 'opus', label: 'Opus', detail: 'Strongest, costs more per turn' },
  { id: 'haiku', label: 'Haiku', detail: 'Fastest and cheapest' },
] as const;
export type ClaudeModel = typeof CLAUDE_MODELS[number]['id'];
export type ClaudeAgentSettings = { model: ClaudeModel; models: typeof CLAUDE_MODELS; turnUsd: number; sdkVersion: string; apiKeyConfigured: boolean; allowanceReady: boolean };
