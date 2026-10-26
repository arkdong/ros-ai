import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import type { CloudAccountStatus } from '../shared/cloud-account';
import { ConnectionCard } from './ModelPage';
import { RosMark } from './RosDock';
import { api, post } from './api';
import { cloudAccountChanged } from './ProfileButton';

/** Free hosted Ros: sign in once in the browser, and ros.ai cloud appears as a model. */
export function CloudAccount({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const [status, setStatus] = useState<CloudAccountStatus>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const refresh = useCallback(async () => { try { setStatus(await api<CloudAccountStatus>('/api/cloud')); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const waiting = status?.state === 'waiting';
  // While the browser approval is open, check every few seconds; the local server does the polling.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => { const next = await api<CloudAccountStatus>('/api/cloud').catch(() => undefined); if (next && next.state !== 'waiting') { setStatus(next); cloudAccountChanged(); await onChanged(); } }, 3000);
    return () => clearInterval(timer);
  }, [waiting, onChanged]);
  const run = async (path: string) => {
    setBusy(true); setError('');
    try { const next = await post<CloudAccountStatus>(path); setStatus(next); cloudAccountChanged(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  if (!status?.available) return null;
  const signedIn = status.state === 'signed-in';
  const subtitle = signedIn ? `${status.email}${status.leftTodayUsd !== undefined ? ` · US$${status.leftTodayUsd.toFixed(2)} left today` : ''}` : 'Free with a ros.ai account';
  return <ConnectionCard label="Ros, hosted by ros.ai" icon={<RosMark/>} subtitle={subtitle} connected={signedIn} forceOpen={waiting} status={signedIn ? 'Signed in' : waiting ? 'Waiting for you' : status.state === 'expired' ? 'Signed out' : 'Not connected'}>
    <p>Ros runs on NVIDIA Nemotron at ros.ai cloud, free while ros.ai is new. Your projects stay on this computer; only what Ros is asked to read is sent.</p>
    {waiting && <div className="connection-setup cloud-waiting"><p>Finish signing in in your browser; ros.ai picks it up by itself.</p><a className="secondary small" href={status.verificationUrl} target="_blank" rel="noreferrer">Open the sign-in page <ExternalLink size={11}/></a></div>}
    {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    <div className="connection-actions">
      {signedIn ? <button className="text-button" disabled={busy} onClick={() => void run('/api/cloud/sign-out')}>Sign out</button>
        : <button className="primary small" disabled={busy} onClick={() => { window.open('/api/cloud/start', '_blank', 'noopener'); setTimeout(() => void refresh(), 800); }}>{busy && <LoaderCircle size={13} className="spin"/>}{waiting ? 'Start again' : status.state === 'expired' ? 'Sign in again' : 'Sign in'}</button>}
    </div>
    {signedIn && <p className="subtle">Choose Ros in the assistant's model settings to use it.</p>}
  </ConnectionCard>;
}
