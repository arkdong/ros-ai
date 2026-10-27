import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ExternalLink, LoaderCircle, Plug, RefreshCw } from 'lucide-react';
import { BrandLogo } from './brand-logos';
import type { ConnectionStatus } from '../shared/types';
import type { CredentialProvider, CredentialStatus } from '../shared/tool-connections';
import type { LocalAgentSetup, CodexLoginStatus } from '../shared/local-agent-setup';
import type { GoogleDriveStatus, GoogleDriveFiles } from '../shared/google-drive';
import type { ConnectionBudgetStatus } from '../shared/connection-budgets';
import type { ClaudeAgentSettings, ClaudeBilling, ClaudeModel, ClaudePlanLogin, ClaudeWebSearch } from '../shared/claude-agent';
import type { CodexAgentSettings, CodexApiModel, CodexBilling } from '../shared/codex-agent';
import { LocalModels } from './LocalModels';
import { CloudAccount } from './CloudAccount';
import { LocalRos } from './LocalRos';
import type { AgentId as SetupAgentId, LinkResult, SetupLinkResponse, SetupStatus } from '../shared/setup';
import { AgentIcon, agentWhy, CommandBox } from './Setup';
import { date } from './Content';
import { api, post } from './api';
import { RosMark } from './RosDock';
import { CatalogueHero, CatalogueRow, CatalogueSidebar } from './PluginsPage';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import { ACP_AGENTS, isAcpAgent, type AcpAgentStatus } from '../shared/acp-agents';
import { AcpAgentCard, acpLogo, acpState } from './AcpAgents';
import './connections.css';

export type AgentId = 'ros' | 'claude' | 'codex' | 'gemini' | 'goose' | 'opencode' | 'own-cursor' | 'own-gemini' | 'own-pi' | 'own-hermes' | 'nebius' | 'openai' | 'local';
/** title: the summary in full on the agent's own page, where the list row's is too short. */
type AgentItem = { id: AgentId; name: string; summary: string; title?: string; mark: ReactNode; uses: string[] };
const agentItems: AgentItem[] = [
  { id: 'ros', name: 'Ros', summary: 'ros.ai’s own assistant, hosted for free or on this computer', mark: <RosMark/>, uses: ['Plans and runs research on the map with ros.ai’s tools', 'Hosted: free with a ros.ai account; nothing to install', 'On this computer: one 3 GB download, works offline', 'Switch between them from the model name in the Ros bar'] },
  { id: 'claude', name: 'Claude Code', summary: 'Plan · API key · your own', title: 'Claude plan · Claude API key · your own Claude Code', mark: <BrandLogo id="claude"/>, uses: ['Inside ros.ai: works as Ros on your Claude plan or your Claude API key', 'From your terminal: your own Claude Code works on the map through ros.ai’s MCP server', 'Reads the project folder and proposes changes; code runs in ros.ai’s sandbox under your approval mode'] },
  { id: 'codex', name: 'Codex', summary: 'Plan · API key · your own', title: 'ChatGPT plan · OpenAI API key · your own Codex', mark: <BrandLogo id="codex"/>, uses: ['Inside ros.ai: works as Ros on your ChatGPT plan or your OpenAI API key', 'From your terminal: your own Codex works on the map through ros.ai’s MCP server', 'On your plan it uses Codex’s own sign-in; ros.ai never sees it'] },
  { id: 'gemini', name: 'Gemini CLI', summary: ACP_AGENTS.gemini.summary, mark: <BrandLogo id="gemini-cli"/>, uses: ['Works as Ros through Gemini CLI on this computer', 'Reads the project folder; its other tools are off in ros.ai', 'Uses its own Google sign-in or key; ros.ai never sees it'] },
  { id: 'goose', name: 'Goose', summary: ACP_AGENTS.goose.summary, mark: <BrandLogo id="goose"/>, uses: ['Works as Ros through Goose on this computer', 'Only ros.ai’s tools run; ros.ai refuses every tool of its own', 'Uses the model Goose is set up with; ros.ai never sees its key'] },
  { id: 'opencode', name: 'OpenCode', summary: ACP_AGENTS.opencode.summary, mark: <BrandLogo id="opencode"/>, uses: ['Works as Ros through OpenCode on this computer', 'Reads the project folder; its other tools are off in ros.ai', 'Uses OpenCode’s own providers and keys; ros.ai never sees them'] },
  { id: 'own-cursor', name: 'Your own Cursor', summary: 'In Cursor, working on the map', mark: <AgentIcon id="cursor"/>, uses: ['Keep working in Cursor the way you already do', 'Its agent reads the map and proposes blocks through ros.ai’s MCP server', 'Proposals follow your approval mode'] },
  { id: 'own-gemini', name: 'Your own Gemini CLI', summary: 'In your terminal, working on the map', mark: <AgentIcon id="gemini-cli"/>, uses: ['Keep working in Gemini CLI the way you already do', 'It reads the map and proposes blocks through ros.ai’s MCP server', 'Proposals follow your approval mode'] },
  { id: 'own-pi', name: 'Your own Pi', summary: 'In your terminal, working on the map', mark: <AgentIcon id="pi"/>, uses: ['Keep working in Pi the way you already do', 'It reads the map and proposes blocks through ros.ai’s MCP server', 'Proposals follow your approval mode'] },
  { id: 'own-hermes', name: 'Your own Hermes Agent', summary: 'In your terminal, working on the map', mark: <AgentIcon id="hermes"/>, uses: ['Keep working in Hermes Agent the way you already do', 'It reads the map and proposes blocks through ros.ai’s MCP server', 'Proposals follow your approval mode'] },
  { id: 'nebius', name: 'Nebius Token Factory', summary: 'Open models through your key', mark: <BrandLogo id="nebius"/>, uses: ['Nemotron, Kimi and other open models for Ros', 'Billed to your Token Factory key; spend shows in Settings › Usage'] },
  { id: 'openai', name: 'OpenAI API', summary: 'GPT models through your API key', mark: <BrandLogo id="openai"/>, uses: ['GPT models for Ros through your API key', 'Codex can run on the same key; choose it on the Codex page'] },
  { id: 'local', name: 'Local models', summary: 'Ollama, LM Studio or any OpenAI-compatible server', mark: <BrandLogo id="ollama"/>, uses: ['Models running on this computer or your own server', 'Nothing leaves the machine'] },
];
/** Who pays for a turn, from how ros.ai runs the agent: Claude Code and Codex here bill the plan or key chosen on
 * their pages, so they sit in the group for that choice, and Gemini CLI, Goose and OpenCode bill however they were set up. */
type Billing = 'plan' | 'key' | 'free' | 'own';
const agentGroups: { billing: Billing; title: string; why?: string; ids: AgentId[] }[] = [
  { billing: 'plan', title: 'On your subscription', why: 'Uses the plan you already pay for. No per-use charges.', ids: ['own-cursor', 'own-gemini'] },
  { billing: 'key', title: 'On your API keys', why: 'Pay per use, billed by the provider. Spend shows in Settings › Usage.', ids: ['openai', 'nebius'] },
  { billing: 'free', title: 'Free', ids: ['ros', 'local'] },
  { billing: 'own', title: 'Their own setup', why: 'Billed however you set the agent up: its own plan or its own key.', ids: ['gemini', 'goose', 'opencode', 'own-pi', 'own-hermes'] },
];
/** The billing line on an agent's own page. */
const billingLine: Record<AgentId, string> = {
  ros: 'Free: hosted with a ros.ai account, or on this computer', local: 'Free: runs on this computer or your own server',
  codex: 'Runs on your ChatGPT plan; no API charges', 'own-cursor': 'Runs on your Cursor plan', 'own-gemini': 'Runs on your own Google sign-in or key, as in your terminal',
  claude: 'Billed per use to your Claude API key', openai: 'Billed per use to your OpenAI API key', nebius: 'Billed per use to your Token Factory key',
  gemini: 'Billed through its own Google sign-in or key', goose: 'Billed through the provider Goose is set up with', opencode: 'Billed through OpenCode’s own providers, or free models',
  'own-pi': 'Billed through the provider Pi is set up with, as in your terminal', 'own-hermes': 'Billed through the provider Hermes Agent is set up with, as in your terminal',
};

type Props = { projectId:string|null; connections:ConnectionStatus[]; publicDemo:boolean; selected:AgentId|null; onSelect:(id:AgentId|null)=>void; onInstalled:(ids:AgentId[])=>void; onChanged:()=>Promise<unknown> };
/** Model holds only AI model connections. What they spend shows in Settings › Usage. */
export function ModelPage({projectId,connections,publicDemo,selected,onSelect,onInstalled,onChanged}:Props) {
  const [credentials,setCredentials]=useState<CredentialStatus[]>([]),[codex,setCodex]=useState<LocalAgentSetup>(),[claude,setClaude]=useState<ClaudeAgentSettings>(),[codexWay,setCodexWay]=useState<CodexAgentSettings>();
  const [loading,setLoading]=useState(false),[errors,setErrors]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
  const [budgets,setBudgets]=useState<ConnectionBudgetStatus[]>([]),[cloud,setCloud]=useState<CloudAccountStatus>(),[setup,setSetup]=useState<SetupStatus>(),[local,setLocal]=useState<LocalRosStatus>(),[acp,setAcp]=useState<AcpAgentStatus[]>([]);
  const refresh=useCallback(async()=>{
    if(publicDemo)return;
    setLoading(true);
    const paths=['/api/connections/credentials',projectId?`/api/projects/${projectId}/agents/setup/codex`:null,'/api/agents/claude','/api/connections/budgets','/api/cloud','/api/setup','/api/local-ros','/api/agents/acp','/api/agents/codex'];
    const values=await Promise.allSettled(paths.map(path=>!path?Promise.resolve(null):path.includes('/agents/setup/')?post<unknown>(path):api<unknown>(path)));
    const failures:Record<string,string>={};
    values.forEach((result,index)=>{const id=['credentials','codex','claude','budgets','cloud','setup','local','acp','codexWay'][index]!;if(result.status==='rejected'){failures[id]=result.reason instanceof Error?result.reason.message:String(result.reason);return;}if(index===0)setCredentials((result.value as {credentials:CredentialStatus[]}).credentials);if(index===1&&result.value)setCodex(result.value as LocalAgentSetup);if(index===2)setClaude(result.value as ClaudeAgentSettings);if(index===3)setBudgets((result.value as {budgets:ConnectionBudgetStatus[]}).budgets);if(index===4)setCloud(result.value as CloudAccountStatus);if(index===5)setSetup(result.value as SetupStatus);if(index===6)setLocal(result.value as LocalRosStatus);if(index===7)setAcp((result.value as {agents:AcpAgentStatus[]}).agents);if(index===8)setCodexWay(result.value as CodexAgentSettings);});
    setErrors(failures);setLoading(false);
  },[projectId,publicDemo]);
  useEffect(()=>{void refresh();},[refresh]);
  const changed=async()=>{await refresh();await onChanged();};
  const saved=async(provider:CredentialProvider,key:string)=>{await api(`/api/connections/credentials/${provider}`,{method:'PUT',body:JSON.stringify({apiKey:key})});setNotice('Key saved on this computer.');await changed();};
  const disconnected=async(provider:CredentialProvider)=>{await api(`/api/connections/credentials/${provider}`,{method:'DELETE'});setNotice('Locally saved key removed. Any environment configuration remains active.');await changed();};
  const key=(provider:CredentialProvider)=>{const item=credentials.find(entry=>entry.provider===provider);return item?.configured?(item.verified===false?{label:'Check failed',connected:false}:{label:'Key saved',connected:true}):{label:'Not connected',connected:false};};
  const own=(id:SetupAgentId)=>{const agent=setup?.agents.find(item=>item.id===id);return !setup?{label:'',connected:false}:agent?.link||agent?.entry?{label:'Linked',connected:true}:agent?.seenAt?{label:'Used before',connected:true}:agent?.found?{label:'Not linked',connected:false}:{label:'Not found',connected:false};};
  const showAgain=async()=>{try{await api('/api/setup/seen',{method:'DELETE'});window.dispatchEvent(new Event('ros-setup-reset'));}catch(cause){setErrors(current=>({...current,setup:message(cause)}));}};
  // Claude Code and Codex each run three ways: inside ros.ai on a plan or an API key, or as the person's own agent through MCP.
  const claudePlan={label:claude?.plan.state==='signed-in'?'Signed in':claude?.plan.state==='unavailable'?'Unavailable':!claude||claude.plan.state==='unknown'?'Checking…':'Not signed in',connected:claude?.plan.state==='signed-in'};
  const chatgptPlan=!projectId?{label:'Open a project',connected:false}:!codex?{label:'Checking…',connected:false}:codex.chatgptSignedIn?{label:'Signed in',connected:true}:{label:'Not signed in',connected:false};
  const codexOnKey=codexWay?.billing==='api-key';
  // Connected, the row names the way in use; the person's own agent counts when neither way inside ros.ai is set up.
  const ways=(inApp:{label:string;connected:boolean},terminal:SetupAgentId)=>inApp.connected||!own(terminal).connected?inApp:{label:'Your own',connected:true};
  const stateOf=(id:AgentId)=>isAcpAgent(id)?acpState(acp.find(item=>item.id===id)):id==='ros'?(cloud?.state==='signed-in'?{label:'Signed in',connected:true}:local?.state==='ready'?{label:'On this computer',connected:true}:{label:'Not connected',connected:false}):id==='claude'?ways(claude?.billing==='plan'?(claudePlan.connected?{label:'Claude plan',connected:true}:claudePlan):key('claude').connected?{label:'API key',connected:true}:key('claude'),'claude-code'):id==='codex'?ways(codexOnKey?(key('openai').connected?{label:'API key',connected:true}:key('openai')):codex?.signedIn?{label:'ChatGPT plan',connected:true}:{label:'Not connected',connected:false},'codex'):id==='own-cursor'?own('cursor'):id==='own-gemini'?own('gemini-cli'):id==='own-pi'?own('pi'):id==='own-hermes'?own('hermes'):id==='nebius'?key('nebius'):id==='openai'?key('openai'):setup?.models.some(item=>item.connectionId)?{label:'Connected',connected:true}:{label:setup?.models.some(item=>item.running)?'Not connected':'',connected:false};
  const installedKey=agentItems.filter(item=>stateOf(item.id).connected).map(item=>item.id).join(',');
  useEffect(()=>{onInstalled(installedKey?installedKey.split(',') as AgentId[]:[]);},[installedKey,onInstalled]);
  if(publicDemo)return <p className="rail-page-note">This demo cannot connect models. Launch the local workspace to connect your own.</p>;
  const cards:Record<AgentId,()=>ReactNode>={
    ros:()=><><CloudAccount onChanged={changed}/><LocalRos onChanged={changed}/></>,
    nebius:()=><KeyConnection forceOpen provider="nebius" label="Nebius Token Factory" icon={<BrandLogo id="nebius"/>} credential={credentials.find(item=>item.provider==='nebius')} usage={connections.find(item=>item.provider==='nebius')} budget={budgets.find(item=>item.provider==='nebius')} description="Open models through your Token Factory API key." keyLink="https://tokenfactory.nebius.com/" onSave={saved} onDisconnect={disconnected} onCheck={async()=>{await post('/api/connections/nebius/check');await refresh();}}/>,
    claude:()=><>
      <InsideRos agent="Claude Code">{claude?.planAllowed&&<WayChoice name="claude-billing" label="How Claude Code is paid for" value={claude.billing} ways={[{id:'plan',title:'Claude plan',detail:'Your Pro or Max subscription. No per-use charges.',state:claudePlan},{id:'api-key',title:'Claude API key',detail:'Pay per use, billed by Anthropic.',state:key('claude')}]} onChoose={async billing=>setClaude(await api<ClaudeAgentSettings>('/api/agents/claude',{method:'PUT',body:JSON.stringify({billing})}))}/>}</InsideRos>
      {claude?.billing==='plan'?<ClaudePlanConnection settings={claude} loadError={errors.claude} onChanged={setClaude}/>:<KeyConnection forceOpen provider="claude" label="Claude API key" icon={<BrandLogo id="claude"/>} credential={credentials.find(item=>item.provider==='claude')} budget={budgets.find(item=>item.provider==='claude')} description="Claude Code as the project assistant, billed to your Claude API key. Choose Claude Code in the assistant's settings to use it." keyLink="https://platform.claude.com/settings/keys" loadError={errors.claude} onSave={saved} onDisconnect={disconnected} onCheck={async()=>{await post('/api/connections/claude/check');await refresh();}}>{claude&&<><ClaudeModelChoice settings={claude} onChanged={setClaude}/><ClaudeWebSearchChoice settings={claude} onChanged={setClaude}/></>}</KeyConnection>}
      <FromTerminal agent="Claude Code" only="claude-code" onChanged={changed}/>
    </>,
    codex:()=><>
      <InsideRos agent="Codex">{codexWay&&<WayChoice name="codex-billing" label="How Codex is paid for" value={codexWay.billing} ways={[{id:'plan',title:'ChatGPT plan',detail:'Your Plus or Pro subscription. No per-use charges.',state:chatgptPlan},{id:'api-key',title:'OpenAI API key',detail:'Pay per use, billed by OpenAI.',state:key('openai')}]} onChoose={async billing=>{setCodexWay(await api<CodexAgentSettings>('/api/agents/codex',{method:'PUT',body:JSON.stringify({billing})}));await changed();}}/>}{errors.codexWay&&<p className="inline-error" role="alert">{errors.codexWay}</p>}</InsideRos>
      {codexOnKey?<KeyConnection forceOpen provider="openai" label="OpenAI API key" icon={<BrandLogo id="openai"/>} credential={credentials.find(item=>item.provider==='openai')} budget={budgets.find(item=>item.provider==='openai')} description="Codex as the project assistant, billed to your OpenAI API key, the same key Ros uses for GPT models. Choose Codex in the assistant's settings to use it." keyLink="https://platform.openai.com/api-keys" loadError={errors.codex} onSave={saved} onDisconnect={disconnected}>{codexWay&&<CodexModelChoice settings={codexWay} onChanged={setCodexWay}/>}{codex&&!codex.available&&<p className="connection-limit">{!codex.installed?'Install the Codex CLI on this computer first. ros.ai runs it with your key.':!codex.isolationReady?'This Codex version can’t keep Codex to the project. Update the Codex CLI.':codex.blockers[0]}</p>}</KeyConnection>:<CodexConnection projectId={projectId} setup={codex} error={errors.codex} onChanged={changed}/>}
      <FromTerminal agent="Codex" only="codex" onChanged={changed}/>
    </>,
    openai:()=><KeyConnection forceOpen provider="openai" label="OpenAI API" icon={<BrandLogo id="openai"/>} credential={credentials.find(item=>item.provider==='openai')} usage={connections.find(item=>item.provider==='openai')} budget={budgets.find(item=>item.provider==='openai')} description="GPT models for Ros through your OpenAI API key. Codex can run on the same key." keyLink="https://platform.openai.com/api-keys" onSave={saved} onDisconnect={disconnected}/>,
    ...Object.fromEntries((['gemini','goose','opencode'] as const).map(id=>[id,()=><AcpAgentCard status={acp.find(item=>item.id===id)} onChanged={value=>setAcp(list=>list.map(item=>item.id===value.id?value:item))}/>])) as Record<'gemini'|'goose'|'opencode',()=>ReactNode>,
    'own-cursor':()=><OutsideAgents only="cursor" onChanged={changed}/>,
    'own-gemini':()=><OutsideAgents only="gemini-cli" onChanged={changed}/>,
    'own-pi':()=><OutsideAgents only="pi" onChanged={changed}/>,
    'own-hermes':()=><OutsideAgents only="hermes" onChanged={changed}/>,
    local:()=><LocalModels hide={[local?.connectionId]} onChanged={changed}/>,
  };
  const current=selected?agentItems.find(item=>item.id===selected):undefined;
  if(current)return <div className="plugins-page plugin-detail">
    <CatalogueHero crumb="Agents" onBack={()=>onSelect(null)} mark={current.mark} name={current.name} summary={<>{current.title??current.summary}<span className="plugin-billing">{current.id==='claude'&&claude?.billing==='plan'?'Runs on your Claude plan; no API charges':current.id==='codex'&&codexOnKey?'Billed per use to your OpenAI API key':billingLine[current.id]}</span></>} state={current.id==='local'&&!stateOf('local').label?undefined:stateOf(current.id)} uses={current.uses}/>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {(errors.credentials||errors.budgets)&&<p className="inline-error" role="alert">{errors.credentials||errors.budgets}</p>}
    {current.id!=='claude'&&current.id!=='codex'&&<h2 className="plugin-section">Connection</h2>}
    {cards[current.id]()}
    <p className="plugins-footnote">{isAcpAgent(current.id)?'It keeps its own sign-in and model; ros.ai never sees either.':'Keys stay on the local server. What each spends shows in Settings › Usage.'}</p>
  </div>;
  return <div className="plugins-page">
    <header className="plugins-head"><div><h1>Agents</h1><p>Agents from any vendor and the models they run on, connected the same way</p></div><button className="icon-button" disabled={loading} aria-label="Refresh agent status" title="Refresh status; no model turn" onClick={()=>void refresh()}><RefreshCw size={15} className={loading?'spin':''}/></button></header>
    {notice&&<p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {(errors.credentials||errors.budgets)&&<p className="inline-error" role="alert">{errors.credentials||errors.budgets}</p>}
    {agentGroups.map(group=>({...group,ids:[...(['claude','codex'] as AgentId[]).filter(id=>group.billing===((id==='claude'?claude?.billing==='plan':!codexOnKey)?'plan':'key')),...group.ids]})).map(group=><section key={group.billing} className="plugin-group"><h2>{group.title}</h2>{group.why&&<p className="plugin-group-why">{group.why}</p>}<div className="plugin-grid">{group.ids.map(id=>{const item=agentItems.find(entry=>entry.id===id)!;return <CatalogueRow key={id} mark={item.mark} name={item.name} summary={item.summary} state={stateOf(id)} onClick={()=>onSelect(id)}/>;})}</div></section>)}
    <p className="plugins-footnote"><button type="button" className="text-button" onClick={()=>void showAgain()}>Show the setup screen again</button></p>
  </div>;
}

/** The left column on the Agents page: its sections and what is connected. */
export function AgentsSidebar({installed,selected,onSelect}:{installed:AgentId[];selected:AgentId|null;onSelect:(id:AgentId|null)=>void}) {
  return <CatalogueSidebar sections={[{id:'agents',label:'Agents'}]} installed={installed.map(id=>{const item=agentItems.find(entry=>entry.id===id)!;return {id,name:item.name,mark:<span className="plugins-mark-small">{id==='ros'?<RosMark/>:isAcpAgent(id)?<BrandLogo id={acpLogo[id]} size={16}/>:id==='own-cursor'?<AgentIcon id="cursor" size={16}/>:id==='own-gemini'?<AgentIcon id="gemini-cli" size={16}/>:id==='own-pi'?<AgentIcon id="pi" size={16}/>:id==='own-hermes'?<AgentIcon id="hermes" size={16}/>:<BrandLogo id={id==='claude'?'claude':id==='codex'?'codex':id==='nebius'?'nebius':id==='openai'?'openai':'ollama'} size={16}/>}</span>};})} selected={selected} onSelect={id=>onSelect(id as AgentId|null)} note="Every agent and model that can work in your projects. Click one to manage its key and model."/>;
}

/** Claude Code and Codex inside ros.ai: ros.ai runs the agent, on the person's plan or their API key. */
function InsideRos({agent,children}:{agent:string;children:ReactNode}) {
  return <><h2 className="plugin-section">Inside ros.ai</h2><p className="plugin-section-why">ros.ai runs {agent} for you. Choose who pays.</p>{children}</>;
}
/** The person's own Claude Code or Codex, working on the map from their terminal through ros.ai's MCP server. */
function FromTerminal({agent,only,onChanged}:{agent:string;only:SetupAgentId;onChanged:()=>Promise<unknown>}) {
  return <><h2 className="plugin-section">From your terminal</h2><p className="plugin-section-why">Keep using {agent} yourself. It works on the map through ros.ai’s MCP server.</p><OutsideAgents only={only} onChanged={onChanged}/></>;
}
/** Who pays for an agent ros.ai runs, each way with its own state: Claude plan or Claude API key, ChatGPT plan or OpenAI API key. */
function WayChoice<T extends ClaudeBilling|CodexBilling>({name,label,value,ways,onChoose}:{name:string;label:string;value:T;ways:{id:T;title:string;detail:string;state:{label:string;connected:boolean}}[];onChoose:(id:T)=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const choose=async(id:T)=>{setBusy(true);setError('');try{await onChoose(id);}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  return <div className="claude-billing" role="radiogroup" aria-label={label}>{ways.map(way=><label key={way.id} className={value===way.id?'selected':''}><input type="radio" name={name} checked={value===way.id} disabled={busy} onChange={()=>void choose(way.id)}/><span><strong>{way.title}</strong><small>{way.detail}</small></span>{way.state.label&&<span className={`connection-state ${way.state.connected?'connected':''}`}><i/>{way.state.label}</span>}</label>)}{error&&<p className="inline-error" role="alert">{error}</p>}</div>;
}
/** On an OpenAI API key the model decides the price per turn; on a ChatGPT plan Codex picks its own. */
function CodexModelChoice({settings,onChanged}:{settings:CodexAgentSettings;onChanged:(value:CodexAgentSettings)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const choose=async(model:CodexApiModel)=>{setBusy(true);setError('');try{onChanged(await api<CodexAgentSettings>('/api/agents/codex',{method:'PUT',body:JSON.stringify({model})}));}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  return <div className="claude-model-choice"><label className="field-label" htmlFor="codex-model">Model</label><select id="codex-model" value={settings.model} disabled={busy} onChange={event=>void choose(event.target.value as CodexApiModel)}>{settings.models.map(item=><option key={item.id} value={item.id}>{item.label} · {item.detail}</option>)}</select>
    <p className="subtle">Each turn is billed to your OpenAI API key and shows in Settings › Usage. Codex reads only what ros.ai gives it and proposes changes through ros.ai’s tools.</p>{error&&<p className="inline-error" role="alert">{error}</p>}</div>;
}
/** Claude Code on the person's own Claude plan. Claude Code signs in through Anthropic's own page; ros.ai never sees the login. */
function ClaudePlanConnection({settings,loadError,onChanged}:{settings:ClaudeAgentSettings;loadError?:string;onChanged:(value:ClaudeAgentSettings)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[login,setLogin]=useState<ClaudePlanLogin|null>(settings.login);
  const plan=settings.plan,signedIn=plan.state==='signed-in';
  useEffect(()=>{
    if(login?.state!=='waiting')return;
    let disposed=false,active=false;
    const timer=window.setInterval(()=>{if(active)return;active=true;void api<ClaudeAgentSettings>('/api/agents/claude').then(value=>{if(disposed)return;setLogin(value.login);if(value.login?.state!=='waiting')onChanged(value);}).catch(cause=>{if(!disposed)setError(message(cause));}).finally(()=>{active=false;});},2000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[login?.state]);
  const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const account=[plan.email,plan.plan&&`${plan.plan[0]!.toUpperCase()}${plan.plan.slice(1)} plan`].filter(Boolean).join(' · ');
  return <ConnectionCard label="Claude plan" icon={<BrandLogo id="claude"/>} subtitle={signedIn&&account?account:undefined} forceOpen connected={signedIn} status={plan.state==='unknown'?'Checking…':signedIn?'Signed in':plan.state==='unavailable'?'Unavailable':'Not signed in'}>
    <p>{signedIn?'Claude Code answers as the project assistant on your Claude plan. Choose Claude Code in the assistant’s settings to use it.':'Sign in with the Claude account that has your plan. If you already use Claude Code on this computer, that sign-in is used.'}</p>
    <ClaudeModelChoice settings={settings} onChanged={onChanged}/>
    <p className="subtle">Claude Code searches the web and reads pages itself when it needs to. On your plan that costs nothing extra.</p>
    {plan.state==='unavailable'&&<p className="connection-limit">{plan.message}</p>}
    {plan.message&&plan.state==='signed-out'&&<p className="connection-limit">{plan.message}</p>}
    {!signedIn&&plan.state!=='unavailable'&&login?.state!=='waiting'&&<div className="connection-actions"><button className="primary small" disabled={busy} onClick={()=>void run(async()=>setLogin(await post<ClaudePlanLogin>('/api/agents/claude/plan-login',{})))}>Sign in with Claude</button><button className="text-button" disabled={busy} onClick={()=>void run(async()=>onChanged(await api<ClaudeAgentSettings>('/api/agents/claude')))}>Check again</button></div>}
    {login&&!signedIn&&<div className="connection-login" role="status"><p>{login.message}</p>{login.state==='waiting'&&<button className="text-button" onClick={()=>void run(async()=>setLogin(await post<ClaudePlanLogin>('/api/agents/claude/plan-login/cancel',{})))}>Cancel sign-in</button>}{login.command&&login.state!=='completed'&&<details><summary>Browser didn’t open?</summary><p>Sign in from Terminal instead, then press Check again:</p><CommandBox command={login.command} label="Copy sign-in command"/></details>}</div>}
    <p className="subtle">Claude Code signs in on Anthropic’s own page and keeps its login itself. ros.ai never sees or stores it.</p>
    {(error||loadError)&&<p className="inline-error" role="alert">{error||loadError}</p>}
  </ConnectionCard>;
}
/** On an API key both ways of searching cost money, so the researcher picks one; on a plan Claude Code always uses its own. */
function ClaudeWebSearchChoice({settings,onChanged}:{settings:ClaudeAgentSettings;onChanged:(value:ClaudeAgentSettings)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const choose=async(webSearch:ClaudeWebSearch)=>{setBusy(true);setError('');try{onChanged(await api<ClaudeAgentSettings>('/api/agents/claude',{method:'PUT',body:JSON.stringify({webSearch})}));}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const choices:{id:ClaudeWebSearch;title:string;detail:string}[]=[
    {id:'own',title:'Claude searches by itself',detail:'Simplest. Claude looks things up as it works. About US$0.01 per search plus the pages it reads, billed to this API key.'},
    {id:'ros',title:'ros.ai search plan',detail:'Claude plans its searches on the map, one note per direction, and runs them on the web search service you connect on the Plugins page (Tavily, Exa or Brave).'},
  ];
  return <div className="claude-model-choice"><span className="field-label">Web search</span><div className="claude-billing" role="radiogroup" aria-label="How Claude Code searches the web">{choices.map(choice=><label key={choice.id} className={settings.webSearch===choice.id?'selected':''}><input type="radio" name="claude-web-search" checked={settings.webSearch===choice.id} disabled={busy} onChange={()=>void choose(choice.id)}/><span><strong>{choice.title}</strong><small>{choice.detail}</small></span></label>)}</div>{error&&<p className="inline-error" role="alert">{error}</p>}</div>;
}
function ClaudeModelChoice({settings,onChanged}:{settings:ClaudeAgentSettings;onChanged:(value:ClaudeAgentSettings)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const choose=async(model:ClaudeModel)=>{setBusy(true);setError('');try{onChanged(await api<ClaudeAgentSettings>('/api/agents/claude',{method:'PUT',body:JSON.stringify({model})}));}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  return <div className="claude-model-choice"><label className="field-label" htmlFor="claude-model">Model</label><select id="claude-model" value={settings.model} disabled={busy} onChange={event=>void choose(event.target.value as ClaudeModel)}>{settings.models.map(item=><option key={item.id} value={item.id}>{item.label} · {item.detail}</option>)}</select>
    <p className="subtle">{settings.billing==='plan'?'Each turn counts toward your Claude plan’s usage limits.':'Each turn is billed to your Claude API key and shows in Settings › Usage.'} It reads this project's folder and proposes changes; code runs in ros.ai's sandbox under your permission choice.</p>{error&&<p className="inline-error" role="alert">{error}</p>}</div>;
}

export function ConnectionCard({label,icon,status,subtitle,connected,forceOpen,children}:{label:string;icon:ReactNode;status:string;subtitle?:string;connected?:boolean;forceOpen?:boolean;children:ReactNode}) {
  const [expanded,setExpanded]=useState(false);
  useEffect(()=>{if(forceOpen)setExpanded(true);},[forceOpen]);
  return <section className="tool-connection" aria-label={`${label} connection`}><details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary className="tool-connection-heading"><span className="tool-connection-icon">{icon}</span><span className="tool-connection-name"><strong>{label}</strong>{subtitle&&<small>{subtitle}</small>}</span><span className={`connection-state ${connected?'connected':''}`}><i/>{status}</span><ChevronDown size={14} className="connection-chevron"/></summary><div className="tool-connection-body">{children}</div></details></section>;
}
export function KeyConnection({provider,label,icon,credential,budget,description,keyLink,loadError,forceOpen,onSave,onDisconnect,onCheck,primary,children}:{provider:CredentialProvider;label:string;icon:ReactNode;credential?:CredentialStatus;usage?:ConnectionStatus;budget?:ConnectionBudgetStatus;description:string;keyLink:string;loadError?:string;forceOpen?:boolean;children?:ReactNode;onSave:(provider:CredentialProvider,key:string)=>Promise<void>;onDisconnect:(provider:CredentialProvider)=>Promise<void>;onCheck?:()=>Promise<void>;/** The one action the card leads with, beside its key button. */primary?:{label:string;onClick:()=>Promise<void>}}) {
  const [open,setOpen]=useState(false),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const configured=credential?.configured??false;
  const ready=budget?.ready??false;
  const subtitle=!budget?'Checking…':budget.limited===false?(ready?undefined:budget.reason):budget.source==='app'?`US$${budget.limitUsd.toFixed(2)} budget · ${!budget.enabled?'paused':ready?'enabled':'limit reached'}`:ready?'Usage enabled':'Usage not enabled';
  return <ConnectionCard label={label} icon={icon} subtitle={subtitle} forceOpen={forceOpen} connected={configured&&credential?.verified!==false} status={!credential?'Checking…':credential.verified===false?'Check failed':configured?'Key configured':'Not connected'}>
    <p>{description}</p>
    {children}
    {credential?.checkMessage&&<p className={credential.verified?'connection-check':'inline-error'} role="status">{credential.checkMessage}</p>}
    <div className="connection-actions">{primary&&<button className="primary small" disabled={busy} onClick={()=>void run(primary.onClick)}>{primary.label}</button>}<button className="secondary small" disabled={busy||!credential} aria-expanded={open} onClick={()=>{setOpen(!open);setKey('');setError('');}}>{open?'Close setup':configured?'Manage key':'Connect'}</button>{onCheck&&configured&&<button className="text-button" disabled={busy} onClick={()=>void run(onCheck)}>{busy?'Checking…':'Check key'}</button>}</div>
    {open&&<div className="connection-setup"><p>Paste a key from <a href={keyLink} target="_blank" rel="noreferrer">{label}<ExternalLink size={11}/></a>. It is saved privately on the local server.</p>{credential?.source==='environment'&&<p className="subtle">A key is already set in the server environment. A saved key will override it; removing the saved key restores that setting.</p>}
      <form onSubmit={event=>{event.preventDefault();if(busy)return;void run(async()=>{await onSave(provider,key);setKey('');setOpen(false);});}}><label className="field-label" htmlFor={`connection-key-${provider}`}>API key</label><input id={`connection-key-${provider}`} type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder="Paste your API key" required minLength={12} maxLength={4096}/><button className="primary small" type="submit" disabled={busy||key.trim().length<12}>{busy?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>} Save connection</button></form>
      {credential?.canDisconnect&&<button className="text-button danger" disabled={busy} onClick={()=>void run(()=>onDisconnect(provider))}>Remove saved key</button>}

    </div>}
    {configured&&budget&&!ready&&<p className="connection-limit">{budget.reason||'Usage is not enabled yet.'}</p>}
    {(error||loadError)&&<p className="inline-error" role="alert">{error||loadError}</p>}
  </ConnectionCard>;
}

function CodexConnection({projectId,setup,error:loadError,onChanged}:{projectId:string|null;setup?:LocalAgentSetup;error?:string;onChanged:()=>Promise<void>}) {
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
  return <ConnectionCard label="ChatGPT plan" icon={<BrandLogo id="codex"/>} subtitle={setup?.available?'Research available':'Research blocked'} forceOpen connected={setup?.signedIn} status={!projectId?'Choose a project':!setup?'Checking…':setup.signedIn?'Signed in':'Not connected'}>
    <p>{limitation}</p><div className="connection-actions"><button className="secondary small" disabled={!projectId} aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'Close setup':setup?.signedIn?'Connection details':'Connect'}</button></div>
    {open&&<div className="connection-setup"><p>{setup?.installed?`Installed: ${setup.version}.`:'Install Codex CLI, then refresh connection status.'} Sign-in is handled by Codex. ros.ai never copies its account credentials.</p>
      {setup?.installed&&!setup.signedIn&&login?.state!=='waiting'&&<div className="connection-actions"><button className="primary small" disabled={busy} onClick={()=>void start('browser')}>Sign in with Codex</button><button className="secondary small" disabled={busy} onClick={()=>void start('device')}>Use device code</button></div>}
      {login&&<div className="connection-login" role="status"><p>{login.message}</p>{login.state==='waiting'&&<>{login.authUrl&&<a className="primary small" href={login.authUrl} target="_blank" rel="noreferrer">Open Codex sign-in <ExternalLink size={12}/></a>}{login.userCode&&<p>Enter code <strong>{login.userCode}</strong> in the Codex sign-in page.</p>}<button className="text-button" onClick={async()=>{try{setLogin(await post<CodexLoginStatus>(`/api/projects/${projectId}/agents/codex/login/${login.id}/cancel`,{}));}catch(cause){setError(message(cause));}}}>Cancel sign-in</button></>}</div>}
      {setup&&<><dl className="connection-facts"><dt>Sign-in</dt><dd>{setup.signedIn?'Detected':'Required'}</dd><dt>Workspace isolation</dt><dd>{setup.isolationReady?'Supported':'Unavailable in installed CLI'}</dd><dt>Usage permission</dt><dd>{setup.authorized?'Bounded grant configured':'No fresh grant'}</dd><dt>Research turns</dt><dd>{setup.available?'Available':'Blocked'}</dd></dl><details><summary>Setup and enforcement details</summary>{setup.blockers.map((blocker,index)=><p key={index}>{blocker}</p>)}{setup.commands.map(item=><div key={item.command}><span>{item.label}</span><pre>{item.command}</pre></div>)}</details>{setup.links.map(link=><a className="connection-doc" key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label}<ExternalLink size={11}/></a>)}</>}
    </div>}{setup?.signedIn&&!setup.authorized&&<p className="connection-limit">Codex cannot start a turn in this project right now.</p>}{(error||loadError)&&<p className="inline-error" role="alert">{error||loadError}</p>}
  </ConnectionCard>;
}

export function GoogleDriveConnectionCard({projectId,status,loadError,onChanged,onImported,onResources}:{projectId:string|null;status:GoogleDriveStatus|null;loadError?:string;onChanged:()=>Promise<void>;onImported:()=>Promise<void>;onResources:()=>void}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[consent,setConsent]=useState(false),[query,setQuery]=useState(''),[files,setFiles]=useState<GoogleDriveFiles|null>(null),[imported,setImported]=useState<string[]>([]);
  const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(cause){setError(message(cause));}finally{setBusy(false);}};
  const browse=async(pageToken?:string)=>{const result=await api<GoogleDriveFiles>(`/api/connections/google-drive/files?${new URLSearchParams({query,...(pageToken?{pageToken}:{})})}`);setFiles(result);};
  return <ConnectionCard label="Google Drive" icon={<BrandLogo id="google-drive"/>} subtitle="Read-only Sheets, Docs and CSV files" connected={status?.connected} status={!status?'Checking…':status.connected?'Connected':status.state==='reconnect-required'?'Reconnect':'Not connected'}>
    <p>Show Google Sheets and Docs live on the canvas, let agents read them, and copy CSV files into this project.</p><div className="connection-actions"><button className="secondary small" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'Close setup':status?.connected?'Browse files':'Connect'}</button>{status?.connected&&<button className="text-button" disabled={!projectId} onClick={onResources}>Resources</button>}</div>
    {open&&<div className="connection-setup">
      {!status?.configured?<><p>Create a Google OAuth app for your local workspace, enable the Drive and Sheets APIs, and register this redirect URI:</p><code className="connection-callback">{status?.callbackUri||'Loading callback…'}</code><GoogleOAuthForm busy={busy} onSave={value=>run(async()=>{await api('/api/connections/google-drive/config',{method:'PUT',body:JSON.stringify(value)});await onChanged();})}/>{status?.setup.documentation.map(link=><a className="connection-doc" href={link.url} target="_blank" rel="noreferrer" key={link.url}>{link.title}<ExternalLink size={11}/></a>)}<p className="subtle">Use a Web application client. While Google’s consent app is in testing, add your own account as a test user.</p></>:
      !status.connected?<><p className="connection-limit">Google consent grants read access to all Drive files. ros.ai reads the Sheets and Docs your blocks show and your agents look up, and only the CSV files you select. It cannot write to Drive.</p><label className="connection-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/> Allow Drive read access for this connection</label><button className="primary small" disabled={busy||!consent} onClick={()=>void run(async()=>{const result=await post<{authorizationUrl:string}>('/api/connections/google-drive/connect',{});window.location.assign(result.authorizationUrl);})}>Continue to Google</button><p className="subtle">You choose the account and finish consent in Google. The authorization returns to this local workspace.</p></>:
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

/** The person's own Claude Code, Codex, Cursor or Gemini CLI, on their own plan, using ros.ai as an MCP server. */
function OutsideAgents({only,onChanged}:{only:SetupAgentId;onChanged?:()=>Promise<unknown>}) {
  const [setup,setSetup]=useState<SetupStatus>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[note,setNote]=useState<LinkResult>();
  const load=useCallback(async(rescan=false)=>{try{setSetup(await api<SetupStatus>(`/api/setup${rescan?'?rescan=1':''}`));}catch(cause){setError(message(cause));}},[]);
  useEffect(()=>{void load();},[load]);
  const act=async(remove:boolean)=>{
    setBusy(true);setError('');
    try{const result=remove?await api<LinkResult>(`/api/setup/links/${only}`,{method:'DELETE'}):(await post<SetupLinkResponse>('/api/setup/links',{agents:[only]})).agents[0];if(result)setNote(result);await load(true);await onChanged?.();}
    catch(cause){setError(message(cause));}finally{setBusy(false);}
  };
  const agent=setup?.agents.find(item=>item.id===only);
  if(!agent)return error?<p className="inline-error" role="alert">{error}</p>:<p className="subtle">Looking on this computer…</p>;
  const linked=Boolean(agent.link||agent.entry);
  const status=linked?'Linked':agent.found?'Not linked':agent.seenAt?'Seen before':'Not found';
  const day=(value:string)=>new Date(value).toLocaleDateString([],{day:'numeric',month:'short'});
  const subtitle=[agent.link?`Linked ${day(agent.link.writtenAt)}`:agent.entry?'Linked outside ros.ai':agent.found?`Found${agent.signals.length?` · ${agent.signals.join(' · ')}`:''}`:'Not found on this computer',agent.seenAt?`Seen ${date(agent.seenAt)}${agent.seenIn?` in ${agent.seenIn}`:''}`:''].filter(Boolean).join(' · ');
  return <ConnectionCard label={`Your own ${agent.label}`} icon={<AgentIcon id={agent.id} size={22}/>} subtitle={subtitle} connected={linked} status={status}>
    <p>{agentWhy[agent.id]}{agent.note?` ${agent.note}`:''} While ros.ai is open, {agent.label} can read the map and propose notes, reports and analysis code through ros.ai’s MCP server. Proposals follow your approval mode. Started inside a project’s folder, it works in that project.</p>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {note&&<p className={note.ok?'connection-notice':'inline-error'} role="status">{note.message}</p>}
    <div className="connection-actions">
      {!linked&&agent.linkable&&<button className="primary small" disabled={busy} onClick={()=>void act(false)}>{busy&&<LoaderCircle size={13} className="spin"/>}Link</button>}
      {agent.entry&&!agent.link&&agent.linkable&&<button className="secondary small" disabled={busy} onClick={()=>void act(false)}>Relink to this ros.ai</button>}
      {linked&&<button className="text-button" disabled={busy} onClick={()=>void act(true)}>Undo link</button>}
    </div>
    <p className="subtle">The link is one entry in {agent.target}. {agent.method==='cli'?'To add it yourself, paste this once in a terminal:':'To add it yourself, put this entry under mcpServers:'}</p>
    <CommandBox command={note&&!note.ok&&note.command?note.command:agent.command} label={agent.label}/>
  </ConnectionCard>;
}
