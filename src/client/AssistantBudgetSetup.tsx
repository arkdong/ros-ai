import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import type { ResearchPolicy } from '../shared/research';
import type { ConnectionBudgetStatus } from '../shared/connection-budgets';
import type { ModelSettingsResponse } from '../shared/model-settings';
import type { InferenceConnectionStatus,InferenceConnectionsResponse } from '../shared/inference';
import { api } from './api';
import './assistant-budget-setup.css';

type Props = {
  projectId: string;
  nodeId?: string | null;
  onChanged: () => Promise<unknown>;
  onConnections: () => void;
  onClose: () => void;
};
const money = (value: number) => `US$${value.toFixed(2)}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** This editor changes only the project's spending ceiling after its explicit
 * submit. Provider authority and sending a research message are separate. */
export function AssistantBudgetSetup({ projectId, nodeId, onChanged, onConnections, onClose }: Props) {
  const inputId = useId();
  const [policy, setPolicy] = useState<ResearchPolicy | null>(null);
  const [models, setModels] = useState<ModelSettingsResponse | null>(null);
  const [budgets, setBudgets] = useState<ConnectionBudgetStatus[] | null>(null);
  const [registered,setRegistered]=useState<InferenceConnectionStatus[]>([]),[registryError,setRegistryError]=useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [error, setError] = useState(''), [details, setDetails] = useState(''), [configurationError, setConfigurationError] = useState(''), [notice, setNotice] = useState('');
  const currentProject = useRef(projectId), mounted = useRef(false);
  currentProject.current = projectId;

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    mounted.current = true;
    setPolicy(null); setModels(null); setBudgets(null); setRegistered([]); setRegistryError(''); setAmount('');
    setLoading(true); setConnectionsLoading(true); setSaving(false); setError(''); setDetails(''); setNotice(''); setConfigurationError('');
    void api<ResearchPolicy>(`/api/projects/${projectId}/policy`, { signal: controller.signal }).then(value => {
      if (current) { setPolicy(value); setAmount(String(value.limits.spendUsd)); }
    }).catch(cause => {
      if (current) { setError('Could not load the project budget.'); setDetails(message(cause)); }
    }).finally(() => { if (current) setLoading(false); });
    let connectionRequest = 0;
    const loadConnections = async () => {
      const request = ++connectionRequest;
      const values = await Promise.allSettled([
        api<ModelSettingsResponse>(`/api/projects/${projectId}/models`, { signal: controller.signal }),
        api<{ budgets: ConnectionBudgetStatus[] }>('/api/connections/budgets', { signal: controller.signal }),
        api<InferenceConnectionsResponse>('/api/connections/inference', { signal: controller.signal }),
      ]);
      if (!current || request !== connectionRequest) return;
      const failures: string[] = [];
      const [modelResult, budgetResult,registryResult] = values;
      if (modelResult.status === 'fulfilled') setModels(modelResult.value); else failures.push(message(modelResult.reason));
      if (budgetResult.status === 'fulfilled') setBudgets(budgetResult.value.budgets); else failures.push(message(budgetResult.reason));
      if(registryResult.status==='fulfilled'){setRegistered(registryResult.value.connections);setRegistryError('');}else setRegistryError(message(registryResult.reason));
      setConfigurationError(failures.join('\n'));
      setConnectionsLoading(false);
    };
    void loadConnections();
    window.addEventListener('ros-ai-model-settings', loadConnections);
    return () => { current = false; mounted.current = false; controller.abort(); window.removeEventListener('ros-ai-model-settings', loadConnections); };
  }, [projectId]);

  const selection = (nodeId ? models?.effective[nodeId]?.selection : undefined) ?? models?.project ?? models?.default;
  const provider = models?.providers.find(value => value.id === selection?.provider);
  const custom=registered.find(value=>value.id===selection?.provider);
  const providerLabel=provider?.label??custom?.name??selection?.provider;
  const allowance = budgets?.find(value => value.provider === selection?.provider)??(custom?{enabled:custom.enabled&&custom.allowanceEnabled,ready:custom.ready,remainingUsd:custom.remainingUsd,remainingRequests:custom.remainingRequests,source:custom.requestCeiling?'app':'none',reason:custom.reason}:undefined);
  const selectedRegistryError=selection?.provider.startsWith('custom-')?registryError:'';
  const needsConnection = !connectionsLoading && (!provider || !allowance || !provider.configured || !allowance.enabled || !allowance.ready);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!policy || saving) return;
    const ceiling = Number(amount);
    setError(''); setDetails(''); setNotice('');
    if (!amount.trim() || !Number.isFinite(ceiling) || ceiling < 0 || ceiling > 1000) {
      setError('Enter a total project budget between US$0 and US$1,000.'); return;
    }
    if (ceiling < policy.used.spendUsd) {
      setError(`The total must include ${money(policy.used.spendUsd)} already reserved.`); return;
    }
    const savedProject = projectId;
    const stillCurrent = () => mounted.current && currentProject.current === savedProject;
    setSaving(true);
    try {
      const value = await api<ResearchPolicy>(`/api/projects/${savedProject}/policy/spend`, {
        method: 'PATCH', body: JSON.stringify({ spendUsd: ceiling, expectedRevision: policy.revision }),
      });
      if (!stillCurrent()) return;
      setPolicy(value); setAmount(String(value.limits.spendUsd));
      setNotice(value.limits.spendUsd > value.used.spendUsd ? 'Project budget saved. No message was sent.' : 'Project budget saved; no spending remains.');
      try { await onChanged(); }
      catch (cause) { if (stillCurrent()) { setError('Budget saved. Refresh connection status before continuing.'); setDetails(message(cause)); } }
    } catch (cause) {
      if (!stillCurrent()) return;
      setError('The project budget was not confirmed. Review the current limits before saving again.'); setDetails(message(cause));
      // Refresh current counters/revision, retaining the user's draft. Never
      // automatically repeat a write after a conflict or uncertain response.
      try { const value = await api<ResearchPolicy>(`/api/projects/${savedProject}/policy`); if (stillCurrent()) setPolicy(value); }
      catch { /* The original save diagnostic remains available. */ }
    } finally { if (stillCurrent()) setSaving(false); }
  };

  return <section className="assistant-budget-setup" aria-label="Project model budget">
    <header><strong>Project model budget</strong><button className="icon-button" type="button" aria-label="Close project budget setup" onClick={onClose}><X size={14}/></button></header>
    {providerLabel && allowance ? <p className="assistant-budget-provider">{providerLabel} · {custom?.destination==='local-unverified'?'no provider USD debit':money(allowance.remainingUsd)} · {allowance.remainingRequests} requests remaining{custom?.deleted ? ' · removed' : !allowance.enabled ? allowance.source === 'app' ? ' · paused' : ' · not enabled' : ''}</p> : <p className="assistant-budget-provider">{configurationError||selectedRegistryError ? 'Provider allowance could not be read.' : connectionsLoading ? 'Reading the selected provider allowance…' : 'No model provider allowance is configured.'}</p>}
    {(needsConnection || configurationError || selectedRegistryError || custom) && <button className="text-button" type="button" onClick={onConnections}>Manage connection</button>}
    {loading && <p role="status"><LoaderCircle size={13} className="spin"/> Reading project budget…</p>}
    {policy && <>
      <p>{money(policy.used.spendUsd)} reserved in this project. Total includes previous use.</p>
      <form onSubmit={event => void save(event)}>
        <label htmlFor={inputId}>Total project budget (USD)<input id={inputId} type="number" min="0" max="1000" step="0.01" required value={amount} disabled={saving} onChange={event => { setAmount(event.target.value); setNotice(''); }}/></label>
        <button className="primary small" type="submit" disabled={saving || !amount.trim()}>{saving ? <><LoaderCircle size={13} className="spin"/> Saving…</> : 'Save project budget'}</button>
      </form>
      <small>Applies to this project. Your provider allowance stays unchanged.</small>
    </>}
    {notice && <p className="assistant-budget-notice" role="status">{notice}</p>}
    {error && <p className="assistant-budget-error" role="alert">{error}</p>}
    {(details || configurationError || selectedRegistryError || (allowance && !allowance.ready)) && <details><summary>Details</summary>{details && <p>{details}</p>}{configurationError && <p>{configurationError}</p>}{selectedRegistryError&&<p>{selectedRegistryError}</p>}{allowance && !allowance.ready && <p>{allowance.reason}</p>}</details>}
  </section>;
}
