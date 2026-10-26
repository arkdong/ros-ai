import { useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Hand, LoaderCircle, Plug, ShieldCheck, TriangleAlert, Zap } from 'lucide-react';
import type { ApprovalMode, ResearchPolicy } from '../shared/research';
import type { AssistantBackend, AssistantState } from '../shared/assistant';
import { modelMaker, type ModelMaker, type ModelSettingsResponse } from '../shared/model-settings';
import type { ProjectDetail } from '../shared/types';
import { ACP_AGENTS, isAcpAgent, type AcpAgentStatus } from '../shared/acp-agents';
import { acpLogo } from './AcpAgents';
import { BrandLogo } from './brand-logos';
import { ModelMakerSymbol } from './ModelMakerSymbol';
import { api, post } from './api';
import { openOnPress } from './press';

const settingsChanged = 'ros-ai-model-settings';

export type ModelChoice = { provider: string; providerLabel: string; model: string; label: string; maker: ModelMaker };

/** The project's chosen model and the models it could switch to, kept fresh when settings change elsewhere. */
export function useProjectModels(projectId: string, revision: number) {
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => { void api<ModelSettingsResponse>(`/api/projects/${projectId}/models`).then(value => { if (active) setSettings(value); }).catch(() => undefined); };
    load();
    window.addEventListener(settingsChanged, load);
    return () => { active = false; window.removeEventListener(settingsChanged, load); };
  }, [projectId, revision]);
  const selection = settings?.project || settings?.default;
  const choices: ModelChoice[] = settings?.providers.flatMap(connection => connection.models.map(item => ({ provider: connection.id, providerLabel: connection.id === 'nebius' ? 'Nebius' : connection.label, model: item.id, label: item.label, maker: item.maker || modelMaker(item.id, connection.id) }))) ?? [];
  const current = choices.find(item => item.provider === selection?.provider && item.model === selection?.model);
  const choose = async (choice: ModelChoice) => {
    const value = await api<ModelSettingsResponse>(`/api/projects/${projectId}/models`, { method: 'PATCH', body: JSON.stringify({ nodeId: null, selection: { provider: choice.provider, model: choice.model } }) });
    setSettings(value);
    window.dispatchEvent(new Event(settingsChanged));
  };
  return { choices, current, fallback: selection?.model, choose };
}

/** What Ros runs with: one trigger naming the model or agent, and one menu to switch, shared by the bar and the open panel. */
export function RosModelMenu({ state, detail, running, onRefresh, onConnections, onPermissions, onError }: {
  state: AssistantState | null; detail: ProjectDetail; running: boolean; onRefresh: () => unknown;
  onConnections: () => void; onPermissions: () => void; onError?: (message: string) => void;
}) {
  const [menu, setMenu] = useState(false), [switching, setSwitching] = useState(false), [acp, setAcp] = useState<AcpAgentStatus[]>([]);
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const models = useProjectModels(detail.project.id, detail.project.revision);
  const backend = state?.backend;
  const agentLabel = backend === 'claude' ? 'Claude Code' : backend === 'codex' ? 'Codex' : isAcpAgent(backend) ? ACP_AGENTS[backend].label : null;
  // Gemini CLI, Goose and OpenCode are offered once they are installed on this computer.
  useEffect(() => {
    if (!menu) return;
    let active = true;
    void api<{ agents: AcpAgentStatus[] }>('/api/agents/acp').then(value => { if (active) setAcp(value.agents); }).catch(() => undefined);
    return () => { active = false; };
  }, [menu]);
  const acpShown = acp.filter(item => item.installed || item.id === backend);
  const label = agentLabel || models.current?.label || models.fallback || 'Choose a model';
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [menu]);
  const switchTo = async (change: () => Promise<unknown>) => {
    if (switching || running) return;
    setSwitching(true);
    try { await change(); await onRefresh(); setMenu(false); } catch (cause) { onError?.(cause instanceof Error ? cause.message : String(cause)); } finally { setSwitching(false); }
  };
  const setBackend = (next: AssistantBackend) => post(`/api/projects/${detail.project.id}/assistant/backend`, { backend: next });
  // Picking a model while an outside agent runs Ros hands Ros back to that model.
  const pickModel = (choice: ModelChoice) => switchTo(async () => { await models.choose(choice); if (agentLabel) await setBackend('provider'); });
  const usingModel = (choice: ModelChoice) => !agentLabel && models.current?.provider === choice.provider && models.current?.model === choice.model;
  const groups = models.choices.reduce<{ provider: string; label: string; items: ModelChoice[] }[]>((list, choice) => {
    const group = list.find(item => item.provider === choice.provider);
    if (group) group.items.push(choice); else list.push({ provider: choice.provider, label: choice.providerLabel, items: [choice] });
    return list;
  }, []);
  const link = (action: () => void) => () => { setMenu(false); action(); };
  return <div className="ros-model">
    <button ref={trigger} type="button" className="ros-chip-button" aria-haspopup="menu" aria-expanded={menu} disabled={running || switching} title={running ? 'Ros is working' : 'Choose what Ros runs with'} {...openOnPress(() => setMenu(value => !value))}>
      {backend === 'claude' ? <BrandLogo id="claude" size={14}/> : backend === 'codex' ? <BrandLogo id="codex" size={14}/> : isAcpAgent(backend) ? <BrandLogo id={acpLogo[backend]} size={14}/> : models.current ? <ModelMakerSymbol maker={models.current.maker} size={14}/> : null}
      <span>{label}</span>{switching ? <LoaderCircle size={11} className="spin"/> : !running && <ChevronDown size={11}/>}
    </button>
    {menu && <div ref={menuRef} className="ros-model-menu" role="menu" aria-label="Ros runs with">
      {groups.map(group => <div key={group.provider} className="ros-menu-group">
        <p>{groups.length > 1 ? group.label : 'Models'}</p>
        {group.items.map(choice => <button key={`${choice.provider}:${choice.model}`} type="button" role="menuitemradio" aria-checked={usingModel(choice)} onClick={() => void pickModel(choice)}><ModelMakerSymbol maker={choice.maker} size={16}/><span className="ros-menu-label">{choice.label}</span>{usingModel(choice) && <Check size={14}/>}</button>)}
      </div>)}
      {!agentLabel && <button type="button" role="menuitemcheckbox" aria-checked={backend === 'agent'} className="ros-menu-toggle" onClick={() => void switchTo(() => setBackend(backend === 'agent' ? 'provider' : 'agent'))}><Bot size={16}/><span className="ros-menu-label">Use ros.ai’s tools step by step</span><span className={`ros-switch ${backend === 'agent' ? 'on' : ''}`} aria-hidden="true"/></button>}
      <div className="ros-menu-group">
        <p>Agents</p>
        <button type="button" role="menuitemradio" aria-checked={backend === 'claude'} onClick={() => void switchTo(() => setBackend('claude'))}><BrandLogo id="claude" size={16}/><span className="ros-menu-label">Claude Code<small>Reads the project folder</small></span>{backend === 'claude' && <Check size={14}/>}</button>
        <button type="button" role="menuitemradio" aria-checked={backend === 'codex'} onClick={() => void switchTo(() => setBackend('codex'))}><BrandLogo id="codex" size={16}/><span className="ros-menu-label">Codex<small>This computer’s sign-in</small></span>{backend === 'codex' && <Check size={14}/>}</button>
        {acpShown.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={backend === item.id} onClick={() => void switchTo(() => setBackend(item.id))}><BrandLogo id={acpLogo[item.id]} size={16}/><span className="ros-menu-label">{item.label}<small>{item.blocker ? 'Cannot start · see Agents' : item.checked && !item.checked.ok ? 'Check failed · see Agents' : ACP_AGENTS[item.id].caption}</small></span>{backend === item.id && <Check size={14}/>}</button>)}
      </div>
      <hr/>
      <button type="button" role="menuitem" onClick={link(onConnections)}><Plug size={14}/><span className="ros-menu-label">Model &amp; budget</span></button>
      <button type="button" role="menuitem" onClick={link(onPermissions)}><ShieldCheck size={14}/><span className="ros-menu-label">Permission details</span></button>
    </div>}
  </div>;
}

/** Icons for the three sizes of Ros: each shows the shape you get. */
export function RosSizeIcon({ size: shape, px = 16 }: { size: 'bar' | 'half' | 'full'; px?: number }) {
  const fill = shape === 'bar' ? 'M3 16h18v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' : shape === 'half' ? 'M3 12h18v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' : 'M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5z';
  return <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d={fill} fill="currentColor" stroke="none"/></svg>;
}
export const rosSizeLabel = { bar: 'Fold Ros to the bar', half: 'Open Ros as a half sheet', full: 'Open Ros as a side panel' } as const;

const approvalModes: { mode: ApprovalMode; label: string; detail: string; icon: typeof Hand }[] = [
  { mode: 'ask', label: 'Ask every time', detail: 'Every code run and every new block waits for your OK', icon: Hand },
  { mode: 'review', label: 'Approve for me', detail: 'Plain analysis runs; other code and new blocks wait for you', icon: ShieldCheck },
  { mode: 'full', label: 'Full access', detail: 'Code runs and blocks land at once; everything stays undoable', icon: Zap },
];

/** How Ros's actions are approved: a chip naming the mode and one menu to change it, like Codex's picker. */
export function RosApprovalMenu({ policy, running, onRefresh, onDetails, onError }: { policy: ResearchPolicy | null; running: boolean; onRefresh: () => unknown; onDetails: () => void; onError?: (message: string) => void }) {
  const [menu, setMenu] = useState(false), [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [menu]);
  if (!policy) return null;
  const current = approvalModes.find(item => item.mode === policy.mode) ?? approvalModes[0];
  const choose = async (mode: ApprovalMode) => {
    if (saving || mode === policy.mode) { setMenu(false); return; }
    setSaving(true);
    try { await api(`/api/projects/${policy.projectId}/policy`, { method: 'PUT', body: JSON.stringify({ mode }) }); await onRefresh(); setMenu(false); }
    catch (cause) { onError?.(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const Icon = current.icon;
  return <div className="ros-model ros-approval">
    <button ref={trigger} type="button" className={`ros-chip-button mode-${policy.mode}`} aria-haspopup="menu" aria-expanded={menu} disabled={saving} title={running ? 'Applies to the next step' : 'How Ros’s actions are approved'} {...openOnPress(() => setMenu(value => !value))}>
      <Icon size={13}/><span>{current.label}</span>{saving ? <LoaderCircle size={11} className="spin"/> : <ChevronDown size={11}/>}
    </button>
    {menu && <div ref={menuRef} className="ros-model-menu" role="menu" aria-label="How Ros’s actions are approved">
      <p>How should Ros’s actions be approved?</p>
      {approvalModes.map(item => { const ItemIcon = item.icon; return <button key={item.mode} type="button" role="menuitemradio" aria-checked={policy.mode === item.mode} className={`mode-${item.mode}`} onClick={() => void choose(item.mode)}><ItemIcon size={16}/><span className="ros-menu-label">{item.label}<small>{item.detail}</small></span>{policy.mode === item.mode && <Check size={14}/>}</button>; })}
      {policy.mode === 'full' && <p className="ros-menu-note"><TriangleAlert size={12}/> Runs in the isolated sandbox; the map keeps its history.</p>}
      <hr/>
      <button type="button" role="menuitem" onClick={() => { setMenu(false); onDetails(); }}><ShieldCheck size={14}/><span className="ros-menu-label">Permissions and usage</span></button>
    </div>}
  </div>;
}
