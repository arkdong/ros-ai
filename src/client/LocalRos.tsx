import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Monitor } from 'lucide-react';
import { ConnectionCard } from './ModelPage';
import { changeLocalRos, gb, percentOf, timeLeft, useLocalRosStatus } from './local-ros-status';

/** ROS on this computer: one download, then ros.ai runs the model itself on this computer. The same status as the
 * download chip in the corner, so both move together. */
export function LocalRos({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const status = useLocalRosStatus(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const changed = useRef(onChanged), seen = useRef(status?.state);
  changed.current = onChanged;
  // Ready after a download: the page reads ROS's connection again.
  useEffect(() => { const before = seen.current; seen.current = status?.state; if (status?.state === 'ready' && before && before !== 'ready') void changed.current(); }, [status?.state]);
  const run = async (action: 'download' | 'cancel' | 'remove') => {
    setBusy(true); setError('');
    try { await changeLocalRos(action); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  if (!status) return null;
  const { state } = status;
  const left = state === 'downloading' ? timeLeft(status) : '';
  const subtitle = state === 'downloading' ? (status.totalBytes ? `${gb(status.doneBytes)} of ${gb(status.totalBytes)}${left ? ` · ${left}` : ''}` : 'Finding the files…')
    : state === 'starting' ? 'Loading the model…'
    : state === 'ready' ? `${status.model?.startsWith('ros-nemotron') ? 'ros-nemotron 4B' : 'Nemotron 3 Nano 4B'} · ${gb(status.totalBytes)} on disk`
    : 'Works offline, free, nothing leaves this computer';
  const label = { 'not-downloaded': 'Not downloaded', downloading: 'Downloading', starting: 'Starting', ready: 'Ready', failed: 'Stopped' }[state];
  const percent = percentOf(status);
  return <ConnectionCard label="ROS on this computer" icon={<Monitor size={18}/>} subtitle={subtitle} connected={state === 'ready'} forceOpen={state !== 'ready'} status={label}>
    {state === 'not-downloaded' && <p>ROS runs on ros-nemotron, NVIDIA Nemotron 3 Nano 4B trained for ros.ai. The download is about 3 GB and needs about 8 GB of memory. ros.ai runs it itself; there is nothing else to install.</p>}
    {state === 'downloading' && <>
      <div className="local-ros-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Download progress"><span style={{ width: `${percent}%` }}/></div>
      {status.note && <p className="subtle">{status.note}</p>}
      <p>You can keep working; another model answers until the download is ready. If ros.ai closes, the download resumes where it stopped.</p>
    </>}
    {state === 'ready' && <p className="subtle">Choose ROS under “ROS on this computer” from the model name in the ROS bar.</p>}
    {!status.supported && <p className="subtle">ros.ai can run ROS on a Mac or a Linux x64 computer for now.</p>}
    {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    <div className="connection-actions">
      {(state === 'not-downloaded' || state === 'failed') && status.supported && <button className="primary small" disabled={busy} onClick={() => void run('download')}>{busy ? <LoaderCircle size={13} className="spin"/> : <Download size={13}/>}{state === 'failed' ? 'Try again' : 'Download ROS (3 GB)'}</button>}
      {state === 'downloading' && <button className="secondary small" disabled={busy} onClick={() => void run('cancel')}>Cancel download</button>}
      {(state === 'ready' || state === 'failed') && status.model && <button className="text-button" disabled={busy} onClick={() => void run('remove')}>Remove download</button>}
    </div>
  </ConnectionCard>;
}
