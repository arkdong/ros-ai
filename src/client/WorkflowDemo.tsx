import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, ChevronDown, LoaderCircle, X } from 'lucide-react';
import type { ProjectDetail } from '../shared/types';
import type { TutorialSession } from '../shared/tutorial';
import { api, post } from './api';
import './executable-demo.css';

/** The guided workflow: each Next adds one step's blocks to the canvas and shows them together. */
export function WorkflowDemo({ session, detail, onSession, onRefresh, onFrame, onOpen, onClose }: {
  session: TutorialSession; detail: ProjectDetail; onSession: (session: TutorialSession) => void; onRefresh: () => Promise<unknown>;
  onFrame: (ids: string[]) => void; onOpen: (id: string) => void; onClose: () => void;
}) {
  const [view, setView] = useState(session.step), [busy, setBusy] = useState(false), [error, setError] = useState(''), [minimized, setMinimized] = useState(false);
  const stage = session.stages[view], last = session.stages.length - 1, framed = useRef(-1);
  const path = `/api/projects/${session.projectId}/demo-session`;
  useEffect(() => { setView(session.step); }, [session.step]);
  // A step's blocks are shown together once they are all on the canvas.
  useEffect(() => {
    const ids = session.stages[session.step].frame ?? [];
    if (framed.current === session.step || !ids.length || !ids.every(id => detail.project.canvas.nodes.some(node => node.id === id))) return;
    framed.current = session.step;
    onFrame(ids);
  }, [session.step, session.stages, detail.project.canvas.nodes, onFrame]);
  const next = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { onSession(await post<TutorialSession>(`${path}/advance`, { step: session.step })); await onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); void api<TutorialSession>(path).then(onSession).catch(() => undefined); }
    finally { setBusy(false); }
  };
  const show = (index: number) => { setView(index); const ids = session.stages[index].frame ?? []; if (ids.length) onFrame(ids); };
  return <section className={`executable-demo workflow-demo ${minimized ? 'minimized' : ''}`} aria-label="Demo guide">
    <header><span><BookOpen size={15}/> Demo mode · {view + 1} of {session.stages.length}</span><div><button className="icon-button" aria-label={minimized ? 'Expand demo guide' : 'Minimize demo guide'} onClick={() => setMinimized(!minimized)}><ChevronDown size={15}/></button><button className="icon-button" aria-label="Close demo guide" onClick={onClose}><X size={16}/></button></div></header>
    {!minimized && <>
      <nav className="demo-progress" aria-label="Demo steps">{session.stages.map(item => <button key={item.index} className={item.index === view ? 'current' : ''} aria-label={`Step ${item.index + 1}: ${item.title}`} aria-current={item.index === view ? 'step' : undefined} disabled={item.index > session.step} onClick={() => show(item.index)}>
        <b>{item.index < session.step ? <Check size={13}/> : item.index + 1}</b><span>{item.label}</span>
      </button>)}</nav>
      <h2>{stage.title}</h2>
      <p>{stage.summary}</p>
      {stage.live && <p className="workflow-live">{stage.live}</p>}
      {!!stage.open?.length && <div className="demo-stage-controls">{stage.open.map(link => <button key={link.label} className="secondary small" onClick={() => { setMinimized(true); onOpen(link.nodeId); }}>{link.label} <ArrowRight size={13}/></button>)}</div>}
      <p className="demo-session-notice">{session.notice}</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer><button className="text-button" onClick={onClose}>Continue exploring</button>{view < session.step
        ? <button className="primary small" onClick={() => show(session.step)}>Current step <ArrowRight size={13}/></button>
        : session.step < last
          ? <button className="primary small" disabled={busy} onClick={() => void next()}>{busy ? <LoaderCircle size={13} className="spin"/> : <ArrowRight size={13}/>} {stage.next ?? 'Next'}</button>
          : <button className="primary small" onClick={onClose}><Check size={13}/> Finish demo</button>}</footer>
    </>}
  </section>;
}
