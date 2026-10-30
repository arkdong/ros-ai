import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowUp, Check, ChevronUp, CircleAlert, LoaderCircle } from 'lucide-react';
import type { AssistantState } from '../shared/assistant';
import type { ProjectDetail } from '../shared/types';
import { ResearchRing } from './Brand';
import { RosApprovalMenu, RosModelMenu, RosSizeIcon, rosSizeLabel } from './RosModelMenu';
import type { ResearchPolicy } from '../shared/research';
import { readSaved, saveLocal, useDraft } from './persistence';
import { textPreview } from '../shared/presentation';
import { useSkillMenu } from './SkillMenu';
import { StopButton, useEscToStop } from './EscToStop';
import type { PluginId } from '../shared/plugins';
import { suggestionsWaiting, usePluginChip } from './PluginSuggestion';
import { useSuggestions } from './plugin-suggestions';
import { RosThreadsButton, seenKey, seenTurn, type ShownThread } from './RosThreads';
import './ros-dock.css';

export type RosMode = 'bar' | 'half' | 'full';

/** The logo ring, the one place the signal green lives. */
export function RosMark({ working = false }: { working?: boolean }) {
  return <span className={`ros-mark ${working ? 'working' : ''}`} aria-hidden="true"><ResearchRing/></span>;
}

const plain = (value: string) => value.replace(/[#*_`>]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

/** ROS folded down: a floating composer at the bottom of the map. The input sits alone on top; the ring, model and controls share one footer line; a request in flight shows above the input.
 * What is selected on the map never shows here: it goes with each message as a quiet hint (the glance, App.tsx).
 * The bar shows one thread (threadId; null is a new thread not yet started): its request in flight, its finished request and its draft. The threads button switches; other threads go on working meanwhile. */
export function RosBar({ state, detail, policy, busy, threadId, onThread, onSend, onCancel, onRefresh, onConnections, onPermissions, onOpen, onSkills, onOpenPlugin }: { state: AssistantState | null; detail: ProjectDetail; policy: ResearchPolicy | null; busy: boolean; threadId: ShownThread; onThread: (thread: ShownThread) => void; onSend: (message: string, suggest?: PluginId[]) => Promise<boolean>; onCancel: (turnId: string) => unknown; onRefresh: () => unknown; onConnections: () => void; onPermissions: () => void; onOpen: (mode: 'half' | 'full') => void; onSkills?: () => void; onOpenPlugin: (id: PluginId) => void }) {
  // The bar and the opened panel share one saved draft per thread, so text survives resizing ROS, switching threads or projects and closing the window.
  const [draft, setDraft] = useDraft(`assistant-draft:${detail.project.id}:${threadId ?? 'new'}`), [now, setNow] = useState(() => Date.now());
  const skills = useSkillMenu(draft, setDraft, onSkills);
  // A link or an app's name in the draft whose plugin agents cannot use yet shows as a chip above the bar.
  const plugins = usePluginChip({ draft, projectId: detail.project.id, backend: state?.backend, hidden: skills.open, onBackend: onRefresh, onOpenPlugin });
  const suggestions = useSuggestions();
  const input = useRef<HTMLInputElement>(null);
  const [seenVersion, setSeenVersion] = useState(0);
  const seen = threadId ? seenTurn(detail.project.id, threadId) : '';
  const allTurns = [...(state?.turns || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const turns = threadId ? allTurns.filter(turn => turn.threadId === threadId) : [];
  const active = turns.findLast(turn => turn.status === 'running');
  const running = busy || Boolean(active);
  // The thread's last finished request stays in the bar, with its outcome, until the user archives it.
  const finished = !running ? turns.findLast(turn => turn.status !== 'running') : undefined;
  const done = finished && finished.id !== seen ? finished : undefined;
  const dismiss = () => { if (done && threadId) { saveLocal(seenKey(detail.project.id, threadId), done.id); setSeenVersion(seenVersion + 1); } };
  const outcome = done ? done.status === 'completed' ? (done.reply ? textPreview(plain(done.reply), 140).text : done.question ? textPreview(plain(done.question), 140).text : 'Done') : done.status === 'failed' ? (done.error || 'ROS could not finish this request') : done.status === 'cancelled' ? 'Stopped' : 'Interrupted' : '';
  const proposed = new Set(allTurns.flatMap(turn => turn.actions.map(action => action.proposalId).filter(Boolean)));
  // Suggestions waiting for a decision, from every thread: open proposals (not ones the canvas has moved past, which can no longer be accepted), pending actions that carry no proposal of their own, lines ROS noticed about the person, and plugins a reply suggested.
  const waiting = detail.proposals.filter(proposal => proposal.status === 'pending' && proposal.baseRevision === detail.project.revision).length + allTurns.flatMap(turn => turn.actions).filter(action => action.status === 'pending' && (!action.proposalId || !proposed.has(action.proposalId))).length + (state?.person?.waiting ?? 0) + suggestionsWaiting(allTurns, suggestions, detail.project.id);
  const currentStep = active?.events.at(-1)?.message || (active ? 'Starting…' : 'Sending your question…');
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
      {running && <button type="button" className="ros-progress" onClick={() => onOpen('half')} aria-label="Show what ROS is doing" data-testid="ros-progress">
        <LoaderCircle size={15} className="spin" aria-hidden="true"/>
        <span className="ros-progress-text"><strong>{active?.userMessage || draft || 'Your question'}</strong><span role="status">{currentStep}</span></span>
        {active && <span className="ros-progress-meta">{clock(now - Date.parse(active.createdAt))}</span>}
        <ChevronUp size={12} aria-hidden="true"/>
      </button>}
      {done && <div className={`ros-progress done ${done.status}`} data-testid="ros-done">
        <button type="button" className="ros-done-open" onClick={() => onOpen('half')} aria-label="Open the reply from ROS">
          {done.status === 'completed' ? <Check size={15} aria-hidden="true"/> : <CircleAlert size={15} aria-hidden="true"/>}
          <span className="ros-progress-text"><strong>{done.userMessage}</strong><span>{outcome}</span></span>
          <span className="ros-progress-meta">{clock(Date.parse(done.updatedAt) - Date.parse(done.createdAt))}</span>
        </button>
        <button type="button" className="icon-button ros-done-ok" aria-label="Archive this request" title="Archive" onClick={dismiss}><Archive size={14}/></button>
      </div>}
      {skills.menu}
      <input ref={input} aria-label="Ask ROS" aria-autocomplete="list" aria-expanded={skills.open} placeholder={running ? 'Type your next question' : done ? 'Ask a follow-up, or @ an agent' : 'Ask ROS, or @ an agent'} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (skills.onKeyDown(event) || event.key !== 'Escape') return; if (!active) (event.target as HTMLInputElement).blur(); }}/>
      <div className="ros-bar-footer">
        <RosMark working={running}/>
        <RosModelMenu state={state} detail={detail} running={running} onRefresh={onRefresh} onConnections={onConnections} onPermissions={onPermissions} onError={() => onOpen('half')}/>
        <RosApprovalMenu policy={policy} running={running} onRefresh={onRefresh} onDetails={onPermissions} onError={() => onOpen('half')}/>
        <span className="ros-footer-spacer"/>
        {waiting > 0 && <button type="button" className="ros-waiting" onClick={() => onOpen('half')}><span className="ros-dot" aria-hidden="true"/>{waiting} waiting</button>}
        <RosThreadsButton state={state} projectId={detail.project.id} current={threadId} onChoose={onThread}/>
        <button type="button" className="icon-button" aria-label={rosSizeLabel.half} title="Half sheet" onClick={() => onOpen('half')}><RosSizeIcon size="half" px={15}/></button>
        <button type="button" className="icon-button" aria-label={rosSizeLabel.full} title="Side panel" onClick={() => onOpen('full')}><RosSizeIcon size="full" px={15}/></button>
        {active ? <StopButton armed={stopArmed} onStop={stop}/>
          : <button type="submit" className="ros-send" aria-label="Send to ROS" disabled={!draft.trim() || running}>{running ? <LoaderCircle size={14} className="spin"/> : <ArrowUp size={14}/>}</button>}
      </div>
    </form>
  </div>;
}
