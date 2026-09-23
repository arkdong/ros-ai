import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ConnectionMode, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, type Node, type NodeProps, type Viewport } from '@xyflow/react';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Focus, GitBranch, LayoutGrid, LoaderCircle, Minus, PanelTopClose, Pencil, Pin, Play, Plus, Settings2, X } from 'lucide-react';
import { ArtifactContent } from './Experiment';
import { RelationshipEdge, type RoutedEdge } from './RelationshipEdge';
import { api } from './api';
import type { ExperimentCapabilities } from '../shared/experiments';
import { deriveGroupOutcomes, type CardOutcome, type CardOutcomeOptions } from '../shared/card-outcome';
import { resolveModelSetting, type ModelSettingsResponse } from '../shared/model-settings';
import { CARD_MAX_HEIGHT, CARD_MIN_HEIGHT, CARD_MIN_WIDTH, CARD_MAX_WIDTH, cardWidth, initialCardSize } from '../shared/card-size';
import { savedCanvasPosition } from '../shared/canvas-position';
import { createCanvasReflowPlan, reflowCanvas, type CanvasReflowPlan } from '../shared/canvas-reflow';
import { resultPage, changeResultPageSize, type ResultPageChoice } from '../shared/result-pages';
import { aggregateTopLevelRelationships } from '../shared/aggregate-relationships';
import { routeRelationship, type RelationshipRoute, type RouteNode } from '../shared/routing';
import { relationshipLabelSize } from '../shared/relationship-label';
import { placeRelationshipLabels } from '../shared/relationship-label-layout';
import { readSaved, saveLocal } from './persistence';
import { arrangeCanvas, numberedStageOrder, CARD_SIZE, GROUP_FOOTER, GROUP_INSET, LAYOUT_GAP, type CanvasSize } from '../shared/layout';
import type { Artifact, Canvas, Mutation, ProjectDetail, Proposal, RunStatus } from '../shared/types';
import './canvas-interactions.css';
import './canvas-reading.css';
import './canvas-evidence.css';

export function kindLabel(kind?: string) { return kind === 'topic' ? 'Knowledge' : kind === 'activity' ? 'Action' : 'Unspecified'; }
export function KindIcon({ kind, size = 14 }: { kind?: string; size?: number }) { return kind === 'activity' ? <Play size={size}/> : <BookOpen size={size}/>; }
type Side = 'top' | 'right' | 'bottom' | 'left';
const sides: { id: Side; position: Position }[] = [{ id: 'top', position: Position.Top }, { id: 'right', position: Position.Right }, { id: 'bottom', position: Position.Bottom }, { id: 'left', position: Position.Left }];
const ARTIFACT_SIZE = { width: 360, height: 300 };
type CardData = {
  kind?: string; title: string; description: string; status?: RunStatus; awaitingApproval?: boolean;
  inputCount: number; resultCount: number; expanded: boolean; preview?: 'added' | 'changed' | 'removed';
  onExpand: () => void; onInspect: () => void; onActivate: () => void; onAdd: () => void; onHandle: (side: Side) => void;
  onSave: (title: string, description: string) => Promise<unknown>; readonly: boolean;
  outcome: CardOutcome; width: number; resizePending: boolean;
  modelLabel?: string; modelTitle?: string;
  results?: ResultPageChoice & { pageCount: number; total: number; start: number };
  onResultChoice: (choice: ResultPageChoice) => void;
  onWidth: (width: number | null, commit?: boolean) => void; onMeasure: (width: number, height: number) => void;
};
type ResearchNode = Node<CardData, 'research'>;
function ResearchCard({ data, selected }: NodeProps<ResearchNode>) {
  const flow = useReactFlow();
  const heading = useRef<HTMLDivElement>(null), resizing = useRef<{ x: number; width: number; zoom: number } | null>(null);
  const measure = useRef(data.onMeasure); measure.current = data.onMeasure;
  useEffect(() => {
    if (data.expanded || !heading.current) return;
    const element = heading.current;
    const update = () => measure.current(data.width, Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, element.offsetHeight + 2)));
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [data.expanded, data.width]);
  const resizedWidth = (x: number) => Math.max(CARD_MIN_WIDTH, Math.min(CARD_MAX_WIDTH, Math.round(resizing.current!.width + (x - resizing.current!.x) / resizing.current!.zoom)));
  const active = data.status === 'running' || data.status === 'queued';
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(data.title), [description, setDescription] = useState(data.description), [saving, setSaving] = useState(false);
  useEffect(() => { if (!editing) { setTitle(data.title); setDescription(data.description); } }, [data.title, data.description, editing]);
  useEffect(() => { if (!data.expanded || data.readonly) setEditing(false); }, [data.expanded, data.readonly]);
  const edit = () => { if (!data.readonly && data.expanded) { data.onActivate(); setTitle(data.title); setDescription(data.description); setEditing(true); } };
  const save = async () => {
    if (!title.trim() || saving) return;
    if (title.trim() === data.title && description === data.description) { setEditing(false); return; }
    setSaving(true);
    try { if (await data.onSave(title.trim(), description) !== false) setEditing(false); } finally { setSaving(false); }
  };
  return <article className={`research-card ${data.expanded ? 'expanded-group' : ''} ${selected ? 'selected' : ''} ${editing ? 'editing' : ''} ${data.preview ? `preview-${data.preview}` : ''}`}>
    {sides.map(side => <Handle key={side.id} id={side.id} type="source" position={side.position} isConnectable={!data.readonly} className="relationship-handle" role="button" tabIndex={data.readonly ? -1 : 0} aria-label={`Connect ${data.title} from ${side.id}`} title="Drag to a note, or click then choose a note" onClick={event => { event.stopPropagation(); data.onHandle(side.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); data.onHandle(side.id); } }}/>) }
    <div ref={heading} className={`group-heading ${editing ? 'nodrag' : ''}`}>
      <div className="card-top"><span className="card-type"><KindIcon kind={data.kind}/> {kindLabel(data.kind)}{data.expanded && ['progress', 'warning', 'danger'].includes(data.outcome.tone) && <span className={`expanded-work-state outcome-${data.outcome.tone}`}> · {data.outcome.label}</span>}</span><span className="card-controls nodrag">
        {data.expanded && !data.readonly && !editing && <button className="icon-button" aria-label={`Edit ${data.title} inline`} title="Edit title and description" onClick={event => { event.stopPropagation(); edit(); }}><Pencil size={15}/></button>}
        <button className="icon-button" aria-label={`Open ${data.title}`} title="Open details" onClick={event => { event.stopPropagation(); data.onInspect(); }}><Settings2 size={15}/></button>
        <button className="icon-button" aria-label={`${data.expanded ? 'Collapse' : 'Expand'} ${data.title}`} title={data.expanded ? 'Collapse group' : 'Expand group'} disabled={saving} onClick={event => { event.stopPropagation(); data.onExpand(); }}>{data.expanded ? <ChevronUp size={17}/> : <ChevronDown size={17}/>}</button>
      </span></div>
      {data.modelLabel && <span className="node-model-indicator" title={data.modelTitle} aria-label={data.modelTitle}><span aria-hidden="true">◉</span>{data.modelLabel}</span>}
      {editing ? <form className="inline-note-editor nodrag nopan nowheel" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setEditing(false); } if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save(); } }}>
        <input autoFocus aria-label="Note title" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} disabled={saving}/>
        <textarea aria-label="Note description" value={description} maxLength={20000} rows={2} onChange={event => setDescription(event.target.value)} disabled={saving}/>
        <div className="inline-note-actions"><span>Save as one undoable edit</span><button type="button" className="secondary small" disabled={saving} onClick={() => setEditing(false)}>Cancel</button><button type="submit" className="primary small" disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>}Save</button></div>
      </form> : <>
        {data.expanded && !data.readonly ? <><button className="card-copy-button nodrag" aria-label={`Edit title for ${data.title}`} onClick={event => { event.stopPropagation(); edit(); }}><span className="card-title" title={data.title}>{data.title || 'Untitled'}</span></button><button className="card-copy-button description-copy nodrag" aria-label={`Edit description for ${data.title}`} onClick={event => { event.stopPropagation(); edit(); }}><span className="card-description" title={data.description}>{data.description || 'Add a question, observation or idea…'}</span></button></> : <><div className="card-title" title={data.title}>{data.title || 'Untitled'}</div>{data.expanded ? <p className="card-description" title={data.description}>{data.description || 'A place for questions, evidence and experiments.'}</p> : <div className={`card-outcome outcome-${data.outcome.tone}`}><span className="outcome-label">{data.preview ? `Preview · ${data.preview}` : data.outcome.label}</span><p className="nowheel">{data.outcome.text}</p></div>}</>}
        {data.expanded ? <div className="card-bottom expanded-result-bar nodrag nopan">{data.results?.total ? <>
          <div className="result-density" role="group" aria-label={`Results shown for ${data.title}`}><span>Show</span>{([2, 4, 'all'] as const).map(size => <button key={size} aria-label={`Show ${size === 'all' ? 'all' : size} results for ${data.title}`} aria-pressed={data.results!.size === size} onClick={event => { event.stopPropagation(); data.onResultChoice(changeResultPageSize(data.results!.total, data.results!, size)); }}>{size === 'all' ? 'All' : size}</button>)}</div>
          <span className="result-range">{data.results.size === 'all' ? `${data.results.total} results` : `${data.results.start + 1}–${Math.min(data.results.start + data.results.size, data.results.total)} of ${data.results.total}`}</span>
          {data.results.size !== 'all' && <nav className="result-pagination" aria-label={`Result pages for ${data.title}`}><button className="icon-button" aria-label={`Previous results for ${data.title}`} disabled={data.results.page === 0} onClick={event => { event.stopPropagation(); data.onResultChoice({ ...data.results!, page: data.results!.page - 1 }); }}><ChevronLeft size={15}/></button><span className="result-page-dots">{Array.from({ length: data.results.pageCount }, (_, page) => <button key={page} className={page === data.results!.page ? 'current' : ''} aria-label={`Result page ${page + 1} of ${data.results!.pageCount} for ${data.title}`} aria-current={page === data.results!.page ? 'page' : undefined} onClick={event => { event.stopPropagation(); data.onResultChoice({ ...data.results!, page }); }}/>)}</span><button className="icon-button" aria-label={`Next results for ${data.title}`} disabled={data.results.page === data.results.pageCount - 1} onClick={event => { event.stopPropagation(); data.onResultChoice({ ...data.results!, page: data.results!.page + 1 }); }}><ChevronRight size={15}/></button></nav>}
        </> : <span className={`node-status ${data.status || ''}`}>{active ? <LoaderCircle size={12} className="spin"/> : <span className="status-dot"/>}{data.preview ? `Preview · ${data.preview}` : data.awaitingApproval ? 'Awaiting approval' : data.status || 'No saved results yet'}</span>}</div> : <div className="outcome-footer"><button className="text-button small nodrag" onClick={event => { event.stopPropagation(); data.onInspect(); }}>{data.outcome.artifactIds.length ? 'Inspect evidence' : 'Open details'}<ArrowUpRight size={13}/></button></div>}
      </>}
    </div>
    {!data.expanded && !data.readonly && <button className="card-width-handle nodrag nopan" disabled={data.resizePending} role="slider" aria-label={`Card width for ${data.title}`} aria-valuemin={CARD_MIN_WIDTH} aria-valuemax={CARD_MAX_WIDTH} aria-valuenow={data.width} aria-valuetext={`${data.width} pixels`} title="Drag to resize width · arrow keys adjust" onClick={event => event.stopPropagation()}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); resizing.current = { x: event.clientX, width: data.width, zoom: flow.getZoom() }; data.onActivate(); }}
      onPointerMove={event => { if (resizing.current) data.onWidth(resizedWidth(event.clientX)); }}
      onPointerUp={event => { if (!resizing.current) return; const width = resizedWidth(event.clientX); resizing.current = null; event.currentTarget.releasePointerCapture(event.pointerId); data.onWidth(width, true); }}
      onPointerCancel={() => { resizing.current = null; data.onWidth(null); }}
      onKeyDown={event => { const width = event.key === 'Home' ? CARD_MIN_WIDTH : event.key === 'End' ? CARD_MAX_WIDTH : event.key === 'ArrowLeft' ? data.width - 24 : event.key === 'ArrowRight' ? data.width + 24 : null; if (width !== null) { event.preventDefault(); event.stopPropagation(); data.onWidth(Math.max(CARD_MIN_WIDTH, Math.min(CARD_MAX_WIDTH, width)), true); } }}/>} 
    {data.expanded && <div className="group-actions nodrag"><span>Drop a result here to reuse it</span><button className="small secondary" disabled={data.readonly} onClick={event => { event.stopPropagation(); data.onAdd(); }}><Plus size={14}/> Add inside</button></div>}
  </article>;
}
type ArtifactData = { artifact: Artifact; destinationId: string; highlighted: boolean; reused: boolean; originLabel?: string; producer?: string; onOpen: () => void; onPin: () => void; onReuse: () => void; readonly: boolean };
type ArtifactNode = Node<ArtifactData, 'artifact'>;
function ArtifactCard({ data }: NodeProps<ArtifactNode>) {
  const { artifact } = data;
  return <article className={`canvas-artifact ${data.highlighted ? 'highlighted' : ''}`}><div className="card-top"><span className="card-type">{data.highlighted ? <Pin size={13}/> : null}{data.reused ? 'Selected input' : artifact.kind}</span><div className="row nodrag"><button className="icon-button" aria-label={`${data.highlighted ? 'Unpin' : 'Pin'} ${artifact.title}`} disabled={data.readonly} title={data.highlighted ? 'Unpin highlight' : 'Pin as highlight'} onClick={data.onPin}><Pin size={15} fill={data.highlighted ? 'currentColor' : 'none'}/></button><button className="icon-button" aria-label={`Inspect ${artifact.title}`} title="Inspect result" onClick={data.onOpen}><ArrowUpRight size={15}/></button></div></div><h3>{artifact.title}</h3>{data.originLabel&&<span className="artifact-origin">{data.originLabel}</span>}<div className="artifact-preview nodrag nowheel" onDoubleClick={data.onOpen}><ArtifactContent artifact={artifact}/></div><div className="artifact-footer"><span title={`Immutable version ${artifact.hash}`}>{data.reused ? 'Exact selected version' : 'Saved result'} · {artifact.hash.slice(0, 8)}{data.producer&&<small className="artifact-producer"> · Produced by {data.producer}</small>}</span><button className="text-button small nodrag" disabled={data.readonly} onClick={data.onReuse}>Reuse <ArrowUpRight size={13}/></button></div></article>;
}
const nodeTypes = { research: ResearchCard, artifact: ArtifactCard };
const edgeTypes = { relationship: RelationshipEdge };
export function emptyPosition(canvas: Canvas): { x: number; y: number } {
  for (let row = 0; row < 100; row++) for (let column = 0; column < 5; column++) {
    const x = column * (CARD_SIZE.width + LAYOUT_GAP), y = row * (CARD_MAX_HEIGHT + LAYOUT_GAP);
    if (canvas.nodes.every(node => x >= node.x + cardWidth(node) + 24 || x + CARD_SIZE.width + 24 <= node.x || y >= node.y + CARD_MAX_HEIGHT + 24 || y + CARD_MAX_HEIGHT + 24 <= node.y)) return { x, y };
  }
  return { x: 0, y: Math.max(0, ...canvas.nodes.map(n => n.y)) + CARD_MAX_HEIGHT + LAYOUT_GAP };
}
function previewCanvas(canvas: Canvas, proposal?: Proposal) {
  const result = structuredClone(canvas); const marks = new Map<string, CardData['preview']>();
  for (const op of proposal?.operations || []) {
    if (op.type === 'addNode') { result.nodes.push(op.node); marks.set(op.node.id, 'added'); }
    if (op.type === 'updateNode') { const n = result.nodes.find(n => n.id === op.id); if (n) Object.assign(n, op.patch); marks.set(op.id, 'changed'); }
    if (op.type === 'removeNode') marks.set(op.id, 'removed');
    if (op.type === 'addConnection') result.connections.push(op.connection);
    if (op.type === 'removeConnection') result.connections = result.connections.filter(c => c.id !== op.id);
  }
  return { canvas: result, marks };
}
export type CanvasHighlight = { id: string; nodeId: string; artifactId: string; x: number; y: number };
type Props = { detail: ProjectDetail; selectedId: string | null; onSelect: (id: string | null) => void; onInspect: (id: string) => void; onArtifact: (artifact: Artifact, nodeId: string) => void; onReuse: (artifact: Artifact, nodeId?: string) => void; onPin: (artifact: Artifact, nodeId: string) => void; onMoveHighlight: (id: string, nodeId: string, position: { x: number; y: number }) => void; highlights: CanvasHighlight[]; mutate: (operations: Mutation[], label: string) => Promise<unknown>; onAdd: (parentId: string | null) => void; proposal?: Proposal; historyCanvas?: Canvas; expandedIds: string[]; onExpandedChange: (ids: string[]) => void; focusId?: string | null };
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
function FlowCanvas({ detail, selectedId, onSelect, onInspect, onArtifact, onReuse, onPin, onMoveHighlight, highlights, mutate, onAdd, proposal, historyCanvas, expandedIds, onExpandedChange, focusId }: Props) {
  const flow = useReactFlow(); const dragging = useRef(false); const area = useRef<HTMLDivElement>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null), [focusRequest, setFocusRequest] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ nodeId: string; side: Side } | null>(null), [arranging, setArranging] = useState(false), [message, setMessage] = useState('');
  const [animatingLayout, setAnimatingLayout] = useState(false), [artifactPlacementRevision, setArtifactPlacementRevision] = useState(0);
  const [reflowRevision, setReflowRevision] = useState(0);
  const [modelSettings, setModelSettings] = useState<ModelSettingsResponse|null>(null);
  useEffect(() => {
    let active=true;
    const load=()=>{void api<ModelSettingsResponse>(`/api/projects/${detail.project.id}/models`).then(value=>{if(active)setModelSettings(value);}).catch(()=>{if(active)setModelSettings(null);});};
    load();window.addEventListener('ros-ai-model-settings',load);
    return()=>{active=false;window.removeEventListener('ros-ai-model-settings',load);};
  },[detail.project.id,detail.project.revision]);
  const reflowState = useRef<{ plan: CanvasReflowPlan; positions: string; dimensions: string; structure: string; shape: string; ready: boolean } | null>(null);
  const reflowWriting = useRef(false);
  const [cardMeasurements, setCardMeasurements] = useState<Record<string, CanvasSize>>({}), [draftWidths, setDraftWidths] = useState<Record<string, number>>({});
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
  const routeHistory = useRef(new Map<string, RelationshipRoute>());
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
      for (const element of area.current!.parentElement?.querySelectorAll('.canvas-tools, .canvas-hint, .selection-toolbar, .project-floating-actions, .edge-selection') || []) {
        const overlay = element.getBoundingClientRect();
        if (overlay.height && overlay.top > bounds.top + bounds.height / 2) bottom = Math.max(bottom, bounds.bottom - overlay.top + 22);
      }
      // Desktop panels shrink the canvas. On narrow windows they overlay it;
      // only their actual intersection is reserved, never their width twice.
      const panel = area.current!.closest('.workspace-body')?.querySelector('.assistant-panel');
      if (panel) {
        const overlay = panel.getBoundingClientRect();
        if (overlay.left < bounds.right && overlay.right > bounds.left && overlay.bottom > bounds.top) right = Math.max(right, bounds.right - Math.max(bounds.left, overlay.left) + 22);
      }
      left = Math.min(left, bounds.width / 8);
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
        setMessage('Reading view · use the stage buttons to follow the question, or Overview to see the whole canvas.');
        return focusReadable(anchor.id, duration);
      }
    }
    return flow.setViewport({ x: inset.left + (width - content.width * zoom) / 2 - content.x * zoom, y: inset.top + (height - content.height * zoom) / 2 - content.y * zoom, zoom }, { duration });
  };
  const readonly = Boolean(historyCanvas || proposal);
  const displayed = useMemo(() => previewCanvas(historyCanvas || detail.project.canvas, historyCanvas ? undefined : proposal), [historyCanvas, detail.project.canvas, proposal]);
  const aggregatedRelationships = useMemo(() => aggregateTopLevelRelationships(displayed.canvas), [displayed.canvas]);
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
  const cardSizes = useMemo(() => Object.fromEntries(displayed.canvas.nodes.map(node => {
    const initial = initialCardSize({ ...node, width: draftWidths[node.id] ?? node.width }, cardOutcomes[node.id].text);
    return [node.id, cardMeasurements[node.id]?.width === initial.width ? cardMeasurements[node.id] : initial];
  })), [displayed.canvas.nodes, cardOutcomes, cardMeasurements, draftWidths]);
  const resizeCard = (id: string, width: number | null, commit = false) => {
    if (resizeCommits.current.has(id)) return;
    const clear = () => setDraftWidths(current => { const next = { ...current }; delete next[id]; return next; });
    if (width === null) { clear(); return; }
    setDraftWidths(current => ({ ...current, [id]: width }));
    if (commit) {
      if (cardWidth(displayed.canvas.nodes.find(node => node.id === id)!) === width) { clear(); return; }
      resizeCommits.current.add(id); setResizingCards([...resizeCommits.current]);
      void mutate([{ type: 'updateNode', id, patch: { width } }], 'Resize card width').finally(() => { clear(); resizeCommits.current.delete(id); setResizingCards([...resizeCommits.current]); });
    }
  };
  const toggle = (id: string) => { const open = expandedIds.includes(id); onExpandedChange(open ? expandedIds.filter(n => n !== id) : [...expandedIds, id]); onSelect(id); };
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
  useEffect(() => { if (readonly) setPendingConnection(null); }, [readonly]);
  const resultPages = useMemo(() => Object.fromEntries(displayed.canvas.nodes.map(node => {
    const parentId = node.id;
        const runs = detail.runs.filter(r => r.nodeId === parentId && r.status === 'completed');
        const local = runs.filter(r => r.configuration.kind === 'local-experiment').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const model = runs.filter(r => r.configuration.kind !== 'local-experiment' && r.configuration.purpose !== 'experiment-plan').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const pinned = highlights.filter(h => h.nodeId === parentId || descendantIds[parentId]?.has(h.nodeId)); const selected = detail.inputs.filter(i => i.nodeId === parentId);
        const artifacts = detail.artifacts.filter(a => pinned.some(h => h.artifactId === a.id) || selected.some(i => i.artifactId === a.id) || ((a.runId === local?.id || a.runId === model?.id) && a.kind !== 'log' && a.kind !== 'source')).sort((a, b) => Number(pinned.some(h => h.artifactId === b.id)) - Number(pinned.some(h => h.artifactId === a.id)));
    return [parentId, resultPage(artifacts, resultChoices[parentId])];
  })), [displayed.canvas.nodes, detail.runs, detail.inputs, detail.artifacts, highlights, resultChoices, descendantIds]);
  const computedNodes = useMemo<(ResearchNode | ArtifactNode)[]>(() => {
    const build = (parentId: string | null, depth = 0): { nodes: (ResearchNode | ArtifactNode)[]; width: number; height: number } => {
      const siblings = displayed.canvas.nodes.filter(n => (n.parentId || null) === parentId).sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
      const built: (ResearchNode | ArtifactNode)[] = []; let right = 0, bottom = 0;
      for (const node of siblings) {
        const expanded = expandedIds.includes(node.id); const child = expanded ? build(node.id, depth + 1) : { nodes: [], width: 0, height: 0 };
        const width = expanded ? Math.ceil(Math.max(768, child.width + GROUP_INSET.x * 2) / 24) * 24 : cardSizes[node.id].width;
        const height = expanded ? Math.ceil(Math.max(408, child.height + GROUP_INSET.y + GROUP_FOOTER) / 24) * 24 : cardSizes[node.id].height;
        const box: Box = { x: parentId ? Math.max(0, node.x) : node.x, y: parentId ? Math.max(0, node.y) : node.y, width, height };
        right = Math.max(right, box.x + width); bottom = Math.max(bottom, box.y + height);
        const runs = detail.runs.filter(r => r.nodeId === node.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); const status = runs.find(r => ['queued', 'running'].includes(r.status))?.status || runs[0]?.status;
        const effective=modelSettings?resolveModelSetting(modelSettings,displayed.canvas.nodes,node.id):null;
        const selectedProvider=modelSettings?.providers.find(item=>item.id===effective?.selection.provider);
        const selectedModel=selectedProvider?.models.find(item=>item.id===effective?.selection.model);
        const modelTitle=effective?`Selected model: ${selectedProvider?.label??effective.selection.provider} · ${selectedModel?.label??effective.selection.model}${effective.inheritedFrom===node.id?' · task override':effective.inheritedFrom?' · inherited from '+displayed.canvas.nodes.find(item=>item.id===effective.inheritedFrom)?.title:' · project default'}. Saved results retain their original producing model.`:undefined;
        built.push({ id: node.id, type: 'research', parentId: parentId || undefined, position: { x: box.x + (parentId ? GROUP_INSET.x : 0), y: box.y + (parentId ? GROUP_INSET.y : 0) }, width, height, style: { width, height }, selected: node.id === selectedId, zIndex: depth, dragHandle: '.group-heading', data: { modelLabel:selectedModel?.label??effective?.selection.model, modelTitle, results: resultPages[node.id], onResultChoice: choice => changeResults(node.id, choice), resizePending: resizingCards.includes(node.id), outcome: cardOutcomes[node.id], width: cardSizes[node.id].width, onWidth: (width, commit) => resizeCard(node.id, width, commit), onMeasure: (width, height) => measureCard(node.id, width, height), kind: node.kind, title: node.title, description: node.description, status, awaitingApproval: runs.some(r => (r.configuration.approval as { status?: string } | undefined)?.status === 'pending'), inputCount: detail.inputs.filter(i => i.nodeId === node.id).length, resultCount: detail.artifacts.filter(a => a.nodeId === node.id && ['result', 'metric', 'table', 'plot'].includes(a.kind)).length, expanded, preview: displayed.marks.get(node.id), onExpand: () => toggle(node.id), onInspect: () => onInspect(node.id), onActivate: () => onSelect(node.id), onAdd: () => onAdd(node.id), onHandle: side => handleClick(node.id, side), onSave: (title, description) => mutate([{ type: 'updateNode', id: node.id, patch: { title, description } }], 'Edit note'), readonly } }, ...child.nodes);
      }
      if (parentId) {
        const pinned = highlights.filter(h => h.nodeId === parentId || descendantIds[parentId]?.has(h.nodeId)); const selected = detail.inputs.filter(i => i.nodeId === parentId);
        const page = resultPages[parentId];
        const artifacts = page.items;
        const packed = packArtifactCards(artifacts, parentId, pinned, page.size !== 'all');
        const startY = Math.max(bottom ? bottom + LAYOUT_GAP : 0, packed.minY);
        packed.items.forEach(({ artifact, box }) => {
          const position = { x: box.x + GROUP_INSET.x, y: box.y + startY + GROUP_INSET.y }; const used = selected.some(i => i.artifactId === artifact.id);
          const owner=displayed.canvas.nodes.find(item=>item.id===artifact.nodeId);
          const producerRun=detail.runs.find(run=>run.id===artifact.runId);
          const original=artifact.metadata?.originalExecution as {provider?:string;model?:string}|undefined;
          const producer=original?.model?`${original.provider??'recorded'} · ${original.model}`:original?'recorded execution (see provenance)':producerRun?`${producerRun.provider} · ${producerRun.model}`:undefined;
          built.push({ id: `artifact:${parentId}:${artifact.id}`, parentId, type: 'artifact', position, ...ARTIFACT_SIZE, style: { ...ARTIFACT_SIZE }, zIndex: depth + 1, connectable: false, data: { artifact, destinationId: parentId, producer, originLabel:artifact.nodeId!==parentId?`From ${owner?.title??'a saved note'}${used?' · selected input':' · highlighted finding'}`:undefined, highlighted: pinned.some(h => h.artifactId === artifact.id), reused: used && artifact.nodeId !== parentId, onOpen: () => onArtifact(artifact, parentId), onPin: () => onPin(artifact, parentId), onReuse: () => onReuse(artifact), readonly } });
          right = Math.max(right, box.x + ARTIFACT_SIZE.width); bottom = Math.max(bottom, startY + box.y + ARTIFACT_SIZE.height);
        });
      }
      return { nodes: built, width: right, height: bottom };
    };
    return build(null).nodes;
  }, [displayed, expandedIds, detail.runs, detail.inputs, detail.artifacts, selectedId, highlights, readonly, pendingConnection, artifactPlacementRevision, cardSizes, cardOutcomes, resizingCards, resultPages, modelSettings, descendantIds]);
  const [nodes, setNodes] = useState(computedNodes);
  const liveNodes = useRef(nodes); liveNodes.current = nodes;
  const extraContent = useMemo(() => Object.fromEntries(expandedIds.flatMap(parentId => {
    const page = resultPages[parentId]; if (!page?.items.length) return [];
    const packed = packArtifactCards(page.items, parentId, highlights.filter(highlight => highlight.nodeId === parentId), page.size !== 'all');
    return [[parentId, { width: packed.width, height: packed.height, minY: packed.minY }]];
  })), [expandedIds, resultPages, highlights, artifactPlacementRevision]);
  useEffect(() => {
    if (readonly) { reflowState.current = null; return; }
    // Pointer drags/width previews are live UI only. Settle once their saved state
    // arrives, rather than issuing a write for every ResizeObserver notification.
    if (dragging.current || reflowWriting.current || arranging || animatingLayout || Object.keys(draftWidths).length || resizingCards.length) return;
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
      state = { plan: createCanvasReflowPlan(source, actualSizes), positions, dimensions, structure, shape, ready: false };
      reflowState.current = state;
    }
    const shapeChanged = state.shape !== shape, sizeChanged = state.dimensions !== dimensions;
    if (state.positions !== positions) {
      // A manual move, undo/content edit or explicit Arrange establishes a new
      // spatial plan. Our own settled batch already recorded its expected key.
      state.plan = createCanvasReflowPlan(source, actualSizes); state.positions = positions;
    }
    if (state.structure !== structure) { state.plan = createCanvasReflowPlan(source, actualSizes); state.structure = structure; }
    if (!state.ready && !shapeChanged) {
      // Initial font/card measurements establish the baseline. Reopening a
      // project never becomes an implicit Arrange or a layout persistence loop.
      state.plan = createCanvasReflowPlan(source, actualSizes); state.dimensions = dimensions;
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
      if (!operations.length) return;
      reflowWriting.current = true;
      animateNextLayout.current = new Map(result.canvas.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
      const failed = () => {
        animateNextLayout.current = null; state.positions = positions; state.dimensions = dimensions;
        setMessage('Automatic spacing could not be saved. Arrange can retry.');
      };
      void mutate(operations, 'Adjust canvas spacing').then(saved => {
        if (saved === false) failed();
      }).catch(failed).finally(() => { reflowWriting.current = false; setReflowRevision(revision => revision + 1); });
    }, 160);
    return () => clearTimeout(timer);
  }, [computedNodes, displayed, expandedIds, extraContent, cardSizes, readonly, arranging, animatingLayout, draftWidths, resizingCards, reflowRevision]);
  useEffect(() => {
    if (dragging.current) return;
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    const expected = animateNextLayout.current;
    const hasArrived = expected && expected.size === displayed.canvas.nodes.length && displayed.canvas.nodes.every(node => expected.get(node.id)?.x === node.x && expected.get(node.id)?.y === node.y);
    const shouldAnimate = hasArrived && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!shouldAnimate) {
      if (hasArrived) animateNextLayout.current = null;
      const measurements = new Map(liveNodes.current.map(node => [node.id, node.measured]));
      setAnimatingLayout(false); setNodes(computedNodes.map(node => ({ ...node, measured: measurements.get(node.id) }))); return;
    }
    const before = new Map(liveNodes.current.map(node => [node.id, node]));
    const started = performance.now(), duration = 420;
    setAnimatingLayout(true);
    const frame = (time: number) => {
      const progress = Math.min(1, (time - started) / duration), eased = 1 - (1 - progress) ** 3;
      // React Flow invalidates handle bounds if a controlled update drops measured.
      // Keep its latest measurements while ResizeObserver follows changing group sizes.
      const measurements = new Map(liveNodes.current.map(node => [node.id, node.measured]));
      setNodes(computedNodes.map(node => {
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
  }, [computedNodes]);
  useEffect(() => {
    if (!focusRequest) return;
    const timer = setTimeout(() => {
      void focusReadable(focusRequest);
      setFocusRequest(null);
    }, 90);
    return () => clearTimeout(timer);
  }, [focusRequest, computedNodes]);
  useEffect(() => { if (focusId) setFocusRequest(focusId); }, [focusId]);
  const edges = useMemo<RoutedEdge[]>(() => {
    // Every root pair gets exactly one visible summary, whether groups are
    // folded or expanded. Descendant links remain stored and inspectable.
    const geometry: RouteNode[] = nodes.filter(node => !node.parentId && node.type === 'research').map(node => ({ id: node.id, ...node.position, width: node.width || CARD_SIZE.width, height: node.height || CARD_SIZE.height }));
    const items = aggregatedRelationships.flatMap(group => {
      const route = routeRelationship({ source: group.source, target: group.target, nodes: geometry, previous: routeHistory.current.get(group.id), labelSize: relationshipLabelSize(group.label) });
      if (!route) return [];
      routeHistory.current.set(group.id, route);
      return [{ group, route: { ...route, visibleSource: group.source, visibleTarget: group.target, renderSource: group.source, renderTarget: group.target, boundaries: [] } }];
    });
    // Reuse the existing text packing with no child boundaries or inner legs.
    placeRelationshipLabels(items.map(({ group, route }) => ({ id: group.id, route, label: group.label })), geometry);
    return items.map(({ group, route }) => {
      const selected = group.id === selectedEdge, color = selected ? '#536f69' : '#99a5a2';
      const marker = { type: MarkerType.ArrowClosed, width: 17, height: 17, color };
      return { id: group.id, type: 'relationship' as const, source: group.source, target: group.target, sourceHandle: route.sourceHandle, targetHandle: route.targetHandle, selected, zIndex: 1000, style: { stroke: color, strokeWidth: selected ? 2 : 1.5 }, interactionWidth: 24, markerEnd: marker, ...(group.bidirectional ? { markerStart: marker } : {}), data: { route, label: group.label, onSelect: () => { setSelectedEdge(group.id); setPendingConnection(null); } } };
    });
  }, [aggregatedRelationships, nodes, selectedEdge]);
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
        if (await mutate(operations, 'Arrange canvas') !== false) setMessage('Canvas arranged. Research content is unchanged.');
        else animateNextLayout.current = null;
      }
    } finally { setArranging(false); }
  };
  return <div ref={area} className={`canvas-area unified-canvas direct-canvas ${pendingConnection ? 'is-connecting' : ''} ${arranging || animatingLayout ? 'is-arranging' : ''}`} data-testid="canvas">
    <ReactFlow<ResearchNode | ArtifactNode, RoutedEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current))}
      onNodeClick={(event, node) => { if ((event.target as HTMLElement).closest('.relationship-handle')) return; if (node.type === 'research') { if (pendingConnection && pendingConnection.nodeId !== node.id) connect(pendingConnection.nodeId, node.id, pendingConnection.side); else onSelect(node.id); } setSelectedEdge(null); }}
      onNodeDoubleClick={(event, node) => { if ((event.target as HTMLElement).closest('input,textarea,button,.inline-note-editor')) return; if (node.type === 'research') { if (!expandedIds.includes(node.id)) toggle(node.id); else setFocusRequest(node.id); } else onArtifact(node.data.artifact, node.data.destinationId); }}
      onPaneClick={() => { onSelect(null); setSelectedEdge(null); setPendingConnection(null); }} onEdgeClick={(_, edge) => { setSelectedEdge(edge.id); setPendingConnection(null); }} onEdgeDoubleClick={(_, edge) => { setSelectedEdge(edge.id); setPendingConnection(null); }}
      onNodeDragStart={() => { dragging.current = true; setReflowRevision(revision => revision + 1); }} onNodeDragStop={(event, node) => {
        dragging.current = false;
        if (node.type === 'artifact') {
          const pointer = 'changedTouches' in event ? event.changedTouches[0] : event; const point = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
          const targets = flow.getNodes().filter(n => n.type === 'research' && expandedIds.includes(n.id) && n.id !== node.parentId).map(n => ({ node: n, absolute: flow.getInternalNode(n.id)?.internals.positionAbsolute })).filter(({ node: n, absolute: p }) => p && point.x >= p.x && point.x <= p.x + (n.width || 0) && point.y >= p.y && point.y <= p.y + (n.height || 0)); const target = targets.at(-1)?.node;
          if (target) { onReuse(node.data.artifact, target.id); setNodes(computedNodes); }
          else if (resultPages[node.data.destinationId]?.size !== 'all') { setNodes(computedNodes); }
          else { const position = { x: Math.max(GROUP_INSET.x, node.position.x), y: Math.max(GROUP_INSET.y, node.position.y) }; saveLocal(`artifact-group-position:${node.data.destinationId}:${node.data.artifact.id}`, position); setArtifactPlacementRevision(revision => revision + 1); const highlight = highlights.find(h => h.nodeId === node.data.destinationId && h.artifactId === node.data.artifact.id); if (highlight) onMoveHighlight(highlight.id, node.data.destinationId, position); setNodes(current => current.map(n => n.id === node.id ? { ...n, position } : n)); }
          return;
        }
        if (!readonly) void mutate([{ type: 'updateNode', id: node.id, patch: savedCanvasPosition(node.position, Boolean(node.parentId)) }], 'Move note').finally(() => setReflowRevision(revision => revision + 1));
      }}
      onConnect={c => { if (c.source && c.target) connect(c.source, c.target, c.sourceHandle as Side | undefined, c.targetHandle as Side | undefined); }}
      onConnectEnd={(event, state) => {
        if (state.isValid || !state.fromNode || readonly) return;
        const target = (event.target as HTMLElement | null)?.closest?.('.react-flow__node-research')?.getAttribute('data-id');
        if (target && target !== state.fromNode.id) connect(state.fromNode.id, target, state.fromHandle?.id as Side || 'right');
      }}
      connectionMode={ConnectionMode.Loose} connectOnClick={false} connectionRadius={28} nodesDraggable={!readonly && !animatingLayout} nodesConnectable={!readonly} deleteKeyCode={null} snapToGrid snapGrid={[24, 24]} minZoom={.08} maxZoom={1.8} defaultViewport={viewport.current} onMoveEnd={(_, view) => saveLocal(viewKey, view)} zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={24} size={1.1} color="#dedede"/></ReactFlow>
    <div className="canvas-header">
      <div className="canvas-context"><span className="eyebrow"><span className="live-dot"/>{historyCanvas ? 'Saved canvas · read only' : proposal ? 'Proposed changes' : 'Research canvas'}</span><span>{displayed.canvas.nodes.length} notes · {expandedIds.length} expanded</span></div>
      <div className="canvas-navigation"><button className="secondary small" aria-label="Broader view" onClick={broader}><ArrowLeft size={15}/> Broader view</button><button className="secondary small" aria-label="Arrange canvas" title="Place sources above consumers with room for relationship labels" disabled={readonly || arranging || animatingLayout || !displayed.canvas.nodes.length} onClick={() => void arrange()}>{arranging || animatingLayout ? <LoaderCircle size={15} className="spin"/> : <LayoutGrid size={15}/>} Arrange</button><button className="secondary small" aria-label="Canvas overview" title="See the entire canvas" onClick={() => void fitCanvas(400, true)}><Focus size={15}/> Overview</button><button className="secondary small" aria-label="Collapse all" disabled={!expandedIds.length} onClick={() => { onExpandedChange([]); onSelect(null); }}><PanelTopClose size={15}/></button></div>
      {showStageNavigation && <nav className="canvas-stage-navigation" aria-label="Research stages">{rootStages.map((node, index) => <button key={node.id} className={selectedId === node.id ? 'active' : ''} aria-label={`Focus stage: ${node.title}`} title={node.title} onClick={() => { onSelect(node.id); setFocusRequest(node.id); }}><span>{/^\s*\d+[.·:—–)\s]/u.test(node.title) ? node.title : `${index + 1} · ${node.title}`}</span></button>)}</nav>}
    </div>
    {!nodes.length && <div className="canvas-empty"><BookOpen size={34} strokeWidth={1.2}/><h2>Give a question room.</h2><p>Add what you know, or an Action to explore what you don’t.</p>{!readonly && <button className="primary" onClick={() => onAdd(null)}><Plus size={16}/> Add Knowledge or Action</button>}</div>}
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
    {message && <div className="canvas-feedback" role="status">{message}</div>}
    <div className="canvas-tools"><button className="icon-button" aria-label="Zoom out" onClick={() => void flow.zoomOut({ duration: 180 })}><Minus size={17}/></button><button className="icon-button" aria-label="Fit canvas" title="Fit at readable zoom; Overview shows everything" onClick={() => void fitCanvas()}><Focus size={18}/></button><button className="icon-button" aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration: 180 })}><Plus size={17}/></button></div><div className="canvas-hint">Double-click to expand · drag corner to resize · group links summarize relationships</div>
  </div>;
}
export function ResearchCanvas(props: Props) { return <ReactFlowProvider key={props.detail.project.id}><FlowCanvas {...props}/></ReactFlowProvider>; }
