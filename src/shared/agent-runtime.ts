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
/** One ros.ai tool call as the timeline shows it: its target block and what came of it. */
export type AgentStep = { call: number; tool: string; outcome: 'requested' | 'done' | 'waiting' | 'declined' | 'failed'; target?: string; size?: number };
export type AgentEvent = { at: string; type: 'progress' | 'delta' | 'tool' | 'approval' | 'usage' | 'thought'; message: string; data?: unknown; step?: AgentStep };
/** Shared by both agent transports, so Claude Code and Codex timelines read the same. */
export function agentStep(call: number, tool: string, input: unknown, result?: { value?: unknown; failed?: boolean }): AgentStep {
  if (!result) {
    const args = (input && typeof input === 'object' ? input : {}) as { resultNodeId?: unknown; nodeId?: unknown; targetNodeId?: unknown; directions?: unknown };
    const target = [args.resultNodeId, args.nodeId, args.targetNodeId].find(value => typeof value === 'string') as string | undefined;
    return { call, tool, outcome: 'requested', ...(target ? { target } : {}), ...(Array.isArray(args.directions) ? { size: args.directions.length } : {}) };
  }
  const value = (result.value && typeof result.value === 'object' ? result.value : {}) as { status?: unknown; action?: { status?: unknown } };
  const status = value.status ?? value.action?.status;
  return { call, tool, outcome: result.failed ? 'failed' : status === 'dismissed' ? 'declined' : status === 'pending' ? 'waiting' : 'done' };
}
export type AgentResult = { reply: string; sessionId: string; actions: AssistantAction[]; requestId: string };
export type AgentScope = { projectId: string; nodeIds: string[]; artifactIds: string[] };
export type AgentExecuteRequest = AgentScope & { turnId: string; message: string; signal: AbortSignal; onEvent: (event: AgentEvent) => void };
export interface AgentRuntime {
  status(projectId: string): Promise<AgentConnectionStatus>;
  execute(request: AgentExecuteRequest): Promise<AgentResult>;
  shutdown(): Promise<void>;
}
