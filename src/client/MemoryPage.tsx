import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, LoaderCircle } from 'lucide-react';
import { MEMORY_KINDS, MEMORY_LIMITS, type MemoryEntry, type MemoryKind, type PersonalMemoryState } from '../shared/personal-memory';
import { api, post } from './api';
import { RosMark } from './RosDock';
import { message } from './ModelPage';
import './memory.css';

const when = (at: string) => at ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
const kindLabel = (kind: MemoryKind) => MEMORY_KINDS.find(item => item.kind === kind)!.label;
type Decision = 'keep' | 'forget';

/** One line, where it came from, and the one action that fits its state. */
function MemoryLineRow({ entry, busy, onDecide, showKind }: { entry: MemoryEntry; busy: boolean; onDecide: (id: string, decision: Decision) => void; showKind?: boolean }) {
  const date = when(entry.at);
  return <div className={`memory-line ${entry.status}`}>
    <div className="memory-line-body"><p>{entry.text}</p><small>{showKind ? `${kindLabel(entry.kind)} · ` : ''}{entry.from}{date ? ` · ${date}` : ''}</small></div>
    {entry.status === 'proposed'
      ? <><button type="button" className="primary small" disabled={busy} onClick={() => onDecide(entry.id, 'keep')}>Keep</button><button type="button" className="text-button" disabled={busy} onClick={() => onDecide(entry.id, 'forget')}>Not this</button></>
      : <button type="button" className="text-button" disabled={busy} onClick={() => onDecide(entry.id, 'forget')}>Forget</button>}
  </div>;
}

/** Settings › Memory: the switch, the lines waiting for a decision, the kept lines by subject, and the files. */
export function MemoryPage({ publicDemo }: { publicDemo: boolean }) {
  const [state, setState] = useState<PersonalMemoryState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<MemoryKind>('style'), [text, setText] = useState('');
  const refresh = useCallback(async () => {
    if (publicDemo) return;
    try { setState(await api<PersonalMemoryState>('/api/memory')); setError(''); } catch (cause) { setError(message(cause)); }
  }, [publicDemo]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (work: () => Promise<unknown>) => { setBusy(true); try { await work(); await refresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  if (publicDemo) return <p className="rail-page-note">This demo keeps no memory of its own. In the local workspace, Ros remembers how you work.</p>;
  if (!state) return error ? <p className="inline-error" role="alert">{error}</p> : <p className="rail-page-note"><LoaderCircle size={14} className="spin"/> Reading memory…</p>;
  const decide = (id: string, decision: Decision) => void run(() => post(`/api/memory/${id}`, { decision }));
  const waiting = state.entries.filter(entry => entry.status === 'proposed');
  const kept = (value: MemoryKind) => state.entries.filter(entry => entry.status === 'kept' && entry.kind === value);
  return <div className="memory-page" data-testid="memory-page">
    {error && <p className="inline-error" role="alert">{error}</p>}
    <section className="memory-panel memory-switch">
      <button type="button" role="switch" aria-checked={state.enabled} aria-label="Ros remembers how you work" className={`switch ${state.enabled ? 'on' : ''}`} disabled={busy} onClick={() => void run(() => api('/api/memory', { method: 'PUT', body: JSON.stringify({ enabled: !state.enabled }) }))}><span/></button>
      <div>
        <h2>Ros remembers how you work</h2>
        <p>Taste, habits, people and commitments Ros notices while you work on the map. Each line waits for you under the project's permission choice, and every agent that works on your map gets the kept lines as your preferences. Project memory (the question, decisions and findings) is separate and stays with each project.</p>
        {!state.enabled && <p className="memory-off">Off: nothing is proposed or shared. The lines below stay in your files.</p>}
      </div>
    </section>
    {waiting.length > 0 && <>
      <h3 className="rail-section-title memory-waiting-title"><span className="ros-dot" aria-hidden="true"/>Waiting for you · {waiting.length}</h3>
      <section className="memory-panel memory-list" aria-label="Waiting for you">{waiting.map(entry => <MemoryLineRow key={entry.id} entry={entry} busy={busy} onDecide={decide} showKind/>)}</section>
    </>}
    {MEMORY_KINDS.map(item => {
      const lines = kept(item.kind);
      return <div key={item.kind}>
        <h3 className="rail-section-title">{item.title}{lines.length ? ` · ${lines.length}` : ''}</h3>
        {lines.length ? <section className="memory-panel memory-list" aria-label={item.title}>{lines.map(entry => <MemoryLineRow key={entry.id} entry={entry} busy={busy} onDecide={decide}/>)}</section> : <p className="memory-empty">{item.about} Nothing kept yet.</p>}
      </div>;
    })}
    <h3 className="rail-section-title">Tell Ros something to remember</h3>
    <form className="memory-panel memory-add" onSubmit={event => { event.preventDefault(); if (!text.trim() || busy) return; void run(async () => { await post('/api/memory', { kind, text: text.trim() }); setText(''); }); }}>
      <label className="sr-only" htmlFor="memory-kind">Kind</label>
      <select id="memory-kind" value={kind} onChange={event => setKind(event.target.value as MemoryKind)}>{MEMORY_KINDS.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select>
      <label className="sr-only" htmlFor="memory-text">What to remember</label>
      <input id="memory-text" value={text} maxLength={MEMORY_LIMITS.text} onChange={event => setText(event.target.value)} placeholder="One sentence, in your own words"/>
      <button type="submit" className="primary small" disabled={busy || !text.trim()}>Add</button>
    </form>
    <footer className="memory-footer">
      <p><FolderOpen size={14}/><span>Saved as Markdown you can open and edit: <code>{state.folder}</code></span><button type="button" className="text-button" disabled={busy} onClick={() => void run(() => post('/api/memory/open'))}>Open folder</button></p>
      <p>Reaches Ros in every project, and Claude Code, Codex or any agent connected over MCP, labelled as your preferences and never as instructions. Nothing leaves this computer.</p>
    </footer>
  </div>;
}

/** Under a reply: the lines Ros noticed in that turn, each with the one action that fits its state now. */
export function RememberCard({ remembered, person, onChanged }: { remembered: { id: string; kind: MemoryKind; text: string }[]; person?: PersonalMemoryState; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const decide = async (id: string, decision: Decision) => {
    setBusy(true); setError('');
    try { await post(`/api/memory/${id}`, { decision }); onChanged?.(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const entries = remembered.map(line => person?.entries.find(entry => entry.id === line.id));
  const proposed = entries.some(entry => entry?.status === 'proposed');
  return <div className="assistant-action memory-card" data-testid="memory-card">
    <div className="assistant-action-title"><RosMark/><strong>{proposed ? 'Ros noticed' : 'Remembered'}</strong><span>{person?.enabled === false ? 'Memory off' : proposed ? 'Waiting for you' : 'Memory'}</span></div>
    {remembered.map((line, index) => {
      const entry = entries[index];
      return entry ? <MemoryLineRow key={line.id} entry={entry} busy={busy} onDecide={(id, decision) => void decide(id, decision)} showKind/> : <div key={line.id} className="memory-line gone"><div className="memory-line-body"><p>{line.text}</p><small>{kindLabel(line.kind)} · not kept</small></div></div>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
