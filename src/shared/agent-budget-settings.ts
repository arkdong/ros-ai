/** Cumulative local agent resources; never a USD/token billing cap. */
export type CodexAllowanceLimits = { maxTurns: number; maxRuntimeSeconds: number; maxToolCalls: number; perTurnSeconds: number; perTurnToolCalls: number };
export type CodexAllowanceResources = { turns: number; runtimeSeconds: number; toolCalls: number };
export type CodexAllowanceScope = { nodeIds: string[]; artifactIds: string[]; capturedAt: string | null; projectRevision: number | null };
export type CodexAllowanceStatus = {
  projectId: string; source: 'app' | 'environment' | 'none'; enabled: boolean;
  ready: boolean; isolationReady: boolean; available: boolean; reason: string;
  grantId: string | null; limits: CodexAllowanceLimits | null;
  used: CodexAllowanceResources; remaining: CodexAllowanceResources; scope: CodexAllowanceScope;
  createdAt: string | null; updatedAt: string | null; expiresAt: string | null; limitations: string[];
};
export type CodexAllowanceUpdate = CodexAllowanceLimits & { enabled: true; acknowledged: true; nodeIds?: string[]; artifactIds?: string[] };
