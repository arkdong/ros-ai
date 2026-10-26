import { useState } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import { ACP_AGENTS, type AcpAgentId, type AcpAgentStatus } from '../shared/acp-agents';
import { BrandLogo, type BrandId } from './brand-logos';
import { ConnectionCard } from './ModelPage';
import { CommandBox } from './Setup';
import { date } from './Content';
import { post } from './api';

export const acpLogo: Record<AcpAgentId, BrandId> = { gemini: 'gemini-cli', goose: 'goose', opencode: 'opencode' };

/** The state an Agents page row shows: green only once the agent is installed and nothing stops it. */
export function acpState(status?: AcpAgentStatus) {
  if (!status) return { label: '', connected: false };
  if (!status.installed) return { label: 'Not installed', connected: false };
  if (status.blocker) return { label: 'Cannot start', connected: false, shown: true };
  if (status.checked && !status.checked.ok) return { label: 'Check failed', connected: false, shown: true };
  return { label: status.checked ? 'Ready' : 'Installed', connected: true };
}

const works: Record<AcpAgentId, string> = {
  gemini: 'ros.ai starts Gemini CLI for each Ros turn. It can read the project folder and works through ros.ai’s tools; ros.ai switches off its other tools and does not load the folder’s own Gemini CLI settings.',
  opencode: 'ros.ai starts OpenCode for each Ros turn in the project folder. It can read the folder and works through ros.ai’s tools; ros.ai switches off its other tools and does not load the folder’s own OpenCode config.',
  goose: 'ros.ai starts Goose for each Ros turn, in the mode where every tool asks first, and allows only ros.ai’s tools. It reads blocks through ros.ai, not the folder.',
};

/** One ACP agent on the Agents page: where it is, how to install and sign in, and a check that starts it without a prompt. */
export function AcpAgentCard({ status, onChanged }: { status?: AcpAgentStatus; onChanged: (value: AcpAgentStatus) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!status) return null;
  const agent = ACP_AGENTS[status.id], state = acpState(status);
  const check = async () => {
    setBusy(true); setError('');
    try { onChanged(await post<AcpAgentStatus>(`/api/agents/acp/${status.id}/check`)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return <ConnectionCard forceOpen label={agent.label} icon={<BrandLogo id={acpLogo[status.id]} size={20}/>} subtitle={status.installed ? `${status.version ?? 'Version unknown'} · ${status.path}` : 'Not on this computer'} connected={state.connected} status={state.label}>
    {status.installed ? <p>{works[status.id]}</p> : <><p>Install {agent.label} in a terminal, then click Check.</p><CommandBox command={agent.install} label={`${agent.label} install`}/></>}
    <p className="subtle">{agent.signIn} <a href={agent.docs} target="_blank" rel="noreferrer">{agent.label} docs<ExternalLink size={11}/></a></p>
    {status.blocker && status.installed && <p className="inline-error" role="alert">{status.blocker}</p>}
    {status.checked && <p className={status.checked.ok ? 'connection-check' : 'inline-error'} role="status">{status.checked.detail} · {date(status.checked.at)}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="connection-actions"><button className="primary small" disabled={busy} onClick={() => void check()}>{busy && <LoaderCircle size={13} className="spin"/>}{busy ? 'Checking…' : 'Check'}</button></div>
    {status.installed && !status.blocker && <p className="subtle">Choose {agent.label} from the model name in the Ros bar. Its provider bills its own account; what it spends does not show in Settings › Usage.</p>}
  </ConnectionCard>;
}
