import { useState, type FormEvent } from 'react';
import { ArrowUp, Folder, LoaderCircle, Maximize2, PanelBottomOpen, SlidersHorizontal } from 'lucide-react';
import type { AssistantState } from '../shared/assistant';
import type { ProjectDetail } from '../shared/types';
import { textPreview } from '../shared/presentation';
import { ResearchRing } from './Brand';
import { useFolderSuggestion } from './ProjectFolder';
import './ros-dock.css';

export type RosMode = 'bar' | 'half' | 'full';

/** The logo ring, the one place the signal green lives. */
export function RosMark({ working = false }: { working?: boolean }) {
  return <span className={`ros-mark ${working ? 'working' : ''}`} aria-hidden="true"><ResearchRing/></span>;
}

const plain = (value: string) => value.replace(/[#*_`>]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

/** Ros folded down: a floating input at the bottom of the map with a fading peek of the last reply. */
export function RosBar({ state, detail, busy, onSend, onOpen }: { state: AssistantState | null; detail: ProjectDetail; busy: boolean; onSend: (message: string) => Promise<boolean>; onOpen: (mode: 'half' | 'full') => void }) {
  const [draft, setDraft] = useState('');
  const turns = [...(state?.turns || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = turns.at(-1), running = busy || Boolean(state?.activeTurnId);
  const proposed = new Set(turns.flatMap(turn => turn.actions.map(action => action.proposalId).filter(Boolean)));
  // Suggestions waiting for a decision: open proposals plus pending actions that carry no proposal of their own.
  const waiting = detail.proposals.filter(proposal => proposal.status === 'pending').length + turns.flatMap(turn => turn.actions).filter(action => action.status === 'pending' && (!action.proposalId || !proposed.has(action.proposalId))).length;
  const peek = running ? 'Working on your question…' : last?.reply ? textPreview(plain(last.reply), 180).text : '';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || running) return;
    if (state && !state.modelAvailable) { onOpen('half'); return; }
    setDraft('');
    if (!await onSend(message)) setDraft(message);
  };
  return <div className="ros-dock" data-testid="ros-bar">
    {peek && <button type="button" className="ros-peek" onClick={() => onOpen('half')} aria-label="Open the conversation with Ros"><span>{peek}</span></button>}
    <form className="ros-bar" onSubmit={submit}>
      <RosMark working={running}/>
      <input aria-label="Ask Ros" placeholder="Ask Ros, or @ an agent" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') (event.target as HTMLInputElement).blur(); }}/>
      {waiting > 0 && <button type="button" className="ros-waiting" onClick={() => onOpen('half')}><span className="ros-dot" aria-hidden="true"/>{waiting} waiting</button>}
      <button type="button" className="icon-button" aria-label="Open Ros as a half sheet" title="Half sheet" onClick={() => onOpen('half')}><PanelBottomOpen size={16}/></button>
      <button type="button" className="icon-button" aria-label="Open Ros in full" title="Full panel" onClick={() => onOpen('full')}><Maximize2 size={15}/></button>
      <button type="submit" className="ros-send" aria-label="Send to Ros" disabled={!draft.trim() || running}>{running ? <LoaderCircle size={15} className="spin"/> : <ArrowUp size={15}/>}</button>
    </form>
  </div>;
}

/** A project title from the first question: its opening words, cut at a word boundary. */
export function titleFromQuestion(question: string) {
  const text = question.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60), space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > 30 ? space : 60)}…`;
}

/** The empty-state start: one box for the question; everything else sits behind Advanced. */
export function RosStart({ folders, onStart, onAdvanced, onDemo }: { folders: boolean; onStart: (title: string, question: string, folder?: string) => Promise<void>; onAdvanced: () => void; onDemo: () => void }) {
  const [question, setQuestion] = useState(''), [busy, setBusy] = useState(false);
  const title = titleFromQuestion(question);
  const suggestion = useFolderSuggestion(title || 'New project', folders);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    try { await onStart(title, question.trim(), suggestion?.path); } finally { setBusy(false); }
  };
  return <div className="ros-start">
    <h2>What do you want to find out?</h2>
    <form className="ros-start-box" onSubmit={submit}>
      <textarea aria-label="Your question" data-testid="start-question" rows={3} autoFocus value={question} maxLength={12000} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder="Ask a research question. Ros plans it with you on the map."/>
      <div className="ros-start-row">
        <RosMark working={busy}/>
        {suggestion && <span className="ros-chip" title={suggestion.path}><Folder size={12}/>Saved as files on this computer</span>}
        <span className="ros-start-spacer"/>
        <button type="button" className="ros-start-advanced" onClick={onAdvanced}><SlidersHorizontal size={13}/>Advanced</button>
        <button type="submit" className="primary small" data-testid="start-project" disabled={!question.trim() || busy}>{busy ? <LoaderCircle size={14} className="spin"/> : <ArrowUp size={14}/>}Start</button>
      </div>
    </form>
    <button type="button" className="text-button ros-start-demo" onClick={onDemo}>Or open a guided demo</button>
  </div>;
}
