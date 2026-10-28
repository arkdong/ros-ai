import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppWindow, Check, ChevronDown, Copy, ExternalLink, LoaderCircle, Search, SquareTerminal } from 'lucide-react';
import type { AgentId, LocalModelId, SetupLinkResponse, SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import type { GoogleDriveStatus } from '../shared/google-drive';
import { PLUGINS, type AppConnectionStatus } from '../shared/plugins';
import { BrandLogo, hasBrandLogo, type BrandId } from './brand-logos';
import { RosMark } from './RosDock';
import { api, post } from './api';
import './chip-menu.css';
import './setup.css';

/** Connect your tools: what ros.ai found on this computer, as rows with a check circle, in one card in the bar's shape.
 * It is the last step of the first run (FirstRun.tsx) and comes back from Agents › Show the setup screen again. Every
 * link is one entry in that tool's own settings; the person can undo each one from Agents. */

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
const words = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const count = (n: number) => words[n] ?? String(n);
const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
/** A download size the way the Ros page says it: "1.2 GB". */
export const gb = (bytes = 0) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Ros on this computer: its state, read again every two seconds while it downloads or starts. */
export function useLocalRos(on = true) {
  const [status, setStatus] = useState<LocalRosStatus>();
  const busy = status?.state === 'downloading' || status?.state === 'starting';
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    const look = () => api<LocalRosStatus>('/api/local-ros').then(next => { if (!stopped) setStatus(next); }).catch(() => undefined);
    void look();
    const timer = busy ? setInterval(look, 2000) : undefined;
    return () => { stopped = true; if (timer) clearInterval(timer); };
  }, [on, busy]);
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

/** The Ros-on-this-computer row of the first run: the download's progress, then Ready. Nothing to choose here. */
export function LocalRosRow({ status, computer }: { status: LocalRosStatus; computer: string }) {
  const percent = status.totalBytes ? Math.min(100, Math.round(((status.doneBytes ?? 0) / status.totalBytes) * 100)) : 0;
  const why = status.state === 'downloading' ? 'Downloading in the background' : status.state === 'starting' ? 'Downloaded · getting Ros ready' : status.state === 'ready' ? `Works offline. Nothing leaves ${computer}.` : status.error || 'The download stopped';
  return <div className="setup-row static">
    <span className="setup-tile" aria-hidden="true"><RosMark/></span>
    <span className="setup-text"><span className="setup-name">Ros on {computer}</span><span className="setup-why">{why}</span></span>
    {status.state === 'downloading' ? <span className="setup-cap">{status.totalBytes ? `${gb(status.doneBytes)} of ${gb(status.totalBytes)}` : 'Finding the files'}<span className="setup-bar" role="progressbar" aria-label="Ros download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></span></span>
      : status.state === 'starting' ? <span className="setup-state"><LoaderCircle size={12} className="spin"/>Starting</span>
      : status.state === 'ready' ? <span className="setup-state ok"><i/>Ready</span>
      : <span className="setup-state fail"><i/>Stopped</span>}
  </div>;
}

/** done: already linked or connected, shown as a row with a green dot. fixed: nothing to do here (an app, which
 * connects on the Plugins page), shown as a plain row. */
type Choice = { key: string; kind: 'agent' | 'model' | 'ros' | 'app'; id: string; label: string; icon: ReactNode; why: string; state: string; on: boolean; done?: boolean; fixed?: boolean };
type Outcome = { state: 'ok' | 'wait' | 'fail' | 'busy'; text: string; message?: string; command?: string };
type Props = {
  status: SetupStatus; onDone: () => void; onAgents: () => void; onChanged: () => Promise<unknown>;
  /** From the first run: the hosted Ros row starts off when the person chose to go without an account. */
  hostedOn?: boolean;
  /** Ros on this computer while the first run downloads it, as a row of its own. */
  localRos?: LocalRosStatus;
  /** Under the card: the first run's step caption. */
  after?: ReactNode;
};

export function SetupScreen({ status, onDone, onAgents, onChanged, hostedOn, localRos, after }: Props) {
  const [cloud, setCloud] = useState<CloudAccountStatus | null>(null);
  // Apps already connected by a sign-in (Notion, Linear) or with Google, so their rows say so.
  const [signIns, setSignIns] = useState<AppConnectionStatus[]>([]), [google, setGoogle] = useState<GoogleDriveStatus | null>(null);
  useEffect(() => {
    if (!status.apps.length) return;
    void api<{ apps: AppConnectionStatus[] }>('/api/apps').then(value => setSignIns(value.apps)).catch(() => undefined);
    if (status.apps.some(app => app.id === 'google-drive')) void api<GoogleDriveStatus>('/api/connections/google-drive').then(setGoogle).catch(() => undefined);
  }, [status.apps]);
  // Signed in before this screen (on the account step, or earlier): the row says as whom.
  useEffect(() => { if (status.cloud.signedIn) void api<CloudAccountStatus>('/api/cloud').then(setCloud).catch(() => undefined); }, [status.cloud.signedIn]);
  const choices = useMemo<Choice[]>(() => {
    const items: Choice[] = [];
    for (const agent of status.agents) {
      if (!agent.found) continue;
      const linked = Boolean(agent.link || agent.entry);
      const state = linked ? 'Linked' : agent.signals.includes('signed in') ? 'Signed in' : agent.signals.includes('used recently') ? 'Used recently' : agent.linkable ? 'Found' : 'Needs a line in your terminal';
      items.push({ key: `agent:${agent.id}`, kind: 'agent', id: agent.id, label: agent.label, icon: <AgentIcon id={agent.id} size={16}/>, why: `${agentWhy[agent.id]}${agent.note ? ` ${agent.note}` : ''}`, state, on: !linked && agent.linkable, done: linked });
    }
    if (status.cloud.available) items.push({ key: 'ros', kind: 'ros', id: 'ros', label: 'Ros, hosted by ros.ai', icon: <RosMark/>, why: status.cloud.signedIn ? `Signed in${cloud?.email ? ` as ${cloud.email}` : ''}. Ros appears as a model.` : 'Free while ros.ai is new. One sign-in in your browser.', state: status.cloud.signedIn ? 'Signed in' : 'Recommended', on: !status.cloud.signedIn && (hostedOn ?? true), done: status.cloud.signedIn });
    for (const model of status.models) {
      if (!model.running) continue;
      const n = model.models.length, done = model.connectionId ? 'Connected' : n ? undefined : 'No models yet';
      items.push({ key: `model:${model.id}`, kind: 'model', id: model.id, label: model.label, icon: <BrandLogo id={model.id} size={16}/>, why: n ? `Running with ${n} model${n === 1 ? '' : 's'}. Use them in Ros, on ${status.computer}.` : 'Running, but without a downloaded model yet.', state: done ?? 'Running', on: !done, done: Boolean(done) });
    }
    // Apps found here, as a plain list in two columns: the name, and how it was found or that it is connected. Their
    // plugins install on the Plugins page, which the caption under the list says.
    for (const app of status.apps) {
      const connected = app.connected || signIns.some(item => item.id === app.id && item.connected) || (app.id === 'google-drive' && Boolean(google?.connected));
      const how = app.signals.includes('running') ? 'Running' : app.signals.includes('synced folder') ? 'Synced' : app.signals.includes('signed in on the command line') ? 'Signed in' : app.signals.includes('app') ? 'Installed' : `Used by ${app.usedBy[0]}`;
      items.push({ key: `app:${app.id}`, kind: 'app', id: app.id, label: app.label, icon: hasBrandLogo(app.id) ? <BrandLogo id={app.id} size={16}/> : <AppWindow size={16} strokeWidth={1.75}/>,
        why: '', state: connected ? 'Connected' : how, on: false, done: connected, fixed: true });
    }
    return items;
  }, [status, cloud, hostedOn, signIns, google]);
  const [on, setOn] = useState<Record<string, boolean>>({});
  // The rows' ticks: the person's own where a row stays, the row's default where it is new, done or fixed.
  useEffect(() => { setOn(prev => Object.fromEntries(choices.map(choice => [choice.key, prev[choice.key] !== undefined && !choice.done && !choice.fixed ? prev[choice.key] : choice.on]))); }, [choices]);
  const [phase, setPhase] = useState<'choose' | 'connecting'>('choose');
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false), [menu, setMenu] = useState(false);
  const foot = useRef<HTMLElement>(null);
  const selected = choices.filter(choice => on[choice.key]);
  const also = useMemo(() => [
    ...status.keys.map(key => `${/^[aeiou]/i.test(key.label) ? 'an' : 'a'} ${key.label} in your ${key.source === 'environment' ? 'environment' : 'saved keys'}`),
    ...status.models.filter(model => model.found && !model.running).map(model => `${model.label} (not running)`),
    ...(status.docker.found ? ['Docker'] : []),
  ], [status]);
  // A click anywhere else closes the Looked at menu.
  useEffect(() => {
    if (!menu) return;
    const away = (event: MouseEvent) => { if (!foot.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menu]);

  // While the browser approval is open, check every few seconds; the local server does the polling.
  const waiting = cloud?.state === 'waiting', changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => { const next = await api<CloudAccountStatus>('/api/cloud').catch(() => undefined); if (next && next.state !== 'waiting') { setCloud(next); await changed.current(); } }, 3000);
    return () => clearInterval(timer);
  }, [waiting]);

  const connect = async () => {
    if (!selected.length) { onDone(); return; }
    setBusy(true); setPhase('connecting'); setMenu(false);
    setOutcomes(Object.fromEntries(selected.map(choice => [choice.key, { state: 'busy', text: 'Connecting' } as Outcome])));
    void post('/api/setup/seen').catch(() => undefined);
    const agents = selected.filter(choice => choice.kind === 'agent').map(choice => choice.id as AgentId), models = selected.filter(choice => choice.kind === 'model').map(choice => choice.id as LocalModelId), ros = selected.some(choice => choice.kind === 'ros');
    const [links, signIn] = await Promise.all([
      agents.length || models.length ? post<SetupLinkResponse>('/api/setup/links', { agents, models }).then(value => ({ value }), (cause: unknown) => ({ error: fail(cause) })) : Promise.resolve(null),
      ros ? post<CloudAccountStatus>('/api/cloud/sign-in').then(value => ({ value }), (cause: unknown) => ({ error: fail(cause) })) : Promise.resolve(null),
    ]);
    const next: Record<string, Outcome> = {};
    if (links) for (const key of [...agents.map(id => `agent:${id}`), ...models.map(id => `model:${id}`)]) {
      if ('error' in links) { next[key] = { state: 'fail', text: 'Couldn\'t connect', message: links.error }; continue; }
      const [kind, id] = key.split(':');
      const result = kind === 'agent' ? links.value.agents.find(item => item.agent === id) : links.value.models.find(item => item.id === id);
      next[key] = result ? { state: result.ok ? 'ok' : 'fail', text: result.ok ? 'Connected' : 'Couldn\'t connect', message: result.message, ...('command' in result && result.command ? { command: result.command } : {}) } : { state: 'fail', text: 'Couldn\'t connect', message: 'ros.ai gave no answer for this one. Try again from Agents.' };
    }
    if (signIn) {
      if ('error' in signIn) next.ros = { state: 'fail', text: 'Couldn\'t connect', message: signIn.error };
      else { setCloud(signIn.value); if (signIn.value.verificationUrl) window.open(signIn.value.verificationUrl, '_blank', 'noopener'); }
    }
    setOutcomes(next); setBusy(false);
    await onChanged();
  };
  const rosOutcome = (): Outcome | undefined => {
    if (outcomes.ros) return outcomes.ros;
    if (!cloud) return { state: 'busy', text: 'Connecting' };
    if (cloud.state === 'waiting') return { state: 'wait', text: 'Waiting for you' };
    if (cloud.state === 'signed-in') return { state: 'ok', text: 'Connected', message: `Signed in${cloud.email ? ` as ${cloud.email}` : ''}. Ros now appears as a model.` };
    return { state: 'fail', text: 'Couldn\'t connect', message: cloud.error || 'The sign-in did not complete. Try again from Agents.' };
  };
  const outcome = (choice: Choice) => choice.kind === 'ros' ? rosOutcome() : outcomes[choice.key];
  const local = localRos && localRos.state !== 'not-downloaded' ? <LocalRosRow status={localRos} computer={status.computer}/> : null;
  // Under the apps: where they connect. Nothing on this screen asks for them.
  const appsNote = choices.some(choice => choice.kind === 'app' && !choice.done) ? <p className="setup-note">Their plugins install on the Plugins page; nothing to do for them here.</p> : undefined;
  const frame = (lead: string, card: ReactNode) => <div className="setup-screen"><div className="setup-column">
    <span className="setup-ring"><RosMark/></span>
    <h1>Connect your tools</h1>
    <p className="setup-lead">{lead}</p>
    {card}
    {after}
  </div></div>;

  if (phase === 'connecting') {
    const states = selected.map(choice => outcome(choice)?.state);
    const ok = states.filter(state => state === 'ok').length, wait = states.filter(state => state === 'wait').length, failed = states.filter(state => state === 'fail').length;
    const working = busy || states.includes('busy');
    const summary = working ? 'Connecting…' : [`${count(ok)} connected.`, wait ? `${count(wait)} ${wait === 1 ? 'is' : 'are'} waiting for you.` : '', failed ? `${count(failed)} ${failed === 1 ? 'needs' : 'need'} a step from you.` : ''].filter(Boolean).join(' ');
    const linkedAgent = selected.find(choice => choice.kind === 'agent' && outcomes[choice.key]?.state === 'ok');
    const group = (kind: Choice['kind'][], title: string, extra?: ReactNode) => {
      const rows = selected.filter(choice => kind.includes(choice.kind));
      return rows.length || extra ? <><p className="setup-group">{title}</p>{rows.map(choice => {
        const result = outcome(choice);
        return <div className="setup-row static" key={choice.key}>
          <span className="setup-tile" aria-hidden="true">{choice.icon}</span>
          <span className="setup-text">
            <span className="setup-name">{choice.label}</span>
            {choice.kind === 'ros' && waiting && cloud ? <>
              <span className="setup-why">Finish signing in in your browser; ros.ai picks it up by itself.</span>
              <a className="chip-button setup-open" href={cloud.verificationUrl} target="_blank" rel="noreferrer">Open the sign-in page <ExternalLink size={11}/></a>
            </> : result?.message && <span className="setup-why">{result.message}</span>}
            {result?.command && <CommandBox command={result.command} label={choice.label}/>}
          </span>
          <span className={`setup-state ${result?.state ?? ''}`}>{result?.state === 'busy' ? <LoaderCircle size={12} className="spin"/> : <i/>}{result?.text ?? ''}</span>
        </div>;
      })}{extra}</> : null;
    };
    return frame(summary, <section className="setup-card" aria-label="Connecting your tools">
      {group(['agent'], 'Your agents')}
      {group(['ros', 'model'], 'Ros', local)}
      {group(['app'], `Apps on ${status.computer}`, appsNote)}
      <p className="setup-note">{linkedAgent ? <>{linkedAgent.label} is linked. In a new session, try: <span>“Open my ros.ai project and summarise the canvas.”</span></> : 'Every link above is one entry in that tool\'s settings. Undo any of them later from Agents.'}</p>
      <footer className="setup-foot">
        <RosMark working={working}/>
        <span className="setup-sp"/>
        {selected.some(choice => choice.kind !== 'app' && ['wait', 'fail'].includes(outcome(choice)?.state ?? '')) && <button type="button" className="chip-button" onClick={onAgents}>Finish later in Agents</button>}
        <button type="button" className="primary setup-primary" disabled={busy} onClick={onDone}>Start</button>
      </footer>
    </section>);
  }

  const group = (kind: Choice['kind'][], title: string, extra?: ReactNode) => {
    const rows = choices.filter(choice => kind.includes(choice.kind));
    // Rows with nothing to tick and nothing to explain (the apps) sit two to a line.
    const plain = rows.length > 1 && rows.every(choice => choice.fixed && !choice.why);
    const row = (choice: Choice) => choice.done || choice.fixed
      ? <div className={`setup-row static${choice.why ? '' : ' plain'}`} key={choice.key}>
        <span className="setup-tile" aria-hidden="true">{choice.icon}</span>
        <span className="setup-text"><span className="setup-name">{choice.label}</span>{choice.why && <span className="setup-why">{choice.why}</span>}</span>
        <span className={`setup-state ${choice.done && choice.state !== 'No models yet' ? 'ok' : ''}`}><i/>{choice.state}</span>
      </div>
      : <button type="button" role="checkbox" aria-checked={Boolean(on[choice.key])} className={`setup-row${on[choice.key] ? ' on' : ''}`} key={choice.key} onClick={() => setOn(prev => ({ ...prev, [choice.key]: !prev[choice.key] }))}>
        <span className="setup-tile" aria-hidden="true">{choice.icon}</span>
        <span className="setup-text"><span className="setup-name">{choice.label}</span><span className="setup-why">{choice.why}</span></span>
        <span className="setup-cap">{choice.state}</span>
        <span className="setup-ck" aria-hidden="true">{on[choice.key] && <Check size={12} strokeWidth={2.5}/>}</span>
      </button>;
    return rows.length || extra ? <><p className="setup-group">{title}</p>{plain ? <div className="setup-apps">{rows.map(row)}</div> : rows.map(row)}{extra}</> : null;
  };
  const places = status.lookedAt.length;
  return frame(`ros.ai looked at ${status.computer} and found these. Nothing was sent anywhere.`, <section className="setup-card" aria-label="Connect your tools">
    {group(['agent'], 'Your agents')}
    {group(['ros', 'model'], 'Ros', local)}
    {group(['app'], `Apps on ${status.computer}`, appsNote)}
    {!choices.length && !local && <p className="setup-note">No agents, model servers or apps yet. Everything here can be connected later from Agents and Plugins.</p>}
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
      <button type="button" className="primary setup-primary" onClick={() => void connect()}>{selected.length ? `Connect ${selected.length}` : 'Start'}</button>
    </footer>
  </section>);
}
