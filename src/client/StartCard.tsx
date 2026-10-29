import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Folder, FolderOpen, FolderSearch, LoaderCircle } from 'lucide-react';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { FolderChoice } from '../shared/project-folders';
import type { TutorialCatalog, TutorialScenario } from '../shared/tutorial';
import { api } from './api';
import { RosMark } from './RosDock';
import { cloudAccountChanged } from './ProfileButton';
import { gb, useLocalRos } from './Setup';
import { folderName, useFolderSuggestion } from './ProjectFolder';
import './chip-menu.css';
import './start-card.css';

/** Where a new project starts: an empty map, a folder that already exists, or one of the demos. */
export type StartFrom = { kind: 'blank' } | { kind: 'folder' } | { kind: 'demo'; scenario: TutorialScenario };
const blank: StartFrom = { kind: 'blank' };

const thisComputer = /Mac/i.test(navigator.userAgent) ? 'this Mac' : 'this computer';
/** A path the way the Mac shows it: the home folder as ~. */
const shortPath = (path: string) => path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, '~');
/** The folder a path sits in, with a trailing separator. */
const parentOf = (path: string) => { const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return at > 0 ? path.slice(0, at + 1) : path; };
/** A demo by the name its project gets, without the Demo prefix. */
const demoName = (scenario: TutorialScenario) => scenario.projectTitle.replace(/^Demo · /, '');

/** The demos this computer has, for the Start from menu and the gallery. */
function useScenarios() {
  const [scenarios, setScenarios] = useState<TutorialScenario[] | null>(null);
  useEffect(() => { void api<TutorialCatalog>('/api/demo-scenarios').then(next => setScenarios(next.scenarios)).catch(() => setScenarios([])); }, []);
  return scenarios;
}

type Handlers = {
  onCreate: (title: string, folder?: string) => Promise<void>;
  onOpenFolder: (path: string) => Promise<boolean>;
  onDemo: (scenario: TutorialScenario, folder?: string) => Promise<void>;
};

/** One card in the bar's shape: the name on top, the folder and the starting point as chips on the footer line, one black action.
 *  The folder follows the name until the person types or picks their own; Enter submits. */
export function ProjectCard({ caption, verb, folders, scenarios, from, onFrom, onCancel, focusKey, onCreate, onOpenFolder, onDemo }: Handlers & { caption?: string; verb: 'Start' | 'Create'; folders: boolean; scenarios: TutorialScenario[] | null; from: StartFrom; onFrom: (from: StartFrom) => void; onCancel?: () => void; focusKey?: number }) {
  const [name, setName] = useState(''), [path, setPath] = useState(''), [busy, setBusy] = useState(false), [menu, setMenu] = useState<'folder' | 'from' | null>(null);
  const [folder, setFolder] = useState(''), [folderEdited, setFolderEdited] = useState(false), [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  const foot = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null);
  const demo = from.kind === 'demo' ? from.scenario : undefined;
  const suggestion = useFolderSuggestion(demo ? demo.projectTitle : name.trim() || 'Untitled', folders && from.kind !== 'folder');
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
      const target = folders && folder.trim() ? folder.trim() : undefined;
      if (from.kind === 'folder') await onOpenFolder(path.trim());
      else if (demo) await onDemo(demo, target);
      else await onCreate(name.trim(), target);
    } finally { setBusy(false); }
  };
  // Esc closes an open menu and stays there; without one it reaches the card's owner.
  const keys = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu) { event.stopPropagation(); setMenu(null); } };
  const fromLabel = from.kind === 'blank' ? 'Blank' : from.kind === 'folder' ? 'A folder' : demoName(from.scenario);
  const action = from.kind === 'folder' ? 'Open' : demo ? `${verb} from demo` : verb;
  const chooser = (onPath: (path: string) => void) => <button type="button" className="chip-button" disabled={choosing} onClick={() => void choose(onPath)}>{choosing ? <LoaderCircle size={12} className="spin"/> : <FolderSearch size={12}/>}Choose…</button>;
  return <form className="project-card" onSubmit={submit} onKeyDown={keys}>
    {caption && <div className="pc-caption">{caption}</div>}
    {from.kind === 'folder'
      ? <input ref={field} className="pc-name mono" data-testid="project-folder" value={path} onChange={event => setPath(event.target.value)} placeholder="~/Documents/My research" aria-label="Folder to open" spellCheck={false} autoComplete="off" autoFocus/>
      : <input ref={field} className="pc-name" data-testid="project-name" value={demo ? demo.projectTitle : name} onChange={event => setName(event.target.value)} readOnly={Boolean(demo)} placeholder="Untitled" aria-label="Project name" maxLength={160} autoFocus/>}
    <div className="pc-foot" ref={foot}>
      {folders && from.kind !== 'folder' && <span className="chip-slot">
        <button type="button" className={`chip-button${folder ? ' set' : ''}`} aria-expanded={menu === 'folder'} aria-haspopup="dialog" title={folder || undefined} onClick={() => setMenu(menu === 'folder' ? null : 'folder')}><Folder size={12}/><span className="chip-label">{!folder ? 'Folder' : !demo && !name.trim() && !folderEdited ? shortPath(parentOf(folder)) : shortPath(folder)}</span><ChevronDown size={12}/></button>
        {menu === 'folder' && <div className="chip-menu down folder-menu" role="dialog" aria-label="Project folder">
          <p>{demo ? 'The demo is built here, as files.' : 'Blocks are saved here as files you can open in other apps.'}</p>
          <input value={folder} onChange={event => { setFolder(event.target.value); setFolderEdited(true); }} aria-label="Folder path" spellCheck={false} autoComplete="off" autoFocus onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setMenu(null); } }}/>
          {(picker || (folderEdited && suggestion)) && <div className="folder-menu-row">
            {picker && chooser(chosen => { setFolder(chosen); setFolderEdited(true); if (!demo && !name.trim()) setName(folderName(chosen)); setMenu(null); })}
            {folderEdited && suggestion && <button type="button" className="chip-button" onClick={() => { setFolder(suggestion.path); setFolderEdited(false); }}>Back to the suggestion</button>}
          </div>}
        </div>}
      </span>}
      {from.kind === 'folder' && picker && chooser(setPath)}
      <span className="chip-slot">
        <button type="button" className="chip-button" aria-expanded={menu === 'from'} aria-haspopup="menu" onClick={() => setMenu(menu === 'from' ? null : 'from')}><span className="chip-label">Start from · {fromLabel}</span><ChevronDown size={12}/></button>
        {menu === 'from' && <div className="chip-menu down from-menu" role="menu" aria-label="Start from">
          <button type="button" role="menuitemradio" aria-checked={from.kind === 'blank'} onClick={() => { onFrom(blank); setMenu(null); }}><span className="chip-check">{from.kind === 'blank' && <Check size={13}/>}</span><span className="chip-menu-label">Blank</span><span className="chip-menu-cap">An empty map</span></button>
          {folders && <button type="button" role="menuitemradio" aria-checked={from.kind === 'folder'} onClick={openFolderMode}><span className="chip-check">{from.kind === 'folder' && <Check size={13}/>}</span><span className="chip-menu-label">Open a folder…</span><span className="chip-menu-cap">One you already have</span></button>}
          {scenarios && scenarios.length > 0 && <>
            <p className="chip-menu-heading">Demos</p>
            {scenarios.map(scenario => <button key={scenario.id} type="button" role="menuitemradio" aria-checked={demo?.id === scenario.id} disabled={scenario.available === false} title={scenario.available === false ? scenario.unavailableReason : undefined} onClick={() => { onFrom({ kind: 'demo', scenario }); setMenu(null); }}><span className="chip-check">{demo?.id === scenario.id && <Check size={13}/>}</span><span className="chip-menu-label">{demoName(scenario)}</span><span className="chip-menu-cap">{scenario.steps} steps</span></button>)}
          </>}
        </div>}
      </span>
      <span className="pc-sp"/>
      {onCancel && <button type="button" className="chip-button" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="primary" data-testid="create-project" disabled={busy || !ready}>{busy && <LoaderCircle size={14} className="spin"/>}{action}</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>;
}

/** The screen before any project: the card, the other doors as pills, and a gallery of the demos that exist. What the
 *  first run did shows as quiet pills too: the tools connected, and ROS downloading to this computer. */
export function StartScreen({ folders, focusKey, tools = 0, onTools, ...handlers }: Handlers & { folders: boolean; focusKey?: number; tools?: number; onTools?: () => void }) {
  const scenarios = useScenarios(), [from, setFrom] = useState<StartFrom>(blank);
  const [cloud, setCloud] = useState<CloudAccountStatus>();
  const local = useLocalRos(folders).status;
  useEffect(() => {
    const look = () => void api<CloudAccountStatus>('/api/cloud').then(setCloud).catch(() => undefined);
    look(); window.addEventListener('ros-cloud-changed', look);
    return () => window.removeEventListener('ros-cloud-changed', look);
  }, []);
  // The local server starts the sign-in and sends a new tab on to ros.ai cloud; the account row in the sidebar follows it.
  const signIn = () => { window.open('/api/cloud/start', '_blank', 'noopener'); setTimeout(cloudAccountChanged, 800); };
  const demos = scenarios?.filter(scenario => scenario.available !== false) ?? [];
  const selected = from.kind === 'demo' ? from.scenario.id : undefined;
  return <div className="start-screen">
    <div className="start-column">
      <span className="start-ring"><RosMark/></span>
      <h1>Start a project</h1>
      <p className="start-lead">{folders ? `A project is a folder on ${thisComputer}. Everything on its map is saved there as files you can open elsewhere.` : 'A project is a map of blocks. On this demo server it is saved for this browser only.'}</p>
      <ProjectCard verb="Start" folders={folders} scenarios={scenarios} from={from} onFrom={setFrom} focusKey={focusKey} {...handlers}/>
      <div className="start-pills">
        {folders && from.kind !== 'folder' && <button type="button" className="chip-button" onClick={() => setFrom({ kind: 'folder' })}><FolderOpen size={12}/>Open a folder on {thisComputer}</button>}
        {cloud?.available && cloud.state !== 'signed-in' && <button type="button" className="chip-button" onClick={signIn}>Sign in to ros.ai</button>}
        {tools > 0 && <button type="button" className="chip-button" onClick={onTools}><span className="chip-dot"/>{tools} tool{tools === 1 ? '' : 's'} connected</button>}
        {local && (local.state === 'downloading' || local.state === 'starting') && <button type="button" className="chip-button" onClick={onTools}>{local.state === 'starting' ? 'ROS is getting ready' : `ROS is downloading${local.totalBytes ? ` · ${gb(local.doneBytes)} of ${gb(local.totalBytes)}` : ''}`}{local.state === 'downloading' && <span className="setup-bar" aria-hidden="true"><i style={{ width: `${local.totalBytes ? Math.min(100, Math.round(((local.doneBytes ?? 0) / local.totalBytes) * 100)) : 0}%` }}/></span>}</button>}
        {local?.state === 'failed' && <button type="button" className="chip-button" onClick={onTools}>The ROS download stopped</button>}
      </div>
    </div>
    {demos.length > 0 && <section className="start-gallery" aria-label="Demos">
      <div className="start-gallery-head"><h2>Or start from a demo</h2><span className="start-cap">A finished map, built step by step</span></div>
      <div className="start-gallery-row">
        {demos.map(scenario => <button key={scenario.id} type="button" className={`demo-card${selected === scenario.id ? ' selected' : ''}`} aria-pressed={selected === scenario.id} onClick={() => setFrom(selected === scenario.id ? blank : { kind: 'demo', scenario })}>
          <span className="demo-map" aria-hidden="true">{Array.from({ length: scenario.steps }, (_, index) => <span key={index}/>)}{selected === scenario.id && <span className="demo-check"><Check size={11}/></span>}</span>
          <span className="demo-card-text"><strong>{demoName(scenario)}</strong><span className="start-cap">Demo · {scenario.steps} steps</span></span>
        </button>)}
      </div>
    </section>}
  </div>;
}

/** New project over the current map: the same card under a light scrim, so nothing jumps. Enter creates; Esc or a click outside cancels. */
export function NewProjectCard({ folders, onClose, ...handlers }: Handlers & { folders: boolean; onClose: () => void }) {
  const scenarios = useScenarios(), [from, setFrom] = useState<StartFrom>(blank), card = useRef<HTMLDivElement>(null);
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
      <ProjectCard caption="New project" verb="Create" folders={folders} scenarios={scenarios} from={from} onFrom={setFrom} onCancel={onClose} {...handlers}/>
    </div>
  </div>;
}
