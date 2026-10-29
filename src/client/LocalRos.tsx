import { useCallback, useEffect, useState } from 'react';
import { Download, LoaderCircle, Monitor } from 'lucide-react';
import type { LocalRosStatus } from '../shared/local-ros';
import { ConnectionCard } from './ModelPage';
import { api, post } from './api';

const gb = (bytes = 0) => `${(bytes / 1e9).toFixed(1)} GB`;

/** ROS on this computer: one download, then ros.ai runs the model itself on this computer. */
export function LocalRos({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const [status, setStatus] = useState<LocalRosStatus>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const refresh = useCallback(async () => { try { setStatus(await api<LocalRosStatus>('/api/local-ros')); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const working = status?.state === 'downloading' || status?.state === 'starting';
  // The local server does the work; the page only follows its progress.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(async () => { const next = await api<LocalRosStatus>('/api/local-ros').catch(() => undefined); if (!next) return; setStatus(next); if (next.state === 'ready') await onChanged(); }, 2000);
    return () => clearInterval(timer);
  }, [working, onChanged]);
  const run = async (path: string) => {
    setBusy(true); setError('');
    try { setStatus(await post<LocalRosStatus>(path)); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  if (!status) return null;
  const { state } = status;
  const subtitle = state === 'downloading' ? (status.totalBytes ? `${gb(status.doneBytes)} of ${gb(status.totalBytes)}` : 'Finding the files…')
    : state === 'starting' ? 'Loading the model…'
    : state === 'ready' ? `${status.model?.startsWith('ros-nemotron') ? 'ros-nemotron 4B' : 'Nemotron 3 Nano 4B'} · ${gb(status.totalBytes)} on disk`
    : 'Works offline, free, nothing leaves this computer';
  const label = { 'not-downloaded': 'Not downloaded', downloading: 'Downloading', starting: 'Starting', ready: 'Ready', failed: 'Stopped' }[state];
  const percent = status.totalBytes ? Math.min(100, Math.round(((status.doneBytes ?? 0) / status.totalBytes) * 100)) : 0;
  return <ConnectionCard label="ROS on this computer" icon={<Monitor size={18}/>} subtitle={subtitle} connected={state === 'ready'} forceOpen={state !== 'ready'} status={label}>
    {state === 'not-downloaded' && <p>ROS runs on ros-nemotron, NVIDIA Nemotron 3 Nano 4B trained for ros.ai. The download is about 3 GB and needs about 8 GB of memory. ros.ai runs it itself; there is nothing else to install.</p>}
    {state === 'downloading' && <>
      <div className="local-ros-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Download progress"><span style={{ width: `${percent}%` }}/></div>
      <p>You can keep working; another model answers until the download is ready. If ros.ai closes, the download resumes where it stopped.</p>
    </>}
    {state === 'ready' && <p className="subtle">Choose ROS under “ROS on this computer” from the model name in the ROS bar.</p>}
    {!status.supported && <p className="subtle">ros.ai can run ROS on a Mac or a Linux x64 computer for now.</p>}
    {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    <div className="connection-actions">
      {(state === 'not-downloaded' || state === 'failed') && status.supported && <button className="primary small" disabled={busy} onClick={() => void run('/api/local-ros/download')}>{busy ? <LoaderCircle size={13} className="spin"/> : <Download size={13}/>}{state === 'failed' ? 'Try again' : 'Download ROS (3 GB)'}</button>}
      {state === 'downloading' && <button className="secondary small" disabled={busy} onClick={() => void run('/api/local-ros/cancel')}>Cancel download</button>}
      {(state === 'ready' || state === 'failed') && status.model && <button className="text-button" disabled={busy} onClick={() => void run('/api/local-ros/remove')}>Remove download</button>}
    </div>
  </ConnectionCard>;
}
