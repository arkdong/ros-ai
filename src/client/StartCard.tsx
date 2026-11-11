import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Folder, FolderOpen, FolderSearch, LoaderCircle } from 'lucide-react';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { FolderChoice, FolderSuggestion } from '../shared/project-folders';
import { api } from './api';
import { RosMark } from './RosDock';
import { cloudAccountChanged } from './ProfileButton';

import { folderName, useFolderSuggestion } from './ProjectFolder';
import './chip-menu.css';
import './start-card.css';

/** Where a new project starts: an empty map, or a folder that already exists. */
export type StartFrom = { kind: 'blank' } | { kind: 'folder' };
const blank: StartFrom = { kind: 'blank' };

const thisComputer = /Mac/i.test(navigator.userAgent) ? 'this Mac' : 'this computer';
/** A path the way the Mac shows it: the home folder as ~. */
const shortPath = (path: string) => path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, '~');
/** The folder a path sits in, with a trailing separator. */
const parentOf = (path: string) => { const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return at > 0 ? path.slice(0, at + 1) : path; };
type Handlers = {
  onCreate: (title: string, folder?: string) => Promise<void>;
  onOpenFolder: (path: string) => Promise<boolean>;
};

/** One card in the bar's shape: the name on top, the folder and the starting point as chips on the footer line, one black action.
 *  The folder follows the name until the person types or picks their own; Enter submits. */
function ProjectCard({ caption, verb, from, onFrom, onCancel, focusKey, onCreate, onOpenFolder }: Handlers & { caption?: string; verb: 'Start' | 'Create'; from: StartFrom; onFrom: (from: StartFrom) => void; onCancel?: () => void; focusKey?: number }) {
  const [name, setName] = useState(''), [path, setPath] = useState(''), [busy, setBusy] = useState(false), [menu, setMenu] = useState<'folder' | 'from' | null>(null);
  const [folder, setFolder] = useState(''), [folderEdited, setFolderEdited] = useState(false), [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  const foot = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null);
  const suggestion = useFolderSuggestion(name.trim() || 'Untitled', from.kind !== 'folder');
  useEffect(() => { if (suggestion && !folderEdited) setFolder(suggestion.path); }, [suggestion, folderEdited]);
  useEffect(() => { if (focusKey) field.current?.focus(); }, [focusKey]);
  // A click anywhere else closes an open menu.
  useEffect(() => {
    if (!menu) return;
    const away = (event: MouseEvent) => { if (!foot.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menu]);
  const picker = Boolean(suggestion?.picker);
  const choose = async (onPath: (path: string) => void) => {
    setChoosing(true); setError('');
    try {
      // The folder window stays open while the person looks around, so this request waits longer than most.
      const start = (from.kind === 'folder' ? path : folder).trim();
      const choice = await api<FolderChoice>('/api/folders/choose', { method: 'POST', body: JSON.stringify(start ? { path: start } : {}), signal: AbortSignal.timeout(11 * 60_000) });
      if ('path' in choice) onPath(choice.path);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChoosing(false); }
  };
  const openFolderMode = () => { onFrom({ kind: 'folder' }); setMenu(null); if (picker) void choose(setPath); };
  const ready = from.kind === 'folder' ? Boolean(path.trim()) : true;
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !ready) return;
    setBusy(true); setError('');
    try {
      let target = folder.trim() || undefined;
      // The suggested folder follows the name a moment after it is typed. A name entered quickly gets its own folder,
      // not the one suggested for the name before it.
      if (from.kind !== 'folder' && suggestion && !folderEdited) target = (await api<FolderSuggestion>(`/api/folders/suggest?name=${encodeURIComponent(name.trim() || 'Untitled')}`).catch(() => null))?.path ?? target;
      if (from.kind === 'folder') await onOpenFolder(path.trim());
      else await onCreate(name.trim(), target);
    } finally { setBusy(false); }
  };
  // Esc closes an open menu and stays there; without one it reaches the card's owner.
  const keys = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu) { event.stopPropagation(); setMenu(null); } };
  const fromLabel = from.kind === 'blank' ? 'Blank' : 'A folder';
  const action = from.kind === 'folder' ? 'Open' : verb;
  const chooser = (onPath: (path: string) => void) => <button type="button" className="chip-button" disabled={choosing} onClick={() => void choose(onPath)}>{choosing ? <LoaderCircle size={12} className="spin"/> : <FolderSearch size={12}/>}Choose…</button>;
  return <form className="project-card" onSubmit={submit} onKeyDown={keys}>
    {caption && <div className="pc-caption">{caption}</div>}
    {from.kind === 'folder'
      ? <input ref={field} className="pc-name mono" data-testid="project-folder" value={path} onChange={event => setPath(event.target.value)} placeholder="~/Documents/My research" aria-label="Folder to open" spellCheck={false} autoComplete="off" autoFocus/>
      : <input ref={field} className="pc-name" data-testid="project-name" value={name} onChange={event => setName(event.target.value)} placeholder="Untitled" aria-label="Project name" maxLength={160} autoFocus/>}
    <div className="pc-foot" ref={foot}>
      {from.kind !== 'folder' && <span className="chip-slot">
        <button type="button" className={`chip-button${folder ? ' set' : ''}`} aria-expanded={menu === 'folder'} aria-haspopup="dialog" title={folder || undefined} onClick={() => setMenu(menu === 'folder' ? null : 'folder')}><Folder size={12}/><span className="chip-label">{!folder ? 'Folder' : !name.trim() && !folderEdited ? shortPath(parentOf(folder)) : shortPath(folder)}</span><ChevronDown size={12}/></button>
        {menu === 'folder' && <div className="chip-menu down folder-menu" role="dialog" aria-label="Project folder">
          <p>Blocks are saved here as files you can open in other apps.</p>
          <input value={folder} onChange={event => { setFolder(event.target.value); setFolderEdited(true); }} aria-label="Folder path" spellCheck={false} autoComplete="off" autoFocus onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setMenu(null); } }}/>
          {(picker || (folderEdited && suggestion)) && <div className="folder-menu-row">
            {picker && chooser(chosen => { setFolder(chosen); setFolderEdited(true); if (!name.trim()) setName(folderName(chosen)); setMenu(null); })}
            {folderEdited && suggestion && <button type="button" className="chip-button" onClick={() => { setFolder(suggestion.path); setFolderEdited(false); }}>Back to the suggestion</button>}
          </div>}
        </div>}
      </span>}
      {from.kind === 'folder' && picker && chooser(setPath)}
      <span className="chip-slot">
        <button type="button" className="chip-button" aria-expanded={menu === 'from'} aria-haspopup="menu" onClick={() => setMenu(menu === 'from' ? null : 'from')}><span className="chip-label">Start from · {fromLabel}</span><ChevronDown size={12}/></button>
        {menu === 'from' && <div className="chip-menu down from-menu" role="menu" aria-label="Start from">
          <button type="button" role="menuitemradio" aria-checked={from.kind === 'blank'} onClick={() => { onFrom(blank); setMenu(null); }}><span className="chip-check">{from.kind === 'blank' && <Check size={13}/>}</span><span className="chip-menu-label">Blank</span><span className="chip-menu-cap">An empty map</span></button>
          <button type="button" role="menuitemradio" aria-checked={from.kind === 'folder'} onClick={openFolderMode}><span className="chip-check">{from.kind === 'folder' && <Check size={13}/>}</span><span className="chip-menu-label">Open a folder…</span><span className="chip-menu-cap">One you already have</span></button>
        </div>}
      </span>
      <span className="pc-sp"/>
      {onCancel && <button type="button" className="chip-button" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="primary" data-testid="create-project" disabled={busy || !ready}>{busy && <LoaderCircle size={14} className="spin"/>}{action}</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>;
}

/** The screen before any project: the card, and the other doors as pills. What the
 *  first run connected shows as a quiet pill too; ROS downloading to this computer shows in the corner, as on every page. */
export function StartScreen({ focusKey, tools = 0, onTools, ...handlers }: Handlers & { focusKey?: number; tools?: number; onTools?: () => void }) {
  const [from, setFrom] = useState<StartFrom>(blank);
  const [cloud, setCloud] = useState<CloudAccountStatus>();
  useEffect(() => {
    const look = () => void api<CloudAccountStatus>('/api/cloud').then(setCloud).catch(() => undefined);
    look(); window.addEventListener('ros-cloud-changed', look);
    return () => window.removeEventListener('ros-cloud-changed', look);
  }, []);
  // The local server starts the sign-in and sends a new tab on to ros.ai cloud; the account row in the sidebar follows it.
  const signIn = () => { window.open('/api/cloud/start', '_blank', 'noopener'); setTimeout(cloudAccountChanged, 800); };
  return <div className="start-screen">
    <div className="start-column">
      <span className="start-ring"><RosMark/></span>
      <h1>Start a project</h1>
      <p className="start-lead">{`A project is a folder on ${thisComputer}. Everything on its map is saved there as files you can open elsewhere.`}</p>
      <ProjectCard verb="Start" from={from} onFrom={setFrom} focusKey={focusKey} {...handlers}/>
      <div className="start-pills">
        {from.kind !== 'folder' && <button type="button" className="chip-button" onClick={() => setFrom({ kind: 'folder' })}><FolderOpen size={12}/>Open a folder on {thisComputer}</button>}
        {cloud?.available && cloud.state !== 'signed-in' && <button type="button" className="chip-button" onClick={signIn}>Sign in to ros.ai</button>}
        {tools > 0 && <button type="button" className="chip-button" onClick={onTools}><span className="chip-dot"/>{tools} tool{tools === 1 ? '' : 's'} connected</button>}
      </div>
    </div>
  </div>;
}

/** New project over the current map: the same card under a light scrim, so nothing jumps. Enter creates; Esc or a click outside cancels. */
export function NewProjectCard({ onClose, ...handlers }: Handlers & { onClose: () => void }) {
  const [from, setFrom] = useState<StartFrom>(blank), card = useRef<HTMLDivElement>(null);
  // Focus goes back where it was when the card closes; the card's own input takes it before any effect runs.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => previous?.focus(), [previous]);
  const trap = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const focusable = [...(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [])], first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="new-project-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="new-project-card" role="dialog" aria-modal="true" aria-label="New project" ref={card} onKeyDown={trap}>
      <ProjectCard caption="New project" verb="Create" from={from} onFrom={setFrom} onCancel={onClose} {...handlers}/>
    </div>
  </div>;
}
