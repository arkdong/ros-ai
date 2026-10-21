import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { post } from './api';
import './network-prompt.css';

type NetworkRequest = { id: string; host: string; projectId: string | null; source: string; at: string };
type NetworkEvent = { type: 'request'; request: NetworkRequest } | { type: 'settled'; id: string };

/** Sandboxed Python asking to reach a site. Shown wherever the person is, like Claude Code's network prompt. */
export function NetworkPrompt({ publicDemo }: { publicDemo: boolean }) {
  const [requests, setRequests] = useState<NetworkRequest[]>([]), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (publicDemo) return;
    const events = new EventSource('/api/python-network/events');
    events.onmessage = item => {
      let event: NetworkEvent;
      try { event = JSON.parse(item.data) as NetworkEvent; } catch { return; }
      setRequests(current => event.type === 'request' ? [...current.filter(value => value.id !== event.request.id), event.request] : current.filter(value => value.id !== event.id));
    };
    // ros.ai without sandboxed Python has no such stream; stop asking for it.
    events.onerror = () => { if (events.readyState === EventSource.CLOSED) events.close(); };
    return () => events.close();
  }, [publicDemo]);
  const request = requests[0];
  if (!request) return null;
  const answer = async (choice: 'once' | 'always' | 'deny') => {
    setBusy(true);
    try { await post(`/api/python-network/requests/${request.id}`, { choice }); setRequests(current => current.filter(value => value.id !== request.id)); }
    finally { setBusy(false); }
  };
  return <section className="network-prompt" role="alertdialog" aria-label={`Allow ${request.host}?`}>
    <div className="network-prompt-text"><Globe size={16}/><div><strong>Allow {request.host}?</strong><span>{request.source} wants to reach this site.{requests.length > 1 ? ` ${requests.length - 1} more waiting.` : ''}</span></div></div>
    <div className="network-prompt-actions">
      <button className="small primary" disabled={busy} onClick={() => void answer('once')}>Allow once</button>
      {request.projectId && <button className="small secondary" disabled={busy} onClick={() => void answer('always')}>Always for this project</button>}
      <button className="small text-button" disabled={busy} onClick={() => void answer('deny')}>Deny</button>
    </div>
  </section>;
}
