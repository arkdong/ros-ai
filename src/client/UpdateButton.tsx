import { useEffect, useRef, useState } from 'react';
import { Check, CircleArrowUp, Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import type { UpdateStatus } from '../shared/updates';
import { installUpdate, updateWait, useUpdates } from './updates';
import './update-button.css';

const reason = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The Update pill at the top right of the workspace, as Codex shows one: it appears once a newer ros.ai is ready.
 * In the Mac app a click restarts into the downloaded version; a checkout or a copy that updates by hand first
 * says what will happen. */
export function UpdateButton() {
  const status = useUpdates(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  // Nothing to click while the Mac app downloads, or before a checkout knows whether it can pull.
  if (!status?.latest || (status.state !== 'installing' && !status.action)) return null;
  const { latest, state, action } = status, updating = state === 'installing' || busy;
  const install = async () => {
    setBusy(true); setError('');
    try { await installUpdate(); setOpen(false); }
    catch (cause) { setError(reason(cause)); setOpen(true); }
    finally { setBusy(false); }
  };
  // The Mac app restarts straight away, unless the last try failed and there is something to say.
  const direct = action === 'restart' && !status.error;
  const tip = updating || open ? undefined : action === 'restart' ? `Restart to update to ${latest.version}` : action === 'update' ? `Update to ${latest.version}` : `ros.ai ${latest.version} is out`;
  return <div className="update" ref={box}>
    <button type="button" className="update-pill" data-tip={tip} aria-haspopup={direct ? undefined : 'dialog'} aria-expanded={direct ? undefined : open} disabled={updating} onClick={() => direct ? void install() : setOpen(!open)}>
      {updating ? <LoaderCircle size={15} className="spin"/> : <CircleArrowUp size={15}/>}{updating ? 'Updating' : 'Update'}
    </button>
    {open && <div className="update-menu" role="dialog" aria-label="Update ros.ai"><UpdateDetails status={status} busy={busy} error={error} onInstall={() => void install()}/></div>}
  </div>;
}

function UpdateDetails({ status, busy, error, onInstall }: { status: UpdateStatus; busy: boolean; error: string; onInstall: () => void }) {
  const latest = status.latest!, problem = error || status.error;
  const failure = problem && <p className="inline-error" role="alert">{problem}</p>;
  return <>
    <div className="update-menu-head"><strong>ros.ai {latest.version} is out</strong><a href={latest.url} target="_blank" rel="noreferrer">What's new</a></div>
    {status.action === 'update' ? <>
      <p>Pulls {latest.version} into this checkout, installs packages if they changed, rebuilds and restarts ros.ai. Takes about a minute; agents that are working stop.</p>
      {failure}
      <button type="button" className="primary update-primary" disabled={busy} onClick={onInstall}>{busy && <LoaderCircle size={13} className="spin"/>}Update and restart</button>
    </> : status.action === 'restart' ? <>
      {failure}
      <button type="button" className="primary update-primary" disabled={busy} onClick={onInstall}>{busy && <LoaderCircle size={13} className="spin"/>}Restart to update</button>
      <DownloadLink status={status}/>
    </> : <>
      <p>{status.note}</p>
      {status.commands ? <>
        <p>In a terminal in the ros-ai folder:</p>
        <Commands text={status.commands}/>
        {status.install === 'source' && <p>Then start ros.ai again.</p>}
      </> : <DownloadLink status={status}/>}
      {failure}
    </>}
  </>;
}

/** The release page, for copies that can't replace themselves; a plain link in the popover, a button in Settings. */
export function DownloadLink({ status, button }: { status: UpdateStatus; button?: boolean }) {
  const latest = status.latest!;
  return <a className={button ? 'secondary small update-download' : 'update-download'} href={latest.url} target="_blank" rel="noreferrer">{button ? 'Download' : `Download ${latest.version} from GitHub`}<ExternalLink size={12}/></a>;
}

export function Commands({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
  return <span className="update-commands"><code>{text}</code><button type="button" className="icon-button" aria-label={copied ? 'Copied' : 'Copy commands'} onClick={copy}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></span>;
}

/** While ros.ai updates, the page waits here and reloads once ros.ai answers again. */
export function UpdateOverlay() {
  const status = useUpdates(), [, tick] = useState(0), installing = status?.state === 'installing';
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => tick(count => count + 1), 5000);
    return () => clearInterval(timer);
  }, [installing]);
  if (!installing || !status.latest) return null;
  const app = status.install === 'app', { waited, down } = updateWait();
  return <div className="update-overlay" role="status"><div className="update-overlay-card">
    <div className="update-overlay-head"><LoaderCircle size={18} className="spin"/><strong>Updating ros.ai to {status.latest.version}</strong></div>
    {app ? <p>{waited > 45_000 && !down ? 'ros.ai didn\'t restart by itself. Quit it, open it again and press Update once more.' : 'ros.ai closes and opens again in a few seconds.'}</p> : <>
      <p>Pulling the new version, installing packages if they changed, building and restarting. This page reloads by itself, usually within a minute.</p>
      <small>{down > 180_000 ? 'ros.ai hasn\'t come back yet. Look at the terminal where you started it.' : 'Each step shows in the terminal where you started ros.ai.'}</small>
    </>}
  </div></div>;
}
