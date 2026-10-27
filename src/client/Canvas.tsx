import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Background, BackgroundVariant, BaseEdge, ConnectionMode, EdgeLabelRenderer, Handle, MarkerType, NodeToolbar, Position, ReactFlow, ReactFlowProvider, SelectionMode, applyNodeChanges, useReactFlow, useStoreApi, type Edge, type EdgeProps, type Node, type NodePositionChange, type NodeProps, type ReactFlowProps, type Viewport, type XYPosition } from '@xyflow/react';
import { AppWindow, ArrowUpRight, BookOpen, Bot, Check, Quote, Search as SearchIcon, BoxSelect, Braces, Database, Text as TextIcon, File as FileIcon, NotebookPen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CornerLeftUp, Focus, GitBranch, History, LayoutGrid, LoaderCircle, Maximize, Minus, PanelTopClose, Pencil, Pin, Play, Plus, Redo2, Settings2, Trash2, Undo2, Ungroup, X } from 'lucide-react';
import { BrandLogo } from './brand-logos';
import { NotionBlock, type RowBlocksOutcome } from './NotionView';
import { GoogleBlock } from './GoogleView';
import { TrainingBlock } from './TrainingView';
import { rowBlockOperations } from '../shared/notion-rows';
import { ArtifactContent } from './Experiment';
import { MarkdownPreview } from './Content';
import { agentDirections, RESULT_PLACEHOLDER, splitSources } from '../shared/agent-work';
import { TEXT_LABELS, blockOrigin, kindName, labelFixed, labelPatch, textLabel } from '../shared/vocabulary';
import { api } from './api';
import type { ExperimentCapabilities } from '../shared/experiments';
import { deriveGroupOutcomes, type CardOutcome, type CardOutcomeOptions } from '../shared/card-outcome';
import { resolveModelSetting, type ModelSettingsResponse } from '../shared/model-settings';
import { CARD_MAX_HEIGHT, CARD_MAX_SET_HEIGHT, CARD_MIN_HEIGHT, CARD_MIN_WIDTH, CARD_MAX_WIDTH, cardWidth, initialCardSize, setCardHeight } from '../shared/card-size';
import { layoutOnly, savedCanvasPosition } from '../shared/canvas-position';
import { createCanvasReflowPlan, extendCanvasReflowPlan, reflowCanvas, type CanvasReflowPlan } from '../shared/canvas-reflow';
import { resultPage, changeResultPageSize, type ResultPageChoice } from '../shared/result-pages';
import { aggregateTopLevelRelationships, relationshipBadgeText, type AggregateRelationship } from '../shared/aggregate-relationships';
import { routeRelationship, type RelationshipRoute, type RouteNode } from '../shared/routing';
import { relationshipLabelSize } from '../shared/relationship-label';
import { readSaved, saveLocal } from './persistence';
import { arrangeCanvas, numberedStageOrder, CARD_SIZE, GROUP_FOOTER, GROUP_INSET, LAYOUT_GAP, type CanvasSize } from '../shared/layout';
import type { Artifact, Canvas, CanvasNode, GoogleView, TrainingView, Mutation, NotionTable, NotionView, ProjectDetail, Proposal, RunStatus } from '../shared/types';
import type { NotebookSummary } from '../shared/notebooks';
import { textPreview } from '../shared/presentation';
import './canvas-interactions.css';
import './canvas-reading.css';
import './canvas-evidence.css';
import './groups.css';
import './aggregate-relationships.css';
import './agent-view.css';
import { GROUP_PREVIEW_MEMBERS, convertLegacyGroups, createGroupOperations, groupMembers, groupPreviewMembers, isGroup, ungroupOperations } from '../shared/groups';
import { isOutputArtifact, nodeBlockType, primaryArtifact } from '../shared/blocks';
import { BlockPreview } from './BlockPreview';
import { AppFrame } from './AppFrame';
import { appFlags, appVersion, type AppFlag } from '../shared/apps';
import { FilePreview, type ShownFile } from './FileView';
import { fileMediaType, fileUrl } from '../shared/files';
import type { FolderFile } from '../shared/project-folders';
import { BLOCKS_MIME, copyBlocks, pasteOperations, readCopiedBlocks } from '../shared/canvas-clipboard';
import { CodeView, modKey } from './code';
import { CanvasDock } from './CanvasDock';
import { CanvasMinimap } from './CanvasMinimap';
import { CanvasToolSwitch, useCanvasTool } from './CanvasTool';

function notebookCard(detail: ProjectDetail, nodeId: string): Pick<CardData, 'notebook' | 'notebookFigure'> {
  const notebook = detail.notebooks?.find(item => item.nodeId === nodeId);
  if (!notebook) return {};
  return { notebook, ...(notebook.figure ? { notebookFigure: `/api/projects/${encodeURIComponent(detail.project.id)}/nodes/${encodeURIComponent(nodeId)}/notebook/figure?h=${notebook.figure}` } : {}) };
}
/** The address, type and size of the file a File block shows; the address carries the file's version so a replaced file is read again. */
export function shownFile(projectId: string, node: CanvasNode, entry?: FolderFile): ShownFile {
  return { src: `${fileUrl(projectId, node.id)}${entry?.version ? `?v=${entry.version}` : ''}`, mediaType: fileMediaType(node.file?.path ?? '') ?? 'application/octet-stream', ...(entry?.bytes ? { bytes: entry.bytes } : {}) };
}
/** One icon per kind of block; a Text block's label says what it means. A Google block shows its app's mark. */
export function KindIcon({ kind, blockType, google, size = 14 }: { kind?: string; blockType?: string; google?: GoogleView['kind']; size?: number }) {
  if (blockType === 'notion') return <BrandLogo id="notion" size={size}/>;
  if (blockType === 'training') return <BrandLogo id="nebius" size={size}/>;
  if (blockType === 'google') return <BrandLogo id={google === 'sheet' ? 'google-sheets' : google === 'doc' ? 'google-docs' : 'google-drive'} size={size}/>;
  const Icon = kind === 'group' ? LayoutGrid : blockType === 'code' ? Braces : blockType === 'app' ? AppWindow : blockType === 'notebook' ? NotebookPen : blockType === 'dataset' ? Database : blockType === 'figure' || blockType === 'file' ? FileIcon : blockType === 'agent' ? Bot : blockType === 'search' ? SearchIcon : TextIcon;
  return <Icon size={size}/>;
}
type Side = 'top' | 'right' | 'bottom' | 'left';
const sides: { id: Side; position: Position }[] = [{ id: 'top', position: Position.Top }, { id: 'right', position: Position.Right }, { id: 'bottom', position: Position.Bottom }, { id: 'left', position: Position.Left }];
const ARTIFACT_SIZE = { width: 360, height: 300 };
type CardData = {
  kind?: string; title: string; description: string; status?: RunStatus; awaitingApproval?: boolean;
  workLabel?: string; blockType?: string; primary?: Artifact; members: number;
  /** What the block is on screen (Text, Code, Data…), the label a Text block carries, and the agent that made it. */
  kindName: string; textLabel?: string; origin?: string;
  /** Opens the label menu of a Text block whose label may change. */
  onLabel?: (anchor: DOMRect) => void;
  /** A Notion database or page the card reads live; `onRows` makes one page block per row of a database. */
  notion?: { projectId: string; view: NotionView; onRows?: (table: NotionTable) => Promise<RowBlocksOutcome | null> };
  /** A Google Sheet or Doc the card reads live; `onCopy` copies a sheet's tab into a new Data block. */
  google?: { projectId: string; view: GoogleView; onCopy?: () => Promise<boolean> };
  /** A model training run the card reads live from its folder and GPU machine. */
  training?: { projectId: string; view: TrainingView };
  /** The PDF or image a File block shows, read from the project folder. */
  file?: ShownFile;
  /** The blocks a collapsed Group lists on its card. */
  listed?: { id: string; title: string; kind?: string; blockType?: string; google?: GoogleView['kind'] }[];
  /** A Code block's source, shown on the card. */
  code?: string;
  /** An App block's page, running on the card: `proposalId` while a proposal previews it, `still` instead of the page
   * on a saved canvas from the past; `leaves` are lines a preview flags for trying to leave the frame. */
  app?: { projectId: string; version: string; inputs: number; proposalId?: string; still?: string; watchKey: string; leaves?: AppFlag[]; onFocus: (blockId: string) => void };
  /** A Notebook block's cells and last run; `notebookFigure` is the address of its newest figure. */
  notebook?: NotebookSummary; notebookFigure?: string; chosen: Artifact[]; origins:Record<string,string>; onHighlightOpen: (artifact: Artifact) => void;
  inputCount: number; resultCount: number; expanded: boolean; preview?: 'added' | 'changed' | 'removed';
  onExpand: () => void; onInspect: () => void; onActivate: () => void; onAdd: () => void; onHandle: (side: Side) => void;
  onSave: (title: string, description: string) => Promise<unknown>; readonly: boolean;
  outcome: CardOutcome; width: number; height: number; heightSet: boolean; resizePending: boolean;
  modelLabel?: string; modelTitle?: string; fileMissing?: boolean;
  results?: ResultPageChoice & { pageCount: number; total: number; start: number };
  onResultChoice: (choice: ResultPageChoice) => void;
  onResize: (size: CardResize | null, commit?: boolean) => void; onAutoHeight: () => void; onMeasure: (width: number, height: number) => void;
  /** An Agent block's turn, when the assistant still has it. */
  agent?: AgentTurnSummary;
  /** The label a text block carries; result marks the note an agent's search direction fills. */
  label?: string;
  /** A Result note's saved search sources (a Search block's on canvases from before 20 October 2026), newest search first. */
  sources?: Artifact[];
  /** Why the agent searched in this direction, from its link to the note. */
  why?: string;
  /** The searches run on a Result note, newest first. */
  queries?: string[];
  /** An Agent block's searches so far, the pages it read and the findings it saved. */
  directions?: { total: number; written: number; sources: number; pages: number; findings: number };
};
export type AgentTurnSummary = { status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; runtime: string; thought?: string; pending: number };
const agentState = { running: 'Working', completed: 'Finished', failed: 'Stopped with an error', cancelled: 'Stopped', interrupted: 'Interrupted' } as const;
/** The quiet last line of a card: which agent made the block and what it rests on (sources, results, the saved version). */
function Provenance({data,appErrors}:{data:CardData;appErrors?:string[]}){
  const parts:ReactNode[]=[];
  if(data.origin)parts.push(<small key="origin">{data.origin}</small>);
  if(data.app){
    parts.push(<small key="reads">{data.app.inputs?`reads ${data.app.inputs} block${data.app.inputs===1?'':'s'}`:'reads no blocks'}</small>);
    if(appErrors?.length)parts.push(<small key="errors" className="app-error" title={appErrors.join('\n')}>{appErrors.length} error{appErrors.length===1?'':'s'}</small>);
    parts.push(<small key="version" className="block-version">Version {data.app.version}</small>);
    return <div className="outcome-footer provenance">{parts}</div>;
  }
  const searching=data.blockType==='search'||(data.label==='result'&&data.description===RESULT_PLACEHOLDER);
  if(searching){if(data.sources?.length)parts.push(<small key="found">{data.sources.length} source{data.sources.length===1?'':'s'} found</small>);}
  else if(!data.primary&&data.blockType!=='agent'){const {sources,hosts}=splitSources(data.description);if(sources>0)parts.push(<small key="cited">{data.blockType==='finding'&&hosts.length?`From ${hosts.join(', ')}`:`${sources} source${sources===1?'':'s'} cited`}</small>);}
  if(data.resultCount>0)parts.push(<small key="results">{data.resultCount} result{data.resultCount===1?'':'s'}</small>);
  if(data.primary)parts.push(<small key="version" className="block-version">{['failed','interrupted','cancelled','queued','running'].includes(data.status??'')?'Earlier saved result · ':'Version · '}{data.primary.hash.slice(0,8)}</small>);
  return parts.length?<div className="outcome-footer provenance">{parts}</div>:null;
}
type ResearchNode = Node<CardData, 'research'>;
/** A card being resized: its new size, and how far its top left corner moved when it was pulled from the left or top. */
export type CardResize = { width: number; height?: number; dx: number; dy: number };
/** The edges and corners a card is resized from. A closed Group fits what it lists, so only its sides move. */
const RESIZE_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
type ResizeEdge = typeof RESIZE_EDGES[number];
const GROUP_RESIZE_EDGES: readonly ResizeEdge[] = ['e', 'w'];
const RESIZE_GRID = 24;
/** The card's size while one of its edges or corners is dragged. Pulled from the left or top, the opposite edge stays
 * put and the move keeps to the canvas grid, as every saved position does. */
function resizedCard(edge: ResizeEdge, start: { width: number; height: number }, dx: number, dy: number): CardResize {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));
  let width = start.width, height: number | undefined, moveX = 0, moveY = 0;
  if (edge.includes('e')) width = clamp(start.width + dx, CARD_MIN_WIDTH, CARD_MAX_WIDTH);
  if (edge.includes('w')) {
    moveX = Math.max(start.width - CARD_MAX_WIDTH, Math.min(start.width - CARD_MIN_WIDTH, Math.round(dx / RESIZE_GRID) * RESIZE_GRID)); width = start.width - moveX;
  }
  if (edge.includes('s')) height = clamp(start.height + dy, CARD_MIN_HEIGHT, CARD_MAX_SET_HEIGHT);
  if (edge.startsWith('n')) {
    moveY = Math.max(start.height - CARD_MAX_SET_HEIGHT, Math.min(start.height - CARD_MIN_HEIGHT, Math.round(dy / RESIZE_GRID) * RESIZE_GRID)); height = start.height - moveY;
  }
  return { width, ...(height === undefined ? {} : { height }), dx: moveX, dy: moveY };
}
// Card previews draw again only when what they show changes, not each time the card moves or is resized.
const ShownMarkdown = memo(MarkdownPreview);
const ShownCode = memo(CodeView);
const ShownArtifact = memo(BlockPreview, (a, b) => a.artifact.id === b.artifact.id && a.artifact.hash === b.artifact.hash && a.compact === b.compact);
const ShownFilePreview = memo(FilePreview, (a, b) => a.title === b.title && a.file.src === b.file.src && a.file.mediaType === b.file.mediaType && a.file.bytes === b.file.bytes);
const ShownNotion = memo(NotionBlock, (a, b) => a.projectId === b.projectId && a.nodeId === b.nodeId && a.full === b.full && Boolean(a.onRows) === Boolean(b.onRows) && JSON.stringify(a.view) === JSON.stringify(b.view));
const ShownTraining = memo(TrainingBlock, (a, b) => a.projectId === b.projectId && a.nodeId === b.nodeId && a.full === b.full && JSON.stringify(a.view) === JSON.stringify(b.view));
const ShownGoogle = memo(GoogleBlock, (a, b) => a.projectId === b.projectId && a.nodeId === b.nodeId && a.full === b.full && Boolean(a.onCopy) === Boolean(b.onCopy) && JSON.stringify(a.view) === JSON.stringify(b.view));
/** An App on its card: the page is live, but takes clicks only after a click into it, so the map still drags and
 * zooms over it; Escape or a click outside hands the map back. */
function AppFace({ id, data, onErrors }: { id: string; data: CardData; onErrors: (errors: string[]) => void }) {
  const app = data.app!, shell = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  // The cover stays a moment after the click that starts the page, so a double-click still opens the block view.
  const [lingering, setLingering] = useState(false);
  useEffect(() => { if (!lingering) return; const timer = window.setTimeout(() => setLingering(false), 350); return () => window.clearTimeout(timer); }, [lingering]);
  useEffect(() => {
    if (!active) return;
    // A click elsewhere, or Escape outside the page (inside it, the kit sends Escape), hands the map back.
    const away = (event: PointerEvent) => { if (!shell.current?.contains(event.target as globalThis.Node)) setActive(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setActive(false); };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
  }, [active]);
  if (app.still) return <div className="app-face"><p className="app-face-still">{app.still}</p></div>;
  return <>
    <div ref={shell} className={`app-face${active ? ' active nodrag nopan nowheel' : ''}`}>
      <AppFrame projectId={app.projectId} nodeId={id} title={data.title} version={app.version} proposalId={app.proposalId} watchKey={app.watchKey} onFocus={app.onFocus} onErrors={onErrors} onEscape={() => setActive(false)}/>
      {(!active || lingering) && <button type="button" className={`app-face-use${active ? ' lingering' : ''}`} aria-label={`Use ${data.title}`} onClick={event => { event.stopPropagation(); if (active) return; data.onActivate(); setActive(true); setLingering(true); }} onDoubleClick={event => { event.stopPropagation(); setActive(false); data.onInspect(); }}><span>Click to use</span></button>}
    </div>
    {app.leaves?.length ? <p className="app-leaves" title={app.leaves.map(flag => `Line ${flag.line}: ${flag.reason}`).join('\n')}>Tries to leave its frame: line {app.leaves[0].line} {app.leaves[0].reason}{app.leaves.length > 1 ? `, and ${app.leaves.length - 1} more` : ''}. The frame blocks it.</p> : null}
  </>;
}
/** What an agent has done so far, in the words of its tool calls. */
function AgentFace({ data }: { data: CardData }) {
  const work = data.directions, running = data.agent?.status === 'running', plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return <div className="agent-face">
    {work && work.total > 0 ? <ul>
      <li><SearchIcon size={12}/>{plural(work.total, 'direction')} searched · {plural(work.sources, 'source')}</li>
      <li><BookOpen size={12}/>{work.written} of {plural(work.total, 'result note')} written</li>
      {work.pages + work.findings > 0 && <li><Quote size={12}/>{plural(work.pages, 'page')} read · {plural(work.findings, 'finding')}</li>}
    </ul> : !running && data.description ? <ShownMarkdown text={data.description} limit={200}/> : null}
    {data.agent?.pending ? <p className="agent-waiting">{plural(data.agent.pending, 'change')} waiting for your review</p> : null}
    {running && data.agent?.thought && <p className="agent-thought" title={data.agent.thought}>{textPreview(data.agent.thought, 160).text}</p>}
  </div>;
}
/** The words a Text block can carry, offered where its label shows; the researcher's own word is typed in. */
function LabelMenu({ node, left, top, onPick, onClose }: { node: CanvasNode; left: number; top: number; onPick: (value: string) => void; onClose: () => void }) {
  const current = textLabel(node) ?? '';
  const [own, setOwn] = useState(''); const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const away = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as globalThis.Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return <div ref={box} className="card-label-menu nodrag nopan nowheel" role="menu" tabIndex={-1} aria-label={`Label of ${node.title}`} style={{ left, top }}>
    {TEXT_LABELS.map(word => <button key={word} type="button" role="menuitemradio" aria-checked={current === word} onClick={() => onPick(word)}>{word}{current === word && <Check size={13}/>}</button>)}
    <form onSubmit={event => { event.preventDefault(); if (own.trim()) onPick(own); }}><input aria-label="Your own label" placeholder="Your own word" maxLength={40} value={own} onChange={event => setOwn(event.target.value)}/></form>
    {current && <button type="button" role="menuitem" className="card-label-clear" onClick={() => onPick('')}>No label</button>}
  </div>;
}
function ResearchCard({ id, data, selected }: NodeProps<ResearchNode>) {
  const flow = useReactFlow();
  const heading = useRef<HTMLDivElement>(null), resizing = useRef<{ edge: ResizeEdge; x: number; y: number; width: number; height: number; zoom: number } | null>(null);
  const measure = useRef(data.onMeasure); measure.current = data.onMeasure;
  const group=data.kind==='group';
  useEffect(() => {
    if (data.expanded || data.heightSet || !heading.current) return;
    const element=heading.current, update=()=>measure.current(data.width,Math.min(CARD_MAX_HEIGHT,Math.max(CARD_MIN_HEIGHT,(data.notion||data.google||data.training||data.app?element.scrollHeight:element.offsetHeight)+2)));
    const observer=new ResizeObserver(update);observer.observe(element);update();return()=>observer.disconnect();
  },[data.expanded,data.heightSet,data.width,data.primary,data.chosen,data.notebookFigure,data.file]);
  // The Notion preview keeps one row callback, which always reaches the latest canvas.
  const latestRows=useRef(data.notion?.onRows); latestRows.current=data.notion?.onRows;
  const notionRows=useCallback((table:NotionTable)=>latestRows.current?latestRows.current(table):Promise.resolve(null),[]);
  const latestCopy=useRef(data.google?.onCopy); latestCopy.current=data.google?.onCopy;
  const googleCopy=useCallback(()=>latestCopy.current?latestCopy.current():Promise.resolve(false),[]);
  const resized=(event:ReactPointerEvent)=>{const start=resizing.current!;return resizedCard(start.edge,start,(event.clientX-start.x)/start.zoom,(event.clientY-start.y)/start.zoom);};
  const arrows:Record<string,[ResizeEdge,number,number]>={ArrowLeft:['e',-RESIZE_GRID,0],ArrowRight:['e',RESIZE_GRID,0],ArrowUp:['s',0,-RESIZE_GRID],ArrowDown:['s',0,RESIZE_GRID]};
  const active=data.status==='running'||data.status==='queued';
  // Only states that need attention get a line; an idle block shows its content.
  const workState=data.awaitingApproval?'Awaiting approval':active?(data.label==='result'?'Searching':data.status):data.status==='failed'?'Latest attempt failed':data.status==='interrupted'?'Latest attempt interrupted':data.status==='cancelled'?'Latest attempt stopped':'';
  const notebook=data.blockType==='notebook'&&!group, code=data.code!==undefined&&!group, lastRun=data.notebook?.lastRun;
  const [appErrors,setAppErrors]=useState<string[]>([]);
  // The edge that takes keyboard focus and arrow keys: a Group's right side, another card's corner.
  const edges=group?GROUP_RESIZE_EDGES:RESIZE_EDGES, handle:ResizeEdge=group?'e':'se';
  return <article className={`research-card ${group?'organizational-group':'research-block'}${data.blockType==='finding'?' finding-card':''} ${data.expanded?'expanded-group':''} ${selected?'selected':''} ${data.preview?`preview-${data.preview}`:''}${data.heightSet&&!data.expanded?' height-set':''}`}>
    {sides.map(side=><Handle key={side.id} id={side.id} type="source" position={side.position} isConnectable={!data.readonly} className="relationship-handle" role="button" tabIndex={data.readonly?-1:0} aria-label={`Connect ${data.title} from ${side.id}`} title="Drag to a block, or click then choose a block" onClick={event=>{event.stopPropagation();data.onHandle(side.id);}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();data.onHandle(side.id);}}}/>)}
    <div ref={heading} className="group-heading">
      <div className="card-top">{data.onLabel?<button type="button" className="card-type card-type-button nodrag" aria-label={`Change the label of ${data.title}`} title="Change label" onClick={event=>{event.stopPropagation();data.onLabel!(event.currentTarget.getBoundingClientRect());}}><KindIcon kind={data.kind} blockType={data.blockType} google={data.google?.view.kind}/>{data.kindName}{data.textLabel?<span className="card-label">{data.textLabel}</span>:<span className="card-label-add" aria-hidden="true">+ label</span>}{data.fileMissing&&<span className="card-file-missing" title="This block's file is missing from the project folder">File missing</span>}</button>:<span className="card-type"><KindIcon kind={data.kind} blockType={data.blockType} google={data.google?.view.kind}/>{group?'Group':data.kindName}{!group&&data.kindName==='Text'&&data.textLabel?<span className="card-label">{data.textLabel}</span>:null}{group&&<span className="group-item-count"> · {data.members} items</span>}{data.fileMissing&&<span className="card-file-missing" title="This block's file is missing from the project folder">File missing</span>}{data.preview&&<span className="card-preview-tag">{data.preview==='added'?'New':data.preview==='changed'?'Changed':'Removed'}</span>}</span>}<span className="card-controls nodrag">
        <button className="icon-button card-open" aria-label={`Open ${data.title}`} data-tip={group?'Open group details':notebook?'Open notebook':code?'Open code and results':data.app?'Open the App, its code and inputs':'Open content'} data-hint={group?undefined:'or double-click the block'} onClick={event=>{event.stopPropagation();data.onInspect();}}><ArrowUpRight size={15}/></button>
        {group&&<button className="icon-button group-expand-control" aria-label={`${data.expanded?'Collapse':'Expand'} ${data.title}`} title={data.expanded?'Collapse group':'Expand group'} onClick={event=>{event.stopPropagation();data.onExpand();}}>{data.expanded?<ChevronUp size={17}/>:<ChevronDown size={17}/>}</button>}
      </span></div>
      <div className="card-title" title={data.title}>{data.title||'Untitled'}</div>
      {group ? <>
        {data.workLabel&&<span className="group-contained-work">{data.workLabel}</span>}
        {data.description&&<p className="group-overview-excerpt">{data.description.slice(0,140)}{data.description.length>140?'…':''}</p>}
        {!data.expanded&&<div className="group-chosen-highlights">{data.chosen.length?data.chosen.map(artifact=><button key={artifact.id} className="group-highlight-preview" aria-label={`Open highlight: ${artifact.title}`} title={`From ${data.origins[artifact.nodeId]??'a saved block'} · exact version ${artifact.hash}`} onClick={event=>{event.stopPropagation();data.onHighlightOpen(artifact);}}><ShownArtifact artifact={artifact} compact/><span><strong>{artifact.title}</strong><small>{data.origins[artifact.nodeId]??'Saved block'} · {artifact.hash.slice(0,8)}</small></span></button>)
          :data.listed?.length?<ul className="group-member-list">{data.listed.slice(0,GROUP_PREVIEW_MEMBERS).map(member=><li key={member.id} title={member.title}><KindIcon kind={member.kind} blockType={member.blockType} google={member.google} size={12}/><span>{member.title}</span></li>)}{data.members>Math.min(data.listed.length,GROUP_PREVIEW_MEMBERS)&&<li className="more">{data.members-Math.min(data.listed.length,GROUP_PREVIEW_MEMBERS)} more</li>}</ul>
          :<p className="subtle">Choose up to three saved highlights in Group details.</p>}</div>}
      </> : <>
        {notebook?data.notebook?.cells?<div className={`block-work-state ${data.notebook.running?'running':lastRun?.status==='error'?'failed':lastRun?.status==='interrupted'?'interrupted':''}`}>{data.notebook.running&&<LoaderCircle size={12} className="spin"/>}{data.notebook.cells} cell{data.notebook.cells===1?'':'s'}{data.notebook.running?' · Running':lastRun?` · ${lastRun.status==='ok'?'Ran':lastRun.status==='error'?'Error in':'Stopped'} [${lastRun.executionCount??' '}] · ${new Date(lastRun.at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:''}</div>:null
        :data.blockType==='agent'?<div className={`block-work-state ${data.agent?.status==='running'?'running':data.agent&&data.agent.status!=='completed'?'failed':''}`}>{data.agent?.status==='running'&&<LoaderCircle size={12} className="spin"/>}{data.agent?`${agentState[data.agent.status]} · ${data.agent.runtime}`:'Agent'}</div>
        :workState&&<div className={`block-work-state ${data.status||''}`}>{active&&<LoaderCircle size={12} className="spin"/>}{workState}</div>}
        <div className="block-primary-preview" onDoubleClick={event=>{event.stopPropagation();data.onInspect();}}>{notebook&&data.notebookFigure?<img className="block-figure-preview" src={data.notebookFigure} alt={`Newest figure in ${data.title}`}/>:notebook&&data.notebook?.value?<strong className="block-metric-preview">{data.notebook.value}</strong>:notebook&&data.notebook?.excerpt?(data.notebook.excerpt.kind==='code'?<pre className="block-code-preview">{data.notebook.excerpt.text.split('\n').slice(0,5).join('\n')}</pre>:<p className="block-text-preview">{textPreview(data.notebook.excerpt.text,220).text}</p>):data.blockType==='agent'?<AgentFace data={data}/>
          :data.blockType==='search'?<div className="search-face">{data.why&&<p className="search-why" title={data.why}>{data.why}</p>}<ul className="search-queries">{data.description.split('\n').filter(Boolean).slice(0,3).map((query,index)=><li key={index} title={query}><SearchIcon size={12}/><span>{query}</span></li>)}</ul></div>
          :data.label==='result'&&data.description===RESULT_PLACEHOLDER?<div className="search-face">{data.why&&<p className="search-why" title={data.why}>{data.why}</p>}{data.queries?.length?<ul className="search-queries">{data.queries.slice(0,3).map((query,index)=><li key={index} title={query}><SearchIcon size={12}/><span>{query}</span></li>)}</ul>:<p className="block-empty-hint">{data.description}</p>}</div>
          :data.app?<AppFace id={id} data={data} onErrors={setAppErrors}/>:data.file?<ShownFilePreview file={data.file} title={data.title}/>:data.notion?<ShownNotion projectId={data.notion.projectId} nodeId={id} view={data.notion.view} onRows={data.notion.onRows?notionRows:undefined}/>:data.google?<ShownGoogle projectId={data.google.projectId} nodeId={id} view={data.google.view} onCopy={data.google.onCopy?googleCopy:undefined}/>:data.training?<ShownTraining projectId={data.training.projectId} nodeId={id} view={data.training.view}/>:code?(data.code?<ShownCode className="block-code-source nowheel" code={data.code}/>:<p className="block-empty-hint">No code yet</p>):data.primary?<ShownArtifact artifact={data.primary}/>:data.description?<ShownMarkdown text={splitSources(data.description).body} limit={data.heightSet?8000:undefined}/>:notebook?<p className="block-empty-hint">No cells yet</p>:null}</div>
        {selected&&data.modelLabel&&!data.notion&&!data.google&&!data.training&&<span className="node-model-indicator" title={data.modelTitle}>{data.modelLabel}</span>}
      </>}
      {!data.expanded&&!group&&<Provenance data={data} appErrors={appErrors}/>}
    </div>
    {!data.expanded&&!data.readonly&&edges.map(edge=><div key={edge} className={`card-resize card-resize-${edge} nodrag nopan${data.resizePending?' pending':''}`}
      {...edge===handle?{role:'button',tabIndex:0,'aria-label':group?`Resize ${data.title}, now ${data.width} wide. Arrow keys resize`:`Resize ${data.title}, now ${data.width} by ${data.height}. Arrow keys resize; double-click fits the height to the content`,title:group?'Drag to resize':'Drag to resize · double-click to fit the content'}:{'aria-hidden':true}}
      onPointerDown={event=>{if(data.resizePending||event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);resizing.current={edge,x:event.clientX,y:event.clientY,width:data.width,height:data.height,zoom:flow.getZoom()};data.onActivate();}}
      onPointerMove={event=>{if(resizing.current)data.onResize(resized(event));}}
      onPointerUp={event=>{const start=resizing.current;if(!start)return;const size=resized(event);resizing.current=null;event.currentTarget.releasePointerCapture(event.pointerId);
        // A click without a drag (the first half of a double-click) changes nothing.
        data.onResize(Math.abs(event.clientX-start.x)+Math.abs(event.clientY-start.y)<3?null:size,true);}}
      onPointerCancel={()=>{resizing.current=null;data.onResize(null);}}
      onClick={event=>event.stopPropagation()}
      onDoubleClick={event=>{event.stopPropagation();if(data.heightSet&&edge!=='e'&&edge!=='w')data.onAutoHeight();}}
      onKeyDown={edge===handle?event=>{const arrow=arrows[event.key];if(!arrow||data.resizePending||group&&arrow[0]==='s')return;event.preventDefault();event.stopPropagation();data.onResize(resizedCard(arrow[0],data,arrow[1],arrow[2]),true);}:undefined}/>)}
    {data.expanded&&<div className="group-actions nodrag"><span>Mixed research blocks · relationships do not run work</span><button className="small secondary" disabled={data.readonly} onClick={event=>{event.stopPropagation();data.onAdd();}}><Plus size={14}/> Add inside</button></div>}
  </article>;
}
type ArtifactData = { artifact: Artifact; destinationId: string; highlighted: boolean; reused: boolean; originLabel?: string; producer?: string; onOpen: () => void; onPin: () => void; onReuse: () => void; readonly: boolean };
type ArtifactNode = Node<ArtifactData, 'artifact'>;
function ArtifactCard({ data }: NodeProps<ArtifactNode>) {
  const { artifact } = data;
  return <article className={`canvas-artifact ${data.highlighted ? 'highlighted' : ''}`}><div className="card-top"><span className="card-type">{data.highlighted ? <Pin size={13}/> : null}{data.reused ? 'Selected input' : artifact.kind}</span><div className="row nodrag"><button className="icon-button" aria-label={`${data.highlighted ? 'Unpin' : 'Pin'} ${artifact.title}`} disabled={data.readonly} title={data.highlighted ? 'Unpin highlight' : 'Pin as highlight'} onClick={data.onPin}><Pin size={15} fill={data.highlighted ? 'currentColor' : 'none'}/></button><button className="icon-button" aria-label={`Inspect ${artifact.title}`} title="Inspect result" onClick={data.onOpen}><ArrowUpRight size={15}/></button></div></div><h3>{artifact.title}</h3>{data.originLabel&&<span className="artifact-origin">{data.originLabel}</span>}<div className="artifact-preview nodrag nowheel" onDoubleClick={data.onOpen}><BlockPreview artifact={artifact}/></div><div className="artifact-footer"><span title={`Immutable version ${artifact.hash}`}>{data.reused ? 'Exact selected version' : 'Saved result'} · {artifact.hash.slice(0, 8)}{data.producer&&<small className="artifact-producer"> · Produced by {data.producer}</small>}</span><button className="text-button small nodrag" disabled={data.readonly} onClick={data.onReuse}>Reuse <ArrowUpRight size={13}/></button></div></article>;
}
// While a block moves, React Flow moves its frame; the card inside draws again only when its content, size or
// selection changes, and a line only when its route does (the route comes with its data, not from the endpoints).
const PLACEMENT_PROPS = new Set(['positionAbsoluteX', 'positionAbsoluteY', 'dragging', 'sourceX', 'sourceY', 'targetX', 'targetY', 'sourcePosition', 'targetPosition']);
function samePlacedProps<P extends object>(a: P, b: P) { return (Object.keys(b) as (keyof P & string)[]).every(key => PLACEMENT_PROPS.has(key) || a[key] === b[key]); }
const nodeTypes = { research: memo(ResearchCard, samePlacedProps), artifact: memo(ArtifactCard, samePlacedProps) };
type RoutedEdge = Edge<{ route: RelationshipRoute; label: string; tooltip: string; showLabel: boolean; onSelect: () => void }, 'relationship'>;
function CanvasRelationshipEdge({ id, data, selected, style, markerStart, markerEnd, interactionWidth }: EdgeProps<RoutedEdge>) {
  if (!data) return null;
  const { route, label, tooltip } = data;
  return <g data-route-source-side={route.sourceHandle} data-route-target-side={route.targetHandle} data-route-obstructed={route.obstructed} data-aggregate-relationship="true">
    <title>{tooltip}</title>
    <BaseEdge id={id} path={route.path} style={style} markerStart={markerStart} markerEnd={markerEnd} interactionWidth={interactionWidth}/>
    <EdgeLabelRenderer>{data.showLabel && <button type="button" className={`relationship-edge-label on-route-relationship-label nodrag nopan ${selected ? 'selected' : ''}`} style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`, width: route.labelWidth, pointerEvents: 'all' }} title={tooltip} aria-label={`Inspect relationship: ${tooltip}`} onClick={event => { event.stopPropagation(); data.onSelect(); }}><span>{label}</span><ChevronRight size={12} aria-hidden="true"/></button>}</EdgeLabelRenderer>
  </g>;
}
const edgeTypes = { relationship: memo(CanvasRelationshipEdge, samePlacedProps) };
function relationshipBadge(group: AggregateRelationship, canvas: Canvas) {
  const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
  const label = relationshipBadgeText(group, id => canvas.nodes.find(node => node.id === id));
  const title = (id: string) => normalize(canvas.nodes.find(node => node.id === id)?.title || 'Untitled block');
  const originals = group.contributions.map(({ connection, sourceTitle, targetTitle }) => `${normalize(sourceTitle) || 'Untitled block'} → ${normalize(targetTitle) || 'Untitled block'}: ${normalize(connection.label) || 'Related'}`);
  return { label, tooltip: `${title(group.source)} ${group.bidirectional ? '↔' : '→'} ${title(group.target)}\n${originals.length === 1 ? 'Saved relationship' : `${originals.length} saved relationships`}:\n${originals.join('\n')}\nClick to inspect the original relationships.` };
}
/** Keep every badge on a straight part of its own rendered route. Enclosing
 * frames have traversable interiors; crowded routes stay selectable without a
 * displaced badge suggesting a relationship elsewhere on the board. */
export function placeCanvasRelationshipLabels(items: { route: RelationshipRoute; showLabel: boolean }[], nodes: readonly RouteNode[], expandedIds: readonly string[]) {
  const expanded = new Set(expandedIds), occupied: Box[] = [];
  const obstacles: Box[] = nodes.flatMap(node => expanded.has(node.id) ? [{ ...node, height: GROUP_INSET.y - 20 }, { ...node, y: node.y + node.height - GROUP_FOOTER, height: GROUP_FOOTER }] : [node]);
  const intersects = (a: Box, b: Box) => a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;
  for (const item of items) {
    const { route } = item, height = 28;
    let traversed = 0;
    const segments = route.points.slice(1).map((b, index) => {
      const a = route.points[index], length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y), start = traversed;
      traversed += length;
      return { a, b, length, start, horizontal: a.y === b.y };
    });
    const candidates = segments.flatMap(({ a, b, length, start, horizontal }) => {
      // Rounded bends consume ten pixels at either end of an inner segment.
      const width = route.labelWidth;
      if (width < 64) return [];
      // The badge can overhang a short horizontal segment's bends when its
      // complete rectangle still fits; only its center must stay on the line.
      const margin = horizontal ? 10 : height / 2 + 10;
      if (length < margin * 2) return [];
      return [Math.max(margin, Math.min(length - margin, traversed / 2 - start)), ...[.125, .25, .375, .5, .625, .75, .875].map(fraction => Math.max(margin, Math.min(length - margin, length * fraction)))].map(offset => {
        const point = { x: a.x + (b.x - a.x) * offset / length, y: a.y + (b.y - a.y) * offset / length };
        const area = { x: point.x - width / 2, y: point.y - height / 2, width, height };
        return { point, area, distance: Math.abs(start + offset - traversed / 2) };
      });
    }).sort((a, b) => a.distance - b.distance);
    const chosen = candidates.find(candidate => ![...obstacles, ...occupied].some(box => intersects(candidate.area, box)));
    item.showLabel = Boolean(chosen);
    if (chosen) { route.label = chosen.point; route.labelWidth = chosen.area.width; route.labelHeight = height; occupied.push(chosen.area); }
  }
}
export function emptyPosition(canvas: Canvas): { x: number; y: number } {
  for (let row = 0; row < 100; row++) for (let column = 0; column < 5; column++) {
    const x = column * (CARD_SIZE.width + LAYOUT_GAP), y = row * (CARD_MAX_HEIGHT + LAYOUT_GAP);
    if (canvas.nodes.every(node => x >= node.x + cardWidth(node) + 24 || x + CARD_SIZE.width + 24 <= node.x || y >= node.y + CARD_MAX_HEIGHT + 24 || y + CARD_MAX_HEIGHT + 24 <= node.y)) return { x, y };
  }
  return { x: 0, y: Math.max(0, ...canvas.nodes.map(n => n.y)) + CARD_MAX_HEIGHT + LAYOUT_GAP };
}
export function previewCanvas(canvas: Canvas, proposal?: Proposal) {
  const result = structuredClone(canvas); const marks = new Map<string, CardData['preview']>();
  for (const op of proposal?.operations || []) {
    if (op.type === 'addNode') { result.nodes.push(op.node); marks.set(op.node.id, 'added'); }
    // Blocks a proposal only moves, such as a tree laid out again around new groups, are not marked as changed.
    if (op.type === 'updateNode') { const n = result.nodes.find(n => n.id === op.id); if (n) Object.assign(n, op.patch); if (!layoutOnly(op.patch)) marks.set(op.id, 'changed'); }
    // Removing a block takes the blocks inside it too, so each of them shows as removed.
    if (op.type === 'removeNode') for (const id of [op.id, ...groupMembers(result, op.id).map(n => n.id)]) marks.set(id, 'removed');
    if (op.type === 'addConnection') result.connections.push(op.connection);
    if (op.type === 'removeConnection') result.connections = result.connections.filter(c => c.id !== op.id);
  }
  return { canvas: convertLegacyGroups(result), marks };
}
export type CanvasHighlight = { id: string; nodeId: string; artifactId: string; x: number; y: number };
type Props = { notices?: ReactNode; proposalCard?: ReactNode; detail: ProjectDetail; agentTurns?: Record<string, AgentTurnSummary>; selectedId: string | null; onSelect: (id: string | null) => void; onInspect: (id: string) => void; onArtifact: (artifact: Artifact, nodeId: string) => void; onReuse: (artifact: Artifact, nodeId?: string) => void; onPin: (artifact: Artifact, nodeId: string) => void; onMoveHighlight: (id: string, nodeId: string, position: { x: number; y: number }) => void; highlights: CanvasHighlight[]; mutate: (operations: Mutation[], label: string) => Promise<unknown>; onAdd: (parentId: string | null) => void; onUndo?: () => void; onRedo?: () => void; onHistory?: () => void; onDemo?: () => void; demoLabel?: string; onTour?: () => void; historyOpen?: boolean; busy?: boolean; proposal?: Proposal; historyCanvas?: Canvas; expandedIds: string[]; onExpandedChange: (ids: string[]) => void; focusId?: string | null; frame?: { ids: string[]; key: number } | null; missingFiles?: ReadonlySet<string>; folderFiles?: ReadonlyMap<string, FolderFile>; onDropFiles?: (files: File[], position: { x: number; y: number }) => void;
  /** Copies the tab a Google Sheet block shows into a new Data block; false when it did not happen. */
  onGoogleCopy?: (nodeId: string) => Promise<boolean> };
type Box = { x: number; y: number; width: number; height: number };
function overlaps(a: Box, b: Box) { return a.x < b.x + b.width + 32 && a.x + a.width + 32 > b.x && a.y < b.y + b.height + 32 && a.y + a.height + 32 > b.y; }
/** One stable result footprint shared by display and Arrange, independent of old child positions. */
function packArtifactCards(artifacts: Artifact[], parentId: string, highlights: CanvasHighlight[], compact = false) {
  const saved = artifacts.map(artifact => {
    if (compact) return null;
    const pin = highlights.find(highlight => highlight.artifactId === artifact.id);
    return pin && (pin.x > 0 || pin.y > 0) ? { x: pin.x, y: pin.y } : readSaved<{ x: number; y: number } | null>(`artifact-group-position:${parentId}:${artifact.id}`, null);
  });
  const minY = saved.some(Boolean) ? Math.max(0, Math.min(...saved.filter((value): value is { x: number; y: number } => Boolean(value)).map(value => value.y - GROUP_INSET.y))) : 0;
  const occupied: Box[] = []; let width = 0, height = 0;
  const items = artifacts.map((artifact, index) => {
    const position = saved[index];
    let box: Box = { x: position ? Math.max(0, position.x - GROUP_INSET.x) : index % 2 * (ARTIFACT_SIZE.width + 48), y: position ? Math.max(0, position.y - GROUP_INSET.y - minY) : Math.floor(index / 2) * (ARTIFACT_SIZE.height + 48), ...ARTIFACT_SIZE };
    let collision = occupied.find(other => overlaps(box, other));
    while (collision) { box = { ...box, y: collision.y + collision.height + 48 }; collision = occupied.find(other => overlaps(box, other)); }
    occupied.push(box); width = Math.max(width, box.x + box.width); height = Math.max(height, box.y + box.height);
    return { artifact, box };
  });
  return { items, width, height, minY };
}
/** The last blocks copied in this window, for browsers that hand a paste only its plain text. */
let lastCopy: { text: string; plain: string } | null = null;
type FlowHandlerName = 'onNodesChange' | 'onNodeClick' | 'onNodeDoubleClick' | 'onPaneClick' | 'onEdgeClick' | 'onEdgeDoubleClick' | 'onSelectionStart' | 'onSelectionEnd' | 'onNodeDragStart' | 'onNodeDrag' | 'onNodeDragStop' | 'onConnect' | 'onConnectEnd' | 'onMoveStart' | 'onMoveEnd';
type FlowHandlers = Required<Pick<ReactFlowProps<ResearchNode | ArtifactNode, RoutedEdge>, FlowHandlerName>>;
/** Handlers that keep their identity across renders and always run the latest code. */
function useStableHandlers<T extends Record<string, (...args: never[]) => unknown>>(handlers: T): T {
  const latest = useRef(handlers); latest.current = handlers;
  return useMemo(() => Object.fromEntries(Object.keys(latest.current).map(key => [key, (...args: never[]) => latest.current[key](...args)])) as T, []);
}
function FlowCanvas({ notices, proposalCard, detail, selectedId, onSelect, onInspect, onArtifact, onReuse, onPin, onMoveHighlight, highlights, mutate, onAdd, onUndo, onRedo, onHistory, onDemo, demoLabel='Demo', onTour, historyOpen=false, busy=false, proposal, historyCanvas, expandedIds: requestedExpandedIds, onExpandedChange, focusId, frame, missingFiles, folderFiles, onDropFiles, onGoogleCopy, agentTurns }: Props) {
  const flow = useReactFlow(); const dragging = useRef(false); const area = useRef<HTMLDivElement>(null);
  // The open label menu, and the Group a dragged block would join (outlined while the drag lasts).
  const [labelMenu, setLabelMenu] = useState<{ nodeId: string; left: number; top: number } | null>(null); const closeLabelMenu = useCallback(() => setLabelMenu(null), []);
  const [dropTarget, setDropTarget] = useState<{ id: string; left: number; top: number; width: number; height: number } | null>(null); const dropTargetId = useRef<string | null>(null);
  const [selecting, setSelecting] = useState(false), [groupSelection, setGroupSelection] = useState<string[]>([]), [groupName, setGroupName] = useState('New group'), [dropping, setDropping] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null), [focusRequest, setFocusRequest] = useState<string | null>(null), [frameRequest, setFrameRequest] = useState<string[] | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ nodeId: string; side: Side } | null>(null), [arranging, setArranging] = useState(false), [message, setMessage] = useState('');
  const [animatingLayout, setAnimatingLayout] = useState(false), [artifactPlacementRevision, setArtifactPlacementRevision] = useState(0);
  const [reflowRevision, setReflowRevision] = useState(0);
  // Blocks being dragged, or settling after a drop, are drawn from React Flow's own store until they come to rest
  // (see followDrag); `saving` keeps a dropped block where it settled until the saved canvas arrives.
  const flowStore = useStoreApi<ResearchNode | ArtifactNode, RoutedEdge>();
  const live = useRef(new Set<string>()), dragFrom = useRef(new Map<string, XYPosition>()), settling = useRef<{ frame: number; targets: Map<string, XYPosition> } | null>(null);
  const saving = useRef(new Map<string, { parentId: string | null; position: XYPosition }>()), missedLayout = useRef(false), boxSelecting = useRef(false);
  const [layoutRetry, setLayoutRetry] = useState(0);
  const [modelSettings, setModelSettings] = useState<ModelSettingsResponse|null>(null);
  useEffect(() => {
    let active=true;
    const load=()=>{void api<ModelSettingsResponse>(`/api/projects/${detail.project.id}/models`).then(value=>{if(active)setModelSettings(value);}).catch(()=>{if(active)setModelSettings(null);});};
    load();window.addEventListener('ros-ai-model-settings',load);
    return()=>{active=false;window.removeEventListener('ros-ai-model-settings',load);};
  },[detail.project.id,detail.project.revision]);
  const reflowState = useRef<{ plan: CanvasReflowPlan; canvas: Canvas; sizes: Record<string, CanvasSize>; positions: string; dimensions: string; structure: string; shape: string; ready: boolean } | null>(null);
  const reflowWriting = useRef(false);
  const [cardMeasurements, setCardMeasurements] = useState<Record<string, CanvasSize>>({}), [draftSizes, setDraftSizes] = useState<Record<string, CardResize>>({});
  const resizeCommits = useRef(new Set<string>());
  const [resizingCards, setResizingCards] = useState<string[]>([]);
  const [resultChoices, setResultChoices] = useState<Record<string, ResultPageChoice>>(() => readSaved(`result-pages:${detail.project.id}`, {}));
  const changeResults = (id: string, choice: ResultPageChoice) => setResultChoices(current => { const next = { ...current, [id]: { size: choice.size, page: choice.page } }; saveLocal(`result-pages:${detail.project.id}`, next); return next; });
  const [blockers, setBlockers] = useState<CardOutcomeOptions['blockers']>();
  const runRevision = detail.runs.map(run => `${run.id}:${run.status}`).join('|');
  useEffect(() => {
    let active = true;
    void api<ExperimentCapabilities>('/api/experiments/capabilities').then(capabilities => {
      if (!active) return;
      const remote = capabilities.nebiusSandbox;
      setBlockers({ 'nebius-sandbox': remote?.costGate && !remote.costGate.ready ? remote.costGate.reason : remote && !remote.available ? 'Nebius Sandbox is unavailable; inspect execution details.' : '' });
    }).catch(() => { /* Keep captured capability evidence when current state is unavailable. */ });
    return () => { active = false; };
  }, [detail.project.id, runRevision]);
  const measureCard = useCallback((id: string, width: number, height: number) => setCardMeasurements(current => current[id]?.width === width && current[id]?.height === height ? current : { ...current, [id]: { width, height } }), []);
  const animateNextLayout = useRef<Map<string, { x: number; y: number }> | null>(null), animationFrame = useRef<number | null>(null);
  const routeHistory = useRef(new Map<string, RelationshipRoute>()), shownEdges = useRef(new Map<string, { key: string; edge: RoutedEdge }>());
  const connectionCommittedAt = useRef(0); const connectionBusy = useRef(false);
  const viewKey = `canvas-view:${detail.project.id}`;
  const viewport = useRef(readSaved<Viewport>(viewKey, readSaved(`viewport:${detail.project.id}:project`, { x: 48, y: 216, zoom: 1 })));
  const canvasInsets = () => {
    const bounds = area.current?.getBoundingClientRect();
    let top = 128, bottom = 88, left = 28, right = 28;
    if (bounds) {
      for (const element of area.current!.querySelectorAll('.canvas-header')) {
        const overlay = element.getBoundingClientRect();
        if (overlay.height) top = Math.max(top, overlay.bottom - bounds.top + 22);
      }
      for (const element of area.current!.parentElement?.querySelectorAll('.canvas-tools, .canvas-hint, .edge-selection, .ros-dock') || []) {
        const overlay = element.getBoundingClientRect();
        if (overlay.height && overlay.top > bounds.top + bounds.height / 2) bottom = Math.max(bottom, bounds.bottom - overlay.top + 22);
      }
      // Desktop panels shrink the canvas. On narrow windows they overlay it;
      // only their actual intersection is reserved, never their width twice.
      const panel = area.current!.closest('.workspace-body')?.querySelector('.assistant-panel:not(.ros-half)');
      if (panel) {
        const overlay = panel.getBoundingClientRect();
        if (overlay.left < bounds.right && overlay.right > bounds.left && overlay.bottom > bounds.top) right = Math.max(right, bounds.right - Math.max(bounds.left, overlay.left) + 22);
      }
      left = Math.min(left, bounds.width / 8);
      const dock = area.current!.querySelector('.canvas-dock')?.getBoundingClientRect();
      if (dock?.width) left = Math.max(left, dock.right - bounds.left + 16);
      // The demo guide floats over the lower left; blocks shown for it stay beside it.
      const guide = document.querySelector('.executable-demo:not(.minimized)')?.getBoundingClientRect();
      if (guide?.width && guide.width < bounds.width / 2 && guide.left < bounds.left + bounds.width / 2) left = Math.max(left, guide.right - bounds.left + 16);
    }
    return { top, bottom, left, right };
  };
  const focusReadable = (id: string, duration = 350) => {
    const node = flow.getInternalNode(id), bounds = area.current?.getBoundingClientRect();
    if (!node || !bounds) return;
    const inset = canvasInsets(), available = Math.max(160, bounds.width - inset.left - inset.right);
    const width = node.measured.width || CARD_SIZE.width;
    // Large open groups are read from their header, not shrunk to their entire
    // contents. The stage navigator keeps the wider sequence in reach.
    const readingWidth = Math.min(width, 768);
    const zoom = Math.min(1, Math.max(.65, available / readingWidth));
    const x = inset.left + Math.max(0, (available - readingWidth * zoom) / 2) - node.internals.positionAbsolute.x * zoom;
    return flow.setViewport({ x, y: inset.top - node.internals.positionAbsolute.y * zoom, zoom }, { duration });
  };
  const fitCanvas = (duration = 400, overview = false) => {
    const bounds = area.current?.getBoundingClientRect(), visible = flow.getNodes();
    if (!bounds || !visible.length) return;
    const inset = canvasInsets(), content = flow.getNodesBounds(visible);
    const width = Math.max(160, bounds.width - inset.left - inset.right), height = Math.max(160, bounds.height - inset.top - inset.bottom);
    const zoom = Math.max(.08, Math.min(1, width / (content.width + 40), height / (content.height + 40)));
    if (!overview && zoom < .65) {
      const anchor = visible.find(node => node.id === selectedId) || visible.filter(node => !node.parentId).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)[0];
      if (anchor) {
        setMessage('Reading view · use the stage buttons to follow the question, or See all to show the whole canvas.');
        return focusReadable(anchor.id, duration);
      }
    }
    return flow.setViewport({ x: inset.left + (width - content.width * zoom) / 2 - content.x * zoom, y: inset.top + (height - content.height * zoom) / 2 - content.y * zoom, zoom }, { duration });
  };
  // Blocks shown together stay readable: when they do not fit at 45% they start at the top left, the rest a scroll away.
  const showBlocks = (visible: Node[], duration = 450, roomRight = 0) => {
    const bounds = area.current?.getBoundingClientRect();
    if (!bounds || !visible.length) return;
    const inset = canvasInsets(), content = flow.getNodesBounds(visible);
    const width = Math.max(160, bounds.width - inset.left - inset.right - roomRight), height = Math.max(160, bounds.height - inset.top - inset.bottom);
    // A proposal's whole batch fits beside its card, even if that zooms out further than usual.
    const zoom = Math.max(roomRight ? .3 : .45, Math.min(1, width / (content.width + 40), height / (content.height + 40)));
    const x = inset.left + Math.max(0, (width - content.width * zoom) / 2), y = inset.top + Math.max(0, (height - content.height * zoom) / 2);
    return flow.setViewport({ x: x - content.x * zoom, y: y - content.y * zoom, zoom }, { duration });
  };
  const readonly = Boolean(historyCanvas || proposal);
  const displayed = useMemo(() => previewCanvas(historyCanvas || detail.project.canvas, historyCanvas ? undefined : proposal), [historyCanvas, detail.project.canvas, proposal]);
  // Read from the canvas as shown, so a group a proposal adds opens while the proposal is reviewed.
  const expandedIds = useMemo(()=>requestedExpandedIds.filter(id=>displayed.canvas.nodes.some(node=>node.id===id&&(isGroup(node)||displayed.canvas.nodes.some(child=>child.parentId===id)))),[requestedExpandedIds,displayed]);
  // A proposal is shown where it changes the canvas: its blocks in view, its card beside them.
  const proposalIds = useMemo(() => proposal && !historyCanvas ? [...displayed.marks.keys()] : [], [proposal, historyCanvas, displayed]);
  const proposalFrame = useRef(false);
  useEffect(() => { if (proposalIds.length) { proposalFrame.current = true; setFrameRequest(proposalIds); } }, [proposal?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const aggregatedRelationships = useMemo(() => aggregateTopLevelRelationships(displayed.canvas, expandedIds), [displayed.canvas, expandedIds]);
  const selectedAggregate = aggregatedRelationships.find(connection => connection.id === selectedEdge);
  const rootStages = displayed.canvas.nodes.filter(node => !node.parentId);
  const stageOrder = numberedStageOrder(rootStages);
  rootStages.sort((a, b) => stageOrder ? stageOrder.get(a.id)! - stageOrder.get(b.id)! : a.y - b.y || a.x - b.x);
  const showStageNavigation = rootStages.length > 1 && rootStages.length <= 8 && rootStages.some(node => displayed.canvas.nodes.some(child => child.parentId === node.id));
  const cardOutcomes = useMemo(() => deriveGroupOutcomes(displayed.canvas.nodes, detail.runs, detail.artifacts, { projectId: detail.project.id, blockers }), [displayed.canvas.nodes, detail.runs, detail.artifacts, detail.project.id, blockers]);
  const descendantIds = useMemo(() => Object.fromEntries(displayed.canvas.nodes.map(node => {
    const ids = new Set<string>();
    const visit=(id:string)=>{for(const child of displayed.canvas.nodes.filter(item=>item.parentId===id)){if(!ids.has(child.id)){ids.add(child.id);visit(child.id);}}};
    visit(node.id);return [node.id,ids];
  })),[displayed.canvas.nodes]);
  // A card the researcher made taller keeps that height; others follow their measured content.
  const cardSizes = useMemo(() => Object.fromEntries(displayed.canvas.nodes.map(node => {
    const draft = draftSizes[node.id], initial = initialCardSize({ ...node, width: draft?.width ?? node.width }, cardOutcomes[node.id].text);
    const height = draft?.height ?? setCardHeight(node);
    if (height) return [node.id, { width: initial.width, height }];
    return [node.id, cardMeasurements[node.id]?.width === initial.width ? cardMeasurements[node.id] : initial];
  })), [displayed.canvas.nodes, cardOutcomes, cardMeasurements, draftSizes]);
  /** One page block per row of a database block, linked from it; the person confirmed on the card. */
  const rowBlocks = async (nodeId: string, table: NotionTable): Promise<RowBlocksOutcome | null> => {
    const node = displayed.canvas.nodes.find(item => item.id === nodeId);
    if (!node) return null;
    const { operations, added, skipped, beyond } = rowBlockOperations(displayed.canvas, node, table);
    if (!operations.length) return { added: 0, skipped, beyond };
    const saved = await mutate(operations, `One block per row of ${node.title}`.slice(0, 80));
    if (saved === false) return null;
    setMessage(`Added ${added} block${added === 1 ? '' : 's'}, one per row of ${node.title}.${beyond ? ` ${beyond} more rows need a narrower filter.` : ''}`);
    return { added, skipped, beyond };
  };
  const resizeCard = (id: string, size: CardResize | null, commit = false) => {
    if (resizeCommits.current.has(id)) return;
    const clear = () => setDraftSizes(current => { const next = { ...current }; delete next[id]; return next; });
    if (size === null) { clear(); return; }
    setDraftSizes(current => ({ ...current, [id]: size }));
    if (!commit) return;
    const node = displayed.canvas.nodes.find(item => item.id === id)!;
    const patch: Partial<CanvasNode> = {
      ...(size.width !== cardWidth(node) ? { width: size.width } : {}),
      ...(size.height !== undefined && size.height !== setCardHeight(node) ? { height: size.height } : {}),
      ...(size.dx ? { x: node.x + size.dx } : {}), ...(size.dy ? { y: node.y + size.dy } : {}),
    };
    if (!Object.keys(patch).length) { clear(); return; }
    resizeCommits.current.add(id); setResizingCards([...resizeCommits.current]);
    void mutate([{ type: 'updateNode', id, patch }], 'Resize block').finally(() => { clear(); resizeCommits.current.delete(id); setResizingCards([...resizeCommits.current]); });
  };
  const fitHeight = (id: string) => { if (!readonly) void mutate([{ type: 'updateNode', id, patch: { height: null } }], 'Fit block to its content'); };
  const toggle = (id: string) => { if (!displayed.canvas.nodes.some(node=>node.id===id&&isGroup(node))) return; const open = expandedIds.includes(id); onExpandedChange(open ? expandedIds.filter(n => n !== id) : [...expandedIds, id]); onSelect(id); };
  const connect = (source: string, target: string, sourceHandle?: Side, targetHandle?: Side) => {
    if (readonly || source === target || connectionBusy.current) return;
    setPendingConnection(null); connectionCommittedAt.current = Date.now();
    const existing = displayed.canvas.connections.find(c => (c.source === source && c.target === target) || (c.source === target && c.target === source));
    if (existing) { setSelectedEdge(aggregatedRelationships.find(group => group.contributions.some(item => item.connection.id === existing.id))?.id || null); setMessage('These notes already have a relationship. Inspect their details to see it.'); return; }
    connectionBusy.current = true;
    void mutate([{ type: 'addConnection', connection: { id: crypto.randomUUID(), source, target, ...(sourceHandle ? { sourceHandle } : {}), ...(targetHandle ? { targetHandle } : {}), label: '' } }], 'Connect notes').then(result => { if (result !== false) setMessage('Relationship added. No work was started or imported.'); }).finally(() => { connectionBusy.current = false; });
  };
  const handleClick = (nodeId: string, side: Side) => {
    if (readonly || Date.now() - connectionCommittedAt.current < 250) return;
    if (pendingConnection && pendingConnection.nodeId !== nodeId) connect(pendingConnection.nodeId, nodeId, pendingConnection.side, side);
    else { setPendingConnection(pendingConnection?.nodeId === nodeId && pendingConnection.side === side ? null : { nodeId, side }); onSelect(nodeId); setSelectedEdge(null); }
  };
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 4500); return () => clearTimeout(timer); }, [message]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPendingConnection(null); setSelectedEdge(null); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  // Delete the picked blocks, or the selected one; a block inside another picked group goes with it.
  // A Text block's label is picked from a menu under its caption; a Report or Finding keeps the label its type implies.
  const labelMenuOpener = (node: CanvasNode) => !readonly && kindName(node) === 'Text' && !labelFixed(node) ? (anchor: DOMRect) => { const box = area.current?.getBoundingClientRect(); setLabelMenu({ nodeId: node.id, left: anchor.left - (box?.left ?? 0), top: anchor.bottom - (box?.top ?? 0) + 6 }); } : undefined;
  // The expanded Group under a point, for blocks being dragged: never one of them or a Group inside one.
  const groupAt = (point: { x: number; y: number }, nodeIds: string[]) => {
    const excluded = new Set(nodeIds.flatMap(id => [id, ...(descendantIds[id] ?? [])]));
    const inside = flow.getNodes().filter(item => item.type === 'research' && expandedIds.includes(item.id) && !excluded.has(item.id)).flatMap(item => { const absolute = flow.getInternalNode(item.id)?.internals.positionAbsolute; return absolute ? [{ id: item.id, absolute, width: item.width || 0, height: item.height || 0 }] : []; }).filter(item => point.x >= item.absolute.x && point.x <= item.absolute.x + item.width && point.y >= item.absolute.y && point.y <= item.absolute.y + item.height);
    return inside.at(-1) ?? null;
  };
  const selectedGroup = !readonly && !selecting && selectedId ? displayed.canvas.nodes.find(node => node.id === selectedId && isGroup(node)) : undefined;
  // The picked blocks: those chosen with the Group picker, a selection box or Shift/⌘-clicks, or else the selected one.
  const picked = selecting || groupSelection.length ? groupSelection : selectedId ? [selectedId] : [];
  const deletable = readonly || busy ? [] : picked.filter(id => displayed.canvas.nodes.some(node => node.id === id));
  const removeSelected = () => {
    const parents = new Map(displayed.canvas.nodes.map(node => [node.id, node.parentId]));
    const inPicked = (id: string) => { for (let parent = parents.get(id); parent; parent = parents.get(parent)) if (deletable.includes(parent)) return true; return false; };
    const ids = deletable.filter(id => !inPicked(id));
    if (!ids.length) return;
    const title = displayed.canvas.nodes.find(node => node.id === ids[0])?.title;
    void mutate(ids.map(id => ({ type: 'removeNode' as const, id })), ids.length === 1 ? `Delete ${title}` : `Delete ${ids.length} blocks`).then(saved => {
      if (saved === false) return;
      setGroupSelection([]); onSelect(null);
      setMessage(`${ids.length === 1 ? `Deleted ${title}` : `Deleted ${ids.length} blocks`}. Undo brings it back.`);
    });
  };
  const removeRef = useRef(removeSelected); removeRef.current = removeSelected;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="dialog"]')) return;
      event.preventDefault(); removeRef.current();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { if (readonly) setPendingConnection(null); }, [readonly]);
  // ⌘/Ctrl Z undoes the last canvas change and ⌘/Ctrl Shift Z (or Ctrl Y off a Mac) redoes it, like the toolbar
  // buttons. Text fields, editors and dialogs keep their own undo.
  const historyRef = useRef({ onUndo, onRedo, canUndo: detail.canUndo, canRedo: detail.canRedo, blocked: readonly || busy });
  historyRef.current = { onUndo, onRedo, canUndo: detail.canUndo, canRedo: detail.canRedo, blocked: readonly || busy };
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !(mac ? event.metaKey : event.ctrlKey)) return;
      const letter = event.code === 'KeyZ' || event.key.toLowerCase() === 'z' ? 'z' : event.code === 'KeyY' || event.key.toLowerCase() === 'y' ? 'y' : '';
      if (!letter || letter === 'y' && (mac || event.shiftKey)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="dialog"], .cm-editor')) return;
      event.preventDefault();
      if (event.repeat) return;
      const { onUndo, onRedo, canUndo, canRedo, blocked } = historyRef.current;
      if (blocked) return;
      if (letter === 'y' || event.shiftKey) { if (canRedo) onRedo?.(); } else if (canUndo) onUndo?.();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  // ⌘/Ctrl C copies the picked blocks and ⌘/Ctrl V pastes them as new blocks. Text being edited or
  // selected keeps the browser's own copy and paste.
  const copySelected = (event: ClipboardEvent) => {
    const copy = copyBlocks(displayed.canvas, picked, detail.project.id);
    if (!copy || !event.clipboardData) return;
    const roots = copy.nodes.filter(node => !copy.nodes.some(item => item.id === node.parentId));
    const text = JSON.stringify(copy), plain = roots.map(node => node.title).join('\n');
    event.clipboardData.setData(BLOCKS_MIME, text); event.clipboardData.setData('text/plain', plain); event.preventDefault();
    lastCopy = { text, plain };
    setMessage(roots.length === 1 ? `Copied ${roots[0].title}.` : `Copied ${roots.length} blocks.`);
  };
  const pasteCopied = (event: ClipboardEvent) => {
    const data = event.clipboardData, plain = data?.getData('text/plain') ?? '';
    // Some browsers keep only plain text, so the last copy made here stands in when the text still matches it.
    const text = data?.getData(BLOCKS_MIME) || (lastCopy && plain === lastCopy.plain ? lastCopy.text : '');
    const copy = text ? readCopiedBlocks(text) : null;
    if (!copy) return;
    event.preventDefault();
    if (readonly || busy) { setMessage(readonly ? 'This canvas is read only. Go back to the current canvas to paste.' : 'Still saving. Paste again in a moment.'); return; }
    const { operations, ids } = pasteOperations(copy, displayed.canvas, detail.project.id, undefined, node => { const shown = flow.getNode(node.id); return shown?.width && shown.height ? { width: shown.width, height: shown.height } : undefined; });
    const title = copy.nodes.find(node => !copy.nodes.some(item => item.id === node.parentId))?.title;
    void mutate(operations, ids.length === 1 ? `Paste ${title}` : `Paste ${ids.length} blocks`).then(saved => {
      if (saved === false) return;
      // Several pasted blocks stay picked, so they can be dragged on together.
      setGroupSelection(selecting || ids.length > 1 ? ids : []); onSelect(selecting || ids.length !== 1 ? null : ids[0]);
      // The nearest free spot can be off screen on a full canvas; then the view moves to the pasted blocks.
      const first = operations.find(op => op.type === 'addNode' && op.node.id === ids[0]), box = area.current?.getBoundingClientRect();
      const at = first?.type === 'addNode' && !first.node.parentId ? flow.flowToScreenPosition({ x: first.node.x, y: first.node.y }) : null;
      if (!at || !box || at.x < box.left || at.y < box.top || at.x > box.right - 120 || at.y > box.bottom - 120) setFrameRequest(ids);
      setMessage(`${ids.length === 1 ? `Pasted ${title}` : `Pasted ${ids.length} blocks`}. Undo takes it away.`);
    });
  };
  const clipboardRef = useRef({ copy: copySelected, paste: pasteCopied }); clipboardRef.current = { copy: copySelected, paste: pasteCopied };
  useEffect(() => {
    const typing = (event: ClipboardEvent) => Boolean((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="dialog"]'));
    const copy = (event: ClipboardEvent) => { if (!typing(event) && !window.getSelection()?.toString()) clipboardRef.current.copy(event); };
    const paste = (event: ClipboardEvent) => { if (!typing(event)) clipboardRef.current.paste(event); };
    document.addEventListener('copy', copy); document.addEventListener('paste', paste);
    return () => { document.removeEventListener('copy', copy); document.removeEventListener('paste', paste); };
  }, []);
  const resultPages = useMemo(() => Object.fromEntries(displayed.canvas.nodes.map(node => {
    const parentId = node.id;
        const runs = detail.runs.filter(r => r.nodeId === parentId && r.status === 'completed');
        const local = runs.filter(r => r.configuration.kind === 'local-experiment').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const research = runs.filter(r => !['local-experiment','external-notebook-capture','notebook-cell'].includes(String(r.configuration.kind)) && r.configuration.purpose !== 'experiment-plan').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const capture = runs.filter(r => r.configuration.kind === 'external-notebook-capture' && detail.artifacts.some(a => a.runId === r.id && isOutputArtifact(a))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const notebookRuns = new Set(runs.filter(r => r.configuration.kind === 'notebook-cell').map(r => r.id));
        const manualBlock = ['code','notebook'].includes(nodeBlockType(node));
        const pinned = highlights.filter(h => h.nodeId === parentId || descendantIds[parentId]?.has(h.nodeId)); const selected = detail.inputs.filter(i => i.nodeId === parentId);
        const artifacts = detail.artifacts.filter(a => (!manualBlock || isOutputArtifact(a)) && (pinned.some(h => h.artifactId === a.id) || selected.some(i => i.artifactId === a.id) || (([local?.id,research?.id,capture?.id].includes(a.runId) || notebookRuns.has(a.runId)) && isOutputArtifact(a)))).sort((a, b) => Number(pinned.some(h => h.artifactId === b.id)) - Number(pinned.some(h => h.artifactId === a.id)));
    return [parentId, resultPage(artifacts, resultChoices[parentId])];
  })), [displayed.canvas.nodes, detail.runs, detail.inputs, detail.artifacts, highlights, resultChoices, descendantIds]);
  // Apps on the canvas read their watched blocks again when the project changes.
  const appWatch = `${detail.project.revision}:${detail.artifacts.length}:${detail.artifacts[0]?.id ?? ''}`;
  const computedNodes = useMemo<(ResearchNode | ArtifactNode)[]>(() => {
    const build = (parentId: string | null, depth = 0): { nodes: (ResearchNode | ArtifactNode)[]; width: number; height: number } => {
      const siblings = displayed.canvas.nodes.filter(n => (n.parentId || null) === parentId).sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
      const built: (ResearchNode | ArtifactNode)[] = []; let right = 0, bottom = 0;
      for (const node of siblings) {
        const expanded = isGroup(node) && expandedIds.includes(node.id); const child = expanded ? build(node.id, depth + 1) : { nodes: [], width: 0, height: 0 };
        const width = expanded ? Math.ceil(Math.max(768, child.width + GROUP_INSET.x * 2) / 24) * 24 : cardSizes[node.id].width;
        const height = expanded ? Math.ceil(Math.max(408, child.height + GROUP_INSET.y + GROUP_FOOTER) / 24) * 24 : cardSizes[node.id].height;
        const draft = expanded ? undefined : draftSizes[node.id], nodeX = node.x + (draft?.dx ?? 0), nodeY = node.y + (draft?.dy ?? 0);
        const box: Box = { x: parentId ? Math.max(0, nodeX) : nodeX, y: parentId ? Math.max(0, nodeY) : nodeY, width, height };
        right = Math.max(right, box.x + width); bottom = Math.max(bottom, box.y + height);
        const runs = detail.runs.filter(r => r.nodeId === node.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); const status = runs.find(r => ['queued', 'running'].includes(r.status))?.status || runs[0]?.status;
        const contained=node.kind==='group'?new Set([node.id,...descendantIds[node.id]]):new Set<string>();
        const latestByBlock=new Map<string,typeof detail.runs[number]>();
        for(const run of [...detail.runs].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)))if(contained.has(run.nodeId)&&!latestByBlock.has(run.nodeId))latestByBlock.set(run.nodeId,run);
        const containedAttempts=[...latestByBlock.values()];
        const pending=containedAttempts.filter(run=>(run.configuration.approval as {status?:string}|undefined)?.status==='pending').length;
        const working=containedAttempts.filter(run=>['running','queued'].includes(run.status)&&(run.configuration.approval as {status?:string}|undefined)?.status!=='pending').length;
        const failed=containedAttempts.filter(run=>['failed','interrupted'].includes(run.status)).length;
        const stopped=containedAttempts.filter(run=>run.status==='cancelled').length;
        const workLabel=[working?`${working} block${working===1?'':'s'} working`:'',pending?`${pending} approval${pending===1?'':'s'} pending`:'',failed?`${failed} block${failed===1?' needs':'s need'} attention`:'',stopped?`${stopped} stopped attempt${stopped===1?'':'s'}`:''].filter(Boolean).join(' · ');
        const effective=modelSettings&&!['code','notebook'].includes(nodeBlockType(node))?resolveModelSetting(modelSettings,displayed.canvas.nodes,node.id):null;
        const selectedProvider=modelSettings?.providers.find(item=>item.id===effective?.selection.provider);
        const selectedModel=selectedProvider?.models.find(item=>item.id===effective?.selection.model);
        const modelTitle=effective?`Selected model: ${selectedProvider?.label??effective.selection.provider} · ${selectedModel?.label??effective.selection.model}${effective.inheritedFrom===node.id?' · task override':effective.inheritedFrom?' · inherited from '+displayed.canvas.nodes.find(item=>item.id===effective.inheritedFrom)?.title:' · project default'}. Saved results retain their original producing model.`:undefined;
        const direction = node.blockType === 'search' || node.label === 'result';
        // A block an agent made says so on its provenance line: a Result note through its link from the Agent block, a finding through its Result note.
        const origin=blockOrigin(displayed.canvas,node.id);
        built.push({ id: node.id, type: 'research', parentId: parentId || undefined, position: { x: box.x + (parentId ? GROUP_INSET.x : 0), y: box.y + (parentId ? GROUP_INSET.y : 0) }, width, height, style: { width, height }, selected: groupSelection.includes(node.id) || node.id === selectedId, zIndex: depth, dragHandle: '.group-heading', data: { workLabel, ...notebookCard(detail, node.id), notion: node.notion ? { projectId: detail.project.id, view: node.notion, onRows: readonly ? undefined : table => rowBlocks(node.id, table) } : undefined, training: node.training ? { projectId: detail.project.id, view: node.training } : undefined, google: node.google ? { projectId: detail.project.id, view: node.google, onCopy: readonly || !onGoogleCopy || node.google.kind !== 'sheet' ? undefined : () => onGoogleCopy(node.id) } : undefined, file: node.file ? shownFile(detail.project.id, node, folderFiles?.get(node.id)) : undefined, origins:Object.fromEntries(displayed.canvas.nodes.map(item=>[item.id,item.title])), blockType:node.blockType, kindName:kindName(node), textLabel:textLabel(node), origin, onLabel:labelMenuOpener(node), code:nodeBlockType(node)==='code'?node.code?.source??detail.artifacts.find(item=>item.id===node.artifactId&&item.kind==='code')?.content??'':undefined, app:node.blockType==='app'?{ projectId: detail.project.id, version: appVersion(node.app?.source ?? ''), inputs: node.app?.inputs.length ?? 0, watchKey: appWatch, onFocus: blockId => { onSelect(blockId); setFocusRequest(blockId); }, ...(historyCanvas ? { still: 'An App from a saved canvas. It runs on the current canvas.' } : proposal && ['added','changed'].includes(displayed.marks.get(node.id) ?? '') ? { proposalId: proposal.id, leaves: appFlags(node.app?.source ?? '') } : {}) }:undefined, primary:isGroup(node)||node.file?undefined:primaryArtifact(node,detail), members:displayed.canvas.nodes.filter(item=>item.parentId===node.id).length, listed:isGroup(node)&&!expanded?groupPreviewMembers(displayed.canvas,node.id).map(({id,title,kind,blockType,google})=>({id,title,kind,blockType,google:google?.kind})):undefined, chosen:(node.groupHighlights??[]).flatMap(highlight=>{const artifact=detail.artifacts.find(item=>item.id===highlight.artifactId&&item.nodeId===highlight.nodeId&&item.hash===highlight.hash);return artifact?[artifact]:[];}), onHighlightOpen:artifact=>onArtifact(artifact,artifact.nodeId), modelLabel:selectedModel?.label??effective?.selection.model, modelTitle, results: resultPages[node.id], onResultChoice: choice => changeResults(node.id, choice), resizePending: resizingCards.includes(node.id), outcome: cardOutcomes[node.id], width: cardSizes[node.id].width, height: cardSizes[node.id].height, heightSet: Boolean(draftSizes[node.id]?.height ?? setCardHeight(node)), onResize: (size, commit) => resizeCard(node.id, size, commit), onAutoHeight: () => fitHeight(node.id), onMeasure: (width, height) => measureCard(node.id, width, height), kind: node.kind, title: node.title, description: node.description, status, awaitingApproval: runs.some(r => (r.configuration.approval as { status?: string } | undefined)?.status === 'pending'), inputCount: detail.inputs.filter(i => i.nodeId === node.id).length, resultCount: detail.artifacts.filter(a => a.nodeId === node.id && isOutputArtifact(a)).length, expanded, preview: displayed.marks.get(node.id), onExpand: () => toggle(node.id), onInspect: () => {const artifact=node.artifactId?detail.artifacts.find(item=>item.id===node.artifactId):undefined;if(artifact&&!['code','notebook','file'].includes(node.blockType??''))onArtifact(artifact,node.id);else onInspect(node.id);}, onActivate: () => onSelect(node.id), onAdd: () => onAdd(node.id), onHandle: side => handleClick(node.id, side), onSave: (title, description) => mutate([{ type: 'updateNode', id: node.id, patch: { title, description } }], 'Edit note'), readonly, fileMissing: missingFiles?.has(node.id), agent: node.agent ? agentTurns?.[node.agent.turnId] : undefined, label: node.label, sources: direction ? detail.artifacts.filter(a => a.nodeId === node.id && a.kind === 'source').sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : undefined, why: direction ? displayed.canvas.connections.find(c => c.target === node.id && displayed.canvas.nodes.find(n => n.id === c.source)?.blockType === 'agent')?.label : undefined, queries: node.label === 'result' ? runs.filter(r => r.provider === 'tavily').map(r => r.request) : undefined, directions: node.blockType === 'agent' ? (({ directions, written, sources, pages, findings }) => ({ total: directions.length, written, sources, pages: pages.length, findings }))(agentDirections(displayed.canvas, detail.artifacts, node.id)) : undefined } }, ...child.nodes);
      }
      return { nodes: built, width: right, height: bottom };
    };
    return build(null).nodes;
  }, [displayed, expandedIds, detail.runs, detail.inputs, detail.artifacts, selectedId, highlights, readonly, pendingConnection, artifactPlacementRevision, cardSizes, draftSizes, cardOutcomes, resizingCards, resultPages, modelSettings, descendantIds, groupSelection, missingFiles, agentTurns, appWatch]);
  const [nodes, setNodes] = useState(computedNodes);
  const liveNodes = useRef(nodes); liveNodes.current = nodes;
  const extraContent = useMemo(() => ({}), []);
  useEffect(() => {
    if (readonly) { reflowState.current = null; return; }
    // Pointer drags/width previews are live UI only. Settle once their saved state
    // arrives, rather than issuing a write for every ResizeObserver notification.
    if (dragging.current || reflowWriting.current || arranging || animatingLayout || Object.keys(draftSizes).length || resizingCards.length) return;
    const source = displayed.canvas;
    const positionKey = (canvas: Canvas) => JSON.stringify(canvas.nodes.map(node => [node.id, node.parentId || null, node.x, node.y]));
    const visible = computedNodes.filter(node => node.type === 'research').sort((a, b) => a.id.localeCompare(b.id));
    const actualSizes = { ...cardSizes, ...Object.fromEntries(visible.map(node => [node.id, { width: node.width!, height: node.height! }])) };
    const sizeKey = (sizes: Record<string, CanvasSize>) => JSON.stringify(visible.map(node => [node.id, sizes[node.id].width, sizes[node.id].height]));
    const positions = positionKey(source), dimensions = sizeKey(actualSizes);
    const structure = JSON.stringify(source.nodes.map(node => [node.id, node.parentId || null]));
    const shape = JSON.stringify([structure, [...expandedIds].sort()]);
    let state = reflowState.current;
    if (!state) {
      state = { plan: createCanvasReflowPlan(source, actualSizes), canvas: source, sizes: actualSizes, positions, dimensions, structure, shape, ready: false };
      reflowState.current = state;
    }
    const shapeChanged = state.shape !== shape, sizeChanged = state.dimensions !== dimensions;
    const previousNodes = new Map(state.canvas.nodes.map(node => [node.id, node]));
    const moved = source.nodes.some(node => {
      const previous = previousNodes.get(node.id);
      return previous && (previous.parentId !== node.parentId || previous.x !== node.x || previous.y !== node.y);
    });
    if (state.positions !== positions && moved) {
      // A user's move or an explicit Arrange establishes a new spatial plan.
      // Newly generated notes alone retain the spacing of existing neighbours.
      state.plan = createCanvasReflowPlan(source, actualSizes);
    } else if (state.structure !== structure) {
      state.plan = extendCanvasReflowPlan(source, { ...actualSizes, ...state.sizes }, state.plan);
    }
    state.positions = positions; state.canvas = source; state.structure = structure;
    if (!state.ready && !shapeChanged) {
      // Initial font/card measurements establish the baseline. Reopening a
      // project never becomes an implicit Arrange or a layout persistence loop.
      state.plan = createCanvasReflowPlan(source, actualSizes); state.dimensions = dimensions; state.sizes = actualSizes;
      const timer = setTimeout(() => { if (reflowState.current === state) state.ready = true; }, 180);
      return () => clearTimeout(timer);
    }
    if (!shapeChanged && !sizeChanged) return;
    const timer = setTimeout(() => {
      if (dragging.current || reflowWriting.current || reflowState.current !== state) return;
      const result = reflowCanvas(source, state.plan, { expandedIds, extraContent, nodeSizes: cardSizes });
      const operations: Mutation[] = result.canvas.nodes.flatMap(node => {
        const before = source.nodes.find(candidate => candidate.id === node.id)!;
        return before.x === node.x && before.y === node.y ? [] : [{ type: 'updateNode' as const, id: node.id, patch: { x: node.x, y: node.y } }];
      });
      state.ready = true; state.shape = shape; state.dimensions = sizeKey(result.sizes); state.positions = positionKey(result.canvas);
      state.canvas = result.canvas; state.sizes = result.sizes;
      if (!operations.length) return;
      reflowWriting.current = true;
      animateNextLayout.current = new Map(result.canvas.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
      const failed = () => {
        animateNextLayout.current = null; state.positions = positions; state.dimensions = dimensions; state.canvas = source; state.sizes = actualSizes;
        setMessage('Automatic spacing could not be saved. Tidy can retry.');
      };
      void mutate(operations, 'Adjust canvas spacing').then(saved => {
        if (saved === false) failed();
      }).catch(failed).finally(() => { reflowWriting.current = false; setReflowRevision(revision => revision + 1); });
    }, 160);
    return () => clearTimeout(timer);
  }, [computedNodes, displayed, expandedIds, extraContent, cardSizes, readonly, arranging, animatingLayout, draftSizes, resizingCards, reflowRevision]);
  useEffect(() => {
    // Blocks being dragged or settling keep their place; the canvas catches up once they come to rest.
    if (dragging.current) { missedLayout.current = true; return; }
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    // A dropped block stays where it settled until the saved canvas that puts it there arrives.
    const shown = saving.current.size ? computedNodes.map(node => { const pending = saving.current.get(node.id); return pending && pending.parentId === (node.parentId ?? null) ? { ...node, position: pending.position } : node; }) : computedNodes;
    const expected = animateNextLayout.current;
    const hasArrived = expected && expected.size === displayed.canvas.nodes.length && displayed.canvas.nodes.every(node => expected.get(node.id)?.x === node.x && expected.get(node.id)?.y === node.y);
    const shouldAnimate = hasArrived && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!shouldAnimate) {
      if (hasArrived) animateNextLayout.current = null;
      const measurements = new Map(liveNodes.current.map(node => [node.id, node.measured]));
      setAnimatingLayout(false); setNodes(shown.map(node => ({ ...node, measured: measurements.get(node.id) }))); return;
    }
    const before = new Map(liveNodes.current.map(node => [node.id, node]));
    const started = performance.now(), duration = 420;
    setAnimatingLayout(true);
    const frame = (time: number) => {
      const progress = Math.min(1, (time - started) / duration), eased = 1 - (1 - progress) ** 3;
      // React Flow invalidates handle bounds if a controlled update drops measured.
      // Keep its latest measurements while ResizeObserver follows changing group sizes.
      const measurements = new Map(liveNodes.current.map(node => [node.id, node.measured]));
      setNodes(shown.map(node => {
        const measured = measurements.get(node.id);
        const original = before.get(node.id); if (!original || progress === 1) return { ...node, measured };
        const width = (original.width || 0) + ((node.width || 0) - (original.width || 0)) * eased;
        const height = (original.height || 0) + ((node.height || 0) - (original.height || 0)) * eased;
        return { ...node, measured, position: { x: original.position.x + (node.position.x - original.position.x) * eased, y: original.position.y + (node.position.y - original.position.y) * eased }, width, height, style: { ...node.style, width, height } };
      }));
      if (progress < 1) animationFrame.current = requestAnimationFrame(frame);
      else { animationFrame.current = null; animateNextLayout.current = null; setAnimatingLayout(false); }
    };
    animationFrame.current = requestAnimationFrame(frame);
    return () => { if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current); };
  }, [computedNodes, layoutRetry]);
  useEffect(() => {
    if (!focusRequest) return;
    const timer = setTimeout(() => {
      void focusReadable(focusRequest);
      setFocusRequest(null);
    }, 90);
    return () => clearTimeout(timer);
  }, [focusRequest, computedNodes]);
  useEffect(() => { if (focusId) setFocusRequest(focusId); }, [focusId]);
  // Shows a set of blocks together once they are on the canvas; a block in a closed group is shown by its group.
  useEffect(() => { if (frame?.ids.length) setFrameRequest(frame.ids); }, [frame]);
  useEffect(() => {
    // Automatic spacing settles first, so the blocks are shown where they end up.
    if (!frameRequest || animatingLayout) return;
    const timer = setTimeout(() => {
      if (reflowWriting.current) return;
      const nodes = displayed.canvas.nodes, shown = new Map<string, Node>();
      for (const id of frameRequest) {
        let node = nodes.find(item => item.id === id);
        if (!node) return;
        while (node && !flow.getNode(node.id)) node = node.parentId ? nodes.find(item => item.id === node!.parentId) : undefined;
        const visible = node && flow.getNode(node.id);
        if (visible) shown.set(visible.id, visible);
      }
      if (shown.size) void showBlocks([...shown.values()], 450, proposalFrame.current ? 420 : 0);
      proposalFrame.current = false; setFrameRequest(null);
    }, 240);
    return () => clearTimeout(timer);
  }, [frameRequest, computedNodes, cardSizes, animatingLayout]);
  // A changed block inside a closed group is pointed at through its group.
  const proposalAnchors = [...new Set(proposalIds.flatMap(id => {
    let node = displayed.canvas.nodes.find(item => item.id === id);
    while (node && !nodes.some(item => item.id === node!.id)) node = node.parentId ? displayed.canvas.nodes.find(item => item.id === node!.parentId) : undefined;
    return node ? [node.id] : [];
  }))];
  // The lines of these relationships, routed around the research blocks in `geometry` (their boxes on the canvas).
  // Original endpoints remain visible in expanded frames; collapsed ancestors aggregate only their hidden contributions.
  const relationshipEdges = (groups: AggregateRelationship[], geometry: RouteNode[]): RoutedEdge[] => {
    const items = groups.flatMap(group => {
      const badge = relationshipBadge(group, displayed.canvas), size = relationshipLabelSize(badge.label);
      const route = routeRelationship({ source: group.source, target: group.target, nodes: geometry.filter(item=>item.id===group.source||item.id===group.target||!expandedIds.includes(item.id)), previous: routeHistory.current.get(group.id), labelSize: badge.label ? { width: size.width + 14, height: 28 } : { width: 0, height: 0 } });
      if (!route) return [];
      routeHistory.current.set(group.id, route);
      return [{ group, ...badge, showLabel: true, route: { ...route } }];
    });
    placeCanvasRelationshipLabels(items, geometry, expandedIds);
    return items.map(({ group, route, label, tooltip, showLabel }) => {
      const selected = group.id === selectedEdge, color = selected ? '#536f69' : '#99a5a2';
      const marker = { type: MarkerType.ArrowClosed, width: 17, height: 17, color };
      const edge: RoutedEdge = { id: group.id, type: 'relationship' as const, source: group.source, target: group.target, sourceHandle: route.sourceHandle, targetHandle: route.targetHandle, selected, zIndex: 1000, ariaLabel: `Inspect relationship: ${tooltip.replace(/\n/gu, ' ')}`, style: { stroke: color, strokeWidth: selected ? 2 : 1.5 }, interactionWidth: 24, markerEnd: marker, ...(group.bidirectional ? { markerStart: marker } : {}), data: { route, label, tooltip, showLabel, onSelect: () => { setSelectedEdge(group.id); setPendingConnection(null); } } };
      // An unchanged edge keeps its object, so dragging one block redraws only the lines that move with it.
      const key = JSON.stringify(edge), shown = shownEdges.current.get(group.id);
      if (shown?.key === key) return shown.edge;
      shownEdges.current.set(group.id, { key, edge });
      return edge;
    });
  };
  const edges = useMemo<RoutedEdge[]>(() => {
    const byId=new Map(nodes.map(node=>[node.id,node]));
    const absolute=(id:string):{x:number;y:number}=>{const node=byId.get(id)!;const parent=node.parentId?absolute(node.parentId):{x:0,y:0};return {x:node.position.x+parent.x,y:node.position.y+parent.y};};
    return relationshipEdges(aggregatedRelationships, nodes.filter(node=>node.type==='research').map(node=>({id:node.id,parentId:node.parentId,...absolute(node.id),width:node.width||CARD_SIZE.width,height:node.height||CARD_SIZE.height})));
  }, [aggregatedRelationships, nodes, selectedEdge, expandedIds, displayed.canvas]);
  // A dragged block moves in React Flow's own store, in the same frame as the pointer, and the canvas around it is
  // not drawn again: only the lines that end on a moving block are routed again. The canvas takes the blocks back
  // once they come to rest (`settled`).
  const followDrag = (changes: NodePositionChange[]) => {
    const state = flowStore.getState();
    state.setNodes(applyNodeChanges(changes, state.nodes));
    const moved = new Set(changes.map(change => change.id)), { nodeLookup } = state;
    const moving = (id: string) => { for (let node = nodeLookup.get(id); node; node = node.parentId ? nodeLookup.get(node.parentId) : undefined) if (moved.has(node.id)) return true; return false; };
    const groups = aggregatedRelationships.filter(group => moving(group.source) || moving(group.target));
    if (!groups.length) return;
    const geometry: RouteNode[] = [...nodeLookup.values()].filter(node => node.type === 'research').map(node => ({ id: node.id, parentId: node.parentId, ...node.internals.positionAbsolute, width: node.width || CARD_SIZE.width, height: node.height || CARD_SIZE.height }));
    const routed = new Map(relationshipEdges(groups, geometry).map(edge => [edge.id, edge]));
    state.setEdges(state.edges.map(edge => routed.get(edge.id) ?? edge));
  };
  // Anything else React Flow reports while blocks move (a measured size, a box being drawn) keeps them where they are shown.
  const keepLive = (current: (ResearchNode | ArtifactNode)[]) => {
    if (!live.current.size) return current;
    const { nodeLookup } = flowStore.getState();
    return current.map(node => { const shown = live.current.has(node.id) ? nodeLookup.get(node.id) : undefined; return shown ? { ...node, position: shown.position, dragging: true } : node; });
  };
  // Dropped blocks glide the last few pixels onto the canvas grid, where they are saved, then the canvas takes them back.
  const settle = (targets: Map<string, XYPosition>) => {
    const { nodeLookup } = flowStore.getState(), from = new Map([...targets].map(([id, to]) => [id, nodeLookup.get(id)?.position ?? to]));
    const started = performance.now(), duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140;
    const step = (time: number) => {
      const progress = duration ? Math.min(1, (time - started) / duration) : 1, eased = 1 - (1 - progress) ** 3;
      followDrag([...targets].map(([id, to]) => { const start = from.get(id)!; return { id, type: 'position' as const, position: { x: start.x + (to.x - start.x) * eased, y: start.y + (to.y - start.y) * eased }, dragging: true }; }));
      if (progress < 1) settling.current = { frame: requestAnimationFrame(step), targets }; else settled(targets);
    };
    settling.current = { frame: requestAnimationFrame(step), targets };
  };
  const settled = (targets: Map<string, XYPosition>) => {
    if (settling.current) cancelAnimationFrame(settling.current.frame);
    settling.current = null; live.current.clear(); dragging.current = false;
    if (targets.size) {
      setNodes(current => keepLive(current.map(node => { const position = targets.get(node.id); return position ? { ...node, position, dragging: false } : node; })));
      setReflowRevision(revision => revision + 1);
    }
    if (missedLayout.current) { missedLayout.current = false; setLayoutRetry(retry => retry + 1); }
  };
  useEffect(() => () => { if (settling.current) cancelAnimationFrame(settling.current.frame); }, []);
  const broader = () => { const selected = displayed.canvas.nodes.find(n => n.id === selectedId); if (selected?.parentId) { onSelect(selected.parentId); setFocusRequest(selected.parentId); } else void fitCanvas(450); };
  const arrange = async () => {
    if (readonly || arranging || animatingLayout) return;
    setArranging(true);
    try {
      const { canvas } = arrangeCanvas(detail.project.canvas, { expandedIds, extraContent, nodeSizes: cardSizes });
      const operations: Mutation[] = canvas.nodes.flatMap(node => {
        const before = detail.project.canvas.nodes.find(n => n.id === node.id)!;
        return node.x === before.x && node.y === before.y ? [] : [{ type: 'updateNode' as const, id: node.id, patch: { x: node.x, y: node.y } }];
      });
      if (!operations.length) setMessage('The canvas is already arranged.');
      else {
        reflowState.current = null;
        animateNextLayout.current = new Map(canvas.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
        if (await mutate(operations, 'Tidy canvas') !== false) setMessage('Blocks tidied. Research content is unchanged.');
        else animateNextLayout.current = null;
      }
    } finally { setArranging(false); }
  };
  const canvasTool = useCanvasTool(), hand = canvasTool.active === 'hand';
  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    if (!onDropFiles || readonly || !Array.from(event.dataTransfer.types).includes('Files')) return false;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; return true;
  };
  // React Flow redraws every block when a handler it is given changes, so it gets handlers that
  // keep their identity and call the latest code; a drag then redraws only the block that moves.
  const flowHandlers = useStableHandlers<FlowHandlers>({
    onNodesChange: changes => {
      // The canvas keeps its own selection (a click, the Group picker, a selection box); React Flow's is followed only while a box is drawn.
      const kept = changes.filter(change => change.type !== 'select' || boxSelecting.current);
      if (!kept.length) return;
      if (kept.every(change => change.type === 'position' && (change.dragging || live.current.has(change.id)))) { followDrag(kept.map(change => ({ ...change as NodePositionChange, dragging: true }))); return; }
      setNodes(current => keepLive(applyNodeChanges(kept, current)));
    },
    onNodeClick: (event, node) => {
      if ((event.target as HTMLElement).closest('.relationship-handle')) return;
      if (node.type === 'research') {
        if (pendingConnection && pendingConnection.nodeId !== node.id) connect(pendingConnection.nodeId, node.id, pendingConnection.side);
        else if (selecting) setGroupSelection(ids => ids.includes(node.id) ? ids.filter(id => id !== node.id) : [...ids, node.id]);
        // Shift or ⌘ adds a block to the picked ones, or takes it out again.
        else if (event.shiftKey || event.metaKey || event.ctrlKey) { const next = picked.includes(node.id) ? picked.filter(id => id !== node.id) : [...picked, node.id]; setGroupSelection(next.length > 1 ? next : []); onSelect(next.length === 1 ? next[0] : null); }
        else { if (groupSelection.length) setGroupSelection([]); onSelect(node.id); }
      }
      setSelectedEdge(null);
    },
    onNodeDoubleClick: (event, node) => { if ((event.target as HTMLElement).closest('input,textarea,button,.inline-note-editor')) return; if (node.type === 'research') { if(isGroup(displayed.canvas.nodes.find(item=>item.id===node.id)!)) toggle(node.id); else {const contentNode=displayed.canvas.nodes.find(item=>item.id===node.id),artifact=detail.artifacts.find(item=>item.id===contentNode?.artifactId);if(artifact&&!['code','notebook','file'].includes(contentNode?.blockType??''))onArtifact(artifact,node.id);else onInspect(node.id);} } else onArtifact(node.data.artifact, node.data.destinationId); },
    onPaneClick: () => { if(!selecting)setGroupSelection([]); onSelect(null); setSelectedEdge(null); setPendingConnection(null); closeLabelMenu(); },
    onEdgeClick: (_, edge) => { setSelectedEdge(edge.id); setPendingConnection(null); },
    onEdgeDoubleClick: (_, edge) => { setSelectedEdge(edge.id); setPendingConnection(null); },
    onSelectionStart: () => { boxSelecting.current = true; },
    onSelectionEnd: () => {
      boxSelecting.current = false;
      const boxed = [...flowStore.getState().nodeLookup.values()].filter(item => item.selected && item.type === 'research').map(item => item.id);
      if (selecting) { setGroupSelection(ids => [...new Set([...ids, ...boxed])]); return; }
      setGroupSelection(boxed.length > 1 ? boxed : []); onSelect(boxed.length === 1 ? boxed[0] : null); setSelectedEdge(null);
    },
    onNodeDragStart: (_, __, dragged) => {
      // A block grabbed again while it settles stops gliding where it is.
      if (settling.current) settled(settling.current.targets);
      dragging.current = true; dragFrom.current = new Map(dragged.map(item => [item.id, item.position]));
      for (const item of dragged) live.current.add(item.id);
      setReflowRevision(revision => revision + 1);
    },
    onNodeDrag: (event, node, dragged) => {
      if (readonly || node.type !== 'research') return;
      const blocks = dragged.filter(item => item.type === 'research'), parents = new Set(blocks.map(item => item.parentId ?? null));
      const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
      const target = parents.size === 1 ? groupAt(flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY }), blocks.map(item => item.id)) : null;
      const nextId = target && !parents.has(target.id) ? target.id : null;
      if (nextId === dropTargetId.current) return;
      dropTargetId.current = nextId;
      if (!target || !nextId) { setDropTarget(null); return; }
      const box = area.current?.getBoundingClientRect(), origin = flow.flowToScreenPosition(target.absolute), corner = flow.flowToScreenPosition({ x: target.absolute.x + target.width, y: target.absolute.y + target.height });
      setDropTarget({ id: nextId, left: origin.x - (box?.left ?? 0), top: origin.y - (box?.top ?? 0), width: corner.x - origin.x, height: corner.y - origin.y });
    },
    onNodeDragStop: (event, node, dragged) => {
      dropTargetId.current = null; setDropTarget(null);
      const pointer = 'changedTouches' in event ? event.changedTouches[0] : event, point = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
      if (node.type === 'artifact') {
        settled(new Map());
        const from = dragFrom.current.get(node.id);
        if (from && from.x === node.position.x && from.y === node.position.y) return;
        const targets = flow.getNodes().filter(n => n.type === 'research' && expandedIds.includes(n.id) && n.id !== node.parentId).map(n => ({ node: n, absolute: flow.getInternalNode(n.id)?.internals.positionAbsolute })).filter(({ node: n, absolute: p }) => p && point.x >= p.x && point.x <= p.x + (n.width || 0) && point.y >= p.y && point.y <= p.y + (n.height || 0)); const target = targets.at(-1)?.node;
        if (target) { onReuse(node.data.artifact, target.id); setNodes(computedNodes); }
        else if (resultPages[node.data.destinationId]?.size !== 'all') { setNodes(computedNodes); }
        else { const position = { x: Math.max(GROUP_INSET.x, node.position.x), y: Math.max(GROUP_INSET.y, node.position.y) }; saveLocal(`artifact-group-position:${node.data.destinationId}:${node.data.artifact.id}`, position); setArtifactPlacementRevision(revision => revision + 1); const highlight = highlights.find(h => h.nodeId === node.data.destinationId && h.artifactId === node.data.artifact.id); if (highlight) onMoveHighlight(highlight.id, node.data.destinationId, position); setNodes(current => current.map(n => n.id === node.id ? { ...n, position } : n)); }
        return;
      }
      // A drag starts as the button goes down, so the block stays exactly under the pointer; a click moves nothing.
      const blocks = dragged.filter(item => item.type === 'research'), moved = blocks.some(item => { const from = dragFrom.current.get(item.id); return !from || from.x !== item.position.x || from.y !== item.position.y; });
      if (readonly || !moved) { settled(new Map()); return; }
      // Dropped together on an expanded Group, the blocks join it; dragged out past its edge, they leave. Otherwise they only move.
      const { nodeLookup } = flowStore.getState(), at = (id?: string | null) => (id ? nodeLookup.get(id)?.internals.positionAbsolute : undefined) ?? { x: 0, y: 0 };
      const parents = new Set(blocks.map(item => item.parentId ?? null)), target = parents.size === 1 ? groupAt(point, blocks.map(item => item.id)) : null;
      const regroup = parents.size === 1 && !parents.has(target?.id ?? null);
      const targets = new Map<string, XYPosition>(), operations: Mutation[] = [];
      for (const item of blocks) {
        const absolute = at(item.id), parentId = regroup ? target?.id ?? null : item.parentId ?? null, parent = at(parentId);
        const saved = savedCanvasPosition({ x: absolute.x - parent.x, y: absolute.y - parent.y }, Boolean(parentId));
        // Where the block comes to rest on the grid, in the frame it is drawn in until the saved canvas arrives.
        const rest = parentId ? { x: parent.x + GROUP_INSET.x + saved.x, y: parent.y + GROUP_INSET.y + saved.y } : saved, frame = at(item.parentId);
        const position = { x: rest.x - frame.x, y: rest.y - frame.y };
        targets.set(item.id, position); saving.current.set(item.id, { parentId: item.parentId ?? null, position });
        operations.push({ type: 'updateNode', id: item.id, patch: regroup ? { parentId, ...saved } : saved });
      }
      settle(targets);
      const label = regroup ? (target ? 'Move into a group' : 'Move out of its group') : blocks.length === 1 ? 'Move note' : `Move ${blocks.length} blocks`;
      void mutate(operations, label).finally(() => {
        for (const [id, position] of targets) if (saving.current.get(id)?.position === position) saving.current.delete(id);
        setReflowRevision(revision => revision + 1);
      });
    },
    onConnect: c => { if (c.source && c.target) connect(c.source, c.target, c.sourceHandle as Side | undefined, c.targetHandle as Side | undefined); },
    onConnectEnd: (event, state) => {
      if (state.isValid || !state.fromNode || readonly) return;
      const target = (event.target as HTMLElement | null)?.closest?.('.react-flow__node-research')?.getAttribute('data-id');
      if (target && target !== state.fromNode.id) connect(state.fromNode.id, target, state.fromHandle?.id as Side || 'right');
    },
    onMoveStart: closeLabelMenu,
    onMoveEnd: (_, view) => saveLocal(viewKey, view),
  });
  return <div ref={area} className={`canvas-area unified-canvas direct-canvas ${pendingConnection ? 'is-connecting' : ''} ${arranging || animatingLayout ? 'is-arranging' : ''}${proposal && !historyCanvas ? ' previewing-proposal' : ''}${dropping ? ' canvas-drop-target' : ''} ${hand ? 'canvas-hand-tool' : 'canvas-move-tool'}${canvasTool.spaceHeld ? ' canvas-space-pan' : ''}`} data-testid="canvas"
    onDragOver={event => { if (dropFiles(event) && !dropping) setDropping(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDropping(false); }}
    onDrop={event => { setDropping(false); if (!dropFiles(event)) return; onDropFiles!(Array.from(event.dataTransfer.files), flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
    <ReactFlow<ResearchNode | ArtifactNode, RoutedEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} {...flowHandlers}
      connectionMode={ConnectionMode.Loose} connectOnClick={false} connectionRadius={28} nodesDraggable={!readonly && !animatingLayout} nodeDragThreshold={0} nodesConnectable={!readonly} selectNodesOnDrag={false}
      panOnDrag={hand || readonly ? true : [1]} selectionOnDrag={!hand && !readonly} selectionMode={SelectionMode.Partial} panOnScroll panOnScrollSpeed={1} zoomOnPinch deleteKeyCode={null} minZoom={.08} maxZoom={1.8} defaultViewport={viewport.current} zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#b8b8b8" bgColor="#ffffff"/><CanvasMinimap/>{proposalCard && proposalAnchors.length > 0 && <NodeToolbar nodeId={proposalAnchors} isVisible position={Position.Right} align="start" offset={20} className="proposal-anchor nodrag nopan nowheel">{proposalCard}</NodeToolbar>}</ReactFlow>
    <div className="canvas-header">
      <div className="canvas-context"><span className="eyebrow"><span className="live-dot"/>{historyCanvas ? 'Saved canvas · read only' : proposal ? 'Proposed changes' : 'Research canvas'}</span><span>{displayed.canvas.nodes.filter(node=>!isGroup(node)).length} blocks · {displayed.canvas.nodes.filter(isGroup).length} groups</span></div>
      <div className="canvas-edit-controls nodrag nopan" role="toolbar" aria-label="Canvas editing">
        <CanvasToolSwitch tool={canvasTool.tool} onChange={canvasTool.setTool}/>
        <button className="secondary small canvas-add-button" data-testid="add-node" aria-label={selectedGroup?`Add a block inside ${selectedGroup.title}`:"Add block to canvas"} disabled={readonly||busy} onClick={()=>onAdd(selectedGroup?.id??null)}><Plus size={15}/> {selectedGroup?"Add inside":"Add block"}</button>
        {onUndo&&<button className="icon-button" aria-label="Undo canvas change" title={`Undo canvas change (${modKey}Z)`} disabled={!detail.canUndo||readonly||busy} onClick={onUndo}><Undo2 size={16}/></button>}
        {onRedo&&<button className="icon-button" aria-label="Redo canvas change" title={`Redo canvas change (${modKey === '⌘' ? '⌘⇧Z' : 'Ctrl+Shift+Z'})`} disabled={!detail.canRedo||readonly||busy} onClick={onRedo}><Redo2 size={16}/></button>}
        {onHistory&&<button className={`icon-button ${historyOpen?'active':''}`} aria-label="Canvas history" title="Canvas content history" aria-expanded={historyOpen} aria-controls="canvas-content-history" onClick={onHistory}><History size={16}/></button>}
        {onDemo&&<button className="secondary small canvas-add-button" onClick={onDemo}><BookOpen size={14}/>{demoLabel}</button>}
        {onTour&&<button className="icon-button" title="Tour saved research" aria-label="Start guided demo" onClick={onTour}><BookOpen size={17}/></button>}
      </div>
      {showStageNavigation && <nav className="canvas-stage-navigation" aria-label="Research stages">{rootStages.map((node, index) => <button key={node.id} className={selectedId === node.id ? 'active' : ''} aria-label={`Focus stage: ${node.title}`} title={node.title} onClick={() => { onSelect(node.id); setFocusRequest(node.id); }}><span>{/^\s*\d+[.·:—–)\s]/u.test(node.title) ? node.title : `${index + 1} · ${node.title}`}</span></button>)}</nav>}
    </div>
    <CanvasDock label="Canvas tools" items={[
      { id: 'group', label: selecting ? 'Done' : 'Group', hint: selecting ? 'Stop picking blocks.' : 'Pick blocks, then put them in a group.', icon: <BoxSelect size={19}/>, pressed: selecting, disabled: readonly, onClick: () => { setSelecting(!selecting); setGroupSelection([]); onSelect(null); } },
      ...(selectedGroup ? [{ id: 'ungroup', label: 'Ungroup', hint: 'Dissolve the selected group. Its blocks stay where they are.', icon: <Ungroup size={19}/>, disabled: busy, onClick: () => { void mutate(ungroupOperations(displayed.canvas, selectedGroup), 'Ungroup').then(saved => { if (saved !== false) { onExpandedChange(expandedIds.filter(id => id !== selectedGroup.id)); onSelect(null); setMessage('Group dissolved. Its blocks and its text stay.'); } }); } }] : []),
      { id: 'up', label: 'Up a level', hint: 'Go to the group around the selected block.', icon: <CornerLeftUp size={19}/>, onClick: broader },
      { id: 'tidy', label: 'Tidy', hint: 'Line blocks up so nothing overlaps.', icon: arranging || animatingLayout ? <LoaderCircle size={19} className="spin"/> : <LayoutGrid size={19}/>, disabled: readonly || arranging || animatingLayout || !displayed.canvas.nodes.length, onClick: () => void arrange() },
      { id: 'delete', label: 'Delete', hint: deletable.length > 1 ? `Delete the ${deletable.length} picked blocks (⌫).` : 'Delete the selected block (⌫).', icon: <Trash2 size={19}/>, disabled: !deletable.length, onClick: removeSelected },
      { id: 'all', label: 'See all', hint: 'Zoom out to show every block.', icon: <Maximize size={19}/>, onClick: () => void fitCanvas(400, true) },
      { id: 'collapse', label: 'Collapse', hint: 'Close every open group.', icon: <PanelTopClose size={19}/>, disabled: !expandedIds.length, onClick: () => { onExpandedChange([]); onSelect(null); } },
    ]}/>
    {labelMenu && (() => { const target = displayed.canvas.nodes.find(node => node.id === labelMenu.nodeId); return target ? <LabelMenu key={target.id} node={target} left={labelMenu.left} top={labelMenu.top} onClose={closeLabelMenu} onPick={value => { closeLabelMenu(); void mutate([{ type: 'updateNode', id: target.id, patch: labelPatch(target, value) }], value ? `Label as ${value.trim().slice(0, 40)}` : 'Remove label'); }}/> : null; })()}
    {dropTarget && <div className="drop-target-outline" style={{ left: dropTarget.left, top: dropTarget.top, width: dropTarget.width, height: dropTarget.height }}/>}
    {!nodes.length && <div className="canvas-empty"><BookOpen size={34} strokeWidth={1.2}/><h2>Give a question room.</h2><p>Add what you know, or a task to explore what you don’t.</p></div>}
    {selecting&&<div className="canvas-group-toolbar nodrag nopan"><span>{groupSelection.length} selected · click blocks</span><input aria-label="New group title" value={groupName} maxLength={200} onChange={event=>setGroupName(event.target.value)}/><button className="primary small" disabled={!groupSelection.length||!groupName.trim()} onClick={()=>{try{const id=crypto.randomUUID(),operations=createGroupOperations(displayed.canvas,groupSelection,id,groupName.trim());void mutate(operations,'Group selected blocks').then(saved=>{if(saved!==false){setSelecting(false);setGroupSelection([]);onExpandedChange([...expandedIds,id]);onSelect(id);setMessage('Group created. Models and authority retained.');}});}catch(error){setMessage(error instanceof Error?error.message:String(error));}}}>Group selected</button></div>}
    {pendingConnection && <div className="connection-instruction" role="status"><GitBranch size={16}/><span>Choose another note to connect</span><button className="icon-button" aria-label="Cancel connection" onClick={() => setPendingConnection(null)}><X size={15}/></button></div>}
    {selectedAggregate && <section className="aggregate-relationships nodrag nopan nowheel" role="dialog" aria-modal="false" aria-label="Contributing relationships">
      <header><GitBranch size={17}/><strong>{selectedAggregate.label}</strong><button className="icon-button" aria-label="Close contributing relationships" onClick={() => setSelectedEdge(null)}><X size={16}/></button></header>
      <p>{displayed.canvas.nodes.find(node => node.id === selectedAggregate.source)?.title} {selectedAggregate.bidirectional ? '↔' : '→'} {displayed.canvas.nodes.find(node => node.id === selectedAggregate.target)?.title}</p>
      <p>{selectedAggregate.bidirectional ? 'Contributions run in both directions.' : 'Contributions share one direction.'} Each relationship below retains its original endpoints and wording.</p>
      <ol>{selectedAggregate.contributions.map(({ connection, sourceTitle, targetTitle }) => <li key={connection.id}>
        <strong>{connection.label || 'Unlabelled relationship'}</strong><p>{sourceTitle} → {targetTitle}</p>
        <div className="contribution-actions"><button className="text-button" aria-label={`Inspect source: ${sourceTitle}`} onClick={() => { setSelectedEdge(null); onInspect(connection.source); }}>Inspect source note</button><button className="text-button" aria-label={`Inspect target: ${targetTitle}`} onClick={() => { setSelectedEdge(null); onInspect(connection.target); }}>Inspect target note</button></div>
      </li>)}</ol>
    </section>}
    <div className="canvas-notices">{notices}{proposalCard && !proposalAnchors.length && proposalCard}{message && <div className="canvas-notice canvas-feedback" role="status">{message}</div>}</div>
    <div className="canvas-tools"><button className="icon-button" aria-label="Zoom out" onClick={() => void flow.zoomOut({ duration: 180 })}><Minus size={17}/></button><button className="icon-button" aria-label="Fit canvas" title="Fit at readable zoom; See all shows everything" onClick={() => void fitCanvas()}><Focus size={18}/></button><button className="icon-button" aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration: 180 })}><Plus size={17}/></button></div><div className="canvas-hint">Double-click to open content · Groups expand with their arrow · drag to arrange</div>
  </div>;
}
export function ResearchCanvas(props: Props) { return <ReactFlowProvider key={props.detail.project.id}><FlowCanvas {...props}/></ReactFlowProvider>; }
