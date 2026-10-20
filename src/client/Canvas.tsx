import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Background, BackgroundVariant, BaseEdge, ConnectionMode, EdgeLabelRenderer, Handle, MarkerType, NodeToolbar, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type Viewport } from '@xyflow/react';
import { ArrowUpRight, BookOpen, Bot, Quote, Search as SearchIcon, BoxSelect, Braces, Database, FileText, Image as ImageIcon, NotebookPen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CornerLeftUp, Focus, GitBranch, History, LayoutGrid, LoaderCircle, Maximize, Minus, PanelTopClose, Pencil, Pin, Play, Plus, Redo2, Settings2, Trash2, Undo2, X } from 'lucide-react';
import { BrandLogo } from './brand-logos';
import { NotionDatabase } from './NotionView';
import { ArtifactContent } from './Experiment';
import { MarkdownPreview } from './Content';
import { agentDirections, RESULT_PLACEHOLDER, splitSources } from '../shared/agent-work';
import { api } from './api';
import type { ExperimentCapabilities } from '../shared/experiments';
import { deriveGroupOutcomes, type CardOutcome, type CardOutcomeOptions } from '../shared/card-outcome';
import { resolveModelSetting, type ModelSettingsResponse } from '../shared/model-settings';
import { CARD_MAX_HEIGHT, CARD_MIN_HEIGHT, CARD_MIN_WIDTH, CARD_MAX_WIDTH, cardWidth, initialCardSize } from '../shared/card-size';
import { layoutOnly, savedCanvasPosition } from '../shared/canvas-position';
import { createCanvasReflowPlan, extendCanvasReflowPlan, reflowCanvas, type CanvasReflowPlan } from '../shared/canvas-reflow';
import { resultPage, changeResultPageSize, type ResultPageChoice } from '../shared/result-pages';
import { aggregateTopLevelRelationships, relationshipBadgeText, type AggregateRelationship } from '../shared/aggregate-relationships';
import { routeRelationship, type RelationshipRoute, type RouteNode } from '../shared/routing';
import { relationshipLabelSize } from '../shared/relationship-label';
import { readSaved, saveLocal } from './persistence';
import { arrangeCanvas, numberedStageOrder, CARD_SIZE, GROUP_FOOTER, GROUP_INSET, LAYOUT_GAP, type CanvasSize } from '../shared/layout';
import type { Artifact, Canvas, Mutation, NotionView, ProjectDetail, Proposal, RunStatus } from '../shared/types';
import type { NotebookSummary } from '../shared/notebooks';
import { textPreview } from '../shared/presentation';
import './canvas-interactions.css';
import './canvas-reading.css';
import './canvas-evidence.css';
import './groups.css';
import './aggregate-relationships.css';
import './agent-view.css';
import { GROUP_PREVIEW_MEMBERS, convertLegacyGroups, createGroupOperations, groupPreviewMembers, isGroup } from '../shared/groups';
import { blockRegistry, isOutputArtifact, nodeBlockType, primaryArtifact } from '../shared/blocks';
import { BlockPreview } from './BlockPreview';
import { CodeView } from './code';
import { CanvasDock } from './CanvasDock';

function notebookCard(detail: ProjectDetail, nodeId: string): Pick<CardData, 'notebook' | 'notebookFigure'> {
  const notebook = detail.notebooks?.find(item => item.nodeId === nodeId);
  if (!notebook) return {};
  return { notebook, ...(notebook.figure ? { notebookFigure: `/api/projects/${encodeURIComponent(detail.project.id)}/nodes/${encodeURIComponent(nodeId)}/notebook/figure?h=${notebook.figure}` } : {}) };
}
export function kindLabel(kind?: string) { return kind === 'group' ? 'Group' : kind === 'topic' ? 'Knowledge' : kind === 'activity' ? 'Action' : 'Note'; }
/** One icon per block type, so a Code block created under Knowledge still reads as code. */
export function KindIcon({ kind, blockType, size = 14 }: { kind?: string; blockType?: string; size?: number }) {
  if (blockType === 'notion') return <BrandLogo id="notion" size={size}/>;
  const Icon = kind === 'group' ? LayoutGrid : blockType === 'code' ? Braces : blockType === 'notebook' ? NotebookPen : blockType === 'dataset' ? Database : blockType === 'figure' ? ImageIcon : blockType === 'report' ? FileText : blockType === 'agent' ? Bot : blockType === 'search' ? SearchIcon : blockType === 'finding' ? Quote : kind === 'activity' ? Play : BookOpen;
  return <Icon size={size}/>;
}
type Side = 'top' | 'right' | 'bottom' | 'left';
const sides: { id: Side; position: Position }[] = [{ id: 'top', position: Position.Top }, { id: 'right', position: Position.Right }, { id: 'bottom', position: Position.Bottom }, { id: 'left', position: Position.Left }];
const ARTIFACT_SIZE = { width: 360, height: 300 };
type CardData = {
  kind?: string; title: string; description: string; status?: RunStatus; awaitingApproval?: boolean;
  workLabel?: string; blockType?: string; blockLabel: string; primary?: Artifact; members: number;
  /** A Notion database the card reads live. */
  notion?: { projectId: string; view: NotionView };
  /** The blocks a collapsed Group lists on its card. */
  listed?: { id: string; title: string; kind?: string; blockType?: string }[];
  /** A Code block's source, shown on the card. */
  code?: string;
  /** A Notebook block's cells and last run; `notebookFigure` is the address of its newest figure. */
  notebook?: NotebookSummary; notebookFigure?: string; chosen: Artifact[]; origins:Record<string,string>; onHighlightOpen: (artifact: Artifact) => void;
  inputCount: number; resultCount: number; expanded: boolean; preview?: 'added' | 'changed' | 'removed';
  onExpand: () => void; onInspect: () => void; onActivate: () => void; onAdd: () => void; onHandle: (side: Side) => void;
  onSave: (title: string, description: string) => Promise<unknown>; readonly: boolean;
  outcome: CardOutcome; width: number; resizePending: boolean;
  modelLabel?: string; modelTitle?: string; fileMissing?: boolean;
  results?: ResultPageChoice & { pageCount: number; total: number; start: number };
  onResultChoice: (choice: ResultPageChoice) => void;
  onWidth: (width: number | null, commit?: boolean) => void; onMeasure: (width: number, height: number) => void;
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
type ResearchNode = Node<CardData, 'research'>;
/** What an agent has done so far, in the words of its tool calls. */
function AgentFace({ data }: { data: CardData }) {
  const work = data.directions, running = data.agent?.status === 'running', plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return <div className="agent-face">
    {work && work.total > 0 ? <ul>
      <li><SearchIcon size={12}/>{plural(work.total, 'direction')} searched · {plural(work.sources, 'source')}</li>
      <li><BookOpen size={12}/>{work.written} of {plural(work.total, 'result note')} written</li>
      {work.pages + work.findings > 0 && <li><Quote size={12}/>{plural(work.pages, 'page')} read · {plural(work.findings, 'finding')}</li>}
    </ul> : !running && data.description ? <MarkdownPreview text={data.description} limit={200}/> : null}
    {data.agent?.pending ? <p className="agent-waiting">{plural(data.agent.pending, 'change')} waiting for your review</p> : null}
    {running && data.agent?.thought && <p className="agent-thought" title={data.agent.thought}>{textPreview(data.agent.thought, 160).text}</p>}
  </div>;
}
function ResearchCard({ id, data, selected }: NodeProps<ResearchNode>) {
  const flow = useReactFlow();
  const heading = useRef<HTMLDivElement>(null), resizing = useRef<{ x:number; width:number; zoom:number } | null>(null);
  const measure = useRef(data.onMeasure); measure.current = data.onMeasure;
  const group=data.kind==='group';
  useEffect(() => {
    if (data.expanded || !heading.current) return;
    const element=heading.current, update=()=>measure.current(data.width,Math.min(CARD_MAX_HEIGHT,Math.max(CARD_MIN_HEIGHT,(data.notion?element.scrollHeight:element.offsetHeight)+2)));
    const observer=new ResizeObserver(update);observer.observe(element);update();return()=>observer.disconnect();
  },[data.expanded,data.width,data.primary,data.chosen,data.notebookFigure]);
  const resizedWidth=(x:number)=>Math.max(CARD_MIN_WIDTH,Math.min(CARD_MAX_WIDTH,Math.round(resizing.current!.width+(x-resizing.current!.x)/resizing.current!.zoom)));
  const active=data.status==='running'||data.status==='queued';
  // Only states that need attention get a line; an idle block shows its content.
  const workState=data.awaitingApproval?'Awaiting approval':active?(data.label==='result'?'Searching':data.status):data.status==='failed'?'Latest attempt failed':data.status==='interrupted'?'Latest attempt interrupted':data.status==='cancelled'?'Latest attempt stopped':'';
  const notebook=data.blockType==='notebook'&&!group, code=data.code!==undefined&&!group, lastRun=data.notebook?.lastRun;
  return <article className={`research-card ${group?'organizational-group':'research-block'}${data.blockType==='finding'?' finding-card':''} ${data.expanded?'expanded-group':''} ${selected?'selected':''} ${data.preview?`preview-${data.preview}`:''}`}>
    {sides.map(side=><Handle key={side.id} id={side.id} type="source" position={side.position} isConnectable={!data.readonly} className="relationship-handle" role="button" tabIndex={data.readonly?-1:0} aria-label={`Connect ${data.title} from ${side.id}`} title="Drag to a block, or click then choose a block" onClick={event=>{event.stopPropagation();data.onHandle(side.id);}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();data.onHandle(side.id);}}}/>)}
    <div ref={heading} className="group-heading">
      <div className="card-top"><span className="card-type"><KindIcon kind={data.kind} blockType={data.blockType}/>{group?'Group':data.blockLabel==='Note'&&data.kind==='topic'?'Knowledge':data.blockLabel}{group&&<span className="group-item-count"> · {data.members} items</span>}{data.fileMissing&&<span className="card-file-missing" title="This block's file is missing from the project folder">File missing</span>}</span><span className="card-controls nodrag">
        <button className="icon-button card-open" aria-label={`Open ${data.title}`} data-tip={group?'Open group details':notebook?'Open notebook':code?'Open code and results':'Open content'} data-hint={group?undefined:'or double-click the block'} onClick={event=>{event.stopPropagation();data.onInspect();}}><ArrowUpRight size={15}/></button>
        {group&&<button className="icon-button group-expand-control" aria-label={`${data.expanded?'Collapse':'Expand'} ${data.title}`} title={data.expanded?'Collapse group':'Expand group'} onClick={event=>{event.stopPropagation();data.onExpand();}}>{data.expanded?<ChevronUp size={17}/>:<ChevronDown size={17}/>}</button>}
      </span></div>
      <div className="card-title" title={data.title}>{data.title||'Untitled'}</div>
      {group ? <>
        {data.workLabel&&<span className="group-contained-work">{data.workLabel}</span>}
        {data.description&&<p className="group-overview-excerpt">{data.description.slice(0,140)}{data.description.length>140?'…':''}</p>}
        {!data.expanded&&<div className="group-chosen-highlights nodrag nopan">{data.chosen.length?data.chosen.map(artifact=><button key={artifact.id} className="group-highlight-preview" aria-label={`Open highlight: ${artifact.title}`} title={`From ${data.origins[artifact.nodeId]??'a saved block'} · exact version ${artifact.hash}`} onClick={event=>{event.stopPropagation();data.onHighlightOpen(artifact);}}><BlockPreview artifact={artifact} compact/><span><strong>{artifact.title}</strong><small>{data.origins[artifact.nodeId]??'Saved block'} · {artifact.hash.slice(0,8)}</small></span></button>)
          :data.listed?.length?<ul className="group-member-list">{data.listed.slice(0,GROUP_PREVIEW_MEMBERS).map(member=><li key={member.id} title={member.title}><KindIcon kind={member.kind} blockType={member.blockType} size={12}/><span>{member.title}</span></li>)}{data.members>Math.min(data.listed.length,GROUP_PREVIEW_MEMBERS)&&<li className="more">{data.members-Math.min(data.listed.length,GROUP_PREVIEW_MEMBERS)} more</li>}</ul>
          :<p className="subtle">Choose up to three saved highlights in Group details.</p>}</div>}
      </> : <>
        {notebook?data.notebook?.cells?<div className={`block-work-state ${data.notebook.running?'running':lastRun?.status==='error'?'failed':lastRun?.status==='interrupted'?'interrupted':''}`}>{data.notebook.running&&<LoaderCircle size={12} className="spin"/>}{data.notebook.cells} cell{data.notebook.cells===1?'':'s'}{data.notebook.running?' · Running':lastRun?` · ${lastRun.status==='ok'?'Ran':lastRun.status==='error'?'Error in':'Stopped'} [${lastRun.executionCount??' '}] · ${new Date(lastRun.at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:''}</div>:null
        :data.blockType==='agent'?<div className={`block-work-state ${data.agent?.status==='running'?'running':data.agent&&data.agent.status!=='completed'?'failed':''}`}>{data.agent?.status==='running'&&<LoaderCircle size={12} className="spin"/>}{data.agent?`${agentState[data.agent.status]} · ${data.agent.runtime}`:'Agent'}</div>
        :workState&&<div className={`block-work-state ${data.status||''}`}>{active&&<LoaderCircle size={12} className="spin"/>}{workState}</div>}
        <div className="block-primary-preview nodrag nopan" onDoubleClick={event=>{event.stopPropagation();data.onInspect();}}>{notebook&&data.notebookFigure?<img className="block-figure-preview" src={data.notebookFigure} alt={`Newest figure in ${data.title}`}/>:notebook&&data.notebook?.value?<strong className="block-metric-preview">{data.notebook.value}</strong>:notebook&&data.notebook?.excerpt?(data.notebook.excerpt.kind==='code'?<pre className="block-code-preview">{data.notebook.excerpt.text.split('\n').slice(0,5).join('\n')}</pre>:<p className="block-text-preview">{textPreview(data.notebook.excerpt.text,220).text}</p>):data.blockType==='agent'?<AgentFace data={data}/>
          :data.blockType==='search'?<div className="search-face">{data.why&&<p className="search-why" title={data.why}>{data.why}</p>}<ul className="search-queries">{data.description.split('\n').filter(Boolean).slice(0,3).map((query,index)=><li key={index} title={query}><SearchIcon size={12}/><span>{query}</span></li>)}</ul></div>
          :data.label==='result'&&data.description===RESULT_PLACEHOLDER?<div className="search-face">{data.why&&<p className="search-why" title={data.why}>{data.why}</p>}{data.queries?.length?<ul className="search-queries">{data.queries.slice(0,3).map((query,index)=><li key={index} title={query}><SearchIcon size={12}/><span>{query}</span></li>)}</ul>:<p className="block-empty-hint">{data.description}</p>}</div>
          :data.notion?<NotionDatabase projectId={data.notion.projectId} nodeId={id} view={data.notion.view}/>:code?(data.code?<CodeView className="block-code-source nowheel" code={data.code}/>:<p className="block-empty-hint">No code yet</p>):data.primary?<BlockPreview artifact={data.primary}/>:data.description?<MarkdownPreview text={splitSources(data.description).body}/>:notebook?<p className="block-empty-hint">No cells yet</p>:null}</div>
        {selected&&data.modelLabel&&!data.notion&&<span className="node-model-indicator" title={data.modelTitle}>{data.modelLabel}</span>}
      </>}
      {!data.expanded&&!group&&(data.blockType==='search'||(data.label==='result'&&data.description===RESULT_PLACEHOLDER))&&data.sources?.length?<div className="outcome-footer"><small>{data.sources.length} source{data.sources.length===1?'':'s'} found</small></div>:null}
      {!data.expanded&&!group&&!data.primary&&!['search','agent'].includes(data.blockType??'')&&(({sources,hosts})=>sources>0&&<div className="outcome-footer"><small>{data.blockType==='finding'&&hosts.length?`From ${hosts.join(', ')}`:`${sources} source${sources===1?'':'s'} cited`}</small></div>)(splitSources(data.description))}
      {!data.expanded&&!group&&(data.resultCount>0||data.primary)&&<div className="outcome-footer">{data.resultCount>0&&<small>{data.resultCount} result{data.resultCount===1?'':'s'}</small>}{data.primary&&<small className="block-version">{['failed','interrupted','cancelled','queued','running'].includes(data.status??'')?'Earlier saved result · ':'Version · '}{data.primary.hash.slice(0,8)}</small>}</div>}
    </div>
    {!data.expanded&&!data.readonly&&<button className="card-width-handle nodrag nopan" disabled={data.resizePending} role="slider" aria-label={`Card width for ${data.title}`} aria-valuemin={CARD_MIN_WIDTH} aria-valuemax={CARD_MAX_WIDTH} aria-valuenow={data.width} title="Drag to resize width" onClick={event=>event.stopPropagation()}
      onPointerDown={event=>{event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);resizing.current={x:event.clientX,width:data.width,zoom:flow.getZoom()};data.onActivate();}}
      onPointerMove={event=>{if(resizing.current)data.onWidth(resizedWidth(event.clientX));}}
      onPointerUp={event=>{if(!resizing.current)return;const width=resizedWidth(event.clientX);resizing.current=null;event.currentTarget.releasePointerCapture(event.pointerId);data.onWidth(width,true);}}
      onPointerCancel={()=>{resizing.current=null;data.onWidth(null);}}
      onKeyDown={event=>{const width=event.key==='ArrowLeft'?data.width-24:event.key==='ArrowRight'?data.width+24:null;if(width!==null){event.preventDefault();event.stopPropagation();data.onWidth(Math.max(CARD_MIN_WIDTH,Math.min(CARD_MAX_WIDTH,width)),true);}}}/>}
    {data.expanded&&<div className="group-actions nodrag"><span>Mixed research blocks · relationships do not run work</span><button className="small secondary" disabled={data.readonly} onClick={event=>{event.stopPropagation();data.onAdd();}}><Plus size={14}/> Add inside</button></div>}
  </article>;
}
type ArtifactData = { artifact: Artifact; destinationId: string; highlighted: boolean; reused: boolean; originLabel?: string; producer?: string; onOpen: () => void; onPin: () => void; onReuse: () => void; readonly: boolean };
type ArtifactNode = Node<ArtifactData, 'artifact'>;
function ArtifactCard({ data }: NodeProps<ArtifactNode>) {
  const { artifact } = data;
  return <article className={`canvas-artifact ${data.highlighted ? 'highlighted' : ''}`}><div className="card-top"><span className="card-type">{data.highlighted ? <Pin size={13}/> : null}{data.reused ? 'Selected input' : artifact.kind}</span><div className="row nodrag"><button className="icon-button" aria-label={`${data.highlighted ? 'Unpin' : 'Pin'} ${artifact.title}`} disabled={data.readonly} title={data.highlighted ? 'Unpin highlight' : 'Pin as highlight'} onClick={data.onPin}><Pin size={15} fill={data.highlighted ? 'currentColor' : 'none'}/></button><button className="icon-button" aria-label={`Inspect ${artifact.title}`} title="Inspect result" onClick={data.onOpen}><ArrowUpRight size={15}/></button></div></div><h3>{artifact.title}</h3>{data.originLabel&&<span className="artifact-origin">{data.originLabel}</span>}<div className="artifact-preview nodrag nowheel" onDoubleClick={data.onOpen}><BlockPreview artifact={artifact}/></div><div className="artifact-footer"><span title={`Immutable version ${artifact.hash}`}>{data.reused ? 'Exact selected version' : 'Saved result'} · {artifact.hash.slice(0, 8)}{data.producer&&<small className="artifact-producer"> · Produced by {data.producer}</small>}</span><button className="text-button small nodrag" disabled={data.readonly} onClick={data.onReuse}>Reuse <ArrowUpRight size={13}/></button></div></article>;
}
const nodeTypes = { research: ResearchCard, artifact: ArtifactCard };
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
const edgeTypes = { relationship: CanvasRelationshipEdge };
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
function previewCanvas(canvas: Canvas, proposal?: Proposal) {
  const result = structuredClone(canvas); const marks = new Map<string, CardData['preview']>();
  for (const op of proposal?.operations || []) {
    if (op.type === 'addNode') { result.nodes.push(op.node); marks.set(op.node.id, 'added'); }
    // Blocks a proposal only moves, such as a tree laid out again around new groups, are not marked as changed.
    if (op.type === 'updateNode') { const n = result.nodes.find(n => n.id === op.id); if (n) Object.assign(n, op.patch); if (!layoutOnly(op.patch)) marks.set(op.id, 'changed'); }
    if (op.type === 'removeNode') marks.set(op.id, 'removed');
    if (op.type === 'addConnection') result.connections.push(op.connection);
    if (op.type === 'removeConnection') result.connections = result.connections.filter(c => c.id !== op.id);
  }
  return { canvas: convertLegacyGroups(result), marks };
}
export type CanvasHighlight = { id: string; nodeId: string; artifactId: string; x: number; y: number };
type Props = { notices?: ReactNode; proposalCard?: ReactNode; detail: ProjectDetail; agentTurns?: Record<string, AgentTurnSummary>; selectedId: string | null; onSelect: (id: string | null) => void; onInspect: (id: string) => void; onArtifact: (artifact: Artifact, nodeId: string) => void; onReuse: (artifact: Artifact, nodeId?: string) => void; onPin: (artifact: Artifact, nodeId: string) => void; onMoveHighlight: (id: string, nodeId: string, position: { x: number; y: number }) => void; highlights: CanvasHighlight[]; mutate: (operations: Mutation[], label: string) => Promise<unknown>; onAdd: (parentId: string | null) => void; onUndo?: () => void; onRedo?: () => void; onHistory?: () => void; onDemo?: () => void; demoLabel?: string; onTour?: () => void; historyOpen?: boolean; busy?: boolean; proposal?: Proposal; historyCanvas?: Canvas; expandedIds: string[]; onExpandedChange: (ids: string[]) => void; focusId?: string | null; frame?: { ids: string[]; key: number } | null; missingFiles?: ReadonlySet<string> };
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
function FlowCanvas({ notices, proposalCard, detail, selectedId, onSelect, onInspect, onArtifact, onReuse, onPin, onMoveHighlight, highlights, mutate, onAdd, onUndo, onRedo, onHistory, onDemo, demoLabel='Demo', onTour, historyOpen=false, busy=false, proposal, historyCanvas, expandedIds: requestedExpandedIds, onExpandedChange, focusId, frame, missingFiles, agentTurns }: Props) {
  const expandedIds = useMemo(()=>{const canvas=historyCanvas||detail.project.canvas;return requestedExpandedIds.filter(id=>canvas.nodes.some(node=>node.id===id&&(isGroup(node)||canvas.nodes.some(child=>child.parentId===id))));},[requestedExpandedIds,historyCanvas,detail.project.canvas]);
  const flow = useReactFlow(); const dragging = useRef(false); const area = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false), [groupSelection, setGroupSelection] = useState<string[]>([]), [groupName, setGroupName] = useState('New group');
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null), [focusRequest, setFocusRequest] = useState<string | null>(null), [frameRequest, setFrameRequest] = useState<string[] | null>(null);
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
  const reflowState = useRef<{ plan: CanvasReflowPlan; canvas: Canvas; sizes: Record<string, CanvasSize>; positions: string; dimensions: string; structure: string; shape: string; ready: boolean } | null>(null);
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
      for (const element of area.current!.parentElement?.querySelectorAll('.canvas-tools, .canvas-hint, .selection-toolbar, .project-floating-actions, .edge-selection, .ros-dock') || []) {
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
    const zoom = Math.max(.45, Math.min(1, width / (content.width + 40), height / (content.height + 40)));
    const x = inset.left + Math.max(0, (width - content.width * zoom) / 2), y = inset.top + Math.max(0, (height - content.height * zoom) / 2);
    return flow.setViewport({ x: x - content.x * zoom, y: y - content.y * zoom, zoom }, { duration });
  };
  const readonly = Boolean(historyCanvas || proposal);
  const displayed = useMemo(() => previewCanvas(historyCanvas || detail.project.canvas, historyCanvas ? undefined : proposal), [historyCanvas, detail.project.canvas, proposal]);
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
  const deletable = readonly || busy ? [] : (selecting ? groupSelection : selectedId ? [selectedId] : []).filter(id => displayed.canvas.nodes.some(node => node.id === id));
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
  const computedNodes = useMemo<(ResearchNode | ArtifactNode)[]>(() => {
    const build = (parentId: string | null, depth = 0): { nodes: (ResearchNode | ArtifactNode)[]; width: number; height: number } => {
      const siblings = displayed.canvas.nodes.filter(n => (n.parentId || null) === parentId).sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
      const built: (ResearchNode | ArtifactNode)[] = []; let right = 0, bottom = 0;
      for (const node of siblings) {
        const expanded = isGroup(node) && expandedIds.includes(node.id); const child = expanded ? build(node.id, depth + 1) : { nodes: [], width: 0, height: 0 };
        const width = expanded ? Math.ceil(Math.max(768, child.width + GROUP_INSET.x * 2) / 24) * 24 : cardSizes[node.id].width;
        const height = expanded ? Math.ceil(Math.max(408, child.height + GROUP_INSET.y + GROUP_FOOTER) / 24) * 24 : cardSizes[node.id].height;
        const box: Box = { x: parentId ? Math.max(0, node.x) : node.x, y: parentId ? Math.max(0, node.y) : node.y, width, height };
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
        built.push({ id: node.id, type: 'research', parentId: parentId || undefined, position: { x: box.x + (parentId ? GROUP_INSET.x : 0), y: box.y + (parentId ? GROUP_INSET.y : 0) }, width, height, style: { width, height }, selected: groupSelection.includes(node.id) || node.id === selectedId, zIndex: depth, dragHandle: '.group-heading', data: { workLabel, ...notebookCard(detail, node.id), notion: node.notion ? { projectId: detail.project.id, view: node.notion } : undefined, origins:Object.fromEntries(displayed.canvas.nodes.map(item=>[item.id,item.title])), blockType:node.blockType, blockLabel:blockRegistry[nodeBlockType(node)].label, code:nodeBlockType(node)==='code'?node.code?.source??detail.artifacts.find(item=>item.id===node.artifactId&&item.kind==='code')?.content??'':undefined, primary:isGroup(node)?undefined:primaryArtifact(node,detail), members:displayed.canvas.nodes.filter(item=>item.parentId===node.id).length, listed:isGroup(node)&&!expanded?groupPreviewMembers(displayed.canvas,node.id).map(({id,title,kind,blockType})=>({id,title,kind,blockType})):undefined, chosen:(node.groupHighlights??[]).flatMap(highlight=>{const artifact=detail.artifacts.find(item=>item.id===highlight.artifactId&&item.nodeId===highlight.nodeId&&item.hash===highlight.hash);return artifact?[artifact]:[];}), onHighlightOpen:artifact=>onArtifact(artifact,artifact.nodeId), modelLabel:selectedModel?.label??effective?.selection.model, modelTitle, results: resultPages[node.id], onResultChoice: choice => changeResults(node.id, choice), resizePending: resizingCards.includes(node.id), outcome: cardOutcomes[node.id], width: cardSizes[node.id].width, onWidth: (width, commit) => resizeCard(node.id, width, commit), onMeasure: (width, height) => measureCard(node.id, width, height), kind: node.kind, title: node.title, description: node.description, status, awaitingApproval: runs.some(r => (r.configuration.approval as { status?: string } | undefined)?.status === 'pending'), inputCount: detail.inputs.filter(i => i.nodeId === node.id).length, resultCount: detail.artifacts.filter(a => a.nodeId === node.id && isOutputArtifact(a)).length, expanded, preview: displayed.marks.get(node.id), onExpand: () => toggle(node.id), onInspect: () => {const artifact=node.artifactId?detail.artifacts.find(item=>item.id===node.artifactId):undefined;if(artifact&&!['code','notebook'].includes(node.blockType??''))onArtifact(artifact,node.id);else onInspect(node.id);}, onActivate: () => onSelect(node.id), onAdd: () => onAdd(node.id), onHandle: side => handleClick(node.id, side), onSave: (title, description) => mutate([{ type: 'updateNode', id: node.id, patch: { title, description } }], 'Edit note'), readonly, fileMissing: missingFiles?.has(node.id), agent: node.agent ? agentTurns?.[node.agent.turnId] : undefined, label: node.label, sources: direction ? detail.artifacts.filter(a => a.nodeId === node.id && a.kind === 'source').sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : undefined, why: direction ? displayed.canvas.connections.find(c => c.target === node.id && displayed.canvas.nodes.find(n => n.id === c.source)?.blockType === 'agent')?.label : undefined, queries: node.label === 'result' ? runs.filter(r => r.provider === 'tavily').map(r => r.request) : undefined, directions: node.blockType === 'agent' ? (({ directions, written, sources, pages, findings }) => ({ total: directions.length, written, sources, pages: pages.length, findings }))(agentDirections(displayed.canvas, detail.artifacts, node.id)) : undefined } }, ...child.nodes);
      }
      return { nodes: built, width: right, height: bottom };
    };
    return build(null).nodes;
  }, [displayed, expandedIds, detail.runs, detail.inputs, detail.artifacts, selectedId, highlights, readonly, pendingConnection, artifactPlacementRevision, cardSizes, cardOutcomes, resizingCards, resultPages, modelSettings, descendantIds, groupSelection, missingFiles, agentTurns]);
  const [nodes, setNodes] = useState(computedNodes);
  const liveNodes = useRef(nodes); liveNodes.current = nodes;
  const extraContent = useMemo(() => ({}), []);
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
  const edges = useMemo<RoutedEdge[]>(() => {
    // Original endpoints remain visible in expanded frames; collapsed ancestors
    // aggregate only their hidden contributions.
    const byId=new Map(nodes.map(node=>[node.id,node]));
    const absolute=(id:string):{x:number;y:number}=>{const node=byId.get(id)!;const parent=node.parentId?absolute(node.parentId):{x:0,y:0};return {x:node.position.x+parent.x,y:node.position.y+parent.y};};
    const geometry: RouteNode[] = nodes.filter(node=>node.type==='research').map(node=>({id:node.id,parentId:node.parentId,...absolute(node.id),width:node.width||CARD_SIZE.width,height:node.height||CARD_SIZE.height}));
    const items = aggregatedRelationships.flatMap(group => {
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
      return { id: group.id, type: 'relationship' as const, source: group.source, target: group.target, sourceHandle: route.sourceHandle, targetHandle: route.targetHandle, selected, zIndex: 1000, ariaLabel: `Inspect relationship: ${tooltip.replace(/\n/gu, ' ')}`, style: { stroke: color, strokeWidth: selected ? 2 : 1.5 }, interactionWidth: 24, markerEnd: marker, ...(group.bidirectional ? { markerStart: marker } : {}), data: { route, label, tooltip, showLabel, onSelect: () => { setSelectedEdge(group.id); setPendingConnection(null); } } };
    });
  }, [aggregatedRelationships, nodes, selectedEdge, expandedIds, displayed.canvas]);
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
  return <div ref={area} className={`canvas-area unified-canvas direct-canvas ${pendingConnection ? 'is-connecting' : ''} ${arranging || animatingLayout ? 'is-arranging' : ''}`} data-testid="canvas">
    <ReactFlow<ResearchNode | ArtifactNode, RoutedEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current))}
      onNodeClick={(event, node) => { if ((event.target as HTMLElement).closest('.relationship-handle')) return; if (node.type === 'research') { if (pendingConnection && pendingConnection.nodeId !== node.id) connect(pendingConnection.nodeId, node.id, pendingConnection.side); else if(selecting){setGroupSelection(ids=>ids.includes(node.id)?ids.filter(id=>id!==node.id):[...ids,node.id]);} else onSelect(node.id); } setSelectedEdge(null); }}
      onNodeDoubleClick={(event, node) => { if ((event.target as HTMLElement).closest('input,textarea,button,.inline-note-editor')) return; if (node.type === 'research') { if(isGroup(displayed.canvas.nodes.find(item=>item.id===node.id)!)) toggle(node.id); else {const contentNode=displayed.canvas.nodes.find(item=>item.id===node.id),artifact=detail.artifacts.find(item=>item.id===contentNode?.artifactId);if(artifact&&!['code','notebook'].includes(contentNode?.blockType??''))onArtifact(artifact,node.id);else onInspect(node.id);} } else onArtifact(node.data.artifact, node.data.destinationId); }}
      onPaneClick={() => { if(!selecting)setGroupSelection([]); onSelect(null); setSelectedEdge(null); setPendingConnection(null); }} onEdgeClick={(_, edge) => { setSelectedEdge(edge.id); setPendingConnection(null); }} onEdgeDoubleClick={(_, edge) => { setSelectedEdge(edge.id); setPendingConnection(null); }}
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
      connectionMode={ConnectionMode.Loose} connectOnClick={false} connectionRadius={28} nodesDraggable={!readonly && !animatingLayout} nodesConnectable={!readonly} deleteKeyCode={null} snapToGrid snapGrid={[24, 24]} minZoom={.08} maxZoom={1.8} defaultViewport={viewport.current} onMoveEnd={(_, view) => saveLocal(viewKey, view)} zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#b8b8b8" bgColor="#ffffff"/>{proposalCard && proposalAnchors.length > 0 && <NodeToolbar nodeId={proposalAnchors} isVisible position={Position.Right} align="start" offset={20} className="proposal-anchor nodrag nopan nowheel">{proposalCard}</NodeToolbar>}</ReactFlow>
    <div className="canvas-header">
      <div className="canvas-context"><span className="eyebrow"><span className="live-dot"/>{historyCanvas ? 'Saved canvas · read only' : proposal ? 'Proposed changes' : 'Research canvas'}</span><span>{displayed.canvas.nodes.filter(node=>!isGroup(node)).length} blocks · {displayed.canvas.nodes.filter(isGroup).length} groups</span></div>
      <div className="canvas-edit-controls nodrag nopan" role="toolbar" aria-label="Canvas editing">
        <button className="secondary small canvas-add-button" data-testid="add-node" aria-label="Add block to canvas" disabled={readonly||busy} onClick={()=>onAdd(null)}><Plus size={15}/> Add block</button>
        {onUndo&&<button className="icon-button" aria-label="Undo canvas change" title="Undo canvas change" disabled={!detail.canUndo||readonly||busy} onClick={onUndo}><Undo2 size={16}/></button>}
        {onRedo&&<button className="icon-button" aria-label="Redo canvas change" title="Redo canvas change" disabled={!detail.canRedo||readonly||busy} onClick={onRedo}><Redo2 size={16}/></button>}
        {onHistory&&<button className={`icon-button ${historyOpen?'active':''}`} aria-label="Canvas history" title="Canvas content history" aria-expanded={historyOpen} aria-controls="canvas-content-history" onClick={onHistory}><History size={16}/></button>}
        {onDemo&&<button className="secondary small canvas-add-button" onClick={onDemo}><BookOpen size={14}/>{demoLabel}</button>}
        {onTour&&<button className="icon-button" title="Tour saved research" aria-label="Start guided demo" onClick={onTour}><BookOpen size={17}/></button>}
      </div>
      {showStageNavigation && <nav className="canvas-stage-navigation" aria-label="Research stages">{rootStages.map((node, index) => <button key={node.id} className={selectedId === node.id ? 'active' : ''} aria-label={`Focus stage: ${node.title}`} title={node.title} onClick={() => { onSelect(node.id); setFocusRequest(node.id); }}><span>{/^\s*\d+[.·:—–)\s]/u.test(node.title) ? node.title : `${index + 1} · ${node.title}`}</span></button>)}</nav>}
    </div>
    <CanvasDock label="Canvas tools" items={[
      { id: 'group', label: selecting ? 'Done' : 'Group', hint: selecting ? 'Stop picking blocks.' : 'Pick blocks, then put them in a group.', icon: <BoxSelect size={19}/>, pressed: selecting, disabled: readonly, onClick: () => { setSelecting(!selecting); setGroupSelection([]); onSelect(null); } },
      { id: 'up', label: 'Up a level', hint: 'Go to the group around the selected block.', icon: <CornerLeftUp size={19}/>, onClick: broader },
      { id: 'tidy', label: 'Tidy', hint: 'Line blocks up so nothing overlaps.', icon: arranging || animatingLayout ? <LoaderCircle size={19} className="spin"/> : <LayoutGrid size={19}/>, disabled: readonly || arranging || animatingLayout || !displayed.canvas.nodes.length, onClick: () => void arrange() },
      { id: 'delete', label: 'Delete', hint: deletable.length > 1 ? `Delete the ${deletable.length} picked blocks (⌫).` : 'Delete the selected block (⌫).', icon: <Trash2 size={19}/>, disabled: !deletable.length, onClick: removeSelected },
      { id: 'all', label: 'See all', hint: 'Zoom out to show every block.', icon: <Maximize size={19}/>, onClick: () => void fitCanvas(400, true) },
      { id: 'collapse', label: 'Collapse', hint: 'Close every open group.', icon: <PanelTopClose size={19}/>, disabled: !expandedIds.length, onClick: () => { onExpandedChange([]); onSelect(null); } },
    ]}/>
    {!nodes.length && <div className="canvas-empty"><BookOpen size={34} strokeWidth={1.2}/><h2>Give a question room.</h2><p>Add what you know, or an Action to explore what you don’t.</p></div>}
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
