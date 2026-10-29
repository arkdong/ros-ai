import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Check, ChevronDown, LoaderCircle, MessagesSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AssistantState, AssistantThreadSummary, AssistantTurn } from '../shared/assistant';
import { time } from './Content';
import { readSaved } from './persistence';
import { openOnPress } from './press';

/** Which thread the bar and the panel show: a thread's id, or null for a new thread that has not started yet. */
export type ShownThread = string | null;

export const threadsOf = (state: AssistantState | null): AssistantThreadSummary[] => state?.threads ?? [];

/** The thread for a saved choice: the chosen one while it exists, else the one with the newest activity; null is a new thread. */
export function shownThread(state: AssistantState | null, choice: string | null | undefined): ShownThread {
  if (choice === null) return null;
  const threads = threadsOf(state);
  if (choice && threads.some(thread => thread.id === choice)) return choice;
  return threads[0]?.id ?? null;
}

/** The turn the person archived last in a thread; a newer finished turn reads as unread until they archive it too.
 * A project from before threads keeps what its one conversation had archived. */
export function seenTurn(projectId: string, threadId: string) {
  return readSaved<string>(`ros-seen-turn:${projectId}:${threadId}`, readSaved<string>(`ros-seen-turn:${projectId}`, ''));
}
export const seenKey = (projectId: string, threadId: string) => `ros-seen-turn:${projectId}:${threadId}`;
const unread = (projectId: string, thread: AssistantThreadSummary) => Boolean(thread.last && !thread.running && thread.last.turnId !== seenTurn(projectId, thread.id));

const ended: Record<AssistantTurn['status'], string> = { running: 'Working', completed: 'Done', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' };
/** A thread's state in one line: what it is doing, what waits for the person, or how its last turn ended and when. */
function threadState(thread: AssistantThreadSummary) {
  if (thread.running) return `Working${thread.step ? ` · ${thread.step}` : ''}`;
  if (thread.waiting) return `${thread.waiting} ${thread.waiting === 1 ? 'change' : 'changes'} waiting`;
  if (thread.last) return `${ended[thread.last.status]} · ${time(thread.last.at)}`;
  return thread.outside ? 'Your own agent' : 'No reply yet';
}

/** Closes a menu on a press outside it or on Escape, the way the model and approval menus do. */
function useMenuDismiss(open: boolean, close: () => void, menu: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
}

/** The one menu behind the bar's threads button and the panel's thread chip: New thread, then every thread with its state. */
function ThreadRows({ projectId, threads, current, onChoose, extra }: { projectId: string; threads: AssistantThreadSummary[]; current: ShownThread; onChoose: (thread: ShownThread) => void; extra?: ReactNode }) {
  return <>
    <button type="button" role="menuitem" className="ros-thread-new" aria-current={current === null ? 'true' : undefined} onClick={() => onChoose(null)}><Plus size={16}/><span className="ros-menu-label">New thread</span>{current === null && <Check size={14}/>}</button>
    {threads.length > 0 && <><hr/><div className="ros-menu-group">
      <p>Threads</p>
      {threads.map(thread => {
        const chosen = thread.id === current, fresh = !chosen && unread(projectId, thread);
        return <button key={thread.id} type="button" role="menuitemradio" aria-checked={chosen} className="ros-thread-row" title={thread.title} onClick={() => onChoose(thread.id)}>
          <span className="ros-thread-state" aria-hidden="true">{thread.running ? <LoaderCircle size={14} className="spin"/> : thread.waiting ? <span className="ros-dot"/> : fresh ? <span className="ros-dot new"/> : null}</span>
          <span className="ros-menu-label"><span className="ros-thread-title">{thread.title}</span><small>{threadState(thread)}{fresh ? <span className="sr-only"> · not yet read</span> : null}</small></span>
          {chosen && <Check size={14}/>}
        </button>;
      })}
    </div></>}
    {extra}
  </>;
}

/** The bar's threads button: a badge counts the threads working elsewhere; a dot marks a reply not read yet. */
export function RosThreadsButton({ state, projectId, current, onChoose }: { state: AssistantState | null; projectId: string; current: ShownThread; onChoose: (thread: ShownThread) => void }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useMenuDismiss(menu, () => setMenu(false), menuRef, trigger);
  const threads = threadsOf(state), others = threads.filter(thread => thread.id !== current);
  const working = others.filter(thread => thread.running).length, fresh = others.some(thread => unread(projectId, thread));
  const label = `Threads${working ? ` · ${working} working elsewhere` : fresh ? ' · a reply to read' : ''}`;
  const choose = (thread: ShownThread) => { setMenu(false); onChoose(thread); };
  return <div className="ros-threads">
    <button ref={trigger} type="button" className="icon-button ros-threads-button" aria-haspopup="menu" aria-expanded={menu} aria-label={label} title={label} data-testid="ros-threads" {...openOnPress(() => setMenu(value => !value))}>
      <MessagesSquare size={15}/>
      {working > 0 ? <span className="ros-threads-badge">{working}</span> : fresh ? <span className="ros-threads-badge dot" aria-hidden="true"/> : null}
    </button>
    {menu && <div ref={menuRef} className="ros-model-menu ros-thread-menu" role="menu" aria-label="Threads"><ThreadRows projectId={projectId} threads={threads} current={current} onChoose={choose}/></div>}
  </div>;
}

/** The panel's thread chip: the thread's name opens the same menu, with Rename and Delete for this thread; beside it,
 * how many other threads are working. Rename and Delete happen in the chip's place. */
export function RosThreadChip({ state, projectId, current, onChoose, onRename, onDelete }: { state: AssistantState | null; projectId: string; current: ShownThread; onChoose: (thread: ShownThread) => void; onRename: (threadId: string, title: string) => Promise<unknown>; onDelete: (threadId: string) => Promise<unknown> }) {
  const [menu, setMenu] = useState(false), [editing, setEditing] = useState<'rename' | 'delete' | null>(null), [name, setName] = useState('');
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useMenuDismiss(menu, () => setMenu(false), menuRef, trigger);
  const threads = threadsOf(state), thread = threads.find(item => item.id === current);
  const working = threads.filter(item => item.id !== current && item.running).length;
  const title = thread?.title ?? 'New thread';
  const choose = (next: ShownThread) => { setMenu(false); onChoose(next); };
  const saveName = () => { const value = name.trim(); setEditing(null); if (thread && value && value !== thread.title) void onRename(thread.id, value); };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); saveName(); } else if (event.key === 'Escape') { event.preventDefault(); setEditing(null); } };
  if (editing === 'rename' && thread) return <input className="ros-thread-rename" aria-label="Thread name" value={name} autoFocus maxLength={120} onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} onKeyDown={keys} onBlur={saveName}/>;
  if (editing === 'delete' && thread) return <span className="ros-thread-confirm" role="alertdialog" aria-label={`Delete the thread ${title}?`}><span>Delete “{title}”?</span><button type="button" className="text-button small ros-thread-danger" onClick={() => { setEditing(null); void onDelete(thread.id); }}>Delete</button><button type="button" className="text-button small" onClick={() => setEditing(null)}>Cancel</button></span>;
  return <>
    <div className="ros-model ros-thread-chip">
      <button ref={trigger} type="button" className="ros-chip-button" aria-haspopup="menu" aria-expanded={menu} title={`${title} · switch thread`} data-testid="ros-thread-chip" {...openOnPress(() => setMenu(value => !value))}><span>{title}</span><ChevronDown size={11}/></button>
      {menu && <div ref={menuRef} className="ros-model-menu ros-thread-menu down" role="menu" aria-label="Threads"><ThreadRows projectId={projectId} threads={threads} current={current} onChoose={choose} extra={thread && <><hr/>
        <button type="button" role="menuitem" onClick={() => { setMenu(false); setName(thread.title); setEditing('rename'); }}><Pencil size={14}/><span className="ros-menu-label">Rename</span></button>
        <button type="button" role="menuitem" disabled={thread.running} title={thread.running ? 'Stop the thread before deleting it' : undefined} onClick={() => { setMenu(false); setEditing('delete'); }}><Trash2 size={14}/><span className="ros-menu-label">Delete{thread.running ? <small>Stop it first</small> : null}</span></button>
      </>}/></div>}
    </div>
    {working > 0 && <button type="button" className="ros-thread-working" title={`${working} other ${working === 1 ? 'thread is' : 'threads are'} working`} onClick={() => setMenu(true)}><LoaderCircle size={11} className="spin"/>{working} working</button>}
  </>;
}
