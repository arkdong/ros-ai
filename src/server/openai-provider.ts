import OpenAI from 'openai';
import type { ModelAdapter, ModelInfo, ModelRequest, ModelResponse } from './providers.js';

export const OPENAI_MODELS = [
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', inputUsdPerToken: 0.75 / 1_000_000, outputUsdPerToken: 4.5 / 1_000_000 },
  { id: 'gpt-5.4', label: 'GPT-5.4', inputUsdPerToken: 2.5 / 1_000_000, outputUsdPerToken: 15 / 1_000_000 },
];

/** Direct inference SDK only; no hosted agent workflow or executable tools. */
export class OpenAIAdapter implements ModelAdapter {
  readonly provider = 'openai';
  readonly configured: boolean;
  constructor(private readonly key = process.env.OPENAI_API_KEY ?? '', readonly model = 'gpt-5.4-mini') {
    this.configured = Boolean(key);
  }
  async prepare(_signal: AbortSignal): Promise<ModelInfo> {
    if (!this.configured) throw new Error('Set OPENAI_API_KEY in server-side .env.local, then restart ros.ai.');
    const selected = OPENAI_MODELS.find(item => item.id === this.model);
    if (!selected) throw new Error('Select an available OpenAI model from model settings.');
    return {
      id: this.model, contextTokens: 272000, inputUsdPerToken: selected.inputUsdPerToken, outputUsdPerToken: selected.outputUsdPerToken,
      capabilities: { structuredOutput: true, cancellation: 'abort-request', toolCalling: false, modelVersion: true },
      metadata: { endpoint: 'https://api.openai.com/v1', sdk: 'openai', pricingCheckedOn: '2026-09-23', pricingSource: 'https://developers.openai.com/api/docs/pricing', modelSource: `https://developers.openai.com/api/docs/models/${this.model}`, inputTokenCeiling: 272000, pricingTier: 'standard, input no greater than 272K', serviceTier: 'default', billing: 'Published standard token rates; account invoice and balance unavailable' },
    };
  }
  describeRequest(request: ModelRequest): Record<string, unknown> {
    return {
      model: this.model,
      messages: request.schema ? [{ role: 'system', content: `Return one JSON object matching this response contract. No Markdown fences or surrounding prose. This is a proposal only, never execution or permission. JSON Schema: ${JSON.stringify(request.schema)}` }, ...request.messages] : request.messages,
      max_completion_tokens: request.maxOutputTokens,
      reasoning_effort: 'none', service_tier: 'default', store: false,
      ...(request.schema ? { response_format: { type: 'json_object' } } : {}),
    };
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const body = this.describeRequest(request);
    const client = new OpenAI({ apiKey: this.key, maxRetries: 0 });
    try {
      const result = await client.chat.completions.create(body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal });
      const content = result.choices[0]?.message.content;
      if (!content?.trim()) throw new Error('OpenAI returned no text response.');
      if (content.length > 100000) throw new Error('OpenAI response exceeds the bounded contract.');
      return { content, model: result.model, modelVersion: result.model, usage: result.usage ? { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens } : null,
        metadata: { provider: this.provider, requestId: result.id, finishReason: result.choices[0]?.finish_reason ?? null, providerUsage: result.usage ?? null, responseContract: request.schema ? 'application-validated-json' : 'text', wireRequest: body } };
    } catch (error) {
      if (error instanceof OpenAI.APIError) throw new Error(`OpenAI returned ${error.status ? `HTTP ${error.status}` : 'a connection error'}. No automatic retry was attempted.`);
      throw error;
    }
  }
}
