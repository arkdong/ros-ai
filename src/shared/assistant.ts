import type { AgentStep } from './agent-runtime.js';
import type { Message } from './types.js';
import type { AssistantStructurePreview } from './assistant-presentation.js';
import type { AssistantClarificationQuestion } from './assistant-clarifications.js';
import type { MemoryKind, PersonalMemoryState } from './personal-memory.js';
import type { AcpAgentId } from './acp-agents.js';
import type { PluginMatch } from './plugin-hints.js';
import type { TurnLayer } from './ros-layer.js';
import type { ModelSelection } from './model-settings.js';
import type { EffortLevel } from './agent-models.js';

/** 'agent' runs the selected model in ros.ai's own tool loop; gemini, goose and opencode are agents on
 * this computer that speak ACP (acp-agents.ts). Claude Code and Codex are two agents each (IN_APP_AGENTS). */
export type AssistantBackend = 'provider'|'codex'|'codex-key'|'claude'|'claude-plan'|'agent'|AcpAgentId;
/** Claude Code and Codex inside ros.ai, one agent for each way of paying: the person's subscription, through the
 * agent's own sign-in, or an API key from the Agents page. 'claude' and 'codex' keep the ids they had before.
 * On the subscription each keeps its plain name, as in its own app; on a key the name says so. */
export const IN_APP_AGENTS = {
  'claude-plan': {agent:'claude',billing:'plan',label:'Claude Code'},
  claude: {agent:'claude',billing:'api-key',label:'Claude Code (API key)'},
  codex: {agent:'codex',billing:'plan',label:'Codex'},
  'codex-key': {agent:'codex',billing:'api-key',label:'Codex (API key)'},
} as const;
export type InAppAgent = keyof typeof IN_APP_AGENTS;
export const inAppAgent = (backend?:AssistantBackend) => backend&&backend in IN_APP_AGENTS?IN_APP_AGENTS[backend as InAppAgent]:undefined;
/** A block (and saved version) a request is about on purpose, such as Check sources on a block: it arrives in full and the tools start
 * from it. A message typed in the bar has none; where the person was on the map comes with it as a glance instead. */
export type AssistantFocus = {nodeId:string|null;artifactId?:string|null};
/** Where the person was on the map when they sent a message, made by the app at Send and sent quietly with it, never shown.
 * open: the block, or a saved version of it, open in its view. clicked: the blocks selected on the map, with when that selection was made.
 * lookedAt: blocks clicked or opened before, newest first. onScreen: the blocks inside the visible part of the map, nearest the middle
 * first, or 'all' when the whole map is in view. ROS reads it as a weak hint for words like "this" or "here"; it never limits or picks
 * what ROS works on (glance.ts on the server). */
export type AssistantGlance = {open?:{nodeId:string;artifactId?:string|null}|null;clicked?:{nodeId:string;at:string}[];lookedAt?:{nodeId:string;at:string}[];onScreen?:string[]|'all'};
export type AssistantReference = {kind:'node'|'artifact'|'run'|'proposal'|'message';id:string;label:string;nodeId?:string};
export type AssistantMemoryEntry = {id:string;text:string;at:string;kind:'decision'|'finding'|'hypothesis'|'gap';references:AssistantReference[];status:'recorded'|'observed'|'proposed'|'unverified'};
export type ResearchMemory = {originalQuestion:string|null;questionHistory:{id:string;text:string;at:string}[];decisions:AssistantMemoryEntry[];findings:AssistantMemoryEntry[];hypotheses:AssistantMemoryEntry[];gaps:AssistantMemoryEntry[]};
export type OutlineEntry = {id:string;title:string;summary:string;kind:'question'|'direction'|'decision'|'finding'|'hypothesis'|'gap';references:AssistantReference[];nodeId?:string;status?:string};
/** by: 'ros' when ROS made the change on top of the agent's turn (ros-layer.ts); undone: the person took it back. */
export type AssistantAction = {id:string;type:'proposal'|'experiment'|'research'|'reuse'|'search';title:string;status:'pending'|'running'|'completed'|'failed'|'cancelled';nodeId?:string;targetNodeId?:string;artifactId?:string;runId?:string;proposalId?:string;reportProposalId?:string;error?:string;by?:'ros';undone?:boolean};
export type AssistantTurn = {id:string;projectId:string;/** The thread the turn belongs to; turns from before threads are stamped with the project's first thread when it is read. */threadId?:string;createdAt:string;updatedAt:string;focus:AssistantFocus;userMessage:string;reply:string;question?:string|null;clarifications?:AssistantClarificationQuestion[];structure?:AssistantStructurePreview;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';source:'model'|'local-records'|'codex-agent'|'claude-agent'|'model-agent'|'outside-agent'|'acp-agent';references:AssistantReference[];actions:AssistantAction[];events:{at:string;message:string;kind?:'thought'|'tool';step?:AgentStep}[];remembered?:{id:string;kind:MemoryKind;text:string}[];suggested?:TurnSuggestion;/** ROS arranging what the turn left (ros-layer.ts). */layer?:TurnLayer;error?:string;warning?:string;model?:string;destination?:string;location?:'local-unverified'|'external'|'local-verified'};
/** Plugins the request needed and the person had not connected, noticed by ros.ai in the message (a link or a name).
 * One card under the reply, open until the person carries on after connecting (done), puts it off (later) or declines
 * every plugin on it (never), or until a newer request that needs the same plugin takes the card over (moved). */
export type TurnSuggestion = {by:'ros.ai';plugins:PluginMatch[];status:'open'|'later'|'never'|'done'|'moved'};
/** One running turn as it changes, pushed to the app so a reply streams in instead of arriving with the next refresh. */
export type AssistantLive = {turnId:string;threadId?:string;reply:string;status:AssistantTurn['status'];step?:string};
/** One conversation with ROS inside a project. A project holds many; each keeps its own history, agent session, running turn
 * and draft, while the map, its proposals, the approval mode and what ROS runs with are the project's. outsideSession: the
 * thread of the person's own agent connected over MCP, one per session, named after the agent. */
export type AssistantThread = {id:string;projectId:string;title:string;createdAt:string;updatedAt:string;outsideSession?:string;choice?:ThreadChoice};
/** What a thread last ran with: the agent or way (backend), the project model, and for Claude Code or Codex the model and effort
 * the agent ran on. Opening the thread again puts this choice back in the ROS bar, so the thread goes on as it was. */
export type ThreadChoice = {backend:AssistantBackend;model?:ModelSelection;agentModel?:{model:string;effort:EffortLevel|null}};
/** A thread as the bar and the panel list it: its name and its state in one line. updatedAt moves with its turns. */
export type AssistantThreadSummary = {id:string;title:string;createdAt:string;updatedAt:string;running:boolean;step?:string;waiting:number;last?:{turnId:string;status:AssistantTurn['status'];at:string};outside?:boolean;choice?:ThreadChoice};
/** threads: newest activity first. activeTurnId: a running turn in any thread. threadId: set on the state a new message
 * returns, naming the thread it went into (a new one when the message named none). */
export type AssistantState = {projectId:string;memory:ResearchMemory;outline:OutlineEntry[];turns:AssistantTurn[];threads:AssistantThreadSummary[];threadId?:string;messages:Message[];activeTurnId:string|null;person?:PersonalMemoryState;modelAvailable:boolean;searchAvailable:boolean;backend?:AssistantBackend;modelBlocker?:string|null};
