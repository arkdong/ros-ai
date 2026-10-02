import { useEffect, useState } from 'react';
import { ChevronDown, Pause, ShieldCheck } from 'lucide-react';
import type { ConnectionBudgetProvider, ConnectionBudgetStatus } from '../shared/connection-budgets';
import type { CodexAllowanceStatus, CodexAllowanceLimits } from '../shared/agent-budget-settings';
import type { ResearchPolicy } from '../shared/research';
import type { ProjectDetail } from '../shared/types';
import { api, post } from './api';

const money=(value:number)=>`US$${value.toFixed(2)}`;
const errorText=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);

export function ConnectionAllowance({provider,status,onChanged}:{provider:ConnectionBudgetProvider;status?:ConnectionBudgetStatus;onChanged:()=>Promise<void>}) {
  const [limit,setLimit]=useState(''),[requests,setRequests]=useState('20'),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{setLimit(status?.limitUsd?String(status.limitUsd):'');setRequests(status?.maxRequests?String(status.maxRequests):'20');setConsent(false);},[status?.revision,status?.source]);
  const run=async(work:()=>Promise<unknown>,success:string)=>{setBusy(true);setError('');setNotice('');try{await work();setConsent(false);await onChanged();setNotice(success);}catch(cause){setError(errorText(cause));}finally{setBusy(false);}};
  return <section className="connection-allowance" aria-label={`${provider} usage allowance`}>
    <div className="allowance-heading"><h4>Usage allowance</h4><span>{status?.source==='app'?(status.enabled?'Enabled':'Paused'):status?.enabled?'Server allowance':'Not enabled'}</span></div>
    {status&&<div className="allowance-meter"><div><span>{status.source==='none'?'Earlier reserved':'Reserved'}</span><strong>{money(status.accountedUsd)}</strong></div><div><span>Remaining</span><strong>{money(status.remainingUsd)}</strong></div><div><span>Requests left</span><strong>{status.remainingRequests} / {status.maxRequests}</strong></div></div>}
    <p>{status?.source==='app'?'This allowance is shared across ros.ai projects. Its reservations include failed or uncertain requests and remain when you edit or pause.':'Enable a fresh allowance shared across ros.ai projects. Earlier reservations remain in Budget & usage; new allowance counters are tracked separately.'}</p>
    {status?.enabled&&!status.ready&&<p className="connection-limit">{status.reason}</p>}
    <form onSubmit={event=>{event.preventDefault();if(busy||!consent)return;void run(()=>api(`/api/connections/budgets/${provider}`,{method:'PUT',body:JSON.stringify({limitUsd:Number(limit),maxRequests:Number(requests),enabled:true,acknowledged:true})}),'Allowance saved. No research has started.');}}>
      <div className="allowance-fields"><label>Total budget (USD)<input aria-label={`${provider} total budget (USD)`} type="number" min="0.01" max="1000" step="0.01" value={limit} onChange={event=>{setLimit(event.target.value);setConsent(false);}} placeholder="e.g. 5.00" required/></label><label>Total requests<input aria-label={`${provider} total requests`} type="number" min="1" max="10000" step="1" value={requests} onChange={event=>{setRequests(event.target.value);setConsent(false);}} required/></label></div>
      <label className="connection-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>Allow ros.ai to {provider==='tavily'?'search the web':'make model calls'} within these total limits.</label>
      <div className="connection-actions"><button className="primary small" type="submit" disabled={busy||!status||!consent||Number(limit)<=0||Number(requests)<1}><ShieldCheck size={13}/>{busy?'Saving…':status?.source==='app'?'Save allowance':'Enable usage'}</button>{status?.enabled&&<button type="button" className="secondary small" disabled={busy} onClick={()=>void run(()=>post(`/api/connections/budgets/${provider}/pause`,{}),'Usage paused. Existing reservations remain.')}><Pause size={12}/>Pause usage</button>}</div>
    </form>
    <p className="allowance-note">Each call must also fit the project ceiling above. {provider==='tavily'?'Search queries':'Model inputs'} go to this provider. Earlier server-authorized usage remains in Budget & usage. Saving does not start a call.</p>
    {notice&&<p className="connection-check" role="status">{notice}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}
  </section>;
}

export function ProjectSpendingCeiling({projectId,onChanged}:{projectId:string|null;onChanged:()=>Promise<void>}) {
  const [policy,setPolicy]=useState<ResearchPolicy|null>(null),[amount,setAmount]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const load=async()=>{if(!projectId)return;const value=await api<ResearchPolicy>(`/api/projects/${projectId}/policy`);setPolicy(value);setAmount(String(value.limits.spendUsd));};
  useEffect(()=>{setPolicy(null);setError('');setNotice('');let current=true;if(projectId)void api<ResearchPolicy>(`/api/projects/${projectId}/policy`).then(value=>{if(current){setPolicy(value);setAmount(String(value.limits.spendUsd));}}).catch(cause=>{if(current)setError(errorText(cause));});return()=>{current=false;};},[projectId]);
  if(!projectId)return <p className="project-ceiling-empty">Open a project to set its spending ceiling.</p>;
  return <details className="project-spending" id="connections-project-ceiling"><summary><span>Project ceiling <strong>{policy?money(policy.limits.spendUsd):'Loading…'}</strong></span><ChevronDown size={14}/></summary><div>
    <p>{policy?`${money(policy.used.spendUsd)} reserved · ${money(Math.max(0,policy.limits.spendUsd-policy.used.spendUsd))} remaining.`:'Reading project limits.'} This ceiling is shared by all providers in this project.</p>
    <form onSubmit={event=>{event.preventDefault();if(!policy||busy)return;setBusy(true);setError('');setNotice('');void api<ResearchPolicy>(`/api/projects/${projectId}/policy/spend`,{method:'PATCH',body:JSON.stringify({spendUsd:Number(amount),expectedRevision:policy.revision})}).then(async value=>{setPolicy(value);await onChanged();setNotice('Project ceiling saved. Approval mode and used amounts are unchanged.');}).catch(async cause=>{setError(errorText(cause));try{await load();}catch{}}).finally(()=>setBusy(false));}}><label>Total project budget (USD)<input aria-label="Total project budget (USD)" type="number" min="0" max="1000" step="0.01" value={amount} onChange={event=>setAmount(event.target.value)} required/></label><button type="submit" className="secondary small" disabled={busy||!policy}>{busy?'Saving…':'Save project ceiling'}</button></form>
    <p className="allowance-note">A connection allowance is also required. Setting this ceiling keeps your existing research permissions.</p>
    {notice&&<p className="connection-check" role="status">{notice}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}
  </div></details>;
}

export function CodexAllowance({projectId,onChanged}:{projectId:string;onChanged:()=>Promise<void>}) {
  const [status,setStatus]=useState<CodexAllowanceStatus|null>(null),[draft,setDraft]=useState<CodexAllowanceLimits>({maxTurns:5,maxRuntimeSeconds:300,maxToolCalls:15,perTurnSeconds:60,perTurnToolCalls:3}),[consent,setConsent]=useState(false),[refreshScope,setRefreshScope]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const load=async()=>{const value=await api<CodexAllowanceStatus>(`/api/projects/${projectId}/agents/codex/allowance`);setStatus(value);if(value.limits)setDraft(value.limits);};
  useEffect(()=>{let current=true;void api<CodexAllowanceStatus>(`/api/projects/${projectId}/agents/codex/allowance`).then(value=>{if(current){setStatus(value);if(value.limits)setDraft(value.limits);}}).catch(cause=>{if(current)setError(errorText(cause));});return()=>{current=false;};},[projectId]);
  const run=async(work:()=>Promise<unknown>,success:string)=>{setBusy(true);setError('');setNotice('');try{await work();setConsent(false);await load();await onChanged();setNotice(success);}catch(cause){setError(errorText(cause));}finally{setBusy(false);}};
  const field=(key:keyof CodexAllowanceLimits,label:string,max:number,min=1)=><label>{label}<input aria-label={`Codex ${label.toLowerCase()}`} type="number" min={min} max={max} step="1" required value={draft[key]} onChange={event=>{setDraft(previous=>({...previous,[key]:Number(event.target.value)}));setConsent(false);}}/></label>;
  const save=async()=>{
    const context=refreshScope?await api<ProjectDetail>(`/api/projects/${projectId}`):null;
    return api(`/api/projects/${projectId}/agents/codex/allowance`,{method:'PUT',body:JSON.stringify({...draft,enabled:true,acknowledged:true,...(context?{nodeIds:context.project.canvas.nodes.map(node=>node.id),artifactIds:context.artifacts.map(artifact=>artifact.id)}:{})})});
  };
  return <section className="connection-allowance" aria-label="Codex usage allowance"><div className="allowance-heading"><h4>Usage allowance</h4><span>{status?.source==='app'?(status.enabled?'Enabled':'Paused'):status?.enabled?'Server allowance':'Not enabled'}</span></div>
    <p>Codex uses turn, time and tool limits for this project. These do not set a dollar cap on your Codex account.</p>
    {status&&<p>{status.remaining.turns} turns · {status.remaining.runtimeSeconds}s · {status.remaining.toolCalls} tool calls remaining.</p>}
    {status&&!status.isolationReady&&<p className="connection-limit">Research stays blocked: the installed Codex CLI cannot isolate reads to this workspace. Saving an allowance does not fix that.</p>}
    <form onSubmit={event=>{event.preventDefault();if(busy||!consent)return;void run(async()=>{await save();setRefreshScope(false);},'Codex allowance saved. No turn has started.');}}>
      <div className="allowance-fields">{field('maxTurns','Total turns',100)}{field('maxRuntimeSeconds','Total seconds',3600)}</div>
      <details className="allowance-advanced"><summary>Time & tool limits</summary><div className="allowance-fields">{field('perTurnSeconds','Seconds per turn',300)}{field('maxToolCalls','Total tool calls',1000,0)}{field('perTurnToolCalls','Tool calls per turn',20,0)}</div></details>
      <p className="allowance-note">{status?.source==='app'?`Scope: ${status.scope.nodeIds.length} saved notes and ${status.scope.artifactIds.length} artifacts. New notes are not automatically included.`:'The allowance covers this project’s current saved notes and artifacts.'} Used amounts stay reserved after edits, failures and restarts.</p>
      {status?.source==='app'&&<label className="connection-consent"><input type="checkbox" checked={refreshScope} onChange={event=>{setRefreshScope(event.target.checked);setConsent(false);}}/>Include the current saved notes and artifacts when saving.</label>}
      <label className="connection-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>Allow Codex turns for this saved project context within these total limits.</label>
      <div className="connection-actions"><button className="primary small" type="submit" disabled={busy||!status||!consent}><ShieldCheck size={13}/>{busy?'Saving…':status?.source==='app'?'Save allowance':'Enable usage'}</button>{status?.enabled&&<button type="button" className="secondary small" disabled={busy} onClick={()=>void run(()=>post(`/api/projects/${projectId}/agents/codex/allowance/pause`,{}),'Codex usage paused. Existing reservations remain.')}><Pause size={12}/>Pause usage</button>}</div>
    </form>{notice&&<p className="connection-check" role="status">{notice}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}
  </section>;
}
