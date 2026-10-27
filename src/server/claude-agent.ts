import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { createSdkMcpServer, query, tool, type AnyZodRawShape, type HookCallback, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Store, StoreError } from './store.js';
import type { ExecutionService } from './execution.js';
import type { ExperimentService } from './experiments.js';
import { AgentWorkspaceTools, agentToolSchemas } from './agent-tools.js';
import { CLAUDE_CODE_INSTRUCTIONS, selectionText } from './agent-prompt.js';
import { projectFolderRoot } from './project-folders.js';
import { agentStep, type AgentEvent, type AgentExecuteRequest, type AgentResult } from '../shared/agent-runtime.js';
import { CLAUDE_MODELS, type ClaudeAgentSettings, type ClaudeBilling, type ClaudeModel } from '../shared/claude-agent.js';
import { ClaudePlan, planAllowed, planEnvironment } from './claude-plan.js';

const now = () => new Date().toISOString();
const SERVER = 'ros';
const FILE_TOOLS = ['Read', 'Glob', 'Grep'];
const MAX_TOOL_CALLS = 30, MAX_MODEL_TURNS = 30, MAX_SECONDS = 900, MIN_TURN_USD = 0.05;
// One turn reserves this much of the Claude connection allowance and passes it to
// Claude Code as its budget. A completed turn settles at the cost Claude Code reports.
const TURN_USD = Math.min(20, Math.max(MIN_TURN_USD, Number(process.env.ROS_CLAUDE_TURN_USD) || 1));
const sdkVersion = (() => { try { return String(JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')).version); } catch { return 'unknown'; } })();


type Session = { sessionId: string; scopeHash: string; cwd: string; costUsd: number; state: 'ready' | 'uncertain'; at: string };
type Attempt = { id: string; projectId: string; assistantTurnId: string; at: string; status: 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain'; model: string; billing?: ClaudeBilling; usageId: string | null; reservedUsd: number; costUsd?: number; sessionId?: string; request: unknown; events: AgentEvent[]; reply: string; error?: string };

/** The child gets only what it needs to run; ros.ai's other provider keys are not forwarded.
 * Its own config directory keeps any personal Claude Code login, settings, skills or
 * CLAUDE.md files out of the session, so the API key is the only credential it can use. */
function childEnvironment(apiKey: string, configDir: string) {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'USERPROFILE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', /* a gateway the person set up themselves */ 'ANTHROPIC_BASE_URL']) if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: configDir, CLAUDE_AGENT_SDK_CLIENT_APP: 'ros-ai/0.1.0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
}
function inside(root: string, target: string) {
  const full = resolve(root, target);
  let real = full;
  try { real = realpathSync(full); } catch { /* A missing path is checked as written. */ }
  const rel = relative(root, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** Enforcement, not instructions: every tool call passes here before it runs. */
function toolGuard(root: string | null): HookCallback {
  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } });
  return async input => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (input.tool_name.startsWith(`mcp__${SERVER}__`) && input.mcp_server?.source !== undefined && input.mcp_server.source !== 'sdk') return deny('Only ros.ai tools are available.');
    if (input.tool_name.startsWith(`mcp__${SERVER}__`)) return {};
    if (!root || !FILE_TOOLS.includes(input.tool_name)) return deny('This tool is not available in ros.ai. Use the mcp__ros__ tools for changes and code.');
    const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input as Record<string, unknown> : {};
    const target = input.tool_name === 'Read' ? args.file_path : args.path;
    if (target !== undefined && (typeof target !== 'string' || !inside(root, target))) return deny('Only files inside this project folder can be read.');
    if (input.tool_name === 'Read' && target === undefined) return deny('Name a file inside this project folder.');
    const pattern = input.tool_name === 'Glob' ? args.pattern : args.glob;
    if (typeof pattern === 'string' && (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..'))) return deny('Search patterns must stay inside this project folder.');
    return {};
  };
}
async function* single(message: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null };
}

/** Claude Code through Anthropic's Agent SDK, paid for by either the Anthropic API key saved
 * on the Agents page or, in the local app, the person's own Claude plan (see claude-plan.ts). */
export class ClaudeAgentService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private readonly configDir: string;
  private closed = false;
  readonly plan = new ClaudePlan();
  constructor(private readonly store: Store, private readonly execution: ExecutionService, private readonly experiments: ExperimentService, dataDir: string) {
    this.configDir = join(dataDir, 'claude-code');
    for (const project of store.listProjects()) for (const attempt of store.records<Attempt>('claude-attempt', project.id)) if (attempt.status === 'running') {
      store.saveRecord('claude-attempt', attempt.id, project.id, { ...attempt, status: 'uncertain', error: 'ros.ai stopped while Claude Code was working. Its full reservation stays counted; nothing was repeated.' });
      const session = store.record<Session>('claude-session', project.id);
      if (session) store.saveRecord('claude-session', project.id, project.id, { ...session, state: 'uncertain' });
    }
  }
  private saved() {
    const saved = this.store.globalRecord<{ model: ClaudeModel; billing?: ClaudeBilling }>('claude-agent-settings', 'settings');
    return { model: saved?.model ?? 'sonnet', billing: planAllowed && saved?.billing === 'plan' ? 'plan' as const : 'api-key' as const };
  }
  settings(): ClaudeAgentSettings {
    const { model, billing } = this.saved();
    const budget = this.execution.connectionBudgets.status('claude');
    return { model, models: CLAUDE_MODELS, billing, planAllowed, plan: this.plan.current(), login: this.plan.loginState(), turnUsd: TURN_USD, sdkVersion, apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()), allowanceReady: budget.ready && budget.remainingUsd >= MIN_TURN_USD };
  }
  /** Settings with a fresh look at the Claude plan sign-in; still no model request. */
  async checkedSettings() { await this.plan.check(); return this.settings(); }
  async update(supplied: unknown) {
    const value = z.object({ model: z.enum(CLAUDE_MODELS.map(item => item.id) as [ClaudeModel, ...ClaudeModel[]]).optional(), billing: z.enum(['api-key', 'plan']).optional() }).strict().parse(supplied);
    if (this.active.size) throw new StoreError('Wait for the current Claude Code turn to finish before changing its settings.', 409);
    if (value.billing === 'plan' && !planAllowed) throw new StoreError('A Claude plan can only be used in the local app.', 403);
    this.store.saveGlobalRecord('claude-agent-settings', 'settings', { ...this.saved(), ...value });
    return this.checkedSettings();
  }
  /** Cheap and local: no request is sent to Anthropic. */
  readiness(projectId: string): { available: boolean; reason: string | null } {
    if (this.saved().billing === 'plan') {
      // An unchecked sign-in is let through: Claude Code's own start-up check below decides.
      const plan = this.plan.current();
      if (plan.state === 'signed-out') return { available: false, reason: 'Sign in with your Claude plan on the Agents page, then Claude Code can answer here.' };
      if (plan.state === 'unavailable') return { available: false, reason: plan.message ?? 'Your Claude plan cannot be used here.' };
      if (this.experiments.authority.policy(projectId).stopped) return { available: false, reason: 'Project research is stopped. Resume deliberately before a new turn.' };
      return { available: true, reason: null };
    }
    if (!process.env.ANTHROPIC_API_KEY?.trim()) return { available: false, reason: 'Connect a Claude API key on the Agents page, then Claude Code can answer here.' };
    const budget = this.execution.connectionBudgets.status('claude');
    if (!budget.ready) return { available: false, reason: budget.reason };
    if (budget.remainingUsd < MIN_TURN_USD) return { available: false, reason: `Less than US$${MIN_TURN_USD.toFixed(2)} of the Claude Code allowance remains. Raise the allowance on the Model page.` };
    if (this.experiments.authority.policy(projectId).stopped) return { available: false, reason: 'Project research is stopped. Resume deliberately before a new turn.' };
    return { available: true, reason: null };
  }
  async execute(request: AgentExecuteRequest): Promise<AgentResult> {
    if (this.closed) throw new StoreError('ros.ai is stopping.', 503);
    if (this.active.has(request.projectId)) throw new StoreError('Claude Code is already working in this project.', 409);
    const ready = this.readiness(request.projectId);
    if (!ready.available) throw new StoreError(ready.reason!, 503);
    const message = z.string().trim().min(1).max(12000).parse(request.message);
    const { model, billing } = this.saved(), onPlan = billing === 'plan';
    const apiKey = onPlan ? '' : process.env.ANTHROPIC_API_KEY!.trim();
    const toolkit = new AgentWorkspaceTools(this.store, this.execution, this.experiments, request, request.turnId, 'claude');
    const root = projectFolderRoot(this.store, request.projectId);
    const cwd = root ?? join(this.configDir, 'work', request.projectId);
    if (!root) mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });

    // Validate before reserving: a reservation is only returned by a reported, completed turn.
    // A turn on the person's Claude plan costs ros.ai nothing, so it reserves no allowance; the plan's own limits apply.
    const requestId = randomUUID(), budget = this.execution.connectionBudgets.status('claude');
    const reservedUsd = onPlan ? 0 : Math.min(TURN_USD, Math.floor(budget.remainingUsd * 100) / 100);
    if (!onPlan && reservedUsd < MIN_TURN_USD) throw new StoreError(`Less than US$${MIN_TURN_USD.toFixed(2)} of the Claude Code allowance remains.`, 409);
    const usage = this.store.atomic(() => {
      this.experiments.authority.reserve(request.projectId, { kind: 'model', nodeId: request.nodeIds[0] ?? 'project', fingerprint: `claude:${requestId}`, spendUsd: reservedUsd });
      return onPlan ? null : this.execution.connectionBudgets.reserve({ provider: 'claude', amountUsd: reservedUsd, purpose: 'Claude Code assistant turn', basis: `Claude Code budget for one turn (maxBudgetUsd ${reservedUsd}); settled at the cost Claude Code reports at Anthropic's published rates, an estimate rather than an invoice`, trace: { requestId, model, projectId: request.projectId, nodeId: request.nodeIds[0] ?? null } }, budget.revision);
    });

    // A new selection moves focus, not the conversation: each prompt states the current selection.
    // The plan and the key keep their sessions in different places, so switching starts a new one.
    const scopeHash = createHash('sha256').update(JSON.stringify(onPlan ? { cwd, billing } : { cwd })).digest('hex');
    const prior = this.store.record<Session>('claude-session', request.projectId);
    const resume = prior && prior.scopeHash === scopeHash && prior.state === 'ready' ? prior : null;
    const prompt = `${root ? `The project folder is your working directory: ${root}` : 'This project has no folder on disk, so no files are available; use the selected material and mcp__ros__ tools.'}\n\n${selectionText(toolkit.preview())}\n\n${request.preferences ? `${request.preferences}\n\n` : ''}Researcher's message:\n${message}`;
    const allowedTools = [...(root ? FILE_TOOLS : []), ...toolkit.definitions.map(item => `mcp__${SERVER}__${item.name}`)];
    let attempt: Attempt = { id: requestId, projectId: request.projectId, assistantTurnId: request.turnId, at: now(), status: 'running', model, billing, usageId: usage?.id ?? null, reservedUsd, request: { prompt, model, cwd, resume: resume?.sessionId ?? null, tools: allowedTools, maxBudgetUsd: onPlan ? null : reservedUsd, maxTurns: MAX_MODEL_TURNS, sdkVersion, authentication: onPlan ? 'Claude plan (Claude Code’s own sign-in)' : 'ANTHROPIC_API_KEY', automaticRetry: false }, events: [], reply: '' };
    const save = () => this.store.saveRecord('claude-attempt', requestId, request.projectId, attempt);
    const event = (value: AgentEvent) => { if (attempt.events.length < 300) { attempt.events.push(value); save(); } request.onEvent(value); };
    save();

    let toolCalls = 0, stopped = false, timedOut = false, refused = '', thoughtMark = 0, apiError = '';
    const controller = new AbortController(), stop = () => { stopped = true; controller.abort(); };
    toolkit.signal = controller.signal;
    // What Claude wrote since its last ros.ai tool call is shown as the reason for the next one.
    const thought = () => { const text = attempt.reply.slice(thoughtMark).trim(); thoughtMark = attempt.reply.length; if (text) event({ at: now(), type: 'thought', message: text.length > 600 ? `…${text.slice(-600)}` : text }); };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, MAX_SECONDS * 1000);
    request.signal.addEventListener('abort', stop, { once: true });
    const tools = toolkit.definitions.map(definition => tool(definition.name, definition.description, agentToolSchemas[definition.name as keyof typeof agentToolSchemas].shape as AnyZodRawShape, async (args: unknown) => {
      const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
      if (stopped) return reply('The turn has stopped. No tool effect was applied.', true);
      if (++toolCalls > MAX_TOOL_CALLS) return reply(`This turn reached its limit of ${MAX_TOOL_CALLS} ros.ai tool calls. No effect was applied; finish your answer.`, true);
      const call = toolCalls;
      thought();
      event({ at: now(), type: 'tool', message: `Claude Code requested ${definition.name}.`, data: { name: definition.name, arguments: args }, step: agentStep(call, definition.name, args) });
      try { const result = await toolkit.call(definition.name, args); event({ at: now(), type: 'tool', message: `${definition.name} returned a validated result.`, data: result, step: agentStep(call, definition.name, args, { value: result }) }); return reply(JSON.stringify(result)); }
      catch (error) { const text = error instanceof StoreError ? error.message : 'Tool arguments failed ros.ai validation. No effect was applied.'; event({ at: now(), type: 'tool', message: text, step: agentStep(call, definition.name, args, { failed: true }) }); return reply(text, true); }
    }));
    let finished: { cost: number; subtype: string; text: string; sessionId: string } | null = null;
    const done = (async () => {
      const stream = query({ prompt: single(prompt), options: {
        abortController: controller, cwd, model, env: onPlan ? planEnvironment() : childEnvironment(apiKey, this.configDir),
        tools: root ? FILE_TOOLS : [], allowedTools, disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'],
        permissionMode: 'dontAsk', settingSources: [], skills: [], strictMcpConfig: true,
        mcpServers: { [SERVER]: createSdkMcpServer({ name: SERVER, version: '0.1.0', tools, alwaysLoad: true }) },
        hooks: { PreToolUse: [{ hooks: [toolGuard(root)] }] },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_CODE_INSTRUCTIONS },
        ...(onPlan ? {} : { maxBudgetUsd: reservedUsd }), maxTurns: MAX_MODEL_TURNS, includePartialMessages: true,
        ...(resume ? { resume: resume.sessionId } : {}),
        stderr: () => {},
      } });
      let textBlocks = 0;
      for await (const item of stream as AsyncIterable<SDKMessage>) {
        if (item.type === 'system' && item.subtype === 'init') {
          attempt.sessionId = item.session_id; attempt.request = { ...(attempt.request as object), claudeCodeVersion: item.claude_code_version, reportedModel: item.model, reportedTools: item.tools, apiKeySource: item.apiKeySource }; save();
          // The session must bill what the person chose: the key ros.ai passed, or their Claude plan and never some other key.
          if (onPlan ? item.apiKeySource !== 'none' && item.apiKeySource !== 'oauth' : item.apiKeySource !== 'ANTHROPIC_API_KEY') { refused = onPlan ? 'Claude Code did not confirm it is using your Claude plan, so ros.ai stopped the turn.' : 'Claude Code did not confirm it is using the API key from the Agents page, so ros.ai stopped the turn.'; stop(); }
        } else if (item.type === 'stream_event' && item.parent_tool_use_id === null) {
          const value = item.event;
          if (value.type === 'content_block_start' && value.content_block.type === 'text' && textBlocks++ > 0) event({ at: now(), type: 'delta', message: '\n\n' });
          if (value.type === 'content_block_delta' && value.delta.type === 'text_delta') {
            if (attempt.reply.length + value.delta.text.length > 120000) { refused = 'Claude Code’s answer exceeded the local capture limit.'; stop(); break; }
            attempt.reply += value.delta.text; event({ at: now(), type: 'delta', message: value.delta.text });
          }
        } else if (item.type === 'assistant' && item.parent_tool_use_id === null) {
          if (item.error) apiError = item.error;
          for (const block of item.message.content) if (block.type === 'tool_use' && !block.name.startsWith(`mcp__${SERVER}__`)) event({ at: now(), type: 'progress', message: `Claude Code asked to use ${block.name}.`, data: { name: block.name, input: block.input } });
        } else if (item.type === 'result') {
          finished = { cost: item.total_cost_usd, subtype: item.subtype, text: item.subtype === 'success' ? item.result : '', sessionId: item.session_id };
        }
      }
    })();
    this.active.set(request.projectId, { controller, done: done.catch(() => {}) });
    try {
      try { await done; } catch (error) { if (!stopped) throw error; }
      const result = finished as { cost: number; subtype: string; text: string; sessionId: string } | null;
      if (result) {
        // Claude Code reports a running total for a resumed session; this turn is the difference.
        const turnCost = Math.round(Math.max(0, result.cost - (resume && result.sessionId === resume.sessionId && result.cost >= resume.costUsd ? resume.costUsd : 0)) * 1e9) / 1e9;
        attempt.costUsd = turnCost;
        if (usage) this.execution.connectionBudgets.settle('claude', usage.id, turnCost, { requestId, model, reportedTotalUsd: result.cost, subtype: result.subtype });
        event({ at: now(), type: 'usage', message: onPlan ? `Ran on your Claude plan; at API prices it would be about US$${turnCost.toFixed(4)}.` : `Claude Code reported about US$${turnCost.toFixed(4)} for this turn.`, data: { costUsd: turnCost, subtype: result.subtype, billing } });
        this.store.saveRecord('claude-session', request.projectId, request.projectId, { sessionId: result.sessionId, scopeHash, cwd, costUsd: result.cost, state: 'ready', at: now() } satisfies Session);
      }
      if (refused) throw new StoreError(refused, 503);
      if (timedOut) throw new StoreError(`Claude Code reached the ${MAX_SECONDS / 60}-minute limit for one turn and was stopped.`, 503);
      if (stopped) throw new StoreError('Claude Code was stopped.', 409);
      const failedOnPlan = onPlan && (!result || result.subtype !== 'success');
      if (failedOnPlan && apiError === 'rate_limit') throw new StoreError('Your Claude plan’s usage limit is reached for now. Try again later, or switch Claude Code to your API key on the Agents page.', 429);
      if (failedOnPlan && (apiError === 'authentication_failed' || apiError === 'oauth_org_not_allowed')) { this.plan.forget(); throw new StoreError('Claude Code’s sign-in to your Claude plan stopped working. Sign in again on the Agents page.', 503); }
      if (!result) throw new StoreError('Claude Code ended without a result. The outcome is uncertain; nothing was repeated.', 503);
      if (result.subtype === 'error_max_budget_usd') throw new StoreError(`Claude Code reached this turn’s US$${reservedUsd.toFixed(2)} budget before finishing. Ask a narrower question or raise ROS_CLAUDE_TURN_USD.`, 503);
      if (result.subtype === 'error_max_turns') throw new StoreError('Claude Code reached the step limit for one turn before finishing.', 503);
      if (result.subtype !== 'success') throw new StoreError('Claude Code stopped with an error. Its record and reservation are saved; nothing was repeated.', 503);
      const reply = (result.text || attempt.reply).trim();
      if (!reply) throw new StoreError('Claude Code finished without a readable answer.', 503);
      attempt = { ...attempt, status: 'completed', reply }; save();
      return { reply, sessionId: result.sessionId, actions: toolkit.actions, requestId };
    } catch (error) {
      let settled = attempt.costUsd !== undefined;
      // Claude Code reports its session before any model request, so without it nothing was sent.
      if (!settled && !attempt.sessionId) { if (usage) this.execution.connectionBudgets.settle('claude', usage.id, 0, { requestId, model, outcome: 'Claude Code did not start; no model request was sent' }); attempt.costUsd = 0; settled = true; }
      if (!settled && usage) this.store.updateUsage(usage.id, { status: 'uncertain' });
      attempt = { ...attempt, status: stopped && !refused && !timedOut ? 'interrupted' : settled ? 'failed' : 'uncertain', error: error instanceof StoreError ? error.message : `Claude Code failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}. Its full reservation stays counted; nothing was repeated.` }; save();
      if (!settled) { const session = this.store.record<Session>('claude-session', request.projectId); if (session) this.store.saveRecord('claude-session', request.projectId, request.projectId, { ...session, state: 'uncertain' }); }
      throw new StoreError(attempt.error!, 503);
    } finally { clearTimeout(deadline); request.signal.removeEventListener('abort', stop); this.active.delete(request.projectId); void toolkit.close(); }
  }
  async shutdown() { this.closed = true; this.plan.shutdown(); for (const value of this.active.values()) value.controller.abort(); await Promise.allSettled([...this.active.values()].map(value => value.done)); }
}

export function attachClaudeAgentRoutes(app: Express, service: ClaudeAgentService) {
  app.get('/api/agents/claude', async (_req, res) => { res.json(await service.checkedSettings()); });
  app.put('/api/agents/claude', async (req, res) => {
    if (!req.is('application/json')) throw new StoreError('Send Claude Code settings as JSON.', 415);
    res.json(await service.update(req.body));
  });
  // Claude Code's own sign-in to the person's Claude plan; ros.ai never sees the token.
  app.post('/api/agents/claude/plan-login', (_req, res) => { res.json(service.plan.startLogin()); });
  app.post('/api/agents/claude/plan-login/cancel', (_req, res) => { res.json(service.plan.cancelLogin()); });
}
