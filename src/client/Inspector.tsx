import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, Clock3, Database, FileText, Globe2, History, LoaderCircle, MessageSquare, RotateCcw, Square, X } from 'lucide-react';
import type { Artifact, CanvasNode, Mutation, ProjectDetail, Run } from '../shared/types';
import { kindName, textLabel } from '../shared/vocabulary';
import { useEditDraft, readSaved, saveLocal } from './persistence';
import { ArtifactContent } from './Experiment';
import { date, Evidence, RichText, time } from './Content';
import { MarkdownEditor } from './MarkdownEditor';
import { PartBoundary } from './ErrorBoundary';
import { isImageType, isVideoType, noteImageUrl } from '../shared/files';
import './detail-polish.css';
import { NotionBlock } from './NotionView';
import { GoogleBlock } from './GoogleView';
import { MapBlock } from './MapView';
import { TrainingBlock } from './TrainingView';
import { MetricBlock } from './MetricView';
import { CLOUD_SHOWS } from '../shared/metrics';
import { DashboardBlock } from './DashboardView';
import { dashboardSources, dashboardsWithRoom, pinOperations } from './dashboard-pins';
import { PostSheet } from './PostView';
import { rowBlockOperations } from '../shared/notion-rows';
import './note-view.css';
import { groupMembers, isGroup } from '../shared/groups';
import { primaryArtifact } from '../shared/blocks';
import { FileViewer, type ShownFile } from './FileView';
import { SourceCheckView } from './SourceCheck';
import { WebSources } from './WebBlock';
import { SqlPanel } from './SqlPanel';

type Props = {
  node: CanvasNode; detail: ProjectDetail;
  mutate: (operations: Mutation[], label: string) => Promise<boolean>;
  onCancel: (runId: string) => Promise<boolean>; onRetry: (runId: string) => Promise<boolean>;
  onAttach: (artifact?: Artifact, destinationId?: string) => void;
  onOpenArtifact: (artifact: Artifact) => void; onOpenNote: (nodeId: string) => void;
  readOnly?: boolean;
  /** Why the view is read only. */
  readOnlyNote?: string;
  /** The PDF or image a File block shows. */
  file?: ShownFile;
  /** Asks ROS to check the block's claims on the web. */
  onCheckSources?: () => void;
  /** Set where SQL runs, on this computer: reloads the project after a query result is saved. */
  sql?: { onChanged: () => Promise<unknown> };
  /** Copies the tab a Google Sheet block shows into a new Data block; false when it did not happen. */
  onGoogleCopy?: () => Promise<boolean>;
  /** Whether the conversation column shows, when the frame around the block owns that choice through its footer chip. */
  conversation?: boolean; onConversation?: (open: boolean) => void;
};

export function Inspector({ node, detail, mutate, onCancel, onRetry, onAttach, onOpenArtifact, onOpenNote, readOnly = false, readOnlyNote = 'Historical canvas · return to the current canvas to make changes.', file, onCheckSources, sql, onGoogleCopy, conversation, onConversation }: Props) {
  const [side, setSide] = useState<'conversation' | 'history'>(() => ['runs', 'experiment'].includes(readSaved<string>(`node-tab:${node.id}`, 'work')) ? 'history' : 'conversation');
  useEffect(() => saveLocal(`node-tab:${node.id}`, side === 'history' ? 'runs' : 'work'), [node.id, side]);
  // Typed text is kept in the browser until it is saved, and comes back only while the block still holds the text it was
  // typed on; while nothing unsaved was typed, the editor follows the block's text (persistence.ts).
  const [title, setTitle, titleSaved] = useEditDraft(`node-title:${node.id}`, node.title, !readOnly); const [description, setDescription, descriptionSaved] = useEditDraft(`node-description:${node.id}`, node.description, !readOnly);
  // The conversation stays out of the way until asked for.
  const [chatState, setChatState] = useState(false);
  const chatOpen = conversation ?? chatState, setChatOpen = (open: boolean) => { setChatState(open); onConversation?.(open); };
  // Text saves itself shortly after typing stops, and the title when you leave it, like a file in Obsidian. Text counts as
  // saved only once the service took it: a save that fails goes again a moment later, and again when the block closes.
  const latest = useRef({ title, description }); latest.current = { title, description };
  const held = useRef({ title: node.title, description: node.description }); held.current = { title: node.title, description: node.description };
  const sending = useRef<{ title?: string; description?: string }>({});
  const save = useRef((_field: 'title' | 'description', _retry?: boolean) => {}); save.current = (field, retry = true) => {
    const text = field === 'title' ? latest.current.title.trim() || 'Untitled node' : latest.current.description;
    if (readOnly || text === held.current[field] || text === sending.current[field]) return;
    sending.current[field] = text;
    void mutate([{ type: 'updateNode', id: node.id, patch: field === 'title' ? { title: text } : { description: text } }], field === 'title' ? 'Rename block' : `Edit ${node.title}`).then(ok => {
      if (sending.current[field] === text) delete sending.current[field];
      if (ok) { held.current[field] = text; (field === 'title' ? titleSaved : descriptionSaved)(text); }
      // Refused because the project moved on meanwhile (another window, an agent): the newest copy is in now, so once more.
      else if (retry) setTimeout(() => save.current(field, false), 1000);
    });
  };
  const saveDescription = useRef(() => {}); saveDescription.current = () => save.current('description');
  const saveTitle = useRef(() => {}); saveTitle.current = () => save.current('title');
  useEffect(() => { const timer = setTimeout(() => saveDescription.current(), 700); return () => clearTimeout(timer); }, [description]);
  useEffect(() => () => { saveDescription.current(); saveTitle.current(); }, []);
  const runs = detail.runs.filter(r => r.nodeId === node.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = runs.find(run => run.configuration.kind !== 'local-experiment' && ['running', 'queued'].includes(run.status));
  const messages = detail.messages.filter(message => message.nodeId === node.id);
  const primary = isGroup(node) ? undefined : primaryArtifact(node, detail), children = detail.project.canvas.nodes.filter(item => item.parentId === node.id);
  const thread = useRef<HTMLDivElement>(null);
  // A picture fills the view; its text is a caption under it.
  const picture = Boolean(file && (isImageType(file.mediaType) || isVideoType(file.mediaType)));
  // A Data block can query the project's data with SQL.
  const sqlShown = Boolean(sql) && !readOnly && node.blockType === 'dataset' && !node.notion && !file;
  const [sqlOpen, setSqlOpen] = useState(false);
  const sqlPanel = sqlShown && sqlOpen && <SqlPanel projectId={detail.project.id} node={node} revision={detail.project.revision} onSaved={async (artifact, filled) => { await sql!.onChanged(); if (filled) setSqlOpen(false); else onOpenArtifact(artifact); }}/>;
  useEffect(() => { if (side === 'conversation') thread.current?.scrollTo({ top: thread.current.scrollHeight }); }, [side, messages.length, active?.events.length]);
  return <aside className={`inspector note-view${chatOpen?'':' chat-closed'}${picture?' picture-view':''}`} aria-label="Node work tools">
    <div className="note-main">
      {!chatOpen&&conversation===undefined&&(messages.length>0||runs.length>0||active)&&<button className="note-chat-toggle" aria-expanded={false} aria-controls={`note-side-${node.id}`} onClick={()=>setChatOpen(true)}><MessageSquare size={13}/> Conversation{active?<LoaderCircle size={12} className="spin"/>:messages.length>0&&<span>{messages.length}</span>}</button>}
      {node.notion?.kind!=='page'&&!node.post&&<><label className="sr-only" htmlFor={`note-title-${node.id}`}>Note title</label><input id={`note-title-${node.id}`} className="note-title" aria-label="Node title" data-testid="node-title" readOnly={readOnly} value={title} onChange={event=>setTitle(event.target.value)} onBlur={()=>saveTitle.current()} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}} placeholder="Untitled node" maxLength={200}/></>}
      {readOnly&&<div className="history-inspector-note">{readOnlyNote}</div>}
      {node.notion&&<section className="note-content"><NotionBlock projectId={detail.project.id} nodeId={node.id} view={node.notion} full readOnly={readOnly} onAccount={readOnly?undefined:account=>void mutate([{type:'updateNode',id:node.id,patch:{notion:{...node.notion!,account}}}],'Read with another Notion account')} onTitle={value=>{if(value&&value!==node.title)void mutate([{type:'updateNode',id:node.id,patch:{title:value.slice(0,200)}}],'Rename from Notion');}} onRows={readOnly?undefined:async table=>{const {operations,added,skipped,beyond}=rowBlockOperations(detail.project.canvas,node,table);if(operations.length&&!await mutate(operations,`One block per row of ${node.title}`.slice(0,80)))return null;return {added:operations.length?added:0,skipped,beyond};}}/>{node.notion.filter&&<p className="subtle">Rows where {node.notion.filter}</p>}</section>}
      {node.training&&<section className="note-content"><TrainingBlock projectId={detail.project.id} nodeId={node.id} view={node.training} full/></section>}
      {node.blockType==='map'&&<section className="note-content"><MapBlock view={node.map??{pins:[]}} full onPins={readOnly?undefined:pins=>mutate([{type:'updateNode',id:node.id,patch:{map:{pins}}}],`Change the places on ${node.title}`.slice(0,80))}/></section>}
      {node.metric&&<section className="note-content"><MetricBlock projectId={detail.project.id} nodeId={node.id} view={node.metric} title={node.title} full onShow={readOnly||node.metric.source!=='cloud'?undefined:show=>{ const named=[node.metric?.source==='cloud'&&node.metric.show?CLOUD_SHOWS[node.metric.show].label:'','Accounts and downloads','ros.ai cloud'].includes(node.title); void mutate([{type:'updateNode',id:node.id,patch:{metric:{source:'cloud',...(show?{show}:{})},...(named?{title:show?CLOUD_SHOWS[show].label:'Accounts and downloads'}:{})}}],'Show in ros.ai cloud block'); }} pin={readOnly?undefined:{dashboards:dashboardsWithRoom(detail.project.canvas.nodes),onPin:(key,dashboard,show)=>void mutate(pinOperations(detail.project.canvas.nodes,node,key,dashboard,show),dashboard?'Pin a number to a dashboard':'Start a dashboard')}}/></section>}
      {node.blockType==='dashboard'&&<section className="note-content"><DashboardBlock projectId={detail.project.id} view={node.dashboard??{tiles:[]}} sources={dashboardSources(detail.project.canvas.nodes)} full onTiles={readOnly?undefined:tiles=>void mutate([{type:'updateNode',id:node.id,patch:{dashboard:{tiles}}}],`Change the tiles on ${node.title}`.slice(0,80))}/></section>}
      {node.post&&<section className="note-content"><PostSheet projectId={detail.project.id} nodeId={node.id} post={node.post} title={node.title}/></section>}
      {node.google&&<section className="note-content"><GoogleBlock projectId={detail.project.id} nodeId={node.id} view={node.google} full onSheet={readOnly?undefined:sheet=>void mutate([{type:'updateNode',id:node.id,patch:{google:{...node.google!,sheet}}}],`Show ${sheet} of ${node.title}`.slice(0,80))} onCopy={readOnly||node.google.kind!=='sheet'?undefined:onGoogleCopy}/></section>}
      {!file&&(!readOnly||description)&&<PartBoundary fallback={()=><><p className="note-plain-note">This text could not be shown with formatting, so it shows as written.</p><textarea className="note-plain-editor" aria-label="Block text" value={description} readOnly={readOnly} onChange={event=>setDescription(event.target.value)} onBlur={()=>saveDescription.current()}/></>}><MarkdownEditor key={node.id} value={description} onChange={setDescription} onBlur={()=>saveDescription.current()} imageUrl={src=>noteImageUrl(detail.project.id,node.id,src)} readOnly={readOnly} ariaLabel="Block text" placeholder="Start writing…"/></PartBoundary>}
      {!file&&!isGroup(node)&&!node.notion&&!node.google&&!node.training&&!node.metric&&!node.post&&!node.app&&!node.web&&node.blockType!=='agent'&&node.blockType!=='map'&&node.blockType!=='dashboard'&&<SourceCheckView check={node.check} text={description} onCheck={readOnly?undefined:onCheckSources}/>}
      {node.web&&<WebSources node={node} detail={detail} onOpenArtifact={onOpenArtifact}/>}
      {file&&!picture&&description&&<div className="note-description"><RichText text={description}/></div>}
      {file&&<FileViewer file={file} title={node.title} text={primary?.kind==='source'?primary:undefined}/>}
      {file&&picture&&description&&<div className="note-description picture-caption-text"><RichText text={description}/></div>}
      {primary&&!file&&<section className="note-content"><div className="note-content-heading"><h3>{primary.title}</h3><span className="note-content-actions">{sqlShown&&<button className="text-button small" aria-pressed={sqlOpen} onClick={()=>setSqlOpen(!sqlOpen)}>{sqlOpen?<><X size={12}/> Close SQL</>:<><Database size={12}/> Query with SQL</>}</button>}<button className="text-button small" onClick={()=>onOpenArtifact(primary)}>Open <ArrowRight size={12}/></button></span></div>{sqlPanel||(['plot','dataset','table','metric','code','log'].includes(primary.kind)?<ArtifactContent artifact={primary}/>:<RichText text={primary.content}/>)}</section>}
      {!primary&&sqlShown&&<section className="note-content">{sqlOpen?<><div className="note-content-heading"><h3>Fill this block with a query</h3><button className="text-button small" onClick={()=>setSqlOpen(false)}><X size={12}/> Close SQL</button></div>{sqlPanel}</>:<button className="secondary small sql-start" onClick={()=>setSqlOpen(true)}><Database size={13}/> Query with SQL</button>}</section>}
      {isGroup(node)&&<section className="note-content"><h3>Blocks in this Group</h3>{children.map(child=><button className="overview-artifact" key={child.id} onClick={()=>onOpenNote(child.id)}><FileText size={16}/><span><strong>{child.title}</strong><small>{kindName(child)}{textLabel(child)?` · ${textLabel(child)}`:''}</small></span><ArrowRight size={14}/></button>)}</section>}
      {isGroup(node)&&<GroupHighlights node={node} detail={detail} mutate={mutate} onOpenArtifact={onOpenArtifact} onOpenNote={onOpenNote} readOnly={readOnly}/>}
      {readOnly&&!description&&!primary&&!children.length&&!node.notion&&!node.google&&!file&&node.blockType!=='map'&&<div className="note-empty"><FileText size={22} strokeWidth={1.3}/><p>Nothing here yet. Ask in the conversation to develop this {isGroup(node)?'group':'note'}.</p></div>}
    </div>
    {chatOpen&&<div className="note-side" id={`note-side-${node.id}`}>
      <div className="note-side-heading"><strong>{side==='history'?'History':'Conversation'}</strong><span className="note-side-spacer"/><button className={`note-history-toggle${side==='history'?' active':''}`} aria-pressed={side==='history'} aria-label={side==='history'?'Close history':undefined} onClick={()=>setSide(side==='history'?'conversation':'history')}>{side==='history'?<><X size={13}/> Close</>:<><History size={13}/> History{runs.length>0&&<span>{runs.length}</span>}</>}</button><button className="icon-button" aria-label="Hide conversation" title="Hide conversation" onClick={()=>setChatOpen(false)}><X size={15}/></button></div>
      {side==='history'
        ? <div className="note-side-scroll runs-section">{!runs.length&&<div className="empty-small"><Clock3 size={22} strokeWidth={1.2}/><p>Each run of this node will appear here.</p></div>}{runs.map((run,index)=><RunDetails key={run.id} run={run} detail={detail} initialOpen={index===0} onAttach={onAttach} onCancel={onCancel} onRetry={onRetry} readOnly={readOnly}/>)}</div>
        : <div ref={thread} className="note-side-scroll conversation" data-testid="node-conversation">
          {!messages.length&&<p className="note-side-welcome">No earlier conversation on this block. To talk about it, select it on the map and ask ROS from the composer.</p>}
          {messages.map(message => {
            const run = message.runId ? detail.runs.find(r => r.id === message.runId) : undefined;
            const sources = run ? evidenceForRun(run, detail) : [];
            const result = run ? detail.artifacts.find(a => a.runId === run.id && a.kind === 'result') : undefined;
            return <article key={message.id} className={`chat-message ${message.role}`}><div className="message-meta"><span>{message.role === 'user' ? 'You' : message.role === 'system' ? 'Workspace update' : 'ros.ai'}</span><time>{time(message.createdAt)}</time></div><RichText text={message.content} sources={sources} scope={run?.id || message.id} />{message.role === 'assistant' && run && <><Evidence sources={sources} onAttach={readOnly ? undefined : onAttach} scope={run.id} /><div className="note-message-actions">{result && !readOnly && <button className="text-button small" onClick={() => onAttach(result)}>Use in another node</button>}<button className="text-button small" onClick={() => setSide('history')}>Inspect run</button></div></>}</article>;
          })}
          {active && <div className="activity-card" role="status"><div className="row between"><span className="row gap"><LoaderCircle size={15} className="spin" /><strong>{active.status === 'queued' ? 'Waiting for a research slot' : 'Working'}</strong></span><button disabled={readOnly} className="small secondary" onClick={() => void onCancel(active.id)}><Square size={11} /> Stop</button></div><p>{active.events.at(-1)?.message || 'Preparing your request…'}</p></div>}
          {!active && runs[0] && ['failed', 'cancelled', 'interrupted'].includes(runs[0].status) && <div className="run-notice"><strong>Run {runs[0].status}</strong><p>{runs[0].error || 'The attempt stays in History.'}</p><button disabled={readOnly} className="small secondary" onClick={() => void onRetry(runs[0].id)}><RotateCcw size={12} /> Try again</button></div>}
        </div>}
    </div>}
  </aside>;
}

/** What a collapsed Group shows on its card: up to three exact saved versions from the blocks inside it. */
function GroupHighlights({node,detail,mutate,onOpenArtifact,onOpenNote,readOnly}:{node:CanvasNode;detail:ProjectDetail;mutate:Props['mutate'];onOpenArtifact:Props['onOpenArtifact'];onOpenNote:Props['onOpenNote'];readOnly:boolean}) {
  const members=groupMembers(detail.project.canvas,node.id), memberIds=new Set([node.id,...members.map(member=>member.id)]);
  const represented=new Set([node.artifactId,...members.map(member=>member.artifactId)].filter(Boolean));
  const candidates=detail.artifacts.filter(artifact=>(memberIds.has(artifact.nodeId)||represented.has(artifact.id))&&!['log','code','source','dataset'].includes(artifact.kind)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const chosen=node.groupHighlights??[];
  const choose=(artifact:Artifact,checked:boolean)=>{const next=checked?[...chosen,{nodeId:artifact.nodeId,artifactId:artifact.id,hash:artifact.hash}]:chosen.filter(item=>item.artifactId!==artifact.id);void mutate([{type:'updateNode',id:node.id,patch:{groupHighlights:next}}],'Choose exact Group highlights');};
  return <details className="detail-disclosure group-highlights"><summary>Choose collapsed highlights <small>{chosen.length} / 3 · exact saved versions</small></summary><div className="disclosure-body group-highlight-picker">{candidates.length?candidates.map(artifact=>{const checked=chosen.some(item=>item.artifactId===artifact.id);return <label key={artifact.id}><input type="checkbox" aria-label={`Highlight ${artifact.title}`} checked={checked} disabled={readOnly||!checked&&chosen.length>=3} onChange={event=>choose(artifact,event.target.checked)}/><span>{artifact.title}<small>{detail.project.canvas.nodes.find(item=>item.id===artifact.nodeId)?.title??'Saved block'} · {artifact.hash.slice(0,8)}</small></span><button className="text-button small" type="button" onClick={()=>onOpenArtifact(artifact)}>Inspect</button></label>;}):<p className="subtle">Contained blocks have no saved results yet.</p>}<p className="subtle">Selections retain their originating block and version. New results never replace them.</p>{detail.project.canvas.nodes.filter(item=>item.parentId===node.id).map(member=><button key={member.id} className="text-button" onClick={()=>onOpenNote(member.id)}>{member.title}</button>)}</div></details>;
}
function RunDetails({ run, detail, initialOpen, onAttach, onCancel, onRetry, readOnly }: { run: Run; detail: ProjectDetail; initialOpen: boolean; onAttach: Props['onAttach']; onCancel: Props['onCancel']; onRetry: Props['onRetry']; readOnly: boolean }) {
  const sources = evidenceForRun(run, detail);
  const results = detail.artifacts.filter(a => a.runId === run.id && a.kind === 'result');
  const active = ['running', 'queued'].includes(run.status);
  return <details className="run-card" open={initialOpen || undefined}><summary><span className={`status-dot ${run.status}`} /><span><strong>{run.status.charAt(0).toUpperCase() + run.status.slice(1)}</strong><small>{date(run.createdAt)}</small></span><span className="run-mode">{run.useSearch ? <Globe2 size={13} /> : <MessageSquare size={13} />}</span><ChevronDown size={14} /></summary><div className="run-body">
    <p className="run-request">{run.request}</p><div className="row between"><span className="tag">{run.provider} · {run.model || 'Model unavailable'}</span>{active ? <button disabled={readOnly} className="small secondary" onClick={() => void onCancel(run.id)}><Square size={11} /> Stop</button> : ['failed', 'cancelled', 'interrupted'].includes(run.status) ? <button disabled={readOnly} className="small secondary" onClick={() => void onRetry(run.id)}><RotateCcw size={12} /> Retry</button> : null}</div>
    {run.retryOf && <p className="subtle">New attempt of run {run.retryOf.slice(0, 8)}. The earlier attempt is preserved.</p>}{run.error && <div className="inline-error">{run.error}</div>}
    {results.map(result => <details key={result.id} className="run-section" open><summary>Result</summary><RichText text={result.content} sources={sources} scope={run.id} /><button disabled={readOnly} className="small secondary" onClick={() => onAttach(result)}><ArrowRight size={12} /> Use in another node</button><Evidence sources={sources} onAttach={readOnly ? undefined : onAttach} scope={run.id} /></details>)}
    <details className="run-section"><summary>Captured request & inputs</summary><div className="capture-meta">Canvas revision {run.projectRevision} · node “{run.node.title}”</div>{run.inputs.length ? run.inputs.map(input => <details key={input.id} className="captured-input"><summary>{input.artifact.title}</summary><blockquote>{input.excerpt || input.artifact.content}</blockquote><span className="subtle">Artifact {input.artifact.id} · original run {input.artifact.runId}</span></details>) : <p className="subtle">No external artifacts selected.</p>}<h4>Model-visible messages</h4>{run.messages.map((message, index) => <details className="captured-message" key={index}><summary>{message.role}</summary><pre>{message.content}</pre></details>)}{!run.messages.length && <p className="subtle">No model request was assembled.</p>}</details>
    <details className="run-section"><summary>Activity & evidence mapping</summary><ol className="event-list">{run.events.map((event, index) => <li key={index}><time>{time(event.at)}</time><span>{event.message}</span>{event.data !== undefined && <details><summary>Recorded detail</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>}</li>)}</ol></details>
    <details className="run-section"><summary>Configuration & usage</summary><dl className="metadata"><dt>Provider</dt><dd>{run.provider}</dd><dt>Model</dt><dd>{run.model}</dd><dt>Model version</dt><dd>{run.modelVersion || 'Unavailable from provider'}</dd><dt>Started</dt><dd>{run.startedAt ? date(run.startedAt) : 'Not started'}</dd><dt>Ended</dt><dd>{run.endedAt ? date(run.endedAt) : 'Not ended'}</dd></dl><h4>Captured configuration</h4><pre>{JSON.stringify(run.configuration, null, 2)}</pre><h4>Available tool schemas</h4><pre>{JSON.stringify(run.tools, null, 2)}</pre><h4>Provider-reported usage</h4><pre>{run.usage ? JSON.stringify(run.usage, null, 2) : 'Unavailable'}</pre><h4>Cost estimate & basis</h4><pre>{run.cost ? JSON.stringify(run.cost, null, 2) : 'Unavailable'}</pre><p className="subtle">Observable requests and activity are recorded. Hosted model versions and repeated outputs are not guaranteed.</p></details>
  </div></details>;
}

function evidenceForRun(run: Run, detail: ProjectDetail): Artifact[] {
  return [...detail.artifacts.filter(a => a.runId === run.id && a.kind === 'source'), ...run.inputs.map((input, index) => ({ ...input.artifact, content: input.excerpt || input.artifact.content, sourceId: `I${index + 1}`, locator: `Selected input · artifact ${input.artifact.id.slice(0, 8)} · source run ${input.artifact.runId.slice(0, 8)}` }))];
}
