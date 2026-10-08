import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, Plug, RefreshCw } from 'lucide-react';
import type { CredentialProvider, CredentialStatus } from '../shared/tool-connections';
import type { GoogleDriveStatus } from '../shared/google-drive';
import type { ConnectionBudgetStatus } from '../shared/connection-budgets';
import { PLUGINS, type PluginDefinition, type PluginStatus, type TokenPluginId } from '../shared/plugins';
import { ConnectionCard, ConnectionSymbol, GoogleDriveConnectionCard, KeyConnection, message } from './ModelPage';
import { api, post } from './api';

const marks:Record<string,{text:string;color:string}>={ 'google-docs':{text:'D',color:'#4285f4'}, zotero:{text:'Z',color:'#cc2936'}, slack:{text:'#',color:'#611f69'}, notion:{text:'N',color:'#191919'}, github:{text:'GH',color:'#24292f'}, tavily:{text:'T',color:'#2f6fdb'}, overleaf:{text:'O',color:'#138a36'} };
function PluginMark({id}:{id:string}) {
  if(id==='google-drive')return <ConnectionSymbol name="drive"/>;
  const mark=marks[id]??{text:'?',color:'#555'};
  return <span className="plugin-mark" style={{background:mark.color}} aria-hidden="true">{mark.text}</span>;
}

/** Tools outside ros.ai, each connected with something the person already has. Using them from the canvas comes later. */
export function PluginsPage({projectId,publicDemo,onChanged,onResources,onBudget}:{projectId:string|null;publicDemo:boolean;onChanged:()=>Promise<unknown>;onResources:()=>void;onBudget:()=>void}) {
  const [plugins,setPlugins]=useState<PluginStatus[]>([]),[google,setGoogle]=useState<GoogleDriveStatus|null>(null),[credentials,setCredentials]=useState<CredentialStatus[]>([]),[budgets,setBudgets]=useState<ConnectionBudgetStatus[]>([]);
  const [loading,setLoading]=useState(false),[errors,setErrors]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
  const refresh=useCallback(async()=>{
    if(publicDemo)return;
    setLoading(true);
    const [tokens,drive,keys,limits]=await Promise.allSettled([api<{plugins:PluginStatus[]}>('/api/plugins'),api<GoogleDriveStatus>('/api/connections/google-drive'),api<{credentials:CredentialStatus[]}>('/api/connections/credentials'),api<{budgets:ConnectionBudgetStatus[]}>('/api/connections/budgets')]);
    const failures:Record<string,string>={};
    if(tokens.status==='fulfilled')setPlugins(tokens.value.plugins);else failures.plugins=message(tokens.reason);
    if(drive.status==='fulfilled')setGoogle(drive.value);else failures.google=message(drive.reason);
    if(keys.status==='fulfilled')setCredentials(keys.value.credentials);else failures.keys=message(keys.reason);
    if(limits.status==='fulfilled')setBudgets(limits.value.budgets);
    setErrors(failures);setLoading(false);
  },[publicDemo]);
  useEffect(()=>{void refresh();},[refresh]);
  const changed=async()=>{await refresh();await onChanged();};
  if(publicDemo)return <p className="rail-page-note">This demo cannot connect your tools. Launch the local workspace to connect them.</p>;
  const card=(plugin:PluginDefinition)=>{
    if(plugin.id==='google-drive')return <GoogleDriveConnectionCard key={plugin.id} projectId={projectId} status={google} loadError={errors.google} onChanged={changed} onImported={async()=>{setNotice('CSV copied into this project. Open Resources to inspect or use it.');await onChanged();}} onResources={onResources}/>;
    if(plugin.id==='google-docs')return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} connected={google?.connected} status={!google?'Checking…':google.connected?'Connected':'Needs Google Drive'}><p>Google Docs live in your Drive, so they use the same read-only Google sign-in. {google?.connected?'Your Docs are readable through it.':'Connect Google Drive above to reach your Docs.'} ros.ai cannot edit or share them.</p></ConnectionCard>;
    if(plugin.id==='tavily')return <KeyConnection key={plugin.id} provider={'tavily' as CredentialProvider} label={plugin.name} icon={<PluginMark id={plugin.id}/>} credential={credentials.find(item=>item.provider==='tavily')} budget={budgets.find(item=>item.provider==='tavily')} onBudget={onBudget} description="Web search for research you start. Each search spends Tavily credits within the allowance you set in Budget." keyLink="https://app.tavily.com/" loadError={errors.keys} onSave={async(_provider,key)=>{await api('/api/connections/credentials/tavily',{method:'PUT',body:JSON.stringify({apiKey:key})});setNotice('Tavily key saved on this computer.');await changed();}} onDisconnect={async()=>{await api('/api/connections/credentials/tavily',{method:'DELETE'});await changed();}}/>;
    if(plugin.connect==='unavailable')return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} status="Not available yet"><p>{plugin.unavailableReason}</p></ConnectionCard>;
    return <TokenPlugin key={plugin.id} plugin={plugin} status={plugins.find(item=>item.id===plugin.id)} onChanged={changed}/>;
  };
  return <div className="connections-page plugins-page">
    <div className="connections-intro"><p>Tools outside ros.ai. Each connects with a key, token or sign-in you already have, and stays on this computer. Using them from the canvas and assistant comes next.</p><button className="icon-button" disabled={loading} aria-label="Refresh plugin status" onClick={()=>void refresh()}><RefreshCw size={15} className={loading?'spin':''}/></button></div>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {errors.plugins&&<p className="inline-error" role="alert">{errors.plugins}</p>}
    {PLUGINS.filter(plugin=>plugin.connect!=='unavailable').map(card)}
    <h3 className="rail-section-title">Not available yet</h3>
    {PLUGINS.filter(plugin=>plugin.connect==='unavailable').map(card)}
  </div>;
}

function TokenPlugin({plugin,status,onChanged}:{plugin:PluginDefinition;status?:PluginStatus;onChanged:()=>Promise<void>}) {
  const [open,setOpen]=useState(false),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const id=plugin.id as TokenPluginId;
  const run=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await onChanged();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const configured=status?.configured??false;
  return <ConnectionCard label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} connected={configured&&status?.verified!==false} status={!status?'Checking…':status.verified===false?'Check failed':configured?'Connected':'Not connected'}>
    {status?.checkMessage&&<p className={status.verified?'connection-check':'inline-error'} role="status">{status.checkMessage}</p>}
    <div className="connection-actions"><button className="secondary small" disabled={busy||!status} aria-expanded={open} onClick={()=>{setOpen(!open);setToken('');setError('');}}>{open?'Close setup':configured?'Replace token':'Connect'}</button>{configured&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>post(`/api/plugins/${id}/check`,{}))}>{busy?'Checking…':'Check'}</button>}{configured&&<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>api(`/api/plugins/${id}`,{method:'DELETE'}))}>Disconnect</button>}</div>
    {open&&<div className="connection-setup"><p>{plugin.tokenHint} {plugin.tokenLink&&<a href={plugin.tokenLink} target="_blank" rel="noreferrer">Open {plugin.name}<ExternalLink size={11}/></a>}</p>
      <form onSubmit={event=>{event.preventDefault();if(busy)return;void run(async()=>{await api(`/api/plugins/${id}`,{method:'PUT',body:JSON.stringify({token})});setToken('');setOpen(false);});}}><label className="field-label" htmlFor={`plugin-token-${id}`}>{plugin.tokenLabel}</label><input id={`plugin-token-${id}`} type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} placeholder="Paste it here" required minLength={8} maxLength={4096}/><button className="primary small" type="submit" disabled={busy||token.trim().length<8}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Save</button></form>
      <p className="subtle">Saved privately on this computer. Check makes one read-only request to confirm the token.</p></div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </ConnectionCard>;
}
