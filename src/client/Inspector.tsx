import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, Check, ChevronDown, Clock3, FileText, Globe2, History, LoaderCircle, MessageSquare, Pencil, Plus, RotateCcw, Square, X } from 'lucide-react';
import type { Artifact, CanvasNode, Mutation, ProjectDetail, Run } from '../shared/types';
import { kindName, textLabel } from '../shared/vocabulary';
import { useDraft, readSaved, saveLocal } from './persistence';
import { ArtifactContent } from './Experiment';
import { date, Evidence, RichText, time } from './Content';
import { ModelSettings, type ModelDisplay } from './ModelSettings';
import './detail-polish.css';
import { NotionBlock } from './NotionView';
import { rowBlockOperations } from '../shared/notion-rows';
import './note-view.css';
import { groupMembers, isGroup } from '../shared/groups';
import { primaryArtifact } from '../shared/blocks';

type Props = {
  node: CanvasNode; detail: ProjectDetail;
  mutate: (operations: Mutation[], label: string) => Promise<boolean>;
  onRun: (nodeId: string, request: string, useSearch: boolean) => Promise<boolean>;
  onCancel: (runId: string) => Promise<boolean>; onRetry: (runId: string) => Promise<boolean>;
  onAttach: (artifact?: Artifact, destinationId?: string) => void;
  onOpenArtifact: (artifact: Artifact) => void; onOpenNote: (nodeId: string) => void;
  readOnly?: boolean;
  /** Why the view is read only. */
  readOnlyNote?: string;
};

export function Inspector({ node, detail, mutate, onRun, onCancel, onRetry, onAttach, onOpenArtifact, onOpenNote, readOnly = false, readOnlyNote = 'Historical canvas · return to the current canvas to make changes.' }: Props) {
  const [side, setSide] = useState<'conversation' | 'history'>(() => ['runs', 'experiment'].includes(readSaved<string>(`node-tab:${node.id}`, 'work')) ? 'history' : 'conversation');
  useEffect(() => saveLocal(`node-tab:${node.id}`, side === 'history' ? 'runs' : 'work'), [node.id, side]);
  const [title, setTitle] = useDraft(`node-title:${node.id}`, node.title, !readOnly); const [description, setDescription] = useDraft(`node-description:${node.id}`, node.description, !readOnly);
  const [request, setRequest] = useDraft(`node-request:${node.id}`); const [useSearch, setUseSearch] = useState(false); const [submitting, setSubmitting] = useState(false);
  const [reasoningModel, setReasoningModel] = useState<ModelDisplay | null>(null);
  const [editing, setEditing] = useState(false);
  // The conversation stays out of the way until asked for.
  const [chatOpen, setChatOpen] = useState(false);
  const dirty = title !== node.title || description !== node.description;
  const priorNode = useRef(node);
  useEffect(() => { if (title === priorNode.current.title) setTitle(node.title); if (description === priorNode.current.description) setDescription(node.description); priorNode.current = node; }, [node]);
  const runs = detail.runs.filter(r => r.nodeId === node.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = runs.find(run => run.configuration.kind !== 'local-experiment' && ['running', 'queued'].includes(run.status));
  const messages = detail.messages.filter(message => message.nodeId === node.id);
  const primary = isGroup(node) ? undefined : primaryArtifact(node, detail), children = detail.project.canvas.nodes.filter(item => item.parentId === node.id);
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => { if (side === 'conversation') thread.current?.scrollTo({ top: thread.current.scrollHeight }); }, [side, messages.length, active?.events.length]);
  const submit = async () => {
    if (!request.trim() || submitting || active || readOnly) return;
    setSubmitting(true); const success = await onRun(node.id, request.trim(), useSearch); setSubmitting(false); if (success) setRequest('');
  };
  return <aside className={`inspector note-view${chatOpen?'':' chat-closed'}`} aria-label="Node work tools">
    <div className="note-main">
      {!chatOpen&&<button className="note-chat-toggle" aria-expanded={false} aria-controls={`note-side-${node.id}`} onClick={()=>setChatOpen(true)}><MessageSquare size={13}/> Conversation{active?<LoaderCircle size={12} className="spin"/>:messages.length>0&&<span>{messages.length}</span>}</button>}
      <label className="sr-only" htmlFor={`note-title-${node.id}`}>Note title</label><input id={`note-title-${node.id}`} className="note-title" aria-label="Node title" data-testid="node-title" readOnly={readOnly} value={title} onChange={event=>setTitle(event.target.value)} placeholder="Untitled node" maxLength={200}/>
      {readOnly&&<div className="history-inspector-note">{readOnlyNote}</div>}
      {node.notion&&<section className="note-content"><NotionBlock projectId={detail.project.id} nodeId={node.id} view={node.notion} full onRows={readOnly?undefined:async table=>{const {operations,added,skipped,beyond}=rowBlockOperations(detail.project.canvas,node,table);if(operations.length&&!await mutate(operations,`One block per row of ${node.title}`.slice(0,80)))return null;return {added:operations.length?added:0,skipped,beyond};}}/>{node.notion.filter&&<p className="subtle">Rows where {node.notion.filter}</p>}</section>}
      {editing
        ? <textarea className="note-description-input" aria-label="Node description" value={description} readOnly={readOnly} onChange={event=>setDescription(event.target.value)} placeholder="What would you like to explore here?" rows={6} autoFocus/>
        : description ? <div className="note-description"><RichText text={description}/></div> : null}
      {!readOnly&&(dirty
        ? <div className="row gap note-edit-actions"><button className="small primary" data-testid="save-node" onClick={async()=>{if(await mutate([{type:'updateNode',id:node.id,patch:{title:title.trim()||'Untitled node',description}}],'Edit node'))setEditing(false);}}><Check size={13}/> Save changes</button><button className="small text-button" onClick={()=>{setTitle(node.title);setDescription(node.description);setEditing(false);}}>Discard</button></div>
        : <button className="text-button small note-edit-toggle" aria-expanded={editing} onClick={()=>setEditing(!editing)}>{editing?'Done':description?<><Pencil size={12}/> Edit text</>:<><Plus size={12}/> Add a description</>}</button>)}
      {primary&&<section className="note-content"><div className="note-content-heading"><h3>{primary.title}</h3><button className="text-button small" onClick={()=>onOpenArtifact(primary)}>Open <ArrowRight size={12}/></button></div>{['plot','dataset','table','metric','code','log'].includes(primary.kind)?<ArtifactContent artifact={primary}/>:<RichText text={primary.content}/>}</section>}
      {isGroup(node)&&<section className="note-content"><h3>Blocks in this Group</h3>{children.map(child=><button className="overview-artifact" key={child.id} onClick={()=>onOpenNote(child.id)}><FileText size={16}/><span><strong>{child.title}</strong><small>{kindName(child)}{textLabel(child)?` · ${textLabel(child)}`:''}</small></span><ArrowRight size={14}/></button>)}</section>}
      {isGroup(node)&&<GroupHighlights node={node} detail={detail} mutate={mutate} onOpenArtifact={onOpenArtifact} onOpenNote={onOpenNote} readOnly={readOnly}/>}
      {!description&&!primary&&!children.length&&!editing&&!node.notion&&<div className="note-empty"><FileText size={22} strokeWidth={1.3}/><p>Nothing here yet. Ask in the conversation to develop this {isGroup(node)?'group':'note'}.</p></div>}
    </div>
    {chatOpen&&<div className="note-side" id={`note-side-${node.id}`}>
      <div className="note-side-heading"><strong>{side==='history'?'History':'Conversation'}</strong><span className="note-side-spacer"/><button className={`note-history-toggle${side==='history'?' active':''}`} aria-pressed={side==='history'} aria-label={side==='history'?'Close history':undefined} onClick={()=>setSide(side==='history'?'conversation':'history')}>{side==='history'?<><X size={13}/> Close</>:<><History size={13}/> History{runs.length>0&&<span>{runs.length}</span>}</>}</button><button className="icon-button" aria-label="Hide conversation" title="Hide conversation" onClick={()=>setChatOpen(false)}><X size={15}/></button></div>
      {side==='history'
        ? <div className="note-side-scroll runs-section">{!runs.length&&<div className="empty-small"><Clock3 size={22} strokeWidth={1.2}/><p>Each run of this node will appear here.</p></div>}{runs.map((run,index)=><RunDetails key={run.id} run={run} detail={detail} initialOpen={index===0} onAttach={onAttach} onCancel={onCancel} onRetry={onRetry} readOnly={readOnly}/>)}</div>
        : <div ref={thread} className="note-side-scroll conversation" data-testid="node-conversation">
          {!messages.length&&<p className="note-side-welcome">Ask about this {isGroup(node)?'group':'note'}: develop it, check a source, or search for more. Only this conversation and the inputs it uses are sent.</p>}
          {messages.map(message => {
            const run = message.runId ? detail.runs.find(r => r.id === message.runId) : undefined;
            const sources = run ? evidenceForRun(run, detail) : [];
            const result = run ? detail.artifacts.find(a => a.runId === run.id && a.kind === 'result') : undefined;
            return <article key={message.id} className={`chat-message ${message.role}`}><div className="message-meta"><span>{message.role === 'user' ? 'You' : message.role === 'system' ? 'Workspace update' : 'ros.ai'}</span><time>{time(message.createdAt)}</time></div><RichText text={message.content} sources={sources} scope={run?.id || message.id} />{message.role === 'assistant' && run && <><Evidence sources={sources} onAttach={readOnly ? undefined : onAttach} scope={run.id} /><div className="note-message-actions">{result && !readOnly && <button className="text-button small" onClick={() => onAttach(result)}>Use in another node</button>}<button className="text-button small" onClick={() => setSide('history')}>Inspect run</button></div></>}</article>;
          })}
          {active && <div className="activity-card" role="status"><div className="row between"><span className="row gap"><LoaderCircle size={15} className="spin" /><strong>{active.status === 'queued' ? 'Waiting for a research slot' : 'Working'}</strong></span><button disabled={readOnly} className="small secondary" onClick={() => void onCancel(active.id)}><Square size={11} /> Stop</button></div><p>{active.events.at(-1)?.message || 'Preparing your request…'}</p></div>}
          {!active && runs[0] && ['failed', 'cancelled', 'interrupted'].includes(runs[0].status) && <div className="run-notice"><strong>Run {runs[0].status}</strong><p>{runs[0].error || 'The attempt stays in History.'}</p><button disabled={readOnly} className="small secondary" onClick={() => void onRetry(runs[0].id)}><RotateCcw size={12} /> Try again</button></div>}
        </div>}
      {!readOnly && <div className="node-composer note-composer"><label className="sr-only" htmlFor="node-request">Message this node</label><textarea id="node-request" data-testid="node-request" placeholder="Ask about this note…" value={request} onChange={event => setRequest(event.target.value)} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} /><div className="note-composer-row"><ModelSettings detail={detail} nodeId={node.id} readOnly={readOnly} compact onSelectionChange={setReasoningModel}/><label className={`search-toggle ${useSearch ? 'enabled' : ''}`} title="Also search the web with Tavily"><input type="checkbox" checked={useSearch} onChange={event => setUseSearch(event.target.checked)} /><Globe2 size={13} /> Web</label><button className="send-button" data-testid="run-node" aria-label="Run node research" title="Send (⌘ Enter)" disabled={!request.trim() || submitting || Boolean(active)} onClick={() => void submit()}>{submitting ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={17} />}</button></div>{reasoningModel && !reasoningModel.configured && <div className="provider-note">Add a key for {reasoningModel.provider} on Model to send.</div>}</div>}
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
