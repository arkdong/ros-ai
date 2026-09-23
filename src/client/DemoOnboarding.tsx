import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, LoaderCircle } from 'lucide-react';
import type { TutorialCatalog, TutorialScenarioId, TutorialSession } from '../shared/tutorial';
import { api, post } from './api';
import './executable-demo.css';

export function DemoOnboarding({ onCreated, onSkip }: { onCreated: (session: TutorialSession) => void; onSkip: () => void }) {
  const [catalog, setCatalog] = useState<TutorialCatalog | null>(null), [scenario, setScenario] = useState<TutorialScenarioId>('banking');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { void api<TutorialCatalog>('/api/demo-scenarios').then(setCatalog).catch(cause => setError(cause.message)); }, []);
  const create = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { onCreated(await post<TutorialSession>('/api/demo-sessions', { scenario })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  return <div className="demo-onboarding">
    <span className="demo-intro-label"><BookOpen size={16}/> Optional demo mode</span>
    <p className="demo-intro">Follow a real research question from first idea to finished draft.</p>
    <p>Four quick steps create your own example workspace. Explore recorded evidence and actual saved calculations, inspect the findings, then open the finished research output.</p>
    <div className="demo-scenario-list" role="radiogroup" aria-label="Demo scenario">
      {catalog?.scenarios.map(item => <button key={item.id} type="button" role="radio" aria-checked={scenario === item.id} disabled={item.available === false} className={scenario === item.id ? 'selected' : ''} onClick={() => setScenario(item.id)}><span className="demo-scenario-check">{scenario === item.id && <Check size={14}/>}</span><span><strong>{item.title}</strong><small>{item.summary}</small>{item.available === false && <small className="demo-unavailable">{item.unavailableReason || 'Available in the local workspace only.'}</small>}</span></button>)}
      {!catalog && !error && <p role="status"><LoaderCircle size={16} className="spin"/> Loading examples…</p>}
    </div>
    {catalog?.scenarios.find(item => item.id === scenario)?.publicDataStatus && <p className="demo-source-note">{catalog.scenarios.find(item => item.id === scenario)?.publicDataStatus}</p>}
    <p className="demo-provenance-note">The tutorial reuses genuine saved research and labels it clearly. Optional code reruns are separate, reviewed actions. Starting a demo makes no paid model or search requests.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="secondary" onClick={onSkip} disabled={busy}>Continue without demo</button><button className="primary" disabled={!catalog || busy || catalog.scenarios.find(item => item.id === scenario)?.available === false} onClick={() => void create()}>{busy ? <LoaderCircle size={15} className="spin"/> : <ArrowRight size={15}/>} {busy ? 'Creating your workspace…' : 'Start demo'}</button></div>
    <a className="waitlist-onboarding-link" href="/waitlist">Interested in early access? Join the waitlist →</a>
  </div>;
}
