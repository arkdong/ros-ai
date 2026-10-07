import { useEffect, useState } from 'react';
import { BatteryMedium, ChevronDown, Clock3, LoaderCircle, PanelRightClose, RefreshCw } from 'lucide-react';
import { api } from './api';
import type { InferenceConnectionsResponse } from '../shared/inference';
import { summarizeBudgetPeriod, type BudgetPeriod, type BudgetReport, type BudgetUsage, type ProviderAccounts, type TavilyUsageScope } from '../shared/budget-report';
import './BudgetPanel.css';

const money = (value: number) => value > 0 && value < .000001 ? '< US$0.000001' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < .01 ? 6 : 2 }).format(value);
const count = (value: number) => new Intl.NumberFormat().format(value);
const periods: { value: BudgetPeriod; label: string }[] = [{ value: 'hour', label: 'Last hour' }, { value: 'today', label: 'Today' }, { value: 'day', label: 'Last 24h' }];
const providerName:Record<string,string> = { nebius: 'Nebius', openai: 'OpenAI', tavily: 'Tavily', 'nebius-sandbox': 'Nebius Sandbox' };

export function BudgetPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [report, setReport] = useState<BudgetReport | null>(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<BudgetPeriod>('today');
  const [now, setNow] = useState(() => new Date());
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState(12);
  const [registeredNames,setRegisteredNames]=useState<Record<string,string>>({});
  useEffect(()=>{let current=true;void api<InferenceConnectionsResponse>('/api/connections/inference').then(value=>{if(current)setRegisteredNames(Object.fromEntries(value.connections.map(connection=>[connection.id,connection.name])));}).catch(()=>{});return()=>{current=false;};},[refresh]);
  useEffect(() => {
    let disposed = false, request: AbortController | null = null;
    const load = async () => {
      request?.abort(); request = new AbortController();
      try {
        const next = await api<BudgetReport>(`/api/projects/${projectId}/budget`, { signal: request.signal });
        if (!disposed) { setReport(next); setError(''); setNow(new Date()); }
      } catch (failure) { if (!disposed && !(failure instanceof DOMException && failure.name === 'AbortError')) setError((failure as Error).message); }
    };
    void load(); const timer = window.setInterval(() => void load(), 30000);
    return () => { disposed = true; request?.abort(); window.clearInterval(timer); };
  }, [projectId, refresh]);
  const data = report?.projectId === projectId ? report : null;
  const summary = summarizeBudgetPeriod(data?.entries ?? [], period, now);
  const hasKnownEstimates = summary.entries.length > summary.unknownEstimates;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const changedPeriod = (value: BudgetPeriod) => { setPeriod(value); setVisible(12); setNow(new Date()); };
  return <aside id="research-budget-panel" className="assistant-panel budget-panel" aria-label="Project budget" data-testid="budget-panel">
    <header className="assistant-heading budget-heading"><span className="budget-heading-icon"><BatteryMedium size={24}/></span><div><h2>Budget & usage</h2><p>Project spending and provider usage</p></div><button className="icon-button" aria-label="Close budget panel" onClick={onClose}><PanelRightClose size={17}/></button></header>
    <div className="budget-scroll">
      {error && <div className="budget-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13}/> Try again</button></div>}
      {!data && !error && <p className="budget-loading"><LoaderCircle size={16} className="spin"/> Reading saved usage…</p>}
      {data && <>
        <section className="budget-remaining" aria-label="Project spending so far">
          <span className="budget-eyebrow">Project spending so far · USD</span><strong className="budget-remaining-value">{money(data.used.spendUsd)}</strong>
          <p>Conservative reservations, including failed or uncertain requests. Each connection's own allowance caps paid calls.{data.stopped ? ' Project research is stopped.' : ''}</p>
          <div className="budget-resource-counts"><span><strong>{data.used.modelCalls}</strong>model requests</span><span><strong>{data.used.experiments}</strong>code runs</span></div>
        </section>
        <section className="budget-activity" aria-label="Recorded provider usage">
          <div className="budget-section-heading"><h3>Recorded usage</h3><span>{summary.entries.length} request{summary.entries.length === 1 ? '' : 's'}</span></div>
          <div className="budget-periods" role="group" aria-label="Usage time range">{periods.map(item => <button key={item.value} aria-pressed={period === item.value} className={period === item.value ? 'active' : ''} onClick={() => changedPeriod(item.value)}>{item.label}</button>)}</div>
          <p className="budget-timezone"><Clock3 size={11}/>{period === 'today' ? 'Since local midnight' : period === 'hour' ? 'Rolling 60 minutes' : 'Rolling 24 hours'} · {zone}</p>
          <div className="budget-period-totals"><div><span>Known cost estimates</span><strong>{summary.entries.length && !hasKnownEstimates ? 'Unknown' : money(summary.knownEstimatedUsd)}</strong><small>{summary.unknownEstimates ? `${summary.unknownEstimates} request${summary.unknownEstimates === 1 ? '' : 's'} missing a USD estimate` : summary.entries.length ? 'From saved usage and pricing' : 'No requests in this period'}</small></div><div><span>Retained reservations</span><strong>{summary.unknownReservations === summary.entries.length && summary.entries.length ? 'Unknown' : money(summary.retainedUsd)}</strong><small>{summary.unknownReservations ? `${summary.unknownReservations} reservation${summary.unknownReservations === 1 ? '' : 's'} unknown` : 'For requests in this period'}</small></div></div>
          <p className="budget-estimate-note">Estimates are not invoices. Reported tokens and search credits appear below; missing costs remain unknown.</p>
          {summary.entries.length ? <ol className="budget-usage-list">{summary.entries.slice(0, visible).map(entry => <UsageRow key={entry.id} entry={entry} providerLabel={registeredNames[entry.provider]||providerName[entry.provider]||entry.provider}/>)}</ol> : <div className="budget-empty">No provider requests recorded in this project during this period.</div>}
          {summary.entries.length > visible && <button className="budget-more text-button" onClick={() => setVisible(value => value + 20)}>Show more requests <ChevronDown size={14}/></button>}
        </section>
        <AccountUsage accounts={data.providerAccounts}/>
        <details className="budget-provider-details"><summary>App provider allowances <ChevronDown size={14}/></summary><p>These are app spending permissions shared across projects. They overlap with project spending; do not add them to project spending or provider account credit.</p>
          {data.providerAllowances.map(allowance => <div className="budget-provider-row" key={allowance.name}><strong>{allowance.name}</strong><span>{money(allowance.remainingUsd)} available under ceiling</span><small>{money(allowance.accountedUsd)} retained · {money(allowance.ceilingUsd)} ceiling<br/>{allowance.scope}</small></div>)}
          <div className="budget-provider-row"><strong>Combined Nebius allowance</strong><span>{money(data.combined.remainingUsd)} remaining{!data.combined.enabled ? ' · currently blocked' : ''}</span><small>{money(data.combined.accountedUsd)} retained · {money(data.combined.ceilingUsd)} ceiling<br/>Inference and sandbox attempts share this additional gate.</small></div>
          {data.sandbox && <div className="budget-provider-row"><strong>Sandbox execution allowance</strong><span>{data.sandbox.perAttemptUsd === null ? 'Pricing / authorization unavailable' : `${money(data.sandbox.remainingUsd)} remaining · ${data.sandbox.remainingRuns} attempts`}</span><small>{data.sandbox.perAttemptUsd === null ? 'No verified USD ceiling per attempt.' : `${money(data.sandbox.perAttemptUsd)} retained per admitted attempt.`}{!data.sandbox.enabled && ' Execution is currently blocked.'}</small></div>}
          {data.unattributedWorkspaceRequests > 0 && <p>{data.unattributedWorkspaceRequests} older workspace request{data.unattributedWorkspaceRequests === 1 ? '' : 's'} cannot be assigned to a project and {data.unattributedWorkspaceRequests === 1 ? 'is' : 'are'} excluded from this project’s usage list. Shared provider accounting retains {data.unattributedWorkspaceRequests === 1 ? 'it' : 'them'}.</p>}
        </details>
      </>}
    </div>
    {data && <footer className="budget-footer">Local records updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<button className="icon-button" aria-label="Refresh budget and provider usage" title="Provider usage refreshes at most once per minute" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13}/></button></footer>}
  </aside>;
}

const credits = (value: number | null | undefined) => value == null ? 'Unknown' : `${count(value)} credits`;
function CreditPair({ label, used, limit }: { label: string; used: number | null; limit: number | null }) {
  return <div className="budget-provider-row"><strong>{label}</strong><span>{credits(used)} used</span><small>Reported limit: {credits(limit)}{limit !== null && used !== null ? ` · ${credits(Math.max(0, limit - used))} below limit` : ''}</small></div>;
}
function OperationUsage({ values }: { values: TavilyUsageScope['operations'] }) {
  return <dl className="budget-operations">{Object.entries(values).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{credits(value)}</dd></div>)}</dl>;
}
function AccountUsage({ accounts }: { accounts: ProviderAccounts | undefined }) {
  const tavily = accounts?.tavily, nebius = accounts?.nebius;
  const stale = tavily?.status === 'stale' || Boolean(tavily?.fetchedAt && Date.now() - Date.parse(tavily.fetchedAt) > 120_000);
  return <section className="budget-provider-accounts" aria-label="Provider account usage">
    <div className="budget-section-heading"><h3>Provider accounts</h3><span>Separate from project caps</span></div>
    <div className="budget-account-credit"><strong>Nebius account credit</strong><span>{nebius ? `${nebius.approximate ? '≈ ' : ''}${money(nebius.amountUsd)}` : 'Unknown'}</span><p>{nebius ? `User-reported on ${nebius.reportedOn}. ${nebius.observedAt ? `Observed ${new Date(nebius.observedAt).toLocaleString()}.` : 'Original observation time unknown.'} Not API-verified; not adjusted using local spending records.` : 'No supported balance refresh is configured.'} Account credit does not grant permission to spend.</p></div>
    <div className="budget-tavily"><div className="budget-section-heading"><strong>Tavily usage & limits</strong><span className={stale || tavily?.status === 'error' ? 'budget-stale' : ''}>{stale ? 'Stale snapshot' : tavily?.status === 'fresh' ? 'API snapshot' : tavily?.status === 'error' ? 'Refresh failed' : tavily?.status === 'disabled' ? 'Sync disabled' : 'Not connected'}</span></div>
      <p className="budget-provider-note">Account and key totals are reported by Tavily in credits. Key usage is part of account usage; these figures are not additive or dollar balances.</p>
      {tavily?.error && <p className="budget-error" role="status">{tavily.error}{tavily.fetchedAt && ' The last successful snapshot remains below.'}</p>}
      {tavily?.fetchedAt && <p className="budget-provider-note">Last refreshed {new Date(tavily.fetchedAt).toLocaleString()}. Cached for one minute.</p>}
      {tavily?.attemptedAt && tavily.status !== 'fresh' && <p className="budget-provider-note">Last attempt {new Date(tavily.attemptedAt).toLocaleString()}.</p>}
      {!tavily?.key && !tavily?.error && <p className="budget-provider-note">{tavily?.status === 'disabled' ? 'Provider usage sync is disabled on this server.' : 'Configure the server-side Tavily key to retrieve usage.'}</p>}
      {tavily?.key && <><CreditPair label="This API key" used={tavily.key.usage} limit={tavily.key.limit}/><details className="budget-operation-details"><summary>Key operation breakdown</summary><OperationUsage values={tavily.key.operations}/></details></>}
      {tavily?.account && <><CreditPair label={`Account plan${tavily.account.plan ? ` · ${tavily.account.plan}` : ''}`} used={tavily.account.planUsage} limit={tavily.account.planLimit}/><CreditPair label="Account pay as you go" used={tavily.account.paygoUsage} limit={tavily.account.paygoLimit}/><details className="budget-operation-details"><summary>Account operation breakdown</summary><OperationUsage values={tavily.account.operations}/></details></>}
    </div>
  </section>;
}

function UsageRow({ entry,providerLabel }: { entry: BudgetUsage;providerLabel:string }) {
  const quantities: string[] = [];
  if (entry.inputTokens !== null) quantities.push(`${count(entry.inputTokens)} input tokens`);
  if (entry.outputTokens !== null) quantities.push(`${count(entry.outputTokens)} output tokens`);
  if (entry.credits !== null) quantities.push(`${count(entry.credits)} search credit${entry.credits === 1 ? '' : 's'}`);
  const label = entry.status === 'settled' ? 'Usage reported' : entry.status === 'reserved' ? 'Awaiting usage' : entry.status === 'uncertain' || entry.status === 'interrupted' ? 'Outcome uncertain' : entry.status;
  return <li className="budget-usage-row"><div className="budget-usage-meta"><strong title={entry.provider}>{providerLabel}</strong><time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p className="budget-usage-purpose">{entry.purpose}</p>{entry.nodeTitle && <p className="budget-usage-node">{entry.nodeTitle}</p>}<p className="budget-usage-quantities">{quantities.length ? quantities.join(' · ') : 'Reported usage unavailable'}</p><div className="budget-usage-cost"><span>{entry.estimatedUsd === null ? 'USD estimate unknown' : `${money(entry.estimatedUsd)} estimated`}</span><span>{entry.reservedUsd === null ? 'Reservation unknown' : `${money(entry.reservedUsd)} retained`}</span></div>{entry.rawCost !== null && <p className="budget-raw-cost">Provider cost: {count(entry.rawCost)} · unit unknown; not converted to USD</p>}<span className={`budget-usage-status ${['uncertain', 'interrupted'].includes(entry.status) ? 'uncertain' : ''}`}>{label}</span></li>;
}
