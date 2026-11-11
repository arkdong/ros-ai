import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { Background, BackgroundVariant, BaseEdge, ConnectionMode, EdgeLabelRenderer, Handle, MarkerType, NodeToolbar, Position, ReactFlow, ReactFlowProvider, SelectionMode, applyNodeChanges, useReactFlow, useStoreApi, type Edge, type EdgeProps, type Node, type NodePositionChange, type NodeProps, type ReactFlowProps, type Viewport, type XYPosition } from '@xyflow/react';
import { Share as ShareIcon, Activity, Minimize2, AppWindow, LayoutDashboard, ArrowUpRight, MapPinned, BookOpen, Bot, Check, Globe, Quote, Search as SearchIcon, BoxSelect, Braces, Database, Text as TextIcon, File as FileIcon, NotebookPen, ArrowLeftRight, ChevronDown, ChevronUp, CornerLeftUp, Focus, GitBranch, Hand, History, LayoutGrid, LoaderCircle, Maximize, Minus, MousePointer2, PanelTopClose, Plus, Redo2, Trash2, Undo2, Ungroup, X } from 'lucide-react';
import { BrandLogo } from './brand-logos';
import { NotionBlock, type RowBlocksOutcome } from './NotionView';
import { GoogleBlock } from './GoogleView';
import { MapBlock } from './MapView';
import { TrainingBlock } from './TrainingView';
import { MetricBlock, MetricLogo } from './MetricView';
import { DashboardBlock, type DashboardSource } from './DashboardView';
import { dashboardSources } from './dashboard-pins';
import { PostCard, PostLogo } from './PostView';
import { rowBlockOperations } from '../shared/notion-rows';
import { MarkdownPreview } from './Content';
import { agentDirections, RESULT_PLACEHOLDER, splitSources, webState } from '../shared/agent-work';
import { WebFace, type WebFaceData } from './WebBlock';
import { VERDICT_ORDER, VERDICT_WORDS, checkTally } from '../shared/source-check';
import { TEXT_LABELS, blockOrigin, kindName, labelFixed, labelPatch, textLabel } from '../shared/vocabulary';
import { api } from './api';
import type { ExperimentCapabilities } from '../shared/experiments';
import { deriveGroupOutcomes, type CardOutcome, type CardOutcomeOptions } from '../shared/card-outcome';
import { CARD_MAX_HEIGHT, CARD_MAX_SET_HEIGHT, CARD_MIN_HEIGHT, CARD_MIN_WIDTH, CARD_MAX_WIDTH, CARD_SCALES, cardScale, cardFootprintHeight, cardWidth, initialCardSize, measuredCardHeight, pictureCardHeight, pictureMinWidth, setCardHeight } from '../shared/card-size';
import { layoutOnly, savedCanvasPosition } from '../shared/canvas-position';
import { createCanvasReflowPlan, extendCanvasReflowPlan, reflowCanvas, unsettled, type CanvasReflowPlan } from '../shared/canvas-reflow';
import { resultPage, type ResultPageChoice } from '../shared/result-pages';
import { aggregateTopLevelRelationships, linkWord, type AggregateRelationship } from '../shared/aggregate-relationships';
import { LINK_WORDS, LINK_WORD_LIMIT, chipPoint, facingSides, isTrail, linkCurve, sideAnchor, sideFraction, trailWording, type LinkBox, type LinkPoint, type LinkSide } from '../shared/links';
import { readSaved, saveLocal } from './persistence';
import { arrangeCanvas, freeSpot, groupContentRight, numberedStageOrder, openGroupSize, CARD_SIZE, GROUP_INSET, LAYOUT_GAP, type CanvasSize } from '../shared/layout';
import type { Artifact, Canvas, CanvasNode, ClaimVerdict, DashboardView, GoogleView, MapView, MetricSource, MetricView, PostPlatform, PostView, TrainingView, Mutation, NotionTable, NotionView, ProjectDetail, Proposal, RunStatus } from '../shared/types';
import type { NotebookSummary } from '../shared/notebooks';
import { textPreview } from '../shared/presentation';
import './canvas-interactions.css';
import './canvas-reading.css';
import './canvas-evidence.css';
import './groups.css';
import './links.css';
import './agent-view.css';
import './source-check.css';
import { GROUP_PREVIEW_MEMBERS, convertLegacyGroups, createGroupOperations, groupKeepsNote, groupMembers, groupPreviewMembers, isGroup, ungroupOperations } from '../shared/groups';
import { isOutputArtifact, nodeBlockType, primaryArtifact } from '../shared/blocks';
import { BlockPreview, artifactFacts } from './BlockPreview';
import { PartBoundary } from './ErrorBoundary';
import { AddBlockMenu } from './AddBlockMenu';
import type { KindId } from './block-kinds';
import { AppFrame } from './AppFrame';
import { appFlags, appVersion, type AppFlag } from '../shared/apps';
import { FilePreview, type ShownFile } from './FileView';
import { fileMediaType, fileUrl, isPictureNode, isVideoType, type ImageSize } from '../shared/files';
import type { FolderFile } from '../shared/project-folders';
import { BLOCKS_MIME, copyBlocks, pasteOperations, readCopiedBlocks } from '../shared/canvas-clipboard';
import { CodeView, modKey } from './code';
import { CanvasDock, type DockItem } from './CanvasDock';
import { CanvasMinimap } from './CanvasMinimap';
import { useCanvasTool } from './CanvasTool';

function notebookCard(detail: ProjectDetail, nodeId: string): Pick<CardData, 'notebook' | 'notebookFigure'> {
  const notebook = detail.notebooks?.find(item => item.nodeId === nodeId);
  if (!notebook) return {};
  return { notebook, ...(notebook.figure ? { notebookFigure: `/api/projects/${encodeURIComponent(detail.project.id)}/nodes/${encodeURIComponent(nodeId)}/notebook/figure?h=${notebook.figure}` } : {}) };
}
/** The address, type and size of the file a File block shows, and a picture's pixel size from the folder or, failing
 * that, from the picture once it loaded; the address carries the file's version so a replaced file is read again. */
export function shownFile(projectId: string, node: CanvasNode, entry?: FolderFile, loaded?: ImageSize): ShownFile {
  const image = entry?.image ?? loaded;
  return { src: `${fileUrl(projectId, node.id)}${entry?.version ? `?v=${entry.version}` : ''}`, mediaType: fileMediaType(node.file?.path ?? '') ?? 'application/octet-stream', ...(entry?.bytes ? { bytes: entry.bytes } : {}), ...(image ? { image } : {}), ...(entry?.seconds !== undefined ? { seconds: entry.seconds } : {}) };
}
/** One icon per kind of block; a Text block's label says what it means. A Google block shows its app's mark. */
export function KindIcon({ kind, blockType, google, map, metric, post, size = 14 }: { kind?: string; blockType?: string; google?: GoogleView['kind']; map?: MapView['provider']; metric?: MetricSource; post?: PostPlatform; size?: number }) {
  if (blockType === 'notion') return <BrandLogo id="notion" size={size}/>;
  if (blockType === 'post' && post) return <PostLogo platform={post} size={size}/>;
  if (blockType === 'metric' && metric) return <MetricLogo source={metric} size={size}/>;
  if (blockType === 'training') return <BrandLogo id="nebius" size={size}/>;
  if (blockType === 'map' && map === 'google') return <BrandLogo id="google-maps" size={size}/>;
  if (blockType === 'google') return <BrandLogo id={google === 'sheet' ? 'google-sheets' : google === 'doc' ? 'google-docs' : 'google-drive'} size={size}/>;
  const Icon = kind === 'group' ? LayoutGrid : blockType === 'metric' ? Activity : blockType === 'dashboard' ? LayoutDashboard : blockType === 'code' ? Braces : blockType === 'app' ? AppWindow : blockType === 'notebook' ? NotebookPen : blockType === 'dataset' ? Database : blockType === 'figure' || blockType === 'file' ? FileIcon : blockType === 'agent' ? Bot : blockType === 'search' ? SearchIcon : blockType === 'web' ? Globe : blockType === 'map' ? MapPinned : TextIcon;
  return <Icon size={size}/>;
}
type Side = 'top' | 'right' | 'bottom' | 'left';
const sides: { id: Side; position: Position }[] = [{ id: 'top', position: Position.Top }, { id: 'right', position: Position.Right }, { id: 'bottom', position: Position.Bottom }, { id: 'left', position: Position.Left }];
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
  /** A Map block's pins. */
  map?: MapView;
  /** A model training run the card reads live from its folder and GPU machine. */
  training?: { projectId: string; view: TrainingView };
  /** Launch numbers the card reads live from a service. */
  metric?: { projectId: string; view: MetricView };
  /** The numbers a Dashboard block pins from other blocks, and those blocks' titles. */
  dashboard?: { projectId: string; view: DashboardView; sources: DashboardSource[] };
  /** A post read from its platform, shown as the platform shows it. */
  post?: { projectId: string; view: PostView };
  /** The PDF or image a File block shows, read from the project folder. */
  file?: ShownFile;
  /** A File block whose file is a picture: the card is the picture, with no frame, and keeps the picture's shape. */
  picture?: boolean;
  /** Hears a picture's pixel size once it loaded, when the folder could not tell it. */
  onPictureSize?: (size: ImageSize) => void;
  /** The blocks a collapsed Group lists on its card. */
  listed?: { id: string; title: string; kind?: string; blockType?: string; google?: GoogleView['kind']; metric?: MetricSource; post?: PostPlatform }[];
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
  /** `width` and `height` are the card's own size; a shrunk block draws it at `scale` (below 1) on the map. */
  outcome: CardOutcome; width: number; height: number; scale?: number; heightSet: boolean; resizePending: boolean;
  fileMissing?: boolean;
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
  /** How many claims of the block carry each mark, after an agent checked them on the web (on the Agent block: the claims it checked). */
  check?: Record<ClaimVerdict, number>;
  /** An Agent block's searches so far, the pages it read and the findings it saved. */
  directions?: { total: number; written: number; sources: number; pages: number; findings: number };
  /** A Web block's directions and the pages its searches found. */
  web?: WebFaceData;
};
type AgentTurnSummary = { status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; runtime: string; thought?: string; pending: number };
const agentState = { running: 'Working', completed: 'Finished', failed: 'Stopped with an error', cancelled: 'Stopped', interrupted: 'Interrupted' } as const;
/** The quiet last line of a card: which agent made the block and what it rests on (sources, results, the saved version). */
function Provenance({data,appErrors}:{data:CardData;appErrors?:string[]}){
  const parts:ReactNode[]=[];
  if(data.origin)parts.push(<small key="origin">{data.origin}</small>);
  if(data.app){
    parts.push(<small key="reads">{data.app.inputs?`reads ${data.app.inputs} block${data.app.inputs===1?'':'s'}`:'reads no blocks'}</small>);
    if(appErrors?.length)parts.push(<small key="errors" className="app-error" title={appErrors.join('\n')}>{appErrors.length} error{appErrors.length===1?'':'s'}</small>);
    return <div className="outcome-footer provenance">{parts}</div>;
  }
  const searching=data.blockType==='search'||(data.label==='result'&&data.description===RESULT_PLACEHOLDER);
  if(searching){if(data.sources?.length)parts.push(<small key="found">{data.sources.length} source{data.sources.length===1?'':'s'} found</small>);}
  else if(!data.primary&&data.blockType!=='agent'){const {sources,hosts}=splitSources(data.description);if(sources>0)parts.push(<small key="cited">{data.blockType==='finding'&&hosts.length?`From ${hosts.join(', ')}`:`${sources} source${sources===1?'':'s'} cited`}</small>);}
  if(data.resultCount>0)parts.push(<small key="results">{data.resultCount} result{data.resultCount===1?'':'s'}</small>);
  if(data.primary&&['failed','interrupted','cancelled','queued','running'].includes(data.status??''))parts.push(<small key="version" className="block-version">Earlier saved result</small>);
  return parts.length?<div className="outcome-footer provenance">{parts}</div>:null;
}
type ResearchNode = Node<CardData, 'research'>;
/** A card being resized: its new size, and how far its top left corner moved when it was pulled from the left or top. */
type CardResize = { width: number; height?: number; dx: number; dy: number };
/** The edges and corners a card is resized from. A closed Group fits what it lists and is not resized. */
const RESIZE_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
type ResizeEdge = typeof RESIZE_EDGES[number];
const RESIZE_GRID = 24;
/** The card's size while one of its edges or corners is dragged. Pulled from the left or top, the opposite edge stays
 * put and the move keeps to the canvas grid, as every saved position does. A picture card keeps its picture's shape:
 * its sides and corners set the width and the height follows; its top and bottom edges set the height and the width follows. */
function resizedCard(edge: ResizeEdge, start: { width: number; height: number }, dx: number, dy: number, image?: ImageSize): CardResize {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));
  let width = start.width, height: number | undefined, moveX = 0, moveY = 0;
  if (image) {
    const narrowest = pictureMinWidth(image);
    if (edge === 'n' || edge === 's') {
      const wanted = clamp(start.height + (edge === 's' ? dy : -dy), 1, CARD_MAX_SET_HEIGHT);
      width = clamp((wanted - 2) * image.width / Math.max(1, image.height) + 2, narrowest, CARD_MAX_WIDTH);
    } else if (edge.includes('e')) width = clamp(start.width + dx, narrowest, CARD_MAX_WIDTH);
    else { moveX = Math.max(start.width - CARD_MAX_WIDTH, Math.min(start.width - narrowest, Math.round(dx / RESIZE_GRID) * RESIZE_GRID)); width = start.width - moveX; }
    height = pictureCardHeight(width, image);
    if (edge.startsWith('n')) moveY = Math.round((start.height - height) / RESIZE_GRID) * RESIZE_GRID;
    return { width, height, dx: moveX, dy: moveY };
  }
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
const ShownFilePreview = memo(FilePreview, (a, b) => a.title === b.title && a.file.src === b.file.src && a.file.mediaType === b.file.mediaType && a.file.bytes === b.file.bytes && a.file.image?.width === b.file.image?.width && a.file.image?.height === b.file.image?.height && a.file.seconds === b.file.seconds && a.missing === b.missing);
const ShownNotion = memo(NotionBlock, (a, b) => a.projectId === b.projectId && a.nodeId === b.nodeId && a.full === b.full && Boolean(a.onRows) === Boolean(b.onRows) && JSON.stringify(a.view) === JSON.stringify(b.view));
const ShownDashboard = memo(DashboardBlock, (a, b) => a.projectId === b.projectId && a.full === b.full && JSON.stringify(a.view) === JSON.stringify(b.view) && JSON.stringify(a.sources) === JSON.stringify(b.sources));
const ShownMetric = memo(MetricBlock, (a, b) => a.projectId === b.projectId && a.nodeId === b.nodeId && a.full === b.full && a.title === b.title && JSON.stringify(a.view) === JSON.stringify(b.view));
const ShownTraining = memo(TrainingBlock, (a, b) => a.projectId === b.projectId && a.nodeId === b.nodeId && a.full === b.full && JSON.stringify(a.view) === JSON.stringify(b.view));
const ShownMap = memo(MapBlock, (a, b) => a.full === b.full && JSON.stringify(a.view) === JSON.stringify(b.view));
const ShownGoogle = memo(GoogleBlock, (a, b) => a.projectId === b.projectId && a.nodeId === b.nodeId && a.full === b.full && Boolean(a.onCopy) === Boolean(b.onCopy) && JSON.stringify(a.view) === JSON.stringify(b.view));
/** A checked block's marks, worst first: how many claims a source contradicts, how many none backs, how many hold. */
function CheckTally({ tally }: { tally: Record<ClaimVerdict, number> }) {
  return <div className="check-tally" aria-label="Sources checked">{VERDICT_ORDER.filter(verdict => tally[verdict] > 0).map(verdict => <span key={verdict} className={`claim-mark ${verdict}`}>{tally[verdict]} {VERDICT_WORDS[verdict].toLowerCase()}</span>)}</div>;
}
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
    {data.check ? <ul><li><Quote size={12}/>{plural(Object.values(data.check).reduce((sum, n) => sum + n, 0), 'claim')} checked on the web</li></ul> : null}
    {data.check ? <CheckTally tally={data.check}/> : work && work.total > 0 ? <ul>
      <li><SearchIcon size={12}/>{plural(work.total, 'direction')} searched · {plural(work.sources, 'source')}</li>
      <li><BookOpen size={12}/>{work.written} of {plural(work.total, 'direction')} written up</li>
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
/** Small, Medium or Full for the picked blocks; each stays whole, drawn smaller. */
function SizeMenu({ left, top, current, count, onPick, onClose }: { left: number; top: number; current?: number; count: number; onPick: (scale: number) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const away = (event: MouseEvent) => { const target = event.target as HTMLElement; if (box.current && !box.current.contains(target) && !target.closest?.('[data-testid="canvas-size"]')) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return <div ref={box} className="card-label-menu card-size-menu nodrag nopan nowheel" role="menu" tabIndex={-1} aria-label={`Size of ${count} block${count === 1 ? '' : 's'}`} style={{ left, top }}>
    {CARD_SCALES.map(size => <button key={size.id} type="button" role="menuitemradio" aria-checked={current === size.scale} onClick={() => onPick(size.scale)}><span>{size.label}<small>{size.scale === 1 ? 'Own size' : `${Math.round(size.scale * 100)} %`}</small></span>{current === size.scale && <Check size={13}/>}</button>)}
  </div>;
}
/** A shrunk block: the card is laid out at its own size and drawn smaller, so everything it shows stays whole.
 * Resizing it still works in the card's own units; a move of its edge is scaled back to the map. */
function ResearchCard(props: NodeProps<ResearchNode>) {
  const { data } = props, scale = data.scale ?? 1;
  const onResize = data.onResize;
  const scaledData = useMemo(() => scale < 1 ? { ...data, onResize: (size: CardResize | null, commit?: boolean) => onResize(size && { ...size, dx: Math.round(size.dx * scale), dy: Math.round(size.dy * scale) }, commit) } : data, [data, scale, onResize]);
  // A block that cannot be drawn shows a note in its place, and the rest of the map goes on working.
  return <PartBoundary retry={`${data.primary?.id ?? ''}:${data.primary?.hash ?? ''}:${data.title}:${data.description}`} fallback={message => <CardTrouble title={data.title} message={message}/>}>
    {/* One wrapper at every size, so going between Full and a smaller size keeps the card mounted: an App does not reload, a live block does not fetch again. */}
    <div className={scale < 1 ? 'card-scale scaled-card' : 'card-scale'} style={scale < 1 ? { width: data.width, height: data.height, transform: `scale(${scale})` } : undefined}><ResearchCardFace {...props} data={scaledData}/></div>
  </PartBoundary>;
}
function CardTrouble({ title, message }: { title: string; message: string }) {
  return <article className="research-card research-block card-trouble" role="alert"><strong>{title}</strong><p>This block could not be shown here. Open it, or Undo the last change.</p><small>{message}</small></article>;
}
function ResearchCardFace({ id, data, selected }: NodeProps<ResearchNode>) {
  const flow = useReactFlow();
  const heading = useRef<HTMLDivElement>(null), resizing = useRef<{ edge: ResizeEdge; x: number; y: number; width: number; height: number; zoom: number } | null>(null);
  const measure = useRef(data.onMeasure); measure.current = data.onMeasure;
  const group=data.kind==='group';
  useEffect(() => {
    if (data.expanded || data.heightSet || !heading.current) return;
    const element=heading.current, update=()=>measure.current(data.width,measuredCardHeight((data.notion||data.google||data.training||data.metric||data.dashboard||data.post||data.app||data.map?element.scrollHeight:element.offsetHeight)+2,Boolean(data.picture&&data.file?.image),Boolean(data.dashboard)));
    const observer=new ResizeObserver(update);observer.observe(element);update();return()=>observer.disconnect();
  },[data.expanded,data.heightSet,data.width,data.primary,data.chosen,data.notebookFigure,data.file]);
  // The Notion preview keeps one row callback, which always reaches the latest canvas.
  const latestRows=useRef(data.notion?.onRows); latestRows.current=data.notion?.onRows;
  const notionRows=useCallback((table:NotionTable)=>latestRows.current?latestRows.current(table):Promise.resolve(null),[]);
  const latestCopy=useRef(data.google?.onCopy); latestCopy.current=data.google?.onCopy;
  const googleCopy=useCallback(()=>latestCopy.current?latestCopy.current():Promise.resolve(false),[]);
  const picture=Boolean(data.picture&&data.file), shape=picture?data.file?.image:undefined;
  const resized=(event:ReactPointerEvent)=>{const start=resizing.current!;return resizedCard(start.edge,start,(event.clientX-start.x)/start.zoom,(event.clientY-start.y)/start.zoom,shape);};
  const arrows:Record<string,[ResizeEdge,number,number]>={ArrowLeft:['e',-RESIZE_GRID,0],ArrowRight:['e',RESIZE_GRID,0],ArrowUp:['s',0,-RESIZE_GRID],ArrowDown:['s',0,RESIZE_GRID]};
  const active=data.status==='running'||data.status==='queued';
  // Only states that need attention get a line; an idle block shows its content.
  const workState=data.awaitingApproval?'Awaiting approval':active?(data.label==='result'?'Searching':data.status):data.status==='failed'?'Latest attempt failed':data.status==='interrupted'?'Latest attempt interrupted':data.status==='cancelled'?'Latest attempt stopped':'';
  const notebook=data.blockType==='notebook'&&!group, code=data.code!==undefined&&!group, lastRun=data.notebook?.lastRun;
  // Facts about what the block holds sit in its header line and show while the block is picked or under the pointer.
  const notebookIdle=notebook&&Boolean(data.notebook?.cells)&&!data.notebook!.running&&(!lastRun||lastRun.status==='ok');
  const primaryId=data.primary?.id, primaryHash=data.primary?.hash;
  const facts=useMemo(()=>group?'':notebookIdle?`${data.notebook!.cells} cell${data.notebook!.cells===1?'':'s'}${lastRun?` · ran ${new Date(lastRun.at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:''}`:data.primary?artifactFacts(data.primary):'',[group,notebookIdle,data.notebook?.cells,lastRun?.at,primaryId,primaryHash]);
  const factsLine=facts?<span className="card-facts">{facts}</span>:null;
  const [appErrors,setAppErrors]=useState<string[]>([]);
  // The corner that takes keyboard focus and arrow keys.
  const handle:ResizeEdge='se';
  const openButton=<button className="icon-button card-open" aria-label={`Open ${data.title}`} data-tip={group?'Open group details':notebook?'Open notebook':code?'Open code and results':data.app?'Open the App, its code and inputs':picture?(isVideoType(data.file?.mediaType)?'Open the video':'Open the picture'):'Open content'} data-hint={group?undefined:'or double-click the block'} onClick={event=>{event.stopPropagation();data.onInspect();}}><ArrowUpRight size={15}/></button>;
  // A picture card is the picture: no kind, title or footer of its own. Its controls and title show over it on hover.
  if(picture)return <article className={`research-card research-block picture-card${data.height<72||data.width<160?' picture-tiny':data.height<160||data.width<280?' picture-small':''} ${selected?'selected':''} ${data.preview?`preview-${data.preview}`:''}`}>
    {sides.map(side=><Handle key={side.id} id={side.id} type="source" position={side.position} isConnectable={!data.readonly} className="relationship-handle" role="button" tabIndex={data.readonly?-1:0} aria-label={`Link ${data.title} from its ${side.id} side`} title="Drag onto another block to link them, or click, then click the block" onClick={event=>{event.stopPropagation();data.onHandle(side.id);}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();data.onHandle(side.id);}}}/>)}
    <div ref={heading} className="group-heading picture-face">
      <div className="block-primary-preview" onDoubleClick={event=>{event.stopPropagation();data.onInspect();}}><ShownFilePreview file={data.file!} title={data.title} missing={data.fileMissing} onSize={data.onPictureSize}/></div>
      <div className="picture-chrome">
        {data.preview&&<span className="card-preview-tag">{data.preview==='added'?'New':data.preview==='changed'?'Changed':'Removed'}</span>}
        <span className="card-controls nodrag">{openButton}</span>
        <span className="picture-caption" title={data.title}>{data.title||'Untitled'}</span>
      </div>
    </div>
    {!data.readonly&&RESIZE_EDGES.map(edge=><div key={edge} className={`card-resize card-resize-${edge} nodrag nopan${data.resizePending?' pending':''}`}
      {...edge===handle?{role:'button',tabIndex:0,'aria-label':`Resize ${data.title}, now ${data.width} by ${data.height}. Arrow keys resize; the picture keeps its shape`,title:'Drag to resize'}:{'aria-hidden':true}}
      onPointerDown={event=>{if(data.resizePending||event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);resizing.current={edge,x:event.clientX,y:event.clientY,width:data.width,height:data.height,zoom:flow.getZoom()*(data.scale??1)};data.onActivate();}}
      onPointerMove={event=>{if(resizing.current)data.onResize(resized(event));}}
      onPointerUp={event=>{const start=resizing.current;if(!start)return;const size=resized(event);resizing.current=null;event.currentTarget.releasePointerCapture(event.pointerId);data.onResize(Math.abs(event.clientX-start.x)+Math.abs(event.clientY-start.y)<3?null:size,true);}}
      onPointerCancel={()=>{resizing.current=null;data.onResize(null);}}
      onClick={event=>event.stopPropagation()}
      onKeyDown={edge===handle?event=>{const arrow=arrows[event.key];if(!arrow||data.resizePending)return;event.preventDefault();event.stopPropagation();data.onResize(resizedCard(arrow[0],data,arrow[1],arrow[2],shape),true);}:undefined}/>)}
  </article>;
  return <article className={`research-card ${group?'organizational-group':'research-block'}${data.blockType==='finding'?' finding-card':''}${data.post?' post-card':''} ${data.expanded?'expanded-group':''} ${selected?'selected':''} ${data.preview?`preview-${data.preview}`:''}${data.heightSet&&!data.expanded?' height-set':''}`}>
    {sides.map(side=><Handle key={side.id} id={side.id} type="source" position={side.position} isConnectable={!data.readonly} className="relationship-handle" role="button" tabIndex={data.readonly?-1:0} aria-label={`Link ${data.title} from its ${side.id} side`} title="Drag onto another block to link them, or click, then click the block" onClick={event=>{event.stopPropagation();data.onHandle(side.id);}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();data.onHandle(side.id);}}}/>)}
    {group&&data.expanded?<div ref={heading} className="group-heading group-bar">
      <KindIcon kind={data.kind} blockType={data.blockType}/>
      <div className="card-title" title={data.title}>{data.title||'Untitled'}</div>
      <span className="group-item-count" title={`${data.members} block${data.members===1?'':'s'}`}>{data.members}</span>
      {data.workLabel&&<span className="group-contained-work">{data.workLabel}</span>}
      {data.preview&&<span className="card-preview-tag">{data.preview==='added'?'New':data.preview==='changed'?'Changed':'Removed'}</span>}
      <span className="card-controls nodrag">
        {!data.readonly&&<button className="icon-button group-add-control" aria-label={`Add a block inside ${data.title}`} title="Add inside" onClick={event=>{event.stopPropagation();data.onAdd();}}><Plus size={16}/></button>}
        {openButton}
        <button className="icon-button group-expand-control" aria-label={`Collapse ${data.title}`} title="Collapse group" onClick={event=>{event.stopPropagation();data.onExpand();}}><ChevronUp size={17}/></button>
      </span>
    </div>:<div ref={heading} className="group-heading">
      <div className="card-top">{data.onLabel?<button type="button" className="card-type card-type-button nodrag" aria-label={`Change the label of ${data.title}`} title="Change label" onClick={event=>{event.stopPropagation();data.onLabel!(event.currentTarget.getBoundingClientRect());}}><KindIcon kind={data.kind} blockType={data.blockType} google={data.google?.view.kind} map={data.map?.provider} metric={data.metric?.view.source} post={data.post?.view.platform}/>{data.kindName}{data.textLabel?<span className="card-label">{data.textLabel}</span>:<span className="card-label-add" aria-hidden="true">+ label</span>}{data.fileMissing&&<span className="card-file-missing" title="This block's file is missing from the project folder">File missing</span>}{factsLine}</button>:<span className="card-type"><KindIcon kind={data.kind} blockType={data.blockType} google={data.google?.view.kind} map={data.map?.provider} metric={data.metric?.view.source} post={data.post?.view.platform}/>{group?'Group':data.kindName}{!group&&data.kindName==='Text'&&data.textLabel?<span className="card-label">{data.textLabel}</span>:null}{group&&<span className="group-item-count"> · {data.members} items</span>}{data.fileMissing&&<span className="card-file-missing" title="This block's file is missing from the project folder">File missing</span>}{factsLine}{data.preview&&<span className="card-preview-tag">{data.preview==='added'?'New':data.preview==='changed'?'Changed':'Removed'}</span>}</span>}<span className="card-controls nodrag">
        {openButton}
        {group&&<button className="icon-button group-expand-control" aria-label={`${data.expanded?'Collapse':'Expand'} ${data.title}`} title={data.expanded?'Collapse group':'Expand group'} onClick={event=>{event.stopPropagation();data.onExpand();}}>{data.expanded?<ChevronUp size={17}/>:<ChevronDown size={17}/>}</button>}
      </span></div>
      <div className="card-title" title={data.title}>{data.title||'Untitled'}</div>
      {group ? <>
        {data.workLabel&&<span className="group-contained-work">{data.workLabel}</span>}
        {data.description&&<p className="group-overview-excerpt">{data.description.slice(0,140)}{data.description.length>140?'…':''}</p>}
        {!data.expanded&&<div className="group-chosen-highlights">{data.chosen.length?data.chosen.map(artifact=><button key={artifact.id} className="group-highlight-preview" aria-label={`Open highlight: ${artifact.title}`} title={`From ${data.origins[artifact.nodeId]??'a saved block'} · exact version ${artifact.hash}`} onClick={event=>{event.stopPropagation();data.onHighlightOpen(artifact);}}><ShownArtifact artifact={artifact} compact/><span><strong>{artifact.title}</strong><small>{data.origins[artifact.nodeId]??'Saved block'} · {artifact.hash.slice(0,8)}</small></span></button>)
          :data.listed?.length?<ul className="group-member-list">{data.listed.slice(0,GROUP_PREVIEW_MEMBERS).map(member=><li key={member.id} title={member.title}><KindIcon kind={member.kind} blockType={member.blockType} google={member.google} metric={member.metric} post={member.post} size={12}/><span>{member.title}</span></li>)}{data.members>Math.min(data.listed.length,GROUP_PREVIEW_MEMBERS)&&<li className="more">{data.members-Math.min(data.listed.length,GROUP_PREVIEW_MEMBERS)} more</li>}</ul>
          :<p className="subtle">Choose up to three saved highlights in Group details.</p>}</div>}
      </> : <>
        {notebook?data.notebook?.cells&&!notebookIdle?<div className={`block-work-state ${data.notebook.running?'running':lastRun?.status==='error'?'failed':lastRun?.status==='interrupted'?'interrupted':''}`}>{data.notebook.running&&<LoaderCircle size={12} className="spin"/>}{data.notebook.cells} cell{data.notebook.cells===1?'':'s'}{data.notebook.running?' · Running':lastRun?` · ${lastRun.status==='ok'?'Ran':lastRun.status==='error'?'Error in':'Stopped'} [${lastRun.executionCount??' '}] · ${new Date(lastRun.at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:''}</div>:null
        :data.blockType==='agent'?<div className={`block-work-state ${data.agent?.status==='running'?'running':data.agent&&data.agent.status!=='completed'?'failed':''}`}>{data.agent?.status==='running'&&<LoaderCircle size={12} className="spin"/>}{data.agent?`${agentState[data.agent.status]} · ${data.agent.runtime}`:'Agent'}</div>
        :workState&&!data.web&&<div className={`block-work-state ${data.status||''}`}>{active&&<LoaderCircle size={12} className="spin"/>}{workState}</div>}
        <div className="block-primary-preview" onDoubleClick={event=>{event.stopPropagation();data.onInspect();}}>{notebook&&data.notebookFigure?<img className="block-figure-preview" src={data.notebookFigure} alt={`Newest figure in ${data.title}`}/>:notebook&&data.notebook?.value?<strong className="block-metric-preview">{data.notebook.value}</strong>:notebook&&data.notebook?.excerpt?(data.notebook.excerpt.kind==='code'?<pre className="block-code-preview">{data.notebook.excerpt.text.split('\n').slice(0,5).join('\n')}</pre>:<p className="block-text-preview">{textPreview(data.notebook.excerpt.text,220).text}</p>):data.blockType==='agent'?<AgentFace data={data}/>
          :data.blockType==='search'?<div className="search-face">{data.why&&<p className="search-why" title={data.why}>{data.why}</p>}<ul className="search-queries">{data.description.split('\n').filter(Boolean).slice(0,3).map((query,index)=><li key={index} title={query}><SearchIcon size={12}/><span>{query}</span></li>)}</ul></div>
          :data.label==='result'&&data.description===RESULT_PLACEHOLDER?<div className="search-face">{data.why&&<p className="search-why" title={data.why}>{data.why}</p>}{data.queries?.length?<ul className="search-queries">{data.queries.slice(0,3).map((query,index)=><li key={index} title={query}><SearchIcon size={12}/><span>{query}</span></li>)}</ul>:<p className="block-empty-hint">{data.description}</p>}</div>
          :data.web?<WebFace data={data.web}/>:data.app?<AppFace id={id} data={data} onErrors={setAppErrors}/>:data.file?<ShownFilePreview file={data.file} title={data.title}/>:data.notion?<ShownNotion projectId={data.notion.projectId} nodeId={id} view={data.notion.view} onRows={data.notion.onRows?notionRows:undefined}/>:data.google?<ShownGoogle projectId={data.google.projectId} nodeId={id} view={data.google.view} onCopy={data.google.onCopy?googleCopy:undefined}/>:data.map?<ShownMap view={data.map}/>:data.training?<ShownTraining projectId={data.training.projectId} nodeId={id} view={data.training.view}/>:data.metric?<ShownMetric projectId={data.metric.projectId} nodeId={id} view={data.metric.view} title={data.title}/>:data.dashboard?<ShownDashboard projectId={data.dashboard.projectId} view={data.dashboard.view} sources={data.dashboard.sources}/>:data.post?<PostCard projectId={data.post.projectId} nodeId={id} post={data.post.view} title={data.title}/>:code?(data.code?<ShownCode className="block-code-source" code={data.code}/>:<p className="block-empty-hint">No code yet</p>):data.primary?<ShownArtifact artifact={data.primary}/>:data.description?<ShownMarkdown text={splitSources(data.description).body} limit={20_000} scroll/>:notebook?<p className="block-empty-hint">No cells yet</p>:null}</div>
        {data.check&&data.blockType!=='agent'&&<CheckTally tally={data.check}/>}
      </>}
      {!data.expanded&&!group&&!data.web&&<Provenance data={data} appErrors={appErrors}/>}
    </div>}
    {!data.expanded&&!data.readonly&&!group&&RESIZE_EDGES.map(edge=><div key={edge} className={`card-resize card-resize-${edge} nodrag nopan${data.resizePending?' pending':''}`}
      {...edge===handle?{role:'button',tabIndex:0,'aria-label':`Resize ${data.title}, now ${data.width} by ${data.height}. Arrow keys resize; double-click fits the height to the content`,title:'Drag to resize · double-click to fit the content'}:{'aria-hidden':true}}
      onPointerDown={event=>{if(data.resizePending||event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);resizing.current={edge,x:event.clientX,y:event.clientY,width:data.width,height:data.height,zoom:flow.getZoom()*(data.scale??1)};data.onActivate();}}
      onPointerMove={event=>{if(resizing.current)data.onResize(resized(event));}}
      onPointerUp={event=>{const start=resizing.current;if(!start)return;const size=resized(event);resizing.current=null;event.currentTarget.releasePointerCapture(event.pointerId);
        // A click without a drag (the first half of a double-click) changes nothing.
        data.onResize(Math.abs(event.clientX-start.x)+Math.abs(event.clientY-start.y)<3?null:size,true);}}
      onPointerCancel={()=>{resizing.current=null;data.onResize(null);}}
      onClick={event=>event.stopPropagation()}
      onDoubleClick={event=>{event.stopPropagation();if(data.heightSet&&edge!=='e'&&edge!=='w')data.onAutoHeight();}}
      onKeyDown={edge===handle?event=>{const arrow=arrows[event.key];if(!arrow||data.resizePending)return;event.preventDefault();event.stopPropagation();data.onResize(resizedCard(arrow[0],data,arrow[1],arrow[2],shape),true);}:undefined}/>)}
  </article>;
}
// While a block moves, React Flow moves its frame; the card inside draws again only when its content, size or
// selection changes, and a line only when its route does (the route comes with its data, not from the endpoints).
const PLACEMENT_PROPS = new Set(['positionAbsoluteX', 'positionAbsoluteY', 'dragging', 'sourceX', 'sourceY', 'targetX', 'targetY', 'sourcePosition', 'targetPosition']);
function samePlacedProps<P extends object>(a: P, b: P) { return (Object.keys(b) as (keyof P & string)[]).every(key => PLACEMENT_PROPS.has(key) || a[key] === b[key]); }
const nodeTypes = { research: memo(ResearchCard, samePlacedProps) };
/** One line between two visible blocks: a link with a word, or a trail ros.ai drew to show where a block came from.
 * The chip on the line is the word and, once the line is selected, the place to change it, turn the link around or
 * delete it. Several links between the same two blocks share one line and list themselves in a small card. */
type LinkRow = { id: string; sourceTitle: string; targetTitle: string; word: string; trail: boolean };
type LinkEdgeData = { path: string; chip: LinkPoint; word: string; quiet: boolean; shared: { text: string; point: LinkPoint } | null; count: number; trail: boolean; trailWord: string; editable: boolean; editingId: string | null; links: LinkRow[]; heading: string; note: string; onSelect: () => void; onEdit: (connectionId: string | null) => void; onRename: (connectionId: string, word: string) => void; onSwap: (connectionId: string) => void; onDelete: (connectionIds: string[]) => void; onClose: () => void };
type LinkEdge = Edge<LinkEdgeData, 'link'>;
type Geometry = LinkBox & { id: string; parentId?: string };
function LinkEdgeView({ id, data, selected, markerStart, markerEnd, interactionWidth }: EdgeProps<LinkEdge>) {
  const [hover, setHover] = useState(false);
  if (!data) return null;
  const single = data.count === 1, link = data.links[0], ghost = !data.trail && single && !data.word;
  const text = data.trail ? (selected ? data.trailWord : '') : data.word || (single ? '+ word' : '');
  const editing = single && data.editingId === link.id;
  // A link that shares its word with others at one end shows its own chip only while it is pointed at or picked.
  const chip = Boolean(text) && !editing && (!ghost || ((hover || selected) && data.editable)) && (!data.quiet || hover || selected);
  return <g className={`link-edge${hover ? ' hovered' : ''}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <BaseEdge id={id} path={data.path} markerStart={markerStart} markerEnd={markerEnd} interactionWidth={interactionWidth}/>
    <EdgeLabelRenderer>
      {data.shared && <div className="link-slot" style={{ transform: `translate(-50%, -50%) translate(${data.shared.point.x}px, ${data.shared.point.y}px)` }}><span className="link-chip still shared">{data.shared.text}</span></div>}
      <div className={`link-slot nodrag nopan${selected ? ' selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${data.chip.x}px, ${data.chip.y}px)` }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {chip && <button type="button" className={`link-chip${selected ? ' selected' : ''}${ghost ? ' ghost' : ''}${data.trail ? ' trail' : ''}`} aria-label={data.trail ? data.trailWord : single ? `Link: ${link.sourceTitle} → ${link.targetTitle}${data.word ? ` · ${data.word}` : ''}` : data.heading} title={single && !data.trail ? `${link.sourceTitle} → ${link.targetTitle}` : undefined} onClick={event => { event.stopPropagation(); if (selected && single && data.editable && !data.trail) data.onEdit(link.id); else data.onSelect(); }}>{text}</button>}
        {chip && selected && data.editable && <button type="button" className="link-chip-delete" aria-label={single ? 'Delete link' : `Delete ${data.count} links`} onClick={event => { event.stopPropagation(); data.onDelete(data.links.map(item => item.id)); }}><X size={11}/></button>}
        {editing && <LinkWordEditor key={link.id} word={data.word} onSave={word => data.onRename(link.id, word)} onSwap={() => data.onSwap(link.id)} onDelete={() => data.onDelete([link.id])} onClose={() => data.onEdit(null)}/>}
        {selected && !single && <LinkListCard heading={data.heading} note={data.note} links={data.links} editable={data.editable} editingId={data.editingId} onRename={data.onRename} onDelete={data.onDelete} onClose={data.onClose}/>}
      </div>
    </EdgeLabelRenderer>
  </g>;
}
const edgeTypes = { link: memo(LinkEdgeView, samePlacedProps) };
/** The word of a link, edited where its chip was: a field, the common words beneath it, then Swap direction and Delete.
 * Enter or a click elsewhere saves, Esc keeps the old word. */
function LinkWordEditor({ word, onSave, onSwap, onDelete, onClose }: { word: string; onSave: (word: string) => void; onSwap: () => void; onDelete: () => void; onClose: () => void }) {
  const [value, setValue] = useState(word); const box = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, word, onSave, onClose }); latest.current = { value, word, onSave, onClose };
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  useEffect(() => {
    const away = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as globalThis.Node)) { const { value, word, onSave, onClose } = latest.current; if (value.trim() !== word.trim()) onSave(value); else onClose(); } };
    document.addEventListener('mousedown', away); return () => document.removeEventListener('mousedown', away);
  }, []);
  const current = word.replace(/\s+/gu, ' ').trim().toLowerCase();
  return <div ref={box} className="link-editor nowheel" role="dialog" aria-label="Word for this link" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <form onSubmit={event => { event.preventDefault(); if (value.trim() !== word.trim()) onSave(value); else onClose(); }}><input ref={field} className="link-chip-input" value={value} maxLength={LINK_WORD_LIMIT} placeholder="Word for this link" aria-label="Word for this link" onChange={event => setValue(event.target.value)}/></form>
    <div className="link-menu" role="menu">
      <p className="link-menu-heading">Common words</p>
      {LINK_WORDS.map(item => <button key={item} type="button" role="menuitemradio" aria-checked={current === item} onClick={() => onSave(item)}>{item}{current === item && <Check size={13}/>}</button>)}
      <div className="link-menu-divider" role="separator"/>
      <button type="button" role="menuitem" onClick={onSwap}><ArrowLeftRight size={13}/> Swap direction</button>
      <button type="button" role="menuitem" onClick={onDelete}><Trash2 size={13}/> Delete link</button>
    </div>
  </div>;
}
/** Several links between the same two blocks, one row each: who links to whom, the word to change, and a × for that link alone. */
function LinkListCard({ heading, note, links, editable, editingId, onRename, onDelete, onClose }: { heading: string; note: string; links: LinkRow[]; editable: boolean; editingId: string | null; onRename: (connectionId: string, word: string) => void; onDelete: (connectionIds: string[]) => void; onClose: () => void }) {
  return <div className="link-list nowheel" role="dialog" aria-label={heading}>
    <header><strong>{heading}</strong><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={14}/></button></header>
    <ol>{links.map(link => <li key={link.id}>
      <span className="link-list-ends" title={`${link.sourceTitle} → ${link.targetTitle}`}>{link.sourceTitle} → {link.targetTitle}</span>
      {link.trail ? <span className="link-chip trail still">{link.word}</span> : <LinkWordField word={link.word} disabled={!editable} autoFocus={editingId === link.id} onSave={word => onRename(link.id, word)}/>}
      {editable && <button type="button" className="link-chip-delete" aria-label={`Delete the link from ${link.sourceTitle} to ${link.targetTitle}`} onClick={() => onDelete([link.id])}><X size={11}/></button>}
    </li>)}</ol>
    {note && <p className="link-list-note">{note}</p>}
  </div>;
}
function LinkWordField({ word, disabled, autoFocus, onSave }: { word: string; disabled: boolean; autoFocus: boolean; onSave: (word: string) => void }) {
  const [value, setValue] = useState(word); useEffect(() => setValue(word), [word]);
  const commit = () => { if (value.trim() !== word.trim()) onSave(value); };
  return <form onSubmit={event => { event.preventDefault(); commit(); event.currentTarget.querySelector('input')?.blur(); }}><input className="link-chip-input" value={value} maxLength={LINK_WORD_LIMIT} placeholder="+ word" disabled={disabled} autoFocus={autoFocus} aria-label="Word for this link" onChange={event => setValue(event.target.value)} onBlur={commit}/></form>;
}
/** Where a new block goes among the blocks directly in `parentId` (the canvas or a Group): the first free spot in
 * reading order beside or below them, within the width they already take, so an open Group's frame stays as
 * narrow as it is; otherwise below them all. Each block counts with the tallest card it can show, as the server
 * checks it, and an open Group with its frame. */
export function emptyPosition(canvas: Canvas, parentId: string | null = null, expandedIds: readonly string[] = []): { x: number; y: number } {
  const open = new Set(expandedIds), seen = new Set<string>();
  const footprint = (node: CanvasNode): CanvasSize => {
    const card = { width: cardWidth(node), height: cardFootprintHeight(node) }, inside = canvas.nodes.filter(item => item.parentId === node.id);
    if (!open.has(node.id) || !inside.length || seen.has(node.id)) return card;
    seen.add(node.id);
    const frame = openGroupSize({ width: Math.max(...inside.map(item => Math.max(0, item.x) + footprint(item).width)), height: Math.max(...inside.map(item => Math.max(0, item.y) + footprint(item).height)) });
    return { width: Math.max(card.width, frame.width), height: Math.max(card.height, frame.height) };
  };
  const boxes = canvas.nodes.filter(node => (node.parentId || null) === parentId).map(node => ({ x: node.x, y: node.y, ...footprint(node) }));
  if (!boxes.length) return { x: 0, y: 0 };
  const origin = parentId ? { x: 0, y: 0 } : { x: Math.min(...boxes.map(box => box.x)), y: Math.min(...boxes.map(box => box.y)) };
  const right = parentId ? groupContentRight(boxes) : Math.max(origin.x + 5 * (CARD_SIZE.width + LAYOUT_GAP) - LAYOUT_GAP, ...boxes.map(box => box.x + box.width));
  return freeSpot(boxes, { width: CARD_SIZE.width, height: CARD_MAX_HEIGHT }, origin, right)
    ?? { x: origin.x, y: Math.ceil((Math.max(...boxes.map(box => box.y + box.height)) + LAYOUT_GAP) / 24) * 24 };
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
    if (op.type === 'updateConnection') result.connections = result.connections.map(c => c.id === op.id ? { ...c, ...op.patch } : c);
  }
  return { canvas: convertLegacyGroups(result), marks };
}
type CanvasHighlight = { id: string; nodeId: string; artifactId: string; x: number; y: number };
/** The map as it is right now, read when a message goes to ROS: the blocks picked together (a ⌘-click or a box) and the blocks inside
 * the visible part of the map, nearest its middle first, or 'all' when every block shown is in view. */
export type CanvasView = () => { picked: string[]; onScreen: string[] | 'all' };
type Props = { notices?: ReactNode; proposalCard?: ReactNode; detail: ProjectDetail; agentTurns?: Record<string, AgentTurnSummary>; selectedId: string | null; onSelect: (id: string | null) => void; onInspect: (id: string) => void; onArtifact: (artifact: Artifact, nodeId: string) => void; highlights: CanvasHighlight[]; mutate: (operations: Mutation[], label: string, options?: { undoableLayout?: boolean }) => Promise<unknown>; onAdd: (parentId: string | null, kind: KindId, at?: { x: number; y: number }) => void; onBrowse: (parentId: string | null, kind?: KindId, at?: { x: number; y: number }) => void; onUndo?: () => void; onRedo?: () => void; onHistory?: () => void; historyOpen?: boolean; busy?: boolean; proposal?: Proposal; historyCanvas?: Canvas; expandedIds: string[]; onExpandedChange: (ids: string[]) => void; focusId?: string | null; missingFiles?: ReadonlySet<string>; folderFiles?: ReadonlyMap<string, FolderFile>; onDropFiles?: (files: File[], position: { x: number; y: number }) => void;
  /** Copies the tab a Google Sheet block shows into a new Data block; false when it did not happen. */
  onGoogleCopy?: (nodeId: string) => Promise<boolean>;
  /** Filled with a reader of what the map shows, for the glance a message to ROS carries. */
  view?: RefObject<CanvasView | null>;
  /** Pastes copied blocks with what they show (files, saved versions, notebooks); null when it did not happen. */
  paste?: (body: { operations: Mutation[]; label: string; from: string; sources: Record<string, string>; artifacts: Record<string, string> }) => Promise<{ missing: string[] } | null>;
  /** Opens Share with where each block is shown now and which Groups are open, so the copy looks like the map. */
  onShare?: (shown: { layout: Record<string, Box>; open: string[] }) => void };
type Box = { x: number; y: number; width: number; height: number };
/** Who gets a trackpad scroll over a block. Pinch and ⌘-scroll always zoom the map, and a two-finger scroll pans it, so
 *  moving around never gets stuck on a block. Only the one picked block scrolls its own content (text, tables, PDF pages,
 *  code) when there is more than fits that way; click the block to scroll it, click the map to hand the scroll back. */
function canvasWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) return;
  const target = event.target instanceof Element ? event.target : null, node = target?.closest('.react-flow__node');
  if (!target || !node?.classList.contains('selected') || node.parentElement?.querySelectorAll(':scope > .react-flow__node.selected').length !== 1) return;
  const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
  for (let el: Element | null = target; el && el !== node; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(el)[vertical ? 'overflowY' : 'overflowX'];
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const more = vertical ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
    // Stopped before React Flow's own listener, so the content scrolls natively and the map stays put.
    if (more) { event.stopPropagation(); return; }
  }
}
/** The last blocks copied in this window, for browsers that hand a paste only its plain text. */
let lastCopy: { text: string; plain: string } | null = null;
type FlowHandlerName = 'onNodesChange' | 'onNodeClick' | 'onNodeDoubleClick' | 'onPaneClick' | 'onEdgeClick' | 'onEdgeDoubleClick' | 'onSelectionStart' | 'onSelectionEnd' | 'onNodeDragStart' | 'onNodeDrag' | 'onNodeDragStop' | 'onConnect' | 'onConnectEnd' | 'onMoveStart' | 'onMoveEnd';
type FlowHandlers = Required<Pick<ReactFlowProps<ResearchNode, LinkEdge>, FlowHandlerName>>;
/** Handlers that keep their identity across renders and always run the latest code. */
function useStableHandlers<T extends Record<string, (...args: never[]) => unknown>>(handlers: T): T {
  const latest = useRef(handlers); latest.current = handlers;
  return useMemo(() => Object.fromEntries(Object.keys(latest.current).map(key => [key, (...args: never[]) => latest.current[key](...args)])) as T, []);
}
function FlowCanvas({ notices, proposalCard, detail, selectedId, onSelect, onInspect, onArtifact, highlights, mutate, onAdd, onBrowse, onUndo, onRedo, onHistory, historyOpen=false, busy=false, proposal, historyCanvas, expandedIds: requestedExpandedIds, onExpandedChange, focusId, missingFiles, folderFiles, onDropFiles, onGoogleCopy, agentTurns, view, paste , onShare }: Props) {
  const flow = useReactFlow(); const dragging = useRef(false); const area = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = area.current; if (!el) return; el.addEventListener('wheel', canvasWheel, { capture: true, passive: true }); return () => el.removeEventListener('wheel', canvasWheel, { capture: true }); }, []);
  // The quick Add block menu, placed beside its tile in the tools card.
  const [addMenu, setAddMenu] = useState<{ left: number; top: number; at?: { x: number; y: number } } | null>(null);
  // The open label menu, and the Group a dragged block would join (outlined while the drag lasts).
  const [sizeMenu, setSizeMenu] = useState<{ left: number; top: number } | null>(null); const closeSizeMenu = useCallback(() => setSizeMenu(null), []);
  const [labelMenu, setLabelMenu] = useState<{ nodeId: string; left: number; top: number } | null>(null); const closeLabelMenu = useCallback(() => setLabelMenu(null), []);
  const [dropTarget, setDropTarget] = useState<{ id: string; left: number; top: number; width: number; height: number } | null>(null); const dropTargetId = useRef<string | null>(null);
  const [selecting, setSelecting] = useState(false), [groupSelection, setGroupSelection] = useState<string[]>([]), [groupName, setGroupName] = useState('Untitled'), [dropping, setDropping] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null), [focusRequest, setFocusRequest] = useState<string | null>(null), [frameRequest, setFrameRequest] = useState<string[] | null>(null);
  // The link whose word is being edited, and a link just drawn, whose word opens as soon as the canvas shows it.
  const [editingLink, setEditingLink] = useState<{ connectionId: string } | null>(null); const pendingEdit = useRef<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ nodeId: string; side: Side } | null>(null), [arranging, setArranging] = useState(false), [message, setMessage] = useState('');
  const [animatingLayout, setAnimatingLayout] = useState(false);
  const [reflowRevision, setReflowRevision] = useState(0);
  // Blocks being dragged, or settling after a drop, are drawn from React Flow's own store until they come to rest
  // (see followDrag); `saving` keeps a dropped block where it settled until the saved canvas arrives.
  const flowStore = useStoreApi<ResearchNode, LinkEdge>();
  const live = useRef(new Set<string>()), dragFrom = useRef(new Map<string, XYPosition>()), settling = useRef<{ frame: number; targets: Map<string, XYPosition> } | null>(null);
  const saving = useRef(new Map<string, { parentId: string | null; position: XYPosition }>()), missedLayout = useRef(false), boxSelecting = useRef(false);
  const [layoutRetry, setLayoutRetry] = useState(0);
  // `settled`: the plan has been checked against the layout it was made from; `expanded`: the Groups open at the last reflow.
  const reflowState = useRef<{ plan: CanvasReflowPlan; canvas: Canvas; sizes: Record<string, CanvasSize>; positions: string; dimensions: string; structure: string; shape: string; ready: boolean; settled: boolean; expanded: string[] } | null>(null);
  const reflowWriting = useRef(false);
  const [cardMeasurements, setCardMeasurements] = useState<Record<string, CanvasSize>>({}), [draftSizes, setDraftSizes] = useState<Record<string, CardResize>>({});
  // Pictures whose pixel size the folder could not tell, learnt as they load.
  const [pictureSizes, setPictureSizes] = useState<Record<string, ImageSize>>({});
  const learnPictureSize = useCallback((id: string, size: ImageSize) => setPictureSizes(current => current[id]?.width === size.width && current[id]?.height === size.height ? current : { ...current, [id]: size }), []);
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
  const shownEdges = useRef(new Map<string, { key: string; edge: LinkEdge }>());
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
      for (const element of area.current!.parentElement?.querySelectorAll('.canvas-tools, .ros-dock') || []) {
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
  // What is on screen: blocks inside the part of the map the header, the tools, ROS and the side panel leave visible, nearest
  // its middle first (a group around the middle comes first). Children of a closed group are not drawn, so they are not on screen.
  useEffect(() => {
    if (!view) return;
    view.current = () => {
      const bounds = area.current?.getBoundingClientRect(), shown = flow.getNodes().filter(node => node.type === 'research');
      if (!bounds?.width || !bounds.height) return { picked: groupSelection, onScreen: [] };
      const inset = canvasInsets();
      const from = flow.screenToFlowPosition({ x: bounds.left + inset.left, y: bounds.top + inset.top }), to = flow.screenToFlowPosition({ x: bounds.right - inset.right, y: bounds.bottom - inset.bottom });
      const rect = { x: from.x, y: from.y, width: Math.max(1, to.x - from.x), height: Math.max(1, to.y - from.y) }, middle = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const distance = (id: string) => {
        const node = flow.getInternalNode(id); if (!node) return Infinity;
        const { x, y } = node.internals.positionAbsolute, width = node.measured.width ?? 0, height = node.measured.height ?? 0;
        return Math.hypot(Math.max(x - middle.x, 0, middle.x - x - width), Math.max(y - middle.y, 0, middle.y - y - height));
      };
      const inView = flow.getIntersectingNodes(rect, true).filter(node => node.type === 'research').map(node => ({ id: node.id, distance: distance(node.id) })).sort((a, b) => a.distance - b.distance).map(item => item.id);
      return { picked: groupSelection, onScreen: shown.length && inView.length === shown.length ? 'all' : inView };
    };
    return () => { view.current = null; };
  });
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
  /** A picture card's pixel size, from the folder or the loaded picture. */
  const pictureShape = (node: CanvasNode): ImageSize | undefined => isPictureNode(node) ? folderFiles?.get(node.id)?.image ?? pictureSizes[node.id] : undefined;
  // A card the researcher made taller keeps that height; others follow their measured content. A picture card is as
  // tall as its picture, which is known before the browser has measured it.
  const fullSizes = useMemo(() => Object.fromEntries(displayed.canvas.nodes.map(node => {
    const draft = draftSizes[node.id], initial = initialCardSize({ ...node, width: draft?.width ?? node.width }, cardOutcomes[node.id].text);
    const height = draft?.height ?? setCardHeight(node);
    if (height) return [node.id, { width: initial.width, height }];
    if (cardMeasurements[node.id]?.width === initial.width) return [node.id, cardMeasurements[node.id]];
    const shape = pictureShape(node);
    return [node.id, shape ? { width: initial.width, height: pictureCardHeight(initial.width, shape) } : initial];
  })), [displayed.canvas.nodes, cardOutcomes, cardMeasurements, draftSizes, folderFiles, pictureSizes]);
  // A shrunk block takes its scaled size on the map; its card is laid out at full size and drawn smaller.
  const cardSizes = useMemo(() => Object.fromEntries(displayed.canvas.nodes.map(node => {
    const size = fullSizes[node.id], scale = cardScale(node);
    return [node.id, scale < 1 ? { width: Math.round(size.width * scale), height: Math.round(size.height * scale) } : size];
  })), [displayed.canvas.nodes, fullSizes]);
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
      ...(size.height !== undefined && size.height !== setCardHeight(node) && !isPictureNode(node) ? { height: size.height } : {}),
      ...(size.dx ? { x: node.x + size.dx } : {}), ...(size.dy ? { y: node.y + size.dy } : {}),
    };
    if (!Object.keys(patch).length) { clear(); return; }
    resizeCommits.current.add(id); setResizingCards([...resizeCommits.current]);
    void mutate([{ type: 'updateNode', id, patch }], 'Resize block', { undoableLayout: true }).finally(() => { clear(); resizeCommits.current.delete(id); setResizingCards([...resizeCommits.current]); });
  };
  const fitHeight = (id: string) => { if (!readonly) void mutate([{ type: 'updateNode', id, patch: { height: null } }], 'Fit block to its content', { undoableLayout: true }); };
  const toggle = (id: string) => { if (!displayed.canvas.nodes.some(node=>node.id===id&&isGroup(node))) return; const open = expandedIds.includes(id); onExpandedChange(open ? expandedIds.filter(n => n !== id) : [...expandedIds, id]); onSelect(id); };
  const connect = (source: string, target: string) => {
    if (readonly || source === target || connectionBusy.current) return;
    setPendingConnection(null); connectionCommittedAt.current = Date.now();
    const existing = displayed.canvas.connections.find(c => (c.source === source && c.target === target) || (c.source === target && c.target === source));
    if (existing) { setSelectedEdge(aggregatedRelationships.find(group => group.contributions.some(item => item.connection.id === existing.id))?.id || null); setEditingLink(null); onSelect(null); setMessage('These blocks are already linked.'); return; }
    connectionBusy.current = true;
    const id = crypto.randomUUID();
    void mutate([{ type: 'addConnection', connection: { id, source, target, label: '' } }], 'Link blocks').then(result => { if (result !== false) pendingEdit.current = id; }).finally(() => { connectionBusy.current = false; });
  };
  const handleClick = (nodeId: string, side: Side) => {
    if (readonly || Date.now() - connectionCommittedAt.current < 250) return;
    if (pendingConnection && pendingConnection.nodeId !== nodeId) connect(pendingConnection.nodeId, nodeId);
    else { setPendingConnection(pendingConnection?.nodeId === nodeId && pendingConnection.side === side ? null : { nodeId, side }); onSelect(nodeId); setSelectedEdge(null); setEditingLink(null); }
  };
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 4500); return () => clearTimeout(timer); }, [message]);
  // Copy and paste answer with a small toast; a paste's toast offers Undo.
  const [toast, setToast] = useState<{ text: string; undo?: boolean; key: number } | null>(null);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.undo ? 5000 : 2200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPendingConnection(null); setSelectedEdge(null); setEditingLink(null); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  // Delete the picked blocks, or the selected one; a block inside another picked group goes with it.
  // A Text block's label is picked from a menu under its caption; a Report or Finding keeps the label its type implies.
  const labelMenuOpener = (node: CanvasNode) => !readonly && kindName(node) === 'Text' && !labelFixed(node) ? (anchor: DOMRect) => { const box = area.current?.getBoundingClientRect(); setLabelMenu({ nodeId: node.id, left: anchor.left - (box?.left ?? 0), top: anchor.bottom - (box?.top ?? 0) + 6 }); } : undefined;
  // The expanded Group under a point, for blocks being dragged: never one of them or a Group inside one.
  const groupAt = (point: { x: number; y: number }, nodeIds: string[]) => {
    const excluded = new Set(nodeIds.flatMap(id => [id, ...(descendantIds[id] ?? [])]));
    const inside = flow.getNodes().filter(item => item.type === 'research' && expandedIds.includes(item.id) && !excluded.has(item.id)).flatMap(item => { const absolute = flow.getInternalNode(item.id)?.internals.positionAbsolute; return absolute ? [{ id: item.id, absolute, width: item.width || 0, height: item.height || 0 }] : []; }).filter(item => point.x >= item.absolute.x && point.x <= item.absolute.x + item.width && point.y >= item.absolute.y && point.y <= item.absolute.y + item.height);
    return inside.at(-1) ?? null;
  };
  // The block under a point on the map; a block inside an open group comes after the group, so it wins.
  const blockAt = (point: { x: number; y: number }) => {
    const inside = flow.getNodes().filter(item => item.type === 'research').flatMap(item => { const absolute = flow.getInternalNode(item.id)?.internals.positionAbsolute; return absolute ? [{ id: item.id, absolute, width: item.width || CARD_SIZE.width, height: item.height || CARD_SIZE.height }] : []; }).filter(item => point.x >= item.absolute.x && point.x <= item.absolute.x + item.width && point.y >= item.absolute.y && point.y <= item.absolute.y + item.height);
    return inside.at(-1)?.id;
  };
  const selectedGroup = !readonly && !selecting && selectedId ? displayed.canvas.nodes.find(node => node.id === selectedId && isGroup(node)) : undefined;
  // The picked blocks: those chosen with the Group picker, a selection box or Shift/⌘-clicks, or else the selected one.
  const picked = selecting || groupSelection.length ? groupSelection : selectedId ? [selectedId] : [];
  const deletable = readonly || busy ? [] : picked.filter(id => displayed.canvas.nodes.some(node => node.id === id));
  // Shrinking a Group shrinks the blocks inside it; the group's frame follows them.
  const sizeTargets = useMemo(() => {
    if (readonly || busy) return [];
    const nodes = displayed.canvas.nodes, found = new Set<string>(), seen = new Set<string>();
    const add = (id: string) => { if (seen.has(id)) return; seen.add(id); const node = nodes.find(item => item.id === id); if (!node) return; if (isGroup(node)) nodes.filter(item => item.parentId === id).forEach(item => add(item.id)); else found.add(id); };
    picked.forEach(add);
    return nodes.filter(node => found.has(node.id));
  }, [picked, displayed.canvas.nodes, readonly, busy]);
  const sizeNow = sizeTargets.length && sizeTargets.every(node => cardScale(node) === cardScale(sizeTargets[0])) ? cardScale(sizeTargets[0]) : undefined;
  // Blocks shrunk together keep their arrangement: each one's place moves toward the top left of its row of siblings
  // by the same amount it shrinks, so the gaps between them shrink too.
  const resizeBlocks = (scale: number) => {
    setSizeMenu(null);
    const anchors = new Map<string, { x: number; y: number }>();
    for (const node of sizeTargets) { const key = node.parentId ?? '', at = anchors.get(key); anchors.set(key, at ? { x: Math.min(at.x, node.x), y: Math.min(at.y, node.y) } : { x: node.x, y: node.y }); }
    const operations: Mutation[] = sizeTargets.flatMap(node => {
      const ratio = scale / cardScale(node), at = anchors.get(node.parentId ?? '')!;
      if (Math.abs(ratio - 1) < 0.001) return [];
      return [{ type: 'updateNode' as const, id: node.id, patch: { scale: scale >= 1 ? null : scale, x: Math.round(at.x + (node.x - at.x) * ratio), y: Math.round(at.y + (node.y - at.y) * ratio) } }];
    });
    if (operations.length) void mutate(operations, scale >= 1 ? 'Show blocks at their own size' : 'Shrink blocks');
  };
  // Blocks already selected go straight into a new group when Group is pressed.
  const groupable = readonly || selecting ? [] : picked.filter(id => displayed.canvas.nodes.some(node => node.id === id));
  const groupBlocks = (ids: readonly string[], title: string) => {
    try {
      const id = crypto.randomUUID(), operations = createGroupOperations(displayed.canvas, ids, id, title, GROUP_INSET);
      if (!operations.length) return;
      void mutate(operations, 'Group selected blocks').then(saved => {
        if (saved === false) return;
        setSelecting(false); setGroupSelection([]); onExpandedChange([...expandedIds, id]); onSelect(id);
        setMessage('Group created. Models and authority retained.');
      });
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
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
    // Delete and Backspace belong to the map only while the map has the keyboard: focus on it, or nowhere after a click on
    // it. In an open block, a page over the map or a menu they delete nothing.
    let pressed: EventTarget | null = null;
    const down = (event: PointerEvent) => { pressed = event.target; };
    const onMap = (target: EventTarget | null) => target instanceof globalThis.Node && Boolean(area.current?.contains(target));
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="dialog"]')) return;
      if (!onMap(target) && !(target === document.body && onMap(pressed))) return;
      event.preventDefault(); removeRef.current();
    };
    window.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => { if (readonly) setPendingConnection(null); }, [readonly]);
  // What the chip on a line can do. A line keeps its edge object while nothing about it changes, so it reaches these
  // through a ref that always holds the latest canvas.
  const linkActions = useRef({ select: (_id: string | null) => {}, edit: (_id: string | null) => {}, rename: (_id: string, _word: string) => {}, swap: (_id: string) => {}, remove: (_ids: string[]) => {} });
  linkActions.current = {
    select: id => { setSelectedEdge(id); setEditingLink(null); setPendingConnection(null); if (id) { onSelect(null); setGroupSelection([]); } },
    edit: id => { if (readonly) return; setEditingLink(id ? { connectionId: id } : null); },
    rename: (id, word) => {
      setEditingLink(null);
      const current = displayed.canvas.connections.find(item => item.id === id), next = word.replace(/\s+/gu, ' ').trim().slice(0, LINK_WORD_LIMIT);
      if (!current || current.label.trim() === next) return;
      void mutate([{ type: 'updateConnection', id, patch: { label: next } }], next ? `Name link ${next.slice(0, 40)}` : 'Remove the word of a link');
    },
    swap: id => {
      setEditingLink(null);
      const current = displayed.canvas.connections.find(item => item.id === id);
      if (!current) return;
      if (displayed.canvas.connections.some(item => item.source === current.target && item.target === current.source)) { setMessage('A link already runs the other way.'); return; }
      void mutate([{ type: 'updateConnection', id, patch: { source: current.target, target: current.source } }], 'Swap link direction');
    },
    remove: ids => {
      setEditingLink(null);
      const live = ids.filter(id => displayed.canvas.connections.some(item => item.id === id));
      if (!live.length) return;
      void mutate(live.map(id => ({ type: 'removeConnection' as const, id })), live.length === 1 ? 'Delete link' : `Delete ${live.length} links`).then(saved => { if (saved !== false) setMessage(live.length === 1 ? 'Link deleted. Undo brings it back.' : `Deleted ${live.length} links. Undo brings them back.`); });
    },
  };
  // A link just drawn is selected with its word open; a line whose links are all gone is no longer selected.
  useEffect(() => {
    const id = pendingEdit.current, group = id ? aggregatedRelationships.find(item => item.contributions.some(entry => entry.connection.id === id)) : undefined;
    if (id && group) { pendingEdit.current = null; setSelectedEdge(group.id); onSelect(null); setEditingLink(readonly ? null : { connectionId: id }); }
    if (selectedEdge && !aggregatedRelationships.some(item => item.id === selectedEdge)) { setSelectedEdge(null); setEditingLink(null); }
  }, [aggregatedRelationships]); // eslint-disable-line react-hooks/exhaustive-deps
  // With a line selected and no block picked, Backspace deletes its links and Enter opens the word of a single link.
  const linkKeys = useRef({ selectedEdge, editingLink, readonly, groups: aggregatedRelationships, picked: picked.length, canvas: displayed.canvas });
  linkKeys.current = { selectedEdge, editingLink, readonly, groups: aggregatedRelationships, picked: picked.length, canvas: displayed.canvas };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const { selectedEdge, editingLink, readonly, groups, picked, canvas } = linkKeys.current;
      if (!selectedEdge || editingLink || readonly || picked || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="dialog"]')) return;
      const group = groups.find(item => item.id === selectedEdge);
      if (!group) return;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); linkActions.current.remove(group.contributions.map(item => item.connection.id)); }
      else if (event.key === 'Enter' && group.contributions.length === 1 && !isTrail(group.contributions[0].connection, id => canvas.nodes.find(node => node.id === id))) { event.preventDefault(); linkActions.current.edit(group.contributions[0].connection.id); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
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
      // While Plugins, Agents, Skills or Settings covers the map, the keys must not change a canvas nobody can see.
      if (document.querySelector('.rail-page')) return;
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
    const copy = copyBlocks(displayed.canvas, picked, detail.project.id, detail.project.title);
    if (!copy || !event.clipboardData) return;
    const roots = copy.nodes.filter(node => !copy.nodes.some(item => item.id === node.parentId));
    const text = JSON.stringify(copy), plain = roots.map(node => node.title).join('\n');
    event.clipboardData.setData(BLOCKS_MIME, text); event.clipboardData.setData('text/plain', plain); event.preventDefault();
    lastCopy = { text, plain };
    setToast({ text: roots.length === 1 ? `Copied ${roots[0].title}` : `Copied ${roots.length} blocks`, key: Date.now() });
  };
  const pasteCopied = (event: ClipboardEvent) => {
    const data = event.clipboardData, plain = data?.getData('text/plain') ?? '';
    // Some browsers keep only plain text, so the last copy made here stands in when the text still matches it.
    const text = data?.getData(BLOCKS_MIME) || (lastCopy && plain === lastCopy.plain ? lastCopy.text : '');
    const copy = text ? readCopiedBlocks(text) : null;
    if (!copy) return;
    event.preventDefault();
    if (readonly || busy) { setMessage(readonly ? 'This canvas is read only. Go back to the current canvas to paste.' : 'Still saving. Paste again in a moment.'); return; }
    const { operations, ids, sources } = pasteOperations(copy, displayed.canvas, detail.project.id, undefined, node => { const shown = flow.getNode(node.id); return shown?.width && shown.height ? { width: shown.width, height: shown.height } : undefined; });
    const title = copy.nodes.find(node => !copy.nodes.some(item => item.id === node.parentId))?.title;
    const label = ids.length === 1 ? `Paste ${title}` : `Paste ${ids.length} blocks`;
    const originals = new Map(copy.nodes.map(node => [node.id, node]));
    const artifacts = Object.fromEntries(Object.entries(sources).flatMap(([copied, original]) => { const artifactId = originals.get(original)?.artifactId; return artifactId ? [[copied, artifactId]] : []; }));
    const saving = paste ? paste({ operations, label, from: copy.projectId, sources, artifacts }) : mutate(operations, label).then(saved => saved === false ? null : { missing: [] });
    void saving.then(result => {
      if (!result) return;
      // Several pasted blocks stay picked, so they can be dragged on together.
      setGroupSelection(selecting || ids.length > 1 ? ids : []); onSelect(selecting || ids.length !== 1 ? null : ids[0]);
      // The nearest free spot can be off screen on a full canvas; then the view moves to the pasted blocks.
      const first = operations.find(op => op.type === 'addNode' && op.node.id === ids[0]), box = area.current?.getBoundingClientRect();
      const at = first?.type === 'addNode' && !first.node.parentId ? flow.flowToScreenPosition({ x: first.node.x, y: first.node.y }) : null;
      if (!at || !box || at.x < box.left || at.y < box.top || at.x > box.right - 120 || at.y > box.bottom - 120) setFrameRequest(ids);
      const elsewhere = copy.projectId !== detail.project.id && copy.projectTitle ? ` from ${copy.projectTitle}` : '';
      const lost = result.missing.length ? ` · ${result.missing.length === 1 ? `${result.missing[0]} came without its file` : `${result.missing.length} came without their files`}` : '';
      setToast({ text: `${ids.length === 1 ? `Pasted ${title}` : `Pasted ${ids.length} blocks`}${elsewhere}${lost}`, undo: true, key: Date.now() });
    });
  };
  const clipboardRef = useRef({ copy: copySelected, paste: pasteCopied }); clipboardRef.current = { copy: copySelected, paste: pasteCopied };
  useEffect(() => {
    // Typing somewhere, or a page that covers the map: copy and paste are not the map's then.
    const typing = (event: ClipboardEvent) => Boolean((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="dialog"]') || document.querySelector('.rail-page'));
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
  // A Web block's page opens as its saved search excerpt; a named link not yet read opens in the browser.
  const webFace = (node: CanvasNode): WebFaceData => {
    const state = webState(node, displayed.canvas, detail.runs, detail.artifacts);
    return { search: node.web!, state, onOpen: source => { if (source.artifacts[0]) onArtifact(source.artifacts[0], node.id); else window.open(source.url, '_blank', 'noopener,noreferrer'); },
      onStop: readonly || !state.sweepId ? undefined : () => { void api(`/api/runs/${encodeURIComponent(state.sweepId!)}/cancel`, { method: 'POST' }).then(() => setMessage('Stopped the searches. The pages found so far stay on the block.')).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Could not stop the searches.')); } };
  };
  // Apps on the canvas read their watched blocks again when the project changes.
  const appWatch = `${detail.project.revision}:${detail.artifacts.length}:${detail.artifacts[0]?.id ?? ''}`;
  const computedNodes = useMemo<(ResearchNode)[]>(() => {
    const build = (parentId: string | null, depth = 0): { nodes: (ResearchNode)[]; width: number; height: number } => {
      const siblings = displayed.canvas.nodes.filter(n => (n.parentId || null) === parentId).sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
      const built: (ResearchNode)[] = []; let right = 0, bottom = 0;
      for (const node of siblings) {
        const expanded = isGroup(node) && expandedIds.includes(node.id); const child = expanded ? build(node.id, depth + 1) : { nodes: [], width: 0, height: 0 };
        const { width, height } = expanded ? openGroupSize(child) : cardSizes[node.id];
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
        const direction = node.blockType === 'search' || node.label === 'result';
        // A block an agent made says so on its provenance line: a Result note through its link from the Agent block, a finding through its Result note.
        const origin=blockOrigin(displayed.canvas,node.id);
        built.push({ id: node.id, type: 'research', parentId: parentId || undefined, position: { x: box.x + (parentId ? GROUP_INSET.x : 0), y: box.y + (parentId ? GROUP_INSET.y : 0) }, width, height, style: { width, height }, selected: groupSelection.includes(node.id) || node.id === selectedId, zIndex: depth, dragHandle: '.group-heading', data: { workLabel, ...notebookCard(detail, node.id), notion: node.notion ? { projectId: detail.project.id, view: node.notion, onRows: readonly ? undefined : table => rowBlocks(node.id, table) } : undefined, training: node.training ? { projectId: detail.project.id, view: node.training } : undefined, metric: node.metric ? { projectId: detail.project.id, view: node.metric } : undefined, dashboard: node.blockType === 'dashboard' ? { projectId: detail.project.id, view: node.dashboard ?? { tiles: [] }, sources: dashboardSources(detail.project.canvas.nodes) } : undefined, post: node.post ? { projectId: detail.project.id, view: node.post } : undefined, google: node.google ? { projectId: detail.project.id, view: node.google, onCopy: readonly || !onGoogleCopy || node.google.kind !== 'sheet' ? undefined : () => onGoogleCopy(node.id) } : undefined, file: node.file ? shownFile(detail.project.id, node, folderFiles?.get(node.id), pictureSizes[node.id]) : undefined, picture: isPictureNode(node), onPictureSize: size => learnPictureSize(node.id, size), origins:Object.fromEntries(displayed.canvas.nodes.map(item=>[item.id,item.title])), blockType:node.blockType, kindName:kindName(node), textLabel:textLabel(node), origin, onLabel:labelMenuOpener(node), code:nodeBlockType(node)==='code'?node.code?.source??detail.artifacts.find(item=>item.id===node.artifactId&&item.kind==='code')?.content??'':undefined, app:node.blockType==='app'?{ projectId: detail.project.id, version: appVersion(node.app?.source ?? ''), inputs: node.app?.inputs.length ?? 0, watchKey: appWatch, onFocus: blockId => { onSelect(blockId); setFocusRequest(blockId); }, ...(historyCanvas ? { still: 'An App from a saved canvas. It runs on the current canvas.' } : proposal && ['added','changed'].includes(displayed.marks.get(node.id) ?? '') ? { proposalId: proposal.id, leaves: appFlags(node.app?.source ?? '') } : {}) }:undefined, primary:isGroup(node)||node.file?undefined:primaryArtifact(node,detail), members:displayed.canvas.nodes.filter(item=>item.parentId===node.id).length, listed:isGroup(node)&&!expanded?groupPreviewMembers(displayed.canvas,node.id).map(({id,title,kind,blockType,google,metric,post})=>({id,title,kind,blockType,google:google?.kind,metric:metric?.source,post:post?.platform})):undefined, chosen:(node.groupHighlights??[]).flatMap(highlight=>{const artifact=detail.artifacts.find(item=>item.id===highlight.artifactId&&item.nodeId===highlight.nodeId&&item.hash===highlight.hash);return artifact?[artifact]:[];}), onHighlightOpen:artifact=>onArtifact(artifact,artifact.nodeId), results: resultPages[node.id], onResultChoice: choice => changeResults(node.id, choice), resizePending: resizingCards.includes(node.id), outcome: cardOutcomes[node.id], width: fullSizes[node.id].width, height: fullSizes[node.id].height, scale: cardScale(node), heightSet: Boolean(draftSizes[node.id]?.height ?? setCardHeight(node)) && !isPictureNode(node), onResize: (size, commit) => resizeCard(node.id, size, commit), onAutoHeight: () => fitHeight(node.id), onMeasure: (width, height) => measureCard(node.id, width, height), kind: node.kind, title: node.title, description: node.description, status, awaitingApproval: runs.some(r => (r.configuration.approval as { status?: string } | undefined)?.status === 'pending'), inputCount: detail.inputs.filter(i => i.nodeId === node.id).length, resultCount: detail.artifacts.filter(a => a.nodeId === node.id && isOutputArtifact(a)).length, expanded, preview: displayed.marks.get(node.id), onExpand: () => toggle(node.id), onInspect: () => {const artifact=node.artifactId?detail.artifacts.find(item=>item.id===node.artifactId):undefined;if(artifact&&!['code','notebook','file'].includes(node.blockType??''))onArtifact(artifact,node.id);else onInspect(node.id);}, onActivate: () => onSelect(node.id), onAdd: () => onBrowse(node.id), onHandle: side => handleClick(node.id, side), onSave: (title, description) => mutate([{ type: 'updateNode', id: node.id, patch: { title, description } }], 'Edit note'), readonly, fileMissing: missingFiles?.has(node.id), agent: node.agent ? agentTurns?.[node.agent.turnId] : undefined, label: node.label, sources: direction ? detail.artifacts.filter(a => a.nodeId === node.id && a.kind === 'source').sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : undefined, why: direction ? displayed.canvas.connections.find(c => c.target === node.id && displayed.canvas.nodes.find(n => n.id === c.source)?.blockType === 'agent')?.label : undefined, queries: node.label === 'result' ? runs.filter(r => r.provider === 'tavily').map(r => r.request) : undefined, check: node.check ? checkTally(node.check) : node.blockType === 'agent' ? (checked => checked?.check ? checkTally(checked.check) : undefined)(displayed.canvas.nodes.find(item => item.check?.agentNodeId === node.id)) : undefined, directions: node.blockType === 'agent' ? (({ directions, written, sources, pages, findings }) => ({ total: directions.length, written, sources, pages: pages.length, findings }))(agentDirections(displayed.canvas, detail.artifacts, node.id, detail.runs)) : undefined, web: node.blockType === 'web' && node.web ? webFace(node) : undefined } }, ...child.nodes);
      }
      return { nodes: built, width: right, height: bottom };
    };
    return build(null).nodes;
  }, [displayed, expandedIds, detail.runs, detail.inputs, detail.artifacts, selectedId, highlights, readonly, pendingConnection, cardSizes, fullSizes, draftSizes, cardOutcomes, resizingCards, resultPages, descendantIds, groupSelection, missingFiles, agentTurns, appWatch, folderFiles, pictureSizes]);
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
      state = { plan: createCanvasReflowPlan(source, actualSizes, cardSizes), canvas: source, sizes: actualSizes, positions, dimensions, structure, shape, ready: false, settled: false, expanded: [] };
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
      state.plan = createCanvasReflowPlan(source, actualSizes, cardSizes); state.settled = false;
    } else if (state.structure !== structure) {
      state.plan = extendCanvasReflowPlan(source, { ...actualSizes, ...state.sizes }, state.plan, cardSizes); state.settled = false;
    }
    state.positions = positions; state.canvas = source; state.structure = structure;
    if (!state.ready && !shapeChanged) {
      // Initial font/card measurements establish the baseline. Reopening a
      // project never becomes an implicit Arrange or a layout persistence loop.
      state.plan = createCanvasReflowPlan(source, actualSizes, cardSizes); state.dimensions = dimensions; state.sizes = actualSizes; state.settled = false;
      const timer = setTimeout(() => { if (reflowState.current === state) { state.ready = true; setReflowRevision(revision => revision + 1); } }, 180);
      return () => clearTimeout(timer);
    }
    // Blocks moved onto each other (by another browser, an agent or a drop) or an open Group with room before its
    // content settle once, without waiting for a block to change size.
    const unsettledLayout = !state.settled && unsettled(source, actualSizes, expandedIds);
    if (!shapeChanged && !sizeChanged && !unsettledLayout) { state.settled = true; state.expanded = [...expandedIds]; return; }
    const timer = setTimeout(() => {
      if (dragging.current || reflowWriting.current || reflowState.current !== state) return;
      const opening = expandedIds.filter(id => !state.expanded.includes(id));
      const result = reflowCanvas(source, state.plan, { expandedIds, extraContent, nodeSizes: cardSizes, opening });
      const operations: Mutation[] = result.canvas.nodes.flatMap(node => {
        const before = source.nodes.find(candidate => candidate.id === node.id)!;
        return before.x === node.x && before.y === node.y ? [] : [{ type: 'updateNode' as const, id: node.id, patch: { x: node.x, y: node.y } }];
      });
      state.ready = true; state.settled = true; state.plan = result.plan; state.expanded = [...expandedIds];
      state.shape = shape; state.dimensions = sizeKey(result.sizes); state.positions = positionKey(result.canvas);
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
      // React Flow's measurements are read as the update applies, so a size it reported since the last render (a group
      // that just closed) is kept; an older one would stay, since the block does not resize again to correct it.
      setAnimatingLayout(false); setNodes(current => { const measurements = new Map(current.map(node => [node.id, node.measured])); return shown.map(node => ({ ...node, measured: measurements.get(node.id) })); }); return;
    }
    const before = new Map(liveNodes.current.map(node => [node.id, node]));
    const started = performance.now(), duration = 420;
    setAnimatingLayout(true);
    const frame = (time: number) => {
      const progress = Math.min(1, (time - started) / duration), eased = 1 - (1 - progress) ** 3;
      // React Flow invalidates handle bounds if a controlled update drops measured.
      // Keep its latest measurements while ResizeObserver follows changing group sizes.
      setNodes(current => { const measurements = new Map(current.map(node => [node.id, node.measured])); return shown.map(node => {
        const measured = measurements.get(node.id);
        const original = before.get(node.id); if (!original || progress === 1) return { ...node, measured };
        const width = (original.width || 0) + ((node.width || 0) - (original.width || 0)) * eased;
        const height = (original.height || 0) + ((node.height || 0) - (original.height || 0)) * eased;
        return { ...node, measured, position: { x: original.position.x + (node.position.x - original.position.x) * eased, y: original.position.y + (node.position.y - original.position.y) * eased }, width, height, style: { ...node.style, width, height } };
      }); });
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
  // The lines between the visible blocks. Each leaves the side of its block that faces the other block and arrives at
  // the facing side as a soft curve; links sharing a side spread along it; the word sits at the middle of the curve, or
  // the nearest spot no other block covers. Links with the same word that meet on one side of a block end at one point
  // there and share one chip ("supports · 2"), so words never lie on each other. Original endpoints stay visible in
  // open groups; closed groups gather their links.
  const linkEdges = (groups: AggregateRelationship[], geometry: Geometry[]): LinkEdge[] => {
    const boxes = new Map(geometry.map(item => [item.id, item]));
    const node = (id: string) => displayed.canvas.nodes.find(item => item.id === id), title = (id: string) => node(id)?.title.trim() || 'Untitled block';
    const sided = groups.flatMap(group => { const a = boxes.get(group.source), b = boxes.get(group.target); return a && b ? [{ group, a, b, ...facingSides(a, b) }] : []; });
    // Bundles: single links with the same word on the same side of a block, where they arrive or where they leave.
    const words = new Map(sided.map(({ group }) => [group.id, group.contributions.length === 1 && !isTrail(group.contributions[0].connection, node) ? linkWord(group, node) : '']));
    const bundles = new Map<string, string[]>(), bundleOf = new Map<string, { key: string; end: 'source' | 'target' }>();
    for (const end of ['target', 'source'] as const) for (const item of sided) {
      const word = words.get(item.group.id);
      if (!word || bundleOf.has(item.group.id)) continue;
      const key = `${end}:${item.group[end]}:${item[end]}:${word.toLowerCase()}`;
      bundles.set(key, [...(bundles.get(key) ?? []), item.group.id]);
    }
    for (const [key, ids] of bundles) if (ids.length > 1) for (const id of ids) if (!bundleOf.has(id)) bundleOf.set(id, { key, end: key.startsWith('target') ? 'target' : 'source' });
    const slotId = (id: string, end: 'source' | 'target') => { const bundle = bundleOf.get(id); return bundle?.end === end ? bundle.key : id; };
    const slots = new Map<string, { id: string; order: number }[]>();
    const take = (nodeId: string, side: LinkSide, id: string, other: LinkBox) => { const key = `${nodeId}:${side}`, list = slots.get(key) ?? []; if (list.some(item => item.id === id)) return; list.push({ id, order: side === 'left' || side === 'right' ? other.y + other.height / 2 : other.x + other.width / 2 }); slots.set(key, list); };
    for (const { group, a, b, source, target } of sided) { take(group.source, source, slotId(group.id, 'source'), b); take(group.target, target, slotId(group.id, 'target'), a); }
    const fraction = (nodeId: string, side: LinkSide, id: string) => { const list = [...(slots.get(`${nodeId}:${side}`) ?? [])].sort((x, y) => x.order - y.order); return sideFraction(list.findIndex(item => item.id === id), list.length); };
    return sided.map(({ group, a, b, source, target }) => {
      const curve = linkCurve(sideAnchor(a, source, fraction(group.source, source, slotId(group.id, 'source'))), source, sideAnchor(b, target, fraction(group.target, target, slotId(group.id, 'target'))), target);
      const obstacles = geometry.filter(item => item.id !== group.source && item.id !== group.target && !expandedIds.includes(item.id));
      const chip = chipPoint(curve.point, obstacles);
      // The first link of a bundle carries the shared chip, near the end the links share.
      const bundle = bundleOf.get(group.id), members = bundle ? bundles.get(bundle.key)! : [], near = bundle?.end === 'target' ? 1 : 0;
      const shared = bundle && members[0] === group.id ? { text: `${words.get(group.id)} · ${members.length}`, point: chipPoint(t => curve.point(Math.min(.94, Math.max(.06, t + (near ? .3 : -.3)))), obstacles) } : null;
      const links: LinkRow[] = group.contributions.map(({ connection, sourceTitle, targetTitle }) => { const trail = isTrail(connection, node); return { id: connection.id, sourceTitle, targetTitle, word: trail ? trailWording(connection, node) : connection.label.trim(), trail }; });
      const trail = links.every(item => item.trail), selected = group.id === selectedEdge, arrow = group.bidirectional ? '↔' : '→', word = linkWord(group, node);
      // The arrowhead takes the line's grey; the style sheet draws a resting line and its arrow at half strength.
      const color = selected && !trail ? '#171717' : '#6b6b6b';
      const marker = { type: MarkerType.ArrowClosed, width: 24, height: 24, markerUnits: 'userSpaceOnUse', strokeWidth: 1, color };
      const closed = [group.source, group.target].map(node).find(item => item && isGroup(item) && !expandedIds.includes(item.id));
      const edge: LinkEdge = { id: group.id, type: 'link', source: group.source, target: group.target, sourceHandle: source, targetHandle: target, selected, className: trail ? 'link trail' : 'link', ariaLabel: `Link: ${title(group.source)} ${arrow} ${title(group.target)}${word ? ` · ${word}` : ''}`, interactionWidth: 24, markerEnd: marker, ...(group.bidirectional ? { markerStart: marker } : {}),
        data: { path: curve.path, chip, word, quiet: Boolean(bundle), shared, count: links.length, trail, trailWord: links.length === 1 ? links[0].word : `${links.length} trails`, editable: !readonly, editingId: editingLink && links.some(item => item.id === editingLink.connectionId) ? editingLink.connectionId : null, links, heading: `${links.length} links · ${title(group.source)} ${arrow} ${title(group.target)}`, note: closed ? `Open ${closed.title.trim() || 'the group'} to see each line on its own block.` : '', onSelect: () => linkActions.current.select(group.id), onEdit: id => linkActions.current.edit(id), onRename: (id, next) => linkActions.current.rename(id, next), onSwap: id => linkActions.current.swap(id), onDelete: ids => linkActions.current.remove(ids), onClose: () => linkActions.current.select(null) } };
      // An unchanged edge keeps its object, so dragging one block redraws only the lines that move with it.
      const key = JSON.stringify(edge), shown = shownEdges.current.get(group.id);
      if (shown?.key === key) return shown.edge;
      shownEdges.current.set(group.id, { key, edge });
      return edge;
    });
  };
  const edges = useMemo<LinkEdge[]>(() => {
    const byId=new Map(nodes.map(node=>[node.id,node]));
    const absolute=(id:string):{x:number;y:number}=>{const node=byId.get(id)!;const parent=node.parentId?absolute(node.parentId):{x:0,y:0};return {x:node.position.x+parent.x,y:node.position.y+parent.y};};
    return linkEdges(aggregatedRelationships, nodes.filter(node=>node.type==='research').map(node=>({id:node.id,parentId:node.parentId,...absolute(node.id),width:node.width||CARD_SIZE.width,height:node.height||CARD_SIZE.height})));
  }, [aggregatedRelationships, nodes, selectedEdge, editingLink, expandedIds, displayed.canvas, readonly]); // eslint-disable-line react-hooks/exhaustive-deps
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
    const geometry: Geometry[] = [...nodeLookup.values()].filter(node => node.type === 'research').map(node => ({ id: node.id, parentId: node.parentId, ...node.internals.positionAbsolute, width: node.width || CARD_SIZE.width, height: node.height || CARD_SIZE.height }));
    const routed = new Map(linkEdges(groups, geometry).map(edge => [edge.id, edge]));
    state.setEdges(state.edges.map(edge => routed.get(edge.id) ?? edge));
  };
  // Anything else React Flow reports while blocks move (a measured size, a box being drawn) keeps them where they are shown.
  const keepLive = (current: (ResearchNode)[]) => {
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
        if (pendingConnection && pendingConnection.nodeId !== node.id) connect(pendingConnection.nodeId, node.id);
        else if (selecting) setGroupSelection(ids => ids.includes(node.id) ? ids.filter(id => id !== node.id) : [...ids, node.id]);
        // Shift or ⌘ adds a block to the picked ones, or takes it out again.
        else if (event.shiftKey || event.metaKey || event.ctrlKey) { const next = picked.includes(node.id) ? picked.filter(id => id !== node.id) : [...picked, node.id]; setGroupSelection(next.length > 1 ? next : []); onSelect(next.length === 1 ? next[0] : null); }
        else { if (groupSelection.length) setGroupSelection([]); onSelect(node.id); }
      }
      setSelectedEdge(null); setEditingLink(null);
    },
    onNodeDoubleClick: (event, node) => { if ((event.target as HTMLElement).closest('input,textarea,button,.inline-note-editor')) return; if (node.type === 'research') { if(isGroup(displayed.canvas.nodes.find(item=>item.id===node.id)!)) toggle(node.id); else {const contentNode=displayed.canvas.nodes.find(item=>item.id===node.id),artifact=detail.artifacts.find(item=>item.id===contentNode?.artifactId);if(artifact&&!['code','notebook','file'].includes(contentNode?.blockType??''))onArtifact(artifact,node.id);else onInspect(node.id);} } },
    onPaneClick: () => { if(!selecting)setGroupSelection([]); onSelect(null); setSelectedEdge(null); setEditingLink(null); setPendingConnection(null); closeLabelMenu(); },
    onEdgeClick: (_, edge) => linkActions.current.select(edge.id),
    onEdgeDoubleClick: (_, edge) => { const group = aggregatedRelationships.find(item => item.id === edge.id), only = group?.contributions.length === 1 ? group.contributions[0].connection : undefined; if (only && !isTrail(only, id => displayed.canvas.nodes.find(node => node.id === id))) linkActions.current.edit(only.id); },
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
    onNodeDragStop: (event, _node, dragged) => {
      dropTargetId.current = null; setDropTarget(null);
      const pointer = 'changedTouches' in event ? event.changedTouches[0] : event, point = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
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
    onConnect: c => { if (c.source && c.target) connect(c.source, c.target); },
    // Let go anywhere over a block, not only over one of its dots, and the block under the pointer is the other end.
    onConnectEnd: (event, state) => {
      if (state.isValid || !state.fromNode || readonly) return;
      const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
      const target = blockAt(flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY })) ?? (event.target as HTMLElement | null)?.closest?.('.react-flow__node-research')?.getAttribute('data-id');
      if (target && target !== state.fromNode.id) connect(state.fromNode.id, target);
    },
    onMoveStart: closeLabelMenu,
    onMoveEnd: (_, view) => saveLocal(viewKey, view),
  });
  // Add block opens its menu beside whichever control asked for it: the dock's black tile, or the button in the middle
  // of an empty map. The menu goes to the right of the control, or to its left when the window is too narrow for that.
  const openAddMenu = (control: HTMLElement) => {
    if (addMenu) { setAddMenu(null); return; }
    const frame = area.current?.getBoundingClientRect();
    if (!frame) return;
    const rect = control.getBoundingClientRect(), fits = rect.right + 10 + 280 <= frame.right - 16;
    setAddMenu({ left: fits ? rect.right - frame.left + 10 : rect.left - frame.left - 10 - 280, top: rect.top - frame.top - 6 });
  };
  // Double-clicking empty map opens the same menu at the pointer, and the block it adds lands there, centred on the spot.
  const openAddMenuAt = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (readonly || busy || hand || !(event.target as HTMLElement).classList.contains('react-flow__pane')) return;
    const frame = area.current?.getBoundingClientRect();
    if (!frame) return;
    const spot = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), fits = event.clientX + 8 + 280 <= frame.right - 16;
    onSelect(null);
    setAddMenu({ left: fits ? event.clientX - frame.left + 8 : event.clientX - frame.left - 8 - 280, top: event.clientY - frame.top - 6, at: { x: Math.round(spot.x - CARD_SIZE.width / 2), y: Math.round(spot.y - 24) } });
  };
  // The map's tools, in the groups the dock draws: add, pointer, arrange, history, view. Add block is the dock's
  // one black tile, and its hint says what a block can be. An empty map has its Add a block button in the middle
  // instead, and shows the dock only when there is something to undo.
  const divider = (id: string): DockItem => ({ id, divider: true });
  const addItem: DockItem = { id: 'add', label: selectedGroup ? 'Add inside' : 'Add block', hint: selectedGroup ? `Into ${selectedGroup.title}` : 'Text, Code, Data, a file, a paper…', icon: <Plus size={18}/>, primary: true, disabled: readonly || busy, pressed: Boolean(addMenu), testId: 'add-node', onClick: event => openAddMenu(event.currentTarget) };
  const historyItems: DockItem[] = [
    ...(onUndo ? [{ id: 'undo', label: 'Undo', hint: `${modKey}Z`, icon: <Undo2 size={18}/>, disabled: !detail.canUndo || readonly || busy, onClick: onUndo }] : []),
    ...(onRedo ? [{ id: 'redo', label: 'Redo', hint: modKey === '⌘' ? '⌘⇧Z' : 'Ctrl+Shift+Z', icon: <Redo2 size={18}/>, disabled: !detail.canRedo || readonly || busy, onClick: onRedo }] : []),
    ...(onHistory ? [{ id: 'history', label: 'History', hint: 'Earlier versions of the map', icon: <History size={18}/>, pressed: historyOpen, expanded: historyOpen, controls: 'canvas-content-history', onClick: onHistory }] : []),
  ];
  const dockItems: DockItem[] = !nodes.length ? (historyItems.length && (detail.canUndo || detail.canRedo) ? historyItems : []) : [
    addItem, divider('add-divider'),
    { id: 'move', label: 'Move', hint: 'V', icon: <MousePointer2 size={18}/>, pressed: canvasTool.tool === 'move', onClick: () => canvasTool.setTool('move') },
    { id: 'hand', label: 'Hand', hint: 'H, or hold Space', icon: <Hand size={18}/>, pressed: canvasTool.tool === 'hand', onClick: () => canvasTool.setTool('hand') },
    divider('arrange-divider'),
    { id: 'group', label: selecting ? 'Done' : groupable.length ? 'Group selected' : 'Group', hint: selecting ? 'Stop picking blocks' : groupable.length ? `Put the ${groupable.length === 1 ? 'selected block' : `${groupable.length} selected blocks`} in a new group` : 'Pick blocks, then group them', icon: <BoxSelect size={18}/>, pressed: selecting, disabled: readonly || busy, onClick: () => { if (!selecting && groupable.length) { groupBlocks(groupable, 'Untitled'); return; } setSelecting(!selecting); setGroupSelection([]); onSelect(null); } },
    ...(selectedGroup ? [{ id: 'ungroup', label: 'Ungroup', hint: 'Its blocks stay where they are', icon: <Ungroup size={18}/>, disabled: busy, onClick: () => {
      // The blocks keep their places. A Group with text or links of its own leaves that as a note in the first free spot
      // beside them, found on the map as it will be once the blocks are out of the frame.
      const canvas = displayed.canvas, keeps = groupKeepsNote(canvas, selectedGroup), moved = ungroupOperations(canvas, selectedGroup, GROUP_INSET);
      const places = new Map(moved.flatMap(op => op.type === 'updateNode' && op.id !== selectedGroup.id ? [[op.id, op.patch] as const] : []));
      const after = { ...canvas, nodes: canvas.nodes.filter(node => node.id !== selectedGroup.id).map(node => places.has(node.id) ? { ...node, ...places.get(node.id) } : node) };
      const operations = keeps ? ungroupOperations(canvas, selectedGroup, GROUP_INSET, emptyPosition(after, selectedGroup.parentId ?? null, expandedIds)) : moved;
      void mutate(operations, 'Ungroup').then(saved => { if (saved !== false) { onExpandedChange(expandedIds.filter(id => id !== selectedGroup.id)); onSelect(null); setMessage(keeps ? 'Group dissolved. Its blocks stay, and its text is now a block beside them.' : 'Group dissolved. Its blocks stay where they are.'); } });
    } }] : []),
    { id: 'up', label: 'Up a level', hint: 'To the group around the block', icon: <CornerLeftUp size={18}/>, onClick: broader },
    { id: 'tidy', label: 'Tidy', hint: 'Line blocks up', icon: arranging || animatingLayout ? <LoaderCircle size={18} className="spin"/> : <LayoutGrid size={18}/>, disabled: readonly || arranging || animatingLayout || !displayed.canvas.nodes.length, onClick: () => void arrange() },
    { id: 'size', label: 'Size', hint: sizeTargets.length ? 'Shrink picked blocks; they stay whole' : 'Pick blocks to shrink them', icon: <Minimize2 size={18}/>, testId: 'canvas-size', disabled: !sizeTargets.length, pressed: Boolean(sizeMenu), expanded: Boolean(sizeMenu), onClick: event => { if (sizeMenu) { setSizeMenu(null); return; } const box = area.current?.getBoundingClientRect(), tile = event.currentTarget.getBoundingClientRect(); setSizeMenu({ left: tile.right - (box?.left ?? 0) + 10, top: tile.top - (box?.top ?? 0) }); } },
    { id: 'delete', label: 'Delete', hint: deletable.length > 1 ? `${deletable.length} picked blocks · ⌫` : '⌫', icon: <Trash2 size={18}/>, disabled: !deletable.length, onClick: removeSelected },
    ...(historyItems.length ? [divider('history-divider'), ...historyItems] : []),
    divider('view-divider'),
    { id: 'all', label: 'See all', hint: 'Every block in view', icon: <Maximize size={18}/>, onClick: () => void fitCanvas(400, true) },
    { id: 'collapse', label: 'Collapse', hint: 'Close every open group', icon: <PanelTopClose size={18}/>, disabled: !expandedIds.length, onClick: () => { onExpandedChange([]); onSelect(null); } },
    ...(onShare && !historyCanvas ? [divider('share-divider'), { id: 'share', label: 'Share', hint: 'A file anyone can open, without your private things', icon: <ShareIcon size={18}/>, onClick: () => {
      const layout: Record<string, Box> = {};
      for (const item of flow.getNodes()) {
        if (item.type !== 'research' || item.hidden) continue;
        const absolute = flow.getInternalNode(item.id)?.internals.positionAbsolute, width = item.measured?.width ?? item.width, height = item.measured?.height ?? item.height;
        if (absolute && width && height) layout[item.id] = { x: Math.round(absolute.x), y: Math.round(absolute.y), width: Math.round(width), height: Math.round(height) };
      }
      onShare({ layout, open: expandedIds });
    } }] : []),
  ];
  return <div ref={area} className={`canvas-area unified-canvas direct-canvas ${pendingConnection ? 'is-connecting' : ''} ${arranging || animatingLayout ? 'is-arranging' : ''}${proposal && !historyCanvas ? ' previewing-proposal' : ''}${dropping ? ' canvas-drop-target' : ''} ${hand ? 'canvas-hand-tool' : 'canvas-move-tool'}${canvasTool.spaceHeld ? ' canvas-space-pan' : ''}`} data-testid="canvas"
    onDragOver={event => { if (dropFiles(event) && !dropping) setDropping(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDropping(false); }}
    onDrop={event => { setDropping(false); if (!dropFiles(event)) return; onDropFiles!(Array.from(event.dataTransfer.files), flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}
    onDoubleClick={openAddMenuAt}>
    <ReactFlow<ResearchNode, LinkEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} {...flowHandlers}
      connectionMode={ConnectionMode.Loose} connectOnClick={false} connectionRadius={28} nodesDraggable={!readonly && !animatingLayout} nodeDragThreshold={0} nodesConnectable={!readonly} selectNodesOnDrag={false}
      panOnDrag={hand || readonly ? true : [1]} selectionOnDrag={!hand && !readonly} selectionMode={SelectionMode.Partial} panOnScroll panOnScrollSpeed={1} zoomOnPinch deleteKeyCode={null} minZoom={.08} maxZoom={1.8} defaultViewport={viewport.current} zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#b8b8b8" bgColor="#ffffff"/><CanvasMinimap/>{proposalCard && proposalAnchors.length > 0 && <NodeToolbar nodeId={proposalAnchors} isVisible position={Position.Right} align="start" offset={20} className="proposal-anchor nodrag nopan nowheel">{proposalCard}</NodeToolbar>}</ReactFlow>
    <div className="canvas-header">
      {(historyCanvas || proposal) && <div className="canvas-context"><span className="canvas-state">{historyCanvas ? 'Saved canvas · read only' : 'Proposed changes'}</span></div>}
      {showStageNavigation && <nav className="canvas-stage-navigation" aria-label="Research stages">{rootStages.map((node, index) => <button key={node.id} className={selectedId === node.id ? 'active' : ''} aria-label={`Focus stage: ${node.title}`} title={node.title} onClick={() => { onSelect(node.id); setFocusRequest(node.id); }}><span>{/^\s*\d+[.·:—–)\s]/u.test(node.title) ? node.title : `${index + 1} · ${node.title}`}</span></button>)}</nav>}
    </div>
    {dockItems.length > 0 && <CanvasDock label="Canvas tools" items={dockItems}/>}
    {addMenu && <AddBlockMenu left={addMenu.left} top={addMenu.top} onPick={kind => { setAddMenu(null); onAdd(addMenu.at ? null : selectedGroup?.id ?? null, kind.id, addMenu.at); }} onBrowse={kind => { setAddMenu(null); onBrowse(addMenu.at ? null : selectedGroup?.id ?? null, kind?.id, addMenu.at); }} onClose={() => setAddMenu(null)}/>}
    {sizeMenu && sizeTargets.length > 0 && <SizeMenu left={sizeMenu.left} top={sizeMenu.top} current={sizeNow} count={sizeTargets.length} onPick={resizeBlocks} onClose={closeSizeMenu}/>}
    {labelMenu && (() => { const target = displayed.canvas.nodes.find(node => node.id === labelMenu.nodeId); return target ? <LabelMenu key={target.id} node={target} left={labelMenu.left} top={labelMenu.top} onClose={closeLabelMenu} onPick={value => { closeLabelMenu(); void mutate([{ type: 'updateNode', id: target.id, patch: labelPatch(target, value) }], value ? `Label as ${value.trim().slice(0, 40)}` : 'Remove label'); }}/> : null; })()}
    {dropTarget && <div className="drop-target-outline" style={{ left: dropTarget.left, top: dropTarget.top, width: dropTarget.width, height: dropTarget.height }}/>}
    {!nodes.length && <div className="canvas-empty"><h2>Give a question room.</h2><p>Add what you know, or a task to explore what you don’t.</p><button type="button" className="canvas-empty-add" data-testid="add-node" aria-haspopup="dialog" aria-expanded={Boolean(addMenu)} disabled={readonly || busy} onClick={event => openAddMenu(event.currentTarget)}><Plus size={16}/>Add a block</button></div>}
    {selecting&&<div className="canvas-group-toolbar nodrag nopan"><span>{groupSelection.length} selected · click blocks</span><input aria-label="New group title" value={groupName} maxLength={200} onChange={event=>setGroupName(event.target.value)}/><button className="primary small" disabled={!groupSelection.length||!groupName.trim()} onClick={()=>groupBlocks(groupSelection,groupName.trim())}>Group selected</button></div>}
    {pendingConnection && <div className="connection-instruction" role="status"><GitBranch size={16}/><span>Click the block to link to</span><button className="icon-button" aria-label="Cancel connection" onClick={() => setPendingConnection(null)}><X size={15}/></button></div>}
    <div className="canvas-notices">{notices}{proposalCard && !proposalAnchors.length && proposalCard}{message && <div className="canvas-notice canvas-feedback" role="status">{message}</div>}{toast && <div key={toast.key} className="canvas-toast" role="status"><Check size={14} aria-hidden="true"/><span>{toast.text}</span>{toast.undo && onUndo && <button type="button" onClick={() => { setToast(null); onUndo(); }}>Undo</button>}</div>}</div>
    <div className="canvas-tools"><button className="icon-button" aria-label="Zoom out" onClick={() => void flow.zoomOut({ duration: 180 })}><Minus size={17}/></button><button className="icon-button" aria-label="Fit canvas" title="Fit at readable zoom; See all shows everything" onClick={() => void fitCanvas()}><Focus size={18}/></button><button className="icon-button" aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration: 180 })}><Plus size={17}/></button></div>
  </div>;
}
export function ResearchCanvas(props: Props) { return <ReactFlowProvider key={props.detail.project.id}><FlowCanvas {...props}/></ReactFlowProvider>; }
