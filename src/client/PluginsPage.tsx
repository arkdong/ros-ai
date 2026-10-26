import { useCallback, useEffect, useState } from 'react';
import { BookText, Check, ChevronRight, ExternalLink, LoaderCircle, MoreHorizontal, Plug, Plus, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CredentialProvider, CredentialStatus } from '../shared/tool-connections';
import type { GoogleDriveStatus } from '../shared/google-drive';
import type { ConnectionBudgetStatus } from '../shared/connection-budgets';
import { PLUGINS, type AppConnectionStatus, type PluginDefinition, type PluginId, type PluginStatus, type TokenPluginId } from '../shared/plugins';
import type { SkillSummary } from '../shared/skills';
import { isSearchProvider, type SearchProviderId, type SearchServiceStatus } from '../shared/search';
import { ConnectionCard, GoogleDriveConnectionCard, KeyConnection, message } from './ModelPage';
import { BrandLogo, hasBrandLogo } from './brand-logos';
import { api, post } from './api';
import './plugins.css';

function PluginMark({id,size}:{id:string;size?:number}) {
  return hasBrandLogo(id)?<BrandLogo id={id} size={size}/>:<Plug size={size||18}/>;
}

/** Tools outside ros.ai, each connected with something the person already has. Using them from the canvas comes later.
 * A row's state shows while connected; shown says it even when off (a skill that is off), with a grey dot. */
type PluginState = { label: string; connected: boolean; shown?: boolean };

/** One row of a catalogue: logo, name, one line, a status when connected, and + or ··· (or its own action). Shared by Plugins, Skills and Agents. */
export function CatalogueRow({mark,name,summary,state,unavailable,action,onClick}:{mark:ReactNode;name:string;summary:string;state?:PluginState;unavailable?:boolean;action?:ReactNode;onClick:()=>void}) {
  return <button type="button" className="plugin-row" onClick={onClick}><span className="plugin-row-mark">{mark}</span><span className="plugin-row-text"><strong>{name}</strong><small>{summary}</small></span>{(state?.connected||state?.shown)&&<span className={`plugin-row-state ${state.connected?'':'off'}`}><i/>{state.label}</span>}<span className="plugin-row-action">{action??(unavailable?<small>Not yet</small>:state?.connected?<MoreHorizontal size={16}/>:<Plus size={16}/>)}</span></button>;
}
type SidebarItem = { id: string; name: string; mark: ReactNode; off?: boolean };
/** The page's sections and its list (what is installed, or the person's skills) in the sidebar, like Codex's left column.
 * section: which section is open when there are several. */
export function CatalogueSidebar({sections,section,onSection,label='Installed',empty='Nothing connected yet',installed,selected,onSelect,note}:{sections:{id:string;label:string;later?:boolean}[];section?:string;onSection?:(id:string)=>void;label?:string;empty?:string;installed:SidebarItem[];selected:string|null;onSelect:(id:string|null)=>void;note:string}) {
  return <div className="plugins-sidebar">
    {sections.map(item=>item.later?<button key={item.id} type="button" className="plugins-nav" disabled title={`${item.label} come in a later round`}>{item.label}<span className="plugins-later">later</span></button>:<button key={item.id} type="button" className={`plugins-nav ${!selected&&(section??item.id)===item.id?'active':''}`} onClick={()=>onSection?onSection(item.id):onSelect(null)}>{item.label}</button>)}
    <div className="sidebar-label plugins-installed-label">{label}</div>
    {installed.length?installed.map(item=><button key={item.id} type="button" className={`plugins-nav plugins-installed ${selected===item.id?'active':''}`} onClick={()=>onSelect(item.id)}>{item.mark}<span className="plugins-name">{item.name}</span>{!item.off&&<i className="plugins-dot" aria-hidden="true"/>}</button>):<p className="sidebar-empty">{empty}</p>}
    <p className="plugins-sidebar-note">{note}</p>
  </div>;
}
/** Breadcrumb and hero of one item's page. action sits at the right of the hero, after the state. */
export function CatalogueHero({crumb,onBack,mark,name,summary,state,uses,action}:{crumb:string;onBack:()=>void;mark:ReactNode;name:string;summary:ReactNode;state?:PluginState;uses?:string[];action?:ReactNode}) {
  return <>
    <nav className="plugin-crumbs" aria-label="Breadcrumb"><button type="button" className="text-button" onClick={onBack}>{crumb}</button><ChevronRight size={13}/><span>{name}</span></nav>
    <header className="plugin-hero"><span className="plugin-hero-mark">{mark}</span><div><h1>{name}</h1><p>{summary}</p></div>{state&&<span className={`plugin-row-state ${state.connected?'':'off'}`}><i/>{state.label}</span>}{action}</header>
    {uses&&<ul className="plugin-uses">{uses.map(use=><li key={use}>{use}</li>)}</ul>}
  </>;
}
const groups: { title: string; ids: PluginId[] }[] = [
  { title: 'Sources', ids: ['google-drive', 'google-sheets', 'google-docs', 'zotero', 'tavily', 'exa', 'brave'] },
  { title: 'Team', ids: ['notion', 'slack', 'linear'] },
  { title: 'Code and design', ids: ['github', 'sentry', 'figma'] },
  { title: 'Not available yet', ids: ['overleaf'] },
];
/** Apps whose own tools come from their sign-in (Notion also has a token) or desktop server, not from a token. */
const viaApp = (plugin: PluginDefinition) => plugin.signIn || plugin.connect === 'sign-in' || plugin.connect === 'desktop';

/** Where each web search service hands out keys, and what its card says. */
const searchKeys: Record<SearchProviderId, { link: string; description: string }> = {
  tavily: { link: 'https://app.tavily.com/', description: 'Web search for research you start. Each search spends Tavily credits; spend shows in Settings › Usage.' },
  exa: { link: 'https://dashboard.exa.ai/api-keys', description: 'Web search for research you start. Exa charges for each search and each page an agent reads; spend shows in Settings › Usage.' },
  brave: { link: 'https://api-dashboard.search.brave.com/app/keys', description: 'Web search for research you start, from Brave’s own index of the web. Each search is charged on your Brave Search plan; spend shows in Settings › Usage.' },
};

export type PluginsSection = 'plugins' | 'skills';
const sections = [{ id: 'plugins', label: 'Plugins' }, { id: 'skills', label: 'Skills' }];
/** Plugins and Skills share the page: the sidebar lists what is connected, or the person's skills. */
export function PluginsSidebar({section,onSection,installed,selected,onSelect,skills,skill,onSkill}:{section:PluginsSection;onSection:(section:PluginsSection)=>void;installed:PluginId[];selected:PluginId|null;onSelect:(id:PluginId|null)=>void;skills:SkillSummary[];skill:string|null;onSkill:(name:string|null)=>void}) {
  const open=(id:string)=>onSection(id as PluginsSection);
  if(section==='skills')return <CatalogueSidebar sections={sections} section={section} onSection={open} label="Your skills" empty="No skills yet" installed={skills.map(item=>({id:item.name,name:item.title,mark:<BookText size={16}/>,off:!item.enabled}))} selected={skill} onSelect={onSkill} note="Every agent in ros.ai uses the skills that are on. Click one to read or change it."/>;
  return <CatalogueSidebar sections={sections} section={section} onSection={open} installed={installed.map(id=>({id,name:PLUGINS.find(item=>item.id===id)!.name,mark:<PluginMark id={id} size={16}/>}))} selected={selected} onSelect={id=>onSelect(id as PluginId|null)} note="Connected on this computer. Click one to manage it."/>;
}

export function PluginsPage({projectId,publicDemo,selected,onSelect,onInstalled,onChanged,onResources}:{projectId:string|null;publicDemo:boolean;selected:PluginId|null;onSelect:(id:PluginId|null)=>void;onInstalled:(ids:PluginId[])=>void;onChanged:()=>Promise<unknown>;onResources:()=>void}) {
  const [plugins,setPlugins]=useState<PluginStatus[]>([]),[apps,setApps]=useState<AppConnectionStatus[]>([]),[google,setGoogle]=useState<GoogleDriveStatus|null>(null),[credentials,setCredentials]=useState<CredentialStatus[]>([]),[budgets,setBudgets]=useState<ConnectionBudgetStatus[]>([]),[search,setSearch]=useState<SearchServiceStatus|null>(null);
  const [loading,setLoading]=useState(false),[errors,setErrors]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
  const refresh=useCallback(async()=>{
    if(publicDemo)return;
    setLoading(true);
    const [tokens,drive,keys,limits,signIns,searching]=await Promise.allSettled([api<{plugins:PluginStatus[]}>('/api/plugins'),api<GoogleDriveStatus>('/api/connections/google-drive'),api<{credentials:CredentialStatus[]}>('/api/connections/credentials'),api<{budgets:ConnectionBudgetStatus[]}>('/api/connections/budgets'),api<{apps:AppConnectionStatus[]}>('/api/apps'),api<SearchServiceStatus>('/api/connections/search')]);
    const failures:Record<string,string>={};
    if(tokens.status==='fulfilled')setPlugins(tokens.value.plugins);else failures.plugins=message(tokens.reason);
    if(drive.status==='fulfilled')setGoogle(drive.value);else failures.google=message(drive.reason);
    if(keys.status==='fulfilled')setCredentials(keys.value.credentials);else failures.keys=message(keys.reason);
    if(limits.status==='fulfilled')setBudgets(limits.value.budgets);
    if(signIns.status==='fulfilled')setApps(signIns.value.apps);
    if(searching.status==='fulfilled')setSearch(searching.value);
    setErrors(failures);setLoading(false);
  },[publicDemo]);
  useEffect(()=>{void refresh();},[refresh]);
  const changed=async()=>{await refresh();await onChanged();};
  const stateOf=(plugin:PluginDefinition):PluginState=>{
    if(plugin.connect==='unavailable')return {label:'Not yet',connected:false};
    if(plugin.id==='google-drive')return google?.connected?{label:'Connected',connected:true}:{label:'Not connected',connected:false};
    if(plugin.id==='google-sheets'||plugin.id==='google-docs')return google?.connected?{label:'Through Google Drive',connected:true}:{label:'Needs Google Drive',connected:false};
    if(isSearchProvider(plugin.id)){const key=credentials.find(item=>item.provider===plugin.id);return key?.configured?{label:search?.active===plugin.id?'Used for search':'Key saved',connected:true}:{label:'Not connected',connected:false};}
    const token=plugins.find(item=>item.id===plugin.id),app=viaApp(plugin)?apps.find(item=>item.id===plugin.id):undefined;
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
    if(plugin.id==='google-sheets'||plugin.id==='google-docs'){const files=plugin.id==='google-sheets'?'Sheets':'Docs';return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} connected={google?.connected} status={!google?'Checking…':google.connected?'Connected':'Needs Google Drive'}><p>{plugin.name} live in your Drive, so they use the same read-only Google sign-in. {google?.connected?`Add one with Add block › Google Drive and its link; agents read your ${files} through it.`:`Connect Google Drive to reach your ${files}.`} ros.ai cannot edit or share them.</p></ConnectionCard>;}
    if(isSearchProvider(plugin.id)){
      const id=plugin.id,credential=credentials.find(item=>item.provider===id),label=search?.services.find(item=>item.id===id)?.label??plugin.name;
      return <KeyConnection key={id} provider={id as CredentialProvider} label={plugin.name} icon={<PluginMark id={id}/>} credential={credential} budget={budgets.find(item=>item.provider===id)} description={searchKeys[id].description} keyLink={searchKeys[id].link} loadError={errors.keys} onSave={async(_provider,key)=>{await api(`/api/connections/credentials/${id}`,{method:'PUT',body:JSON.stringify({apiKey:key})});setNotice(`${label} key saved on this computer.`);await changed();}} onDisconnect={async()=>{await api(`/api/connections/credentials/${id}`,{method:'DELETE'});await changed();}}
        primary={credential?.configured&&search&&search.active!==id?{label:`Search with ${label}`,onClick:async()=>{setSearch(await api<SearchServiceStatus>('/api/connections/search',{method:'PUT',body:JSON.stringify({provider:id})}));setNotice(`Ros and your agents now search the web with ${label}.`);await onChanged();}}:undefined}>
        {credential?.configured&&search?.active===id&&<p>Ros and your agents search the web with {label}.</p>}
      </KeyConnection>;
    }
    if(plugin.connect==='unavailable')return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} status="Not available yet"><p>{plugin.unavailableReason}</p></ConnectionCard>;
    if(plugin.connect==='sign-in'||plugin.connect==='desktop')return <AppPlugin key={plugin.id} open={plugin.id===selected} plugin={plugin} app={apps.find(item=>item.id===plugin.id)} onChanged={changed}/>;
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
  </div>;}
  return <div className="plugins-page">
    <header className="plugins-head"><div><h1>Plugins</h1><p>Connect plugins so your agents work across your tools</p></div><button className="icon-button" disabled={loading} aria-label="Refresh plugin status" onClick={()=>void refresh()}><RefreshCw size={15} className={loading?'spin':''}/></button></header>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {errors.plugins&&<p className="inline-error" role="alert">{errors.plugins}</p>}
    {groups.map(group=><section key={group.title} className="plugin-group"><h2>{group.title}</h2><div className="plugin-grid">{group.ids.map(id=>row(PLUGINS.find(plugin=>plugin.id===id)!))}</div></section>)}
    <p className="plugins-footnote">Each plugin connects with a sign-in, key, token or desktop app you already have, and stays on this computer. Every agent you run here, from any vendor, uses the same connections; agents read through them and change things only after you accept.</p>
  </div>;
}

/** An app connected through its own MCP server: Connect opens its sign-in page (sign-in), or checks that its desktop app serves it (desktop). */
function AppPlugin({plugin,app,open:forceOpen,onChanged}:{plugin:PluginDefinition;app?:AppConnectionStatus;open?:boolean;onChanged:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await onChanged();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const connected=app?.connected??false,desktop=plugin.connect==='desktop';
  const connect=()=>void run(async()=>{const started=await post<{authorizationUrl?:string}>(`/api/apps/${plugin.id}/connect`,{});if(started.authorizationUrl)window.location.assign(started.authorizationUrl);});
  return <ConnectionCard label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} forceOpen={forceOpen} connected={connected} status={!app?'Checking…':connected?'Connected':'Not connected'}>
    {connected?<p className="connection-check" role="status">{desktop?`Connected to ${plugin.name}’s desktop app. Agents read the designs you link or select there while the app is open.`:`Signed in to ${plugin.name}${app?.account?` as ${app.account}`:''}. Agents use ${plugin.name}’s own tools and ask you before changing anything there.`}</p>
      :<p>{desktop?plugin.start:`Connect opens ${plugin.name}’s sign-in. Approve ros.ai there and you come back here; there is nothing to create or paste.`}</p>}
    {desktop&&!connected&&plugin.requirement&&<p className="subtle">{plugin.requirement}</p>}
    <div className="connection-actions">{connected?<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>api(`/api/apps/${plugin.id}`,{method:'DELETE'}))}>Disconnect</button>:<button className="primary small" disabled={busy||!app} onClick={connect}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} {busy&&desktop?'Checking…':'Connect'}</button>}</div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </ConnectionCard>;
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
