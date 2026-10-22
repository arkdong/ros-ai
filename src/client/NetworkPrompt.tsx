import { useEffect, useState } from 'react';
import { Check, Globe, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { post } from './api';
import './network-prompt.css';

type NetworkRequest = { id: string; host: string; projectId: string | null; source: string; at: string };
type NetworkEvent = { type: 'request'; request: NetworkRequest } | { type: 'settled'; id: string };
type SetupEvent = { status: 'installing'; step: string } | { status: 'ready'; version: string } | { status: 'failed'; message: string };

/** A server stream that exists only with sandboxed Python (macOS); elsewhere it is closed after the first error. */
function useStream<T>(url: string, enabled: boolean, onEvent: (event: T) => void) {
  useEffect(() => {
    if (!enabled) return;
    const events = new EventSource(url);
    events.onmessage = item => { try { onEvent(JSON.parse(item.data) as T); } catch { /* not ours */ } };
    events.onerror = () => { if (events.readyState === EventSource.CLOSED) events.close(); };
    return () => events.close();
  }, [url, enabled]);
}

/** Notices from sandboxed Python, shown over everything: the one-time setup, and sites waiting to be allowed. */
export function NetworkPrompt({ publicDemo }: { publicDemo: boolean }) {
  const [requests, setRequests] = useState<NetworkRequest[]>([]), [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<SetupEvent | null>(null), [why, setWhy] = useState(false);
  useStream<NetworkEvent>('/api/python-network/events', !publicDemo, event =>
    setRequests(current => event.type === 'request' ? [...current.filter(value => value.id !== event.request.id), event.request] : current.filter(value => value.id !== event.id)));
  useStream<SetupEvent>('/api/python/setup/events', !publicDemo, setSetup);
  // "Ready" says so briefly, then goes.
  useEffect(() => { if (setup?.status !== 'ready') return; const timer = window.setTimeout(() => setSetup(null), 6000); return () => window.clearTimeout(timer); }, [setup]);
  const request = requests[0];
  if (!request && !setup) return null;
  const answer = async (choice: 'once' | 'always' | 'deny') => {
    if (!request) return;
    setBusy(true);
    try { await post(`/api/python-network/requests/${request.id}`, { choice }); setRequests(current => current.filter(value => value.id !== request.id)); }
    finally { setBusy(false); }
  };
  return <div className="python-notices">
    {setup && <section className="python-notice" role="status" aria-label="Python setup">
      <div className="python-notice-text">
        {setup.status === 'installing' ? <LoaderCircle size={16} className="spin"/> : setup.status === 'ready' ? <Check size={16}/> : <X size={16}/>}
        <div>
          <strong>{setup.status === 'installing' ? 'Setting up Python, once' : setup.status === 'ready' ? 'Python is ready' : 'Python could not be set up'}</strong>
          <span>{setup.status === 'installing' ? `${setup.step}… About 150 MB, a minute or two.` : setup.status === 'ready' ? `Python ${setup.version}. Run your cell again if it stopped.` : setup.message}</span>
        </div>
        {setup.status !== 'installing' && <button className="icon-button" aria-label="Close" onClick={() => setSetup(null)}><X size={14}/></button>}
      </div>
      {setup.status !== 'ready' && <>
        <button className="small text-button python-notice-why" onClick={() => setWhy(open => !open)}><ShieldCheck size={13}/> {why ? 'Hide' : 'Why, and is it safe?'}</button>
        {why && <ul className="python-notice-detail">
          <li>Code and Notebook blocks need Python with pandas, NumPy, matplotlib and SciPy. ros.ai fetches its own copy so you don't have to install anything.</li>
          <li>It comes from the standard open-source sources: Python builds through uv, and packages from PyPI. Nothing else is installed.</li>
          <li>It stays in ros.ai's own folder and leaves your system Python alone. Deleting that folder removes it.</li>
          <li>Every cell runs in the macOS sandbox: it can't read your other files, writes only to the outputs folder, and asks before reaching any website.</li>
        </ul>}
      </>}
    </section>}
    {request && <section className="python-notice" role="alertdialog" aria-label={`Allow ${request.host}?`}>
      <div className="python-notice-text"><Globe size={16}/><div><strong>Allow {request.host}?</strong><span>{request.source} wants to reach this site.{requests.length > 1 ? ` ${requests.length - 1} more waiting.` : ''}</span></div></div>
      <div className="python-notice-actions">
        <button className="small primary" disabled={busy} onClick={() => void answer('once')}>Allow once</button>
        {request.projectId && <button className="small secondary" disabled={busy} onClick={() => void answer('always')}>Always for this project</button>}
        <button className="small text-button" disabled={busy} onClick={() => void answer('deny')}>Deny</button>
      </div>
    </section>}
  </div>;
}
