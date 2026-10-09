export type NodeKind = 'topic'|'activity'|'unspecified'|'group';
export type BlockType = 'note'|'action'|'dataset'|'figure'|'code'|'notebook'|'report'|'agent'|'search'|'finding';
/** An Agent block stands for one assistant turn run by Claude Code or Codex; its timeline lives with that turn. */
export type AgentLink = {runtime:'claude'|'codex'; turnId:string};
export type CodeDocument = {language:string; source:string; parameters:Record<string,string|number|boolean>; inputArtifactId?:string|null};
export type NotebookDocument = {sessionId?:string; path:string};
export type GroupHighlight = { nodeId:string; artifactId:string; hash:string };
/** Recorded by the researcher through canvas edits, so Undo removes it. Withdrawing keeps the entry. */
export type Decision = { id:string; text:string; reason:string; at:string; basedOn:{artifactId:string; hash:string}[]; withdrawnAt?:string };
// Missing fields on foundation records mean unspecified kind and project scope.
export type CanvasNode = { id:string; title:string; description:string; x:number; y:number; width?:number; kind?:NodeKind; parentId?:string|null; blockType?:BlockType; artifactId?:string; code?:CodeDocument; notebook?:NotebookDocument; groupHighlights?:GroupHighlight[]; agent?:AgentLink; legacyKind?:Exclude<NodeKind,'group'>; decisions?:Decision[] };
export type Connection = { id:string; source:string; target:string; label:string; sourceHandle?:'top'|'right'|'bottom'|'left'; targetHandle?:'top'|'right'|'bottom'|'left' };
export type Canvas = { nodes:CanvasNode[]; connections:Connection[] };
export type Project = { id:string; title:string; revision:number; canvas:Canvas; createdAt:string; updatedAt:string };
export type Mutation =
 | {type:'addNode'; node:CanvasNode}
 | {type:'updateNode'; id:string; patch:Partial<Omit<CanvasNode,'id'>>}
 | {type:'removeNode'; id:string}
 | {type:'addConnection'; connection:Connection}
 | {type:'removeConnection'; id:string};
export type Message = {id:string; projectId:string; nodeId:string|null; role:'user'|'assistant'|'system'; content:string; createdAt:string; runId?:string};
export type Proposal = {id:string; projectId:string; baseRevision:number; summary:string; operations:Mutation[]; status:'pending'|'accepted'|'dismissed'; createdAt:string};
export type Change = {id:string; projectId:string; revision:number; label:string; canvas:Canvas; createdAt:string};
export type Artifact = {id:string; projectId:string; nodeId:string; runId:string; kind:'result'|'source'|'dataset'|'code'|'table'|'metric'|'plot'|'log'|'notebook'; title:string; content:string; hash:string; createdAt:string; url?:string; locator?:string; capture?:'search-snippet'|'full-content'|'generated'|'external'; sourceId?:string; mediaType?:string; metadata?:Record<string,unknown>};
export type SelectedInput = {id:string; projectId:string; nodeId:string; artifactId:string; excerpt:string; createdAt:string};
export type RunStatus = 'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted';
export type ModelMessage = {role:'system'|'user'|'assistant'; content:string};
export type RunEvent = {at:string; type:string; message:string; data?:unknown};
export type Run = {id:string; projectId:string; nodeId:string; request:string; useSearch:boolean; status:RunStatus; retryOf?:string; createdAt:string; startedAt?:string; endedAt?:string; projectRevision:number; node:CanvasNode; inputs:(SelectedInput & {artifact:Artifact})[]; messages:ModelMessage[]; provider:string; model:string; modelVersion:string|null; configuration:Record<string,unknown>; tools:unknown[]; events:RunEvent[]; artifactIds:string[]; error?:string; usage?:unknown; cost?:unknown};
export type UsageRecord = {id:string; provider:string; purpose:string; runId?:string; reservedUsd:number; estimatedUsd:number|null; reportedUsage:unknown; status:'reserved'|'settled'|'uncertain'; basis:string; createdAt:string};
export type ProjectDetail = {project:Project; messages:Message[]; proposals:Proposal[]; changes:Change[]; runs:Run[]; artifacts:Artifact[]; inputs:SelectedInput[]; canUndo:boolean; canRedo:boolean; highlights?:import('./research.js').Highlight[]; notebooks?:import('./notebooks.js').NotebookSummary[]};
export type ConnectionStatus = {provider:string; configured:boolean; model?:string; detail:string; limitUsd:number; accountedUsd:number};
