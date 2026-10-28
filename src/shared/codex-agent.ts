import type { AgentModel } from './agent-models.js';

/** Who pays for a Codex turn inside ros.ai: the person's ChatGPT subscription, through Codex's own sign-in, or the OpenAI
 * API key on the Agents page. Each is its own agent, 'codex' and 'codex-key' (IN_APP_AGENTS in assistant.ts), picked per project in the Ros bar. */
export type CodexBilling = 'plan' | 'api-key';
/** The models Codex runs on with an OpenAI API key. ros.ai knows their prices (openai-provider.ts), which keeps each turn within its cap.
 * On a ChatGPT subscription Codex offers its own list (model/list). */
export const CODEX_API_MODELS: AgentModel[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', detail: 'Strongest', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', detail: 'Faster and cheaper', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
];
export type CodexApiModel = 'gpt-5.4' | 'gpt-5.4-mini';
