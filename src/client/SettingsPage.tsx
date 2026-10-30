import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brain, ChevronLeft, ChevronRight, ChartColumn, ExternalLink, FolderOpen, LoaderCircle, RefreshCw, Settings2, Wallet } from 'lucide-react';
import { api } from './api';
import { ChipChoice } from './ChipChoice';
import { approvalModes } from './RosModelMenu';
import type { ApprovalMode, ResearchPolicy } from '../shared/research';
import type { BudgetLine, BudgetStatus, PlanUsage, ProviderBalance, UsageAnalytics, UsageEvent } from '../shared/budget-report';
import type { SetupResetPlan, SetupResetResponse } from '../shared/setup';
import { cloudAccountChanged } from './ProfileButton';
import { reloadLocalRos } from './local-ros-status';
import { BrandLogo } from './brand-logos';
import { RosMark } from './RosDock';
import { Commands, DownloadLink } from './UpdateButton';
import { checkForUpdates, installUpdate, setAutoUpdates, useUpdates } from './updates';
import { changeSuggestions, pluginName, useSuggestions } from './plugin-suggestions';
import { LAYER_ENGINES, type LayerStatus } from '../shared/ros-layer';
import './settings.css';

export type SettingsSection = 'general' | 'usage' | 'balances' | 'memory' | 'resources';
const sections: { id: SettingsSection; label: string; icon: typeof Settings2 }[] = [
  { id: 'usage', label: 'Usage', icon: ChartColumn },
  { id: 'balances', label: 'Balances', icon: Wallet },
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'resources', label: 'Resources', icon: FolderOpen },
];

/** Settings sections in the left menu, the way Plugins and Agents list theirs. */
export function SettingsSidebar({ section, onSection }: { section: SettingsSection; onSection: (section: SettingsSection) => void }) {
  return <div className="plugins-sidebar settings-sidebar">
    <div className="sidebar-label">Settings</div>
    {sections.map(item => <button key={item.id} type="button" className={`plugins-nav ${section === item.id ? 'active' : ''}`} aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}><item.icon size={15}/>{item.label}</button>)}
  </div>;
}

export function Row({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong>{detail && <small>{detail}</small>}</div><div className="settings-row-control">{children}</div></div>;
}

const usd = (value: number) => `US$${value.toFixed(2)}`;
/** A dollar amount with Save; an empty field clears it. */
function AmountField({ label, value, onSave }: { label: string; value: number | null; onSave: (value: number | null) => Promise<unknown> }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setDraft(value === null ? '' : String(value)); }, [value]);
  const parsed = draft.trim() === '' ? null : Number(draft), valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0), changed = parsed !== value;
  const save = async () => { setBusy(true); setError(''); try { await onSave(parsed); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <form className="amount-field" onSubmit={event => { event.preventDefault(); if (valid && changed && !busy) void save(); }}>
    <span className="amount-prefix">US$</span><input aria-label={label} inputMode="decimal" placeholder="None" value={draft} onChange={event => setDraft(event.target.value)}/>
    {changed && <button className="secondary small" type="submit" disabled={!valid || busy}>{busy ? <LoaderCircle size={13} className="spin"/> : 'Save'}</button>}
    {error && <span className="inline-error" role="alert">{error}</span>}
  </form>;
}
const budgetDetail = (line: BudgetLine) => line.monthlyUsd === null ? `No budget. ${usd(line.spentUsd)} spent this month.` : `${usd(line.spentUsd)} spent this month, ${usd(line.leftUsd ?? 0)} left. Paid requests stop when it runs out.`;

const approvalDetail: Record<ApprovalMode, string> = {
  ask: 'Every code run, and every canvas change an agent makes, waits for your OK.',
  review: 'Plain data-analysis code runs straight away, and agents add, move and regroup blocks. Edits, removals and other code wait for your OK.',
  full: 'Code runs straight away in the sandbox and agents change the canvas at once. Everything stays undoable.',
};

export function GeneralSettings({ projectId, projectTitle, policy, publicDemo, onChanged }: { projectId: string | null; projectTitle: string | null; policy: ResearchPolicy | null; publicDemo: boolean; onChanged: () => Promise<unknown> }) {
  const [paths, setPaths] = useState<{ dataDir: string | null; keysFile: string | null } | null>(null);
  const [mode, setMode] = useState<ApprovalMode>(policy?.mode ?? 'ask'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [network, setNetwork] = useState<{ mode: 'ask' | 'full'; preset: string[]; sites: string[] } | null>(null);
  const networkUrl = `/api/python-network${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;
  // Only sandboxed Python (macOS) has a network proxy; elsewhere this row stays hidden.
  useEffect(() => { if (!publicDemo) void api<NonNullable<typeof network>>(networkUrl).then(setNetwork).catch(() => setNetwork(null)); }, [publicDemo, networkUrl]);
  const saveNetwork = async (mode: 'ask' | 'full') => { const saved = await api<{ mode: 'ask' | 'full' }>('/api/python-network', { method: 'PUT', body: JSON.stringify({ mode }) }); setNetwork(current => current && { ...current, mode: saved.mode }); };
  const forgetSite = async (host: string) => { if (!projectId) return; const { sites } = await api<{ sites: string[] }>(`/api/python-network/sites/${encodeURIComponent(projectId)}/${encodeURIComponent(host)}`, { method: 'DELETE' }); setNetwork(current => current && { ...current, sites }); };
  const budgetUrl = `/api/settings/budget${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;
  useEffect(() => { if (!publicDemo) void api<BudgetStatus>(budgetUrl).then(setBudget).catch(() => {}); }, [publicDemo, budgetUrl]);
  const saveBudget = async (scope: 'all' | 'project', monthlyUsd: number | null) => setBudget(await api<BudgetStatus>('/api/settings/budget', { method: 'PUT', body: JSON.stringify({ scope, ...(scope === 'project' ? { projectId } : {}), monthlyUsd }) }));
  useEffect(() => { setMode(policy?.mode ?? 'ask'); }, [policy?.mode, projectId]);
  useEffect(() => { if (!publicDemo) void api<{ dataDir: string | null; keysFile: string | null }>('/api/settings/general').then(setPaths).catch(() => {}); }, [publicDemo]);
  const choose = async (next: ApprovalMode) => {
    if (!projectId) return;
    const previous = mode; setMode(next); setBusy(true); setError('');
    try { await api(`/api/projects/${projectId}/policy`, { method: 'PUT', body: JSON.stringify({ mode: next }) }); await onChanged(); }
    catch (cause) { setMode(previous); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="settings-page">
    <h1>General</h1>
    {!publicDemo && <UpdateSettings/>}
    {projectId && <section><h2>This project</h2><div className="settings-card">
      <Row title="Permissions" detail={`${projectTitle ? `${projectTitle}: ` : ''}${approvalDetail[mode]}`}>
        <ChipChoice label="Project permissions" caption="Agents may" value={mode} busy={busy} options={approvalModes.map(item => { const Icon = item.icon; return { id: item.mode, label: item.label, detail: item.detail, icon: <Icon size={13}/> }; })} onChange={value => void choose(value)}/>
      </Row>
    </div>{error && <p className="inline-error" role="alert">{error}</p>}</section>}
    {!publicDemo && <RosLayerSettings/>}
    {!publicDemo && <SuggestionSettings/>}
    {!publicDemo && budget && <section><h2>Monthly budget</h2><div className="settings-card">
      <Row title="All projects" detail={budgetDetail(budget.all)}><AmountField label="Monthly budget for all projects" value={budget.all.monthlyUsd} onSave={value => saveBudget('all', value)}/></Row>
      {budget.project && <Row title={projectTitle ?? 'This project'} detail={budgetDetail(budget.project)}><AmountField label="Monthly budget for this project" value={budget.project.monthlyUsd} onSave={value => saveBudget('project', value)}/></Row>}
    </div></section>}
    {network && <section><h2>Python network</h2><div className="settings-card">
      <Row title="Sites" detail={network.mode === 'full' ? 'Python in Code and Notebook blocks can reach any website.' : `Python asks before reaching a new website. ${network.preset.join(' and ')} are always allowed for installing packages.`}>
        <ChipChoice label="Python network" value={network.mode} options={[{ id: 'ask', label: 'Ask for each site' }, { id: 'full', label: 'Full network' }]} onChange={value => void saveNetwork(value)}/>
      </Row>
      {projectId && network.mode === 'ask' && network.sites.map(host => <Row key={host} title={host} detail={`Always allowed in ${projectTitle ?? 'this project'}.`}><button className="small text-button" onClick={() => void forgetSite(host)}>Remove</button></Row>)}
    </div></section>}
    {!publicDemo && <AppSettings/>}
    {!publicDemo && <FirstRunSettings/>}
    {!publicDemo && <section><h2>On this computer</h2><div className="settings-card">
      <Row title="Data folder" detail="Projects, notes and usage records are saved here."><code title={paths?.dataDir ?? ''}>{paths?.dataDir ?? '…'}</code></Row>
      <Row title="Keys file" detail="API keys every data folder reads, kept outside the code."><code title={paths?.keysFile ?? ''}>{paths ? paths.keysFile ?? 'None' : '…'}</code></Row>
    </div></section>}
  </div>;
}

type ResetOption = 'links' | 'tokens' | 'apps' | 'models' | 'cloud' | 'localRos';
/** Reset all connections, to test the first run again: every ros-ai entry in the agents' settings (whichever ros.ai wrote
 * it), saved tokens, app sign-ins, model servers and the hosted ROS sign-in go, each kept by unticking it, and the first
 * run starts again from the welcome page, as on a new computer. The ROS download stays unless it is ticked. */
function FirstRunSettings() {
  const [plan, setPlan] = useState<SetupResetPlan | null>(null), [choice, setChoice] = useState<Record<ResetOption, boolean>>({ links: true, tokens: true, apps: true, models: true, cloud: true, localRos: false });
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState<string[]>([]), [error, setError] = useState('');
  const show = () => window.dispatchEvent(new CustomEvent('ros-setup-reset', { detail: { from: 'welcome' } }));
  const start = async () => { setError(''); setFailed([]); setBusy(true); try { setPlan(await api<SetupResetPlan>('/api/setup/reset')); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const reset = async () => {
    if (!plan) return;
    setBusy(true); setError('');
    try {
      const chosen = (option: ResetOption, there: boolean) => choice[option] && there;
      const request = { links: chosen('links', plan.links.length > 0), tokens: chosen('tokens', plan.tokens.length > 0), apps: chosen('apps', plan.apps.length > 0), models: chosen('models', plan.models.length > 0), cloud: chosen('cloud', plan.cloud), localRos: chosen('localRos', plan.localRos) };
      const answer = await api<SetupResetResponse>('/api/setup/reset', { method: 'POST', body: JSON.stringify(request) });
      setPlan(null);
      if (request.cloud) cloudAccountChanged();
      if (request.localRos) void reloadLocalRos();
      // What could not be undone stays here to read; otherwise the welcome page opens at once.
      if (answer.failed.length) setFailed(answer.failed); else show();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const options: { id: ResetOption; label: string; detail?: string }[] = plan ? [
    ...(plan.links.length ? [{ id: 'links' as const, label: 'Remove the ros-ai link from your agents', detail: plan.links.join(', ') }] : []),
    ...(plan.apps.length ? [{ id: 'apps' as const, label: 'Disconnect your apps', detail: plan.apps.join(', ') }] : []),
    ...(plan.tokens.length ? [{ id: 'tokens' as const, label: 'Forget saved tokens', detail: plan.tokens.join(', ') }] : []),
    ...(plan.models.length ? [{ id: 'models' as const, label: 'Disconnect model servers', detail: plan.models.join(', ') }] : []),
    ...(plan.cloud ? [{ id: 'cloud' as const, label: 'Sign out of hosted ROS' }] : []),
    ...(plan.localRos ? [{ id: 'localRos' as const, label: 'Remove the ROS download', detail: 'ROS on this computer, about 3 GB. Left unticked, it stays.' }] : []),
  ] : [];
  return <section><h2>First run</h2><div className="settings-card">
    <Row title="Show the welcome again" detail="Walk through the welcome, account and tools pages once more. Nothing is reset: the sign-in, the links and the download stay.">
      <button type="button" className="secondary small" onClick={show}>Show</button>
    </Row>
    <Row title="Reset all connections" detail="Undo every link and sign-in on this computer, then start again from the welcome page, as on a new computer.">
      <button type="button" className="secondary small" disabled={busy} aria-expanded={Boolean(plan)} onClick={() => plan ? setPlan(null) : void start()}>{busy && !plan && <LoaderCircle size={13} className="spin"/>}Reset all…</button>
    </Row>
    {plan && <div className="settings-confirm">
      <div className="settings-options">
        <label className="settings-option"><input type="checkbox" checked disabled/><span><span>Show the welcome, sign-in and tools pages again</span></span></label>
        {options.map(option => <label key={option.id} className="settings-option"><input type="checkbox" checked={choice[option.id]} onChange={event => setChoice(current => ({ ...current, [option.id]: event.target.checked }))}/><span><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</span></label>)}
      </div>
      {!options.length && <p className="settings-confirm-note">Nothing is connected on this computer; only the welcome comes back.</p>}
      <div className="settings-confirm-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setPlan(null)}>Cancel</button><button type="button" className="primary small" disabled={busy} onClick={() => void reset()}>{busy && <LoaderCircle size={13} className="spin"/>}Reset all</button></div>
    </div>}
    {failed.length > 0 && <div className="settings-confirm">
      <p className="settings-confirm-note">Reset, except for these:</p>
      <ul className="settings-confirm-list">{failed.map(line => <li key={line}>{line}</li>)}</ul>
      <div className="settings-confirm-actions"><button type="button" className="primary small" onClick={() => { setFailed([]); show(); }}>Show the welcome page</button></div>
    </div>}
  </div>{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

const layerEngine: Record<LayerStatus['engine'], string> = {
  local: 'Runs on Local ROS on this computer.',
  hosted: 'Runs on hosted ROS while you are signed in.',
  layout: 'Until Local ROS is downloaded or you sign in to hosted ROS, ros.ai’s own rules do it.',
};
/** ROS on top of whichever agent runs a turn: the switch, what it runs on, and behind More the counts that tell whether
 * it helps and how fast it is on this computer. */
function RosLayerSettings() {
  const [status, setStatus] = useState<LayerStatus | null>(null), [more, setMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { void api<LayerStatus>('/api/ros-layer').then(setStatus).catch(() => setStatus(null)); }, []);
  if (!status) return null;
  const run = async (work: () => Promise<LayerStatus>) => { setBusy(true); setError(''); try { setStatus(await work()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const { stats, bench } = status, plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`, seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  return <section><h2>ROS</h2><div className="settings-card">
    <Row title="ROS arranges what agents add" detail={`After each agent turn, ROS groups and links what was left loose and puts an answer given only in chat on the map. Undo it on the turn's card. ${layerEngine[status.engine]}`}>
      <button type="button" role="switch" aria-checked={status.on} aria-label="ROS arranges what agents add" className={`switch ${status.on ? 'on' : ''}`} disabled={busy} onClick={() => void run(() => api('/api/ros-layer', { method: 'PUT', body: JSON.stringify({ on: !status.on }) }))}><span/></button>
    </Row>
    {more && <>
      <Row title="What agents left" detail={stats.turns ? `${plural(stats.turns, 'agent turn')}: ${plural(stats.blocks, 'block')} added, ${stats.loose} of them loose (no group, no link); ${plural(stats.chatOnly, 'answer')} only in chat; ${(stats.changes / stats.turns).toFixed(1)} changes per turn.` : 'No agent turns counted yet.'}><span/></Row>
      <Row title="What ROS did" detail={stats.rows ? `${plural(stats.rows, 'row')}, ${stats.rescued} of them answers put on the map: ${stats.accepted} kept, ${stats.undone} undone, ${stats.dismissed} dismissed.${stats.fallback ? ` ${stats.fallback} made by ros.ai’s own rules when ROS did not answer.` : ''}` : 'Nothing arranged yet.'}><span/></Row>
      {status.engine !== 'layout' && <Row title="Speed on this computer" detail={bench ? `${LAYER_ENGINES[bench.engine]} read ${bench.promptTokens.toLocaleString()} tokens in ${seconds(bench.prefillMs)} and wrote ${bench.outputTokens} in ${seconds(bench.decodeMs)}, ${ago(bench.at)}.` : 'Reads a map of about 8,000 tokens, then writes a short answer.'}>
        <button type="button" className="secondary small" disabled={busy} onClick={() => void run(() => api('/api/ros-layer/bench', { method: 'POST', signal: AbortSignal.timeout(200_000) }))}>{busy && <LoaderCircle size={13} className="spin"/>}{bench ? 'Measure again' : 'Measure'}</button>
      </Row>}
    </>}
  </div><button type="button" className="text-button small settings-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

/** Whether agents may build App blocks. Off, they see their tools exactly as before; people can always add one. */
function AppSettings() {
  const [settings, setSettings] = useState<{ agents: boolean; running: boolean } | null>(null), [error, setError] = useState('');
  useEffect(() => { void api<{ agents: boolean; running: boolean }>('/api/apps/settings').then(setSettings).catch(() => setSettings(null)); }, []);
  if (!settings) return null;
  const toggle = async () => { setError(''); try { setSettings(await api('/api/apps/settings', { method: 'PUT', body: JSON.stringify({ agents: !settings.agents }) })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  return <section><h2>Apps</h2><div className="settings-card">
    <Row title="Agents can build apps" detail="Agents may add App blocks: pages that run sealed on their card, with no web access, reading only the blocks they name.">
      <button type="button" role="switch" aria-checked={settings.agents} aria-label="Agents can build apps" className={`switch ${settings.agents ? 'on' : ''}`} onClick={() => void toggle()}><span/></button>
    </Row>
  </div>{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

/** Whether ros.ai offers a plugin in the conversation when a request needs one, and the plugins put off or declined. */
function SuggestionSettings() {
  const status = useSuggestions(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!status) return null;
  const run = async (path: string, init: RequestInit) => { setBusy(true); setError(''); try { await changeSuggestions(path, init); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const day = (when: string) => new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return <section><h2>Plugin suggestions</h2><div className="settings-card">
    <Row title="Suggest plugins in conversations" detail="When a request needs a plugin you haven't connected, ros.ai offers it. Nothing connects until you click.">
      <button type="button" role="switch" aria-checked={status.enabled} aria-label="Suggest plugins in conversations" className={`switch ${status.enabled ? 'on' : ''}`} disabled={busy} onClick={() => void run('/api/suggestions', { method: 'PUT', body: JSON.stringify({ enabled: !status.enabled }) })}><span/></button>
    </Row>
    {status.enabled && status.silenced.map(item => <Row key={`${item.pluginId}:${item.projectId ?? ''}`} title={pluginName(item.pluginId)} detail={item.projectId ? `Not now in ${item.projectTitle ?? 'a removed project'}${item.until ? `, until ${day(item.until)}` : ''}.` : 'Not suggested in any project.'}>
      <button className="small text-button" disabled={busy} onClick={() => void run(`/api/suggestions/silenced/${item.pluginId}${item.projectId ? `?projectId=${encodeURIComponent(item.projectId)}` : ''}`, { method: 'DELETE' })}>Undo</button>
    </Row>)}
  </div>{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

const ago = (when: string) => {
  const minutes = Math.round((Date.now() - Date.parse(when)) / 60_000), hours = Math.round(minutes / 60);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `on ${new Date(when).toLocaleDateString()}`;
};
const megabytes = (bytes = 0) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** The version this ros.ai runs, a newer one when there is one, and whether ros.ai looks by itself. */
function UpdateSettings() {
  const status = useUpdates(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!status) return null;
  const run = async (task: () => Promise<unknown>) => { setBusy(true); setError(''); try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const { latest, checking } = status, problem = error || status.error;
  const whatsNew = latest && <a href={latest.url} target="_blank" rel="noreferrer">What's new</a>;
  const check = <button className="secondary small" disabled={busy || checking} onClick={() => void run(checkForUpdates)}>{(busy || checking) && <LoaderCircle size={13} className="spin"/>}Check now</button>;
  let row: [title: string, detail: ReactNode, control: ReactNode];
  if (!status.enabled) row = [`ros.ai ${status.version}`, 'Update checks are off (ROS_UPDATE_URL=off).', null];
  else if (!latest) row = [`ros.ai ${status.version}`, checking ? 'Checking for a newer version…' : `Up to date.${status.checkedAt ? ` Checked ${ago(status.checkedAt)}.` : ''}`, check];
  else if (status.state === 'installing') row = [`Updating to ${latest.version}`, 'ros.ai restarts by itself.', <LoaderCircle size={14} className="spin"/>];
  else if (status.state === 'downloading') {
    const share = status.totalBytes ? Math.min(100, Math.round((status.doneBytes ?? 0) / status.totalBytes * 100)) : 0;
    row = [`ros.ai ${latest.version} is downloading`, <>{share}% of {megabytes(status.totalBytes)}. Keep working; the Update button appears when it is ready.<span className="update-progress"><span style={{ width: `${share}%` }}/></span></>, null];
  }
  else if (status.action === 'restart') row = [`ros.ai ${latest.version} is ready`, <>You have {status.version}. The new version downloaded in the background. {whatsNew}</>, <button className="primary small" disabled={busy} onClick={() => void run(installUpdate)}>{busy && <LoaderCircle size={13} className="spin"/>}Restart to update</button>];
  else if (status.action === 'update') row = [`ros.ai ${latest.version} is out`, <>You run {status.version} from a git checkout. Update pulls {latest.version}, installs packages if they changed, rebuilds and restarts. {whatsNew}</>, <button className="primary small" disabled={busy} onClick={() => void run(installUpdate)}>{busy && <LoaderCircle size={13} className="spin"/>}Update and restart</button>];
  else if (status.action === 'steps') row = [`ros.ai ${latest.version} is out`, <>{status.note} {whatsNew}{status.commands && <Commands text={status.commands}/>}</>, status.commands ? status.install === 'source' && check : <DownloadLink status={status} button/>];
  // Found, not ready yet: the Mac app downloads it next, or the download failed and Check now tries again.
  else row = [`ros.ai ${latest.version} is out`, checking ? 'Getting it ready…' : `You have ${status.version}.`, check];
  return <section><h2>Updates</h2><div className="settings-card">
    <Row title={row[0]} detail={row[1]}>{row[2]}</Row>
    {status.enabled && <Row title="Check for updates" detail={status.auto ? 'Asks GitHub for the newest release when ros.ai starts and every six hours. Nothing about you or this computer is sent.' : 'Off. ros.ai looks only when you press Check now.'}>
      <button type="button" role="switch" aria-checked={status.auto} aria-label="Check for updates" className={`switch ${status.auto ? 'on' : ''}`} disabled={busy} onClick={() => void run(() => setAutoUpdates(!status.auto))}><span/></button>
    </Row>}
  </div>{problem && <p className="inline-error" role="alert">{problem}</p>}</section>;
}

// Categorical slots in fixed order; anything past them folds into Other.
const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'];
const OTHER = '#b4b4b0';
const DAY = 24 * 60 * 60 * 1000;
type Range = 7 | 30;
type Group = 'model' | 'task';
const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < .01 ? 4 : 2 }).format(value);
const startOfDay = (time: number) => { const day = new Date(time); day.setHours(0, 0, 0, 0); return day.getTime(); };
const dayLabel = (time: number) => new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const groupOf = (event: UsageEvent, group: Group) => group === 'model' ? event.model ?? event.providerName : event.task;
const share = (part: number, total: number) => { if (!total) return '0%'; const value = part / total * 100; return value > 0 && value < .1 ? '<0.1%' : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`; };

/** What each model and each kind of work spent, from the usage this computer recorded. */
export function UsageSettings({ publicDemo }: { publicDemo: boolean }) {
  const [data, setData] = useState<UsageAnalytics | null>(null), [error, setError] = useState('');
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  useEffect(() => { if (!publicDemo) void api<BudgetStatus>('/api/settings/budget').then(setBudget).catch(() => {}); }, [publicDemo, data]);
  const [range, setRange] = useState<Range>(7), [group, setGroup] = useState<Group>('model'), [offset, setOffset] = useState(0), [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    const load = () => api<UsageAnalytics>('/api/usage/analytics').then(value => { if (current) { setData(value); setError(''); } }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    void load(); const timer = window.setInterval(load, 30000);
    return () => { current = false; window.clearInterval(timer); };
  }, []);
  const view = useMemo(() => {
    const end = startOfDay(Date.now()) - offset * range * DAY, start = end - (range - 1) * DAY;
    const events = (data?.events ?? []).filter(event => { const at = Date.parse(event.at); return at >= start && at < end + DAY; });
    const totals = new Map<string, number>();
    for (const event of events) totals.set(groupOf(event, group), (totals.get(groupOf(event, group)) ?? 0) + (event.costUsd ?? 0));
    // Colour follows the name: ranked across all recorded usage, not this window, so paging never repaints a series.
    const allTotals = new Map<string, number>();
    for (const event of data?.events ?? []) allTotals.set(groupOf(event, group), (allTotals.get(groupOf(event, group)) ?? 0) + (event.costUsd ?? 0));
    const ranked = [...allTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const named = ranked.slice(0, palette.length), color = (name: string) => named.includes(name) ? palette[named.indexOf(name)] : OTHER;
    const series = [...totals.entries()].filter(([, usd]) => usd > 0).sort((a, b) => b[1] - a[1]).map(([name, usd]) => ({ name, usd, color: color(name) }));
    const days = Array.from({ length: range }, (_, index) => {
      const at = start + index * DAY, dayEvents = events.filter(event => startOfDay(Date.parse(event.at)) === at);
      const parts = series.map(item => ({ ...item, usd: dayEvents.filter(event => groupOf(event, group) === item.name).reduce((sum, event) => sum + (event.costUsd ?? 0), 0) })).filter(item => item.usd > 0);
      return { at, parts, usd: parts.reduce((sum, item) => sum + item.usd, 0), requests: dayEvents.length };
    });
    const total = series.reduce((sum, item) => sum + item.usd, 0), unknown = events.filter(event => event.costUsd === null).length;
    const top = new Map<string, { title: string; place: string; model: string; models: Set<string>; usd: number; requests: number }>();
    for (const event of events) {
      const key = `${event.projectId ?? '-'}:${event.nodeTitle ?? '-'}:${event.task}`, model = event.model ?? event.providerName;
      const row = top.get(key) ?? { title: event.nodeTitle ?? event.task, place: [event.projectTitle ?? 'No project', event.nodeTitle ? event.task : null].filter(Boolean).join(' · '), model, models: new Set<string>(), usd: 0, requests: 0 };
      row.models.add(model); row.usd += event.costUsd ?? 0; row.requests++; top.set(key, row);
    }
    return { start, end, days, series, total, unknown, requests: events.length, top: [...top.values()].sort((a, b) => b.usd - a.usd || b.requests - a.requests).slice(0, 10) };
  }, [data, range, group, offset]);
  const max = Math.max(...view.days.map(day => day.usd), 0);
  const earliest = data?.events.length ? startOfDay(Date.parse(data.events[data.events.length - 1].at)) : Date.now();
  const hovered = hover === null ? null : view.days[hover];
  return <div className="settings-page usage-page">
    <h1>Usage</h1>
    <p className="settings-lead">What your agents and models spent, by model and by task. Recorded on this computer; nothing is sent anywhere.</p>
    {publicDemo && <p className="rail-page-note">The demo makes no paid calls, so it records no usage.</p>}
    {budget?.all.monthlyUsd != null && <div className="settings-card budget-meter"><div><span>This month</span><strong>{usd(budget.all.spentUsd)} <small>of {usd(budget.all.monthlyUsd)} budget</small></strong></div><span className="budget-meter-left">{usd(budget.all.leftUsd ?? 0)} left</span><b className="budget-track"><i style={{ width: `${Math.min(100, budget.all.spentUsd / budget.all.monthlyUsd * 100)}%` }}/></b></div>}
    {!publicDemo && <PlanLimits/>}
    <div className="usage-controls">
      <div className="usage-segments" role="group" aria-label="Time range">{([7, 30] as const).map(value => <button key={value} type="button" aria-pressed={range === value} className={range === value ? 'active' : ''} onClick={() => { setRange(value); setOffset(0); }}>{value}d</button>)}</div>
      <ChipChoice label="Group usage" value={group} options={[{ id: 'model', label: 'By model' }, { id: 'task', label: 'By task' }]} onChange={setGroup}/>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <section className="settings-card usage-chart-card" aria-label="Spend over time">
      <header className="usage-chart-head">
        <div><span>{dayLabel(view.start)} – {dayLabel(view.end)}</span><strong>{data ? money(view.total) : '…'}</strong></div>
        <div className="usage-pager"><button type="button" className="icon-button" aria-label="Earlier" disabled={view.start <= earliest} onClick={() => setOffset(value => value + 1)}><ChevronLeft size={16}/></button><button type="button" className="icon-button" aria-label="Later" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 1))}><ChevronRight size={16}/></button></div>
      </header>
      <div className="usage-plot" onMouseLeave={() => setHover(null)}>
        <div className="usage-grid" aria-hidden="true"><i/><i/><i/><i/></div>
        <div className={`usage-bars ${range === 30 ? 'dense' : ''}`}>{view.days.map((day, index) => <div key={day.at} className="usage-day" onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} tabIndex={0} aria-label={`${dayLabel(day.at)}: ${money(day.usd)}`}>
          <div className="usage-stack" style={{ height: max ? `${Math.max(day.usd / max * 100, day.usd ? 2 : 0)}%` : 0 }}>{day.parts.map(part => <span key={part.name} style={{ flexGrow: part.usd, background: part.color }}/>)}</div>
        </div>)}</div>
        {hovered && hover !== null && <div className="usage-tip" style={{ left: `${(hover + .5) / range * 100}%` }}><strong>{dayLabel(hovered.at)} · {money(hovered.usd)}</strong>{hovered.parts.map(part => <span key={part.name}><i style={{ background: part.color }}/>{part.name}<b>{money(part.usd)}</b></span>)}{!hovered.parts.length && <span>{hovered.requests ? `${hovered.requests} request${hovered.requests === 1 ? '' : 's'}, no reported cost` : 'No usage'}</span>}</div>}
      </div>
      <div className="usage-axis" aria-hidden="true">{view.days.map((day, index) => <span key={day.at}>{index === 0 || index === range - 1 || (range === 7 ? index === 3 : index % 7 === 0 && index < range - 3) ? dayLabel(day.at) : ''}</span>)}</div>
      {view.series.length ? <ul className="usage-legend">{view.series.map(item => <li key={item.name} style={{ borderColor: item.color }}><span>{item.name}</span><strong>{share(item.usd, view.total)}</strong><small>{money(item.usd)}</small></li>)}</ul>
        : <p className="usage-empty">{!data ? <><LoaderCircle size={14} className="spin"/> Reading usage…</> : view.requests ? 'No reported cost in this period.' : 'No usage in this period.'}</p>}
      {view.unknown > 0 && <p className="usage-note">{view.unknown} request{view.unknown === 1 ? '' : 's'} without a reported cost {view.unknown === 1 ? 'is' : 'are'} not counted.</p>}
    </section>
    <section aria-label="Top tasks">
      <h2>Top tasks</h2>
      <div className="settings-card usage-table">
        <div className="usage-table-head"><span>Task</span><span>Model</span><span>Requests</span><span>Spent</span></div>
        {view.top.length ? view.top.map(row => <div key={`${row.place}:${row.title}`} className="usage-table-row"><span><strong>{row.title}</strong><small>{row.place}</small></span><span title={[...row.models].join(', ')}>{row.models.size > 1 ? `${row.model} +${row.models.size - 1}` : row.model}</span><span>{row.requests}</span><span>{money(row.usd)}</span></div>)
          : <p className="usage-empty">Nothing in this period.</p>}
      </div>
    </section>
  </div>;
}

const resetsAt = (at: string) => {
  const time = new Date(at), soon = time.getTime() - Date.now() < DAY;
  return `Resets ${time.toLocaleString(undefined, soon ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
};
const planName = (plan: string | null) => plan ? `${plan[0].toUpperCase()}${plan.slice(1)} plan` : null;

/** How much of the Claude and ChatGPT subscriptions' windows is used, as Claude Code and Codex report it. */
function PlanLimits() {
  const [plans, setPlans] = useState<PlanUsage[] | null>(null);
  useEffect(() => {
    let current = true;
    const load = () => api<{ plans: PlanUsage[] }>('/api/usage/plans').then(value => { if (current) setPlans(value.plans); }).catch(() => { if (current) setPlans(value => value ?? []); });
    void load(); const timer = window.setInterval(load, 60000);
    return () => { current = false; window.clearInterval(timer); };
  }, []);
  return <section className="plan-limits" aria-label="Subscription limits">
    <h2>Subscription limits</h2>
    <div className="settings-card">
      {!plans ? <p className="usage-empty plan-empty"><LoaderCircle size={14} className="spin"/> Asking Claude Code and Codex…</p>
        : plans.map(plan => <div key={plan.id} className="settings-row balance-row plan-row">
          <span className="balance-mark"><BrandLogo id={plan.id} size={20}/></span>
          <div className="settings-row-text"><strong>{plan.name}{planName(plan.plan) && <small> · {planName(plan.plan)}</small>}</strong>{(plan.state !== 'ready' || plan.message) && <small>{plan.message}</small>}</div>
          {plan.windows.length > 0 && <ul className="plan-windows">{plan.windows.map(item => <li key={item.label}>
            <span>{item.label}</span>
            <b className="plan-track" role="meter" aria-label={`${plan.name} ${item.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.usedPercent)}><i style={{ width: `${item.usedPercent}%` }}/></b>
            <strong>{Math.round(item.usedPercent)}%</strong>
            <small>{item.resetsAt ? resetsAt(item.resetsAt) : ''}</small>
          </li>)}</ul>}
        </div>)}
    </div>
  </section>;
}

/** What each connected model, agent or tool says is left, and where the provider keeps it to itself. */
export function BalanceSettings({ publicDemo }: { publicDemo: boolean }) {
  const [balances, setBalances] = useState<ProviderBalance[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); try { setBalances((await api<{ balances: ProviderBalance[] }>('/api/usage/balances')).balances); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  useEffect(() => { if (!publicDemo) void load(); }, [publicDemo]);
  const mark = (id: ProviderBalance['id']) => id === 'ros-cloud' ? <span className="plugins-mark-small balance-ros"><RosMark/></span> : <BrandLogo id={id} size={20}/>;
  // ROS cloud, Codex and Tavily report what is left; the others keep it in their own consoles.
  const typed = (item: ProviderBalance) => ['nebius', 'openai', 'claude'].includes(item.id);
  const saveCredit = async (id: string, amountUsd: number | null) => { await api(`/api/usage/credit/${id}`, { method: 'PUT', body: JSON.stringify({ amountUsd }) }); await load(); };
  const reports = (item: ProviderBalance) => ['ros-cloud', 'codex', 'tavily'].includes(item.id);
  const reported = balances?.filter(reports) ?? [], silent = balances?.filter(item => !reports(item)) ?? [];
  const row = (item: ProviderBalance) => <div key={item.id} className="settings-row balance-row"><span className="balance-mark">{mark(item.id)}</span><div className="settings-row-text"><strong>{item.name}</strong><small>{item.detail}</small></div><div className="settings-row-control">{item.left ? <span className="balance-left">{item.left}</span> : null}{typed(item) && <AmountField label={`${item.name} credit`} value={item.credit?.amountUsd ?? null} onSave={value => saveCredit(item.id, value)}/>}{!item.left && item.link && <a className="text-button" href={item.link} target="_blank" rel="noreferrer">Open <ExternalLink size={12}/></a>}</div></div>;
  return <div className="settings-page">
    <header className="settings-head"><div><h1>Balances</h1><p className="settings-lead">What is left with each connected model, agent and tool, where the provider reports it.</p></div>{!publicDemo && <button className="icon-button" aria-label="Check balances again" disabled={busy} onClick={() => void load()}><RefreshCw size={15} className={busy ? 'spin' : ''}/></button>}</header>
    {publicDemo && <p className="rail-page-note">The demo has no connected accounts.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!balances && !publicDemo && !error && <p className="usage-empty"><LoaderCircle size={14} className="spin"/> Checking…</p>}
    {balances && !balances.length && <p className="rail-page-note">Nothing is connected yet. Connect agents and tools on the Agents and Plugins pages.</p>}
    {reported.length > 0 && <section><h2>Reported by the provider</h2><div className="settings-card">{reported.map(row)}</div></section>}
    {silent.length > 0 && <section><h2>Entered by you</h2><p className="settings-lead balance-note">These providers keep your credit in their own console. Enter it once; ros.ai subtracts what it records from then on.</p><div className="settings-card">{silent.map(row)}</div></section>}
  </div>;
}
