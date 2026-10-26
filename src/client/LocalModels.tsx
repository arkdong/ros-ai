import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { AGENT_CONTEXT_TOKENS, type DetectedModel, type SetupLinkResponse, type SetupStatus } from '../shared/setup';
import type { InferenceConnectionStatus } from '../shared/inference';
import { ConnectionCard } from './ModelPage';
import { InferenceConnections } from './InferenceConnections';
import { BrandLogo } from './brand-logos';
import { api } from './api';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const short = (tokens: number) => tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : tokens.toLocaleString('en-US');
const guidance = {
  ollama: { download: 'https://ollama.com/download', start: 'Open Ollama, then press Refresh.', empty: 'No models yet. Download one, for example with ollama pull qwen3:8b, then press Refresh.',
    context: 'Set Context length to 32k in Ollama’s settings (or start it with OLLAMA_CONTEXT_LENGTH=32768), then press Refresh.' },
  'lm-studio': { download: 'https://lmstudio.ai', start: 'Open LM Studio and start its server under Developer, then press Refresh.', empty: 'No models yet. Download one in LM Studio, then press Refresh.',
    context: 'Load the model in LM Studio with a context length of 32k, then press Refresh.' },
};
type Row = { id: string; context: number | null; tools: boolean | null };

/** Agents › Local models: Ollama and LM Studio on this computer, each one Connect away, with every model's context
 * as its server gives it and whether ros.ai's agent can work with it. Other servers follow below. */
export function LocalModels({ hide, onChanged }: { hide: (string | undefined)[]; onChanged: () => Promise<unknown> }) {
  const [setup, setSetup] = useState<SetupStatus>(), [connections, setConnections] = useState<InferenceConnectionStatus[]>([]), [error, setError] = useState('');
  const load = useCallback(async (rescan = false) => {
    const [status, saved] = await Promise.all([api<SetupStatus>(`/api/setup${rescan ? '?rescan=1' : ''}`), api<{ connections: InferenceConnectionStatus[] }>('/api/connections/inference')]);
    setSetup(status); setConnections(saved.connections);
  }, []);
  useEffect(() => { void load().catch(cause => setError(errorText(cause))); }, [load]);
  const changed = async () => { await load(); window.dispatchEvent(new Event('ros-ai-model-settings')); await onChanged(); };
  const servers = setup?.models ?? [];
  return <>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!setup && !error && <p className="subtle" role="status"><LoaderCircle className="spin" size={13}/> Looking for model servers on this computer…</p>}
    {servers.map(server => <LocalServer key={server.id} server={server} connection={connections.find(item => item.id === server.connectionId && !item.deleted)} onRescan={() => load(true)} onChanged={changed}/>)}
    <InferenceConnections hidden={[...servers.map(server => server.connectionId ?? undefined), ...hide].filter((id): id is string => Boolean(id))} onChanged={changed}/>
  </>;
}

function LocalServer({ server, connection, onRescan, onChanged }: { server: DetectedModel; connection?: InferenceConnectionStatus; onRescan: () => Promise<void>; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const text = guidance[server.id];
  // Once connected, a model's facts are the ones ros.ai uses: its registered context and tool support.
  const rows: Row[] = connection ? connection.models.map(model => ({ id: model.id, context: model.contextTokens, tools: model.tools ?? server.details.find(item => item.id === model.id)?.tools ?? null }))
    : server.details.filter(item => !item.embedding).map(item => ({ id: item.id, context: item.context, tools: item.tools }));
  // Before Connect an unknown context is no problem yet: connecting reads it.
  const small = rows.some(row => row.tools !== false && row.context !== null && row.context < AGENT_CONTEXT_TOKENS);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  // Connecting reads every model's context; for Ollama that can mean loading one model, so it may take a while.
  const link = () => run(async () => {
    const result = await api<SetupLinkResponse>('/api/setup/links', { method: 'POST', body: JSON.stringify({ models: [server.id] }), signal: AbortSignal.timeout(180_000) });
    const outcome = result.models[0];
    if (!outcome?.ok) throw new Error(outcome?.message ?? `${server.label} could not be connected.`);
    setNotice(outcome.message); await onChanged();
  });
  const state = connection ? 'Connected' : server.running ? 'Running' : server.found ? 'Not running' : 'Not found';
  const subtitle = server.running ? `${rows.length} model${rows.length === 1 ? '' : 's'} on this computer` : server.found ? 'Installed, not running' : 'Not on this computer';
  return <ConnectionCard label={server.label} icon={<BrandLogo id={server.id} size={20}/>} subtitle={subtitle} status={state} connected={Boolean(connection)} forceOpen={server.running && !connection}>
    {!server.found && <p>Runs open models on this computer; ros.ai connects to it on its usual port. <a href={text.download} target="_blank" rel="noreferrer">Get {server.label}<ExternalLink size={11}/></a></p>}
    {server.found && !server.running && <p>{text.start}</p>}
    {server.running && !rows.length && <p>{text.empty}</p>}
    {rows.length > 0 && <ul className="local-models" aria-label={`${server.label} models`}>{rows.map(row => <li key={row.id}>
      <span className="local-model-name">{row.id}</span>
      <span className="local-model-facts">{row.context ? `${short(row.context)} context` : 'Context not known yet'}</span>
      {row.tools === false ? <span className="local-model-tag">Chat only</span> : row.tools && (row.context ?? 0) >= AGENT_CONTEXT_TOKENS ? <span className="local-model-tag">Agent</span> : null}
    </li>)}</ul>}
    {rows.length > 0 && small && <p className="connection-limit">Ros works step by step with a model marked Agent: it needs tools and a {short(AGENT_CONTEXT_TOKENS)} context, 32k is better. {text.context}</p>}
    {notice && <p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="connection-actions">
      {server.running && rows.length > 0 && !connection && <button className="primary small" disabled={busy} onClick={() => void link()}>{busy ? <><LoaderCircle size={13} className="spin"/>Connecting…</> : 'Connect'}</button>}
      {(connection || !server.running || !rows.length) && <button className="secondary small" disabled={busy} onClick={() => void (connection && server.running ? link() : run(onRescan))}>{busy ? <LoaderCircle size={13} className="spin"/> : <RefreshCw size={13}/>}Refresh</button>}
      {connection && <button className="text-button" disabled={busy} onClick={() => void run(async () => { await api(`/api/connections/inference/${connection.id}`, { method: 'DELETE' }); await onChanged(); })}>Disconnect</button>}
    </div>
  </ConnectionCard>;
}
