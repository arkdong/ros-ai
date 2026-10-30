import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Monitor } from 'lucide-react';
import { ConnectionCard } from './ModelPage';
import { changeLocalRos, gb, percentOf, timeLeft, useLocalRosStatus } from './local-ros-status';

/** The model's name as the card says it: "ros-nemotron 4B, round 2" for a file from round 2's training. */
function modelName(file = '') {
  const round = /-r(\d+)[a-z]?-/u.exec(file)?.[1];
  return file.startsWith('ros-nemotron') ? `ros-nemotron 4B${round ? `, round ${round}` : ''}` : 'Nemotron 3 Nano 4B';
}

/** ROS on this computer: one download, then ros.ai runs the model itself on this computer, and a newer model comes
 * in the background while the one it has keeps answering. The same status as the download chip in the corner, so both
 * move together. */
export function LocalRos({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const status = useLocalRosStatus(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const changed = useRef(onChanged), seen = useRef(status?.state);
  changed.current = onChanged;
  // Ready after a download: the page reads ROS's connection again.
  useEffect(() => { const before = seen.current; seen.current = status?.state; if (status?.state === 'ready' && before && before !== 'ready') void changed.current(); }, [status?.state]);
  const run = async (action: 'download' | 'cancel' | 'remove' | 'update') => {
    setBusy(true); setError('');
    try { await changeLocalRos(action); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  if (!status) return null;
  const { state } = status, update = state === 'ready' ? status.update : undefined;
  const left = state === 'downloading' ? timeLeft(status) : update?.state === 'downloading' ? timeLeft(update) : '';
  const subtitle = state === 'downloading' ? (status.totalBytes ? `${gb(status.doneBytes)} of ${gb(status.totalBytes)}${left ? ` · ${left}` : ''}` : 'Finding the files…')
    : state === 'starting' ? 'Loading the model…'
    : state === 'ready' ? `${modelName(status.model)} · ${update?.state === 'downloading' ? `updating, ${percentOf(update)}%` : update?.state === 'switching' ? 'switching to the new model' : update ? 'update available' : `${gb(status.totalBytes)} on disk`}`
    : 'Works offline, free, nothing leaves this computer';
  const label = { 'not-downloaded': 'Not downloaded', downloading: 'Downloading', starting: 'Starting', ready: 'Ready', failed: 'Stopped' }[state];
  const percent = percentOf(update ?? status);
  return <ConnectionCard label="ROS on this computer" icon={<Monitor size={18}/>} subtitle={subtitle} connected={state === 'ready'} forceOpen={state !== 'ready' || Boolean(update)} status={label}>
    {state === 'not-downloaded' && <p>ROS runs on ros-nemotron, NVIDIA Nemotron 3 Nano 4B trained for ros.ai. The download is about 3 GB and needs about 8 GB of memory. ros.ai runs it itself; there is nothing else to install.</p>}
    {(state === 'downloading' || update?.state === 'downloading') && <div className="local-ros-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={update ? 'Update progress' : 'Download progress'}><span style={{ width: `${percent}%` }}/></div>}
    {state === 'downloading' && <>
      {status.note && <p className="subtle">{status.note}</p>}
      <p>You can keep working; another model answers until the download is ready. If ros.ai closes, the download resumes where it stopped.</p>
    </>}
    {update?.state === 'downloading' && <>
      <p className="subtle">{`${modelName(update.model)} · ${gb(update.doneBytes)} of ${gb(update.totalBytes)}${left ? ` · ${left}` : ''}`}</p>
      {update.note && <p className="subtle">{update.note}</p>}
      <p>ROS keeps answering with the model it has and switches by itself once the new one is in.</p>
    </>}
    {update?.state === 'switching' && <p>{modelName(update.model)} is in. ROS switches to it as soon as it isn’t answering anything, which takes a few seconds.</p>}
    {update?.state === 'available' && <p>{modelName(update.model)} is out ({gb(update.totalBytes)}). ROS keeps answering with the model it has while it downloads.</p>}
    {state === 'ready' && !update && <p className="subtle">Choose ROS under “ROS on this computer” from the model name in the ROS bar.</p>}
    {!status.supported && <p className="subtle">ros.ai can run ROS on a Mac or a Linux x64 computer for now.</p>}
    {(error || status.error || update?.error) && <p className="inline-error" role="alert">{error || status.error || update?.error}</p>}
    <div className="connection-actions">
      {(state === 'not-downloaded' || state === 'failed') && status.supported && <button className="primary small" disabled={busy} onClick={() => void run('download')}>{busy ? <LoaderCircle size={13} className="spin"/> : <Download size={13}/>}{state === 'failed' ? 'Try again' : 'Download ROS (3 GB)'}</button>}
      {update?.state === 'available' && <button className="primary small" disabled={busy} onClick={() => void run('update')}>{busy ? <LoaderCircle size={13} className="spin"/> : <Download size={13}/>}Update ROS</button>}
      {state === 'downloading' && <button className="secondary small" disabled={busy} onClick={() => void run('cancel')}>Cancel download</button>}
      {update?.state === 'downloading' && <button className="secondary small" disabled={busy} onClick={() => void run('cancel')}>Stop update</button>}
      {(state === 'ready' || state === 'failed') && status.model && <button className="text-button" disabled={busy} onClick={() => void run('remove')}>Remove download</button>}
    </div>
  </ConnectionCard>;
}
