import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUp, Check, ChevronDown, Clock3, FileText, GitBranch, Globe2, History, Layers3, LoaderCircle, MessageSquare, Play, Plus, RotateCcw, Square, Trash2, X } from 'lucide-react';
import type { Artifact, CanvasNode, ConnectionStatus, Mutation, ProjectDetail, Run } from '../shared/types';
import { useDraft, readSaved, saveLocal } from './persistence';
import { ArtifactContent, Experiment } from './Experiment';
import { ActionPolicy, modeLabel } from './ResearchControls';
import type { ResearchPolicy } from '../shared/research';
import { date, Evidence, RichText, time } from './Content';
import { ModelSettings, type ModelDisplay } from './ModelSettings';
import './detail-polish.css';
import { groupMembers, isGroup, ungroupOperations } from '../shared/groups';
import { primaryArtifact } from '../shared/blocks';
import { BlockPreview } from './BlockPreview';

type Props = {
  node: CanvasNode; detail: ProjectDetail; connections: ConnectionStatus[]; width: number;
  onResize: (event: React.PointerEvent) => void; onClose: () => void;
  mutate: (operations: Mutation[], label: string) => Promise<boolean>;
  onRun: (nodeId: string, request: string, useSearch: boolean) => Promise<boolean>;
  onCancel: (runId: string) => Promise<boolean>; onRetry: (runId: string) => Promise<boolean>;
  onAttach: (artifact?: Artifact, destinationId?: string) => void;
  onRefresh: () => Promise<unknown>;
  onOpenArtifact: (artifact: Artifact) => void; onOpenNote: (nodeId: string) => void;
  onResearch: () => void; policy: ResearchPolicy | null;
  onRemoveInput: (inputId: string) => Promise<boolean>; readOnly?: boolean;
};

export function Inspector({ node, detail, connections, width, onResize, onClose, mutate, onRun, onCancel, onRetry, onAttach, onRemoveInput, onRefresh, onOpenArtifact, onOpenNote, onResearch, policy, readOnly = false }: Props) {
  const [tab, setTab] = useState<'overview' | 'results' | 'experiment' | 'work' | 'inputs' | 'runs'>(() => { const saved = readSaved<'overview' | 'results' | 'experiment' | 'work' | 'inputs' | 'runs'>(`node-tab:${node.id}`, 'overview'); return node.kind === 'topic' && saved === 'experiment' ? 'overview' : saved; });
  useEffect(() => saveLocal(`node-tab:${node.id}`, tab), [node.id, tab]);
  const [title, setTitle] = useDraft(`node-title:${node.id}`, node.title); const [description, setDescription] = useDraft(`node-description:${node.id}`, node.description);
  const [request, setRequest] = useDraft(`node-request:${node.id}`); const [useSearch, setUseSearch] = useState(false); const [submitting, setSubmitting] = useState(false);
  const [reasoningModel, setReasoningModel] = useState<ModelDisplay | null>(null);
  const [editing, setEditing] = useState(false); const [target, setTarget] = useState(''); const [relationLabel, setRelationLabel] = useState('Related');
  const dirty = title !== node.title || description !== node.description;
  const kindChangeLocked = isGroup(node) && (detail.project.canvas.nodes.some(child=>child.parentId===node.id) || Boolean(node.groupHighlights?.length));
  const priorNode = useRef(node);
  useEffect(() => { if (title === priorNode.current.title) setTitle(node.title); if (description === priorNode.current.description) setDescription(node.description); priorNode.current = node; }, [node]);
  const runs = detail.runs.filter(r => r.nodeId === node.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = runs.find(run => run.configuration.kind !== 'local-experiment' && ['running', 'queued'].includes(run.status));
  const inputs = detail.inputs.filter(input => input.nodeId === node.id);
  const messages = detail.messages.filter(message => message.nodeId === node.id);
  const relationships = detail.project.canvas.connections.filter(c => c.source === node.id || c.target === node.id);
  const submit = async () => {
    if (!request.trim() || submitting || active || readOnly) return;
    setSubmitting(true); const success = await onRun(node.id, request.trim(), useSearch); setSubmitting(false); if (success) setRequest('');
  };
  return <aside className="inspector detail-polish note-detail" aria-label="Node work tools">
    <div className="node-heading">
      <label className="sr-only" htmlFor={`note-title-${node.id}`}>Note title</label><input id={`note-title-${node.id}`} aria-label="Node title" data-testid="node-title" readOnly={readOnly} value={title} onChange={event=>setTitle(event.target.value)} placeholder="Untitled node" maxLength={200}/>
      <div className="note-heading-actions"><button className="description-toggle" aria-expanded={editing} onClick={()=>setEditing(!editing)}>{readOnly?'Read description':description?'Edit description':'Add a description'}<ChevronDown size={13} className={editing?'rotated':''}/></button>{!readOnly&&!isGroup(node)&&<button className="primary small" onClick={onResearch}><Play size={13}/> Research with ros.ai</button>}</div>
      {editing&&<textarea aria-label="Node description" value={description} readOnly={readOnly} onChange={event=>setDescription(event.target.value)} placeholder="What would you like to explore here?" rows={3}/>}
      {dirty&&!readOnly&&<div className="row gap note-edit-actions"><button className="small primary" data-testid="save-node" onClick={async()=>{if(await mutate([{type:'updateNode',id:node.id,patch:{title:title.trim()||'Untitled node',description}}],'Edit node'))setEditing(false);}}><Check size={13}/> Save changes</button><button className="small text-button" onClick={()=>{setTitle(node.title);setDescription(node.description);}}>Discard</button></div>}
      <GroupTools node={node} detail={detail} mutate={mutate} onOpenArtifact={onOpenArtifact} onOpenNote={onOpenNote} readOnly={readOnly}/><ModelSettings detail={detail} nodeId={node.id} readOnly={readOnly} onSelectionChange={setReasoningModel}/>
      <details className="note-settings detail-disclosure"><summary><span>Note settings</span><small>{node.kind==='group'?'Group':node.kind==='activity'?'Action':node.kind==='topic'?'Knowledge':'Note'} · {modeLabel(policy?.overrides[node.id]||policy?.mode||'ask')}</small></summary><div className="disclosure-body"><div className="node-kind-row"><label>Kind<select aria-label="Node kind" value={node.kind||'unspecified'} disabled={readOnly||kindChangeLocked} onChange={event=>void mutate([{type:'updateNode',id:node.id,patch:{kind:event.target.value as CanvasNode['kind']}}],'Change node kind')}><option value="unspecified">Unspecified</option><option value="topic">Knowledge</option><option value="activity">Action</option><option value="group">Group</option></select></label><span className="subtle">{kindChangeLocked?'Use Ungroup to change the kind.':node.parentId?'Inside a group':'At project level'}</span></div>{!readOnly&&<ActionPolicy nodeId={node.id} policy={policy} onRefresh={onRefresh}/>}</div></details>
    </div>
    {readOnly&&<div className="history-inspector-note">Historical canvas · inspect saved work below. Return to the current canvas to make changes.</div>}
    <nav className="inspector-tabs" aria-label="Node sections"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><FileText size={14} /> {isGroup(node)?'Overview':'Content'}</button><button className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}><Layers3 size={14}/> Results</button><button className={tab === 'experiment' ? 'active' : ''} onClick={() => setTab('experiment')}><Play size={14} /> Experiments</button><button className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}><MessageSquare size={14} /> Conversation</button><button className={tab === 'inputs' ? 'active' : ''} onClick={() => setTab('inputs')}><ArrowDownToLine size={14} /> Sources{inputs.length > 0 && <span>{inputs.length}</span>}</button><button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}><History size={14} /> History{runs.length > 0 && <span>{runs.length}</span>}</button></nav>
    {tab === 'overview' && <NoteOverview node={node} detail={detail} onArtifact={onOpenArtifact} onNote={onOpenNote}/> }
    {tab === 'results' && <SavedResults node={node} detail={detail} onArtifact={onOpenArtifact}/>}
    {tab === 'experiment' && <Experiment key={node.id} node={node} detail={detail} onRefresh={onRefresh} readOnly={readOnly} policy={policy} model={reasoningModel} />}
    {tab === 'work' && <>
      <div className="inspector-scroll conversation" data-testid="node-conversation">
        {!messages.length && <div className="node-welcome"><div className="small-symbol"><MessageSquare size={22} strokeWidth={1.3} /></div><h3>A space for this question.</h3><p>Start a conversation, develop a thought, or ask for research. Work here stays with this node.</p><div className="scope-note"><Layers3 size={14} /><span>Only this conversation and your selected inputs are included.</span></div></div>}
        {messages.map(message => {
          const run = message.runId ? detail.runs.find(r => r.id === message.runId) : undefined;
          const sources = run ? evidenceForRun(run, detail) : [];
          const result = run ? detail.artifacts.find(a => a.runId === run.id && a.kind === 'result') : undefined;
          return <article key={message.id} className={`chat-message ${message.role}`}><div className="message-meta"><span>{message.role === 'user' ? 'You' : message.role === 'system' ? 'Workspace update' : 'ros.ai'}</span><time>{time(message.createdAt)}</time></div><RichText text={message.content} sources={sources} scope={run?.id || message.id} />{message.role === 'assistant' && run && <><Evidence sources={sources} onAttach={readOnly ? undefined : onAttach} scope={run.id} />{result && !readOnly && <button className="small secondary reuse-button" onClick={() => onAttach(result)}><ArrowRight size={13} /> Use result in another node</button>}<button className="text-button small run-reference" onClick={() => setTab('runs')}>Inspect this run <ArrowRight size={12} /></button></>}</article>;
        })}
        {active && <div className="activity-card" role="status"><div className="row between"><span className="row gap"><LoaderCircle size={15} className="spin" /><strong>{active.status === 'queued' ? 'Waiting for a research slot' : 'Research in progress'}</strong></span><button disabled={readOnly} className="small secondary" onClick={() => void onCancel(active.id)}><Square size={11} /> Stop</button></div><p>{active.events.at(-1)?.message || 'Preparing your request…'}</p><span className="subtle">This node is working independently.</span></div>}
        {!active && runs[0] && ['failed', 'cancelled', 'interrupted'].includes(runs[0].status) && <div className="run-notice"><strong>Run {runs[0].status}</strong><p>{runs[0].error || 'The attempt is retained in run history. You can start a new attempt when ready.'}</p><button disabled={readOnly} className="small secondary" onClick={() => void onRetry(runs[0].id)}><RotateCcw size={12} /> Retry as a new attempt</button></div>}
      </div>
      {!readOnly && <div className="node-composer"><label className="sr-only" htmlFor="node-request">Message this node</label><textarea id="node-request" data-testid="node-request" placeholder="What would you like to explore?" value={request} onChange={event => setRequest(event.target.value)} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} /><div className="row between"><label className={`search-toggle ${useSearch ? 'enabled' : ''}`}><input type="checkbox" checked={useSearch} onChange={event => setUseSearch(event.target.checked)} /><Globe2 size={13} /> Search with Tavily</label><button className="send-button" data-testid="run-node" aria-label="Run node research" title="Run research (⌘ Enter)" disabled={!request.trim() || submitting || Boolean(active)} onClick={() => void submit()}>{submitting ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={17} />}</button></div><div className="provider-note">{reasoningModel ? `${reasoningModel.provider} · ${reasoningModel.model}` : 'Selected reasoning model'}{useSearch ? ' · search query to Tavily' : ' · model only'}{reasoningModel && !reasoningModel.configured ? ' · configure connection to run' : ''}</div></div>}
    </>}
    {tab === 'inputs' && <div className="inspector-scroll inputs-section"><div className="section-heading"><h3>Selected inputs</h3><button disabled={readOnly} className="small secondary" onClick={() => onAttach(undefined, node.id)}><Plus size={13} /> Attach</button></div><p className="subtle">Specific saved results or excerpts that this node may use. A relationship alone does not share any content.</p>
      {!inputs.length && <div className="empty-small"><ArrowDownToLine size={23} strokeWidth={1.2} /><p>No inputs selected.<br />Attach a result from another node when it helps.</p></div>}
      {inputs.map(input => {
        const artifact = detail.artifacts.find(a => a.id === input.artifactId);
        const sourceNode = detail.project.canvas.nodes.find(n => n.id === artifact?.nodeId);
        const newer = artifact && detail.artifacts.some(a => a.nodeId === artifact.nodeId && a.kind === artifact.kind && a.createdAt > artifact.createdAt);
        return <article className="input-card" key={input.id}><div className="row between"><strong>{artifact?.title || 'Saved artifact'}</strong><button className="icon-button danger" aria-label={`Remove input ${artifact?.title || ''}`} disabled={readOnly} onClick={() => void onRemoveInput(input.id)}><X size={13} /></button></div><span className="subtle">From {sourceNode?.title || 'removed node'} · {artifact ? date(artifact.createdAt) : ''}</span>{newer && <span className="newer-hint">A newer source result is available. This selection is unchanged.</span>}<details><summary>Inspect saved {input.excerpt ? 'excerpt' : 'content'}</summary><blockquote>{input.excerpt || artifact?.content}</blockquote><div className="subtle">Artifact {artifact?.id.slice(0, 8)} · run {artifact?.runId.slice(0, 8)}</div></details></article>;
      })}
      <div className="section-heading relationships-heading"><h3>Relationships</h3><GitBranch size={15} /></div><p className="subtle">Connect ideas without passing results or starting work.</p>
      {relationships.map(connection => <div className="relationship-row" key={connection.id}><GitBranch size={14} /><div><strong>{detail.project.canvas.nodes.find(n => n.id === (connection.source === node.id ? connection.target : connection.source))?.title || 'Node'}</strong><span className="subtle">{connection.label || 'Related'}</span></div><button className="icon-button danger" aria-label="Remove relationship" disabled={readOnly} onClick={() => void mutate([{ type: 'removeConnection', id: connection.id }], 'Remove relationship')}><X size={13} /></button></div>)}
      {!readOnly && <details className="detail-disclosure"><summary>Add a relationship</summary><div className="relationship-form"><select aria-label="Node to connect" value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose another node…</option>{detail.project.canvas.nodes.filter(n => n.id !== node.id && (n.parentId || null) === (node.parentId || null)).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select><div className="row gap"><input aria-label="Relationship label" value={relationLabel} onChange={event => setRelationLabel(event.target.value)} placeholder="Relationship label" /><button className="small secondary" disabled={!target} onClick={async () => { if (await mutate([{ type: 'addConnection', connection: { id: crypto.randomUUID(), source: node.id, target, label: relationLabel.trim() || 'Related' } }], 'Connect nodes')) setTarget(''); }}>Connect</button></div></div></details>}
    </div>}
    {tab === 'runs' && <div className="inspector-scroll runs-section"><div className="section-heading"><h3>Run history</h3><span className="subtle">{runs.length} attempt{runs.length === 1 ? '' : 's'}</span></div><p className="subtle">Each attempt keeps its own request, selected input versions, provider activity, and results.</p>{!runs.length && <div className="empty-small"><Clock3 size={24} strokeWidth={1.2} /><p>Your first run will appear here.</p></div>}{runs.map((run, index) => <RunDetails key={run.id} run={run} detail={detail} initialOpen={index === 0} onAttach={onAttach} onCancel={onCancel} onRetry={onRetry} readOnly={readOnly} />)}</div>}
    <footer className="inspector-footer"><span><span className="status-dot" /> Saved locally</span><button disabled={readOnly} className="text-button danger" data-testid="remove-node" onClick={async () => { if (await mutate([{ type: 'removeNode', id: node.id }], 'Remove node')) onClose(); }}><Trash2 size={12} /> Remove node</button></footer>
  </aside>;
}

function GroupTools({node,detail,mutate,onOpenArtifact,onOpenNote,readOnly}:{node:CanvasNode;detail:ProjectDetail;mutate:Props['mutate'];onOpenArtifact:Props['onOpenArtifact'];onOpenNote:Props['onOpenNote'];readOnly:boolean}) {
  const members=groupMembers(detail.project.canvas,node.id), excluded=new Set([node.id,...members.map(member=>member.id)]);
  const destinations=detail.project.canvas.nodes.filter(item=>isGroup(item)&&!excluded.has(item.id));
  const group=isGroup(node), memberIds=new Set([node.id,...members.map(member=>member.id)]);
  const represented=new Set([node.artifactId,...members.map(member=>member.artifactId)].filter(Boolean));
  const candidates=detail.artifacts.filter(artifact=>(memberIds.has(artifact.nodeId)||represented.has(artifact.id))&&!['log','code','source','dataset'].includes(artifact.kind)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const chosen=node.groupHighlights??[];
  const choose=(artifact:Artifact,checked:boolean)=>{const next=checked?[...chosen,{nodeId:artifact.nodeId,artifactId:artifact.id,hash:artifact.hash}]:chosen.filter(item=>item.artifactId!==artifact.id);void mutate([{type:'updateNode',id:node.id,patch:{groupHighlights:next}}],'Choose exact Group highlights');};
  return <><div className="group-organize"><label>Move to<select aria-label={`Move ${node.title} to group`} value={node.parentId??''} disabled={readOnly} onChange={event=>void mutate([{type:'updateNode',id:node.id,patch:{parentId:event.target.value||null,x:0,y:0}}],'Move block between groups')}><option value="">Canvas root</option>{destinations.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{group&&<button className="secondary small" disabled={readOnly} onClick={()=>void mutate(ungroupOperations(detail.project.canvas,node),'Ungroup; retain overview and research identity')}>Ungroup</button>}</div>
    {group&&<details className="detail-disclosure"><summary>Choose collapsed highlights <small>{chosen.length} / 3 · exact saved versions</small></summary><div className="disclosure-body group-highlight-picker">{candidates.length?candidates.map(artifact=>{const checked=chosen.some(item=>item.artifactId===artifact.id);return <label key={artifact.id}><input type="checkbox" aria-label={`Highlight ${artifact.title}`} checked={checked} disabled={readOnly||!checked&&chosen.length>=3} onChange={event=>choose(artifact,event.target.checked)}/><span>{artifact.title}<small>{detail.project.canvas.nodes.find(item=>item.id===artifact.nodeId)?.title??'Saved block'} · {artifact.hash.slice(0,8)}</small></span><button className="text-button small" type="button" onClick={()=>onOpenArtifact(artifact)}>Inspect</button></label>;}):<p className="subtle">Contained blocks have no saved results yet.</p>}<p className="subtle">Selections retain their originating block and version. New results never replace them.</p>{detail.project.canvas.nodes.filter(item=>item.parentId===node.id).map(member=><button key={member.id} className="text-button" onClick={()=>onOpenNote(member.id)}>{member.title}</button>)}</div></details>}
  </>;
}
function SavedResults({node,detail,onArtifact}:{node:CanvasNode;detail:ProjectDetail;onArtifact:(artifact:Artifact)=>void}) {
  const ids=new Set([node.id,...(isGroup(node)?groupMembers(detail.project.canvas,node.id).map(member=>member.id):[])]);
  const artifacts=detail.artifacts.filter(item=>ids.has(item.nodeId)||item.id===node.artifactId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return <div className="inspector-scroll note-overview"><h3>All saved results and captured material</h3><p className="subtle">Attempts, failures and earlier successful versions stay separate in History.</p><div className="overview-artifacts">{artifacts.map(item=><button className="overview-artifact" key={item.id} onClick={()=>onArtifact(item)}><FileText size={16}/><span><strong>{item.title}</strong><small>{item.kind} · {item.hash.slice(0,8)} · {detail.runs.find(run=>run.id===item.runId)?.status??'Saved'}{isGroup(node)?` · ${detail.project.canvas.nodes.find(member=>member.id===item.nodeId)?.title??'Saved block'}`:''}</small></span><ArrowRight size={14}/></button>)}</div>{!artifacts.length&&<p>No saved results yet. Open Conversation or Experiments to begin work.</p>}</div>;
}
function NoteOverview({node,detail,onArtifact,onNote}:{node:CanvasNode;detail:ProjectDetail;onArtifact:(artifact:Artifact)=>void;onNote:(id:string)=>void}) {
  const primary=primaryArtifact(node,detail),children=detail.project.canvas.nodes.filter(item=>item.parentId===node.id);
  return <div className="inspector-scroll note-overview">
    {node.description&&<section><h3>{isGroup(node)?'Group overview':'Question and notes'}</h3><RichText text={node.description}/></section>}
    {!isGroup(node)&&primary&&<section className="overview-finding"><div className="section-heading"><h3>{primary.title}</h3><button className="small secondary" onClick={()=>onArtifact(primary)}>Open saved content</button></div><span className="subtle">Exact version {primary.hash.slice(0,8)} · {date(primary.createdAt)}</span><BlockPreview artifact={primary}/></section>}
    {isGroup(node)&&<section><h3>Blocks in this Group</h3>{children.map(child=><button className="overview-artifact" key={child.id} onClick={()=>onNote(child.id)}><FileText size={16}/><span><strong>{child.title}</strong><small>{isGroup(child)?'Group':child.blockType??(child.kind==='activity'?'Action':'Note')}</small></span><ArrowRight size={14}/></button>)}</section>}
    {!node.description&&!primary&&!children.length&&<div className="empty-small"><FileText size={24}/><p>Add a question or description to develop this block.</p></div>}
  </div>;
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
