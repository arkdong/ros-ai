import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { LoaderCircle } from 'lucide-react';
import { RosMark } from './RosDock';
import { changeLocalRos, gb, percentOf, timeLeft, useLocalRosStatus } from './local-ros-status';
import './ros-download.css';

const reason = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** ROS downloading to this computer, at the top right of every page beside Feedback: the share done, with a line along
 * the chip's foot that fills as it goes. A click says how much is left and lets the person stop it or open Agents › ROS.
 * Once ROS is ready the chip says so for a few seconds and goes; a download that stopped stays until the person tries
 * again or puts it away. Nothing shows while there is no download. */
export function RosDownloadChip({ onOpen, onReady }: { onOpen: () => void; onReady?: () => void }) {
  const status = useLocalRosStatus();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [ready, setReady] = useState(false), [putAway, setPutAway] = useState<string>();
  const box = useRef<HTMLDivElement>(null), seen = useRef(status?.state), done = useRef(onReady);
  done.current = onReady;
  const state = status?.state;
  // Ready after a download this page watched: say so for a moment, and let the app read its models again.
  useEffect(() => {
    const before = seen.current;
    seen.current = state;
    if (state !== 'ready' || (before !== 'downloading' && before !== 'starting')) return;
    setReady(true); setOpen(false); done.current?.();
    const timer = setTimeout(() => setReady(false), 6000);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
  }, [open]);

  const failed = state === 'failed' && putAway !== (status?.error ?? '');
  if (!status || !(state === 'downloading' || state === 'starting' || failed || (state === 'ready' && ready))) return null;
  const percent = percentOf(status), sized = Boolean(status.totalBytes);
  const act = async (action: 'download' | 'cancel') => {
    setBusy(true); setError('');
    try { await changeLocalRos(action); if (action === 'cancel') setOpen(false); }
    catch (cause) { setError(reason(cause)); }
    finally { setBusy(false); }
  };
  const go = () => { setOpen(false); setReady(false); onOpen(); };

  const label = state === 'downloading' ? <>ROS{sized && <b>{percent}%</b>}</> : state === 'starting' ? 'Starting ROS' : state === 'ready' ? 'ROS ready' : 'ROS stopped';
  const mark = state === 'downloading' ? <RosMark working/> : state === 'starting' ? <LoaderCircle size={13} className="spin"/> : <i className={`ros-dl-dot ${state === 'ready' ? 'ok' : 'fail'}`}/>;
  const spoken = state === 'downloading' ? `ROS is downloading${sized ? `, ${percent} percent` : ''}` : state === 'starting' ? 'ROS is starting' : state === 'ready' ? 'ROS is ready' : 'The ROS download stopped';
  const left = state === 'downloading' ? timeLeft(status) : '';
  return <div className="ros-dl" ref={box}>
    <button type="button" className={`ros-dl-chip ${state}${status.note ? ' waiting' : ''}`} style={{ '--done': `${sized ? percent : 0}%` } as CSSProperties}
      aria-label={spoken} aria-haspopup={state === 'ready' ? undefined : 'dialog'} aria-expanded={state === 'ready' ? undefined : open}
      onClick={() => state === 'ready' ? go() : setOpen(!open)}>
      {mark}<span className="ros-dl-label">{label}</span>{status.note && <i className="ros-dl-dot wait" aria-hidden="true"/>}
    </button>
    {open && state !== 'ready' && <div className="ros-dl-menu" role="dialog" aria-label="ROS download">
      <div className="ros-dl-head"><strong>{state === 'downloading' ? 'Downloading ROS' : state === 'starting' ? 'Getting ROS ready' : 'The ROS download stopped'}</strong>{state === 'downloading' && sized && <span>{percent}%</span>}</div>
      {state === 'downloading' && <>
        <span className="ros-dl-bar" role="progressbar" aria-label="ROS download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></span>
        <p>{sized ? `${gb(status.doneBytes)} of ${gb(status.totalBytes)}${left ? ` · ${left}` : ''}` : 'Finding the files'}</p>
        {status.note && <p className="ros-dl-note"><i className="ros-dl-dot wait"/>{status.note}</p>}
        <p>Keep working. It carries on if ros.ai closes.</p>
      </>}
      {state === 'starting' && <p>Downloaded. ROS is starting on this computer; it takes a few seconds.</p>}
      {state === 'failed' && <p>{status.error || 'The download stopped.'}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="ros-dl-actions">
        {state === 'downloading' && <button type="button" className="text-button" disabled={busy} onClick={() => void act('cancel')}>Cancel download</button>}
        {state === 'failed' && <button type="button" className="text-button" onClick={() => { setPutAway(status.error ?? ''); setOpen(false); }}>Not now</button>}
        <span className="ros-dl-sp"/>
        {state === 'failed' ? <button type="button" className="primary small" disabled={busy} onClick={() => void act('download')}>{busy && <LoaderCircle size={13} className="spin"/>}Try again</button>
          : <button type="button" className="secondary small" onClick={go}>Agents › ROS</button>}
      </div>
    </div>}
  </div>;
}
