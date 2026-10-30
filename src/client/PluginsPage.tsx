import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ExternalLink, Globe, LoaderCircle, MoreHorizontal, Pencil, Plug, Plus, RefreshCw, RotateCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CredentialProvider, CredentialStatus } from '../shared/tool-connections';
import type { GoogleDriveStatus } from '../shared/google-drive';
import type { ConnectionBudgetStatus } from '../shared/connection-budgets';
import { PLUGINS, zoteroAppProblem, type AppAccountStatus, type AppConnectionStatus, type LocalPlugins, type PluginDefinition, type PluginId, type PluginStatus, type TokenPluginId } from '../shared/plugins';
import type { PaperSourceStatus, PapersStatus } from '../shared/papers';
import type { BrowserStatus } from '../shared/browser';
import { isSearchProvider, type SearchProviderId, type SearchServiceStatus } from '../shared/search';
import { ConnectionCard, GoogleDriveConnectionCard, KeyConnection, message } from './ModelPage';
import { BrandLogo, hasBrandLogo } from './brand-logos';
import { api, post } from './api';
import { readSavedList, saveLocal } from './persistence';
import './plugins.css';

export function PluginMark({id,size}:{id:string;size?:number}) {
  return hasBrandLogo(id)?<BrandLogo id={id} size={size}/>:id==='browser'?<Globe size={size||18}/>:<Plug size={size||18}/>;
}
/** An account's tile: the first letter of its name, as Notion shows a workspace without an icon. */
export function AccountTile({name,small}:{name:string;small?:boolean}) {
  return <span className={`account-tile${small?' mini':''}`} aria-hidden="true">{(name.trim()[0]??'?').toUpperCase()}</span>;
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
  { title: 'Sources', ids: ['google-drive', 'google-sheets', 'google-docs', 'zotero', 'openalex', 'arxiv', 'tavily', 'exa', 'brave'] },
  { title: 'Team', ids: ['notion', 'slack', 'linear'] },
  { title: 'Code and design', ids: ['github', 'sentry', 'figma'] },
  { title: 'Tools', ids: ['browser'] },
  { title: 'Not available yet', ids: ['overleaf'] },
];
/** Apps whose own tools come from their sign-in (Notion also has a token) or desktop server, not from a token. */
const viaApp = (plugin: PluginDefinition) => plugin.signIn || plugin.connect === 'sign-in' || plugin.connect === 'desktop';

/** Where each web search service hands out keys, and what its card says. */
export const searchKeys: Record<SearchProviderId, { link: string; description: string }> = {
  tavily: { link: 'https://app.tavily.com/', description: 'Web search for research you start. Each search spends Tavily credits; spend shows in Settings › Usage.' },
  exa: { link: 'https://dashboard.exa.ai/api-keys', description: 'Web search for research you start. Exa charges for each search and each page an agent reads; spend shows in Settings › Usage.' },
  brave: { link: 'https://api-dashboard.search.brave.com/app/keys', description: 'Web search for research you start, from Brave’s own index of the web. Each search is charged on your Brave Search plan; spend shows in Settings › Usage.' },
};

/** The sidebar lists the plugins connected on this computer. */
export function PluginsSidebar({installed,selected,onSelect}:{installed:PluginId[];selected:PluginId|null;onSelect:(id:PluginId|null)=>void}) {
  return <CatalogueSidebar sections={[{id:'plugins',label:'Plugins'}]} installed={installed.map(id=>({id,name:PLUGINS.find(item=>item.id===id)!.name,mark:<PluginMark id={id} size={16}/>}))} selected={selected} onSelect={id=>onSelect(id as PluginId|null)} note="Connected on this computer. Click one to manage it."/>;
}

/** What the page read last in this session: it opens with that at once while it reads again. */
type PluginReads = { plugins?: PluginStatus[]; apps?: AppConnectionStatus[]; google?: GoogleDriveStatus | null; credentials?: CredentialStatus[]; budgets?: ConnectionBudgetStatus[]; search?: SearchServiceStatus | null; papers?: PaperSourceStatus[] | null; browser?: BrowserStatus | null; local?: LocalPlugins | null };
let lastReads: PluginReads = {};
/** What was connected when the page last finished reading, saved on this computer, so the page and its sidebar open with it. */
type Installed = { id: PluginId; label: string };
const savedPlugins = () => readSavedList<Installed>('plugins-installed', item => PLUGINS.some(plugin => plugin.id === item?.id) && typeof item?.label === 'string');
export const lastInstalledPlugins = () => savedPlugins().map(item => item.id);

export function PluginsPage({projectId,publicDemo,selected,onSelect,onInstalled,onChanged,onResources}:{projectId:string|null;publicDemo:boolean;selected:PluginId|null;onSelect:(id:PluginId|null)=>void;onInstalled:(ids:PluginId[])=>void;onChanged:()=>Promise<unknown>;onResources:()=>void}) {
  const [plugins,setPlugins]=useState<PluginStatus[]>(lastReads.plugins??[]),[apps,setApps]=useState<AppConnectionStatus[]>(lastReads.apps??[]),[google,setGoogle]=useState<GoogleDriveStatus|null>(lastReads.google??null),[credentials,setCredentials]=useState<CredentialStatus[]>(lastReads.credentials??[]),[budgets,setBudgets]=useState<ConnectionBudgetStatus[]>(lastReads.budgets??[]),[search,setSearch]=useState<SearchServiceStatus|null>(lastReads.search??null),[papers,setPapers]=useState<PaperSourceStatus[]|null>(lastReads.papers??null),[browser,setBrowser]=useState<BrowserStatus|null>(lastReads.browser??null),[local,setLocal]=useState<LocalPlugins|null>(lastReads.local??null);
  const [loading,setLoading]=useState(false),[errors,setErrors]=useState<Record<string,string>>({}),[notice,setNotice]=useState(''),[read,setRead]=useState(false),[remembered]=useState(savedPlugins);
  useEffect(()=>{lastReads={plugins,apps,google,credentials,budgets,search,papers,browser,local};},[plugins,apps,google,credentials,budgets,search,papers,browser,local]);
  const refresh=useCallback(async()=>{
    if(publicDemo)return;
    setLoading(true);
    const [tokens,drive,keys,limits,signIns,searching,sources,browsing,found]=await Promise.allSettled([api<{plugins:PluginStatus[]}>('/api/plugins'),api<GoogleDriveStatus>('/api/connections/google-drive'),api<{credentials:CredentialStatus[]}>('/api/connections/credentials'),api<{budgets:ConnectionBudgetStatus[]}>('/api/connections/budgets'),api<{apps:AppConnectionStatus[]}>('/api/apps'),api<SearchServiceStatus>('/api/connections/search'),api<PapersStatus>('/api/papers'),api<BrowserStatus>('/api/browser'),api<LocalPlugins>('/api/plugins/local')]);
    const failures:Record<string,string>={};
    if(tokens.status==='fulfilled')setPlugins(tokens.value.plugins);else failures.plugins=message(tokens.reason);
    if(drive.status==='fulfilled')setGoogle(drive.value);else failures.google=message(drive.reason);
    if(keys.status==='fulfilled')setCredentials(keys.value.credentials);else failures.keys=message(keys.reason);
    if(limits.status==='fulfilled')setBudgets(limits.value.budgets);
    if(signIns.status==='fulfilled')setApps(signIns.value.apps);
    if(searching.status==='fulfilled')setSearch(searching.value);
    if(sources.status==='fulfilled')setPapers(sources.value.sources);
    if(browsing.status==='fulfilled')setBrowser(browsing.value);
    if(found.status==='fulfilled')setLocal(found.value);
    setErrors(failures);setLoading(false);setRead(true);
  },[publicDemo]);
  useEffect(()=>{void refresh();},[refresh]);
  const changed=async()=>{await refresh();await onChanged();};
  const stateOf=(plugin:PluginDefinition):PluginState=>{
    if(plugin.connect==='unavailable')return {label:'Not yet',connected:false};
    if(plugin.id==='google-drive')return google?.connected?{label:'Connected',connected:true}:{label:'Not connected',connected:false};
    if(plugin.id==='google-sheets'||plugin.id==='google-docs')return google?.connected?{label:'Through Google Drive',connected:true}:{label:'Needs Google Drive',connected:false};
    if(plugin.connect==='public')return papers?.find(item=>item.id===plugin.id)?.agents?{label:'On for agents',connected:true}:{label:'Off for agents',connected:false};
    if(plugin.connect==='browser')return browser?.agents?{label:'On for agents',connected:true}:{label:'Off for agents',connected:false};
    if(isSearchProvider(plugin.id)){
      const key=credentials.find(item=>item.provider===plugin.id),active=search?.active===plugin.id;
      if(key?.configured)return {label:active?'Used for search':'Key saved',connected:true};
      return search?.services.find(item=>item.id===plugin.id)?.free?{label:active?'Used for search':'Free tier',connected:true}:{label:'Not connected',connected:false};
    }
    const token=plugins.find(item=>item.id===plugin.id),app=viaApp(plugin)?apps.find(item=>item.id===plugin.id):undefined;
    if(app?.connected)return {label:app.accounts&&app.accounts.length>1?`${app.accounts.length} accounts`:'Connected',connected:true};
    if(token?.via)return token.verified===false||!token.configured?{label:'Check failed',connected:false}:{label:token.via==='github-cli'?'Through GitHub CLI':'Through the Zotero app',connected:true};
    if(token?.configured)return token.verified===false?{label:'Check failed',connected:false}:{label:'Token saved',connected:true};
    return {label:'Not connected',connected:false};
  };
  // Until this visit's reads are in, what was connected last time still shows, so the list never starts empty.
  const shown=(plugin:PluginDefinition)=>{const state=stateOf(plugin),before=read?undefined:remembered.find(item=>item.id===plugin.id);return before&&!state.connected?{label:before.label,connected:true}:state;};
  const installedKey=JSON.stringify(PLUGINS.filter(plugin=>shown(plugin).connected).map(plugin=>({id:plugin.id,label:shown(plugin).label})));
  // Once they are in, what is connected is saved on this computer for the next time.
  useEffect(()=>{const installed=JSON.parse(installedKey) as Installed[];onInstalled(installed.map(item=>item.id));if(read)saveLocal('plugins-installed',installed);},[installedKey,read,onInstalled]);
  if(publicDemo)return <p className="rail-page-note">Plugins don't connect in this demo. <a href="https://ros-ai.io/#get" target="_blank" rel="noreferrer">Download ros.ai</a> to connect Notion, GitHub, Google Drive and more on your own computer.</p>;
  const card=(plugin:PluginDefinition)=>{
    if(plugin.id==='google-drive')return <GoogleDriveConnectionCard key={plugin.id} projectId={projectId} status={google} loadError={errors.google} onChanged={changed} onImported={async()=>{setNotice('CSV copied into this project. Open Resources to inspect or use it.');await onChanged();}} onResources={onResources}/>;
    if(plugin.id==='google-sheets'||plugin.id==='google-docs'){const files=plugin.id==='google-sheets'?'Sheets':'Docs';return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} connected={google?.connected} status={!google?'Checking…':google.connected?'Connected':'Needs Google Drive'}><p>{plugin.name} live in your Drive, so they use the same read-only Google sign-in. {google?.connected?`Add one with Add block › Google Drive and its link; agents read your ${files} through it.`:`Connect Google Drive to reach your ${files}.`} ros.ai cannot edit or share them.</p></ConnectionCard>;}
    if(isSearchProvider(plugin.id)){
      const id=plugin.id,credential=credentials.find(item=>item.provider===id),service=search?.services.find(item=>item.id===id),label=service?.label??plugin.name;
      const use=async()=>{setSearch(await api<SearchServiceStatus>('/api/connections/search',{method:'PUT',body:JSON.stringify({provider:id})}));setNotice(`ROS and your agents now search the web with ${label}.`);await onChanged();};
      const saveKey=async(key:string)=>{await api(`/api/connections/credentials/${id}`,{method:'PUT',body:JSON.stringify({apiKey:key})});setNotice(`${label} key saved on this computer.`);await changed();};
      if(service?.free&&credential&&!credential.configured)return <FreeSearch key={id} plugin={plugin} label={label} active={search?.active===id} using={search?.services.find(item=>item.id===search.active)?.label??null} keyLink={searchKeys[id].link} onUse={use} onSaveKey={saveKey}/>;
      return <KeyConnection key={id} provider={id as CredentialProvider} label={plugin.name} icon={<PluginMark id={id}/>} credential={credential} budget={budgets.find(item=>item.provider===id)} description={searchKeys[id].description} keyLink={searchKeys[id].link} loadError={errors.keys} onSave={async(_provider,key)=>{await api(`/api/connections/credentials/${id}`,{method:'PUT',body:JSON.stringify({apiKey:key})});setNotice(`${label} key saved on this computer.`);await changed();}} onDisconnect={async()=>{await api(`/api/connections/credentials/${id}`,{method:'DELETE'});await changed();}}
        primary={credential?.configured&&search&&search.active!==id?{label:`Search with ${label}`,onClick:async()=>{setSearch(await api<SearchServiceStatus>('/api/connections/search',{method:'PUT',body:JSON.stringify({provider:id})}));setNotice(`ROS and your agents now search the web with ${label}.`);await onChanged();}}:undefined}>
        {credential?.configured&&search?.active===id&&<p>ROS and your agents search the web with {label}.</p>}
      </KeyConnection>;
    }
    if(plugin.connect==='public')return <PaperSource key={plugin.id} plugin={plugin} source={papers?.find(item=>item.id===plugin.id)} token={plugins.find(item=>item.id===plugin.id)} onChanged={changed}/>;
    if(plugin.connect==='browser')return <BrowserPlugin key={plugin.id} plugin={plugin} status={browser} onChanged={changed}/>;
    if(plugin.connect==='unavailable')return <ConnectionCard key={plugin.id} label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} status="Not available yet"><p>{plugin.unavailableReason}</p></ConnectionCard>;
    if(plugin.local)return <LocalPlugin key={plugin.id} plugin={plugin} status={plugins.find(item=>item.id===plugin.id)} local={local} onChanged={changed} onLook={async()=>{setLocal(await api<LocalPlugins>('/api/plugins/local'));}}/>;
    if(plugin.connect==='sign-in'||plugin.connect==='desktop')return <AppPlugin key={plugin.id} open={plugin.id===selected} plugin={plugin} app={apps.find(item=>item.id===plugin.id)} onChanged={changed}/>;
    const signIns=plugin.signIn?apps.find(item=>item.id===plugin.id):undefined;
    if(signIns?.accounts)return <AppAccounts key={plugin.id} plugin={plugin} app={signIns} status={plugins.find(item=>item.id===plugin.id)} onChanged={changed}/>;
    return <TokenPlugin key={plugin.id} open={plugin.id===selected} plugin={plugin} status={plugins.find(item=>item.id===plugin.id)} app={signIns} onChanged={changed}/>;
  };
  const current=selected?PLUGINS.find(plugin=>plugin.id===selected):undefined;
  const row=(plugin:PluginDefinition)=><CatalogueRow key={plugin.id} mark={<PluginMark id={plugin.id} size={22}/>} name={plugin.name} summary={plugin.summary} state={shown(plugin)} unavailable={plugin.connect==='unavailable'} onClick={()=>onSelect(plugin.id)}/>;
  if(current){return <div className="plugins-page plugin-detail">
    <CatalogueHero crumb="Plugins" onBack={()=>onSelect(null)} mark={<PluginMark id={current.id} size={34}/>} name={current.name} summary={current.summary} state={shown(current)} uses={current.uses}/>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {errors.plugins&&<p className="inline-error" role="alert">{errors.plugins}</p>}
    <h2 className="plugin-section">{current.signIn&&apps.find(item=>item.id===current.id)?.accounts?'Accounts':'Connection'}</h2>
    {card(current)}
  </div>;}
  return <div className="plugins-page">
    <header className="plugins-head"><div><h1>Plugins</h1><p>Connect plugins so your agents work across your tools</p></div><button className="icon-button" disabled={loading} aria-label="Refresh plugin status" onClick={()=>void refresh()}><RefreshCw size={15} className={loading?'spin':''}/></button></header>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {errors.plugins&&<p className="inline-error" role="alert">{errors.plugins}</p>}
    {groups.map(group=><section key={group.title} className="plugin-group"><h2>{group.title}</h2><div className="plugin-grid">{group.ids.map(id=>row(PLUGINS.find(plugin=>plugin.id===id)!))}</div></section>)}
    <p className="plugins-footnote">Plugins connect through what you already have: a sign-in, or an app on this computer. Keys and tokens wait under More, and everything stays on this computer. Every agent you run here, from any vendor, uses the same connections; agents read through them and change things only after you accept.</p>
  </div>;
}

/** A free public source of papers (OpenAlex, arXiv). Add block › Paper always searches it; the switch offers it to every
 * agent too. OpenAlex also takes an optional key, kept like a plugin token, for a larger daily allowance. */
function PaperSource({plugin,source,token,onChanged}:{plugin:PluginDefinition;source?:PaperSourceStatus;token?:PluginStatus;onChanged:()=>Promise<void>}) {
  const [open,setOpen]=useState(false),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await onChanged();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const on=source?.agents??false,id=plugin.id as TokenPluginId;
  return <ConnectionCard label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} forceOpen connected={on} status={!source?'Checking…':on?'On for agents':'Off for agents'}>
    <p>Free, with no account. Add block › Paper searches {plugin.name} whenever you add a paper. {on?`Every agent can search it too, and add the papers it finds to the canvas.`:`Turn it on and every agent can search it too.`}</p>
    {token?.checkMessage&&<p className={token.verified?'connection-check':'inline-error'} role="status">{token.checkMessage}</p>}
    <div className="connection-actions">
      <button className={on?'secondary small':'primary small'} disabled={busy||!source} onClick={()=>void run(()=>api(`/api/papers/${plugin.id}`,{method:'PUT',body:JSON.stringify({agents:!on})}))}>{on?'Turn off for agents':'Turn on for agents'}</button>
      {plugin.tokenLabel&&<button className="text-button" disabled={busy} aria-expanded={open} onClick={()=>{setOpen(!open);setKey('');setError('');}}>{open?'Close setup':token?.configured?'Replace key':'Add a key'}</button>}
      {token?.configured&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>post(`/api/plugins/${id}/check`,{}))}>{busy?'Checking…':'Check'}</button>}{token?.configured&&<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>api(`/api/plugins/${id}`,{method:'DELETE'}))}>Remove key</button>}
    </div>
    {open&&<div className="connection-setup"><p>{plugin.tokenHint} {plugin.tokenLink&&<a href={plugin.tokenLink} target="_blank" rel="noreferrer">Open {plugin.name}<ExternalLink size={11}/></a>}</p>
      <form onSubmit={event=>{event.preventDefault();if(busy)return;void run(async()=>{await api(`/api/plugins/${id}`,{method:'PUT',body:JSON.stringify({token:key})});setKey('');setOpen(false);});}}><label className="field-label" htmlFor={`plugin-token-${id}`}>{plugin.tokenLabel}</label><input id={`plugin-token-${id}`} type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder="Paste it here" required minLength={8} maxLength={4096}/><button className="primary small" type="submit" disabled={busy||key.trim().length<8}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Save</button></form>
      <p className="subtle">Saved privately on this computer. Check makes one request to confirm the key.</p></div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </ConnectionCard>;
}

/** The browser agents use: the Chrome or Edge on this computer, or Chromium downloaded once. The switch offers it to every agent. */
function BrowserPlugin({plugin,status,onChanged}:{plugin:PluginDefinition;status:BrowserStatus|null;onChanged:()=>Promise<void>}) {
  const [doing,setDoing]=useState<'switch'|'check'|'download'|null>(null),[error,setError]=useState(''),[live,setLive]=useState<BrowserStatus|null>(null);
  useEffect(()=>setLive(null),[status]);
  const shown=live??status,downloading=shown?.download.state==='downloading';
  // While Chromium downloads, the card asks every second how far it got.
  useEffect(()=>{
    if(!downloading)return;
    const timer=setInterval(()=>{void api<BrowserStatus>('/api/browser').then(next=>{setLive(next);if(next.download.state!=='downloading')void onChanged();}).catch(()=>undefined);},1000);
    return()=>clearInterval(timer);
  },[downloading,onChanged]);
  const run=async(what:'switch'|'check'|'download',work:()=>Promise<unknown>)=>{setDoing(what);setError('');try{await work();await onChanged();}catch(cause){setError(message(cause));}finally{setDoing(null);}};
  const on=shown?.agents??false,engine=shown?.engine;
  return <ConnectionCard label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} forceOpen connected={on} status={!shown?'Checking…':on?'On for agents':'Off for agents'}>
    {engine?<p>Agents use {engine.name} on this computer, without a window and in an empty profile each time, so they never see your cookies, logins or saved passwords. It reaches public websites only, never this computer or your network, and keeps no downloads. The first page an agent opens in a turn follows the project’s approval mode.</p>
      :<p>Agents browse with Google Chrome, Microsoft Edge or Chromium. None is on this computer, so ros.ai can download Chromium once, about 100 MB, into its own data folder.</p>}
    {downloading&&<p className="connection-check" role="status">Downloading Chromium{shown.download.state==='downloading'&&shown.download.percent!==null?`: ${shown.download.percent}%`:'…'}</p>}
    {shown?.download.state==='failed'&&<p className="inline-error" role="alert">The download stopped: {shown.download.message}</p>}
    {shown?.checked&&<p className={shown.checked.ok?'connection-check':'inline-error'} role="status">{shown.checked.message}</p>}
    <div className="connection-actions">
      {engine?<button className={on?'secondary small':'primary small'} disabled={Boolean(doing)||!shown} onClick={()=>void run('switch',()=>api('/api/browser',{method:'PUT',body:JSON.stringify({agents:!on})}))}>{on?'Turn off for agents':'Turn on for agents'}</button>
        :<button className="primary small" disabled={Boolean(doing)||downloading||!shown} onClick={()=>void run('download',async()=>setLive(await post<BrowserStatus>('/api/browser/download',{})))}>{downloading?<LoaderCircle size={13} className="spin"/>:null} {downloading?'Downloading…':'Download Chromium'}</button>}
      {engine&&<button className="text-button" disabled={Boolean(doing)} onClick={()=>void run('check',()=>post('/api/browser/check',{}))}>{doing==='check'?'Checking…':'Check'}</button>}
    </div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </ConnectionCard>;
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

/** A web search service with no key saved, which searches free within its own limit (Tavily, Exa): one line and one
 * button, and a key of the person's own under More. */
function FreeSearch({plugin,label,active,using,keyLink,onUse,onSaveKey}:{plugin:PluginDefinition;label:string;active:boolean;using:string|null;keyLink:string;onUse:()=>Promise<void>;onSaveKey:(key:string)=>Promise<void>}) {
  const [key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  return <ConnectionCard label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} connected status={active?'Used for search':'Free tier'}
    more={<div className="alt-ways">
      <div className="alt-way"><span><strong>Your own {label} key</strong><small>Searches more than the free limit, charged to your {label} account. <a href={keyLink} target="_blank" rel="noreferrer">Get a key<ExternalLink size={11}/></a></small></span></div>
      <form className="connection-key" onSubmit={event=>{event.preventDefault();if(!busy&&key.trim().length>=12)void run(()=>onSaveKey(key.trim()));}}><label className="sr-only" htmlFor={`free-key-${plugin.id}`}>{label} API key</label><input id={`free-key-${plugin.id}`} type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder="Paste your API key" minLength={12} maxLength={4096}/><button className="secondary small" type="submit" disabled={busy||key.trim().length<12}>{busy&&<LoaderCircle size={13} className="spin"/>}Save key</button></form>
    </div>}
    actions={!active&&<button className="primary small" disabled={busy} onClick={()=>void run(onUse)}>Search with {label}</button>}>
    <p className={active?'connection-check':undefined}>{active?`ROS and your agents search the web with ${label} now, free with no account up to ${label}’s limit.`:`Free with no account, up to ${label}’s limit.${using?` ROS and your agents search with ${using} now.`:''}`}</p>
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </ConnectionCard>;
}

/** A plugin that connects through what is already on this computer, as Codex and Claude Code do: GitHub through the
 * GitHub CLI's sign-in, Zotero through the Zotero app. One line and one button; the token or key waits under More. */
function LocalPlugin({plugin,status,local,onChanged,onLook}:{plugin:PluginDefinition;status?:PluginStatus;local:LocalPlugins|null;onChanged:()=>Promise<void>;onLook:()=>Promise<void>}) {
  const [busy,setBusy]=useState<'use'|'look'|'check'|'token'|'off'|null>(null),[error,setError]=useState(''),[typing,setTyping]=useState(false),[token,setToken]=useState('');
  const id=plugin.id as TokenPluginId,github=id==='github',app=github?'the GitHub CLI':'the Zotero app';
  const run=async(what:NonNullable<typeof busy>,work:()=>Promise<unknown>)=>{setBusy(what);setError('');try{await work();await onChanged();}catch(cause){setError(message(cause));}finally{setBusy(null);}};
  const use=()=>void run('use',()=>post(`/api/plugins/${id}/local`,{}));
  const look=()=>void run('look',onLook);
  const via=status?.via??null,failed=status?.verified===false||(via!==null&&status?.configured===false),connected=Boolean(status?.configured)&&!failed;
  // What is on this computer, before anything is connected: ready, or what stands in the way.
  const ready=github?local?.github===true:local?.zotero==='ready';
  const found=!local?'':github?(local.github?'The GitHub CLI on this computer is signed in. ros.ai uses that sign-in; nothing is copied or saved.':'Sign in to the GitHub CLI with gh auth login in Terminal, and ros.ai uses that sign-in. Or use a token under More.')
    :local.zotero==='ready'?'Zotero is open on this computer. ros.ai reads your library and the PDFs it keeps through it; nothing in your library changes.':`${zoteroAppProblem(local.zotero)}${local.zotero==='closed'?' Or use an API key under More.':''}`;
  const line=via&&!failed?<p className="connection-check" role="status">{github?`${status?.checkMessage??'Connected through the GitHub CLI.'} Agents use GitHub’s own tools and ask you before changing anything.`:'Connected through the Zotero app. ros.ai reads your library while Zotero is open; nothing in your library changes.'}</p>
    :failed?<p className="inline-error" role="status">{status?.checkMessage??(github?'The GitHub CLI’s sign-in could not be read. Run gh auth login in Terminal, then check again.':`${plugin.name} could not be reached.`)}</p>
    :connected?<p className="connection-check" role="status">{status?.checkMessage??`Connected with a ${github?'personal access token':'Zotero API key'}.`}</p>
    :<p>{found||'Looking on this computer…'}</p>;
  const primary=connected?null:failed?<button className="primary small" disabled={Boolean(busy)} onClick={()=>void run('check',()=>post(`/api/plugins/${id}/check`,{}))}>{busy==='check'&&<LoaderCircle size={13} className="spin"/>}Check again</button>
    :ready?<button className="primary small" disabled={Boolean(busy)} onClick={use}>{busy==='use'?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>}{github?'Use GitHub CLI':'Use Zotero'}</button>
    :<button className="primary small" disabled={Boolean(busy)||!local} onClick={look}>{busy==='look'&&<LoaderCircle size={13} className="spin"/>}Check again</button>;
  return <ConnectionCard label={plugin.name} icon={<PluginMark id={plugin.id}/>} subtitle={plugin.summary} connected={connected} status={!status?'Checking…':failed?'Check failed':via?'Connected':connected?(github?'Connected with a token':'Connected with a key'):'Not connected'}
    more={<div className="alt-ways">
      {ready&&via===null&&connected&&<div className="alt-way"><span><strong>{github?'GitHub CLI on this computer':'The Zotero app'}</strong><small>{github?'Signed in. ros.ai uses that sign-in instead of the token.':'Open now. ros.ai reads your library through it instead of the key.'}</small></span><button className="secondary small" disabled={Boolean(busy)} onClick={use}>{github?'Use GitHub CLI':'Use Zotero'}</button></div>}
      <div className="alt-way"><span><strong>{plugin.tokenLabel}</strong><small>{github?`Make a token on github.com and paste it here${via?`, instead of ${app}`:''}.`:`Reads your online library, without the app. Make a key on zotero.org and paste it here.`}</small></span><button className="secondary small" disabled={Boolean(busy)} aria-expanded={typing} onClick={()=>{setTyping(!typing);setToken('');}}>{typing?'Close':connected&&via===null?'Replace':'Use a token'}</button></div>
      {typing&&<div className="connection-setup"><p>{plugin.tokenHint} {plugin.tokenLink&&<a href={plugin.tokenLink} target="_blank" rel="noreferrer">Open {plugin.name}<ExternalLink size={11}/></a>}</p>
        <form onSubmit={event=>{event.preventDefault();if(busy)return;void run('token',async()=>{await api(`/api/plugins/${id}`,{method:'PUT',body:JSON.stringify({token})});await post(`/api/plugins/${id}/check`,{});setToken('');setTyping(false);});}}><label className="field-label" htmlFor={`plugin-token-${id}`}>{plugin.tokenLabel}</label><input id={`plugin-token-${id}`} type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} placeholder="Paste it here" required minLength={8} maxLength={4096}/><button className="primary small" type="submit" disabled={Boolean(busy)||token.trim().length<8}>{busy==='token'?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Save</button></form>
        <p className="subtle">Saved privately on this computer. ros.ai checks it once with a read-only request.</p></div>}
    </div>}
    actions={<>{(connected||failed)&&<button className="text-button danger" disabled={Boolean(busy)} onClick={()=>void run('off',()=>api(`/api/plugins/${id}`,{method:'DELETE'}))}>Disconnect</button>}{primary}</>}>
    {line}
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

/** The day an account signed in, as "28 October" (with the year when it is not this one). */
const signedInOn = (at: string) => { const date = new Date(at); return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }); };

/** An app the person signs in to once per workspace (Notion): one card with a row per account and more behind each
 * row's ···, and one black action to add another. The integration token stays the fallback, offered while no account is
 * signed in. */
function AppAccounts({plugin,app,status,onChanged}:{plugin:PluginDefinition;app:AppConnectionStatus;status?:PluginStatus;onChanged:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[renaming,setRenaming]=useState<string|null>(null),[open,setOpen]=useState(false),[token,setToken]=useState('');
  const id=plugin.id as TokenPluginId,accounts=app.accounts??[],configured=status?.configured??false,several=accounts.length>1;
  const run=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await onChanged();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  // Each sign-in opens Notion's own page, which asks which workspace to share, and comes back here.
  const signIn=(body:{add?:boolean;account?:string})=>void run(async()=>{const started=await post<{authorizationUrl?:string}>(`/api/apps/${id}/connect`,body);if(started.authorizationUrl)window.location.assign(started.authorizationUrl);});
  const change=(key:string,body:{default?:true;name?:string})=>run(()=>api(`/api/apps/${id}/accounts/${key}`,{method:'PATCH',body:JSON.stringify(body)}));
  const tokenButton=<button className="text-button" disabled={busy||!status} aria-expanded={open} onClick={()=>{setOpen(!open);setToken('');setError('');}}>{open?'Close setup':configured?'Replace token':'Use an integration token instead'}</button>;
  return <>
    {app.notice&&<p className="connection-notice" role="status"><Check size={14}/>{app.notice}</p>}
    {accounts.length?<section className="plugin-accounts" aria-label={`${plugin.name} accounts`}>
      {accounts.map(account=><div key={account.key} className="plugin-account">
        <AccountTile name={account.name}/>
        {renaming===account.key
          ?<RenameField account={account} onDone={value=>{setRenaming(null);if(value!==null&&value.trim()!==account.name)void change(account.key,{name:value.trim()});}}/>
          :<span className="plugin-account-name"><strong>{account.name}</strong>{account.email&&<small>{account.email}</small>}</span>}
        {account.default&&several&&<span className="plugin-account-tag">Default</span>}
        <span className={`plugin-row-state ${account.connected?'':'off'}`}><i/>{account.connected?'Connected':'Signed out'}</span>
        {!account.connected&&<button className="secondary small" disabled={busy} onClick={()=>signIn({account:account.key})}>Sign in again</button>}
        <AccountMenu account={account} several={several} busy={busy} onDefault={()=>void change(account.key,{default:true})} onRename={()=>setRenaming(account.key)} onSignIn={()=>signIn({account:account.key})} onDisconnect={()=>void run(()=>api(`/api/apps/${id}/accounts/${account.key}`,{method:'DELETE'}))}/>
      </div>)}
      <footer className="plugin-accounts-foot"><span>Each sign-in links one workspace. {plugin.name} asks which.</span><button className="primary small" disabled={busy} onClick={()=>signIn({add:true})}>{busy?<LoaderCircle size={14} className="spin"/>:<Plus size={14}/>}Add account</button></footer>
    </section>
    :<section className="plugin-accounts" aria-label={`Connect ${plugin.name}`}>
      <div className="plugin-accounts-empty"><span><strong>Bring your {plugin.name} onto the map</strong><small>Sign in once and pick a workspace. Add more workspaces any time.</small></span><button className="primary small" disabled={busy} onClick={()=>signIn({})}>{busy?<LoaderCircle size={14} className="spin"/>:<Plug size={14}/>}Connect</button></div>
    </section>}
    {status?.checkMessage&&<p className={status.verified?'connection-check':'inline-error'} role="status">{status.checkMessage}</p>}
    {(configured||!app.connected)&&<div className="plugin-accounts-token">
      {configured&&<span>Integration token saved</span>}{tokenButton}
      {configured&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>post(`/api/plugins/${id}/check`,{}))}>{busy?'Checking…':'Check'}</button>}{configured&&<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>api(`/api/plugins/${id}`,{method:'DELETE'}))}>Remove token</button>}
    </div>}
    {open&&<div className="connection-setup"><p>{plugin.tokenHint} {plugin.tokenLink&&<a href={plugin.tokenLink} target="_blank" rel="noreferrer">Open {plugin.name}<ExternalLink size={11}/></a>}</p>
      <form onSubmit={event=>{event.preventDefault();if(busy)return;void run(async()=>{await api(`/api/plugins/${id}`,{method:'PUT',body:JSON.stringify({token})});setToken('');setOpen(false);});}}><label className="field-label" htmlFor={`plugin-token-${id}`}>{plugin.tokenLabel}</label><input id={`plugin-token-${id}`} type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} placeholder="Paste it here" required minLength={8} maxLength={4096}/><button className="primary small" type="submit" disabled={busy||token.trim().length<8}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Save</button></form>
      <p className="subtle">Saved privately on this computer. Check makes one read-only request to confirm the token.</p></div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </>;
}

/** An account's name, edited in place: Enter or leaving the field keeps it, Escape leaves it as it was (null). An empty
 * name shows the workspace's own name again. */
function RenameField({account,onDone}:{account:AppAccountStatus;onDone:(name:string|null)=>void}) {
  const [value,setValue]=useState(account.name),done=useRef(false);
  const finish=(name:string|null)=>{if(done.current)return;done.current=true;onDone(name);};
  return <form className="plugin-account-name" onSubmit={event=>{event.preventDefault();finish(value);}}><input aria-label={`Name for ${account.name}`} value={value} autoFocus maxLength={120} placeholder={account.name} onChange={event=>setValue(event.target.value)} onBlur={()=>finish(value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();finish(null);}}}/></form>;
}

/** The ··· of one account: who signed in and since when, then make it the default, rename it, sign in again or disconnect it. */
function AccountMenu({account,several,busy,onDefault,onRename,onSignIn,onDisconnect}:{account:AppAccountStatus;several:boolean;busy:boolean;onDefault:()=>void;onRename:()=>void;onSignIn:()=>void;onDisconnect:()=>void}) {
  const [open,setOpen]=useState(false);
  const menuRef=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};
  },[open]);
  const pick=(action:()=>void)=>()=>{setOpen(false);action();};
  return <div className="plugin-account-more">
    <button ref={trigger} type="button" className="icon-button" aria-label={`More for ${account.name}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={()=>setOpen(value=>!value)}><MoreHorizontal size={16}/></button>
    {open&&<div ref={menuRef} className="ros-model-menu plugin-account-menu" role="menu" aria-label={account.name}>
      <p>{account.connected?`Signed in${account.email?` as ${account.email}`:''}${account.connectedAt?` since ${signedInOn(account.connectedAt)}`:''}.`:'Signed out. Sign in again to use it.'}</p>
      {several&&!account.default&&<button type="button" role="menuitem" onClick={pick(onDefault)}><Check size={15}/>Make default</button>}
      <button type="button" role="menuitem" onClick={pick(onRename)}><Pencil size={15}/>Rename</button>
      <button type="button" role="menuitem" onClick={pick(onSignIn)}><RotateCw size={15}/>Sign in again</button>
      <hr/>
      <button type="button" role="menuitem" className="danger" onClick={pick(onDisconnect)}><X size={15}/>Disconnect</button>
    </div>}
  </div>;
}
