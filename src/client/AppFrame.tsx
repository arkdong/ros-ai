import { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import type { AppFrameGrant } from '../shared/apps';
import { api, post } from './api';
import { AppHost } from './app-host';
import './app-block.css';

type FrameState = { kind: 'starting' } | { kind: 'running' } | { kind: 'stopped'; reason: 'frozen' | 'left' } | { kind: 'failed'; message: string };
const STOPPED = { frozen: 'This App stopped answering, so ros.ai unloaded it.', left: 'This App tried to leave its page, so ros.ai unloaded it.' };

/** An App's page in its sealed frame. A new frame opens when the page (version) or the proposal it previews changes;
 * watchKey changes when the project does, and the page gets fresh copies of the blocks it watches. */
export function AppFrame({ projectId, nodeId, title, version, proposalId, watchKey, onFocus, onErrors, onEscape }: {
  projectId: string; nodeId: string; title: string; version: string; proposalId?: string; watchKey?: string | number;
  onFocus?: (blockId: string) => void; onErrors?: (errors: string[]) => void; onEscape?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null), host = useRef<AppHost | null>(null);
  const [state, setState] = useState<FrameState>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const events = useRef({ onFocus, onErrors, onEscape }); events.current = { onFocus, onErrors, onEscape };
  useEffect(() => {
    let cancelled = false, token: string | null = null;
    const errors: string[] = [];
    setState({ kind: 'starting' }); events.current.onErrors?.([]);
    void post<AppFrameGrant>(`/api/projects/${projectId}/apps/${nodeId}/frame`, proposalId ? { proposalId } : {}).then(grant => {
      if (cancelled || !box.current) { void api(`/api/app-bridge/${grant.token}`, { method: 'DELETE' }).catch(() => undefined); return; }
      token = grant.token;
      host.current = new AppHost(box.current, grant.token, grant.url, `App: ${title}`, {
        onFocus: id => events.current.onFocus?.(id),
        onEscape: () => events.current.onEscape?.(),
        onError: message => { errors.push(message); events.current.onErrors?.(errors.slice(-20)); },
        onReady: () => setState({ kind: 'running' }),
        onStopped: reason => setState({ kind: 'stopped', reason }),
      });
    }, error => { if (!cancelled) setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }); });
    return () => {
      cancelled = true; host.current?.dispose(); host.current = null;
      if (token) void api(`/api/app-bridge/${token}`, { method: 'DELETE' }).catch(() => undefined);
    };
    // The title only names the frame for screen readers; renaming the block keeps the running page.
  }, [projectId, nodeId, proposalId, version, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { host.current?.changed(); }, [watchKey]);
  return <div className={`app-frame-box app-${state.kind}`}>
    <div ref={box} className="app-frame-slot"/>
    {state.kind === 'stopped' || state.kind === 'failed' ? <div className="app-frame-notice" role="status">
      <p>{state.kind === 'stopped' ? STOPPED[state.reason] : state.message}</p>
      {state.kind === 'stopped' && <button type="button" className="secondary small nodrag" onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }}><RotateCw size={13}/> Reload</button>}
    </div> : null}
  </div>;
}
