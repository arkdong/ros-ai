import type { AcpAgentId } from './acp-agents.js';
export type NodeKind = 'topic'|'activity'|'unspecified'|'group';
export type BlockType = 'note'|'action'|'dataset'|'figure'|'code'|'notebook'|'report'|'agent'|'search'|'finding'|'notion'|'file'|'google'|'app'|'training'|'web'|'map';
/** A PDF or image shown from the project folder: only its path is saved; the file stays where it is. */
export type FileView = { path:string };
/** One place on a Map block: where it is and what it is. `place` is the address or name it was looked up by, when it was. */
export type MapPin = { id:string; name:string; lat:number; lng:number; note?:string; url?:string; place?:string };
/** A Map block: pins on a map. Only the pins are saved; the map itself comes from OpenStreetMap as it is shown, or,
 * for a Google Maps block (`provider: 'google'`), from Google Maps with the key saved in Plugins. */
export type MapView = { pins:MapPin[]; provider?:'google' };
/** A Notion database or page shown live on the canvas: only where it is (and, for a database, which rows);
 * the content stays in Notion. `kind` is learnt at the first read; an older block without it is a database.
 * `account`: the Notion account the person chose to read it with, when they have several; without it the block
 * reads with the account that can open it. */
export type NotionView = { url:string; filter?:string; columns?:string[]; kind?:'database'|'page'; account?:string };
/** Which of the person's Notion accounts read a block, when they have several: its key and name. */
export type NotionAccount = { key:string; name:string };
/** What a Notion database block shows, read live: the rows are never saved by ros.ai. `titleColumn` names the
 * column that holds each row's title, so one block per row can be made from the rows. */
export type NotionTable = { kind?:'database'; title:string; url:string; link:string|null; columns:string[]; titleColumn?:string|null; rows:Record<string,string>[]; truncated:boolean; fetchedAt:string; notice?:string; account?:NotionAccount };
/** The kinds of property a page can carry, from its database's schema. Those a person can set from ros.ai are
 * `editable`; people, relations, files and values Notion computes are shown only. */
export type NotionPropertyType = 'title'|'text'|'select'|'multi_select'|'checkbox'|'date'|'number'|'people'|'relation'|'files'|'computed';
/** One property of a Notion page as text; `links` are the pages or addresses the value points to; `values` the chosen
 * options of a multi-select; `date` the parts of a date. */
export type NotionProperty = { name:string; value:string; type:NotionPropertyType; editable:boolean; options?:string[]; values?:string[]; date?:{ start:string; end:string }; links?:{ text:string; url:string }[] };
/** One block of a page's text, as Markdown; `source` is Notion's own text for it, one line, which an edit replaces
 * (absent for tables, media and other blocks that stay read only), and `labels` what each mention or date in it reads as. */
export type NotionUnit = { markdown:string; source?:string; labels?:Record<string,string> };
/** What a Notion page block shows, read live: its properties, its content as Markdown (`units` block by block)
 * and where it lives. `titleProperty` names the database column that holds the title. */
export type NotionPage = { kind:'page'; title:string; icon?:string; url:string; link:string|null; properties:NotionProperty[]; titleProperty?:string; content:string; units:NotionUnit[]; parent?:{ title:string; link:string|null; kind:'database'|'page' }; editedAt?:string; fetchedAt:string; notice?:string; account?:NotionAccount };
/** A field's new value; `end` the end of a date range. */
export type NotionFieldValue = { value:string|number|boolean|string[]|null; end?:string|null };
/** The changes a person saves to a page in one go: a new title, fields, lines of text replaced (an empty `new`
 * removes one; several lines make new blocks) and text added at the end. */
export type NotionSave = { title?:string; properties?:({ name:string } & NotionFieldValue)[]; text?:{ old:string; new:string }[]; append?:string };
export type NotionRead = NotionTable | NotionPage;
/** A Google Sheet or Doc shown live on the canvas through the Google Drive sign-in: only which file (and for a
 * sheet, which tab); the content stays in Google Drive. */
export type GoogleView = { fileId:string; kind:'sheet'|'doc'; sheet?:string };
/** What a Sheet block shows, read live: one tab's first rows as Google shows them, under its first row's names. */
export type GoogleSheet = { kind:'sheet'; title:string; fileId:string; link:string; sheet:string; sheets:string[]; columns:string[]; rows:string[][]; truncated:boolean; modifiedAt?:string; fetchedAt:string; notice?:string };
/** What a Doc block shows, read live: its text as Markdown, without images. */
export type GoogleDoc = { kind:'doc'; title:string; fileId:string; link:string; content:string; truncated:boolean; modifiedAt?:string; fetchedAt:string; notice?:string };
export type GoogleRead = GoogleSheet | GoogleDoc;
/** A model training run shown live (training/ros-nemotron): the run's folder on this computer, and optionally the
 * GPU machine it trains on, reached with this computer's own ssh. ros.ai only reads; it starts and stops nothing. */
export type TrainingView = { folder:string; host?:string; remote?:string };
export type TrainingStage = 'data'|'data-ready'|'training'|'trained'|'model';
export type TrainingRead = {
  stage:TrainingStage; running:boolean; fetchedAt:string; notice?:string;
  data:{ tasks:number; run:number; kept:number; seconds:number; families:{ family:string; run:number; kept:number; top?:string }[]; spentUsd:number; train?:number; val?:number; updatedAt?:string };
  training?:{ pilot:boolean; step:number; maxSteps:number; epoch:number; epochs:number; loss:{ step:number; value:number }[]; evalLoss:{ step:number; value:number }[]; seconds:number; usdPerHour:number; finished:boolean; base?:string; rank?:number; targets?:string[]; lr?:number; samples?:number };
  evals:{ label:string; run:number; passed:number }[];
  model?:{ file:string; bytes:number };
};
/** Where a paper on the canvas came from (Add block › Paper, or an agent's add_paper): its source and its ID there
 * (openalex:W…, arxiv:2401.01234v2, zotero:ABCD2345), and its DOI and page. The reference itself is the block's text. */
export type PaperSource = 'openalex'|'arxiv'|'zotero';
export type PaperRef = { source:PaperSource; id:string; doi?:string; link:string };
/** An Agent block stands for one assistant turn run by Claude Code, Codex, a model or an ACP agent; its timeline lives with that turn. */
export type AgentLink = {runtime:'claude'|'codex'|'model'|AcpAgentId; turnId:string};
/** What an agent found when it checked a block's claims on the web: backed or contradicted by a quoted page,
 * no source found, or not judged yet. `textHash` is the block text it checked, so a later edit shows. */
export type ClaimVerdict = 'backed'|'contradicted'|'unsupported'|'open';
export type CheckedClaim = { text:string; verdict:ClaimVerdict; note?:string; quote?:string; source?:{ title:string; url?:string } };
export type SourceCheck = { checkedAt:string; agentNodeId:string; textHash:string; claims:CheckedClaim[] };
/** One direction of a Web block: its searches and named links, why the agent took it, and what the agent wrote from
 * its sources (citing them as [n]). `aside` says why the agent set a weak direction aside. */
export type WebDirection = { id:string; title:string; why:string; queries:string[]; links?:string[]; summary?:string; aside?:string };
/** A question searched on the web in several directions at once. The block keeps the plan and what the agent wrote;
 * the sources are its search snippets and the pages read in full, saved as artifacts of the block's runs. */
export type WebSearch = { question:string; directions:WebDirection[] };
export type CodeDocument = {language:string; source:string; parameters:Record<string,string|number|boolean>; inputArtifactId?:string|null};
/** An App block's page (one HTML document) and the blocks it reads, in order. A file edit or an agent's page never widens
 * `inputs`: adding one is the person's edit, or a proposal they accept. */
export type AppDocument = {source:string; inputs:string[]};
export type NotebookDocument = {sessionId?:string; path:string};
export type GroupHighlight = { nodeId:string; artifactId:string; hash:string };
/** Recorded by the researcher through canvas edits, so Undo removes it. Withdrawing keeps the entry. */
export type Decision = { id:string; text:string; reason:string; at:string; basedOn:{artifactId:string; hash:string}[]; withdrawnAt?:string };
// Missing fields on foundation records mean unspecified kind and project scope.
/** label: what a text block means to the project (question, plan, task, result, finding, decision, draft, report, or the researcher's own word).
 * 'result' marks the note an agent's search direction fills; its searches run on that note. */
export type CanvasNode = { id:string; title:string; description:string; x:number; y:number; width?:number; /** Set when the researcher resized the card's height; null in a change gives the card back to its content. */ height?:number|null; kind?:NodeKind; parentId?:string|null; blockType?:BlockType; label?:string; artifactId?:string; code?:CodeDocument; notebook?:NotebookDocument; groupHighlights?:GroupHighlight[]; agent?:AgentLink; app?:AppDocument; check?:SourceCheck; web?:WebSearch; notion?:NotionView; google?:GoogleView; training?:TrainingView; file?:FileView; map?:MapView; paper?:PaperRef; legacyKind?:Exclude<NodeKind,'group'>; decisions?:Decision[] };
export type Connection = { id:string; source:string; target:string; label:string; sourceHandle?:'top'|'right'|'bottom'|'left'; targetHandle?:'top'|'right'|'bottom'|'left' };
export type Canvas = { nodes:CanvasNode[]; connections:Connection[] };
export type Project = { id:string; title:string; revision:number; canvas:Canvas; createdAt:string; updatedAt:string };
export type Mutation =
 | {type:'addNode'; node:CanvasNode}
 | {type:'updateNode'; id:string; patch:Partial<Omit<CanvasNode,'id'>>}
 | {type:'removeNode'; id:string}
 | {type:'addConnection'; connection:Connection}
 | {type:'removeConnection'; id:string}
 /** A link's word, or its direction: the person's edit on the canvas; agents add and remove links only. */
 | {type:'updateConnection'; id:string; patch:Partial<Omit<Connection,'id'>>};
/** threadId: the ROS thread a project message (nodeId null) belongs to; block conversations have none. */
export type Message = {id:string; projectId:string; nodeId:string|null; role:'user'|'assistant'|'system'; content:string; createdAt:string; runId?:string; threadId?:string};
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
