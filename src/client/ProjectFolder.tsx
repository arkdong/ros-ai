import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, AppWindow, ChevronDown, Code2, Folder, FolderOpen, FolderSearch, LoaderCircle, Plus, RotateCcw, SquareTerminal } from 'lucide-react';
import type { FolderChoice, FolderFile, FolderSuggestion, OpenApp, ProjectFolderStatus, UnplacedFile } from '../shared/project-folders';
import type { CanvasNode } from '../shared/types';
import { api, post } from './api';
import './project-folder.css';

const fileApp = /Mac/i.test(navigator.userAgent) ? 'Finder' : 'your files';
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const quiet = (status: ProjectFolderStatus) => JSON.stringify({ ...status, checkedAt: undefined });

/** Follows the open project's folder. An edit saved in another app raises the project revision, which reloads the canvas. */
export function useProjectFolder(projectId: string | null, revision: number | undefined, enabled: boolean, onOutsideChange: () => void) {
  const [status, setStatus] = useState<ProjectFolderStatus | null>(null), [epoch, setEpoch] = useState(0);
  const latest = useRef({ revision, onOutsideChange }); latest.current = { revision, onOutsideChange };
  const shown = useRef('');
  const show = (next: ProjectFolderStatus | null) => { const key = next ? quiet(next) : ''; if (key !== shown.current) { shown.current = key; setStatus(next); } };
  useEffect(() => show(null), [projectId]);
  useEffect(() => {
    if (!projectId || !enabled) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const next = await api<ProjectFolderStatus>(`/api/projects/${projectId}/folder`);
        if (stopped) return;
        show(next);
        if (latest.current.revision !== undefined && next.revision > latest.current.revision) latest.current.onOutsideChange();
        // Only a project with a folder is checked again, and less often while the tab is hidden.
        if (next.attached) timer = setTimeout(check, document.visibilityState === 'visible' ? 2000 : 10000);
      } catch { if (!stopped) timer = setTimeout(check, 10000); }
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [projectId, enabled, epoch]);
  return { status, update: show, reload: () => setEpoch(value => value + 1) };
}

/** A folder path the person can type, or pick in the computer's own folder window. */
export function FolderField({ id, value, onChange, picker, placeholder }: { id: string; value: string; onChange: (path: string, picked: boolean) => void; picker: boolean; placeholder?: string }) {
  const [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  const choose = async () => {
    setChoosing(true); setError('');
    try {
      // The folder window stays open while the person looks around, so this request waits longer than most.
      const choice = await api<FolderChoice>('/api/folders/choose', { method: 'POST', body: JSON.stringify(value.trim() ? { path: value.trim() } : {}), signal: AbortSignal.timeout(11 * 60_000) });
      if ('path' in choice) onChange(choice.path, true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChoosing(false); }
  };
  return <>
    <div className="folder-field"><input id={id} value={value} onChange={event => onChange(event.target.value, false)} placeholder={placeholder} spellCheck={false} autoComplete="off"/>
      {picker && <button type="button" className="secondary" disabled={choosing} onClick={() => void choose()}>{choosing ? <LoaderCircle size={14} className="spin"/> : <FolderSearch size={14}/>} Choose…</button>}</div>
    {error && <p className="inline-error">{error}</p>}
  </>;
}

/** Fetches where ros.ai would put a new project's folder, and whether this computer has a folder window. */
export function useFolderSuggestion(name: string, enabled: boolean) {
  const [suggestion, setSuggestion] = useState<FolderSuggestion | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const timer = setTimeout(() => void api<FolderSuggestion>(`/api/folders/suggest?name=${encodeURIComponent(name.trim())}`).then(next => { if (current) setSuggestion(next); }).catch(() => undefined), suggestion ? 250 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [name, enabled]);
  return suggestion;
}

export function FolderChip({ status, onClick }: { status: ProjectFolderStatus; onClick: () => void }) {
  if (!status.attached) return <button className="folder-chip unattached" onClick={onClick} title="Keep this project's blocks as files in a folder"><Folder size={13}/><span>Choose a folder</span></button>;
  const issues = (status.available === false ? 1 : 0) + status.files.filter(file => file.missing).length + status.problems.length;
  return <button className={`folder-chip ${issues ? 'attention' : ''}`} onClick={onClick} title={status.available === false ? status.reason : status.path}>
    {issues ? <AlertTriangle size={13}/> : <FolderOpen size={13}/>}<span>{folderName(status.path ?? '')}</span>
    {status.unplaced.length > 0 && <small>{status.unplaced.length} new</small>}
  </button>;
}

const kindNames: Record<UnplacedFile['kind'], string> = { note: 'Note', code: 'Code', notebook: 'Notebook', dataset: 'Dataset', pdf: 'PDF, added as its text' };
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function FolderPanel({ projectId, projectTitle, status, nodes, onStatus, onChanged, onOpenFolder, onRemoveBlock }: {
  projectId: string; projectTitle: string; status: ProjectFolderStatus; nodes: CanvasNode[];
  onStatus: (status: ProjectFolderStatus) => void; onChanged: () => Promise<unknown>;
  onOpenFolder: (path: string) => Promise<boolean>; onRemoveBlock: (nodeId: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const suggestion = useFolderSuggestion(projectTitle, !status.attached || status.available === false);
  const [path, setPath] = useState(''), [edited, setEdited] = useState(false);
  useEffect(() => { if (!edited && !status.attached && suggestion) setPath(suggestion.path); }, [suggestion, edited, status.attached]);
  const work = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await fn(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(''); }
  };
  const title = (file: FolderFile) => nodes.find(node => node.id === file.nodeId)?.title ?? file.path;
  const missing = status.files.filter(file => file.missing);
  const picker = Boolean(suggestion?.picker);

  if (!status.attached) return <div className="folder-panel">
    <p className="modal-description">Keep this project's notes, code, notebooks and data as ordinary files in a folder, so you can open them in apps like Obsidian, VS Code or Jupyter. Edits saved there come back into ros.ai and can be undone.</p>
    <label className="field-label" htmlFor="project-folder-path">Folder</label>
    <FolderField id="project-folder-path" value={path} picker={picker} placeholder="~/Documents/ros.ai/My project" onChange={next => { setPath(next); setEdited(true); }}/>
    <p className="subtle">ros.ai creates the folder if it does not exist yet.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="primary" disabled={Boolean(busy) || !path.trim()} onClick={() => void work('attach', async () => { onStatus(await post<ProjectFolderStatus>(`/api/projects/${projectId}/folder`, { path: path.trim() })); await onChanged(); })}>{busy === 'attach' ? <LoaderCircle size={14} className="spin"/> : <FolderOpen size={14}/>} Use this folder</button></div>
  </div>;

  if (status.available === false) return <div className="folder-panel">
    <p className="folder-warning" role="status"><AlertTriangle size={15}/> {status.reason}</p>
    <p className="subtle">It was at <code>{status.path}</code>. ros.ai reconnects on its own if the folder comes back there.</p>
    <label className="field-label" htmlFor="project-folder-reconnect">Its new place</label>
    <FolderField id="project-folder-reconnect" value={path} picker={picker} placeholder="~/Documents/ros.ai/My project" onChange={next => { setPath(next); setEdited(true); }}/>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="primary" disabled={Boolean(busy) || !path.trim()} onClick={() => void work('reconnect', () => onOpenFolder(path.trim()))}>{busy === 'reconnect' ? <LoaderCircle size={14} className="spin"/> : <FolderOpen size={14}/>} Reconnect folder</button></div>
  </div>;

  return <div className="folder-panel">
    <div className="folder-location"><code title={status.path}>{status.path}</code><OpenIn projectId={projectId} onError={cause => setError(cause instanceof Error ? cause.message : String(cause))}/></div>
    <p className="subtle">Each block is a file here. Edits you save in other apps appear in ros.ai within a few seconds and can be undone.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {missing.length > 0 && <section className="folder-section"><h3>Missing files</h3><p className="subtle">These files were deleted or moved out of the folder. The blocks keep their content.</p>
      {missing.map(file => <div className="folder-row" key={file.nodeId}><span><strong>{title(file)}</strong><small>{file.path}</small></span>
        <button className="secondary small" disabled={Boolean(busy)} onClick={() => void work(file.nodeId, async () => { onStatus(await post<ProjectFolderStatus>(`/api/projects/${projectId}/folder/restore`, { nodeId: file.nodeId })); })}><RotateCcw size={13}/> Put the file back</button>
        <button className="text-button small" disabled={Boolean(busy)} onClick={() => void work(file.nodeId, () => onRemoveBlock(file.nodeId))}>Remove block</button></div>)}
    </section>}
    {status.unplaced.length > 0 && <section className="folder-section"><h3>Files not on the canvas</h3><p className="subtle">Add a file to work with it in ros.ai. Nothing is added on its own.</p>
      {status.unplaced.map(file => <div className="folder-row" key={file.path}><span><strong>{folderName(file.path)}</strong><small>{file.path} · {kindNames[file.kind]} · {size(file.bytes)}</small></span>
        <button className="secondary small" disabled={Boolean(busy)} onClick={() => void work(file.path, async () => { await post(`/api/projects/${projectId}/folder/add`, { path: file.path }); await onChanged(); })}>{busy === file.path ? <LoaderCircle size={13} className="spin"/> : <Plus size={13}/>} Add to canvas</button></div>)}
    </section>}
    {status.problems.length > 0 && <section className="folder-section"><h3>Needs a look</h3>
      {status.problems.map(problem => <div className="folder-row" key={`${problem.path}:${problem.message}`}><span><strong>{problem.path === '.' ? 'Project folder' : problem.path}</strong><small>{problem.message}</small></span></div>)}
    </section>}
  </div>;
}

/** The block's file, with ways to open it outside ros.ai. */
export function FileBar({ projectId, file, onError }: { projectId: string; file: FolderFile; onError: (cause: unknown) => void }) {
  return <div className="file-bar"><FolderOpen size={13}/><code title={file.path}>{file.path}</code>
    {file.missing ? <span className="file-missing">File missing</span> : <OpenIn projectId={projectId} nodeId={file.nodeId} onError={onError}/>}
  </div>;
}

// Installed apps change rarely, so one lookup serves the whole session.
let apps: Promise<OpenApp[]> | null = null;
/** One "Open in" button whose menu lists the editors and terminals on this computer, the default app and the file manager. */
export function OpenIn({ projectId, nodeId, onError, label = 'Open in' }: { projectId: string; nodeId?: string; onError: (cause: unknown) => void; label?: string }) {
  const [open, setOpen] = useState(false), [list, setList] = useState<OpenApp[]>([]), box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) void (apps ??= api<OpenApp[]>('/api/open-apps').catch(() => { apps = null; return []; })).then(setList); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away); return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const go = (how: string) => { setOpen(false); void post(`/api/projects/${projectId}/folder/open`, { ...(nodeId ? { nodeId } : {}), with: how }).catch(onError); };
  const item = (how: string, icon: ReactNode, text: string) => <button key={how} type="button" role="menuitem" onClick={() => go(how)}>{icon}{text}</button>;
  const editors = list.filter(app => app.kind === 'editor'), terminals = list.filter(app => app.kind === 'terminal');
  return <div className="open-in" ref={box} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="secondary small open-in-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><FolderOpen size={13}/> {label} <ChevronDown size={13}/></button>
    {open && <div className="open-in-menu" role="menu">
      {editors.map(app => item(app.id, <Code2 size={15}/>, app.label))}
      {item('default', <AppWindow size={15}/>, 'Default app')}
      {terminals.map(app => item(app.id, <SquareTerminal size={15}/>, app.label))}
      <hr/>
      {item('reveal', <Folder size={15}/>, `Show in ${fileApp}`)}
    </div>}
  </div>;
}
