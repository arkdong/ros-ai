import type { AgentStep } from './agent-runtime.js';
import type { Message } from './types.js';
import type { AssistantStructurePreview } from './assistant-presentation.js';
import type { AssistantClarificationQuestion } from './assistant-clarifications.js';
import type { MemoryKind, PersonalMemoryState } from './personal-memory.js';
import type { AcpAgentId } from './acp-agents.js';
import type { PluginMatch } from './plugin-hints.js';

/** 'agent' runs the selected model in ros.ai's own tool loop; gemini, goose and opencode are agents on
 * this computer that speak ACP (acp-agents.ts). */
export type AssistantBackend = 'provider'|'codex'|'claude'|'agent'|AcpAgentId;
export type AssistantFocus = {nodeId:string|null;artifactId?:string|null};
export type AssistantReference = {kind:'node'|'artifact'|'run'|'proposal'|'message';id:string;label:string;nodeId?:string};
export type AssistantMemoryEntry = {id:string;text:string;at:string;kind:'decision'|'finding'|'hypothesis'|'gap';references:AssistantReference[];status:'recorded'|'observed'|'proposed'|'unverified'};
export type ResearchMemory = {originalQuestion:string|null;questionHistory:{id:string;text:string;at:string}[];decisions:AssistantMemoryEntry[];findings:AssistantMemoryEntry[];hypotheses:AssistantMemoryEntry[];gaps:AssistantMemoryEntry[]};
export type OutlineEntry = {id:string;title:string;summary:string;kind:'question'|'direction'|'decision'|'finding'|'hypothesis'|'gap';references:AssistantReference[];nodeId?:string;status?:string};
export type AssistantAction = {id:string;type:'proposal'|'experiment'|'research'|'reuse'|'search';title:string;status:'pending'|'running'|'completed'|'failed'|'cancelled';nodeId?:string;targetNodeId?:string;artifactId?:string;runId?:string;proposalId?:string;reportProposalId?:string;error?:string};
export type AssistantTurn = {id:string;projectId:string;createdAt:string;updatedAt:string;focus:AssistantFocus;userMessage:string;reply:string;question?:string|null;clarifications?:AssistantClarificationQuestion[];structure?:AssistantStructurePreview;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';source:'model'|'local-records'|'codex-agent'|'claude-agent'|'model-agent'|'outside-agent'|'acp-agent';references:AssistantReference[];actions:AssistantAction[];events:{at:string;message:string;kind?:'thought'|'tool';step?:AgentStep}[];remembered?:{id:string;kind:MemoryKind;text:string}[];suggested?:TurnSuggestion;error?:string;warning?:string;model?:string;destination?:string;location?:'local-unverified'|'external'|'local-verified'};
/** Plugins the request needed and the person had not connected, noticed by ros.ai in the message (a link or a name).
 * One card under the reply, open until the person carries on after connecting (done), puts it off (later) or declines
 * every plugin on it (never), or until a newer request that needs the same plugin takes the card over (moved). */
export type TurnSuggestion = {by:'ros.ai';plugins:PluginMatch[];status:'open'|'later'|'never'|'done'|'moved'};
/** One running turn as it changes, pushed to the app so a reply streams in instead of arriving with the next refresh. */
export type AssistantLive = {turnId:string;reply:string;status:AssistantTurn['status'];step?:string};
export type AssistantState = {projectId:string;focus:AssistantFocus;memory:ResearchMemory;outline:OutlineEntry[];turns:AssistantTurn[];messages:Message[];activeTurnId:string|null;person?:PersonalMemoryState;modelAvailable:boolean;searchAvailable:boolean;backend?:AssistantBackend;modelBlocker?:string|null};
