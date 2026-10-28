/** Shared pieces of the ros-nemotron data pipeline: file locations, a spend ledger with a hard
 * cap, and one chat-completions adapter that serves as teacher (Nemotron 3 Super on Token
 * Factory), as student under evaluation (llama-server or vLLM) and as the simulated web's writer. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { wireMessages, wireTools, type ChatMessage, type ModelAdapter, type ModelInfo, type ModelRequest, type ModelResponse } from '../../src/server/providers.js';
import { captureChatCompletion } from '../../src/server/response-normalization.js';

export const ROOT = resolve(import.meta.dirname);
/** Generated data stays out of git: it is large and reproducible from the committed task seeds. */
export const dataDir = () => resolve(process.env.ROS_TRAINING_DATA || resolve(ROOT, 'data'));
export const TOKEN_FACTORY = 'https://api.tokenfactory.us-central1.nebius.com/v1';
export const TEACHER_MODEL = process.env.ROS_TEACHER_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

export const path = (...parts: string[]) => { const value = resolve(dataDir(), ...parts); mkdirSync(dirname(value), { recursive: true }); return value; };
export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
export const writeJson = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
export const readJsonl = <T>(file: string): T[] => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T) : [];
export const appendJsonl = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(value)}\n`); };
export const arg = (name: string, fallback?: string) => { const found = process.argv.find(item => item.startsWith(`--${name}=`)); return found ? found.slice(name.length + 3) : fallback; };
export const flag = (name: string) => process.argv.includes(`--${name}`);

/** Every paid request in the pipeline settles here; a request that would pass the cap is never sent. */
export class Ledger {
  private readonly file = path('spend.jsonl');
  constructor(readonly capUsd: number) {}
  get spentUsd() { return readJsonl<{ usd: number }>(this.file).reduce((sum, item) => sum + item.usd, 0); }
  admit(worstCaseUsd: number) { if (this.spentUsd + worstCaseUsd > this.capUsd) throw new Error(`Spend cap reached: US$${this.spentUsd.toFixed(2)} spent of US$${this.capUsd}. Raise --max-usd only with Adam's go-ahead.`); }
  settle(entry: { purpose: string; model: string; inputTokens: number; outputTokens: number; usd: number }) { appendJsonl(this.file, { at: new Date().toISOString(), ...entry }); }
}

type Options = { base: string; key: string; model: string; contextTokens: number; thinking: boolean; ledger?: Ledger; purpose: string; usdPerMillion?: { input: number; output: number } };

/** Any OpenAI-compatible chat server. Reasoning text is dropped, so a sample holds only what
 * ros-nemotron will be asked to write: visible text and tool calls (Local Ros runs with
 * --reasoning-budget 0). `beforeSend` lets the rollout add the teacher's hidden guide. */
export class ChatAdapter implements ModelAdapter {
  readonly provider = 'nebius';
  readonly configured = true;
  beforeSend?: (messages: ChatMessage[]) => ChatMessage[];
  private price = { input: 0, output: 0 };
  constructor(private readonly options: Options) { this.model = options.model; }
  readonly model: string;
  async prepare(signal: AbortSignal): Promise<ModelInfo> {
    if (this.options.usdPerMillion) this.price = this.options.usdPerMillion;
    else if (this.options.base === TOKEN_FACTORY) {
      // The catalogue's own rates, so the cap holds even if Nebius changes prices.
      const response = await fetch(`${TOKEN_FACTORY}/models?verbose=true`, { headers: { Authorization: `Bearer ${this.options.key}` }, signal });
      const found = ((await response.json()) as { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] }).data?.find(item => item.id === this.model);
      if (!found?.pricing) throw new Error(`${this.model} is not in the Token Factory catalogue.`);
      this.price = { input: Number(found.pricing.prompt) * 1e6, output: Number(found.pricing.completion) * 1e6 };
    }
    return { id: this.model, contextTokens: this.options.contextTokens, inputUsdPerToken: this.price.input / 1e6, outputUsdPerToken: this.price.output / 1e6, capabilities: { structuredOutput: false, toolCalling: true, cancellation: 'abort-request', modelVersion: false }, metadata: { pipeline: 'ros-nemotron', purpose: this.options.purpose } };
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const messages = this.beforeSend ? this.beforeSend(request.messages) : request.messages;
    const body: Record<string, unknown> = { model: this.model, messages: wireMessages(messages), max_tokens: request.maxOutputTokens, temperature: this.options.thinking ? 0.6 : 0.3, ...(request.tools ? { tools: wireTools(request.tools), tool_choice: 'auto' } : {}), chat_template_kwargs: { enable_thinking: this.options.thinking } };
    const inputBytes = Buffer.byteLength(JSON.stringify(body));
    // Worst case: one token per input byte and the full output allowance.
    this.options.ledger?.admit((inputBytes * this.price.input + request.maxOutputTokens * this.price.output) / 1e6);
    const response = await fetch(`${this.options.base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${this.options.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`${this.options.purpose}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    const result = await response.json() as { choices?: { message?: { content?: string | null } }[] };
    const message = result.choices?.[0]?.message;
    if (message && typeof message.content === 'string') message.content = message.content.replace(/<think>[\s\S]*?<\/think>/gu, '').replace(/^[\s\S]*<\/think>/u, '').trim();
    const captured = captureChatCompletion(result, { provider: this.provider, requestedModel: this.model, modelVersion: false, responseContract: request.tools ? 'agent-tool-calls' : 'text', wireRequest: { model: this.model }, allowToolCalls: Boolean(request.tools) });
    const usage = captured.usage ?? { inputTokens: Math.ceil(inputBytes / 4), outputTokens: request.maxOutputTokens };
    this.options.ledger?.settle({ purpose: this.options.purpose, model: this.model, ...usage, usd: (usage.inputTokens * this.price.input + usage.outputTokens * this.price.output) / 1e6 });
    return captured;
  }
}

/** The teacher, the world writer and the student, from the environment. NEBIUS_API_KEY is the one in
 * ~/.config/ros.ai/keys.env on Adam's Mac; the student is any OpenAI-compatible server. */
export function teacher(ledger: Ledger, purpose = 'teacher', thinking = !flag('no-thinking')) {
  const key = process.env.NEBIUS_API_KEY, base = process.env.ROS_TEACHER_URL || TOKEN_FACTORY;
  if (!key) throw new Error('Set NEBIUS_API_KEY (Token Factory) to run the teacher.');
  // Another server (a test double, or a gateway) states its price as ROS_TEACHER_USD_PER_MILLION="input,output".
  const [input = 0, output = 0] = (process.env.ROS_TEACHER_USD_PER_MILLION ?? '').split(',').map(Number);
  return new ChatAdapter({ base, key, model: TEACHER_MODEL, contextTokens: 128_000, thinking, ledger, purpose, ...(base === TOKEN_FACTORY ? {} : { usdPerMillion: { input, output } }) });
}
export function student() {
  const base = arg('student-url', process.env.ROS_STUDENT_URL || 'http://127.0.0.1:4319/v1')!;
  // The injected student is admitted like a hosted model: a token per byte, plus 4,096 and the 8,000-token output cap. The app admits
  // Local Ros at three bytes a token up to its 64 KB request cap, so 64,000 + 4,096 + 8,000 admits the same requests.
  return new ChatAdapter({ base, key: process.env.ROS_STUDENT_KEY || 'local', model: arg('student-model', 'ros-local')!, contextTokens: Number(arg('student-context', '76096')), thinking: false, purpose: 'student', usdPerMillion: { input: 0, output: 0 } });
}

/** One JSON object from a model's text answer, tolerating a Markdown fence around it. */
export function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/```\s*$/u, '');
  const start = trimmed.search(/[[{]/u);
  const body = trimmed.slice(start);
  try { return JSON.parse(body) as T; } catch {
    // Raw newlines and tabs inside string literals are the teacher's commonest slip.
    let inString = false, escaped = false, out = '';
    for (const char of body) {
      if (inString && !escaped && char < ' ') { out += char === '\n' ? '\\n' : char === '\t' ? '\\t' : char === '\r' ? '\\r' : ''; continue; }
      if (char === '"' && !escaped) inString = !inString;
      escaped = char === '\\' && !escaped;
      out += char;
    }
    return JSON.parse(out) as T;
  }
}
export async function ask<T>(model: ChatAdapter, system: string, user: string, maxOutputTokens = 6000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(300_000);
    await model.prepare(signal);
    const response = await model.complete({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxOutputTokens }, signal);
    try { return parseJson<T>(response.content); } catch (error) { if (attempt >= 2) throw error; console.warn(`Unparseable teacher JSON, retrying once: ${(error as Error).message}`); }
  }
}
