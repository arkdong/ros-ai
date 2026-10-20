import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, Plug, SquareTerminal } from 'lucide-react';
import type { AgentId, AppId, LocalModelId, SetupLinkResponse, SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { AppConnectionStatus } from '../shared/plugins';
import { BrandLogo, hasBrandLogo, type BrandId } from './brand-logos';
import { RosMark } from './RosDock';
import { api, post } from './api';
import './setup.css';

/** First launch: what ros.ai found on this computer, as rows to connect in one go. Every link is one
 * entry in that tool's own settings; the person can undo each one from Agents. */

const brands: Partial<Record<AgentId, BrandId>> = { 'claude-code': 'claude', codex: 'codex' };
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
};
/** Apps with their own hosted connection: the sign-in happens at the app, in the browser, and the key stays here. */
const appWhy: Partial<Record<AppId, string>> = {
  notion: 'Ros and your agents can search and read your Notion pages. You approve at Notion; ros.ai keeps the key on this computer.',
};
const appIcon = (id: AppId) => hasBrandLogo(id) ? <BrandLogo id={id} size={20}/> : <Plug size={20} strokeWidth={1.75}/>;
const signalLabel: Record<string, string> = { app: 'Installed', running: 'Running', 'synced folder': 'Synced folder', 'signed in on the command line': 'Signed in on the command line' };
const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const words = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const count = (n: number) => words[n] ?? String(n);

/** A command or settings entry to paste, with a copy button. */
export function CommandBox({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const copy = async () => { try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copying was blocked. Select the command and copy it yourself.'); } };
  return <>
    <div className="setup-command"><code>{command}</code><button type="button" className="icon-button" aria-label={`Copy the ${label} command`} title="Copy" onClick={() => void copy()}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </>;
}

type Choice = { key: string; kind: 'agent' | 'model' | 'ros' | 'app'; id: string; label: string; icon: ReactNode; why: string; signal: string; on: boolean; done?: string };
type Outcome = { state: 'ok' | 'wait' | 'fail' | 'busy'; text: string; message?: string; command?: string; url?: string };
type Props = { status: SetupStatus; onDone: () => void; onAgents: () => void; onApps: () => void; onChanged: () => Promise<unknown> };

export function SetupScreen({ status, onDone, onAgents, onApps, onChanged }: Props) {
  const choices = useMemo<Choice[]>(() => {
    const items: Choice[] = [];
    for (const agent of status.agents) {
      if (!agent.found) continue;
      const linked = Boolean(agent.link || agent.entry), facts = ['Found', ...agent.signals.filter(signal => signal === 'signed in' || signal === 'used recently')];
      items.push({ key: `agent:${agent.id}`, kind: 'agent', id: agent.id, label: agent.label, icon: <AgentIcon id={agent.id}/>, why: `${agentWhy[agent.id]}${agent.note ? ` ${agent.note}` : ''}`,
        signal: linked ? 'Already linked' : agent.linkable ? facts.join(' · ') : 'Found · needs a line in your terminal', on: !linked && agent.linkable, ...(linked ? { done: 'Already linked' } : {}) });
    }
    if (status.cloud.available) items.push({ key: 'ros', kind: 'ros', id: 'ros', label: 'Ros, hosted by ros.ai', icon: <RosMark/>, why: 'Free while ros.ai is new. One sign-in in your browser.', signal: status.cloud.signedIn ? 'Signed in' : 'Recommended', on: !status.cloud.signedIn, ...(status.cloud.signedIn ? { done: 'Signed in' } : {}) });
    for (const model of status.models) {
      if (!model.running) continue;
      const n = model.models.length, done = model.connectionId ? 'Already connected' : n ? undefined : 'No models yet';
      items.push({ key: `model:${model.id}`, kind: 'model', id: model.id, label: model.label, icon: <BrandLogo id={model.id} size={20}/>, why: n ? `Running with ${n} model${n === 1 ? '' : 's'}. Use them in Ros, on ${status.computer}.` : 'Running, but without a downloaded model yet.', signal: done ?? 'Running', on: !done, ...(done ? { done } : {}) });
    }
    for (const app of status.apps) {
      if (!app.connectable) continue;
      const facts = [...app.signals.map(signal => signalLabel[signal] ?? signal), ...(app.usedBy.length ? [`Used by ${list(app.usedBy)}`] : [])], done = app.connected ? `Connected${app.account ? ` as ${app.account}` : ''}` : undefined;
      items.push({ key: `app:${app.id}`, kind: 'app', id: app.id, label: app.label, icon: appIcon(app.id), why: appWhy[app.id] ?? `Lets Ros and your agents use ${app.label} through its own connection. You approve at ${app.label}.`, signal: done ?? (facts.join(' · ') || 'Found'), on: !app.connected, ...(done ? { done } : {}) });
    }
    return items;
  }, [status]);
  const [on, setOn] = useState<Record<string, boolean>>({});
  useEffect(() => { setOn(Object.fromEntries(choices.map(choice => [choice.key, choice.on]))); }, [choices]);
  const [phase, setPhase] = useState<'choose' | 'connecting'>('choose');
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);
  const [cloud, setCloud] = useState<CloudAccountStatus | null>(null);
  const selected = choices.filter(choice => on[choice.key]);
  const also = useMemo(() => [
    ...status.keys.map(key => `${/^[aeiou]/i.test(key.label) ? 'an' : 'a'} ${key.label} in your ${key.source === 'environment' ? 'environment' : 'saved keys'}`),
    ...status.apps.filter(app => !app.connectable).map(app => app.label),
    ...status.models.filter(model => model.found && !model.running).map(model => `${model.label} (not running)`),
    ...(status.docker.found ? ['Docker'] : []),
  ], [status]);

  // While the browser approval is open, check every few seconds; the local server does the polling.
  const waiting = cloud?.state === 'waiting', changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => { const next = await api<CloudAccountStatus>('/api/cloud').catch(() => undefined); if (next && next.state !== 'waiting') { setCloud(next); await changed.current(); } }, 3000);
    return () => clearInterval(timer);
  }, [waiting]);
  // An app sign-in runs in its own tab; here the screen asks every few seconds whether the app has answered.
  const waitingApps = selected.filter(choice => choice.kind === 'app' && outcomes[choice.key]?.state === 'wait').map(choice => choice.id).join(',');
  useEffect(() => {
    if (!waitingApps) return;
    const ids = waitingApps.split(',');
    const timer = setInterval(async () => {
      const result = await api<{ apps: AppConnectionStatus[] }>('/api/apps').catch(() => undefined);
      const done = result?.apps.filter(app => ids.includes(app.id) && app.connected) ?? [];
      if (!done.length) return;
      setOutcomes(prev => ({ ...prev, ...Object.fromEntries(done.map(app => [`app:${app.id}`, { state: 'ok', text: 'Connected', message: `Signed in${app.account ? ` as ${app.account}` : ''}. Agents use ${app.name}’s own tools and ask you before changing anything there.` } satisfies Outcome])) }));
      await changed.current();
    }, 3000);
    return () => clearInterval(timer);
  }, [waitingApps]);

  const connect = async () => {
    if (!selected.length) { onDone(); return; }
    setBusy(true); setPhase('connecting');
    setOutcomes(Object.fromEntries(selected.map(choice => [choice.key, { state: 'busy', text: 'Connecting' } as Outcome])));
    void post('/api/setup/seen').catch(() => undefined);
    const agents = selected.filter(choice => choice.kind === 'agent').map(choice => choice.id as AgentId), models = selected.filter(choice => choice.kind === 'model').map(choice => choice.id as LocalModelId), ros = selected.some(choice => choice.kind === 'ros'), apps = selected.filter(choice => choice.kind === 'app').map(choice => choice.id as AppId);
    const starting = Promise.all(apps.map(id => post<{ authorizationUrl?: string; connected?: boolean; app?: AppConnectionStatus }>(`/api/apps/${id}/connect`, { popup: true }).then(value => ({ id, value }), (cause: unknown) => ({ id, error: fail(cause) }))));
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
    // The browser allows one new tab per click: the first app sign-in opens itself unless Ros already did, the rest wait for their link.
    let opened = Boolean(signIn && 'value' in signIn && signIn.value.verificationUrl);
    for (const start of await starting) {
      const key = `app:${start.id}`;
      if ('error' in start) { next[key] = { state: 'fail', text: 'Couldn\'t connect', message: start.error }; continue; }
      if (start.value.connected || !start.value.authorizationUrl) { next[key] = { state: 'ok', text: 'Connected', message: `Signed in${start.value.app?.account ? ` as ${start.value.app.account}` : ''}.` }; continue; }
      next[key] = { state: 'wait', text: 'Waiting for you', url: start.value.authorizationUrl };
      if (!opened) { window.open(start.value.authorizationUrl, '_blank', 'noopener'); opened = true; }
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
  const fineprint = <p className="setup-fineprint">Looked at {list(status.lookedAt)} on {status.computer}. Nothing was sent anywhere.</p>;

  if (phase === 'connecting') {
    const states = selected.map(choice => outcome(choice)?.state);
    const ok = states.filter(state => state === 'ok').length, wait = states.filter(state => state === 'wait').length, failed = states.filter(state => state === 'fail').length;
    const summary = busy || states.includes('busy') ? 'Connecting…' : [`${count(ok)} connected.`, wait ? `${count(wait)} ${wait === 1 ? 'is' : 'are'} waiting for you.` : '', failed ? `${count(failed)} ${failed === 1 ? 'needs' : 'need'} a step from you.` : ''].filter(Boolean).join(' ');
    const linkedAgent = selected.find(choice => choice.kind === 'agent' && outcomes[choice.key]?.state === 'ok');
    const pendingKinds = selected.filter(choice => ['wait', 'fail'].includes(outcome(choice)?.state ?? '')).map(choice => choice.kind), laterInApps = pendingKinds.length > 0 && pendingKinds.every(kind => kind === 'app');
    const section = (kind: Choice['kind'][], title: string) => {
      const rows = selected.filter(choice => kind.includes(choice.kind));
      return rows.length ? <><h3 className="setup-section">{title}</h3>{rows.map(choice => {
        const result = outcome(choice);
        return <div className="setup-row static" key={choice.key}>
          <span className="setup-tile" aria-hidden="true">{choice.icon}</span>
          <div className="setup-body">
            <div className="setup-name">{choice.label}</div>
            {choice.kind === 'ros' && waiting && cloud ? <>
              <div className="setup-why">Approve {status.computer} in your browser. The page shows this code: <strong>{cloud.userCode}</strong></div>
              <div className="setup-actions"><a className="secondary small" href={cloud.verificationUrl} target="_blank" rel="noreferrer">Open the sign-in page <ExternalLink size={11}/></a></div>
            </> : choice.kind === 'app' && result?.state === 'wait' && result.url ? <>
              <div className="setup-why">Approve ros.ai at {choice.label} in the tab that opened, then come back here. Nothing is copied from your account.</div>
              <div className="setup-actions"><a className="secondary small" href={result.url} target="_blank" rel="noreferrer">Open the {choice.label} sign-in <ExternalLink size={11}/></a></div>
            </> : result?.message && <div className="setup-why">{result.message}</div>}
            {result?.command && <CommandBox command={result.command} label={choice.label}/>}
          </div>
          <span className={`setup-state ${result?.state ?? ''}`}>{result?.state === 'busy' ? <LoaderCircle size={12} className="spin"/> : <i/>}{result?.text ?? ''}</span>
        </div>;
      })}</> : null;
    };
    return <div className="setup-screen"><div className="setup-column">
      <section className="setup-card" aria-label="Connecting your tools">
        <h2>Connecting your tools</h2>
        <p className="setup-lead">{summary}</p>
        {section(['agent'], 'Agents')}
        {section(['ros', 'model'], 'Ros')}
        {section(['app'], 'Apps')}
        <footer className="setup-footer">
          <p>{linkedAgent ? <>{linkedAgent.label} is linked. In a new session, try: <span>“Open my ros.ai project and summarise the canvas.”</span></> : 'Every link above is one entry in that tool\'s settings. Undo any of them later from Agents.'}</p>
          {(wait || failed) > 0 && <button type="button" className="text-button" onClick={laterInApps ? onApps : onAgents}>Finish later in {laterInApps ? 'Plugins' : 'Agents'}</button>}
          <button type="button" className="primary" disabled={busy} onClick={onDone}>Start</button>
        </footer>
      </section>
      {fineprint}
    </div></div>;
  }

  const section = (kind: Choice['kind'][], title: string) => {
    const rows = choices.filter(choice => kind.includes(choice.kind));
    return rows.length ? <><h3 className="setup-section">{title}</h3>{rows.map(choice => <label className="setup-row" key={choice.key}>
      <input className="setup-check" type="checkbox" checked={Boolean(on[choice.key])} disabled={Boolean(choice.done)} aria-label={`Connect ${choice.label}`} onChange={event => setOn(prev => ({ ...prev, [choice.key]: event.target.checked }))}/>
      <span className="setup-tile" aria-hidden="true">{choice.icon}</span>
      <span className="setup-body"><span className="setup-name">{choice.label}</span><span className="setup-why" style={{ display: 'block' }}>{choice.why}</span></span>
      <span className="setup-signal">{choice.signal}</span>
    </label>)}</> : null;
  };
  return <div className="setup-screen"><div className="setup-column">
    <section className="setup-card" aria-label="Connect your tools">
      <h2>Connect your tools</h2>
      <p className="setup-lead">ros.ai looked at {status.computer} and found these. Connect them in one go, or choose one by one.</p>
      {section(['agent'], 'Agents')}
      {section(['ros', 'model'], 'Ros')}
      {section(['app'], 'Apps')}
      {also.length > 0 && <p className="setup-also">Also found: {list(also)}.{status.apps.some(app => !app.connectable) ? ' Those apps connect later, in Plugins.' : ''}</p>}
      <footer className="setup-footer">
        <button type="button" className="text-button" onClick={onAgents}>Choose one by one</button>
        <span className="setup-space"/>
        <button type="button" className="secondary" onClick={onDone}>Not now</button>
        <button type="button" className="primary" onClick={() => void connect()}>{selected.length ? `Connect ${selected.length}` : 'Start'}</button>
      </footer>
    </section>
    {fineprint}
  </div></div>;
}
