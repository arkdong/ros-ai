import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, LoaderCircle } from 'lucide-react';
import { IN_APP_AGENTS, type InAppAgent } from '../shared/assistant';
import { EFFORT_LEVELS, EFFORT_NAMES, effortFor, type AgentModel, type AgentModelChoice, type EffortLevel } from '../shared/agent-models';
import { api } from './api';
import { openOnPress } from './press';
import './agent-model.css';

const changed = 'ros-ai-agent-model';
const modelPath = (agent: InAppAgent) => `/api/agents/${IN_APP_AGENTS[agent].agent}/model?billing=${IN_APP_AGENTS[agent].billing}`;
// Codex lists many models; the first few show at once and the rest behind More models.
const SHOWN = 4;

type Change = { model?: string; effort?: EffortLevel };
/** failed: why the choice could not be read, shown on the agent's page; the ROS bar then shows no chip. */
export type AgentModelState = { choice: AgentModelChoice | null; saving: boolean; failed: string; choose: (change: Change) => Promise<void> };

/** The model and effort one of the four agents ros.ai runs works with, for every project. The ROS bar and the agent's own page show the same choice. */
export function useAgentModel(agent: InAppAgent | null | undefined): AgentModelState {
  // The choice is kept with its agent, so a switch to another agent never shows the last one's model.
  const [held, setHeld] = useState<{ agent: InAppAgent; choice: AgentModelChoice } | null>(null), [saving, setSaving] = useState(false), [failed, setFailed] = useState('');
  const latest = useRef(0), queue = useRef<Promise<unknown>>(Promise.resolve()), self = useRef({}), shown = useRef(agent);
  shown.current = agent;
  const choice = held && held.agent === agent ? held.choice : null;
  useEffect(() => {
    setFailed('');
    if (!agent) return;
    let active = true;
    void api<AgentModelChoice>(modelPath(agent)).then(value => { if (active) setHeld({ agent, choice: value }); }).catch(cause => { if (active) setFailed(cause instanceof Error ? cause.message : String(cause)); });
    const update = (event: Event) => { const detail = (event as CustomEvent<{ agent: InAppAgent; choice: AgentModelChoice; from: object }>).detail; if (active && detail.agent === agent && detail.from !== self.current) setHeld({ agent, choice: detail.choice }); };
    window.addEventListener(changed, update);
    return () => { active = false; window.removeEventListener(changed, update); };
  }, [agent]);
  const choose = async (change: Change) => {
    if (!agent || !choice) return;
    const call = ++latest.current, before = choice;
    // An answer counts only for the latest change, and only while the same agent is shown.
    const current = () => call === latest.current && shown.current === agent;
    const setChoice = (value: AgentModelChoice) => setHeld({ agent, choice: value });
    // The new choice shows at once; a new model starts on its own default effort, as the server saves it.
    const model = choice.models.find(item => item.id === (change.model ?? choice.model));
    if (model) setChoice({ ...choice, model: model.id, effort: change.effort ?? (model.id === choice.model ? choice.effort : effortFor(model, null)) });
    setSaving(true);
    // Changes go one at a time, so a quick drag along the slider saves where it stopped.
    const sent = queue.current.catch(() => undefined).then(() => api<AgentModelChoice>(modelPath(agent), { method: 'PUT', body: JSON.stringify(change) }));
    queue.current = sent;
    try {
      const value = await sent;
      window.dispatchEvent(new CustomEvent(changed, { detail: { agent, choice: value, from: self.current } }));
      if (current()) setChoice(value);
    } catch (cause) { if (current()) setChoice(before); throw cause; }
    finally { if (call === latest.current) setSaving(false); }
  };
  return { choice, saving, failed, choose };
}

/** The models to list: the first few, the chosen one, and the rest once More models is open. */
function shownModels(choice: AgentModelChoice, more: boolean) {
  return more || choice.models.length <= SHOWN + 1 ? choice.models : choice.models.filter((item, index) => index < SHOWN || item.id === choice.model);
}

/** How long the agent thinks, on a slider over the levels its model takes, as in Claude Code's /effort. */
export function EffortSlider({ model, effort, disabled, labels, onChange }: { model: AgentModel; effort: EffortLevel; disabled?: boolean; labels?: boolean; onChange: (effort: EffortLevel) => void }) {
  const levels = model.efforts, at = Math.max(0, levels.indexOf(effort)), last = Math.max(1, levels.length - 1);
  // A stop's place along the input, where the thumb's centre is when that level is chosen.
  const place = (index: number) => `calc(8px + (100% - 16px) * ${index / last})`;
  return <div className="effort-slider" style={{ '--effort-at': at / last } as CSSProperties}>
    <div className="effort-track">
      {levels.map((level, index) => index !== at && <i key={level} className={index < at ? 'on' : ''} style={{ left: place(index) }} aria-hidden="true"/>)}
      <input type="range" min={0} max={levels.length - 1} step={1} value={at} disabled={disabled} aria-label="Effort" aria-valuetext={EFFORT_NAMES[effort].label} onChange={event => onChange(levels[Number(event.target.value)]!)}/>
    </div>
    {labels && <div className="effort-ticks" aria-hidden="true">{levels.map((level, index) => <button key={level} type="button" className={index === at ? 'current' : ''} style={{ left: place(index) }} disabled={disabled} tabIndex={-1} onClick={() => onChange(level)}>{EFFORT_NAMES[level].label}</button>)}</div>}
  </div>;
}

/** What the slider's level means, and whether it is the model's own default. */
const effortNote = (model: AgentModel, effort: EffortLevel) => `${EFFORT_NAMES[effort].detail}${effort === model.defaultEffort ? `. ${model.label}’s default.` : '.'}`;

/** The effort as five rising bars, filled up to its level, on the same scale for every model: the icon of the model chip in the ROS bar. */
function EffortBars({ effort }: { effort: EffortLevel }) {
  const at = EFFORT_LEVELS.indexOf(effort);
  return <svg className="effort-bars" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">{EFFORT_LEVELS.map((level, index) => <rect key={level} x={index * 3} y={8 - index * 2} width="2" height={4 + index * 2} rx="1" fill="currentColor" opacity={index <= at ? 1 : .25}/>)}</svg>;
}

/** Beside the agent in the ROS bar: the model it runs on with its effort as bars, and one short menu to change both.
 * The bar has no room for the effort's name next to the approval chip, so the name shows in the menu and on hover. */
export function AgentModelChip({ agent, state, running, onError }: { agent: InAppAgent; state: AgentModelState; running: boolean; onError?: (message: string) => void }) {
  const { choice, saving } = state;
  const [menu, setMenu] = useState(false), [more, setMore] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) { setMore(false); return; }
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [menu]);
  useEffect(() => { if (running) setMenu(false); }, [running]);
  const model = choice?.models.find(item => item.id === choice.model);
  if (!choice || !model) return null;
  const choose = (change: Change) => { void state.choose(change).catch(cause => onError?.(cause instanceof Error ? cause.message : String(cause))); };
  const name = IN_APP_AGENTS[agent].label, level = choice.effort ? `${EFFORT_NAMES[choice.effort].label} effort` : null;
  return <div className="ros-model ros-agent-model">
    <button ref={trigger} type="button" className="ros-chip-button" aria-haspopup="menu" aria-expanded={menu} aria-label={level ? `${model.label}, ${level}` : model.label} disabled={running} title={running ? 'ROS is working' : level ? `${model.label} · ${level}` : model.label} {...openOnPress(() => setMenu(value => !value))}>
      {choice.effort && <EffortBars effort={choice.effort}/>}<span>{model.label}</span>{saving ? <LoaderCircle size={11} className="spin"/> : !running && <ChevronDown size={11}/>}
    </button>
    {menu && <div ref={menuRef} className="ros-model-menu agent-model-menu" role="menu" aria-label={`${name}’s model and effort`}>
      <p>Model</p>
      {shownModels(choice, more).map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === choice.model} onClick={() => { if (item.id !== choice.model) choose({ model: item.id }); }}><span className="ros-menu-label">{item.label}{item.detail && <small>{item.detail}</small>}</span>{item.id === choice.model && <Check size={14}/>}</button>)}
      {!more && shownModels(choice, false).length < choice.models.length && <button type="button" role="menuitem" className="agent-model-more" onClick={() => setMore(true)}><span className="ros-menu-label">More models</span><ChevronDown size={12}/></button>}
      {choice.effort && model.efforts.length > 1 && <>
        <hr/>
        <div className="agent-model-effort">
          <div className="agent-model-effort-head"><span>Effort</span><strong>{EFFORT_NAMES[choice.effort].label}</strong></div>
          <EffortSlider model={model} effort={choice.effort} onChange={effort => { if (effort !== choice.effort) choose({ effort }); }}/>
          <p className="agent-model-note">{effortNote(model, choice.effort)}</p>
        </div>
      </>}
    </div>}
  </div>;
}

/** On an agent's own page: the same choice as the ROS bar, as a list of models and an effort slider with its levels named. */
export function AgentModelSettings({ agent }: { agent: InAppAgent }) {
  const state = useAgentModel(agent), { choice, saving } = state;
  const [more, setMore] = useState(false), [error, setError] = useState('');
  const model = choice?.models.find(item => item.id === choice.model);
  if (!choice || !model) return state.failed ? <p className="inline-error" role="alert">{state.failed}</p> : null;
  const choose = (change: Change) => { setError(''); void state.choose(change).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); };
  const plan = IN_APP_AGENTS[agent].billing === 'plan';
  return <div className="agent-model-settings">
    <div className="agent-model-field" id={`agent-model-${agent}`}>Model</div>
    <div className="agent-model-list" role="radiogroup" aria-labelledby={`agent-model-${agent}`}>
      {shownModels(choice, more).map(item => <button key={item.id} type="button" role="radio" aria-checked={item.id === choice.model} className={item.id === choice.model ? 'selected' : ''} onClick={() => { if (item.id !== choice.model) choose({ model: item.id }); }}><span className="agent-model-label">{item.label}{item.detail && <small>{item.detail}</small>}</span>{item.id === choice.model && <Check size={14}/>}</button>)}
      {!more && shownModels(choice, false).length < choice.models.length && <button type="button" className="agent-model-more" onClick={() => setMore(true)}><span className="agent-model-label">More models</span><ChevronDown size={12}/></button>}
    </div>
    {choice.effort && model.efforts.length > 1 && <>
      <div className="agent-model-field"><span>Effort</span><strong>{saving ? <LoaderCircle size={12} className="spin"/> : EFFORT_NAMES[choice.effort].label}</strong></div>
      <EffortSlider model={model} effort={choice.effort} labels onChange={effort => { if (effort !== choice.effort) choose({ effort }); }}/>
      <p className="agent-model-note">{effortNote(model, choice.effort)} Higher effort is slower and {plan ? 'uses more of your plan’s limits' : 'costs more per turn'}.</p>
    </>}
    <p className="agent-model-note">Applies to all your projects; the ROS bar shows the same choice.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
