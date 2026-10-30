import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppWindow, ArrowUpRight, Check, ChevronDown, Copy, LoaderCircle, Search, SquareTerminal } from 'lucide-react';
import type { AgentId, AppId, LocalModelId, SetupLinkResponse, SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import type { GoogleDriveStatus } from '../shared/google-drive';
import { PLUGINS, zoteroAppProblem, type AppConnectionStatus } from '../shared/plugins';
import { BrandLogo, hasBrandLogo, type BrandId } from './brand-logos';
import { RosMark } from './RosDock';
import { api, post } from './api';
import { changeLocalRos, gb, percentOf, useLocalRosStatus } from './local-ros-status';
import './chip-menu.css';
import './setup.css';

/** Connect your tools: everything ros.ai found on this computer, in one list to tick, in one card in the bar's shape.
 * Connect then works through what was ticked. What needs nothing from the person (an agent's link, a model server, the
 * ROS download, Figma's desktop app, GitHub through the GitHub CLI's sign-in, Zotero through its app) runs at once in
 * the background; what needs the browser (a sign-in) opens one at a time, each as the one before it finishes, in one
 * window ros.ai moves along. Nothing here asks for a key: what only a key or a token connects waits on its Plugins page.
 * It is the last step of the first run (FirstRun.tsx) and comes back from Agents › Show the setup screen again. Every
 * link is one entry in that tool's own settings; the person can undo each one from Agents. */

const brands: Partial<Record<AgentId, BrandId>> = { 'claude-code': 'claude', 'claude-app': 'claude', codex: 'codex', 'gemini-cli': 'gemini-cli', pi: 'pi', hermes: 'hermes' };
/** The agent's official mark where ros.ai has one, else a neutral terminal glyph. */
export function AgentIcon({ id, size = 20 }: { id: AgentId; size?: number }) {
  const brand = brands[id];
  return brand ? <BrandLogo id={brand} size={size}/> : <SquareTerminal size={size} strokeWidth={1.75}/>;
}
export const agentWhy: Record<AgentId, string> = {
  'claude-code': 'Adds ros.ai to Claude Code\'s tools. Your Claude login stays yours.',
  'claude-app': 'Adds ros.ai to the Claude desktop app\'s connectors, in its settings file.',
  codex: 'Adds ros.ai to Codex\'s tools. Your ChatGPT login stays yours.',
  cursor: 'Adds ros.ai to Cursor\'s MCP servers, in its settings file.',
  'gemini-cli': 'Adds ros.ai to Gemini CLI\'s MCP servers, in its settings file.',
  pi: 'Adds ros.ai to Pi\'s MCP servers, in its settings file.',
  hermes: 'Adds ros.ai to Hermes Agent\'s tools. Your model keys stay yours.',
};
const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const words = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const count = (n: number) => words[n] ?? String(n);
const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** A command or settings entry to paste, with a copy button. */
export function CommandBox({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const copy = async () => { try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copying was blocked. Select the command and copy it yourself.'); } };
  return <>
    <div className="setup-command"><code>{command}</code><button type="button" className="icon-button" aria-label={`Copy the ${label} command`} title="Copy" onClick={() => void copy()}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </>;
}

/** The ROS-on-this-computer row of the first run: the download's progress, then Ready. Nothing to choose here. */
export function LocalRosRow({ status, computer }: { status: LocalRosStatus; computer: string }) {
  const percent = percentOf(status);
  const why = status.state === 'downloading' ? status.note || 'Downloading in the background' : status.state === 'starting' ? 'Downloaded · getting ROS ready' : status.state === 'ready' ? `Works offline. Nothing leaves ${computer}.` : status.error || 'The download stopped';
  return <div className="setup-row static">
    <span className="setup-tile" aria-hidden="true"><RosMark/></span>
    <span className="setup-text"><span className="setup-name">ROS on {computer}</span><span className="setup-why">{why}</span></span>
    {status.state === 'downloading' ? <span className="setup-cap">{status.totalBytes ? `${gb(status.doneBytes)} of ${gb(status.totalBytes)}` : 'Finding the files'}<span className="setup-bar" role="progressbar" aria-label="ROS download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></span></span>
      : status.state === 'starting' ? <span className="setup-state"><LoaderCircle size={12} className="spin"/>Starting</span>
      : status.state === 'ready' ? <span className="setup-state ok"><i/>Ready</span>
      : <span className="setup-state fail"><i/>Stopped</span>}
  </div>;
}

/** How a row connects. auto: by itself, in the background; terminal: an agent whose command line ros.ai cannot reach, so
 * the person pastes one line; sign-in: a sign-in in the browser; plugins: only on the app's Plugins page. */
type How = 'auto' | 'terminal' | 'sign-in' | 'plugins';
const tags: Record<How, string> = { auto: 'Automatic', terminal: 'Terminal line', 'sign-in': 'Sign in', plugins: 'In Plugins' };
/** How each app found here connects from this screen. GitHub and Zotero connect by themselves through what is on this
 * computer (the GitHub CLI's sign-in, the Zotero app) once it is ready (local), and wait on their Plugins pages
 * otherwise. Slack needs a Slack app of the person's own and Google Drive a Google app, so they stay on their Plugins
 * pages; Figma connects by itself once its desktop app's server is on. Obsidian and Dropbox have no plugin yet. */
const appHow: Partial<Record<AppId, How>> = { notion: 'sign-in', linear: 'sign-in', zotero: 'plugins', slack: 'plugins', github: 'plugins', figma: 'auto', 'google-drive': 'plugins' };
const localApps: ReadonlySet<AppId> = new Set<AppId>(['github', 'zotero']);
/** What a GitHub or Zotero row says: how it connects by itself, or what to do first. */
function localWhy(app: SetupStatus['apps'][number]) {
  if (app.id === 'github') return app.local === 'ready' ? 'Uses the GitHub CLI’s sign-in on this computer.' : 'Sign in to the GitHub CLI with gh auth login, or connect it in Plugins.';
  return app.local === 'ready' ? 'Reads your library through the Zotero app.' : app.local ? zoteroAppProblem(app.local).replace(/,? then try again\.$/u, ', then connect it in Plugins.') : 'Connect it in Plugins.';
}
/** One thing found here. done: already linked or connected, said in a word beside a green dot, with nothing to tick. */
type Item = { key: string; kind: 'agent' | 'model' | 'ros' | 'local' | 'app'; id: string; label: string; icon: ReactNode; why: string; how: How; on: boolean; done?: string };
/** Where a ticked row stands once Connect is pressed. next: waiting its turn; busy: ros.ai is on it; wait: the person
 * is signing in or pasting a key. url: the page that step opens; blocked: the browser kept it from opening. */
type Step = { state: 'next' | 'busy' | 'wait' | 'ok' | 'fail' | 'skip'; text: string; message?: string; command?: string; url?: string; blocked?: boolean };
type Props = {
  status: SetupStatus; onDone: () => void; onAgents: () => void; onChanged: () => Promise<unknown>;
  /** From the first run: the hosted ROS row starts off when the person chose to go without an account. */
  hostedOn?: boolean;
  /** Under the card: the first run's step caption. */
  after?: ReactNode;
};
const interactive = (item: Item) => item.how === 'sign-in';
/** The Mac app adds ros.ai/<version> to its user agent; it opens other sites in the system browser, a tab each. */
const macApp = () => / ros\.ai\/\S+$/u.test(navigator.userAgent);
const WINDOW = 'ros-ai-connect', FEATURES = 'popup,width=520,height=720';
/** The window the sign-ins open in, one after another. Opened blank, with no way back to this page; from a click, so the
 * browser allows it. */
function blankWindow(text: string) {
  const opened = window.open('', WINDOW, FEATURES);
  if (!opened) return null;
  try { opened.opener = null; opened.document.title = 'Connect your tools · ros.ai'; if (opened.document.body) opened.document.body.textContent = text; } catch { /* still on another site */ }
  return opened;
}
/** The window shows a page of ros.ai's own (blank, or where a sign-in ended), which this page may move on or close. On
 * another site's page it may not, and a window the browser cut off from this page reads as closed. */
const ours = (popup: Window) => { try { return Boolean(popup.location.href); } catch { return false; } };
/** Tells ros.ai's own page in the sign-in window where to go next, or to close: that page listens over this channel and
 * answers (followScript on the server), which reaches it even when the browser cut the window off from this page. False
 * when no page answered. */
function steer(to: string) {
  return new Promise<boolean>(resolve => {
    let channel: BroadcastChannel;
    try { channel = new BroadcastChannel('ros-ai-plugins'); } catch { resolve(false); return; }
    const done = (answered: boolean) => { clearTimeout(timer); channel.close(); resolve(answered); };
    channel.onmessage = event => { if ((event.data as { steered?: string } | null)?.steered === to) done(true); };
    const timer = setTimeout(() => done(false), 500);
    channel.postMessage({ steer: to });
  });
}
/** What happens on Connect, in a sentence: "Two connect by themselves. Then two open in your browser, one at a time." */
function planOf(items: Item[]) {
  const auto = items.filter(item => !interactive(item)).length, browser = items.filter(interactive).length;
  return [
    auto ? `${count(auto)} connect${auto === 1 ? 's' : ''} by ${auto === 1 ? 'itself' : 'themselves'}.` : '',
    browser ? `${auto ? `Then ${count(browser).toLowerCase()}` : count(browser)} open${browser === 1 ? 's' : ''} in your browser${browser > 1 ? ', one at a time' : ''}.` : '',
  ].filter(Boolean).join(' ');
}

export function SetupScreen({ status, onDone, onAgents, onChanged, hostedOn, after }: Props) {
  const [cloud, setCloud] = useState<CloudAccountStatus | null>(null);
  const localRos = useLocalRosStatus();
  // Apps already connected by a sign-in (Notion, Linear) or with Google, so their rows say so.
  const [signIns, setSignIns] = useState<AppConnectionStatus[]>([]), [google, setGoogle] = useState<GoogleDriveStatus | null>(null);
  useEffect(() => {
    if (!status.apps.length) return;
    void api<{ apps: AppConnectionStatus[] }>('/api/apps').then(value => setSignIns(value.apps)).catch(() => undefined);
    if (status.apps.some(app => app.id === 'google-drive')) void api<GoogleDriveStatus>('/api/connections/google-drive').then(setGoogle).catch(() => undefined);
  }, [status.apps]);
  // Signed in before this screen (on the account step, or earlier): the row says as whom.
  useEffect(() => { if (status.cloud.signedIn) void api<CloudAccountStatus>('/api/cloud').then(setCloud).catch(() => undefined); }, [status.cloud.signedIn]);
  const localState = localRos?.supported ? localRos.state : undefined;
  const items = useMemo<Item[]>(() => {
    const found: Item[] = [];
    for (const agent of status.agents) {
      if (!agent.found) continue;
      const linked = Boolean(agent.link || agent.entry);
      found.push({ key: `agent:${agent.id}`, kind: 'agent', id: agent.id, label: agent.label, icon: <AgentIcon id={agent.id} size={16}/>, why: `${agentWhy[agent.id]}${agent.note ? ` ${agent.note}` : ''}`, how: agent.linkable ? 'auto' : 'terminal', on: !linked && agent.linkable, ...(linked ? { done: 'Linked' } : {}) });
    }
    if (status.cloud.available) found.push({ key: 'ros', kind: 'ros', id: 'ros', label: 'ROS, hosted by ros.ai', icon: <RosMark/>, why: status.cloud.signedIn ? `Signed in${cloud?.email ? ` as ${cloud.email}` : ''}. ROS appears as a model.` : 'Free while ros.ai is new. Sign in or create an account.', how: 'sign-in', on: !status.cloud.signedIn && (hostedOn ?? true), ...(status.cloud.signedIn ? { done: 'Signed in' } : {}) });
    // Not downloaded yet: a row to tick. Downloading or downloaded: its own row with the progress (LocalRosRow).
    if (localState === 'not-downloaded') found.push({ key: 'local', kind: 'local', id: 'local', label: `ROS on ${status.computer}`, icon: <RosMark/>, why: `About 3 GB, in the background. Free, and it works offline on ${status.computer}.`, how: 'auto', on: false });
    for (const model of status.models) {
      if (!model.running) continue;
      const n = model.models.length;
      found.push({ key: `model:${model.id}`, kind: 'model', id: model.id, label: model.label, icon: <BrandLogo id={model.id} size={16}/>, why: n ? `Running with ${n} model${n === 1 ? '' : 's'}. Use them in ROS, on ${status.computer}.` : 'Running, but without a downloaded model yet.', how: n ? 'auto' : 'plugins', on: !model.connectionId && n > 0, ...(model.connectionId ? { done: 'Connected' } : {}) });
    }
    for (const app of status.apps) {
      // GitHub and Zotero connect by themselves once what is on this computer is ready, and come ticked.
      const ready = localApps.has(app.id) && app.local === 'ready', how = ready ? 'auto' : appHow[app.id];
      if (!how) continue;
      const connected = app.connected || signIns.some(item => item.id === app.id && item.connected) || (app.id === 'google-drive' && Boolean(google?.connected));
      found.push({ key: `app:${app.id}`, kind: 'app', id: app.id, label: app.label, icon: hasBrandLogo(app.id) ? <BrandLogo id={app.id} size={16}/> : <AppWindow size={16} strokeWidth={1.75}/>,
        why: localApps.has(app.id) && !connected ? localWhy(app) : PLUGINS.find(plugin => plugin.id === app.id)?.summary ?? '', how, on: ready && !connected, ...(connected ? { done: 'Connected' } : {}) });
    }
    return found;
  }, [status, cloud, hostedOn, signIns, google, localState]);
  const [on, setOn] = useState<Record<string, boolean>>({});
  // The rows' ticks: the person's own where a row stays, the row's default where it is new.
  useEffect(() => { setOn(prev => Object.fromEntries(items.map(item => [item.key, prev[item.key] !== undefined && !item.done ? prev[item.key] : item.on]))); }, [items]);
  const tickable = (item: Item) => !item.done && item.how !== 'plugins';
  const picked = items.filter(item => tickable(item) && on[item.key]);
  const [menu, setMenu] = useState(false);
  const foot = useRef<HTMLElement>(null);
  const also = useMemo(() => [
    ...status.keys.map(key => `${/^[aeiou]/i.test(key.label) ? 'an' : 'a'} ${key.label} in your ${key.source === 'environment' ? 'environment' : 'saved keys'}`),
    ...status.models.filter(model => model.found && !model.running).map(model => `${model.label} (not running)`),
    ...status.apps.filter(app => !appHow[app.id]).map(app => `${app.label} (no plugin yet)`),
    ...(status.docker.found ? ['Docker'] : []),
  ], [status]);
  // A click anywhere else closes the Looked at menu.
  useEffect(() => {
    if (!menu) return;
    const away = (event: MouseEvent) => { if (!foot.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menu]);

  // Connecting: the rows ticked when Connect was pressed, where each stands, and the one waiting for the person.
  const [walk, setWalk] = useState<Item[] | null>(null), [steps, setSteps] = useState<Record<string, Step>>({}), [now, setNow] = useState<string | null>(null);
  const [walking, setWalking] = useState(false);
  const put = (itemKey: string, step: Step) => setSteps(prev => ({ ...prev, [itemKey]: step }));
  const shared = useRef<Window | null>(null), waiter = useRef<((step: Step) => void) | null>(null), alive = useRef(true);
  // Leaving the screen stops waiting. A sign-in still open in the browser finishes by itself; ros.ai saves it either way.
  useEffect(() => () => { alive.current = false; waiter.current?.({ state: 'skip', text: 'Skipped' }); }, []);
  const waiting = now && steps[now]?.state === 'wait' ? now : null;
  // The step waiting for the person comes into view in the list.
  useEffect(() => {
    if (!waiting) return;
    document.querySelector('.setup-row.here')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [waiting]);

  /** Shows a page in the sign-in window: straight there while the window shows ros.ai's own page, through that page when
   * the browser cut the window off from this one, or else in a new window, which the browser may block outside a click.
   * click: the person asked for it, so a new window opens at once. In the Mac app the system browser opens it. False
   * when it could not open. */
  const show = async (url: string, click = false) => {
    try {
      if (macApp()) { window.open(url, '_blank', 'noopener'); return true; }
      const to = new URL(url, location.href).href, popup = shared.current;
      if (popup && !popup.closed && ours(popup)) { popup.location.href = to; try { popup.focus(); } catch { /* the browser decides */ } return true; }
      // Steering helps only once the window was cut off; a window still on another site's page has none of ros.ai's.
      if (!click && (!popup || popup.closed) && await steer(to)) return true;
      shared.current = blankWindow('Opening…');
      if (!shared.current) return false;
      shared.current.location.href = to;
      return true;
    } catch { return false; }
  };
  /** Closes the sign-in window where ros.ai still may: straight away on ros.ai's own page, or through that page. On another
   * site's page (where a key was copied) it stays for the person to close. */
  const closeWindow = () => {
    const popup = shared.current;
    shared.current = null;
    if (macApp()) return;
    if (popup && !popup.closed && ours(popup)) popup.close(); else void steer('close');
  };
  /** Waits until the sign-in shows as done: the app's page says so over a BroadcastChannel, and ros.ai asks every two
   * seconds as well, which is how the Mac app hears it. Skip and leaving the screen end the wait too. */
  const signedIn = (item: Item) => new Promise<Step>(resolve => {
    let settled = false, sawWaiting = false, channel: BroadcastChannel | undefined;
    const finish = (step: Step) => { if (settled) return; settled = true; clearInterval(timer); clearTimeout(expire); channel?.close(); if (waiter.current === finish) waiter.current = null; resolve(step); };
    waiter.current = finish;
    const look = async () => {
      if (item.kind === 'ros') {
        const account = await api<CloudAccountStatus>('/api/cloud').catch(() => undefined);
        if (account?.state === 'signed-in') { setCloud(account); finish({ state: 'ok', text: 'Signed in', message: `${account.email ? `Signed in as ${account.email}. ` : ''}ROS now appears as a model.` }); }
        else if (account?.state === 'waiting') sawWaiting = true;
        else if (account && sawWaiting) finish({ state: 'fail', text: 'Couldn’t connect', message: account.error || 'The sign-in did not finish.' });
        return;
      }
      const apps = await api<{ apps: AppConnectionStatus[] }>('/api/apps').catch(() => undefined);
      if (apps?.apps.some(app => app.id === item.id && app.connected)) finish({ state: 'ok', text: 'Connected' });
    };
    if (item.kind === 'app') try {
      channel = new BroadcastChannel('ros-ai-plugins');
      channel.onmessage = event => { const data = event.data as { connected?: string; failed?: string; error?: string } | null; if (data?.connected === item.id) finish({ state: 'ok', text: 'Connected' }); else if (data?.failed === item.id) finish({ state: 'fail', text: 'Couldn’t connect', message: data.error || 'The sign-in failed.' }); };
    } catch { /* The asking below still hears it. */ }
    const timer = setInterval(() => void look(), 2000);
    const expire = setTimeout(() => finish({ state: 'fail', text: 'Not finished', message: 'The sign-in was not finished within 10 minutes. Connect it later from Plugins.' }), 10 * 60_000);
  });
  /** One sign-in: ros.ai asks the app for its sign-in page, shows it, and waits. */
  const signIn = async (item: Item): Promise<Step> => {
    put(item.key, { state: 'busy', text: 'Opening' });
    try {
      let url: string;
      if (item.kind === 'ros') url = macApp() ? (await post<CloudAccountStatus>('/api/cloud/sign-in')).verificationUrl ?? '' : '/api/cloud/start?keep=1';
      else {
        const started = await post<{ authorizationUrl?: string }>(`/api/apps/${item.id}/connect`, { window: true, keep: !macApp() });
        if (!started.authorizationUrl) return { state: 'ok', text: 'Connected' };
        url = started.authorizationUrl;
      }
      if (!url) throw new Error('ros.ai cloud sent no sign-in page. Try again from Agents.');
      const opened = await show(url);
      put(item.key, { state: 'wait', text: 'Waiting for you', url, blocked: !opened });
      return await signedIn(item);
    } catch (cause) { return { state: 'fail', text: 'Couldn’t connect', message: fail(cause) }; }
  };
  /** Everything that needs nothing from the person, at once: the agents' links and model servers in one request, the
   * ROS download, Figma's desktop app, and GitHub and Zotero through what is on this computer. */
  const automatic = async (chosen: Item[]) => {
    const agents = chosen.filter(item => item.kind === 'agent').map(item => item.id as AgentId), models = chosen.filter(item => item.kind === 'model').map(item => item.id as LocalModelId);
    const jobs: Promise<unknown>[] = [];
    if (agents.length || models.length) jobs.push(api<SetupLinkResponse>('/api/setup/links', { method: 'POST', body: JSON.stringify({ agents, models }), signal: AbortSignal.timeout(180_000) }).then(links => {
      for (const id of agents) {
        const result = links.agents.find(item => item.agent === id);
        put(`agent:${id}`, !result ? { state: 'fail', text: 'Couldn’t link', message: 'ros.ai gave no answer for this one. Try again from Agents.' } : result.ok ? { state: 'ok', text: 'Linked', message: result.message } : { state: 'fail', text: result.command ? 'Needs you' : 'Couldn’t link', message: result.message, ...(result.command ? { command: result.command } : {}) });
      }
      for (const id of models) {
        const result = links.models.find(item => item.id === id);
        put(`model:${id}`, result?.ok ? { state: 'ok', text: 'Connected', message: result.message } : { state: 'fail', text: 'Couldn’t connect', message: result?.message ?? 'ros.ai gave no answer for this one. Try again from Agents.' });
      }
    }, cause => { for (const itemKey of [...agents.map(id => `agent:${id}`), ...models.map(id => `model:${id}`)]) put(itemKey, { state: 'fail', text: 'Couldn’t connect', message: fail(cause) }); }));
    if (chosen.some(item => item.kind === 'local')) jobs.push(changeLocalRos('download').then(() => put('local', { state: 'ok', text: 'Downloading' }), cause => put('local', { state: 'fail', text: 'Couldn’t start', message: fail(cause) })));
    for (const item of chosen.filter(entry => entry.kind === 'app')) jobs.push(post(localApps.has(item.id as AppId) ? `/api/plugins/${item.id}/local` : `/api/apps/${item.id}/connect`, {}).then(() => put(item.key, { state: 'ok', text: 'Connected', ...(item.id === 'github' ? { message: 'Through the GitHub CLI’s sign-in.' } : item.id === 'zotero' ? { message: 'Through the Zotero app.' } : {}) }), cause => put(item.key, { state: 'fail', text: 'Couldn’t connect', message: fail(cause) })));
    await Promise.all(jobs);
  };
  const connect = async () => {
    if (!picked.length) { onDone(); return; }
    // Sign-ins, one after another: each ends on ros.ai's own page, from where the window moves on to the next.
    const chosen = picked, queue = chosen.filter(item => item.how === 'sign-in');
    // The window opens from this click, while the browser still allows it; each sign-in then opens in it in turn.
    if (queue.length && !macApp()) shared.current = blankWindow('Getting your first sign-in ready…');
    setWalk(chosen); setWalking(true); setMenu(false);
    setSteps(Object.fromEntries(chosen.map(item => [item.key, interactive(item) ? { state: 'next', text: 'Next' } : { state: 'busy', text: 'Connecting' }] as const)));
    void post('/api/setup/seen').catch(() => undefined);
    const background = automatic(chosen.filter(item => !interactive(item)));
    for (const item of queue) {
      if (!alive.current) return;
      setNow(item.key);
      put(item.key, await signIn(item));
    }
    if (!alive.current) return;
    setNow(null);
    closeWindow();
    await background;
    if (!alive.current) return;
    setWalking(false);
    await onChanged().catch(() => undefined);
  };
  /** Opens the step's page again, from a click: after the window was closed, or when the browser blocked it. */
  const again = async (itemKey: string) => {
    const url = steps[itemKey]?.url;
    if (!url) return;
    const blocked = !(await show(url, true));
    setSteps(prev => prev[itemKey] ? { ...prev, [itemKey]: { ...prev[itemKey], blocked } } : prev);
  };
  const skip = () => waiter.current?.({ state: 'skip', text: 'Skipped' });

  const live = localRos && localState && localState !== 'not-downloaded' ? <LocalRosRow status={localRos} computer={status.computer}/> : null;
  // Apps that connect only on their Plugins page: a line under them says where.
  const elsewhere = items.filter(item => item.kind === 'app' && item.how === 'plugins' && !item.done && !localApps.has(item.id as AppId)).map(item => item.label);
  const appsNote = elsewhere.length ? <p className="setup-apps-note">{elsewhere.length === 1 ? `${elsewhere[0]} connects in Plugins, with ${elsewhere[0] === 'Slack' ? 'a Slack' : 'a Google'} app of your own.` : `${list(elsewhere)} connect in Plugins, each with an app of your own.`}</p> : undefined;
  const frame = (lead: string, card: ReactNode) => <div className="setup-screen"><div className="setup-column">
    <span className="setup-ring"><RosMark/></span>
    <h1>Connect your tools</h1>
    <p className="setup-lead">{lead}</p>
    {card}
    {after}
  </div></div>;
  const groups = (rows: Item[], row: (item: Item) => ReactNode, local: ReactNode, note?: ReactNode) => {
    const group = (kinds: Item['kind'][], title: string, extra?: ReactNode) => {
      const shown = rows.filter(item => kinds.includes(item.kind));
      return shown.length || extra ? <><p className="setup-group">{title}</p>{shown.map(row)}{extra}</> : null;
    };
    return <>
      {group(['agent'], 'Your agents')}
      {group(['ros', 'local', 'model'], 'ROS', local)}
      {group(['app'], `Apps on ${status.computer}`, note)}
    </>;
  };

  if (walk) {
    const states = walk.map(item => steps[item.key]?.state), current = walk.find(item => item.key === now);
    const ok = states.filter(state => state === 'ok').length, skipped = states.filter(state => state === 'skip').length, failed = states.filter(state => state === 'fail').length;
    const settled = ok + skipped + failed;
    const name = current?.kind === 'ros' ? 'ros.ai' : current?.label;
    const lead = walking ? `${!current ? 'Connecting…' : steps[current.key]?.blocked ? `Open the ${name} sign-in to go on.` : `Sign in to ${name} in the window that opened.`} ${settled} of ${walk.length} done.`
      : [`${count(ok)} connected.`, skipped ? `${count(skipped)} skipped.` : '', failed ? `${count(failed)} ${failed === 1 ? 'needs' : 'need'} a step from you.` : '', localState === 'downloading' ? 'ROS keeps downloading in the background.' : ''].filter(Boolean).join(' ');
    const linkedAgent = walk.find(item => item.kind === 'agent' && steps[item.key]?.state === 'ok');
    const row = (item: Item) => {
      if (item.kind === 'local' && live) return <Fragment key={item.key}>{live}</Fragment>;
      const step = steps[item.key], here = item.key === now && step?.state === 'wait';
      return <div className={`setup-row static${here ? ' here' : ''}`} key={item.key}>
        <span className="setup-tile" aria-hidden="true">{item.icon}</span>
        <span className="setup-text">
          <span className="setup-name">{item.label}</span>
          {here ? <>
            <span className="setup-why">{step.blocked ? 'Your browser kept the sign-in window from opening.' : `${item.kind === 'ros' ? 'Sign in or create your account' : 'Allow access'} in the window that opened. ros.ai goes on by itself.`}</span>
            <span className="setup-step-actions"><button type="button" className={step.blocked ? 'primary small' : 'chip-button'} onClick={() => void again(item.key)}>{step.blocked ? `Open the ${item.kind === 'ros' ? 'ros.ai' : item.label} sign-in` : 'Open it again'}<ArrowUpRight size={11}/></button><button type="button" className="chip-button" onClick={skip}>Skip</button></span>
          </> : step?.message && <span className="setup-why">{step.message}</span>}
          {step?.command && <CommandBox command={step.command} label={item.label}/>}
        </span>
        <span className={`setup-state ${step?.state ?? ''}`}>{step?.state === 'busy' ? <LoaderCircle size={12} className="spin"/> : <i/>}{step?.text ?? ''}</span>
      </div>;
    };
    return frame(lead, <section className="setup-card" aria-label="Connecting your tools" aria-busy={walking}>
      <div className="setup-list">{groups(walk, row, walk.some(item => item.kind === 'local') ? null : live)}</div>
      <p className="setup-note">{linkedAgent ? <>{linkedAgent.label} is linked. In a new session, try: <span>“Open my ros.ai project and summarise the canvas.”</span></> : 'Every link above is one entry in that tool\'s settings. Undo any of them later from Agents.'}</p>
      <footer className="setup-foot">
        <RosMark working={walking}/>
        <span className="setup-sp"/>
        {!walking && failed > 0 && <button type="button" className="chip-button" onClick={onAgents}>Finish later in Agents</button>}
        <button type="button" className="primary setup-primary" onClick={onDone}>Start</button>
      </footer>
    </section>);
  }

  const row = (item: Item) => item.done || !tickable(item)
    ? <div className="setup-row static" key={item.key}>
      <span className="setup-tile" aria-hidden="true">{item.icon}</span>
      <span className="setup-text"><span className="setup-name">{item.label}</span>{item.why && <span className="setup-why">{item.why}</span>}</span>
      {item.done ? <span className="setup-state ok"><i/>{item.done}</span> : <span className="setup-how">{tags[item.how]}</span>}
    </div>
    : <button type="button" role="checkbox" aria-checked={Boolean(on[item.key])} className={`setup-row${on[item.key] ? ' on' : ''}`} key={item.key} onClick={() => setOn(prev => ({ ...prev, [item.key]: !prev[item.key] }))}>
      <span className="setup-tile" aria-hidden="true">{item.icon}</span>
      <span className="setup-text"><span className="setup-name">{item.label}</span><span className="setup-why">{item.why}</span></span>
      <span className="setup-how">{tags[item.how]}</span>
      <span className="setup-ck" aria-hidden="true">{on[item.key] && <Check size={12} strokeWidth={2.5}/>}</span>
    </button>;
  const places = status.lookedAt.length, plan = planOf(picked);
  return frame(`ros.ai looked at ${status.computer} and found these. Tick what to connect; nothing was sent anywhere.`, <section className="setup-card" aria-label="Connect your tools">
    <div className="setup-list">{groups(items, row, live, appsNote)}</div>
    {!items.length && !live && <p className="setup-note">No agents, model servers or apps yet. Everything here can be connected later from Agents and Plugins.</p>}
    {plan && <p className="setup-plan">{plan}</p>}
    <footer className="setup-foot" ref={foot}>
      <RosMark/>
      <span className="chip-slot">
        <button type="button" className="chip-button" aria-expanded={menu} aria-haspopup="dialog" onClick={() => setMenu(!menu)}><Search size={12}/>Looked at {places} place{places === 1 ? '' : 's'}<ChevronDown size={12}/></button>
        {menu && <div className="chip-menu setup-looked" role="dialog" aria-label="Where ros.ai looked">
          <p>Names and dates only, on {status.computer}. Nothing was sent anywhere.</p>
          <ul>{status.lookedAt.map(place => <li key={place}>{sentence(place)}</li>)}</ul>
          {also.length > 0 && <p>Also found: {list(also)}.</p>}
        </div>}
      </span>
      <span className="setup-sp"/>
      <button type="button" className="chip-button" onClick={onDone}>Not now</button>
      <button type="button" className="primary setup-primary" onClick={() => void connect()}>{picked.length ? `Connect ${picked.length}` : 'Start'}</button>
    </footer>
  </section>);
}
