/** Who pays for a Codex turn inside ros.ai: the person's ChatGPT subscription, through Codex's own sign-in, or the OpenAI
 * API key on the Agents page. Each is its own agent, 'codex' and 'codex-key' (IN_APP_AGENTS in assistant.ts), picked per project in the Ros bar. */
export type CodexBilling = 'plan' | 'api-key';
/** The models Codex runs on with an OpenAI API key. ros.ai knows their prices (openai-provider.ts), which keeps each turn within its cap. */
export const CODEX_API_MODELS = [
  { id: 'gpt-5.4', label: 'GPT-5.4', detail: 'Strongest' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', detail: 'Faster and cheaper' },
] as const;
export type CodexApiModel = typeof CODEX_API_MODELS[number]['id'];
/** model: on the API key; on a subscription Codex picks its own. */
export type CodexAgentSettings = { model: CodexApiModel; models: typeof CODEX_API_MODELS; apiKeyConfigured: boolean };
