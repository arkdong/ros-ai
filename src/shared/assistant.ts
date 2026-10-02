import type { Message } from './types.js';
import type { AssistantStructurePreview } from './assistant-presentation.js';
import type { AssistantClarificationQuestion } from './assistant-clarifications.js';

export type AssistantFocus = {nodeId:string|null;artifactId?:string|null};
export type AssistantReference = {kind:'node'|'artifact'|'run'|'proposal'|'message';id:string;label:string;nodeId?:string};
export type AssistantMemoryEntry = {id:string;text:string;at:string;kind:'decision'|'finding'|'hypothesis'|'gap';references:AssistantReference[];status:'recorded'|'observed'|'proposed'|'unverified'};
export type ResearchMemory = {originalQuestion:string|null;questionHistory:{id:string;text:string;at:string}[];decisions:AssistantMemoryEntry[];findings:AssistantMemoryEntry[];hypotheses:AssistantMemoryEntry[];gaps:AssistantMemoryEntry[]};
export type OutlineEntry = {id:string;title:string;summary:string;kind:'question'|'direction'|'decision'|'finding'|'hypothesis'|'gap';references:AssistantReference[];nodeId?:string;status?:string};
export type AssistantAction = {id:string;type:'proposal'|'experiment'|'research'|'reuse'|'search';title:string;status:'pending'|'running'|'completed'|'failed'|'cancelled';nodeId?:string;targetNodeId?:string;artifactId?:string;runId?:string;proposalId?:string;reportProposalId?:string;error?:string};
export type AssistantTurn = {id:string;projectId:string;createdAt:string;updatedAt:string;focus:AssistantFocus;userMessage:string;reply:string;question?:string|null;clarifications?:AssistantClarificationQuestion[];structure?:AssistantStructurePreview;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';source:'model'|'local-records'|'codex-agent';references:AssistantReference[];actions:AssistantAction[];events:{at:string;message:string}[];error?:string;warning?:string;model?:string;destination?:string;location?:'local-unverified'|'external'|'local-verified'};
export type AssistantState = {projectId:string;focus:AssistantFocus;memory:ResearchMemory;outline:OutlineEntry[];turns:AssistantTurn[];messages:Message[];activeTurnId:string|null;modelAvailable:boolean;searchAvailable:boolean;backend?:'provider'|'codex';modelBlocker?:string|null};
