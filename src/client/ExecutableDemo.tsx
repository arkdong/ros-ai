import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, ChevronDown, LoaderCircle, Play, Square, X } from 'lucide-react';
import type { Artifact, ProjectDetail } from '../shared/types';
import type { TutorialSession } from '../shared/tutorial';
import { api, post } from './api';
import { textPreview } from '../shared/presentation';
import './executable-demo.css';

export function ExecutableDemo({ session, detail, onSession, onRefresh, onStage, onNote, onArtifact, onClose }: {
  session: TutorialSession; detail: ProjectDetail; onSession: (session: TutorialSession) => void;
  onRefresh: () => Promise<unknown>; onStage: (id: string) => void; onNote: (id: string) => void;
  onArtifact: (artifact: Artifact) => void; onClose: () => void;
}) {
  const [view, setView] = useState(session.step), [busy, setBusy] = useState(false), [error, setError] = useState(''), [minimized, setMinimized] = useState(false);
  const shownStage = useRef<string | null>(null);
  const stage = session.stages[view], run = session.preview?.run;
  const summaryParagraph = stage.summary.split(/\n\s*\n/).find(paragraph => !/^#{1,6}\s/.test(paragraph.trim())) || stage.summary;
  const summary = textPreview(summaryParagraph.replace(/\*\*/g, '').replace(/^#{1,6}\s+/gm, ''), 420).text;
  const running = Boolean(run && ['queued', 'running'].includes(run.status) && session.preview?.approval.status !== 'pending');
  const pending = session.preview?.approval.status === 'pending';
  const path = `/api/projects/${session.projectId}/demo-session`;
  useEffect(() => { setView(session.step); }, [session.step]);
  useEffect(() => { const id = session.stages[session.step].nodeId; if (id && shownStage.current !== id && detail.project.canvas.nodes.some(node => node.id === id)) { shownStage.current = id; onStage(id); } }, [session.step, session.stages, detail.project.canvas.nodes, onStage]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { void api<TutorialSession>(path).then(async next => { onSession(next); if (!['queued','running'].includes(next.preview?.run.status || '')) await onRefresh(); }).catch(cause => setError(cause.message)); }, 1500);
    return () => window.clearInterval(timer);
  }, [running, path, onSession, onRefresh]);
  const act = async (work: () => Promise<TutorialSession | void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { const next = await work() || await api<TutorialSession>(path); onSession(next); await onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const show = (index: number) => { setView(index); const id = session.stages[index].nodeId; if (id) onStage(id); };
  const descendantIds = new Set<string>(stage.nodeId ? [stage.nodeId] : []);
  for (let pass = 0; pass < detail.project.canvas.nodes.length; pass++) for (const node of detail.project.canvas.nodes) if (node.parentId && descendantIds.has(node.parentId)) descendantIds.add(node.id);
  const saved = detail.artifacts.filter(item => (session.outputArtifactIds.includes(item.id) || (view < 2 && ['source', 'dataset', 'result'].includes(item.kind))) && descendantIds.has(item.nodeId));
  const inspectArtifact = (item: Artifact) => { setMinimized(true); onArtifact(item); };
  const fresh = detail.artifacts.filter(item => session.freshOutputArtifactIds.includes(item.id));
  const draft = detail.artifacts.find(item => item.id === session.draftArtifactId);
  return <section className={`executable-demo ${minimized ? 'minimized' : ''}`} aria-label="Demo tutorial">
    <header><span><BookOpen size={15}/> Demo mode · {view + 1} of 4</span><div><button className="icon-button" aria-label={minimized ? 'Expand demo tutorial' : 'Minimize demo tutorial'} onClick={() => setMinimized(!minimized)}><ChevronDown size={15}/></button><button className="icon-button" aria-label="Close demo tutorial" onClick={onClose}><X size={16}/></button></div></header>
    {!minimized && <><nav className="demo-progress" aria-label="Tutorial stages">{session.stages.map(item => <button className={item.index === view ? 'current' : ''} key={item.index} aria-label={`Step ${item.index + 1}: ${item.title}`} aria-current={item.index === view ? 'step' : undefined} disabled={!item.nodeId} onClick={() => show(item.index)}>{item.index < session.step ? <Check size={14}/> : item.index + 1}<span>{['Explore','Evidence','Analyze','Draft'][item.index]}</span></button>)}</nav>
    <h2>{stage.title}</h2><p>{summary}</p>
    <div className="demo-stage-controls">{stage.nodeId && <button className="secondary small" onClick={() => { setMinimized(true); onNote(stage.nodeId!); }}>Open stage findings</button>}{stage.nodeId && <button className="text-button small" onClick={() => { setMinimized(true); onStage(stage.nodeId!); }}>Show on canvas</button>}</div>
    {saved.length > 0 && <div className="demo-output-list"><strong>{view < 2 ? 'Question and captured evidence' : 'Saved research · inspect the evidence'}</strong>{saved.map(item => <button className="text-button" key={item.id} onClick={() => inspectArtifact(item)}>{item.title}<ArrowRight size={12}/></button>)}</div>}
    {view === 3 && draft && <button className="primary demo-open-draft" onClick={() => inspectArtifact(draft)}>Read finished research output <ArrowRight size={14}/></button>}
    {view >= 2 && <details className="demo-rerun"><summary>Optional: run the calculation again</summary><p>The tutorial above uses saved results. This runs reviewed Python on the server’s isolated local runtime and creates a separate attempt. It does not call a model.</p>
      {!session.execution.available && <p className="demo-runtime-note">{session.execution.reason}</p>}
      {!pending && !running && <button className="secondary small" disabled={busy || !session.execution.available} onClick={() => void act(() => post<TutorialSession>(`${path}/preview`))}><Play size={13}/> {run ? 'Review another attempt' : 'Review code and inputs'}</button>}
      {session.preview && <div className="demo-exact-review"><span className="tag">{pending ? 'Awaiting your approval' : run?.status}</span><details><summary>Exact Python code</summary><pre>{session.preview.code}</pre></details><details><summary>Captured input data</summary><pre>{session.preview.csv}</pre></details><details><summary>Parameters and runtime</summary><pre>{JSON.stringify({ parameters: session.preview.parameters, backend: run?.configuration.backend }, null, 2)}</pre></details>
        {pending && <div className="row gap"><button className="primary small" disabled={busy} onClick={() => void act(async () => { await post(`/api/experiments/${run!.id}/decision`, { fingerprint: session.preview!.approval.fingerprint, decision: 'allow' }); })}><Play size={13}/> Approve and run code</button><button className="secondary small" disabled={busy} onClick={() => void act(async () => { await post(`/api/experiments/${run!.id}/decision`, { fingerprint: session.preview!.approval.fingerprint, decision: 'cancel' }); })}>Cancel review</button></div>}
        {running && <div className="row gap" role="status"><LoaderCircle size={14} className="spin"/><span>Executing this attempt…</span><button className="secondary small" disabled={busy} onClick={() => void act(async () => { await post(`/api/experiments/${run!.id}/cancel`); })}><Square size={12}/> Stop</button></div>}
        {run?.error && <p className="inline-error">{run.error}</p>}
        {!!fresh.length && <div className="demo-output-list"><strong>New execution · actual outputs</strong>{fresh.map(item => <button className="text-button" key={item.id} onClick={() => inspectArtifact(item)}>{item.title}<ArrowRight size={12}/></button>)}</div>}
      </div>}
    </details>}
    <p className="demo-session-notice">{session.notice}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <footer><button className="text-button" onClick={onClose}>Continue exploring</button>{view < session.step ? <button className="primary small" onClick={() => show(session.step)}>Current step <ArrowRight size={13}/></button> : session.step < 3 ? <button className="primary small" disabled={busy} onClick={() => void act(() => post<TutorialSession>(`${path}/advance`, { step: session.step }))}>{busy ? <LoaderCircle size={13} className="spin"/> : <ArrowRight size={13}/>} {['Gather evidence','Analyze findings','Create research draft'][session.step]}</button> : <button className="primary small" onClick={onClose}><Check size={13}/> Finish demo</button>}</footer>
    </>}
  </section>;
}
