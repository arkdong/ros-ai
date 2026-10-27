export type ApprovalMode = 'ask' | 'review' | 'full';
/** Running tallies of project work. They are a record, not a limit. */
export type ResearchUsage = { experiments:number; modelCalls:number; createdActions:number; runtimeSeconds:number; spendUsd:number };
export type ResearchPolicy = { projectId:string; mode:ApprovalMode; overrides:Record<string,ApprovalMode>; used:ResearchUsage; stopped:boolean; revision:number };
export type ReviewDecision = { id:string; at:string; mode:ApprovalMode; outcome:'allow'|'escalate'|'deny'; reason:string; kind:'experiment'|'create-action'|'model'|'canvas-change'|'browser'; nodeId:string; fingerprint:string; policyRevision:number };
export type LocalConnection = { id:string; projectId:string; name:string; kind:'csv'|'output-folder'; path:string; writable:boolean; createdAt:string; updatedAt:string };
export type ProjectResource = { id:string; projectId:string; name:string; storage:'linked'|'copied'|'captured'; kind:'csv'|'source'; createdAt:string; fileName?:string; path?:string; bytes?:number; hash?:string; connectionId?:string; artifactId?:string; nodeId?:string; url?:string; locator?:string; originKey?:string };
export type ResourcePreview = { resource:ProjectResource; content:string; hash:string };
export type Highlight = { id:string; projectId:string; nodeId:string; artifactId:string; x:number; y:number; createdAt:string };
export type ResearchSession = { id:string; projectId:string; nodeId:string; question:string; datasetArtifactId:string; status:'running'|'waiting'|'completed'|'failed'|'stopped'|'interrupted'; phase:'plan'|'experiment'|'inspect'|'proposal'|'done'; step:number; maxSteps:number; runIds:string[]; currentRunId?:string; processedModelRunIds?:string[]; pendingProposalId?:string; pendingAction?:{title:string;description:string;relation:string;request:string}; findings:string[]; suggestions:string[]; events:{at:string;message:string}[]; createdAt:string; updatedAt:string; error?:string; parentSessionId?:string };
