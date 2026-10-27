import type { AcpAgentId } from './acp-agents.js';
export type NodeKind = 'topic'|'activity'|'unspecified'|'group';
export type BlockType = 'note'|'action'|'dataset'|'figure'|'code'|'notebook'|'report'|'agent'|'search'|'finding'|'notion'|'file'|'google';
/** A PDF or image shown from the project folder: only its path is saved; the file stays where it is. */
export type FileView = { path:string };
/** A Notion database or page shown live on the canvas: only where it is (and, for a database, which rows);
 * the content stays in Notion. `kind` is learnt at the first read; an older block without it is a database. */
export type NotionView = { url:string; filter?:string; columns?:string[]; kind?:'database'|'page' };
/** What a Notion database block shows, read live: the rows are never saved by ros.ai. `titleColumn` names the
 * column that holds each row's title, so one block per row can be made from the rows. */
export type NotionTable = { kind?:'database'; title:string; url:string; link:string|null; columns:string[]; titleColumn?:string|null; rows:Record<string,string>[]; truncated:boolean; fetchedAt:string; notice?:string };
/** The kinds of property a page can carry, from its database's schema. Those a person can set from ros.ai are
 * `editable`; people, relations, files and values Notion computes are shown only. */
export type NotionPropertyType = 'title'|'text'|'select'|'multi_select'|'checkbox'|'date'|'number'|'people'|'relation'|'files'|'computed';
/** One property of a Notion page as text; `links` are the pages or addresses the value points to; `values` the chosen
 * options of a multi-select; `date` the parts of a date. */
export type NotionProperty = { name:string; value:string; type:NotionPropertyType; editable:boolean; options?:string[]; values?:string[]; date?:{ start:string; end:string }; links?:{ text:string; url:string }[] };
/** One block of a page's text, as Markdown; `source` is Notion's own text for it, which an edit replaces (absent
 * for tables, media and other blocks that stay read only), and `text` the words a person edits (no list marks). */
export type NotionUnit = { markdown:string; text?:string; source?:string };
/** What a Notion page block shows, read live: its properties, its content as Markdown (`units` block by block)
 * and where it lives. `titleProperty` names the database column that holds the title. */
export type NotionPage = { kind:'page'; title:string; icon?:string; url:string; link:string|null; properties:NotionProperty[]; titleProperty?:string; content:string; units:NotionUnit[]; parent?:{ title:string; link:string|null; kind:'database'|'page' }; editedAt?:string; fetchedAt:string; notice?:string };
/** A change a person makes to a page from ros.ai, saved straight to Notion. */
export type NotionEdit =
  | { kind:'title'; title:string }
  | { kind:'property'; name:string; value:string|number|boolean|string[]|null; end?:string|null }
  | { kind:'text'; old:string; new:string }
  | { kind:'append'; text:string };
export type NotionRead = NotionTable | NotionPage;
/** A Google Sheet or Doc shown live on the canvas through the Google Drive sign-in: only which file (and for a
 * sheet, which tab); the content stays in Google Drive. */
export type GoogleView = { fileId:string; kind:'sheet'|'doc'; sheet?:string };
/** What a Sheet block shows, read live: one tab's first rows as Google shows them, under its first row's names. */
export type GoogleSheet = { kind:'sheet'; title:string; fileId:string; link:string; sheet:string; sheets:string[]; columns:string[]; rows:string[][]; truncated:boolean; modifiedAt?:string; fetchedAt:string; notice?:string };
/** What a Doc block shows, read live: its text as Markdown, without images. */
export type GoogleDoc = { kind:'doc'; title:string; fileId:string; link:string; content:string; truncated:boolean; modifiedAt?:string; fetchedAt:string; notice?:string };
export type GoogleRead = GoogleSheet | GoogleDoc;
/** Where a paper on the canvas came from (Add block › Paper, or an agent's add_paper): its source and its ID there
 * (openalex:W…, arxiv:2401.01234v2, zotero:ABCD2345), and its DOI and page. The reference itself is the block's text. */
export type PaperSource = 'openalex'|'arxiv'|'zotero';
export type PaperRef = { source:PaperSource; id:string; doi?:string; link:string };
/** An Agent block stands for one assistant turn run by Claude Code, Codex, a model or an ACP agent; its timeline lives with that turn. */
export type AgentLink = {runtime:'claude'|'codex'|'model'|AcpAgentId; turnId:string};
export type CodeDocument = {language:string; source:string; parameters:Record<string,string|number|boolean>; inputArtifactId?:string|null};
export type NotebookDocument = {sessionId?:string; path:string};
export type GroupHighlight = { nodeId:string; artifactId:string; hash:string };
/** Recorded by the researcher through canvas edits, so Undo removes it. Withdrawing keeps the entry. */
export type Decision = { id:string; text:string; reason:string; at:string; basedOn:{artifactId:string; hash:string}[]; withdrawnAt?:string };
// Missing fields on foundation records mean unspecified kind and project scope.
/** label: what a text block means to the project (question, plan, task, result, finding, decision, draft, report, or the researcher's own word).
 * 'result' marks the note an agent's search direction fills; its searches run on that note. */
export type CanvasNode = { id:string; title:string; description:string; x:number; y:number; width?:number; /** Set when the researcher resized the card's height; null in a change gives the card back to its content. */ height?:number|null; kind?:NodeKind; parentId?:string|null; blockType?:BlockType; label?:string; artifactId?:string; code?:CodeDocument; notebook?:NotebookDocument; groupHighlights?:GroupHighlight[]; agent?:AgentLink; notion?:NotionView; google?:GoogleView; file?:FileView; paper?:PaperRef; legacyKind?:Exclude<NodeKind,'group'>; decisions?:Decision[] };
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
/** after: proposals this one builds on, accepted before it and dismissed with it. batch: proposals made together (an
 * agent turn); accepting one moves the others still pending onto the new canvas revision. */
export type Proposal = {id:string; projectId:string; baseRevision:number; summary:string; operations:Mutation[]; status:'pending'|'accepted'|'dismissed'; createdAt:string; after?:string[]; batch?:string};
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
