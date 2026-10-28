import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { MEMORY_KINDS, MEMORY_LIMITS, type MemoryEntry, type MemoryKind, type PersonalMemoryState } from '../shared/personal-memory';
import { api, post } from './api';
import { ChipChoice } from './ChipChoice';
import { RosMark } from './RosDock';
import { message } from './ModelPage';
import { Row } from './SettingsPage';
import './memory.css';

const when = (at: string) => at ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
const kindLabel = (kind: MemoryKind) => MEMORY_KINDS.find(item => item.kind === kind)!.label;
type Decision = 'keep' | 'forget';

/** One line, where it came from, and the one action that fits its state. */
function MemoryLineRow({ entry, busy, onDecide, showKind }: { entry: MemoryEntry; busy: boolean; onDecide: (id: string, decision: Decision) => void; showKind?: boolean }) {
  const date = when(entry.at);
  return <div className={`settings-row memory-line ${entry.status}`}>
    <div><strong>{entry.text}</strong><small>{showKind ? `${kindLabel(entry.kind)} · ` : ''}{entry.from}{date ? ` · ${date}` : ''}</small></div>
    <div className="settings-row-control">{entry.status === 'proposed'
      ? <><button type="button" className="primary small" disabled={busy} onClick={() => onDecide(entry.id, 'keep')}>Keep</button><button type="button" className="text-button" disabled={busy} onClick={() => onDecide(entry.id, 'forget')}>Not this</button></>
      : <button type="button" className="text-button" disabled={busy} onClick={() => onDecide(entry.id, 'forget')}>Forget</button>}</div>
  </div>;
}

/** Settings › Memory: the switch, the lines waiting for a decision, the kept lines by subject, and the files. */
export function MemoryPage({ publicDemo }: { publicDemo: boolean }) {
  const [state, setState] = useState<PersonalMemoryState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<MemoryKind>('style'), [text, setText] = useState(''), [about, setAbout] = useState(false);
  const refresh = useCallback(async () => {
    if (publicDemo) return;
    try { setState(await api<PersonalMemoryState>('/api/memory')); setError(''); } catch (cause) { setError(message(cause)); }
  }, [publicDemo]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (work: () => Promise<unknown>) => { setBusy(true); try { await work(); await refresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const decide = (id: string, decision: Decision) => void run(() => post(`/api/memory/${id}`, { decision }));
  const waiting = state?.entries.filter(entry => entry.status === 'proposed') ?? [];
  const kept = (value: MemoryKind) => state?.entries.filter(entry => entry.status === 'kept' && entry.kind === value) ?? [];
  return <div className="settings-page memory-page" data-testid="memory-page">
    <header className="settings-head">
      <div><h1>Memory</h1><p className="settings-lead">What Ros remembers about how you work: taste and style, working habits, people and commitments. <button type="button" className="text-button inline" aria-expanded={about} onClick={() => setAbout(!about)}>{about ? 'Less' : 'More'}</button></p>
        {about && <p className="settings-lead">Each line waits for you under the project's permission choice, and every agent that works on your map gets the kept lines as your preferences, never as instructions. Project memory (the question, decisions and findings) stays with each project.</p>}</div>
      {state && <button type="button" role="switch" aria-checked={state.enabled} aria-label="Ros remembers how you work" className={`switch ${state.enabled ? 'on' : ''}`} disabled={busy} onClick={() => void run(() => api('/api/memory', { method: 'PUT', body: JSON.stringify({ enabled: !state.enabled }) }))}><span/></button>}
    </header>
    {publicDemo && <p className="rail-page-note">This demo keeps no memory of its own. In the local workspace, Ros remembers how you work.</p>}
    {!publicDemo && !state && (error ? <p className="inline-error" role="alert">{error}</p> : <p className="rail-page-note"><LoaderCircle size={14} className="spin"/> Reading memory…</p>)}
    {state && <>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!state.enabled && <p className="settings-lead memory-off">Off: nothing is proposed or shared. The lines below stay in your files.</p>}
      {waiting.length > 0 && <section><h2 className="memory-waiting-title"><span className="ros-dot" aria-hidden="true"/>Waiting for you · {waiting.length}</h2>
        <div className="settings-card" role="region" aria-label="Waiting for you">{waiting.map(entry => <MemoryLineRow key={entry.id} entry={entry} busy={busy} onDecide={decide} showKind/>)}</div></section>}
      {MEMORY_KINDS.map(item => {
        const lines = kept(item.kind);
        return <section key={item.kind}><h2>{item.title}{lines.length ? ` · ${lines.length}` : ''}</h2>
          {lines.length ? <div className="settings-card" role="region" aria-label={item.title}>{lines.map(entry => <MemoryLineRow key={entry.id} entry={entry} busy={busy} onDecide={decide}/>)}</div> : <p className="rail-page-note">{item.about} Nothing kept yet.</p>}
        </section>;
      })}
      <section><h2>Tell Ros something to remember</h2>
        <form className="settings-card memory-add" onSubmit={event => { event.preventDefault(); if (!text.trim() || busy) return; void run(async () => { await post('/api/memory', { kind, text: text.trim() }); setText(''); }); }}>
          <label className="sr-only" htmlFor="memory-text">What to remember</label>
          <input id="memory-text" value={text} maxLength={MEMORY_LIMITS.text} onChange={event => setText(event.target.value)} placeholder="One sentence, in your own words"/>
          <div className="memory-add-foot">
            <ChipChoice label="Kind" value={kind} options={MEMORY_KINDS.map(item => ({ id: item.kind, label: item.label }))} onChange={setKind}/>
            <button type="submit" className="primary small" disabled={busy || !text.trim()}>Add</button>
          </div>
        </form></section>
      <section><h2>Files</h2><div className="settings-card">
        <Row title="Folder" detail="One Markdown file per subject, a line each, with where it came from. Edit or delete lines freely; Ros reads the files again at the start of every turn."><code title={state.folder}>{state.folder}</code><button type="button" className="text-button" disabled={busy} onClick={() => void run(() => post('/api/memory/open'))}>Open folder</button></Row>
        <Row title="Who reads it" detail="Ros in every project, and Claude Code, Codex or any agent connected over MCP, labelled as your preferences and never as instructions. Nothing leaves this computer."><span/></Row>
      </div></section>
    </>}
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
      return entry ? <MemoryLineRow key={line.id} entry={entry} busy={busy} onDecide={(id, decision) => void decide(id, decision)} showKind/> : <div key={line.id} className="settings-row memory-line gone"><div><strong>{line.text}</strong><small>{kindLabel(line.kind)} · not kept</small></div></div>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
