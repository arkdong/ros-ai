import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowUp, Check, ChevronUp, CircleAlert, Focus, Folder, LoaderCircle, SlidersHorizontal, X } from 'lucide-react';
import type { AssistantFocus, AssistantState } from '../shared/assistant';
import type { ProjectDetail } from '../shared/types';
import { ResearchRing } from './Brand';
import { RosApprovalMenu, RosModelMenu, RosSizeIcon, rosSizeLabel } from './RosModelMenu';
import type { ResearchPolicy } from '../shared/research';
import { useFolderSuggestion } from './ProjectFolder';
import { readSaved, saveLocal, useDraft } from './persistence';
import { textPreview } from '../shared/presentation';
import { useSkillMenu } from './SkillMenu';
import { StopButton, useEscToStop } from './EscToStop';
import type { PluginId } from '../shared/plugins';
import { suggestionsWaiting, usePluginChip } from './PluginSuggestion';
import { useSuggestions } from './plugin-suggestions';
import './ros-dock.css';

export type RosMode = 'bar' | 'half' | 'full';

/** The logo ring, the one place the signal green lives. */
export function RosMark({ working = false }: { working?: boolean }) {
  return <span className={`ros-mark ${working ? 'working' : ''}`} aria-hidden="true"><ResearchRing/></span>;
}

const plain = (value: string) => value.replace(/[#*_`>]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

/** Ros folded down: a floating composer at the bottom of the map. The input sits alone on top; the ring, model, context and controls share one footer line; a request in flight shows above the input. */
export function RosBar({ state, detail, policy, focus, busy, onSend, onCancel, onClearFocus, onRefresh, onConnections, onPermissions, onOpen, onSkills, onOpenPlugin }: { state: AssistantState | null; detail: ProjectDetail; policy: ResearchPolicy | null; focus: AssistantFocus; busy: boolean; onSend: (message: string, suggest?: PluginId[]) => Promise<boolean>; onCancel: (turnId: string) => unknown; onClearFocus: () => void; onRefresh: () => unknown; onConnections: () => void; onPermissions: () => void; onOpen: (mode: 'half' | 'full') => void; onSkills?: () => void; onOpenPlugin: (id: PluginId) => void }) {
  // The bar and the opened panel share one saved draft per project, so text survives resizing Ros, switching projects and closing the window.
  const [draft, setDraft] = useDraft(`assistant-draft:${detail.project.id}`), [now, setNow] = useState(() => Date.now());
  const skills = useSkillMenu(draft, setDraft, onSkills);
  // A link or an app's name in the draft whose plugin agents cannot use yet shows as a chip above the bar.
  const plugins = usePluginChip({ draft, projectId: detail.project.id, backend: state?.backend, hidden: skills.open, onBackend: onRefresh, onOpenPlugin });
  const suggestions = useSuggestions();
  const input = useRef<HTMLInputElement>(null);
  const [seenTurn, setSeenTurn] = useState(() => readSaved<string>(`ros-seen-turn:${detail.project.id}`, ''));
  const turns = [...(state?.turns || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active = turns.find(turn => turn.id === state?.activeTurnId) || turns.findLast(turn => turn.status === 'running');
  const running = busy || Boolean(active);
  // The last finished request stays in the bar, with its outcome, until the user clicks OK.
  const finished = !running ? turns.findLast(turn => turn.status !== 'running') : undefined;
  const done = finished && finished.id !== seenTurn ? finished : undefined;
  const dismiss = () => { if (done) { setSeenTurn(done.id); saveLocal(`ros-seen-turn:${detail.project.id}`, done.id); } };
  const outcome = done ? done.status === 'completed' ? (done.reply ? textPreview(plain(done.reply), 140).text : done.question ? textPreview(plain(done.question), 140).text : 'Done') : done.status === 'failed' ? (done.error || 'Ros could not finish this request') : done.status === 'cancelled' ? 'Stopped' : 'Interrupted' : '';
  const proposed = new Set(turns.flatMap(turn => turn.actions.map(action => action.proposalId).filter(Boolean)));
  // Suggestions waiting for a decision: open proposals, pending actions that carry no proposal of their own, lines Ros noticed about the person, and plugins a reply suggested.
  const waiting = detail.proposals.filter(proposal => proposal.status === 'pending').length + turns.flatMap(turn => turn.actions).filter(action => action.status === 'pending' && (!action.proposalId || !proposed.has(action.proposalId))).length + (state?.person?.waiting ?? 0) + suggestionsWaiting(turns, suggestions, detail.project.id);
  const currentStep = active?.events.at(-1)?.message || (active ? 'Starting…' : 'Sending your question…');
  const focusedNode = detail.project.canvas.nodes.find(node => node.id === focus.nodeId);
  const blocks = detail.project.canvas.nodes.length;
  useEffect(() => { if (!running) return; setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [running]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || running) return;
    if (state && !state.modelAvailable) { onOpen('half'); return; }
    setDraft('');
    if (!await onSend(message, plugins.suggest)) setDraft(message);
    input.current?.focus();
  };
  // Stopping leaves the cursor in the box, ready for the next question.
  const stop = () => { if (active) void onCancel(active.id); input.current?.focus(); };
  const stopArmed = useEscToStop(active ? stop : null);
  return <div className="ros-dock" data-testid="ros-bar">
    {plugins.chip}
    <form className={`ros-bar ${running || done ? 'running' : ''}`} onSubmit={submit}>
      {running && <button type="button" className="ros-progress" onClick={() => onOpen('half')} aria-label="Show what Ros is doing" data-testid="ros-progress">
        <LoaderCircle size={15} className="spin" aria-hidden="true"/>
        <span className="ros-progress-text"><strong>{active?.userMessage || draft || 'Your question'}</strong><span role="status">{currentStep}</span></span>
        {active && <span className="ros-progress-meta">{clock(now - Date.parse(active.createdAt))}</span>}
        <ChevronUp size={12} aria-hidden="true"/>
      </button>}
      {done && <div className={`ros-progress done ${done.status}`} data-testid="ros-done">
        <button type="button" className="ros-done-open" onClick={() => onOpen('half')} aria-label="Open the reply from Ros">
          {done.status === 'completed' ? <Check size={15} aria-hidden="true"/> : <CircleAlert size={15} aria-hidden="true"/>}
          <span className="ros-progress-text"><strong>{done.userMessage}</strong><span>{outcome}</span></span>
          <span className="ros-progress-meta">{clock(Date.parse(done.updatedAt) - Date.parse(done.createdAt))}</span>
        </button>
        <button type="button" className="icon-button ros-done-ok" aria-label="Archive this request" title="Archive" onClick={dismiss}><Archive size={14}/></button>
      </div>}
      {skills.menu}
      <input ref={input} aria-label="Ask Ros" aria-autocomplete="list" aria-expanded={skills.open} placeholder={running ? 'Type your next question' : done ? 'Ask a follow-up, or @ an agent' : 'Ask Ros, or @ an agent'} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (skills.onKeyDown(event) || event.key !== 'Escape') return; if (!active) (event.target as HTMLInputElement).blur(); }}/>
      <div className="ros-bar-footer">
        <RosMark working={running}/>
        <RosModelMenu state={state} detail={detail} running={running} onRefresh={onRefresh} onConnections={onConnections} onPermissions={onPermissions} onError={() => onOpen('half')}/>
        <RosApprovalMenu policy={policy} running={running} onRefresh={onRefresh} onDetails={onPermissions} onError={() => onOpen('half')}/>
        {focusedNode
          ? <span className="ros-context focused" title={`Ros is looking at ${focusedNode.title}`}><Focus size={12}/><span>{focusedNode.title}</span><button type="button" aria-label="Show Ros the whole map" title="Whole map" onClick={onClearFocus}><X size={12}/></button></span>
          : <span className="ros-context" title="Select a block to point Ros at it"><Focus size={12}/><span>Whole map · {blocks} {blocks === 1 ? 'block' : 'blocks'}</span></span>}
        <span className="ros-footer-spacer"/>
        {waiting > 0 && <button type="button" className="ros-waiting" onClick={() => onOpen('half')}><span className="ros-dot" aria-hidden="true"/>{waiting} waiting</button>}
        <button type="button" className="icon-button" aria-label={rosSizeLabel.half} title="Half sheet" onClick={() => onOpen('half')}><RosSizeIcon size="half" px={15}/></button>
        <button type="button" className="icon-button" aria-label={rosSizeLabel.full} title="Side panel" onClick={() => onOpen('full')}><RosSizeIcon size="full" px={15}/></button>
        {active ? <StopButton armed={stopArmed} onStop={stop}/>
          : <button type="submit" className="ros-send" aria-label="Send to Ros" disabled={!draft.trim() || running}>{running ? <LoaderCircle size={14} className="spin"/> : <ArrowUp size={14}/>}</button>}
      </div>
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
  const [question, setQuestion] = useDraft('start-question'), [busy, setBusy] = useState(false);
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
