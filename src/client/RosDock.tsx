import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronUp, CircleAlert, Focus, Folder, LoaderCircle, Maximize2, PanelBottomOpen, SlidersHorizontal, Square, X } from 'lucide-react';
import type { AssistantBackend, AssistantFocus, AssistantState } from '../shared/assistant';
import { modelMaker, type ModelMaker, type ModelSettingsResponse } from '../shared/model-settings';
import type { ProjectDetail } from '../shared/types';
import { ResearchRing } from './Brand';
import { BrandLogo } from './brand-logos';
import { ModelMakerSymbol } from './ModelMakerSymbol';
import { api, post } from './api';
import { useFolderSuggestion } from './ProjectFolder';
import { readSaved, saveLocal } from './persistence';
import { textPreview } from '../shared/presentation';
import './ros-dock.css';

export type RosMode = 'bar' | 'half' | 'full';

/** The logo ring, the one place the signal green lives. */
export function RosMark({ working = false }: { working?: boolean }) {
  return <span className={`ros-mark ${working ? 'working' : ''}`} aria-hidden="true"><ResearchRing/></span>;
}

const settingsChanged = 'ros-ai-model-settings';
const plain = (value: string) => value.replace(/[#*_`>]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

type ModelChoice = { provider: string; model: string; label: string; maker: ModelMaker };

/** The project's chosen model and the models it could switch to, kept fresh when settings change elsewhere. */
function useProjectModels(projectId: string, revision: number) {
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => { void api<ModelSettingsResponse>(`/api/projects/${projectId}/models`).then(value => { if (active) setSettings(value); }).catch(() => undefined); };
    load();
    window.addEventListener(settingsChanged, load);
    return () => { active = false; window.removeEventListener(settingsChanged, load); };
  }, [projectId, revision]);
  const selection = settings?.project || settings?.default;
  const choices: ModelChoice[] = settings?.providers.flatMap(connection => connection.models.map(item => ({ provider: connection.id, model: item.id, label: item.label, maker: item.maker || modelMaker(item.id, connection.id) }))) ?? [];
  const current = choices.find(item => item.provider === selection?.provider && item.model === selection?.model);
  const choose = async (choice: ModelChoice) => {
    const value = await api<ModelSettingsResponse>(`/api/projects/${projectId}/models`, { method: 'PATCH', body: JSON.stringify({ nodeId: null, selection: { provider: choice.provider, model: choice.model } }) });
    setSettings(value);
    window.dispatchEvent(new Event(settingsChanged));
  };
  return { choices, current, fallback: selection?.model, choose };
}

/** Ros folded down: a floating composer at the bottom of the map. The input sits alone on top; the ring, model, context and controls share one footer line; a request in flight shows above the input. */
export function RosBar({ state, detail, focus, busy, onSend, onCancel, onClearFocus, onRefresh, onOpen }: { state: AssistantState | null; detail: ProjectDetail; focus: AssistantFocus; busy: boolean; onSend: (message: string) => Promise<boolean>; onCancel: (turnId: string) => unknown; onClearFocus: () => void; onRefresh: () => unknown; onOpen: (mode: 'half' | 'full') => void }) {
  const [draft, setDraft] = useState(''), [menu, setMenu] = useState(false), [switching, setSwitching] = useState(false), [now, setNow] = useState(() => Date.now());
  const [seenTurn, setSeenTurn] = useState(() => readSaved<string>(`ros-seen-turn:${detail.project.id}`, ''));
  const menuRef = useRef<HTMLDivElement>(null), modelButton = useRef<HTMLButtonElement>(null);
  const models = useProjectModels(detail.project.id, detail.project.revision);
  const turns = [...(state?.turns || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active = turns.find(turn => turn.id === state?.activeTurnId) || turns.findLast(turn => turn.status === 'running');
  const running = busy || Boolean(active);
  // The last finished request stays in the bar, with its outcome, until the user clicks OK.
  const finished = !running ? turns.findLast(turn => turn.status !== 'running') : undefined;
  const done = finished && finished.id !== seenTurn ? finished : undefined;
  const dismiss = () => { if (done) { setSeenTurn(done.id); saveLocal(`ros-seen-turn:${detail.project.id}`, done.id); } };
  const outcome = done ? done.status === 'completed' ? (done.reply ? textPreview(plain(done.reply), 140).text : done.question ? textPreview(plain(done.question), 140).text : 'Done') : done.status === 'failed' ? (done.error || 'Ros could not finish this request') : done.status === 'cancelled' ? 'Stopped' : 'Interrupted' : '';
  const proposed = new Set(turns.flatMap(turn => turn.actions.map(action => action.proposalId).filter(Boolean)));
  // Suggestions waiting for a decision: open proposals plus pending actions that carry no proposal of their own.
  const waiting = detail.proposals.filter(proposal => proposal.status === 'pending').length + turns.flatMap(turn => turn.actions).filter(action => action.status === 'pending' && (!action.proposalId || !proposed.has(action.proposalId))).length;
  const currentStep = active?.events.at(-1)?.message || (active ? 'Starting…' : 'Sending your question…');
  const focusedNode = detail.project.canvas.nodes.find(node => node.id === focus.nodeId);
  const blocks = detail.project.canvas.nodes.length;
  const backend = state?.backend;
  const agentLabel = backend === 'claude' ? 'Claude Code' : backend === 'codex' ? 'Codex' : null;
  const modelLabel = agentLabel || models.current?.label || models.fallback || 'Choose a model';
  useEffect(() => { if (!running) return; setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [running]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !modelButton.current?.contains(event.target as Node)) setMenu(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(false); modelButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [menu]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || running) return;
    if (state && !state.modelAvailable) { onOpen('half'); return; }
    setDraft('');
    if (!await onSend(message)) setDraft(message);
  };
  const switchTo = async (change: () => Promise<unknown>) => {
    if (switching || running) return;
    setSwitching(true);
    try { await change(); await onRefresh(); setMenu(false); } catch { onOpen('half'); } finally { setSwitching(false); }
  };
  const setBackend = (next: AssistantBackend) => post(`/api/projects/${detail.project.id}/assistant/backend`, { backend: next });
  // Picking a model while an outside agent runs Ros hands Ros back to that model.
  const pickModel = (choice: ModelChoice) => switchTo(async () => { await models.choose(choice); if (agentLabel) await setBackend('provider'); });
  const usingModel = (choice: ModelChoice) => !agentLabel && models.current?.provider === choice.provider && models.current?.model === choice.model;
  return <div className="ros-dock" data-testid="ros-bar">
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
        <button type="button" className="ros-done-ok" onClick={dismiss}>OK</button>
      </div>}
      <input aria-label="Ask Ros" placeholder={running ? 'Type your next question' : done ? 'Ask a follow-up, or @ an agent' : 'Ask Ros, or @ an agent'} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') (event.target as HTMLInputElement).blur(); }}/>
      <div className="ros-bar-footer">
        <RosMark working={running}/>
        <div className="ros-model">
          <button ref={modelButton} type="button" className="ros-chip-button" aria-haspopup="menu" aria-expanded={menu} disabled={running || switching} title={running ? 'Ros is working' : 'Choose what Ros runs with'} onClick={() => setMenu(!menu)}>
            {backend === 'claude' ? <BrandLogo id="claude" size={14}/> : backend === 'codex' ? <BrandLogo id="codex" size={14}/> : models.current ? <ModelMakerSymbol maker={models.current.maker} size={14}/> : null}
            <span>{modelLabel}</span>{switching ? <LoaderCircle size={11} className="spin"/> : !running && <ChevronDown size={11}/>}
          </button>
          {menu && <div ref={menuRef} className="ros-model-menu" role="menu" aria-label="Ros runs with">
            <p>Ros runs with</p>
            {models.choices.map(choice => <button key={`${choice.provider}:${choice.model}`} type="button" role="menuitemradio" aria-checked={usingModel(choice)} onClick={() => void pickModel(choice)}><ModelMakerSymbol maker={choice.maker} size={16}/><span className="ros-menu-label">{choice.label}</span>{usingModel(choice) && <Check size={14}/>}</button>)}
            <button type="button" role="menuitemradio" aria-checked={backend === 'claude'} onClick={() => void switchTo(() => setBackend('claude'))}><BrandLogo id="claude" size={16}/><span className="ros-menu-label">Claude Code<small>Your Anthropic API key</small></span>{backend === 'claude' && <Check size={14}/>}</button>
            <button type="button" role="menuitemradio" aria-checked={backend === 'codex'} onClick={() => void switchTo(() => setBackend('codex'))}><BrandLogo id="codex" size={16}/><span className="ros-menu-label">Codex<small>This computer’s Codex sign-in</small></span>{backend === 'codex' && <Check size={14}/>}</button>
            <hr/>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onOpen('half'); }}><SlidersHorizontal size={14}/><span className="ros-menu-label">More settings</span></button>
          </div>}
        </div>
        {focusedNode
          ? <span className="ros-context focused" title={`Ros is looking at ${focusedNode.title}`}><Focus size={12}/><span>{focusedNode.title}</span><button type="button" aria-label="Show Ros the whole map" title="Whole map" onClick={onClearFocus}><X size={12}/></button></span>
          : <span className="ros-context" title="Select a block to point Ros at it"><Focus size={12}/><span>Whole map · {blocks} {blocks === 1 ? 'block' : 'blocks'}</span></span>}
        <span className="ros-footer-spacer"/>
        {waiting > 0 && <button type="button" className="ros-waiting" onClick={() => onOpen('half')}><span className="ros-dot" aria-hidden="true"/>{waiting} waiting</button>}
        <button type="button" className="icon-button" aria-label="Open Ros as a half sheet" title="Half sheet" onClick={() => onOpen('half')}><PanelBottomOpen size={14}/></button>
        <button type="button" className="icon-button" aria-label="Open Ros in full" title="Full panel" onClick={() => onOpen('full')}><Maximize2 size={13}/></button>
        {active ? <button type="button" className="ros-send ros-stop" aria-label="Stop Ros" title="Stop" onClick={() => void onCancel(active.id)}><Square size={10} fill="currentColor"/></button>
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
