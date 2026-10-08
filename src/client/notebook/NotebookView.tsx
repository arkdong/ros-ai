import { memo, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MutableRefObject } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Eraser, FastForward, FileUp, LoaderCircle, NotebookPen, Play, Plus, RotateCcw, ShieldCheck, Square, Trash2, Undo2 } from 'lucide-react';
import type { ApprovalMode } from '../../shared/research';
import type { Artifact, CanvasNode, ProjectDetail } from '../../shared/types';
import type { FolderFile } from '../../shared/project-folders';
import { NOTEBOOK_LIMITS, errorLine, type NotebookApproval, type NotebookCell, type NotebookCellEdit, type NotebookEvent, type NotebookKernel, type NotebookRunResult, type NotebookState } from '../../shared/notebooks';
import { api, post } from '../api';
import { CodeEditor, modKey, type CodeEditorApi, type ErrorMark } from '../code';
import type { CodeContext } from '../code/context';
import { FileBar } from '../ProjectFolder';
import { ResultActions } from '../ResultActions';
import { modeLabel } from '../ResearchControls';
import { Markdown } from './markdown';
import { OutputView } from './outputs';
import './notebook.css';

/** This window, so the server can tell it apart from other windows and apps editing the notebook. */
const CLIENT = crypto.randomUUID();
const CONTEXT: CodeContext = { runtime: 'notebook', columns: null, paramKeys: [] };
const newCellId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const blank = (type: 'code' | 'markdown'): NotebookCell => type === 'code'
  ? { id: newCellId(), cell_type: 'code', source: '', metadata: {}, outputs: [], execution_count: null }
  : { id: newCellId(), cell_type: 'markdown', source: '', metadata: {} };
const edits = (cells: NotebookCell[]): NotebookCellEdit[] => cells.map(({ id, cell_type, source, metadata }) => ({ id, cell_type, source, metadata }));
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const conflicted = (cause: unknown) => (cause as { status?: number }).status === 409 && message(cause).includes('changed in another window');

type Approval = NotebookApproval & { source: string; rest: string[] };
type Handlers = {
  focused(id: string, target: EventTarget): void; left(id: string, event: FocusEvent): void;
  change(id: string, source: string): void; run(id: string): void; runAndAdvance(id: string): void;
  escape(id: string): void; edge(id: string, direction: 'up' | 'down'): boolean; editText(id: string): void;
  move(id: string, by: number): void; retype(id: string, type: 'code' | 'markdown'): void; remove(id: string): void;
  approve(): void; decline(): void; permissions(): void; saveOutput(id: string, index: number): void;
};
type Props = {
  node: CanvasNode; detail: ProjectDetail; file?: FolderFile; mode?: ApprovalMode;
  onClose(): void; onRefresh(): Promise<unknown>; onError(cause: unknown): void; onPermissions(): void;
  onOpenArtifact(artifact: Artifact): void; onReport(artifact: Artifact): void; onInterpret(artifact: Artifact, destinationId: string): void;
};

/** A Notebook block, opened over the canvas: cells run one at a time in this notebook's own Python in the Docker sandbox. */
export function NotebookView({ node, detail, file, mode: chosenMode, onClose, onRefresh, onError, onPermissions, onOpenArtifact, onReport, onInterpret }: Props) {
  const base = `/api/projects/${encodeURIComponent(detail.project.id)}/nodes/${encodeURIComponent(node.id)}/notebook`;
  const [state, setState] = useState<NotebookState | null>(null), [loadError, setLoadError] = useState('');
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [kernel, setKernel] = useState<NotebookKernel>({ status: 'off', session: null, executionCount: 0 });
  const [queue, setQueue] = useState<Record<string, 'queued' | 'running'>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null), [editing, setEditing] = useState<string | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [saving, setSaving] = useState<'saved' | 'saving' | 'unsaved' | 'failed'>('saved');
  const [conflict, setConflict] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(''), [deleted, setDeleted] = useState<{ cell: NotebookCell; index: number }[]>([]);
  const [focusTick, setFocusTick] = useState(0);

  const cellsRef = useRef<NotebookCell[]>([]), revision = useRef(0), changes = useRef(0), stored = useRef(0), conflictRef = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve()), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editors = useRef(new Map<string, MutableRefObject<CodeEditorApi | null>>()), elements = useRef(new Map<string, HTMLDivElement>());
  const elementRefs = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const ran = useRef(new Map<string, string>()), focusRequest = useRef<{ id: string; at?: 'start' | 'end' } | null>(null);
  const queueRef = useRef(queue), lastKey = useRef({ key: '', at: 0 }), alive = useRef(true), fileInput = useRef<HTMLInputElement>(null);
  const refreshRef = useRef(onRefresh);
  queueRef.current = queue; refreshRef.current = onRefresh;
  conflictRef.current = conflict;
  const unsaved = () => changes.current !== stored.current;

  const show = (next: NotebookCell[]) => { cellsRef.current = next; setCells(next); };
  const patch = (id: string, update: (cell: NotebookCell) => NotebookCell) => show(cellsRef.current.map(cell => cell.id === id ? update(cell) : cell));
  const failed = (cause: unknown) => { if (conflicted(cause)) { setConflict(true); setSaving('unsaved'); } else setError(message(cause)); };
  // Writes go one at a time, each against the newest revision this window knows.
  const write = (task: () => Promise<void>) => { const next = writes.current.then(task).catch(failed); writes.current = next; return next; };
  const persist = async () => {
    if (!unsaved() || conflictRef.current) return;
    const at = changes.current;
    setSaving('saving');
    try {
      const result = await api<{ revision: number }>(base, { method: 'PUT', body: JSON.stringify({ base: revision.current, client: CLIENT, cells: edits(cellsRef.current) }) });
      revision.current = result.revision; stored.current = at;
      setSaving(unsaved() ? 'unsaved' : 'saved');
    } catch (cause) { setSaving('failed'); throw cause; }
  };
  const save = () => { clearTimeout(timer.current); return write(persist); };
  const edit = (update: (current: NotebookCell[]) => NotebookCell[]) => {
    const next = update(cellsRef.current);
    if (next === cellsRef.current) return;
    show(next); changes.current++; setSaving('unsaved');
    clearTimeout(timer.current);
    if (!conflictRef.current) timer.current = setTimeout(() => void save(), 800);
  };
  const forget = (id: string) => setSaved(current => Object.keys(current).some(key => key.startsWith(`${id}/`)) ? Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${id}/`))) : current);

  const load = useCallback(async (check = false) => {
    const value = await api<NotebookState>(`${base}${check ? '?check=1' : ''}`);
    if (!alive.current) return null;
    setState(value); setKernel(value.kernel); setSaved(value.saved); setLoadError('');
    setQueue(Object.fromEntries(value.queue.map(item => [item.cellId, item.state])));
    if (!unsaved()) { show(value.notebook.cells); revision.current = value.notebook.revision; setSaving('saved'); }
    else {
      // Unsaved edits stay; outputs that arrived meanwhile are taken from the server.
      const server = new Map(value.notebook.cells.map(cell => [cell.id, cell]));
      show(cellsRef.current.map(cell => { const fresh = server.get(cell.id); return fresh?.cell_type === 'code' && cell.cell_type === 'code' ? { ...cell, outputs: fresh.outputs, execution_count: fresh.execution_count } : cell; }));
    }
    return value;
  }, [base]);

  const apply = (event: NotebookEvent) => {
    if (event.type === 'kernel') { setKernel(event.kernel); return; }
    if (event.type === 'notebook') {
      if (event.client === CLIENT || event.revision <= revision.current) return;
      if (unsaved()) { setConflict(true); return; }
      void load().then(value => { if (value?.previous && value.previous.reason === event.reason) setNotice(event.reason); }).catch(failed);
      return;
    }
    const id = event.cellId;
    if (event.type === 'cell') {
      setQueue(current => { const next = { ...current }; if (event.state === 'queued' || event.state === 'running') next[id] = event.state; else delete next[id]; return next; });
      if (event.state === 'running') { patch(id, cell => ({ ...cell, outputs: [], execution_count: null })); forget(id); }
      else if (event.state === 'done') patch(id, cell => ({ ...cell, execution_count: event.executionCount ?? null }));
    } else if (event.type === 'output') patch(id, cell => ({ ...cell, outputs: [...(cell.outputs ?? []), event.output] }));
    else if (event.type === 'stream') patch(id, cell => {
      const outputs = [...(cell.outputs ?? [])], last = outputs.at(-1);
      if (last?.output_type === 'stream' && last.name === event.name) outputs[outputs.length - 1] = { ...last, text: last.text + event.text };
      else outputs.push({ output_type: 'stream', name: event.name, text: event.text });
      return { ...cell, outputs };
    });
    else if (event.type === 'clear') { patch(id, cell => ({ ...cell, outputs: [], ...(queueRef.current[id] === 'running' ? {} : { execution_count: null }) })); forget(id); }
  };
  const applyRef = useRef(apply); applyRef.current = apply;

  useEffect(() => {
    alive.current = true;
    void load().then(value => {
      const first = value?.notebook.cells[0];
      if (!first) return;
      // A new notebook opens ready to type.
      if (value.notebook.cells.length === 1 && first.cell_type === 'code' && !first.source) requestFocus(first.id);
      else setSelected(first.id);
    }).catch(cause => setLoadError(message(cause)));
    const events = new EventSource(`${base}/events`);
    let opened = false;
    // After a dropped connection, the notebook is read again so no output is missed.
    events.onopen = () => { if (opened) void load().catch(() => undefined); opened = true; };
    events.onmessage = item => { let event: NotebookEvent; try { event = JSON.parse(item.data) as NotebookEvent; } catch { return; } applyRef.current(event); };
    const leaving = () => {
      if (!unsaved() || conflictRef.current) return;
      void fetch(base, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: revision.current, client: CLIENT, cells: edits(cellsRef.current) }) }).catch(() => undefined);
    };
    window.addEventListener('pagehide', leaving);
    return () => {
      alive.current = false; events.close(); window.removeEventListener('pagehide', leaving);
      clearTimeout(timer.current);
      // Closing the notebook saves what was typed, then the canvas card shows the newest cells and run.
      void (unsaved() ? write(persist) : writes.current).then(() => refreshRef.current()).catch(() => undefined);
    };
  // The notebook is read once per block; later reads follow server events.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // Focus waits for the cell's editor, which loads with the first notebook opened. It starts a frame
  // later, after React's development mode has replaced a just-mounted editor with its second copy.
  useEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    let tries = 0;
    const attempt = () => {
      const editor = editors.current.get(request.id)?.current;
      if (editor) { if (focusRequest.current === request) focusRequest.current = null; editor.focus(request.at); }
      else if (tries++ < 120) frame = requestAnimationFrame(attempt);
    };
    let frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [focusTick]);
  const requestFocus = (id: string, at?: 'start' | 'end') => { focusRequest.current = { id, ...(at ? { at } : {}) }; setSelected(id); setEditing(id); setFocusTick(tick => tick + 1); };
  const focusCell = (id: string) => {
    setSelected(id); setEditing(null);
    requestAnimationFrame(() => { const element = elements.current.get(id); element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: 'nearest' }); });
  };

  const runCells = (ids: string[], approve?: Record<string, string>) => write(async () => {
    clearTimeout(timer.current);
    const list = ids.filter(id => { const cell = cellsRef.current.find(item => item.id === id); return cell?.cell_type === 'code' && Boolean(cell.source.trim()); });
    if (!list.length || conflictRef.current) return;
    for (const id of list) ran.current.set(id, cellsRef.current.find(item => item.id === id)!.source);
    const pending = unsaved(), at = changes.current;
    setApproval(null); setError('');
    const result = await post<NotebookRunResult>(`${base}/run`, { run: list, ...(pending ? { base: revision.current, client: CLIENT, cells: edits(cellsRef.current) } : {}), ...(approve ? { approve } : {}) });
    revision.current = result.revision;
    if (pending) { stored.current = at; setSaving(unsaved() ? 'unsaved' : 'saved'); }
    if (result.approval) {
      const index = list.indexOf(result.approval.cellId);
      setApproval({ ...result.approval, source: cellsRef.current.find(item => item.id === result.approval!.cellId)?.source ?? '', rest: index < 0 ? [] : list.slice(index + 1) });
    }
  });
  const insert = (type: 'code' | 'markdown', where: 'above' | 'below', anchor: string | null, enter: boolean) => {
    if (cellsRef.current.length >= NOTEBOOK_LIMITS.cells) { setError(`Notebooks are limited to ${NOTEBOOK_LIMITS.cells} cells.`); return; }
    const cell = blank(type);
    edit(current => {
      const index = anchor ? current.findIndex(item => item.id === anchor) : current.length - 1;
      const next = [...current];
      next.splice(index < 0 ? current.length : where === 'above' ? index : index + 1, 0, cell);
      return next;
    });
    if (enter) requestFocus(cell.id); else focusCell(cell.id);
  };
  const runAndAdvance = (id: string) => {
    const index = cellsRef.current.findIndex(cell => cell.id === id), cell = cellsRef.current[index];
    if (!cell) return;
    if (cell.cell_type === 'code') void runCells([id]);
    const next = cellsRef.current[index + 1];
    if (next) focusCell(next.id); else insert('code', 'below', id, true);
  };
  const remove = (id: string) => {
    const index = cellsRef.current.findIndex(cell => cell.id === id);
    if (index < 0) return;
    setDeleted(stack => [...stack.slice(-19), { cell: cellsRef.current[index], index }]);
    const neighbor = cellsRef.current[index + 1] ?? cellsRef.current[index - 1];
    edit(current => { const next = current.filter(cell => cell.id !== id); return next.length ? next : [blank('code')]; });
    if (approval?.cellId === id) setApproval(null);
    focusCell(neighbor?.id ?? cellsRef.current[0].id);
  };
  const undoDelete = () => {
    const last = deleted.at(-1);
    if (!last) return;
    setDeleted(stack => stack.slice(0, -1));
    if (cellsRef.current.some(cell => cell.id === last.cell.id)) return;
    edit(current => { const next = [...current]; next.splice(Math.min(last.index, next.length), 0, last.cell); return next; });
    focusCell(last.cell.id);
  };
  const move = (id: string, by: number) => edit(current => {
    const index = current.findIndex(cell => cell.id === id), target = index + by;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const retype = (id: string, type: 'code' | 'markdown') => edit(current => current.some(cell => cell.id === id && cell.cell_type !== type)
    ? current.map(cell => cell.id !== id ? cell : type === 'code' ? { id: cell.id, cell_type: 'code', source: cell.source, metadata: cell.metadata, outputs: [], execution_count: null } : { id: cell.id, cell_type: 'markdown', source: cell.source, metadata: cell.metadata })
    : current);
  const kernelAction = (name: 'interrupt' | 'restart') => {
    setApproval(null); setBusy(name);
    void post<NotebookKernel>(`${base}/${name}`).then(value => { setKernel(value); if (name === 'restart') ran.current.clear(); }).catch(failed).finally(() => setBusy(''));
  };
  const clearOutputs = () => write(async () => {
    await post(`${base}/clear`, {});
    for (const cell of cellsRef.current) if (cell.cell_type === 'code' && queueRef.current[cell.id] !== 'running') patch(cell.id, item => ({ ...item, outputs: [], execution_count: null }));
    setSaved({});
  });
  const importFile = (chosen: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!chosen) return;
    if (!/\.ipynb$/iu.test(chosen.name)) { setError('Choose a Jupyter notebook (.ipynb) file.'); return; }
    if (chosen.size > NOTEBOOK_LIMITS.fileBytes) { setError(`Notebooks are limited to ${NOTEBOOK_LIMITS.fileBytes / 1_000_000} MB.`); return; }
    setBusy('import');
    void write(async () => {
      await persist();
      await post(`${base}/import`, { name: chosen.name, content: await chosen.text() });
      const value = await load();
      if (value?.notebook.cells[0]) focusCell(value.notebook.cells[0].id);
      setNotice(value?.previous?.reason ?? '');
      setApproval(null); setDeleted([]);
    }).finally(() => setBusy(''));
  };
  const restore = () => {
    setBusy('restore');
    void write(async () => { await post(`${base}/restore`); setNotice(''); await load(); }).finally(() => setBusy(''));
  };
  const resolveConflict = (keep: boolean) => {
    setConflict(false); conflictRef.current = false;
    void write(async () => {
      const value = await api<NotebookState>(base);
      if (keep) { revision.current = value.notebook.revision; await persist(); }
      else { stored.current = changes.current; await load(); }
    });
  };
  const saveOutput = (id: string, index: number) => {
    setBusy(`save:${id}/${index}`);
    void post<Artifact>(`${base}/outputs`, { cellId: id, index })
      .then(artifact => { setSaved(current => ({ ...current, [`${id}/${index}`]: artifact.id })); return onRefresh(); })
      .catch(failed).finally(() => setBusy(''));
  };

  const handlers = useRef<Handlers>(null!);
  handlers.current = {
    focused: (id, target) => { setSelected(id); setEditing(target instanceof Element && target.closest('.cm-editor, .code-editor-fallback') ? id : null); },
    left: (id, event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setEditing(current => current === id ? null : current); },
    change: (id, source) => edit(current => current.map(cell => cell.id === id ? { ...cell, source } : cell)),
    run: id => { const cell = cellsRef.current.find(item => item.id === id); if (cell?.cell_type === 'code') void runCells([id]); else focusCell(id); },
    runAndAdvance,
    escape: focusCell,
    edge: (id, direction) => {
      const index = cellsRef.current.findIndex(cell => cell.id === id), neighbor = cellsRef.current[index + (direction === 'up' ? -1 : 1)];
      if (!neighbor) return false;
      if (neighbor.cell_type !== 'code' && neighbor.source.trim()) focusCell(neighbor.id);
      else requestFocus(neighbor.id, direction === 'up' ? 'end' : 'start');
      return true;
    },
    editText: id => requestFocus(id),
    move, retype, remove,
    approve: () => { if (approval) void runCells([approval.cellId, ...approval.rest], { [approval.cellId]: approval.fingerprint }); },
    decline: () => setApproval(null),
    permissions: onPermissions,
    saveOutput,
  };

  // Jupyter's command mode: keys act on the selected cell while no editor has focus.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Escape from an editor selects its cell (command mode); Escape in command mode returns to the canvas.
    if (event.key === 'Escape' && target.closest('.nb-cell') && !target.closest('.cm-editor') && !target.classList.contains('nb-cell')) { event.preventDefault(); if (selected) focusCell(selected); return; }
    if (!selected || !target.classList.contains('nb-cell') || event.altKey) return;
    const index = cellsRef.current.findIndex(cell => cell.id === selected), key = event.key.toLowerCase(), modified = event.metaKey || event.ctrlKey;
    const go = (by: number) => { const next = cellsRef.current[index + by]; if (next) focusCell(next.id); };
    const actions: Record<string, () => void> = modified ? { enter: () => handlers.current.run(selected) } : event.shiftKey ? { enter: () => runAndAdvance(selected) } : {
      enter: () => requestFocus(selected), arrowup: () => go(-1), k: () => go(-1), arrowdown: () => go(1), j: () => go(1),
      a: () => insert('code', 'above', selected, false), b: () => insert('code', 'below', selected, false),
      m: () => retype(selected, 'markdown'), y: () => retype(selected, 'code'), z: undoDelete,
      d: () => { if (lastKey.current.key === 'd' && Date.now() - lastKey.current.at < 800) { lastKey.current = { key: '', at: 0 }; remove(selected); } else lastKey.current = { key: 'd', at: Date.now() }; },
    };
    const action = actions[key];
    if (!action) return;
    event.preventDefault();
    if (key !== 'd') lastKey.current = { key: '', at: 0 };
    action();
  };

  const codeIds = useMemo(() => cells.filter(cell => cell.cell_type === 'code').map(cell => cell.id), [cells]);
  const active = Object.keys(queue).length > 0, runtime = state?.runtime, mode = chosenMode ?? state?.mode;
  const pristine = cells.length === 1 && !cells[0].source && !cells[0].outputs?.length;
  const kernelLabel = kernel.status === 'busy' ? 'Running' : kernel.status === 'starting' ? 'Starting Python…' : kernel.status === 'idle' ? 'Python ready' : 'Python off';
  const kernelTitle = kernel.python ? `Python ${kernel.python}${Object.entries(kernel.libraries ?? {}).map(([name, version]) => ` · ${name} ${version}`).join('')}` : 'Python starts when you run a cell, and keeps variables until it restarts.';

  if (!state) return <section className="notebook-view" aria-label={`Notebook ${node.title}`}>
    <header className="nb-header"><button className="secondary small" onClick={onClose}><ArrowLeft size={14}/> Canvas</button><div className="nb-title"><NotebookPen size={17}/><h2>{node.title}</h2></div></header>
    <div className="nb-loading">{loadError ? <p className="inline-error" role="alert">{loadError}</p> : <><LoaderCircle size={18} className="spin"/> Opening notebook…</>}</div>
  </section>;
  return <section className="notebook-view" aria-label={`Notebook ${node.title}`}>
    <header className="nb-header">
      <button className="secondary small" onClick={onClose} title="Back to the canvas. Python keeps running."><ArrowLeft size={14}/> Canvas</button>
      <div className="nb-title"><NotebookPen size={17}/><h2 title={node.title}>{node.title}</h2></div>
      {file && <FileBar projectId={detail.project.id} file={file} onError={onError}/>}
    </header>
    <div className="nb-toolbar" role="toolbar" aria-label="Notebook actions">
      <button className="primary small" disabled={!selected} onClick={() => selected && runAndAdvance(selected)} title="Run the selected cell and move on (Shift+Enter)"><Play size={14}/> Run</button>
      <button className="secondary small" disabled={!codeIds.length} onClick={() => void runCells(codeIds)} title="Run every cell from the top"><FastForward size={14}/> Run all</button>
      <button className="secondary small" disabled={!active || busy === 'interrupt'} onClick={() => kernelAction('interrupt')} title="Stop the running cell"><Square size={13}/> Stop</button>
      <button className="secondary small" disabled={kernel.status === 'off' || busy === 'restart'} onClick={() => kernelAction('restart')} title="Restart Python. Variables are cleared; outputs stay.">{busy === 'restart' ? <LoaderCircle size={14} className="spin"/> : <RotateCcw size={14}/>} Restart</button>
      <span className="nb-separator"/>
      <button className="secondary small" onClick={() => insert('code', 'below', selected, true)} title="Add a code cell below (B)"><Plus size={14}/> Code</button>
      <button className="secondary small" onClick={() => insert('markdown', 'below', selected, true)} title="Add a text cell below"><Plus size={14}/> Text</button>
      {deleted.length > 0 && <button className="secondary small" onClick={undoDelete} title="Bring back the last deleted cell (Z)"><Undo2 size={14}/> Undo delete</button>}
      <span className="nb-separator"/>
      <button className="text-button small" disabled={active} onClick={() => void clearOutputs()} title="Clear every output and run number"><Eraser size={14}/> Clear outputs</button>
      <button className="text-button small" disabled={busy === 'import'} onClick={() => fileInput.current?.click()} title="Replace this notebook with a .ipynb file. Undo brings this version back.">{busy === 'import' ? <LoaderCircle size={14} className="spin"/> : <FileUp size={14}/>} Import .ipynb</button>
      <input ref={fileInput} type="file" accept=".ipynb,application/x-ipynb+json,application/json" hidden onChange={event => importFile(event.target.files?.[0])}/>
      <span className="nb-status">
        <span className={`nb-kernel ${kernel.status}`} title={kernelTitle}>{(kernel.status === 'busy' || kernel.status === 'starting') && <LoaderCircle size={12} className="spin"/>}{kernelLabel}</span>
        {mode && <button className="text-button small nb-mode" onClick={onPermissions} title="Who approves code before it runs"><ShieldCheck size={13}/> {modeLabel(mode)}</button>}
        <span className={`nb-save ${saving}`}>{saving === 'saving' ? 'Saving…' : saving === 'unsaved' ? 'Unsaved changes' : saving === 'failed' ? 'Not saved' : 'Saved'}</span>
      </span>
    </div>
    <div className="nb-banners">
      {runtime && !runtime.available && <div className="nb-banner warning" role="status"><span>{runtime.reason}</span><button className="secondary small" onClick={() => void load(true).catch(failed)}>Check again</button></div>}
      {kernel.status === 'off' && kernel.message && <div className="nb-banner" role="status"><span>{kernel.message}</span></div>}
      {conflict && <div className="nb-banner warning" role="alert"><span>This notebook changed in another window or app while you were editing.</span><button className="secondary small" onClick={() => resolveConflict(false)}>Use the new version</button><button className="text-button small" onClick={() => resolveConflict(true)}>Keep mine</button></div>}
      {notice && <div className="nb-banner" role="status"><span>{notice}.</span>{state.previous && <button className="secondary small" disabled={busy === 'restore'} onClick={restore}><Undo2 size={13}/> Undo</button>}<button className="text-button small" onClick={() => setNotice('')}>Dismiss</button></div>}
      {error && <div className="nb-banner error" role="alert"><span>{error}</span><button className="text-button small" onClick={() => setError('')}>Dismiss</button></div>}
    </div>
    <div className="nb-scroll">
      <div className="nb-cells" onKeyDown={onKeyDown}>
        {pristine && <p className="nb-hint">Write Python below and press <kbd>Shift</kbd>+<kbd>Enter</kbd> to run it. Variables carry from cell to cell until Python restarts. You can also <button className="text-button" onClick={() => fileInput.current?.click()}>import a .ipynb file</button>.</p>}
        {cells.map((cell, index) => <CellView key={cell.id} cell={cell} index={index} last={index === cells.length - 1} selected={cell.id === selected} editing={cell.id === editing}
          state={queue[cell.id]} approval={approval?.cellId === cell.id && approval.source === cell.source ? approval : null} mode={mode} ranSource={ran.current.get(cell.id)}
          saved={saved} busy={busy} detail={detail} on={handlers} editorRef={editorRef(editors.current, cell.id)} element={elementRef(elementRefs.current, elements.current, cell.id)}
          onOpenArtifact={onOpenArtifact} onReport={onReport} onInterpret={onInterpret} onRefresh={onRefresh}/>)}
        <div className="nb-add"><button className="secondary small" onClick={() => insert('code', 'below', cells.at(-1)?.id ?? null, true)}><Plus size={14}/> Code</button><button className="secondary small" onClick={() => insert('markdown', 'below', cells.at(-1)?.id ?? null, true)}><Plus size={14}/> Text</button></div>
        <footer className="nb-footer">
          <p>Python runs in ros.ai’s Docker sandbox with no network. {state.outputs ? <>It can read this project’s folder and save files in <code>{state.outputs}/</code>.</> : 'It can save files in /tmp only, because this project has no folder.'}</p>
          <p><kbd>Shift</kbd>+<kbd>Enter</kbd> runs a cell · <kbd>{modKey === '⌘' ? '⌘' : 'Ctrl'}</kbd>+<kbd>Enter</kbd> runs it in place · <kbd>Esc</kbd> then <kbd>A</kbd> or <kbd>B</kbd> adds a cell, <kbd>M</kbd> or <kbd>Y</kbd> makes it text or code, <kbd>D</kbd><kbd>D</kbd> deletes, <kbd>Z</kbd> brings it back</p>
        </footer>
      </div>
    </div>
  </section>;
}

function editorRef(map: Map<string, MutableRefObject<CodeEditorApi | null>>, id: string) {
  let ref = map.get(id);
  if (!ref) { ref = { current: null }; map.set(id, ref); }
  return ref;
}
function elementRef(refs: Map<string, (element: HTMLDivElement | null) => void>, map: Map<string, HTMLDivElement>, id: string) {
  let ref = refs.get(id);
  if (!ref) { ref = element => { if (element) map.set(id, element); else { map.delete(id); refs.delete(id); } }; refs.set(id, ref); }
  return ref;
}

type CellProps = {
  cell: NotebookCell; index: number; last: boolean; selected: boolean; editing: boolean; state?: 'queued' | 'running';
  approval: Approval | null; mode?: ApprovalMode; ranSource?: string; saved: Record<string, string>; busy: string; detail: ProjectDetail;
  on: MutableRefObject<Handlers>; editorRef: MutableRefObject<CodeEditorApi | null>; element: (element: HTMLDivElement | null) => void;
  onOpenArtifact(artifact: Artifact): void; onReport(artifact: Artifact): void; onInterpret(artifact: Artifact, destinationId: string): void; onRefresh(): Promise<unknown>;
};
/** One cell. Cells that did not change keep their editor untouched while others stream output. */
const CellView = memo(function CellView({ cell, index, last, selected, editing, state, approval, mode, ranSource, saved, busy, detail, on, editorRef, element, onOpenArtifact, onReport, onInterpret, onRefresh }: CellProps) {
  const code = cell.cell_type === 'code', outputs = cell.outputs ?? [];
  const failure = outputs.find(output => output.output_type === 'error');
  const line = failure && ranSource === cell.source ? errorLine(failure, cell.execution_count) : null;
  const errors = useMemo<ErrorMark[]>(() => line && failure?.output_type === 'error' ? [{ line, column: null, primary: true, message: `${failure.ename}: ${failure.evalue}` }] : [], [line, failure]);
  const label = code ? `Code cell ${index + 1}` : `Text cell ${index + 1}`;
  const editor = (language: string) => <CodeEditor apiRef={editorRef} ariaLabel={label} value={cell.source} language={language} context={CONTEXT} lineNumbers={false} errors={errors}
    maxLength={NOTEBOOK_LIMITS.cellSourceCharacters} autoFocus={!code} placeholder={code ? undefined : 'Write text. Markdown works: # heading, **bold**, - list'}
    onChange={value => on.current.change(cell.id, value)} onRun={() => on.current.run(cell.id)} onShiftEnter={() => on.current.runAndAdvance(cell.id)}
    onEscape={() => on.current.escape(cell.id)} onEdge={direction => on.current.edge(cell.id, direction)}/>;
  return <div ref={element} className={`nb-cell ${cell.cell_type}${selected ? ' selected' : ''}${editing ? ' editing' : ''}${state ? ` ${state}` : ''}`} tabIndex={-1} aria-label={label}
    onFocus={event => on.current.focused(cell.id, event.target)} onBlur={event => on.current.left(cell.id, event)}>
    <div className="nb-gutter">
      {code && <button className="nb-run" aria-label={`Run ${label}`} title="Run this cell (Shift+Enter)" onClick={() => on.current.run(cell.id)}>{state === 'running' ? <LoaderCircle size={14} className="spin"/> : <Play size={13}/>}</button>}
      {code && <span className="nb-count" title={state === 'running' ? 'Running' : state === 'queued' ? 'Waiting to run' : cell.execution_count ? `Run number ${cell.execution_count}` : 'Not run yet'}>[{state ? '*' : cell.execution_count ?? ' '}]</span>}
    </div>
    <div className="nb-main">
      {code ? editor('python') : editing || !cell.source.trim()
        ? editing ? editor(cell.cell_type === 'markdown' ? 'markdown' : 'text') : <button className="nb-empty-text" onClick={() => on.current.editText(cell.id)}>Empty text cell. Click to write.</button>
        : <div className="nb-rendered" onDoubleClick={() => on.current.editText(cell.id)} title="Double-click to edit">{cell.cell_type === 'markdown' ? <Markdown text={cell.source} attachments={cell.attachments}/> : <pre className="nb-text">{cell.source}</pre>}</div>}
      {approval && <div className="nb-approval" role="group" aria-label="Approval needed">
        <strong><ShieldCheck size={15}/> Check this cell before it runs</strong>
        <p>{approval.reason}</p>
        <div className="row gap wrap"><button className="primary small" onClick={() => on.current.approve()}><Play size={13}/> Run this cell{approval.rest.length ? ` and ${approval.rest.length} more` : ''}</button><button className="secondary small" onClick={() => on.current.decline()}>Don’t run</button>
          {mode !== 'full' && <button className="text-button small" onClick={() => on.current.permissions()}>Change permissions</button>}</div>
      </div>}
      {outputs.length > 0 && <div className="nb-outputs" aria-label={`Output of ${label}`}>{outputs.map((output, at) => {
        const savedId = saved[`${cell.id}/${at}`], artifact = savedId ? detail.artifacts.find(item => item.id === savedId) : undefined;
        const actions = output.output_type === 'error' || state ? undefined : artifact
          ? <ResultActions artifact={artifact} detail={detail} onChanged={onRefresh} onOpen={onOpenArtifact} onReport={onReport} onInterpret={onInterpret}/>
          : savedId ? <small className="subtle">Saved as a result</small>
          : <button className="text-button small" disabled={busy === `save:${cell.id}/${at}`} onClick={() => on.current.saveOutput(cell.id, at)} title="Keep this output as a result you can use as input or in a report">{busy === `save:${cell.id}/${at}` ? 'Saving…' : 'Save as result'}</button>;
        return <OutputView key={at} output={output} actions={actions}/>;
      })}</div>}
    </div>
    {selected && <div className="nb-cell-tools" role="toolbar" aria-label={`${label} tools`}>
      <button className="icon-button" aria-label="Move cell up" title="Move up" disabled={index === 0} onClick={() => on.current.move(cell.id, -1)}><ArrowUp size={14}/></button>
      <button className="icon-button" aria-label="Move cell down" title="Move down" disabled={last} onClick={() => on.current.move(cell.id, 1)}><ArrowDown size={14}/></button>
      <button className="text-button small" title={code ? 'Make this a text cell (M)' : 'Make this a code cell (Y)'} onClick={() => on.current.retype(cell.id, code ? 'markdown' : 'code')}>{code ? 'Text' : 'Code'}</button>
      <button className="icon-button" aria-label="Delete cell" title="Delete (D D)" onClick={() => on.current.remove(cell.id)}><Trash2 size={14}/></button>
    </div>}
  </div>;
});
