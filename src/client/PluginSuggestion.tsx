import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ExternalLink, LoaderCircle, MoreHorizontal, Plug, ShieldCheck, X } from 'lucide-react';
import { PLUGINS, type PluginDefinition, type PluginId, type PluginStatus } from '../shared/plugins';
import { pluginMatches, pluginReach, suggestionConnect, suggestionReason, type PluginMatch, type PluginReadiness, type SuggestionConnect, type SuggestionStatus } from '../shared/plugin-hints';
import type { AssistantBackend, AssistantTurn } from '../shared/assistant';
import { isSearchProvider } from '../shared/search';
import { api, post } from './api';
import { ResearchRing } from './Brand';
import { PluginMark, searchKeys } from './PluginsPage';
import { decideSuggestion, openSignIn, pluginName, reloadSuggestions, silenced, useSuggestions } from './plugin-suggestions';
import './plugin-suggestion.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const SIGN_IN_WAIT = 10 * 60_000;
/** Sheets and Docs ride on the Google Drive sign-in, so their setup is Google Drive's. */
const setupPage = (id: PluginId): PluginId => id === 'google-sheets' || id === 'google-docs' ? 'google-drive' : id;
const definition = (id: PluginId) => PLUGINS.find(plugin => plugin.id === id)!;

/** The word on the button for each way of connecting. */
function actionLabel(kind: SuggestionConnect, state: PluginReadiness | undefined) {
  if (kind === 'setup') return 'Set up';
  if (kind === 'switch') return 'Turn on';
  if (kind === 'sign-in') return state === 'failed' ? 'Sign in again' : 'Connect';
  return state === 'failed' ? kind === 'key' ? 'Replace key' : 'Replace token' : kind === 'key' ? 'Add key' : 'Add token';
}
const stateText = (name: string, state: PluginReadiness | undefined) => state === 'off' ? `${name} is off for agents` : state === 'failed' ? `${name} needs reconnecting` : `${name} isn’t connected`;
const stepsNote = (names: string) => `This also turns on “Use ros.ai’s tools step by step” for this project, so Ros can use ${names}.`;

/** Resolves once the plugin is connected. The sign-in page says so over a BroadcastChannel; while that cannot reach this
 * window (the Mac app signs in in the system browser), ros.ai asks every two seconds, for as long as a sign-in stays valid. */
function waitForSignIn(id: PluginId, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let channel: BroadcastChannel | undefined;
    const stop = () => { channel?.close(); clearInterval(timer); clearTimeout(expire); signal.removeEventListener('abort', cancelled); };
    const connected = () => { stop(); resolve(); };
    const fail = (error: Error) => { stop(); reject(error); };
    const cancelled = () => fail(new DOMException('The sign-in was cancelled.', 'AbortError'));
    try {
      channel = new BroadcastChannel('ros-ai-plugins');
      channel.onmessage = event => { const data = event.data as { connected?: string; failed?: string; error?: string } | null; if (data?.connected === id) connected(); else if (data?.failed === id) fail(new Error(data.error || 'The sign-in failed.')); };
    } catch { /* The polling below still hears it. */ }
    const timer = setInterval(() => void reloadSuggestions().then(next => { if (next?.plugins[id] === 'ready') connected(); }), 2000);
    const expire = setTimeout(() => fail(new Error('The sign-in was not finished within 10 minutes. Start it again.')), SIGN_IN_WAIT);
    signal.addEventListener('abort', cancelled);
  });
}

type Phase = 'idle' | 'working' | 'signing-in' | 'key';
/** connected: the plugin is ready; steps says whether Ros was switched to its tools, or why that could not happen. */
type ConnectOptions = { projectId: string; backend?: AssistantBackend; onBackend: () => unknown; onOpenPlugin: (id: PluginId) => void; onConnected?: (id: PluginId, steps: { switched: boolean; error?: string }) => void };

/** Connecting one plugin from a chip or a card, without leaving the conversation: a switch, the app's sign-in in its own
 * window, or a key field. Ros in API mode cannot use plugins, so the click that connects also turns on its tools. */
function useConnect(plugin: PluginDefinition, { projectId, backend, onBackend, onOpenPlugin, onConnected }: ConnectOptions) {
  const kind = suggestionConnect(plugin) ?? 'setup', steps = backend === 'provider';
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState(''), [signIn, setSignIn] = useState<string>();
  // Only Cancel and × stop waiting. A chip goes away as soon as its plugin reads as connected, often before this flow
  // hears it, and the flow must still finish: turn on Ros's tools and say the plugin is connected.
  const stopping = useRef<AbortController | null>(null);
  const finish = async () => {
    let switched = false, problem: string | undefined;
    if (steps) { try { await post(`/api/projects/${projectId}/assistant/backend`, { backend: 'agent' }); switched = true; await onBackend(); } catch (cause) { problem = errorText(cause); } }
    await reloadSuggestions();
    setPhase('idle');
    onConnected?.(plugin.id, { switched, ...(problem ? { error: problem } : {}) });
  };
  const run = async (work: () => Promise<unknown>, back: Phase = 'idle') => {
    setPhase('working'); setError('');
    try { await work(); } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(errorText(cause)); setPhase(back); }
  };
  const start = () => {
    if (kind === 'setup') { onOpenPlugin(setupPage(plugin.id)); return; }
    if (kind === 'key' || kind === 'token') { setError(''); setPhase('key'); return; }
    if (kind === 'switch') { void run(async () => { await api(`/api/papers/${plugin.id}`, { method: 'PUT', body: JSON.stringify({ agents: true }) }); await finish(); }); return; }
    void run(async () => {
      const controller = new AbortController(); stopping.current = controller;
      const started = await openSignIn(plugin.id);
      if (!started.connected) { setSignIn(started.url); setPhase('signing-in'); await waitForSignIn(plugin.id, controller.signal); }
      await finish();
    });
  };
  const saveKey = (value: string) => void run(async () => {
    if (kind === 'key') {
      await api(`/api/connections/credentials/${plugin.id}`, { method: 'PUT', body: JSON.stringify({ apiKey: value }) });
      // The person picked this search service, so Ros and the agents search with it from now on.
      await api('/api/connections/search', { method: 'PUT', body: JSON.stringify({ provider: plugin.id }) });
    } else {
      await api(`/api/plugins/${plugin.id}`, { method: 'PUT', body: JSON.stringify({ token: value }) });
      const checked = await post<PluginStatus>(`/api/plugins/${plugin.id}/check`, {});
      if (checked.verified === false) throw new Error(checked.checkMessage ?? `${plugin.name} did not accept it.`);
    }
    await finish();
  }, 'key');
  const cancel = () => { stopping.current?.abort(); setPhase('idle'); setError(''); };
  return { kind, steps, phase, error, signIn, start, saveKey, cancel };
}

/** A key or token pasted into the chip or the card; it goes to this computer's ros.ai only, never to a model. */
function KeyField({ plugin, kind, busy, onSave, onCancel }: { plugin: PluginDefinition; kind: SuggestionConnect; busy: boolean; onSave: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const key = kind === 'key', min = key ? 12 : 8, label = key ? `${plugin.name} API key` : plugin.tokenLabel ?? `${plugin.name} token`;
  const link = key && isSearchProvider(plugin.id) ? searchKeys[plugin.id].link : plugin.tokenLink;
  return <form className="plugin-key" onSubmit={event => { event.preventDefault(); if (!busy && value.trim().length >= min) onSave(value.trim()); }}>
    {!key && plugin.tokenHint && <p className="plugin-key-hint">{plugin.tokenHint}</p>}
    <div className="plugin-key-row">
      <label className="sr-only" htmlFor={`plugin-key-${plugin.id}`}>{label}</label>
      <input id={`plugin-key-${plugin.id}`} type="password" autoComplete="off" autoFocus placeholder={`Paste your ${label}`} value={value} onChange={event => setValue(event.target.value)} required minLength={min} maxLength={4096}/>
      <button className="primary small" type="submit" disabled={busy || value.trim().length < min}>{busy && <LoaderCircle size={13} className="spin"/>}{key ? 'Save' : 'Save and check'}</button>
      <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    {link && <a className="plugin-key-link" href={link} target="_blank" rel="noreferrer">Get {key ? 'a key' : 'a token'} at {new URL(link).hostname}<ExternalLink size={11}/></a>}
  </form>;
}

type ChipOptions = { draft: string; projectId: string; backend?: AssistantBackend; hidden?: boolean; onBackend: () => unknown; onOpenPlugin: (id: PluginId) => void };
/** The chip above the input: the first plugin the draft points at (a link or a name) that agents cannot use yet. It never
 * blocks sending. suggest lists the plugins still not connected, to send with the message, so the reply carries a card. */
export function usePluginChip({ draft, projectId, backend, hidden, onBackend, onOpenPlugin }: ChipOptions) {
  const status = useSuggestions();
  const matches = useMemo(() => pluginMatches(draft), [draft]);
  const [dismissed, setDismissed] = useState<PluginId[]>([]), [connected, setConnected] = useState<{ id: PluginId; switched: boolean; error?: string } | null>(null);
  const named = matches.map(match => match.id).join(' ');
  // A plugin new to the draft: read what is connected now, in case it changed on another page.
  useEffect(() => { if (named) void reloadSuggestions(); }, [named]);
  // A sent or cleared draft starts afresh: × only puts a plugin off for the draft it was pressed on.
  useEffect(() => { if (!draft.trim()) { setDismissed([]); setConnected(null); } }, [draft]);
  const open = status?.enabled ? matches.filter(match => { const state = status.plugins[match.id]; return state && state !== 'ready' && !silenced(status, match.id, projectId) && !dismissed.includes(match.id); }) : [];
  const first = open[0], done = !first && connected && matches.some(match => match.id === connected.id) ? connected : null;
  const chip = hidden || !status ? null
    : first ? <PluginChip key={first.id} match={first} state={status.plugins[first.id]} options={{ projectId, backend, onBackend, onOpenPlugin, onConnected: (id, steps) => setConnected({ id, ...steps }) }} onDismiss={() => setDismissed(list => [...list, first.id])}/>
    : done ? <div className="plugin-chip" role="status" data-testid="plugin-chip">
      <PluginMark id={done.id} size={16}/><span className="plugin-dot" aria-hidden="true"/>
      <span className="plugin-chip-text">{pluginName(done.id)} connected{done.switched ? '. Ros now works step by step here.' : done.error ? `. Turn on “Use ros.ai’s tools step by step” in the model menu so Ros can use it.` : ''}</span>
      <button type="button" className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setConnected(null)}><X size={14}/></button>
    </div> : null;
  return { chip, suggest: open.map(match => match.id) };
}

function PluginChip({ match, state, options, onDismiss }: { match: PluginMatch; state: PluginReadiness | undefined; options: ConnectOptions; onDismiss: () => void }) {
  const plugin = definition(match.id), connect = useConnect(plugin, options), busy = connect.phase === 'working';
  const dismiss = <button type="button" className="icon-button" aria-label="Not now" title="Not now" onClick={() => { connect.cancel(); onDismiss(); }}><X size={14}/></button>;
  if (connect.phase === 'key') return <div className="plugin-chip open" role="group" aria-label={`Connect ${plugin.name}`} data-testid="plugin-chip"><PluginMark id={plugin.id} size={16}/><KeyField plugin={plugin} kind={connect.kind} busy={busy} onSave={connect.saveKey} onCancel={connect.cancel}/>{dismiss}</div>;
  const signingIn = connect.phase === 'signing-in';
  return <div className={`plugin-chip ${connect.error ? 'failed' : ''}`} role="group" aria-label={`Connect ${plugin.name}`} data-testid="plugin-chip">
    <PluginMark id={plugin.id} size={16}/>
    <span className="plugin-chip-text" role={connect.error ? 'alert' : signingIn ? 'status' : undefined}>{connect.error || (signingIn ? `Approve ros.ai in the ${plugin.name} window` : stateText(plugin.name, state))}</span>
    {signingIn ? <>{connect.signIn && <a className="plugin-chip-link" href={connect.signIn} target="_blank" rel="noreferrer">Open again<ExternalLink size={11}/></a>}<LoaderCircle size={14} className="spin" aria-hidden="true"/></>
      : <button type="button" className="primary small" disabled={busy} title={connect.steps && connect.kind !== 'setup' ? 'Also turns on ros.ai’s tools step by step for this project, so Ros can use it' : undefined} onClick={connect.start}>{busy && <LoaderCircle size={13} className="spin"/>}{actionLabel(connect.kind, state)}</button>}
    {dismiss}
  </div>;
}

/** Cards under replies still waiting for the person, counted in the bar's "N waiting". */
export function suggestionsWaiting(turns: AssistantTurn[], status: SuggestionStatus | undefined, projectId: string) {
  if (!status?.enabled) return 0;
  return turns.filter(turn => turn.status !== 'running' && turn.suggested?.status === 'open' && turn.suggested.plugins.some(item => { const state = status.plugins[item.id]; return state && state !== 'ready' && !silenced(status, item.id, projectId); })).length;
}

type CardProps = { turn: AssistantTurn; latest: boolean; running: boolean; projectId: string; backend?: AssistantBackend; onSend: (message: string) => Promise<boolean>; onRefresh: () => unknown; onOpenPlugin: (id: PluginId) => void };
/** The card under a reply: plugins the request needed that agents cannot use yet. Each connects in place; then Continue
 * sends a follow-up, so the agent picks the request back up with the plugin among its tools. */
export function PluginSuggestionCard({ turn, latest, running, projectId, backend, onSend, onRefresh, onOpenPlugin }: CardProps) {
  const status = useSuggestions();
  const [phases, setPhases] = useState<Partial<Record<PluginId, Phase>>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [menu, setMenu] = useState(false);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!more.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);
  const card = turn.suggested;
  if (!card || !status?.enabled || (card.status !== 'open' && card.status !== 'done')) return null;
  const rows = card.plugins.filter(item => status.plugins[item.id] && !silenced(status, item.id, projectId));
  if (!rows.length) return null;
  const waiting = card.status === 'open' ? rows.filter(item => status.plugins[item.id] !== 'ready') : [];
  const names = rows.map(item => pluginName(item.id)).join(' and '), single = rows.length === 1;
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  const later = () => void run(async () => { await decideSuggestion({ decision: 'later', projectId, turnId: turn.id }); await onRefresh(); });
  const never = (id: PluginId) => void run(async () => { setMenu(false); await decideSuggestion({ decision: 'never', projectId, turnId: turn.id, pluginId: id }); await onRefresh(); });
  const carryOn = () => void run(async () => {
    if (backend === 'provider') await post(`/api/projects/${projectId}/assistant/backend`, { backend: 'agent' });
    if (await onSend(`${names} ${single ? 'is' : 'are'} connected now. Please carry on with my request.`)) await decideSuggestion({ decision: 'done', projectId, turnId: turn.id });
    await onRefresh();
  });
  const options: ConnectOptions = { projectId, backend, onBackend: onRefresh, onOpenPlugin };
  const extras = <>
    <button type="button" className="text-button" disabled={busy} onClick={later}>Not now</button>
    <span className="plugin-card-spacer"/>
    <div className="plugin-card-more" ref={more}>
      <button type="button" className="icon-button" aria-label="More options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={16}/></button>
      {menu && <div className="ros-model-menu plugin-card-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); } }}>{waiting.map(item => <button key={item.id} type="button" role="menuitem" disabled={busy} onClick={() => never(item.id)}>Don’t suggest {pluginName(item.id)}</button>)}</div>}
    </div>
  </>;
  const signingIn = Object.values(phases).includes('signing-in');
  return <div className="assistant-action plugin-card" data-testid="plugin-card">
    <div className="assistant-action-title"><span className="ros-mark" aria-hidden="true"><ResearchRing/></span><strong>ros.ai noticed</strong>{waiting.length > 0 && <span>{signingIn ? 'Signing in' : 'Waiting for you'}</span>}</div>
    {rows.map(item => <SuggestionRow key={item.id} match={item} state={status.plugins[item.id]} options={options} single={single} extras={extras} onPhase={phase => setPhases(current => current[item.id] === phase ? current : { ...current, [item.id]: phase })}/>)}
    {backend === 'provider' && (waiting.length > 0 || (card.status === 'open' && latest)) && <p className="plugin-card-note">{stepsNote(names)}</p>}
    {!single && waiting.length > 0 && <div className="assistant-action-buttons">{extras}</div>}
    {!waiting.length && card.status === 'open' && latest && <div className="assistant-action-buttons"><button type="button" className="primary small" disabled={busy || running} onClick={carryOn}>{busy && <LoaderCircle size={13} className="spin"/>}Continue<ArrowRight size={13}/></button></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}

function SuggestionRow({ match, state, options, single, extras, onPhase }: { match: PluginMatch; state: PluginReadiness | undefined; options: ConnectOptions; single: boolean; extras: ReactNode; onPhase: (phase: Phase) => void }) {
  const plugin = definition(match.id), connect = useConnect(plugin, options), ready = state === 'ready', busy = connect.phase === 'working';
  useEffect(() => onPhase(connect.phase), [connect.phase]);
  const label = actionLabel(connect.kind, state);
  const action = connect.phase === 'signing-in'
    ? <>{connect.signIn && <a className="secondary small plugin-open-again" href={connect.signIn} target="_blank" rel="noreferrer"><ExternalLink size={13}/>Open the sign-in again</a>}<button type="button" className="text-button" onClick={connect.cancel}>Cancel</button></>
    : <button type="button" className={single ? 'primary small' : 'secondary small'} disabled={busy} onClick={connect.start}>{busy ? <LoaderCircle size={13} className="spin"/> : <Plug size={13}/>}{label}</button>;
  return <div className="plugin-suggestion">
    <div className="plugin-suggestion-head">
      <span className="plugin-suggestion-mark"><PluginMark id={plugin.id} size={22}/></span>
      <div className="plugin-suggestion-text">
        <span className="plugin-suggestion-name"><strong>{plugin.name}</strong>{ready && <span className="plugin-suggestion-ok" role="status"><span className="plugin-dot" aria-hidden="true"/>Connected</span>}</span>
        {ready ? <span>Ros can use {plugin.name} from the next step.</span>
          : connect.phase === 'signing-in' ? <span className="plugin-suggestion-wait" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true"/>Approve ros.ai in the {plugin.name} window that opened.</span>
          : <><span>{suggestionReason(match)}</span><small><ShieldCheck size={12} aria-hidden="true"/>{pluginReach(plugin.id)}</small></>}
        {!single && !ready && connect.phase !== 'key' && <div className="plugin-suggestion-inline">{action}</div>}
      </div>
    </div>
    {!ready && connect.phase === 'key' && <KeyField plugin={plugin} kind={connect.kind} busy={busy} onSave={connect.saveKey} onCancel={connect.cancel}/>}
    {connect.error && <p className="inline-error" role="alert">{connect.error}</p>}
    {single && !ready && connect.phase !== 'key' && <div className="assistant-action-buttons">{action}{connect.phase !== 'signing-in' && extras}</div>}
  </div>;
}
