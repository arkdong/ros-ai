export type ApprovalMode = 'ask' | 'review' | 'full';
/** Running tallies of project work. They are a record, not a limit. */
export type ResearchUsage = { experiments:number; modelCalls:number; createdActions:number; runtimeSeconds:number; spendUsd:number };
export type ResearchPolicy = { projectId:string; mode:ApprovalMode; overrides:Record<string,ApprovalMode>; used:ResearchUsage; stopped:boolean; revision:number };
/** A block's own approval mode, else the project's. Only the overrides' own keys count: a block id such as `__proto__` or
 * `constructor` would otherwise read a built-in of every object, which is no mode and was once treated as approved. */
export function approvalModeFor(policy: Pick<ResearchPolicy, 'mode' | 'overrides'>, nodeId: string): ApprovalMode {
  const own = Object.hasOwn(policy.overrides, nodeId) ? policy.overrides[nodeId] : undefined;
  return own === 'ask' || own === 'review' || own === 'full' ? own : policy.mode;
}
export type ReviewDecision = { id:string; at:string; mode:ApprovalMode; outcome:'allow'|'escalate'|'deny'; reason:string; kind:'experiment'|'create-action'|'model'|'canvas-change'|'browser'; nodeId:string; fingerprint:string; policyRevision:number };
export type LocalConnection = { id:string; projectId:string; name:string; kind:'csv'|'output-folder'; path:string; writable:boolean; createdAt:string; updatedAt:string };
export type ProjectResource = { id:string; projectId:string; name:string; storage:'linked'|'copied'|'captured'; kind:'csv'|'source'; createdAt:string; fileName?:string; path?:string; bytes?:number; hash?:string; connectionId?:string; artifactId?:string; nodeId?:string; url?:string; locator?:string; originKey?:string };
export type ResourcePreview = { resource:ProjectResource; content:string; hash:string };
export type Highlight = { id:string; projectId:string; nodeId:string; artifactId:string; x:number; y:number; createdAt:string };
