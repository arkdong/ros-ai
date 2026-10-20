import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronRight, ExternalLink, LoaderCircle, MoreHorizontal, Plug, Plus, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CredentialProvider, CredentialStatus } from '../shared/tool-connections';
import type { GoogleDriveStatus } from '../shared/google-drive';
import type { ConnectionBudgetStatus } from '../shared/connection-budgets';
import { PLUGINS, type AppConnectionStatus, type PluginDefinition, type PluginId, type PluginStatus, type TokenPluginId } from '../shared/plugins';
import { ConnectionCard, GoogleDriveConnectionCard, KeyConnection, message } from './ModelPage';
import { BrandLogo, hasBrandLogo } from './brand-logos';
import { api, post } from './api';
import './plugins.css';

function PluginMark({id,size}:{id:string;size?:number}) {
  return hasBrandLogo(id)?<BrandLogo id={id} size={size}/>:<Plug size={size||18}/>;
}

/** Tools outside ros.ai, each connected with something the person already has. Using them from the canvas comes later. */
type PluginState = { label: string; connected: boolean };

/** One row of a catalogue: logo, name, one line, a status when connected, and + or ··· . Shared by Plugins and Agents. */
export function CatalogueRow({mark,name,summary,state,unavailable,onClick}:{mark:ReactNode;name:string;summary:string;state?:PluginState;unavailable?:boolean;onClick:()=>void}) {
  return <button type="button" className="plugin-row" onClick={onClick}><span className="plugin-row-mark">{mark}</span><span className="plugin-row-text"><strong>{name}</strong><small>{summary}</small></span>{state?.connected&&<span className="plugin-row-state"><i/>{state.label}</span>}<span className="plugin-row-action">{unavailable?<small>Not yet</small>:state?.connected?<MoreHorizontal size={16}/>:<Plus size={16}/>}</span></button>;
}
/** The page's sections and installed list in the sidebar, like Codex's left column. */
export function CatalogueSidebar({sections,installed,selected,onSelect,note}:{sections:{id:string;label:string;later?:boolean}[];installed:{id:string;name:string;mark:ReactNode}[];selected:string|null;onSelect:(id:string|null)=>void;note:string}) {
  return <div className="plugins-sidebar">
    {sections.map(section=>section.later?<button key={section.id} type="button" className="plugins-nav" disabled title={`${section.label} come in a later round`}>{section.label}<span className="plugins-later">later</span></button>:<button key={section.id} type="button" className={`plugins-nav ${selected?'':'active'}`} onClick={()=>onSelect(null)}>{section.label}</button>)}
    <div className="sidebar-label plugins-installed-label">Installed</div>
    {installed.length?installed.map(item=><button key={item.id} type="button" className={`plugins-nav plugins-installed ${selected===item.id?'active':''}`} onClick={()=>onSelect(item.id)}>{item.mark}<span className="plugins-name">{item.name}</span><i className="plugins-dot" aria-hidden="true"/></button>):<p className="sidebar-empty">Nothing connected yet</p>}
    <p className="plugins-sidebar-note">{note}</p>
  </div>;
}
/** Breadcrumb and hero of one item's page. */
export function CatalogueHero({crumb,onBack,mark,name,summary,state,uses}:{crumb:string;onBack:()=>void;mark:ReactNode;name:string;summary:string;state?:PluginState;uses?:string[]}) {
  return <>
    <nav className="plugin-crumbs" aria-label="Breadcrumb"><button type="button" className="text-button" onClick={onBack}>{crumb}</button><ChevronRight size={13}/><span>{name}</span></nav>
    <header className="plugin-hero"><span className="plugin-hero-mark">{mark}</span><div><h1>{name}</h1><p>{summary}</p></div>{state&&<span className={`plugin-row-state ${state.connected?'':'off'}`}><i/>{state.label}</span>}</header>
    {uses&&<ul className="plugin-uses">{uses.map(use=><li key={use}>{use}</li>)}</ul>}
  </>;
}
const groups: { title: string; ids: PluginId[] }[] = [
  { title: 'Sources', ids: ['google-drive', 'google-docs', 'zotero', 'tavily'] },
  { title: 'Team', ids: ['notion', 'slack', 'github'] },
  { title: 'Not available yet', ids: ['overleaf'] },
];

export function PluginsSidebar({installed,selected,onSelect}:{installed:PluginId[];selected:PluginId|null;onSelect:(id:PluginId|null)=>void}) {
  return <CatalogueSidebar sections={[{id:'plugins',label:'Plugins'},{id:'skills',label:'Skills',later:true}]} installed={installed.map(id=>({id,name:PLUGINS.find(item=>item.id===id)!.name,mark:<PluginMark id={id} size={16}/>}))} selected={selected} onSelect={id=>onSelect(id as PluginId|null)} note="Connected on this computer. Click one to manage it."/>;
}

export function PluginsPage({projectId,publicDemo,selected,onSelect,onInstalled,onChanged,onResources}:{projectId:string|null;publicDemo:boolean;selected:PluginId|null;onSelect:(id:PluginId|null)=>void;onInstalled:(ids:PluginId[])=>void;onChanged:()=>Promise<unknown>;onResources:()=>void}) {
  const [plugins,setPlugins]=useState<PluginStatus[]>([]),[apps,setApps]=useState<AppConnectionStatus[]>([]),[google,setGoogle]=useState<GoogleDriveStatus|null>(null),[credentials,setCredentials]=useState<CredentialStatus[]>([]),[budgets,setBudgets]=useState<ConnectionBudgetStatus[]>([]);
  const [loading,setLoading]=useState(false),[errors,setErrors]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
  const refresh=useCallback(async()=>{
    if(publicDemo)return;
    setLoading(true);
    const [tokens,drive,keys,limits,signIns]=await Promise.allSettled([api<{plugins:PluginStatus[]}>('/api/plugins'),api<GoogleDriveStatus>('/api/connections/google-drive'),api<{credentials:CredentialStatus[]}>('/api/connections/credentials'),api<{budgets:ConnectionBudgetStatus[]}>('/api/connections/budgets'),api<{apps:AppConnectionStatus[]}>('/api/apps')]);
    const failures:Record<string,string>={};
    if(tokens.status==='fulfilled')setPlugins(tokens.value.plugins);else failures.plugins=message(tokens.reason);
    if(drive.status==='fulfilled')setGoogle(drive.value);else failures.google=message(drive.reason);
    if(keys.status==='fulfilled')setCredentials(keys.value.credentials);else failures.keys=message(keys.reason);
    if(limits.status==='fulfilled')setBudgets(limits.value.budgets);
    if(signIns.status==='fulfilled')setApps(signIns.value.apps);
    setErrors(failures);setLoading(false);
  },[publicDemo]);
  useEffect(()=>{void refresh();},[refresh]);
  const changed=async()=>{await refresh();await onChanged();};
  const stateOf=(plugin:PluginDefinition):PluginState=>{
    if(plugin.connect==='unavailable')return {label:'Not yet',connected:false};
    if(plugin.id==='google-drive')return google?.connected?{label:'Connected',connected:true}:{label:'Not connected',connected:false};
    if(plugin.id==='google-docs')return google?.connected?{label:'Through Google Drive',connected:true}:{label:'Needs Google Drive',connected:false};
    if(plugin.id==='tavily'){const key=credentials.find(item=>item.provider==='tavily');return key?.configured?{label:'Key saved',connected:true}:{label:'Not connected',connected:false};}
    const token=plugins.find(item=>item.id===plugin.id),app=apps.find(item=>item.id===plugin.id);
    if(app?.connected)return {label:'Connected',connected:true};
    if(token?.configured)return token.verified===false?{label:'Check failed',connected:false}:{label:'Token saved',connected:true};
    return {label:'Not connected',connected:false};
  };
  const installed=PLUGINS.filter(plugin=>stateOf(plugin).connected).map(plugin=>plugin.id);
  const installedKey=installed.join(',');
  useEffect(()=>{onInstalled(installedKey?installedKey.split(',') as PluginId[]:[]);},[installedKey,onInstalled]);
  if(publicDemo)return <p className="rail-page-note">This demo cannot connect your tools. Launch the local workspace to connect them.</p>;
  const card=(plugin:PluginDefinition)=>{
    if(plugin.id==='google-drive')return <GoogleDriveConnectionCard key={plugin.id} projectId={projectId} status={google} loadError={errors.google} onChanged={changed} onImported={async()=>{setNotice('CSV copied into this project. Open Resources to inspect or use it.');await onChanged();}} onResources={onResources}/>;
    if(plugin.id==='google-docs')return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} connected={google?.connected} status={!google?'Checking…':google.connected?'Connected':'Needs Google Drive'}><p>Google Docs live in your Drive, so they use the same read-only Google sign-in. {google?.connected?'Your Docs are readable through it.':'Connect Google Drive above to reach your Docs.'} ros.ai cannot edit or share them.</p></ConnectionCard>;
    if(plugin.id==='tavily')return <KeyConnection key={plugin.id} provider={'tavily' as CredentialProvider} label={plugin.name} icon={<PluginMark id={plugin.id}/>} credential={credentials.find(item=>item.provider==='tavily')} budget={budgets.find(item=>item.provider==='tavily')} description="Web search for research you start. Each search spends Tavily credits; spend shows in Settings › Usage." keyLink="https://app.tavily.com/" loadError={errors.keys} onSave={async(_provider,key)=>{await api('/api/connections/credentials/tavily',{method:'PUT',body:JSON.stringify({apiKey:key})});setNotice('Tavily key saved on this computer.');await changed();}} onDisconnect={async()=>{await api('/api/connections/credentials/tavily',{method:'DELETE'});await changed();}}/>;
    if(plugin.connect==='unavailable')return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} status="Not available yet"><p>{plugin.unavailableReason}</p></ConnectionCard>;
    return <TokenPlugin key={plugin.id} open={plugin.id===selected} plugin={plugin} status={plugins.find(item=>item.id===plugin.id)} app={plugin.signIn?apps.find(item=>item.id===plugin.id):undefined} onChanged={changed}/>;
  };
  const current=selected?PLUGINS.find(plugin=>plugin.id===selected):undefined;
  const row=(plugin:PluginDefinition)=><CatalogueRow key={plugin.id} mark={<PluginMark id={plugin.id} size={22}/>} name={plugin.name} summary={plugin.summary} state={stateOf(plugin)} unavailable={plugin.connect==='unavailable'} onClick={()=>onSelect(plugin.id)}/>;
  if(current){return <div className="plugins-page plugin-detail">
    <CatalogueHero crumb="Plugins" onBack={()=>onSelect(null)} mark={<PluginMark id={current.id} size={34}/>} name={current.name} summary={current.summary} state={stateOf(current)} uses={current.uses}/>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {errors.plugins&&<p className="inline-error" role="alert">{errors.plugins}</p>}
    <h2 className="plugin-section">Connection</h2>
    {card(current)}
    <h2 className="plugin-section">Skills <small>later</small></h2>
    <p className="plugin-later">Ways of working with {current.name} that agents follow, switchable one by one. They come with the Skills page.</p>
  </div>;}
  return <div className="plugins-page">
    <header className="plugins-head"><div><h1>Plugins</h1><p>Connect plugins so your agents work across your tools</p></div><button className="icon-button" disabled={loading} aria-label="Refresh plugin status" onClick={()=>void refresh()}><RefreshCw size={15} className={loading?'spin':''}/></button></header>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {errors.plugins&&<p className="inline-error" role="alert">{errors.plugins}</p>}
    {groups.map(group=><section key={group.title} className="plugin-group"><h2>{group.title}</h2><div className="plugin-grid">{group.ids.map(id=>row(PLUGINS.find(plugin=>plugin.id===id)!))}</div></section>)}
    <p className="plugins-footnote">Each plugin connects with a sign-in, key or token you already have and stays on this computer. Agents read through it and change things only after you accept.</p>
  </div>;
}

function TokenPlugin({plugin,status,app,open:forceOpen,onChanged}:{plugin:PluginDefinition;status?:PluginStatus;app?:AppConnectionStatus;open?:boolean;onChanged:()=>Promise<void>}) {
  const [open,setOpen]=useState(false),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const id=plugin.id as TokenPluginId;
  const run=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await onChanged();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const configured=status?.configured??false,signedIn=app?.connected??false;
  // Sign in at the app's own server; it sends the browser back to ros.ai when the person has approved.
  const signIn=()=>void run(async()=>{const started=await post<{authorizationUrl?:string}>(`/api/apps/${id}/connect`,{});if(started.authorizationUrl)window.location.assign(started.authorizationUrl);});
  const tokenButton=<button className={plugin.signIn?'text-button':'secondary small'} disabled={busy||!status} aria-expanded={open} onClick={()=>{setOpen(!open);setToken('');setError('');}}>{open?'Close setup':configured?'Replace token':plugin.signIn?'Use a token instead':'Connect'}</button>;
  return <ConnectionCard label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} forceOpen={forceOpen} connected={signedIn||(configured&&status?.verified!==false)} status={!status?'Checking…':signedIn?'Connected':status.verified===false?'Check failed':configured?'Connected with a token':'Not connected'}>
    {signedIn&&<p className="connection-check" role="status">Signed in to {plugin.name}{app?.account?` as ${app.account}`:''}. Agents use {plugin.name}’s own tools and ask you before changing anything there.</p>}
    {status?.checkMessage&&<p className={status.verified?'connection-check':'inline-error'} role="status">{status.checkMessage}</p>}
    <div className="connection-actions">
      {plugin.signIn&&!signedIn&&<button className="primary small" disabled={busy} onClick={signIn}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Connect</button>}
      {plugin.signIn&&signedIn&&<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>api(`/api/apps/${id}`,{method:'DELETE'}))}>Disconnect</button>}
      {(!plugin.signIn||!signedIn||configured)&&tokenButton}
      {configured&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>post(`/api/plugins/${id}/check`,{}))}>{busy?'Checking…':'Check'}</button>}{configured&&<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>api(`/api/plugins/${id}`,{method:'DELETE'}))}>{plugin.signIn?'Remove token':'Disconnect'}</button>}
    </div>
    {open&&<div className="connection-setup"><p>{plugin.tokenHint} {plugin.tokenLink&&<a href={plugin.tokenLink} target="_blank" rel="noreferrer">Open {plugin.name}<ExternalLink size={11}/></a>}</p>
      <form onSubmit={event=>{event.preventDefault();if(busy)return;void run(async()=>{await api(`/api/plugins/${id}`,{method:'PUT',body:JSON.stringify({token})});setToken('');setOpen(false);});}}><label className="field-label" htmlFor={`plugin-token-${id}`}>{plugin.tokenLabel}</label><input id={`plugin-token-${id}`} type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} placeholder="Paste it here" required minLength={8} maxLength={4096}/><button className="primary small" type="submit" disabled={busy||token.trim().length<8}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Save</button></form>
      <p className="subtle">Saved privately on this computer. Check makes one read-only request to confirm the token.</p></div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </ConnectionCard>;
}
