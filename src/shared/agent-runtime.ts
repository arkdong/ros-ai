import type { AssistantAction } from './assistant.js';

/** Full agent runtimes are separate from model API providers and Python execution. */
export type AgentConnectionStatus = {
  id: 'codex'; label: string; checkedAt: string; installed: boolean; version: string | null;
  signedIn: boolean; authMethod: 'chatgpt' | 'api-key' | 'unknown' | null;
  configured: boolean; authorized: boolean; available: boolean;
  detail: string; blockers: string[];
  features: { appServer: boolean; dynamicTools: boolean; interrupt: boolean; restrictedReadAccess: boolean };
  enforcement: string[]; limitations: string[];
  grant: { id: string; remainingTurns: number; remainingSeconds: number; remainingToolCalls: number; expiresAt: string | null } | null;
};
/** One ros.ai tool call as the timeline shows it: its target block, how many things it covered, the blocks
 * or saved versions it made (items), what it turned down (skipped), the proposal it made, and what came of it. */
export type AgentStep = { call: number; tool: string; outcome: 'requested' | 'done' | 'waiting' | 'declined' | 'failed'; target?: string; size?: number; items?: string[]; skipped?: number; proposalId?: string };
export type AgentEvent = { at: string; type: 'progress' | 'delta' | 'tool' | 'approval' | 'usage' | 'thought'; message: string; data?: unknown; step?: AgentStep };
/** Shared by both agent transports, so Claude Code and Codex timelines read the same. */
export function agentStep(call: number, tool: string, input: unknown, result?: { value?: unknown; failed?: boolean }): AgentStep {
  if (!result) {
    const args = (input && typeof input === 'object' ? input : {}) as { resultNodeId?: unknown; nodeId?: unknown; targetNodeId?: unknown; directions?: unknown; pages?: unknown; findings?: unknown; themes?: unknown; claims?: unknown; verdicts?: unknown };
    const target = [args.resultNodeId, args.nodeId, args.targetNodeId].find(value => typeof value === 'string') as string | undefined;
    const list = [args.directions, args.pages, args.findings, args.themes, args.claims, args.verdicts].find(Array.isArray);
    return { call, tool, outcome: 'requested', ...(target ? { target } : {}), ...(list ? { size: list.length } : {}) };
  }
  const value = (result.value && typeof result.value === 'object' ? result.value : {}) as { status?: unknown; count?: unknown; items?: unknown; rejected?: unknown; action?: { status?: unknown; proposalId?: unknown } };
  const status = value.status ?? value.action?.status, items = Array.isArray(value.items) ? value.items.filter((item): item is string => typeof item === 'string').slice(0, 30) : [];
  return { call, tool, outcome: result.failed ? 'failed' : status === 'dismissed' ? 'declined' : status === 'pending' ? 'waiting' : 'done',
    ...(typeof value.count === 'number' ? { size: value.count } : {}), ...(items.length ? { items } : {}), ...(Array.isArray(value.rejected) && value.rejected.length ? { skipped: value.rejected.length } : {}), ...(typeof value.action?.proposalId === 'string' ? { proposalId: value.action.proposalId } : {}) };
}
export type AgentResult = { reply: string; sessionId: string; actions: AssistantAction[]; requestId: string };
export type AgentScope = { projectId: string; nodeIds: string[]; artifactIds: string[] };
/** preferences: the person's kept memory lines as one paragraph, labelled as their own notes; left out when there are none. */
export type AgentExecuteRequest = AgentScope & { turnId: string; message: string; preferences?: string; signal: AbortSignal; onEvent: (event: AgentEvent) => void };
export interface AgentRuntime {
  status(projectId: string): Promise<AgentConnectionStatus>;
  execute(request: AgentExecuteRequest): Promise<AgentResult>;
  shutdown(): Promise<void>;
}
