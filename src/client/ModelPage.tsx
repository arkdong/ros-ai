import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ExternalLink, LoaderCircle, Plug, RefreshCw, Terminal } from 'lucide-react';
import type { ConnectionStatus } from '../shared/types';
import type { CredentialProvider, CredentialStatus } from '../shared/tool-connections';
import type { LocalAgentSetup, CodexLoginStatus } from '../shared/local-agent-setup';
import type { GoogleDriveStatus, GoogleDriveFiles } from '../shared/google-drive';
import type { ConnectionBudgetStatus } from '../shared/connection-budgets';
import type { ClaudeAgentSettings, ClaudeModel } from '../shared/claude-agent';
import { InferenceConnections } from './InferenceConnections';
import { api, post } from './api';
import './connections.css';

type Props = { projectId:string|null; connections:ConnectionStatus[]; publicDemo:boolean; onChanged:()=>Promise<unknown>; onBudget:()=>void };
/** Model holds only AI model connections. Their spending allowances live on the Budget page. */
export function ModelPage({projectId,connections,publicDemo,onChanged,onBudget}:Props) {
  const [credentials,setCredentials]=useState<CredentialStatus[]>([]),[codex,setCodex]=useState<LocalAgentSetup>(),[claude,setClaude]=useState<ClaudeAgentSettings>();
  const [loading,setLoading]=useState(false),[errors,setErrors]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
  const [budgets,setBudgets]=useState<ConnectionBudgetStatus[]>([]);
  const refresh=useCallback(async()=>{
    if(publicDemo)return;
    setLoading(true);
    const paths=['/api/connections/credentials',projectId?`/api/projects/${projectId}/agents/setup/codex`:null,'/api/agents/claude','/api/connections/budgets'];
    const values=await Promise.allSettled(paths.map(path=>!path?Promise.resolve(null):path.includes('/agents/setup/')?post<unknown>(path):api<unknown>(path)));
    const failures:Record<string,string>={};
    values.forEach((result,index)=>{const id=['credentials','codex','claude','budgets'][index]!;if(result.status==='rejected'){failures[id]=result.reason instanceof Error?result.reason.message:String(result.reason);return;}if(index===0)setCredentials((result.value as {credentials:CredentialStatus[]}).credentials);if(index===1&&result.value)setCodex(result.value as LocalAgentSetup);if(index===2)setClaude(result.value as ClaudeAgentSettings);if(index===3)setBudgets((result.value as {budgets:ConnectionBudgetStatus[]}).budgets);});
    setErrors(failures);setLoading(false);
  },[projectId,publicDemo]);
  useEffect(()=>{void refresh();},[refresh]);
  const changed=async()=>{await refresh();await onChanged();};
  const saved=async(provider:CredentialProvider,key:string)=>{await api(`/api/connections/credentials/${provider}`,{method:'PUT',body:JSON.stringify({apiKey:key})});setNotice('Key saved on this computer. Set or check its allowance in Budget.');await changed();};
  const disconnected=async(provider:CredentialProvider)=>{await api(`/api/connections/credentials/${provider}`,{method:'DELETE'});setNotice('Locally saved key removed. Any environment configuration remains active.');await changed();};
  if(publicDemo)return <p className="rail-page-note">This demo cannot connect models. Launch the local workspace to connect your own.</p>;
  return <div className="connections-page">
    <div className="connections-intro"><p>The AI models ros.ai can use, on this computer. Choose which one the assistant uses in its settings.</p><button className="icon-button" disabled={loading} aria-label="Refresh model status" title="Refresh status; no model turn" onClick={()=>void refresh()}><RefreshCw size={15} className={loading?'spin':''}/></button></div>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {(errors.credentials||errors.budgets)&&<p className="inline-error" role="alert">{errors.credentials||errors.budgets}</p>}
    <h3 className="rail-section-title">Model providers</h3>
    <KeyConnection provider="nebius" label="Nebius Token Factory" icon={<ConnectionSymbol name="nebius"/>} credential={credentials.find(item=>item.provider==='nebius')} usage={connections.find(item=>item.provider==='nebius')} budget={budgets.find(item=>item.provider==='nebius')} onBudget={onBudget} description="Open models through your Token Factory API key." keyLink="https://tokenfactory.nebius.com/" onSave={saved} onDisconnect={disconnected} onCheck={async()=>{await post('/api/connections/nebius/check');await refresh();}}/>
    <KeyConnection provider="claude" label="Claude Code" icon={<ConnectionSymbol name="claude"/>} credential={credentials.find(item=>item.provider==='claude')} budget={budgets.find(item=>item.provider==='claude')} onBudget={onBudget} description="Claude Code as the project assistant, billed to your Anthropic API key. Choose Claude Code in the assistant's settings to use it." keyLink="https://platform.claude.com/settings/keys" loadError={errors.claude} onSave={saved} onDisconnect={disconnected} onCheck={async()=>{await post('/api/connections/claude/check');await refresh();}}>{claude&&<ClaudeModelChoice settings={claude} onChanged={setClaude}/>}</KeyConnection>
    <CodexConnection projectId={projectId} setup={codex} error={errors.codex} onChanged={changed} onBudget={onBudget}/>
    <KeyConnection provider="openai" label="OpenAI API" icon={<Plug size={18}/>} credential={credentials.find(item=>item.provider==='openai')} usage={connections.find(item=>item.provider==='openai')} budget={budgets.find(item=>item.provider==='openai')} onBudget={onBudget} description="Direct model API access, separate from Codex sign-in." keyLink="https://platform.openai.com/api-keys" onSave={saved} onDisconnect={disconnected}/>
    <h3 className="rail-section-title">Local models and other servers</h3>
    <InferenceConnections onChanged={changed} onBudget={onBudget}/>
    <p className="connections-footnote">Keys stay on the local server. Connect a model here, then set what it may spend in Budget.</p>
  </div>;
}

function ClaudeModelChoice({settings,onChanged}:{settings:ClaudeAgentSettings;onChanged:(value:ClaudeAgentSettings)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const choose=async(model:ClaudeModel)=>{setBusy(true);setError('');try{onChanged(await api<ClaudeAgentSettings>('/api/agents/claude',{method:'PUT',body:JSON.stringify({model})}));}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  return <div className="claude-model-choice"><label className="field-label" htmlFor="claude-model">Model</label><select id="claude-model" value={settings.model} disabled={busy} onChange={event=>void choose(event.target.value as ClaudeModel)}>{settings.models.map(item=><option key={item.id} value={item.id}>{item.label} · {item.detail}</option>)}</select>
    <p className="subtle">Each turn may use up to US${settings.turnUsd.toFixed(2)} of the allowance below, then counts what Claude Code reports it cost. It reads this project's folder and proposes changes; code runs in ros.ai's sandbox under your permission choice. A Claude subscription login is not used.</p>{error&&<p className="inline-error" role="alert">{error}</p>}</div>;
}

export function ConnectionSymbol({name}:{name:'nebius'|'claude'|'drive'}) {
  if(name==='nebius')return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 18V6h4l6 12h4V6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round"/></svg>;
  if(name==='claude')return <svg aria-hidden="true" viewBox="0 0 24 24" className="claude-symbol">{Array.from({length:8},(_,i)=><path key={i} d="M12 3v6" transform={`rotate(${i*45} 12 12)`} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>)}</svg>;
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path fill="#2684fc" d="M4 17h16l-3 5H1z"/><path fill="#ffba00" d="M9 2h6l9 15h-6z"/><path fill="#00ac47" d="M9 2L0 17l3 5L12 7z"/></svg>;
}
export function ConnectionCard({label,icon,status,subtitle,connected,forceOpen,children}:{label:string;icon:ReactNode;status:string;subtitle?:string;connected?:boolean;forceOpen?:boolean;children:ReactNode}) {
  const [expanded,setExpanded]=useState(false);
  useEffect(()=>{if(forceOpen)setExpanded(true);},[forceOpen]);
  return <section className="tool-connection" aria-label={`${label} connection`}><details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary className="tool-connection-heading"><span className="tool-connection-icon">{icon}</span><span className="tool-connection-name"><strong>{label}</strong>{subtitle&&<small>{subtitle}</small>}</span><span className={`connection-state ${connected?'connected':''}`}><i/>{status}</span><ChevronDown size={14} className="connection-chevron"/></summary><div className="tool-connection-body">{children}</div></details></section>;
}
export function KeyConnection({provider,label,icon,credential,budget,onBudget,description,keyLink,loadError,onSave,onDisconnect,onCheck,children}:{provider:CredentialProvider;label:string;icon:ReactNode;credential?:CredentialStatus;usage?:ConnectionStatus;budget?:ConnectionBudgetStatus;onBudget:()=>void;description:string;keyLink:string;loadError?:string;children?:ReactNode;onSave:(provider:CredentialProvider,key:string)=>Promise<void>;onDisconnect:(provider:CredentialProvider)=>Promise<void>;onCheck?:()=>Promise<void>}) {
  const [open,setOpen]=useState(false),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const configured=credential?.configured??false;
  const ready=budget?.ready??false;
  const subtitle=!budget?'Checking allowance…':budget.source==='app'?`US$${budget.limitUsd.toFixed(2)} budget · ${!budget.enabled?'paused':ready?'enabled':'limit reached'}`:ready?'Usage enabled':'Usage not enabled';
  return <ConnectionCard label={label} icon={icon} subtitle={subtitle} connected={configured&&credential?.verified!==false} status={!credential?'Checking…':credential.verified===false?'Check failed':configured?'Key configured':'Not connected'}>
    <p>{description}</p>
    {children}
    {credential?.checkMessage&&<p className={credential.verified?'connection-check':'inline-error'} role="status">{credential.checkMessage}</p>}
    <div className="connection-actions"><button className="secondary small" disabled={busy||!credential} aria-expanded={open} onClick={()=>{setOpen(!open);setKey('');setError('');}}>{open?'Close setup':configured?'Manage key':'Connect'}</button>{onCheck&&configured&&<button className="text-button" disabled={busy} onClick={()=>void run(onCheck)}>{busy?'Checking…':'Check key'}</button>}</div>
    {open&&<div className="connection-setup"><p>Paste a key from <a href={keyLink} target="_blank" rel="noreferrer">{label}<ExternalLink size={11}/></a>. It is saved privately on the local server.</p>{credential?.source==='environment'&&<p className="subtle">A key is already set in the server environment. A saved key will override it; removing the saved key restores that setting.</p>}
      <form onSubmit={event=>{event.preventDefault();if(busy)return;void run(async()=>{await onSave(provider,key);setKey('');setOpen(false);});}}><label className="field-label" htmlFor={`connection-key-${provider}`}>API key</label><input id={`connection-key-${provider}`} type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder="Paste your API key" required minLength={12} maxLength={4096}/><button className="primary small" type="submit" disabled={busy||key.trim().length<12}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Save connection</button></form>
      {credential?.canDisconnect&&<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>onDisconnect(provider))}>Remove saved key</button>}

    </div>}
    {configured&&budget&&!ready&&<p className="connection-limit">{budget.reason||'Usage is not enabled yet.'} <button className="text-button" onClick={onBudget}>Set its allowance in Budget</button></p>}
    {(error||loadError)&&<p className="inline-error" role="alert">{error||loadError}</p>}
  </ConnectionCard>;
}

function CodexConnection({projectId,setup,error:loadError,onChanged,onBudget}:{projectId:string|null;setup?:LocalAgentSetup;error?:string;onChanged:()=>Promise<void>;onBudget:()=>void}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[login,setLogin]=useState<CodexLoginStatus|null>(null);
  useEffect(()=>{if(!projectId)return;let current=true;void api<CodexLoginStatus|null>(`/api/projects/${projectId}/agents/codex/login`).then(value=>{if(current){setLogin(value);if(value)setOpen(true);}}).catch(cause=>{if(current)setError(message(cause));});return()=>{current=false;};},[projectId]);
  useEffect(()=>{
    if(login?.state!=='waiting')return;
    let disposed=false,active=false;
    const timer=window.setInterval(()=>{if(active)return;active=true;void api<CodexLoginStatus>(`/api/projects/${projectId}/agents/codex/login/${login.id}`).then(async status=>{if(disposed)return;setLogin(status);if(status.state==='completed')await onChanged();}).catch(cause=>{if(!disposed)setError(message(cause));}).finally(()=>{active=false;});},3000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[login?.id,login?.state,projectId]);
  const start=async(method:'browser'|'device')=>{setBusy(true);setError('');try{setLogin(await post<CodexLoginStatus>(`/api/projects/${projectId}/agents/codex/login`,{method}));}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const limitation=!projectId?'Open a project to check Codex sign-in and its research permissions.':setup?.available?'Ready within the configured project permissions.':setup?.signedIn?`Sign-in detected. Research turns ${!setup.isolationReady&&!setup.authorized?'need workspace isolation and a bounded usage grant.':!setup.isolationReady?'need workspace isolation.':!setup.authorized?'need a bounded usage grant.':'are currently unavailable; see setup details.'}`:'Uses Codex’s own sign-in on this computer.';
  return <ConnectionCard label="Codex" icon={<Terminal size={20}/>} subtitle={setup?.available?'Research available':'Research blocked'} forceOpen={login?.state==='waiting'} connected={setup?.signedIn} status={!projectId?'Choose a project':!setup?'Checking…':setup.signedIn?'Signed in':'Not connected'}>
    <p>{limitation}</p><div className="connection-actions"><button className="secondary small" disabled={!projectId} aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'Close setup':setup?.signedIn?'Connection details':'Connect'}</button></div>
    {open&&<div className="connection-setup"><p>{setup?.installed?`Installed: ${setup.version}.`:'Install Codex CLI, then refresh connection status.'} Sign-in is handled by Codex. ros.ai never copies its account credentials.</p>
      {setup?.installed&&!setup.signedIn&&login?.state!=='waiting'&&<div className="connection-actions"><button className="primary small" disabled={busy} onClick={()=>void start('browser')}>Sign in with Codex</button><button className="secondary small" disabled={busy} onClick={()=>void start('device')}>Use device code</button></div>}
      {login&&<div className="connection-login" role="status"><p>{login.message}</p>{login.state==='waiting'&&<>{login.authUrl&&<a className="primary small" href={login.authUrl} target="_blank" rel="noreferrer">Open Codex sign-in <ExternalLink size={12}/></a>}{login.userCode&&<p>Enter code <strong>{login.userCode}</strong> in the Codex sign-in page.</p>}<button className="text-button" onClick={async()=>{try{setLogin(await post<CodexLoginStatus>(`/api/projects/${projectId}/agents/codex/login/${login.id}/cancel`,{}));}catch(cause){setError(message(cause));}}}>Cancel sign-in</button></>}</div>}
      {setup&&<><dl className="connection-facts"><dt>Sign-in</dt><dd>{setup.signedIn?'Detected':'Required'}</dd><dt>Workspace isolation</dt><dd>{setup.isolationReady?'Supported':'Unavailable in installed CLI'}</dd><dt>Usage permission</dt><dd>{setup.authorized?'Bounded grant configured':'No fresh grant'}</dd><dt>Research turns</dt><dd>{setup.available?'Available':'Blocked'}</dd></dl><details><summary>Setup and enforcement details</summary>{setup.blockers.map((blocker,index)=><p key={index}>{blocker}</p>)}{setup.commands.map(item=><div key={item.command}><span>{item.label}</span><pre>{item.command}</pre></div>)}</details>{setup.links.map(link=><a className="connection-doc" key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label}<ExternalLink size={11}/></a>)}</>}
    </div>}{setup?.signedIn&&!setup.authorized&&<p className="connection-limit">Codex needs a usage allowance for this project. <button className="text-button" onClick={onBudget}>Set it in Budget</button></p>}{(error||loadError)&&<p className="inline-error" role="alert">{error||loadError}</p>}
  </ConnectionCard>;
}

export function GoogleDriveConnectionCard({projectId,status,loadError,onChanged,onImported,onResources}:{projectId:string|null;status:GoogleDriveStatus|null;loadError?:string;onChanged:()=>Promise<void>;onImported:()=>Promise<void>;onResources:()=>void}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[consent,setConsent]=useState(false),[query,setQuery]=useState(''),[files,setFiles]=useState<GoogleDriveFiles|null>(null),[imported,setImported]=useState<string[]>([]);
  const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const browse=async(pageToken?:string)=>{const result=await api<GoogleDriveFiles>(`/api/connections/google-drive/files?${new URLSearchParams({query,...(pageToken?{pageToken}:{})})}`);setFiles(result);};
  return <ConnectionCard label="Google Drive" icon={<ConnectionSymbol name="drive"/>} subtitle="Read-only CSV access" connected={status?.connected} status={!status?'Checking…':status.connected?'Connected':status.state==='reconnect-required'?'Reconnect':'Not connected'}>
    <p>Browse CSV files and copy selected versions into this project.</p><div className="connection-actions"><button className="secondary small" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'Close setup':status?.connected?'Browse files':'Connect'}</button>{status?.connected&&<button className="text-button" disabled={!projectId} onClick={onResources}>Resources</button>}</div>
    {open&&<div className="connection-setup">
      {!status?.configured?<><p>Create a Google OAuth app for your local workspace, enable the Drive API, and register this redirect URI:</p><code className="connection-callback">{status?.callbackUri||'Loading callback…'}</code><GoogleOAuthForm busy={busy} onSave={value=>run(async()=>{await api('/api/connections/google-drive/config',{method:'PUT',body:JSON.stringify(value)});await onChanged();})}/>{status?.setup.documentation.map(link=><a className="connection-doc" href={link.url} target="_blank" rel="noreferrer" key={link.url}>{link.title}<ExternalLink size={11}/></a>)}<p className="subtle">Use a Web application client. While Google’s consent app is in testing, add your own account as a test user.</p></>:
      !status.connected?<><p className="connection-limit">Google consent grants read access to all Drive files. ros.ai lists CSV files and downloads only a file you explicitly select. It cannot write to Drive.</p><label className="connection-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/> Allow Drive read access for this connection</label><button className="primary small" disabled={busy||!consent} onClick={()=>void run(async()=>{const result=await post<{authorizationUrl:string}>('/api/connections/google-drive/connect',{});window.location.assign(result.authorizationUrl);})}>Continue to Google</button><p className="subtle">You choose the account and finish consent in Google. The authorization returns to this local workspace.</p></>:
      <><p className="subtle">Read-only access. Open a project to import selected CSV files. Imports are project copies up to 500 KB; they do not automatically become model inputs.</p><form className="drive-search" onSubmit={event=>{event.preventDefault();void run(()=>browse());}}><label className="field-label" htmlFor="drive-search">Find CSV files</label><div><input id="drive-search" placeholder="Search by filename" value={query} onChange={event=>setQuery(event.target.value)} maxLength={200}/><button className="secondary small" disabled={busy}>Search</button></div></form>{files&&<div className="drive-files">{files.files.length?files.files.map(file=><article key={file.id}><div><strong>{file.name}</strong><small>{file.size===undefined?'Size unknown':`${(file.size/1000).toFixed(1)} KB`}{file.modifiedTime?` · ${new Date(file.modifiedTime).toLocaleDateString()}`:''}</small></div><button className="secondary small" disabled={busy||!projectId||imported.includes(file.id)||!file.canDownload||(file.size??0)>500000} onClick={()=>void run(async()=>{await post(`/api/projects/${projectId}/google-drive/import`,{fileId:file.id,...(file.modifiedTime?{expectedModifiedTime:file.modifiedTime}:{})});setImported(previous=>[...previous,file.id]);await onImported();})}>{imported.includes(file.id)?'Copied':'Import'}</button></article>):<p className="subtle">No matching CSV files.</p>}{files.nextPageToken&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>browse(files.nextPageToken))}>Next page</button>}</div>}<button className="text-button danger" disabled={busy} onClick={()=>void run(async()=>{await post('/api/connections/google-drive/disconnect',{});setFiles(null);setConsent(false);await onChanged();})}>Disconnect locally</button><p className="subtle">To revoke Google’s permission, remove ros.ai from your Google account’s third-party connections.</p></>}
      {status?.configured&&<details><summary>OAuth app settings</summary><p>Register this exact redirect URI in your Google app:</p><code className="connection-callback">{status.callbackUri}</code><p>Replacing these settings disconnects the locally saved Google account.</p><GoogleOAuthForm busy={busy} onSave={value=>run(async()=>{await api('/api/connections/google-drive/config',{method:'PUT',body:JSON.stringify(value)});setFiles(null);setConsent(false);await onChanged();})}/></details>}
    </div>}{(error||loadError||status?.lastError)&&<p className="inline-error" role="alert">{error||loadError||status?.lastError}</p>}
  </ConnectionCard>;
}
function GoogleOAuthForm({busy,onSave}:{busy:boolean;onSave:(value:{clientId:string;clientSecret:string})=>Promise<void>}) {
  const [clientId,setClientId]=useState(''),[clientSecret,setClientSecret]=useState('');
  return <form onSubmit={event=>{event.preventDefault();void onSave({clientId:clientId.trim(),clientSecret:clientSecret.trim()}).then(()=>{setClientId('');setClientSecret('');});}}><label className="field-label" htmlFor="google-client-id">OAuth client ID</label><input id="google-client-id" value={clientId} onChange={event=>setClientId(event.target.value)} autoComplete="off" required maxLength={1000}/><label className="field-label" htmlFor="google-client-secret">OAuth client secret</label><input id="google-client-secret" type="password" autoComplete="off" value={clientSecret} onChange={event=>setClientSecret(event.target.value)} required maxLength={4000}/><button type="submit" className="primary small" disabled={busy||!clientId.trim()||!clientSecret.trim()}>Save OAuth app</button></form>;
}
export function message(cause:unknown) { return cause instanceof Error?cause.message:String(cause); }
