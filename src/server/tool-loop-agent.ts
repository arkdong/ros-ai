import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import type { ExecutionService } from './execution.js';
import type { ExperimentService } from './experiments.js';
import { AgentWorkspaceTools } from './agent-tools.js';
import { AGENT_LOOP_INSTRUCTIONS, selectionText } from './agent-prompt.js';
import type { ChatMessage, ModelTool, ToolCall } from './providers.js';
import { agentStep, type AgentEvent, type AgentExecuteRequest, type AgentResult } from '../shared/agent-runtime.js';
import type { ModelSelection } from '../shared/model-settings.js';
import { AGENT_CONTEXT_TOKENS } from '../shared/setup.js';

const now = () => new Date().toISOString();
const MAX_TOOL_CALLS = 30, MAX_MODEL_REQUESTS = 30, MAX_SECONDS = 900, MAX_FAILURES_IN_A_ROW = 3;
const MAX_OUTPUT_TOKENS = 8000, RESULT_CHARACTERS = 12_000, OLD_RESULT_CHARACTERS = 1_500, NEW_RESULT_CHARACTERS = 6_000, RESULT_TAIL_CHARACTERS = 400;
// ros.ai refuses provider requests above 64 KB, tools included; older tool results shrink first, then the newest.
const MESSAGE_BUDGET_BYTES = 44_000, REQUEST_BYTES = 62_000;

type Attempt = { id: string; projectId: string; assistantTurnId: string; at: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; selection: ModelSelection; label: string; requests: number; toolCalls: number; estimatedUsd: number; usageIds: string[]; events: AgentEvent[]; reply: string; error?: string };

/** The ros_* tools in the shape chat-completions servers take; the zod schemas stay the single contract. */
function modelTools(toolkit: AgentWorkspaceTools): ModelTool[] {
  return toolkit.definitions.map(({ name, description, inputSchema }) => {
    const { $schema: _schema, ...parameters } = inputSchema as Record<string, unknown>;
    return { name, description, parameters };
  });
}
const bytes = (messages: ChatMessage[]) => Buffer.byteLength(JSON.stringify(messages), 'utf8');
/** A tool result cut to its head and its tail, so the instruction a tool puts last (what to do next) survives the cut. */
const shorten = (content: string, head: number) => content.length <= head + RESULT_TAIL_CHARACTERS ? content : `${content.slice(0, head)}… [result shortened; call the tool again to see it whole] …${content.slice(-RESULT_TAIL_CHARACTERS)}`;
/** Keep the system prompt and the question whole; clip older tool results first, then the newest ones if the request
 * would still overflow (several page reads in one step, for example), rather than let the provider request fail. */
export function fit(messages: ChatMessage[], budget: number) {
  for (let index = 2; bytes(messages) > budget && index < messages.length - 2; index++) {
    const message = messages[index];
    if (message.role === 'tool' && message.content.length > OLD_RESULT_CHARACTERS + RESULT_TAIL_CHARACTERS) messages[index] = { ...message, content: shorten(message.content, OLD_RESULT_CHARACTERS) };
  }
  for (const head of [NEW_RESULT_CHARACTERS, OLD_RESULT_CHARACTERS]) for (let index = 2; bytes(messages) > budget && index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'tool' && message.content.length > head + RESULT_TAIL_CHARACTERS) messages[index] = { ...message, content: shorten(message.content, head) };
  }
}

/** ros.ai's own agent loop for any chat model with tool calling: Nemotron on Nebius Token
 * Factory, or a local model in Ollama or LM Studio. The model only names tool calls; each one
 * passes the same validation, scope and approval checks as Claude Code's, and every model
 * request goes through the project's model admission, budget and usage records. */
/** Tool calls a model wrote into its answer text because the provider's parser missed them
 * (Nemotron once did). Reads both the XML form (<function=name><parameter=key>) and the JSON form
 * ({"name", "arguments"}) inside <tool_call> tags; anything else stays ordinary text. */
export function textToolCalls(content: string): { text: string; calls: ToolCall[] } | undefined {
  if (!content.includes('<tool_call>')) return undefined;
  const calls: ToolCall[] = [];
  const text = content.replace(/<tool_call>([\s\S]*?)<\/tool_call>/gu, (whole, inner: string) => {
    const xml = /<function=([\w.-]+)>([\s\S]*?)<\/function>/u.exec(inner);
    if (xml) {
      const args: Record<string, unknown> = {};
      for (const [, key, raw] of xml[2].matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/gu)) {
        const value = raw.trim();
        try { args[key] = JSON.parse(value); } catch { args[key] = value; }
      }
      calls.push({ id: `text-${randomUUID()}`, name: xml[1], arguments: JSON.stringify(args) });
      return '';
    }
    try {
      const value = JSON.parse(inner.trim()) as { name?: unknown; arguments?: unknown };
      if (typeof value.name !== 'string') return whole;
      calls.push({ id: `text-${randomUUID()}`, name: value.name, arguments: typeof value.arguments === 'string' ? value.arguments : JSON.stringify(value.arguments ?? {}) });
      return '';
    } catch { return whole; }
  });
  return calls.length ? { text, calls } : undefined;
}

export class ToolLoopAgentService {
  private readonly active = new Map<string, AbortController>();
  private closed = false;
  constructor(private readonly store: Store, private readonly execution: ExecutionService, private readonly experiments: ExperimentService) {
    for (const project of store.listProjects()) for (const attempt of store.records<Attempt>('agent-loop-attempt', project.id)) if (attempt.status === 'running')
      store.saveRecord('agent-loop-attempt', attempt.id, project.id, { ...attempt, status: 'interrupted', error: 'ros.ai stopped while the agent was working. Its model requests stay recorded; nothing was repeated.' });
  }
  /** What the Agents list and turn header show for a model selection. */
  label(selection: ModelSelection) {
    const connection = this.execution.inference?.statuses().find(item => item.id === selection.provider);
    const where = ` · ${selection.provider === 'nebius' ? 'Token Factory' : (connection?.name ?? 'your server').slice(0, 20)}`;
    return `${selection.model.replace(/^nvidia\//i, '').slice(0, 40 - where.length)}${where}`;
  }
  /** Where the turn's requests go, as the conversation shows it. */
  destination(selection: ModelSelection): { destination: string; location: 'external' | 'local-unverified' } {
    if (selection.provider === 'nebius') return { destination: 'Nebius Token Factory', location: 'external' };
    const connection = this.execution.inference?.statuses().find(item => item.id === selection.provider);
    return { destination: connection?.name ?? 'your model server', location: connection?.destination === 'local-unverified' ? 'local-unverified' : 'external' };
  }
  /** The connected model a selection names, with what its server says about it. */
  private registered(selection: ModelSelection) {
    const connection = this.execution.inference?.statuses().find(item => item.id === selection.provider);
    const model = connection?.models.find(item => item.id === selection.model);
    return connection && model ? { connection, model, local: connection.destination === 'local-unverified' } : undefined;
  }
  /** Cheap and local: no model request is sent. */
  readiness(projectId: string, selection: ModelSelection): { available: boolean; reason: string | null } {
    if (selection.provider === 'openai') return { available: false, reason: 'The agent runs on Nemotron or a model you connected, not on the OpenAI connection. Choose another model.' };
    const found = this.registered(selection);
    if (found?.model.tools === false) return { available: false, reason: `${found.model.label} cannot call tools in ${found.connection.name}, so it cannot work step by step. Choose a model that can, or turn off “Use ros.ai’s tools step by step”.` };
    if (found?.local && found.model.contextTokens < AGENT_CONTEXT_TOKENS) return { available: false, reason: `${found.model.label} has a ${found.model.contextTokens.toLocaleString('en-US')}-token context in ${found.connection.name}; working step by step needs at least ${AGENT_CONTEXT_TOKENS / 1024}k (32k is better). Raise its context length there, then press Refresh under Agents › Local models.` };
    const capabilities = this.execution.assistantCapabilities(projectId);
    return capabilities.modelAvailable ? { available: true, reason: null } : { available: false, reason: capabilities.modelBlocker ?? 'The selected model cannot run.' };
  }
  async execute(request: AgentExecuteRequest & { selection: ModelSelection }): Promise<AgentResult> {
    if (this.closed) throw new StoreError('ros.ai is stopping.', 503);
    if (this.active.has(request.projectId)) throw new StoreError('An agent is already working in this project.', 409);
    const ready = this.readiness(request.projectId, request.selection);
    if (!ready.available) throw new StoreError(ready.reason!, 503);
    const message = z.string().trim().min(1).max(12000).parse(request.message), label = this.label(request.selection);
    const toolkit = new AgentWorkspaceTools(this.store, this.execution, this.experiments, request, request.turnId, 'model', label);
    const tools = modelTools(toolkit), names = new Set(tools.map(item => item.name));
    // The request carries the tools as well as the messages, so the messages get what the 64 KB cap leaves after the
    // tools; a local model's context holds both too, at three bytes a token.
    const found = this.registered(request.selection), toolBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    const remote = Math.min(MESSAGE_BUDGET_BYTES, Math.max(8_000, REQUEST_BYTES - toolBytes));
    const budget = found?.local ? Math.min(remote, Math.max(8_000, (found.model.contextTokens - 2_048) * 3 - toolBytes)) : remote;
    const messages: ChatMessage[] = [
      { role: 'system', content: AGENT_LOOP_INSTRUCTIONS },
      { role: 'user', content: `${selectionText(toolkit.preview())}\n\n${request.preferences ? `${request.preferences}\n\n` : ''}Researcher's message:\n${message}` },
    ];
    const id = randomUUID();
    let attempt: Attempt = { id, projectId: request.projectId, assistantTurnId: request.turnId, at: now(), status: 'running', selection: request.selection, label, requests: 0, toolCalls: 0, estimatedUsd: 0, usageIds: [], events: [], reply: '' };
    const save = () => this.store.saveRecord('agent-loop-attempt', id, request.projectId, attempt);
    const event = (value: AgentEvent) => { if (attempt.events.length < 300) { attempt.events.push(value); save(); } request.onEvent(value); };
    save();

    const controller = new AbortController();
    let timedOut = false;
    const stop = () => controller.abort(), deadline = setTimeout(() => { timedOut = true; stop(); }, MAX_SECONDS * 1000);
    request.signal.addEventListener('abort', stop, { once: true });
    toolkit.signal = controller.signal;
    this.active.set(request.projectId, controller);
    try {
      let failures = 0, reply = '';
      for (;;) {
        if (controller.signal.aborted) throw new StoreError(timedOut ? `The agent reached the ${MAX_SECONDS / 60}-minute limit for one turn and was stopped.` : 'The agent was stopped.', timedOut ? 503 : 409);
        if (attempt.requests >= MAX_MODEL_REQUESTS) throw new StoreError(`The agent reached the limit of ${MAX_MODEL_REQUESTS} model requests for one turn before finishing.`, 503);
        fit(messages, budget);
        attempt.requests++;
        const { response, usage } = await this.execution.assistantComplete(request.projectId, { messages, maxOutputTokens: MAX_OUTPUT_TOKENS, tools }, controller.signal, request.selection);
        attempt.usageIds.push(usage.id); attempt.estimatedUsd += usage.estimatedUsd ?? usage.reservedUsd; save();
        const written = response.toolCalls?.length ? undefined : textToolCalls(response.content);
        const text = (written?.text ?? response.content).trim(), calls: ToolCall[] = response.toolCalls?.length ? response.toolCalls : written?.calls ?? [];
        if (!calls.length) { reply = text; break; }
        if (text) event({ at: now(), type: 'thought', message: text.length > 600 ? `…${text.slice(-600)}` : text });
        messages.push({ role: 'assistant', content: text, toolCalls: calls });
        for (const call of calls) {
          const result = await this.run(call, names, toolkit, ++attempt.toolCalls, event);
          failures = result.failed ? failures + 1 : 0;
          messages.push({ role: 'tool', toolCallId: call.id, content: result.text });
        }
        save();
        if (failures >= MAX_FAILURES_IN_A_ROW) throw new StoreError(`The agent's last ${failures} tool calls failed ros.ai's checks, so the turn ended. Nothing from them was applied.`, 503);
      }
      if (!reply) throw new StoreError('The agent finished without a readable answer.', 503);
      event({ at: now(), type: 'usage', message: `${attempt.requests} model request${attempt.requests === 1 ? '' : 's'}, about US$${attempt.estimatedUsd.toFixed(4)}.`, data: { requests: attempt.requests, estimatedUsd: attempt.estimatedUsd } });
      attempt = { ...attempt, status: 'completed', reply }; save();
      return { reply, sessionId: id, actions: toolkit.actions, requestId: id };
    } catch (error) {
      const text = error instanceof StoreError ? error.message : `The agent stopped: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}. Its model requests stay recorded; nothing was repeated.`;
      attempt = { ...attempt, status: controller.signal.aborted && !timedOut ? 'interrupted' : 'failed', error: text }; save();
      throw new StoreError(text, error instanceof StoreError ? error.status : 503);
    } finally { clearTimeout(deadline); request.signal.removeEventListener('abort', stop); this.active.delete(request.projectId); void toolkit.close(); }
  }
  /** One tool call, checked like Claude Code's: an error goes back to the model as text it can fix. */
  private async run(call: ToolCall, names: Set<string>, toolkit: AgentWorkspaceTools, count: number, event: (value: AgentEvent) => void): Promise<{ text: string; failed: boolean }> {
    const fail = (text: string, args?: unknown) => { event({ at: now(), type: 'tool', message: text, step: agentStep(count, call.name, args, { failed: true }) }); return { text: `Error: ${text}`, failed: true }; };
    if (count > MAX_TOOL_CALLS) return fail(`This turn reached its limit of ${MAX_TOOL_CALLS} ros.ai tool calls. No effect was applied; finish your answer.`);
    if (!names.has(call.name)) return fail(`ros.ai has no tool named ${call.name}.`);
    let args: unknown;
    try { args = JSON.parse(call.arguments || '{}'); } catch { return fail(`The arguments for ${call.name} are not valid JSON. No effect was applied.`); }
    event({ at: now(), type: 'tool', message: `The agent requested ${call.name}.`, data: { name: call.name, arguments: args }, step: agentStep(count, call.name, args) });
    try {
      const result = await toolkit.call(call.name, args);
      event({ at: now(), type: 'tool', message: `${call.name} returned a validated result.`, data: result, step: agentStep(count, call.name, args, { value: result }) });
      const text = JSON.stringify(result);
      return { text: text.length > RESULT_CHARACTERS ? `${text.slice(0, RESULT_CHARACTERS)}… [result shortened]` : text, failed: false };
    } catch (error) {
      return fail(error instanceof StoreError ? error.message : error instanceof z.ZodError ? `The arguments for ${call.name} failed ros.ai validation: ${error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}. No effect was applied.` : 'Tool arguments failed ros.ai validation. No effect was applied.', args);
    }
  }
  async shutdown() { this.closed = true; for (const controller of this.active.values()) controller.abort(); }
}
