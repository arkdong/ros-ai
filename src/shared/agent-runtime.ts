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
export type AgentEvent = { at: string; type: 'progress' | 'delta' | 'tool' | 'approval' | 'usage' | 'thought'; message: string; data?: unknown };
export type AgentResult = { reply: string; sessionId: string; actions: AssistantAction[]; requestId: string };
export type AgentScope = { projectId: string; nodeIds: string[]; artifactIds: string[] };
export type AgentExecuteRequest = AgentScope & { turnId: string; message: string; signal: AbortSignal; onEvent: (event: AgentEvent) => void };
export interface AgentRuntime {
  status(projectId: string): Promise<AgentConnectionStatus>;
  execute(request: AgentExecuteRequest): Promise<AgentResult>;
  shutdown(): Promise<void>;
}
