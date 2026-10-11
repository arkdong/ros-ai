import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, LoaderCircle } from 'lucide-react';
import type { TutorialCatalog, TutorialScenarioId, TutorialSession } from '../shared/tutorial';
import { api, post } from './api';
import './executable-demo.css';

export function DemoOnboarding({ onCreated, onWorkspace, onSkip }: { onCreated: (session: TutorialSession) => void; onWorkspace: (projectId: string) => void; onSkip: () => void }) {
  const [catalog, setCatalog] = useState<TutorialCatalog | null>(null), [scenario, setScenario] = useState<TutorialScenarioId | 'workspace'>('banking');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { void api<TutorialCatalog>('/api/demo-scenarios').then(next => { setCatalog(next); if (next.workspace?.available) setScenario('workspace'); }).catch(cause => setError(cause.message)); }, []);
  const create = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (scenario === 'workspace') onWorkspace((await post<{ projectId: string }>('/api/demo-workspace', {})).projectId);
      else onCreated(await post<TutorialSession>('/api/demo-sessions', { scenario }));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  return <div className="demo-onboarding">
    <span className="demo-intro-label"><BookOpen size={16}/> Optional demo mode</span>
    <p className="demo-intro">Follow a real research question from first idea to finished draft.</p>
    <p>The whole workspace opens as one canvas you can explore and keep working in. The guided cases build up in four quick steps. Each uses recorded evidence and actual saved calculations.</p>
    <div className="demo-scenario-list" role="radiogroup" aria-label="Demo scenario">
      {catalog?.workspace && <button type="button" role="radio" aria-checked={scenario === 'workspace'} disabled={!catalog.workspace.available} className={scenario === 'workspace' ? 'selected' : ''} onClick={() => setScenario('workspace')}><span className="demo-scenario-check">{scenario === 'workspace' && <Check size={14}/>}</span><span><strong>{catalog.workspace.title}</strong><small>{catalog.workspace.summary}</small>{!catalog.workspace.available && <small className="demo-unavailable">{catalog.workspace.unavailableReason}</small>}</span></button>}
      {catalog?.scenarios.map(item => <button key={item.id} type="button" role="radio" aria-checked={scenario === item.id} disabled={item.available === false} className={scenario === item.id ? 'selected' : ''} onClick={() => setScenario(item.id)}><span className="demo-scenario-check">{scenario === item.id && <Check size={14}/>}</span><span><strong>{item.title}</strong><small>{item.summary}</small>{item.available === false && <small className="demo-unavailable">{item.unavailableReason || 'Available in the local workspace only.'}</small>}</span></button>)}
      {!catalog && !error && <p role="status"><LoaderCircle size={16} className="spin"/> Loading examples…</p>}
    </div>
    {catalog?.scenarios.find(item => item.id === scenario)?.publicDataStatus && <p className="demo-source-note">{catalog.scenarios.find(item => item.id === scenario)?.publicDataStatus}</p>}
    <p className="demo-provenance-note">The tutorial reuses genuine saved research and labels it clearly. Optional code reruns are separate, reviewed actions. Starting a demo makes no paid model or search requests.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="secondary" onClick={onSkip} disabled={busy}>Continue without demo</button><button className="primary" disabled={!catalog || busy || (scenario === 'workspace' ? !catalog.workspace?.available : catalog.scenarios.find(item => item.id === scenario)?.available === false)} onClick={() => void create()}>{busy ? <LoaderCircle size={15} className="spin"/> : <ArrowRight size={15}/>} {busy ? 'Creating your workspace…' : 'Start demo'}</button></div>
  </div>;
}
