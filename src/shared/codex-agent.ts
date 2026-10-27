/** Who pays for Codex turns inside ros.ai: the person's ChatGPT plan, through Codex's own sign-in, or the OpenAI API key on the Agents page. */
export type CodexBilling = 'plan' | 'api-key';
/** The models Codex runs on with an OpenAI API key. ros.ai knows their prices (openai-provider.ts), which keeps each turn within its cap. */
export const CODEX_API_MODELS = [
  { id: 'gpt-5.4', label: 'GPT-5.4', detail: 'Strongest' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', detail: 'Faster and cheaper' },
] as const;
export type CodexApiModel = typeof CODEX_API_MODELS[number]['id'];
export type CodexAgentSettings = { billing: CodexBilling; model: CodexApiModel; models: typeof CODEX_API_MODELS; apiKeyConfigured: boolean };
