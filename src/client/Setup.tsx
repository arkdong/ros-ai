import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, CircleCheck, Copy, Download, ExternalLink, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, SquareTerminal, X } from 'lucide-react';
import type { AgentId, AppId, LocalModelId, SetupLinkResponse, SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import type { PluginStatus } from '../shared/plugins';
import { BrandLogo, type BrandId } from './brand-logos';
import { RosMark } from './RosDock';
import { cloudAccountChanged } from './ProfileButton';
import { api, post } from './api';
import './setup.css';

/** First launch: what ros.ai found on this computer, on a card in the style of Ros's question box. Switches connect in
 * one go; apps that need a token take it in their row. Every agent link is one entry in that agent's own settings,
 * which the person can undo from Agents. */

const brands: Partial<Record<AgentId, BrandId>> = { 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini-cli', pi: 'pi', hermes: 'hermes' };
/** The agent's official mark where ros.ai has one, else a neutral terminal glyph. */
export function AgentIcon({ id, size = 20 }: { id: AgentId; size?: number }) {
  const brand = brands[id];
  return brand ? <BrandLogo id={brand} size={size}/> : <SquareTerminal size={size} strokeWidth={1.75}/>;
}
export const agentWhy: Record<AgentId, string> = {
  'claude-code': 'Adds ros.ai to Claude Code\'s tools. Your Claude login stays yours.',
  codex: 'Adds ros.ai to Codex\'s tools. Your ChatGPT login stays yours.',
  cursor: 'Adds ros.ai to Cursor\'s MCP servers, in its settings file.',
  'gemini-cli': 'Adds ros.ai to Gemini CLI\'s MCP servers, in its settings file.',
  pi: 'Adds ros.ai to Pi\'s MCP servers, in its settings file.',
  hermes: 'Adds ros.ai to Hermes Agent\'s tools. Your model keys stay yours.',
};
const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
export const gb = (bytes = 0) => `${(bytes / 1e9).toFixed(1)} GB`;
/** The Mac app adds ros.ai/<version> to its user agent; it opens sign-ins in the system browser. */
export const macApp = () => / ros\.ai\/\S+$/u.test(navigator.userAgent);

/** Ros on this computer, followed every two seconds while it downloads or starts. onReady: called once the model
 * answers, so the rest of ros.ai picks it up. */
export function useLocalRos(follow: boolean, onReady?: () => Promise<unknown>) {
  const [status, setStatus] = useState<LocalRosStatus>();
  const ready = useRef(onReady), last = useRef<LocalRosStatus['state'] | undefined>(undefined);
  ready.current = onReady;
  const load = useCallback(() => api<LocalRosStatus>('/api/local-ros').then(setStatus, () => undefined), []);
  useEffect(() => { if (follow) void load(); }, [follow, load]);
  const state = status?.state, working = state === 'downloading' || state === 'starting';
  useEffect(() => {
    if (!follow || !working) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [follow, working, load]);
  useEffect(() => {
    if (state === 'ready' && last.current && last.current !== 'ready') void ready.current?.().catch(() => undefined);
    last.current = state;
  }, [state]);
  return { status, set: setStatus };
}

/** A command or settings entry to paste, with a copy button. */
export function CommandBox({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const copy = async () => { try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copying was blocked. Select the command and copy it yourself.'); } };
  return <>
    <div className="setup-command"><code>{command}</code><button type="button" className="icon-button" aria-label={`Copy the ${label} command`} title="Copy" onClick={() => void copy()}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </>;
}

/** The Slack app a bot token comes from, made from a manifest with the scopes ros.ai reads and posts with. */
const slackManifest = { display_information: { name: 'ros.ai' }, features: { bot_user: { display_name: 'ros.ai', always_online: false } }, oauth_config: { scopes: { bot: ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'users:read', 'chat:write'] } }, settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false } };
/** Apps that take a token or key in their row: what they need, and where to make one. */
const tokenApps: Partial<Record<AppId, { need: string; button: string; placeholder: string; link: string; linkLabel: string }>> = {
  slack: { need: 'Needs the bot token of your own Slack app', button: 'Add token', placeholder: 'xoxb-…', linkLabel: 'Make a Slack app', link: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest))}` },
  zotero: { need: 'Needs a Zotero key', button: 'Add key', placeholder: 'Zotero API key', linkLabel: 'Create a key', link: 'https://www.zotero.org/settings/security#applications' },
  github: { need: 'Needs a token', button: 'Add token', placeholder: 'github_pat_…', linkLabel: 'Create a token', link: 'https://github.com/settings/personal-access-tokens' },
};

type Group = 'agents' | 'apps' | 'ros';
type Kind = 'agent' | 'sign-in' | 'desktop' | 'token' | 'setup' | 'ros' | 'local' | 'model' | 'keys';
/** One row of the card. switch: connected with the others by Connect; token: a field in the row; setup: done on Plugins;
 * state: nothing to do, already linked, connected or set, or a download under way (tone and progress); none: a hint only. */
type Item = { key: string; group: Group; kind: Kind; id: string; label: string; icon: ReactNode; detail: string; control: 'switch' | 'token' | 'setup' | 'state' | 'none'; on: boolean; state?: string; tone?: 'ok' | 'busy' | 'fail'; progress?: number; method?: 'cli' | 'file' };
const groups: { id: Group; label: string }[] = [{ id: 'agents', label: 'Your agents' }, { id: 'apps', label: 'Apps' }, { id: 'ros', label: 'Ros' }];

/** Why an app is on the list, strongest first: an agent already reaches it, it is open, it was used lately. */
function appReason(app: SetupStatus['apps'][number], computer: string) {
  if (app.usedBy.length) return `${list(app.usedBy)} already ${app.usedBy.length === 1 ? 'uses' : 'use'} it`;
  if (app.id === 'zotero' && app.running) return 'Zotero is open';
  if (app.signals.includes('signed in on the command line')) return 'signed in to the gh command line';
  if (app.used) return `used ${app.used}`;
  if (app.signals.includes('settings file')) return 'sentry-cli is set up';
  if (app.signals.includes('synced folder')) return 'its folder syncs here';
  return `on ${computer}`;
}

/** hostedRos: offer the hosted Ros sign-in here; off after the first run's account page asked already. localRos: Ros on this
 * computer, shown while it downloads and once it is there. */
function itemsFor(status: SetupStatus, { hostedRos = true, localRos }: { hostedRos?: boolean; localRos?: LocalRosStatus } = {}): Item[] {
  const items: Item[] = [];
  for (const agent of status.agents) {
    if (!agent.found) continue;
    const linked = Boolean(agent.link || agent.entry), fact = agent.signals.includes('used recently') ? 'used this week' : agent.signals.includes('signed in') ? 'signed in' : '';
    const where = agent.id === 'cursor' ? 'Works on your map from Cursor’s agent' : agent.id === 'codex' && agent.signals.includes('app') ? 'Works on your map from the Codex app and your terminal' : 'Works on your map from your terminal';
    items.push({ key: `agent:${agent.id}`, group: 'agents', kind: 'agent', id: agent.id, label: `Your own ${agent.label}`, icon: <AgentIcon id={agent.id} size={16}/>, method: agent.method,
      detail: linked ? '' : agent.linkable ? [where, fact].filter(Boolean).join(' · ') : 'Found · needs one line in your terminal',
      control: linked ? 'state' : 'switch', on: !linked && agent.linkable, ...(linked ? { state: 'Linked' } : {}) });
  }
  for (const app of status.apps) {
    if (!app.connect) continue;
    const base = { key: `app:${app.id}`, group: 'apps' as const, id: app.id, label: app.label, icon: <BrandLogo id={app.id as BrandId} size={16}/>, on: false };
    const why = appReason(app, status.computer);
    if (app.connected) items.push({ ...base, kind: app.connect, detail: '', control: 'state', state: 'Connected' });
    else if (app.connect === 'sign-in') items.push({ ...base, kind: 'sign-in', detail: `Sign in once · ${why}`, control: 'switch', on: app.suggested });
    else if (app.connect === 'desktop') items.push({ ...base, kind: 'desktop', ...(app.running ? { detail: 'Its desktop server is on · nothing to sign in', control: 'switch', on: app.suggested } : { detail: `Turn on its desktop server in ${app.label}’s Dev Mode, then look again`, control: 'none' }) });
    else if (app.connect === 'token') items.push({ ...base, kind: 'token', detail: `${tokenApps[app.id]?.need ?? 'Needs a token'} · ${why}`, control: 'token' });
    else items.push({ ...base, kind: 'setup', detail: `Set up once on Plugins · ${why}`, control: 'setup' });
  }
  if (status.cloud.available && (hostedRos || status.cloud.signedIn)) items.push({ key: 'ros', group: 'ros', kind: 'ros', id: 'ros', label: 'Ros, hosted by ros.ai', icon: <RosMark/>,
    ...(status.cloud.signedIn ? { detail: '', control: 'state', state: 'Signed in', on: false } : { detail: 'Free while ros.ai is new · one sign-in in your browser', control: 'switch', on: true }) });
  if (localRos?.supported && localRos.state !== 'not-downloaded') {
    const { state, doneBytes, totalBytes } = localRos, base = { key: 'local', group: 'ros' as const, kind: 'local' as const, id: 'local', label: `Ros on ${status.computer}`, icon: <RosMark/>, control: 'state' as const, on: false };
    if (state === 'downloading') items.push({ ...base, detail: `Downloading in the background · ${totalBytes ? `${gb(doneBytes)} of ${gb(totalBytes)}` : 'finding the files'}`, progress: totalBytes ? Math.min(100, Math.round(((doneBytes ?? 0) / totalBytes) * 100)) : 0 });
    else if (state === 'starting') items.push({ ...base, detail: 'Downloaded · getting Ros ready', state: 'Starting', tone: 'busy' });
    else if (state === 'ready') items.push({ ...base, detail: `Works offline · nothing leaves ${status.computer}`, state: 'Ready' });
    else items.push({ ...base, detail: localRos.error || 'The download stopped · try again in Agents', state: 'Stopped', tone: 'fail' });
  }
  for (const model of status.models) {
    if (!model.running) continue;
    const n = model.models.length, base = { key: `model:${model.id}`, group: 'ros' as const, kind: 'model' as const, id: model.id, label: model.label, icon: <BrandLogo id={model.id} size={16}/>, on: false };
    if (model.connectionId) items.push({ ...base, detail: '', control: 'state', state: 'Connected' });
    else if (!n) items.push({ ...base, detail: 'Running, with no model downloaded yet', control: 'none' });
    else items.push({ ...base, detail: `Running with ${n} model${n === 1 ? '' : 's'} · use them in Ros on ${status.computer}`, control: 'switch', on: true });
  }
  if (status.keys.length) items.push({ key: 'keys', group: 'ros', kind: 'keys', id: 'keys', label: 'Your keys', icon: <KeyRound size={16} strokeWidth={1.75}/>, on: false,
    detail: `${list(status.keys.map(key => key.label.replace(/ key$/u, '')))} · already set on ${status.computer}`, control: 'state', state: 'Ready' });
  return items;
}

/** What the first run connected, for the row on the question box afterwards. waiting: what still needs the person, and
 * where to finish it. localRos: Ros on this computer's name, when the first run started its download. */
export type SetupSummary = { connected: { key: string; label: string; icon: ReactNode }[]; waiting: { label: string; where: 'Plugins' | 'Agents' }[]; localRos?: string };
const placeOf = (item: Item): 'Plugins' | 'Agents' => item.kind === 'agent' || item.kind === 'ros' || item.kind === 'model' ? 'Agents' : 'Plugins';

/** One line on the Ros download the first run started, kept up to date while it runs. */
function downloadLine(label: string, local: LocalRosStatus) {
  if (local.state === 'downloading') return `${label} keeps downloading${local.totalBytes ? ` · ${((local.doneBytes ?? 0) / 1e9).toFixed(1)} of ${gb(local.totalBytes)}` : ''}`;
  if (local.state === 'starting') return `${label} · getting ready`;
  if (local.state === 'ready') return `${label} is ready`;
  if (local.state === 'failed') return `${label} · the download stopped, try again in Agents`;
  return '';
}

/** The row on the question box after the first run: what connected, what still waits for the person, and how the Ros
 * download is going. */
export function SetupDone({ summary, floating = false, onClose, onChanged }: { summary: SetupSummary; floating?: boolean; onClose: () => void; onChanged?: () => Promise<unknown> }) {
  const local = useLocalRos(Boolean(summary.localRos), onChanged).status;
  const n = summary.connected.length, places = [...new Set(summary.waiting.map(item => item.where))];
  const waiting = summary.waiting.length ? `${list(summary.waiting.map(item => item.label))} ${summary.waiting.length === 1 ? 'waits' : 'wait'} in ${list(places)}` : '';
  const download = summary.localRos && local ? downloadLine(summary.localRos, local) : '';
  // With nothing connected, the download is the news.
  const title = n ? `Connected ${n} ${n === 1 ? 'tool' : 'tools'}` : !waiting && download ? download : 'Nothing connected yet';
  return <div className={`setup-done ${floating ? 'floating' : ''}`} role="status">
    {!n && title === download ? <Download size={16}/> : <CircleCheck size={16} className={n ? 'ok' : ''}/>}
    <span className="setup-done-text"><strong>{title}</strong>{waiting && <span>{waiting}</span>}{download && title !== download && <span>{download}</span>}</span>
    {n > 0 && <span className="setup-logos" aria-hidden="true">{summary.connected.slice(0, 6).map(item => <span key={item.key}>{item.icon}</span>)}</span>}
    <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}><X size={14}/></button>
  </div>;
}

/** The chip under the card: what ros.ai looked at, what else it found, and Look again. */
function FoundMenu({ status, onRescan }: { status: SetupStatus; onRescan: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const also = [...status.apps.filter(app => !app.connect).map(app => app.label), ...status.models.filter(model => model.found && !model.running).map(model => `${model.label} (not running)`), ...(status.docker.found ? ['Docker'] : [])];
  const again = async () => { setBusy(true); try { await onRescan(); } finally { setBusy(false); } };
  return <div className="setup-found" ref={box}>
    <button type="button" className="setup-chip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><ShieldCheck size={12}/>Found on {status.computer}<ChevronDown size={11}/></button>
    {open && <div className="setup-menu" role="dialog" aria-label="What ros.ai looked at">
      <p className="setup-menu-title">What ros.ai looked at</p>
      <ul>{status.lookedAt.map(line => <li key={line}>{line}</li>)}</ul>
      {also.length > 0 && <p className="setup-menu-also">Also found: {list(also)}. Nothing to connect yet.</p>}
      <div className="setup-menu-foot"><span>Names and dates only. Nothing leaves {status.computer}.</span><button type="button" className="setup-small-button" disabled={busy} onClick={() => void again()}>{busy ? <LoaderCircle size={12} className="spin"/> : <RefreshCw size={12}/>}Look again</button></div>
    </div>}
  </div>;
}

/** A token or key pasted into its app's row, saved on this computer and checked with one read-only request. */
function TokenField({ item, onConnected, onCancel }: { item: Item; onConnected: () => Promise<unknown>; onCancel: () => void }) {
  const spec = tokenApps[item.id as AppId];
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || value.trim().length < 8) return;
    setBusy(true); setError('');
    try {
      await api(`/api/plugins/${item.id}`, { method: 'PUT', body: JSON.stringify({ token: value.trim() }) });
      const checked = await post<PluginStatus>(`/api/plugins/${item.id}/check`, {});
      if (checked.verified === false) throw new Error(checked.checkMessage ?? `${item.label} did not accept it.`);
      await onConnected();
    } catch (cause) { setError(fail(cause)); setBusy(false); }
  };
  return <form className="setup-field" onSubmit={event => void check(event)}>
    <div className="setup-field-row">
      <input type="password" autoComplete="off" spellCheck={false} autoFocus aria-label={`${item.label} ${spec?.button === 'Add key' ? 'key' : 'token'}`} placeholder={spec?.placeholder} value={value} maxLength={4096}
        onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}/>
      <button type="submit" className="setup-small-button" disabled={busy || value.trim().length < 8}>{busy && <LoaderCircle size={12} className="spin"/>}Check</button>
      <button type="button" className="setup-text-button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    {error && <p className="setup-error" role="alert">{error}</p>}
  </form>;
}

/** busy: still working; wait: the person's turn, in the sign-in window; next: a sign-in after it in the same window;
 * retry: the window closed before this sign-in, so it takes a click of its own. */
type Outcome = { state: 'busy' | 'ok' | 'fail' | 'wait' | 'next' | 'retry'; text: string; detail?: string; command?: string };
/** One step of the sign-ins in one window, as /api/apps/sign-ins answers. */
type ChainStep = { app?: AppId; url?: string; then?: 'ros'; connected: AppId[]; failed: { app: AppId; error: string }[] };
const settledStates: Outcome['state'][] = ['ok', 'fail', 'retry'];

/** In the first run's own window (framed): no hosted Ros row after its account page, the Ros download's progress, and
 * the step dots after the card. */
type Props = { status: SetupStatus; onDone: (summary?: SetupSummary) => void; onPlugins: (id: AppId) => void; onRescan: () => Promise<unknown>; onRefresh: () => Promise<unknown>; onChanged: () => Promise<unknown>;
  framed?: boolean; hostedRos?: boolean; localRos?: LocalRosStatus; after?: ReactNode };

export function SetupScreen({ status, onDone, onPlugins, onRescan, onRefresh, onChanged, framed = false, hostedRos = true, localRos, after }: Props) {
  const all = useMemo(() => itemsFor(status, { hostedRos, localRos }), [status, hostedRos, localRos]);
  // The person's own choices survive a new look at the computer; the rest follow what was found.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const isOn = (item: Item) => item.control === 'switch' && (touched[item.key] ?? item.on);
  const chosen = all.filter(isOn);
  const [field, setField] = useState<string | null>(null), [checked, setChecked] = useState<Item[]>([]);
  const [phase, setPhase] = useState<'choose' | 'connecting'>('choose');
  const [selected, setSelected] = useState<Item[]>([]), [queue, setQueue] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [closed, setClosed] = useState(false), [startedAt, setStartedAt] = useState(0), [now, setNow] = useState(() => Date.now());
  const popup = useRef<Window | null>(null), rosStarted = useRef(false), refreshed = useRef(false);
  const windowed = !macApp();
  // A connected sign-in is never set back by a late or repeated message.
  const settle = (key: string, outcome: Outcome) => setResults(current => current[key]?.state === 'ok' ? current : { ...current, [key]: outcome });

  // Coming back from another app (Figma's Dev Mode, a terminal) looks again, at most every few seconds.
  useEffect(() => {
    if (phase !== 'choose') return;
    let last = Date.now();
    const again = () => { if (Date.now() - last < 4000) return; last = Date.now(); void onRescan().catch(() => undefined); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [phase, onRescan]);

  const outcomeOf = (item: Item): Outcome => {
    const result = results[item.key];
    if (result) return result;
    if (!queue.includes(item.key)) return { state: 'busy', text: 'Connecting' };
    const name = item.kind === 'ros' ? 'ros.ai' : item.label;
    if (closed) return { state: 'retry', text: 'Sign in', detail: `The window closed before ${name} was connected` };
    const first = queue.find(key => !results[key]) === item.key;
    if (first) return { state: 'wait', text: 'Waiting for you', detail: windowed ? `Sign in to ${name} in the window that opened` : `Sign in to ${name} in your browser` };
    return { state: 'next', text: 'Up next', detail: item.kind === 'ros' ? windowed ? 'Last in the same window' : 'Last, in your browser' : windowed ? 'Next in the same window' : 'Next in your browser' };
  };
  const shown = selected.map(item => ({ item, outcome: outcomeOf(item) }));
  const settled = phase === 'connecting' && shown.every(entry => settledStates.includes(entry.outcome.state));
  const signingIn = phase === 'connecting' && queue.some(key => !results[key]) && !closed;

  // The sign-in pages say what happened over a BroadcastChannel; the Mac app's system browser cannot, so ros.ai also asks.
  useEffect(() => {
    if (phase !== 'connecting') return;
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel('ros-ai-plugins');
      channel.onmessage = event => {
        const data = event.data as { connected?: string; failed?: string; error?: string; next?: string } | null;
        if (data?.connected) settle(`app:${data.connected}`, { state: 'ok', text: 'Connected' });
        if (data?.failed) settle(`app:${data.failed}`, { state: 'fail', text: 'Couldn’t connect', detail: data.error });
        if (data?.next === 'ros') rosStarted.current = true;
        if (data?.next) setClosed(false);
      };
    } catch { /* The polling below still hears it. */ }
    return () => channel?.close();
  }, [phase]);
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(() => void (async () => {
      const [apps, cloud] = await Promise.all([
        queue.some(key => key.startsWith('app:')) ? api<{ apps: { id: string; connected: boolean }[] }>('/api/apps').catch(() => undefined) : undefined,
        queue.includes('ros') ? api<CloudAccountStatus>('/api/cloud').catch(() => undefined) : undefined,
      ]);
      for (const app of apps?.apps ?? []) if (app.connected && queue.includes(`app:${app.id}`)) settle(`app:${app.id}`, { state: 'ok', text: 'Connected' });
      if (cloud?.state === 'waiting') rosStarted.current = true;
      else if (cloud?.state === 'signed-in') settle('ros', { state: 'ok', text: 'Connected', detail: `Signed in${cloud.email ? ` as ${cloud.email}` : ''}. Ros now appears as a model.` });
      else if (cloud && rosStarted.current && cloud.error) settle('ros', { state: 'fail', text: 'Couldn’t connect', detail: cloud.error });
      // Closed by hand, the window gives the focus back; a window a sign-in page moved out of reach keeps it.
      if (popup.current?.closed && document.hasFocus()) { popup.current = null; setClosed(true); }
    })(), 2000);
    return () => clearInterval(timer);
  }, [signingIn, queue]);
  useEffect(() => {
    if (phase !== 'connecting' || settled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase, settled]);
  // Once everything has an answer, the rest of ros.ai picks up the new models and agents, and the profile button the sign-in.
  useEffect(() => {
    if (!settled || refreshed.current) return;
    refreshed.current = true;
    if (queue.includes('ros')) cloudAccountChanged();
    void onChanged().catch(() => undefined);
  }, [settled, onChanged, queue]);

  /** Browsers allow one new window per click, so it opens before anything is asked, and every sign-in runs in it. */
  const openWindow = () => {
    if (!windowed) return null;
    const target = window.open('', 'ros-ai-sign-in', 'popup,width=520,height=720');
    // A window still on a sign-in page belongs to another site, so it is only sent on, not written to.
    try { if (target) { target.opener = null; target.document.title = 'Signing in · ros.ai'; target.document.body.textContent = 'Opening the sign-in…'; } } catch { /* another site's page */ }
    return target;
  };
  const go = (url: string) => { const target = popup.current; if (target && !target.closed) target.location.href = url; else window.open(url, '_blank', 'noopener'); };
  const startRos = async () => {
    rosStarted.current = true;
    try {
      if (windowed) go(new URL('/api/cloud/start', window.location.href).href);
      else { const started = await post<CloudAccountStatus>('/api/cloud/sign-in'); if (started.verificationUrl) window.open(started.verificationUrl, '_blank', 'noopener'); }
    } catch (cause) { settle('ros', { state: 'fail', text: 'Couldn’t connect', detail: fail(cause) }); }
  };
  /** The apps' sign-ins one after another in one window, then hosted Ros: each sign-in page opens the next. */
  const startSignIns = async (apps: AppId[], ros: boolean) => {
    if (apps.length) {
      let step: ChainStep;
      try { step = await post<ChainStep>('/api/apps/sign-ins', { apps, ...(ros ? { then: 'ros' } : {}) }); }
      catch (cause) { for (const id of apps) settle(`app:${id}`, { state: 'fail', text: 'Couldn’t connect', detail: fail(cause) }); if (ros) await startRos(); return; }
      for (const id of step.connected) settle(`app:${id}`, { state: 'ok', text: 'Connected' });
      for (const item of step.failed) settle(`app:${item.app}`, { state: 'fail', text: 'Couldn’t connect', detail: item.error });
      if (step.url) { go(step.url); return; }
    }
    if (ros) await startRos();
    else popup.current?.close();
  };
  /** Open again, Sign in and Try again: the sign-ins still waiting, from this one on, in a new window. Those before it
   * were passed over, so each keeps a Sign in of its own. */
  const signInFrom = (item: Item) => {
    const left = queue.filter(key => !results[key] || results[key]!.state !== 'ok'), from = Math.max(0, left.indexOf(item.key)), keys = left.slice(from);
    const skipped = Object.fromEntries(left.slice(0, from).map(key => [key, { state: 'retry', text: 'Sign in', detail: 'Not signed in yet' } satisfies Outcome]));
    setResults(current => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))), ...skipped }));
    popup.current = openWindow();
    // A blocked window leaves the button to click again.
    if (windowed && !popup.current) { setClosed(true); return; }
    setClosed(false);
    void startSignIns(keys.filter(key => key.startsWith('app:')).map(key => key.slice(4) as AppId), keys.includes('ros'));
  };

  const connect = async () => {
    const picked = chosen;
    if (!picked.length) { finish(); return; }
    const signIns = picked.filter(item => item.kind === 'sign-in'), ros = picked.find(item => item.kind === 'ros');
    const order = [...signIns.map(item => item.key), ...(ros ? [ros.key] : [])];
    popup.current = order.length ? openWindow() : null;
    // A blocked window leaves a Sign in button on each of them instead.
    const blocked = order.length > 0 && windowed && !popup.current;
    setSelected(picked); setQueue(order); setPhase('connecting'); setStartedAt(Date.now()); setNow(Date.now()); setClosed(blocked);
    setResults(Object.fromEntries(picked.filter(item => !order.includes(item.key)).map(item => [item.key, {
      state: 'busy', text: item.kind === 'agent' ? 'Linking' : 'Connecting',
      detail: item.kind === 'agent' ? item.method === 'file' ? 'Adding one ros-ai entry to its settings file' : `Adding ros.ai with ${item.label.replace(/^Your own /u, '')}’s command line` : item.kind === 'desktop' ? 'Checking its desktop server' : 'Adding it as a model connection',
    } satisfies Outcome])));
    void post('/api/setup/seen').catch(() => undefined);
    const agents = picked.filter(item => item.kind === 'agent').map(item => item.id as AgentId), models = picked.filter(item => item.kind === 'model').map(item => item.id as LocalModelId);
    await Promise.all([
      (agents.length || models.length) && post<SetupLinkResponse>('/api/setup/links', { agents, models }).then(value => {
        for (const result of value.agents) settle(`agent:${result.agent}`, result.ok ? { state: 'ok', text: 'Linked', detail: result.message } : { state: 'fail', text: 'Couldn’t link', detail: result.message, ...(result.command ? { command: result.command } : {}) });
        for (const result of value.models) settle(`model:${result.id}`, result.ok ? { state: 'ok', text: 'Connected', detail: result.message } : { state: 'fail', text: 'Couldn’t connect', detail: result.message });
      }, (cause: unknown) => { for (const key of [...agents.map(id => `agent:${id}`), ...models.map(id => `model:${id}`)]) settle(key, { state: 'fail', text: 'Couldn’t connect', detail: fail(cause) }); }),
      ...picked.filter(item => item.kind === 'desktop').map(item => post(`/api/apps/${item.id}/connect`, {}).then(
        () => settle(item.key, { state: 'ok', text: 'Connected', detail: `Through ${item.label}’s desktop server on ${status.computer}` }),
        (cause: unknown) => settle(item.key, { state: 'fail', text: 'Couldn’t connect', detail: fail(cause) }))),
      order.length && !blocked && startSignIns(signIns.map(item => item.id as AppId), Boolean(ros)),
    ]);
  };
  /** Done, Not now, or nothing chosen: the card becomes the question box, with what connected on it. */
  const finish = (picked: Item[] = []) => {
    const ok = picked.filter(item => results[item.key]?.state === 'ok'), left = picked.filter(item => results[item.key]?.state !== 'ok');
    const connected = [...ok, ...checked].map(item => ({ key: item.key, label: item.label, icon: item.icon }));
    onDone(connected.length || left.length ? { connected, waiting: left.map(item => ({ label: item.kind === 'ros' ? 'Hosted Ros' : item.label, where: placeOf(item) })) } : undefined);
  };

  const card = (rows: (item: Item) => ReactNode, items: Item[]) => groups.map(group => {
    const members = items.filter(item => item.group === group.id);
    return members.length ? <Fragment key={group.id}><div className="setup-label">{group.label}</div>{members.map(rows)}</Fragment> : null;
  });
  const tile = (item: Item) => <span className="setup-tile" aria-hidden="true">{item.icon}</span>;
  const text = (item: Item, detail = item.detail) => <span className="setup-text"><span className="setup-name">{item.label}</span>{detail && <span className="setup-detail">{detail}</span>}</span>;
  const state = (tone: string, label: string) => <span className={`setup-state ${tone}`}>{tone === 'busy' ? <LoaderCircle size={12} className="spin"/> : <i/>}{label}</span>;
  const footer = (actions: ReactNode) => <footer className="setup-foot"><RosMark working={signingIn}/><FoundMenu status={status} onRescan={onRescan}/><span className="setup-space"/>{actions}</footer>;

  if (phase === 'connecting') {
    const ok = shown.filter(entry => entry.outcome.state === 'ok').length, current = shown.find(entry => entry.outcome.state === 'wait');
    const left = shown.filter(entry => entry.outcome.state !== 'ok'), places = [...new Set(left.map(entry => placeOf(entry.item)))];
    const heading = !settled ? `Connecting ${selected.length}` : ok === selected.length ? selected.length === 1 ? 'Connected' : `Connected all ${ok}` : `Connected ${ok} of ${selected.length}`;
    const line = current ? current.outcome.detail : !settled ? shown.find(entry => entry.outcome.state === 'busy')?.outcome.detail
      : left.length ? `${list(left.map(entry => entry.item.kind === 'ros' ? 'Hosted Ros' : entry.item.label))} ${left.length === 1 ? 'waits' : 'wait'} for you · finish later in ${list(places)}` : '';
    return <div className={`setup-screen ${framed ? 'framed' : ''}`}>
      <h1 className="setup-title">Connect your tools</h1>
      <section className="setup-card" aria-label="Connecting your tools" aria-busy={!settled}>
        <div className="setup-progress" role="status">
          {settled ? <CircleCheck size={15} className={ok === selected.length ? 'ok' : ''}/> : <LoaderCircle size={15} className="spin"/>}
          <span className="setup-progress-text"><strong>{heading}</strong>{line && <span>{line}</span>}</span>
          {!settled && <span className="setup-progress-meta">{clock(now - startedAt)}</span>}
        </div>
        {card(item => {
          const outcome = outcomeOf(item);
          return <Fragment key={item.key}>
            <div className="setup-row">
              {tile(item)}{text(item, outcome.detail ?? '')}
              {outcome.state === 'wait' && <button type="button" className="setup-text-button" onClick={() => signInFrom(item)}>Open again</button>}
              {outcome.state === 'retry' || (outcome.state === 'fail' && queue.includes(item.key))
                ? <button type="button" className="setup-small-button" onClick={() => signInFrom(item)}>{outcome.state === 'retry' ? 'Sign in' : 'Try again'}</button>
                : state(outcome.state, outcome.text)}
            </div>
            {outcome.command && <div className="setup-extra"><CommandBox command={outcome.command} label={item.label}/></div>}
          </Fragment>;
        }, selected)}
        {footer(<button type="button" className="primary setup-primary" onClick={() => finish(selected)}>Done</button>)}
      </section>
      {after}
    </div>;
  }

  return <div className={`setup-screen ${framed ? 'framed' : ''}`}>
    <h1 className="setup-title">Connect your tools</h1>
    <section className="setup-card" aria-label="Connect your tools">
      {card(item => {
        const open = field === item.key, spec = tokenApps[item.id as AppId], on = isOn(item);
        return <Fragment key={item.key}>
          <div className={`setup-row ${open ? 'open' : ''}`}>
            {tile(item)}{text(item)}
            {item.control === 'switch' && <button type="button" role="switch" aria-checked={on} aria-label={`Connect ${item.label}`} className={`setup-switch ${on ? 'on' : ''}`} onClick={() => setTouched(current => ({ ...current, [item.key]: !on }))}/>}
            {item.control === 'token' && spec && (open
              ? <a className="setup-link" href={spec.link} target="_blank" rel="noreferrer">{spec.linkLabel}<ExternalLink size={11}/></a>
              : <button type="button" className="setup-small-button" onClick={() => setField(item.key)}>{spec.button}</button>)}
            {item.control === 'setup' && <button type="button" className="setup-small-button" onClick={() => onPlugins(item.id as AppId)}>Set up</button>}
            {item.progress !== undefined && <span className="setup-bar" role="progressbar" aria-label={`${item.label} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}><i style={{ width: `${item.progress}%` }}/></span>}
            {item.control === 'state' && item.state && state(item.tone ?? 'ok', item.state)}
          </div>
          {open && <TokenField item={item} onCancel={() => setField(null)} onConnected={async () => { setField(null); setChecked(current => [...current.filter(entry => entry.key !== item.key), item]); await onRefresh(); }}/>}
        </Fragment>;
      }, all)}
      {footer(<>
        {chosen.length > 0 && <button type="button" className="setup-text-button setup-later" onClick={() => finish()}>Not now</button>}
        <button type="button" className="primary setup-primary" onClick={() => void connect()}>{chosen.length ? <><ArrowUp size={14}/>Connect {chosen.length}</> : 'Done'}</button>
      </>)}
    </section>
    {after}
  </div>;
}
