import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, FileText, Clock3, FolderOpen, GitBranch, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeft, PanelLeftClose, PanelLeftOpen, Pin, Plus, Square, Trash2, X } from 'lucide-react';
import type { Artifact, Canvas, CanvasNode, Change, ConnectionStatus, GoogleRead, GoogleView, TrainingRead, TrainingView, Mutation, NodeKind, NotionRead, NotionView, Project, ProjectDetail, Proposal } from '../shared/types';
import { checkSourcesRequest } from '../shared/source-check';
import type { ResearchPolicy } from '../shared/research';
import { api, post, upload } from './api';
import { emptyPosition, previewCanvas, ResearchCanvas, shownFile } from './Canvas';
import { fileMediaType } from '../shared/files';
import { BrandLogo } from './brand-logos';
import { kindName, labelFixed, labelPatch } from '../shared/vocabulary';
import { ArtifactViewer } from './ArtifactViewer';
import { ReportEditor } from './ReportEditor';
import { date, RichText, time } from './Content';
import { Inspector } from './Inspector';
import { CodeBlock, blankCode } from './CodeBlock';
import { NotebookView } from './notebook/NotebookView';
import { WorkspaceGuide } from './WorkspaceGuide';
import { ResultActions } from './ResultActions';
import { PolicyPanel } from './ResearchControls';
import { readSaved, saveLocal } from './persistence';
import { layoutOnly } from '../shared/canvas-position';
import { arrivedGroups, groupMembers, isGroup, proposedGroups } from '../shared/groups';
import { AssistantPanel } from './AssistantPanel';
import { RosBar, type RosMode } from './RosDock';
import { shownThread, type ShownThread } from './RosThreads';
import { useLiveTurns, withLive } from './live-reply';
import { NoteTree } from './NoteTree';
import { Resources } from './Resources';
import { DemoTour, demoEvidence } from './DemoTour';
import { ExecutableDemo } from './ExecutableDemo';
import { WorkflowDemo } from './WorkflowDemo';
import type { TutorialScenario, TutorialSession } from '../shared/tutorial';
import { NewProjectCard, StartScreen } from './StartCard';
import { NetworkPrompt } from './NetworkPrompt';
import { BalanceSettings, GeneralSettings, SettingsSidebar, UsageSettings, type SettingsSection } from './SettingsPage';
import { PluginsPage, PluginsSidebar, lastInstalledPlugins } from './PluginsPage';
import { SkillsPage, SkillsSidebar, lastSkills, type SkillItem } from './SkillsPage';
import { AgentsSidebar, lastInstalledAgents, type AgentId } from './ModelPage';
import { PLUGINS, type PluginId } from '../shared/plugins';
import { MemoryPage } from './MemoryPage';
import { AppRail, RailPageFrame, type RailPage } from './AppRail';
import { Modal } from './Modal';
import { RemoveProjectDialog } from './RemoveProject';
import { blockKind, noteKindUse, type KindId, type NewBlockType } from './block-kinds';
import { AllBlocksWindow } from './AllBlocksWindow';
import { BlockSheet, LabelChip, readBlockViewMode, saveBlockViewMode, type BlockViewMode } from './BlockSheet';
import { ProfileButton } from './ProfileButton';
import { UpdateButton, UpdateOverlay } from './UpdateButton';
import { checkForUpdates } from './updates';
import { FeedbackButton } from './FeedbackButton';
import { RosDownloadChip } from './RosDownloadChip';
import { Wordmark } from './Brand';
import { SetupScreen } from './Setup';
import { FirstRun } from './FirstRun';
import type { SetupStatus } from '../shared/setup';
import { AgentReportReview } from './AgentReportReview';
import { AgentView } from './AgentView';
import { AppView } from './AppView';
import { APP_STARTER } from '../shared/apps';
import { ModelPage } from './ModelPage';
import { CanvasHistory } from './CanvasHistory';
import { FileBar, FolderChip, FolderPanel, useProjectFolder } from './ProjectFolder';
import './demo-polish.css';
import type { AssistantState, AssistantFocus, AssistantReference } from '../shared/assistant';
import type { OutsideAgentsStatus } from '../shared/outside-agents';

export function App(){
  // Each sidebar opens with what its page last found, saved on this computer, while the page reads again.
  const [agentId,setAgentId]=useState<AgentId|null>(null),[installedAgents,setInstalledAgents]=useState<AgentId[]>(lastInstalledAgents);
  const [pluginId,setPluginId]=useState<PluginId|null>(null),[installedPlugins,setInstalledPlugins]=useState<PluginId[]>(lastInstalledPlugins);
  const [skillName,setSkillName]=useState<string|null>(null),[skillList,setSkillList]=useState<SkillItem[]>(lastSkills);
  const [projectOpen,setProjectOpenState]=useState<boolean>(()=>readSaved('sidebar-project-open',true));const setProjectOpen=(open:boolean)=>{setProjectOpenState(open);saveLocal('sidebar-project-open',open);};
  const [projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState<string|null>(null),[detail,setDetail]=useState<ProjectDetail|null>(null);
  const [setup,setSetup]=useState<SetupStatus|null>(null),[setupOpen,setSetupOpen]=useState(false),[setupRun,setSetupRun]=useState(0);
  // The first run from the welcome page, in a window of its own; /app?welcome shows it on every load, to try it over and
  // over. setupChecked: the start screen waits until that is known.
  const [firstRun,setFirstRun]=useState(false),[setupChecked,setSetupChecked]=useState(false);
  const [connections,setConnections]=useState<ConnectionStatus[]>([]),[policy,setPolicy]=useState<ResearchPolicy|null>(null);
  const [selectedId,setSelectedId]=useState<string|null>(null),[expandedIds,setExpandedIds]=useState<string[]>([]),[focusId,setFocusId]=useState<string|null>(null),[frame,setFrame]=useState<{ids:string[];key:number}|null>(null);
  const [inspectorId,updateInspectorId]=useState<string|null>(null),[artifact,setArtifact]=useState<{value:Artifact;nodeId:string}|null>(null);
  const [dialog,setDialog]=useState<'policy'|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(0);
  const [newProject,setNewProject]=useState(false),[addWindow,setAddWindow]=useState<{scope:string|null;kind?:KindId}|null>(null),[sidebarOpen,setSidebarOpen]=useState(window.innerWidth>1100);
  const [previewId,setPreviewId]=useState<string|null>(null),[historyOpen,setHistoryOpen]=useState(false),[historical,setHistorical]=useState<Change|null>(null),[attachment,setAttachment]=useState<{artifact?:Artifact;nodeId?:string}|null>(null);
  const [assistant,setAssistant]=useState<AssistantState|null>(null),[rosMode,updateRosMode]=useState<RosMode>(()=>{const saved=readSaved<string>('ros-mode','bar');return saved==='half'||saved==='full'?saved:'bar';}),[page,setPage]=useState<RailPage>('canvas'),[chatBusy,setChatBusy]=useState<string|null>(null),[threadChoices,setThreadChoices]=useState<Record<string,string|null|undefined>>({}),[assistantLoadError,setAssistantLoadError]=useState(''),[chatPrefill,setChatPrefill]=useState('');
  /** The / menu of the ROS bar opens the Skills page. */
  const openSkills=useCallback(()=>{setPage('skills');setSkillName(null);},[]);
  const openPlugin=useCallback((id:PluginId)=>{setPage('plugins');setPluginId(id);},[]);
  // Back from an app's or Google's sign-in page: show that plugin, and take the marker out of the address.
  useEffect(()=>{const params=new URLSearchParams(window.location.search),id=params.get('app')??(params.has('googleDrive')?'google-drive':null);if(!id)return;window.history.replaceState(null,'',window.location.pathname);if(!PLUGINS.some(item=>item.id===id))return;setPage('plugins');setPluginId(id as PluginId);},[]);
  // Agent blocks show their turn's live state; the timeline itself stays with the assistant turn.
  const agentTurns=useMemo(()=>Object.fromEntries((assistant?.turns??[]).filter(turn=>turn.source==='claude-agent'||turn.source==='codex-agent'||turn.source==='model-agent'||turn.source==='acp-agent').map(turn=>[turn.id,{status:turn.status,runtime:turn.source==='claude-agent'?'Claude Code':turn.source==='model-agent'||turn.source==='acp-agent'?turn.model??'Agent':'Codex',thought:[...turn.events].reverse().find(event=>event.kind==='thought')?.message,pending:turn.actions.filter(item=>item.status==='pending'&&(!item.proposalId||detail?.proposals.find(proposal=>proposal.id===item.proposalId)?.status==='pending')).length}])),[assistant?.turns,detail?.proposals]);
  const [assistantFocus,setAssistantFocus]=useState<AssistantFocus>({nodeId:null}),[deleteCandidate,setDeleteCandidate]=useState<Project|null>(null),[projectMenu,setProjectMenu]=useState<string|null>(null);
  const [tourOpen,setTourOpen]=useState(false),[reportEditor,setReportEditor]=useState<{artifact?:Artifact}|null>(null),[agentReportId,setAgentReportId]=useState<string|null>(null);
  const [folderDialog,setFolderDialog]=useState(false);
  // An open block shows as a sheet over the map or a panel beside it; the choice sticks per project. Its conversation column starts closed.
  const [blockView,setBlockViewState]=useState<BlockViewMode>('sheet'),[blockChat,setBlockChat]=useState(false);
  useEffect(()=>{if(projectId)setBlockViewState(readBlockViewMode(projectId));},[projectId]);
  useEffect(()=>setBlockChat(false),[inspectorId]);
  const setBlockView=(mode:BlockViewMode)=>{setBlockViewState(mode);if(projectId)saveBlockViewMode(projectId,mode);};
  const setInspectorId=updateInspectorId;
  const [codeAttempt,setCodeAttempt]=useState<{nodeId:string;runId:string}|null>(null);
  const [outputGuide,setOutputGuide]=useState<{artifact:Artifact;destinationId:string}|null>(null);
  const [startFocus,setStartFocus]=useState(0),[demoSession,setDemoSession]=useState<TutorialSession|null>(null),[demoOpen,setDemoOpen]=useState(false),[demoOpenVersion,setDemoOpenVersion]=useState(0);
  useEffect(()=>setTourOpen(false),[projectId]);
  useEffect(()=>{let current=true;setDemoSession(null);setDemoOpen(false);if(projectId)void api<TutorialSession|null>(`/api/projects/${projectId}/demo-session`).then(session=>{if(current){setDemoSession(session);setDemoOpen(Boolean(session));}}).catch(()=>undefined);return()=>{current=false;};},[projectId]);
  const publicDemo=connections.some(connection=>connection.provider==='public-demo');
  const setRos=(mode:RosMode)=>{updateRosMode(mode);saveLocal('ros-mode',mode);};
  // Older callers open or close "the assistant"; opening keeps a full panel full and otherwise shows the half sheet.
  const updateRightPanel=(panel:'assistant'|null)=>updateRosMode(current=>panel?(current==='full'?'full':'half'):'bar');
  const setRightPanel=(panel:'assistant'|null)=>setRos(panel?(rosMode==='full'?'full':'half'):'bar');
  const rightPanel=rosMode==='full'?'assistant':null;
  useEffect(()=>{if(demoSession&&demoSession.scenario!=='workflow'&&!readSaved('demo-assistant-introduced',false)){saveLocal('demo-assistant-introduced',true);setRos('full');}},[demoSession?.projectId]);
  const assistantOpen=rosMode!=='bar';
  const setAssistantOpen=(open:boolean)=>setRightPanel(open?'assistant':null);
  const selectedProjectTitle=detail?.project.id===projectId?demoDisplayTitle(detail.project):projects.find(project=>project.id===projectId)&&demoDisplayTitle(projects.find(project=>project.id===projectId)!);
  useEffect(()=>{document.title=selectedProjectTitle?`${selectedProjectTitle} · ros.ai`:'ros.ai — Research workspace';},[selectedProjectTitle]);
  const focusSequence=useRef(0),refreshSequence=useRef(0),appliedRefresh=useRef(0);
  const focusWrites=useRef(new Map<string,Promise<void>>()),focusVersions=useRef(new Map<string,number>());
  const projectRef=useRef(projectId);projectRef.current=projectId;const errorTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const report=useCallback((cause:unknown)=>{setError(cause instanceof Error?cause.message:String(cause));if(errorTimer.current)clearTimeout(errorTimer.current);errorTimer.current=setTimeout(()=>setError(''),14000);},[]);
  const refresh=useCallback(async(id=projectRef.current,restoreFocus=false)=>{
    if(!id)return null;
    const request=++refreshSequence.current,focusAtStart=focusSequence.current;
    if(restoreFocus)await focusWrites.current.get(id);
    const [detailResult,policyResult,assistantResult]=await Promise.allSettled([api<ProjectDetail>(`/api/projects/${id}`),api<ResearchPolicy>(`/api/projects/${id}/policy`),api<AssistantState>(`/api/projects/${id}/assistant`)]);
    if(detailResult.status==='rejected')throw detailResult.reason;
    const next=detailResult.value;
    const nextAssistant=assistantResult.status==='fulfilled'?assistantResult.value:null;
    if(projectRef.current===id&&request>appliedRefresh.current){
      appliedRefresh.current=request;setDetail(next);noteRevision(id,next.project.revision);if(policyResult.status==='fulfilled')setPolicy(policyResult.value);if(nextAssistant){setAssistant(nextAssistant);setAssistantLoadError('');}else setAssistantLoadError(assistantResult.status==='rejected'?(assistantResult.reason instanceof Error?assistantResult.reason.message:String(assistantResult.reason)):'The saved conversation could not be loaded.');
      setAssistantFocus(current=>current.nodeId&&!next.project.canvas.nodes.some(node=>node.id===current.nodeId)?{nodeId:null}:current);
      if(nextAssistant&&restoreFocus&&focusAtStart===focusSequence.current){setAssistantFocus(nextAssistant.focus);setSelectedId(nextAssistant.focus.nodeId);}
      setProjects(current=>current.map(project=>project.id===id?next.project:project));
    }
    return next;
  },[]);
  useEffect(()=>{const changed=()=>{void refresh().catch(report);};window.addEventListener('ros-ai-model-settings',changed);return()=>window.removeEventListener('ros-ai-model-settings',changed);},[refresh,report]);
  useEffect(()=>{void Promise.all([api<Project[]>('/api/projects'),api<ConnectionStatus[]>('/api/connections')]).then(([list,providers])=>{setProjects(list);setConnections(providers);let last:string|null=null;try{last=localStorage.getItem('ros-ai-project');}catch{/* Storage can be blocked; fall back to the first project. */}setProjectId(list.some(p=>p.id===last)?last:list[0]?.id||null);}).catch(report).finally(()=>setLoading(false));return()=>{if(errorTimer.current)clearTimeout(errorTimer.current);};},[report]);
  useEffect(()=>{if(!projectId){setDetail(null);setAssistant(null);return;}try{localStorage.setItem('ros-ai-project',projectId);}catch{/* The service keeps the project; only the last-opened choice is lost. */}setDetail(null);setPolicy(null);setAssistant(null);setAssistantFocus({nodeId:null});setProjectMenu(null);setArtifact(null);setReportEditor(null);setAgentReportId(null);const saved=readSaved<{selectedId:string|null}>(`navigation:${projectId}`,{selectedId:null});setSelectedId(saved.selectedId);setExpandedIds(readSaved(`expanded-groups:${projectId}`,[]));setInspectorId(null);setDialog(null);setFolderDialog(false);setHistorical(null);setPreviewId(null);setHistoryOpen(false);void refresh(projectId,true).catch(report);},[projectId,refresh,report]);
  useEffect(()=>{if(projectId&&detail?.project.id===projectId){saveLocal(`navigation:${projectId}`,{selectedId,workNodeId:selectedId});saveLocal(`expanded-groups:${projectId}`,expandedIds);}},[projectId,detail?.project.id,selectedId,expandedIds]);
  // A group opens the first time it appears while the project is open (an agent's, a paste, an accepted proposal), so the
  // blocks put in it show; a group the person has already seen keeps the state they left it in. The guided demo frames
  // each step itself, so its groups keep the look it was made with.
  const seenGroups=useRef<{projectId:string;ids:Set<string>}|null>(null);
  useEffect(()=>{if(!detail)return;const canvas=detail.project.canvas,seen=seenGroups.current;if(seen?.projectId!==detail.project.id){seenGroups.current={projectId:detail.project.id,ids:new Set(canvas.nodes.filter(isGroup).map(node=>node.id))};return;}const arrived=arrivedGroups(seen.ids,canvas),guided=demoOpen&&demoSession?.projectId===detail.project.id;for(const node of canvas.nodes)if(isGroup(node))seen.ids.add(node.id);if(arrived.length&&!guided)setExpandedIds(current=>[...new Set([...current,...arrived])]);},[detail]);
  const hasActive=detail?.runs.some(run=>['running','queued'].includes(run.status))||Boolean(assistant?.activeTurnId),notebookRunning=Boolean(detail?.notebooks?.some(item=>item.running));
  const folder=useProjectFolder(projectId,detail?.project.id===projectId?detail.project.revision:undefined,!publicDemo,()=>{void refresh().catch(report);}),folderStatus=folder.status;
  const missingKey=folderStatus?.files.filter(file=>file.missing).map(file=>file.nodeId).sort().join(',')??'';
  const missingFiles=useMemo(()=>new Set(missingKey.split(',').filter(Boolean)),[missingKey]);
  const folderFiles=useMemo(()=>new Map(folderStatus?.files.map(file=>[file.nodeId,file])??[]),[folderStatus]);
  // The person's own Claude Code or Codex can propose changes from outside; show them as they arrive.
  useEffect(()=>{if(!projectId||publicDemo)return;let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,seen:string|undefined;
    const check=async()=>{try{const {activity}=await api<OutsideAgentsStatus>('/api/outside-agents');if(stopped)return;const at=activity[projectId];if(seen!==undefined&&at&&at!==seen){await refresh();setAssistantOpen(true);}seen=at??'';}catch{/* ros.ai is restarting; try again. */}if(!stopped)timer=setTimeout(check,document.visibilityState==='visible'?2500:10000);};
    void check();return()=>{stopped=true;clearTimeout(timer);};
  },[projectId,publicDemo,refresh]);
  // Replies stream over their own connection; the refresh above still brings actions, proposals and the canvas.
  const live=useLiveTurns(projectId,Boolean(assistant?.activeTurnId)||Boolean(chatBusy),()=>void refresh().catch(report)),liveAssistant=useMemo(()=>withLive(assistant,live),[assistant,live]);
  // The ROS thread shown for this project: the one chosen here, else the one saved, else the newest; null is a new thread not yet started. chatBusy names the thread a message is being sent in.
  const threadChoice=useMemo(()=>{if(!projectId)return undefined;if(projectId in threadChoices)return threadChoices[projectId];const saved=readSaved<string|null>(`ros-thread:${projectId}`,null);return saved==='new'?null:saved??undefined;},[projectId,threadChoices]);
  const threadId=shownThread(liveAssistant,threadChoice),threadKey=threadId??'new';
  const chooseThread=useCallback((thread:ShownThread|undefined)=>{const id=projectRef.current;if(!id)return;setThreadChoices(current=>({...current,[id]:thread}));saveLocal(`ros-thread:${id}`,thread===undefined?null:thread??'new');},[]);
  // A Web block's pages arrive a search at a time, so its card is read more often while it searches.
  const sweeping=Boolean(detail?.runs.some(run=>run.configuration.purpose==='web-sweep'&&['running','queued'].includes(run.status)));
  useEffect(()=>{if(!hasActive&&!chatBusy&&!notebookRunning)return;let polling=false;const interval=setInterval(()=>{if(polling)return;polling=true;void refresh().catch(report).finally(()=>{polling=false;});},sweeping?700:1500);return()=>clearInterval(interval);},[hasActive,chatBusy,notebookRunning,sweeping,refresh,report]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&!(event.target instanceof Element&&event.target.closest('.cm-editor'))){setNewProject(false);setDialog(null);setFolderDialog(false);setAttachment(null);setAddWindow(null);setInspectorId(null);setArtifact(null);setReportEditor(null);setAgentReportId(null);setDeleteCandidate(null);setProjectMenu(null);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  const action=useCallback(async(fn:()=>Promise<unknown>,shouldRefresh=true)=>{setSaving(n=>n+1);try{await fn();if(shouldRefresh)await refresh();return true;}catch(cause){report(cause);if(shouldRefresh)await refresh().catch(()=>undefined);return false;}finally{setSaving(n=>n-1);}},[refresh,report]);
  // Run canvas edits one at a time against the newest revision this browser has seen,
  // so quick consecutive edits do not trip the server's stale-canvas check.
  const mutationQueue=useRef<Promise<unknown>>(Promise.resolve()),knownRevision=useRef<{projectId:string;revision:number}|null>(null);
  const noteRevision=(id:string,revision:number)=>{const known=knownRevision.current;if(known?.projectId!==id||revision>known.revision)knownRevision.current={projectId:id,revision};};
  const mutate=(operations:Mutation[],label:string)=>{if(!projectId||!detail||historical)return Promise.resolve(false);const id=projectId,seen=detail.project.revision;
    const run=mutationQueue.current.then(()=>action(async()=>{noteRevision(id,seen);const project=await post<Project>(`/api/projects/${id}/mutations`,{operations,label,expectedRevision:knownRevision.current!.revision});noteRevision(id,project.revision);}));
    mutationQueue.current=run.catch(()=>undefined);return run;};
  const selectFocus=(nodeId:string|null,artifactId:string|null=null)=>{
    // A block that only exists in a proposal can be selected, but ROS cannot focus on it yet.
    if(nodeId&&detail&&!detail.project.canvas.nodes.some(n=>n.id===nodeId)){setSelectedId(nodeId);return;}
    setSelectedId(nodeId);const focus={nodeId,artifactId};setAssistantFocus(focus);const id=projectRef.current;if(!id)return;
    const sequence=++focusSequence.current;focusVersions.current.set(id,sequence);
    // Save selections in order. Skip superseded writes still waiting in the queue.
    const write=(focusWrites.current.get(id)||Promise.resolve()).then(async()=>{
      if(focusVersions.current.get(id)!==sequence)return;
      try{
        const state=await post<AssistantState>(`/api/projects/${id}/assistant/focus`,focus);
        if(projectRef.current===id&&sequence===focusSequence.current)setAssistant(current=>current?{...current,focus:state.focus,modelAvailable:state.modelAvailable,modelBlocker:state.modelBlocker,searchAvailable:state.searchAvailable}:current);
      }catch(cause){if(projectRef.current===id&&sequence===focusSequence.current)report(cause);}
    });
    focusWrites.current.set(id,write);
  };
  const revealNode=(id:string,inspect=false)=>{if(!detail)return;const ancestors:string[]=[];let node=detail.project.canvas.nodes.find(n=>n.id===id);const seen=new Set<string>();while(node?.parentId&&!seen.has(node.id)){seen.add(node.id);ancestors.push(node.parentId);node=detail.project.canvas.nodes.find(n=>n.id===node?.parentId);}setExpandedIds(current=>[...new Set([...current,...ancestors])]);selectFocus(id);setFocusId(null);requestAnimationFrame(()=>setFocusId(id));if(inspect)setInspectorId(id);};
  const showTourStage=(nodeId:string)=>{setArtifact(null);setInspectorId(null);setDialog(null);revealNode(nodeId);setExpandedIds(current=>[...new Set([...current,nodeId])]);};
  // The guided demo shows each step's new blocks together.
  const frameBlocks=(ids:string[])=>{setArtifact(null);setInspectorId(null);setDialog(null);setFocusId(null);if(selectedId)selectFocus(null);setFrame({ids,key:Date.now()});};
  /** A PDF or image chosen or dropped is saved into files/ in the project folder; the block shows it from there. */
  const saveFile=async(file:File)=>{
    if(!detail)throw new Error('Open a project first.');
    if(!fileMediaType(file.name))throw new Error(`${file.name} is not a PDF or a PNG, JPEG, WebP or GIF image.`);
    if(!folderStatus?.attached)throw new Error('Choose a project folder first (the folder chip above the canvas); the file is saved there.');
    return upload<{path:string}>(`/api/projects/${detail.project.id}/folder/files?name=${encodeURIComponent(file.name)}`,file);
  };
  const dropFiles=async(files:File[],position:{x:number;y:number})=>{
    if(!detail)return;
    for(const [index,file] of files.slice(0,10).entries()){
      try{
        const {path}=await saveFile(file), id=crypto.randomUUID(), name=file.name.replace(/\.[^.]+$/u,'').trim().slice(0,200)||'File';
        await mutate([{type:'addNode',node:{id,kind:'topic',blockType:'file',file:{path},parentId:null,title:name,description:'',x:Math.round(position.x)+index*32,y:Math.round(position.y)+index*32}}],`Add ${name}`);
        if(index===files.length-1)selectFocus(id);
      }catch(reason){report(reason);return;}
    }
  };
  const addNode=async(kind:NodeKind,scope:string|null,title:string,blockType?:NewBlockType,chosenFile?:File,notion?:NotionView,label?:string,googleLink?:string,training?:TrainingView)=>{
    if(!detail)return;
    const id=crypto.randomUUID();
    let display=blockType==='notion'?'Notion':blockType==='dataset'?'Data':blockType&&blockType!=='report'?blockType[0].toUpperCase()+blockType.slice(1):kind==='group'?'Group':label?label[0].toUpperCase()+label.slice(1):'Text';
    // A Notion link is read once first, so a wrong link or filter is caught before the block exists,
    // and the block learns whether it shows a page or a database.
    let read:NotionRead|GoogleRead|undefined;
    if(notion){try{read=await post<NotionRead>('/api/notion/views/preview',notion);}catch(reason){report(reason);return;}notion={...notion,kind:read.kind==='page'?'page':'database'};display=read.kind==='page'?'Notion page':'Notion database';}
    // A Google link too: the block learns whether it is a sheet or a doc, and the tab the link points at.
    let google:GoogleView|undefined;
    if(blockType==='google'){if(!googleLink)return;try{({view:google,read}=await post<{view:GoogleView;read:GoogleRead}>('/api/google/views/preview',{url:googleLink}));}catch(reason){report(reason);return;}display=google.kind==='sheet'?'Google Sheet':'Google Doc';}
    // A training run's folder (and GPU machine) is read once first, so a wrong path or ssh host is caught before the block exists.
    if(blockType==='training'){if(!training)return;try{({view:training}=await post<{view:TrainingView;read:TrainingRead}>('/api/training/preview',training));}catch(reason){report(reason);return;}display='Training run';}
    const notebookFile=blockType==='notebook'?chosenFile:undefined;
    let file:{path:string}|undefined;
    if(blockType==='file'){if(!chosenFile)return;try{file=await saveFile(chosenFile);}catch(reason){report(reason);return;}}
    let name=title.trim()||read?.title.slice(0,200)||(notebookFile?.name.replace(/\.ipynb$/iu,'').trim().slice(0,200)??'')||(file?chosenFile!.name.replace(/\.[^.]+$/u,'').trim().slice(0,200):'');
    if(!name){
      const titles=new Set(detail.project.canvas.nodes.map(node=>node.title.toLocaleLowerCase()));
      name=display;
      for(let suffix=2;titles.has(name.toLocaleLowerCase());suffix++)name=`${display} ${suffix}`;
    }
    if(await mutate([{type:'addNode',node:{id,kind,blockType,parentId:scope,title:name,description:'',...(label?{label}:{}),...(blockType==='code'?{code:blankCode}:{}),...(blockType==='app'?{app:{source:APP_STARTER,inputs:[]}}:{}),...(notion?{notion}:{}),...(google?{google}:{}),...(training?{training}:{}),...(file?{file}:{}),...emptyPosition(detail.project.canvas,scope,expandedIds)}}],`Add ${display}`)){
      setAddWindow(null);
      if(notebookFile&&blockType==='notebook')await post(`/api/projects/${detail.project.id}/nodes/${id}/notebook/import`,{name:notebookFile.name,content:await notebookFile.text()}).catch(report);
      // Code and notebooks open straight into their editors once the block exists on the canvas; an App on its inputs.
      if(blockType==='app')saveLocal(`app-tab:${id}`,'inputs');
      setInspectorId(blockType==='code'||blockType==='notebook'||blockType==='app'?id:null);
      selectFocus(id);
      if(scope)setExpandedIds(current=>[...new Set([...current,scope])]);
      setFocusId(id);
      setPreviewId(null);
    }
  };
  /** Add block › Paper: ros.ai saves the paper's open PDF into the project folder and adds its block in one change.
   * A paper already on the canvas is shown instead of added twice. */
  const addPaper=async(scope:string|null,paper:string)=>{
    if(!detail)return;
    let added:{nodeId:string;existing?:boolean}|undefined;
    if(!await action(async()=>{added=await post<{nodeId:string;existing?:boolean}>(`/api/projects/${detail.project.id}/papers`,{paper,parentId:scope,...emptyPosition(detail.project.canvas,scope,expandedIds)});})||!added)return;
    setAddWindow(null);
    setPreviewId(null);
    if(added.existing){revealNode(added.nodeId);return;}
    selectFocus(added.nodeId);
    if(scope)setExpandedIds(current=>[...new Set([...current,scope])]);
    setFocusId(added.nodeId);
  };
  /** The quick menu: a kind that needs nothing more is added at once; one that asks for a link or a file opens All blocks on its row. */
  const addQuick=(scope:string|null,id:KindId)=>{const kind=blockKind(id);if(kind.asks){setAddWindow({scope,kind:id});return;}noteKindUse(id);void addNode(kind.kind,scope,'',kind.blockType);};
  // A Google Sheet's tab copied into a Data block beside it, with where and when it came from; the block view opens the copy.
  const copyGoogle=async(nodeId:string,open:boolean)=>{
    if(!detail)return false;
    let created='';
    const copied=await action(async()=>{created=(await post<{nodeId:string}>(`/api/projects/${detail.project.id}/nodes/${nodeId}/google/copy`)).nodeId;});
    if(copied&&created){if(open)revealNode(created,true);else selectFocus(created);}
    return copied;
  };
  const queueAssistantMessage=(id:string,message:string,focus:AssistantFocus,suggest?:PluginId[],thread?:string)=>{
    // Message admission also saves focus, so keep it ordered with selections. No thread named starts a new one.
    const request=(focusWrites.current.get(id)||Promise.resolve()).then(()=>post<AssistantState>(`/api/projects/${id}/assistant/messages`,{message,focus,...(suggest?.length?{suggest}:{}),...(thread?{threadId:thread}:{})}));
    focusWrites.current.set(id,request.then(()=>undefined,()=>undefined));
    return request;
  };
  const createProject=async(title:string,folder?:string)=>{if(await action(async()=>{const project=await post<Project>('/api/projects',{title,start:'blank',...(folder?{folder}:{})});setProjects(current=>[project,...current]);setProjectId(project.id);setAssistantOpen(false);},false))setNewProject(false);};
  const startDemo=async(scenario:TutorialScenario,folder?:string)=>{await action(async()=>{const session=await post<TutorialSession>('/api/demo-sessions',{scenario:scenario.id,...(folder?{folder}:{})});await openCreatedDemo(session);},false);};
  // A folder ros.ai made reconnects to its project; any other folder becomes a new project.
  const openFolder=async(path:string)=>{const success=await action(async()=>{const project=await post<Project>('/api/folders/open',{path});setProjects(current=>[project,...current.filter(item=>item.id!==project.id)]);if(projectRef.current===project.id){await refresh(project.id);folder.reload();}else setProjectId(project.id);},false);if(success){setNewProject(false);setFolderDialog(false);}return success;};
  const openCreatedDemo=async(session:TutorialSession)=>{setNewProject(false);setTourOpen(false);setDemoSession(session);if(session.scenario==='workflow'){updateRightPanel(null);setSidebarOpen(false);}const next=await api<ProjectDetail>(`/api/projects/${session.projectId}`);setProjects(current=>[next.project,...current.filter(project=>project.id!==next.project.id)]);setProjectId(session.projectId);setDemoOpen(true);};
  /** Sends in the thread shown; a new thread is adopted as soon as the service names it. */
  const sendChat=async(message:string,suggest?:PluginId[])=>{if(!projectId||chatBusy)return false;const id=projectId;setChatBusy(threadKey);try{const admitted=await queueAssistantMessage(id,message,assistantFocus,suggest,threadId??undefined);if(projectRef.current===id){setAssistant(admitted);if(admitted.threadId)chooseThread(admitted.threadId);}await refresh(id).catch(report);return true;}catch(cause){report(cause);await refresh(id).catch(()=>undefined);throw cause;}finally{setChatBusy(null);}};
  /** Check sources on a block: ROS takes the block in focus and checks its claims on the web, in the thread shown, or in a new one while that thread works. */
  const checkSources=async(node:CanvasNode)=>{if(!projectId||chatBusy)return;const id=projectId,thread=threadId&&!liveAssistant?.threads.find(item=>item.id===threadId)?.running?threadId:undefined;setInspectorId(null);setSelectedId(node.id);setAssistantFocus({nodeId:node.id});setChatBusy(thread??'new');try{const admitted=await queueAssistantMessage(id,checkSourcesRequest(node.title),{nodeId:node.id},undefined,thread);if(projectRef.current===id){setAssistant(admitted);if(admitted.threadId)chooseThread(admitted.threadId);}await refresh(id).catch(report);}catch(cause){report(cause);await refresh(id).catch(()=>undefined);}finally{setChatBusy(null);}};
  const trashProject=async(project:Project,files=false)=>{if(await action(async()=>{await post(`/api/projects/${project.id}/trash`,files?{files}:{});const list=await api<Project[]>('/api/projects');setProjects(list);if(projectRef.current===project.id)setProjectId(list[0]?.id||null);},false)){setDeleteCandidate(null);setProjectMenu(null);}};
  const openArtifact=(value:Artifact,nodeId:string)=>{selectFocus(nodeId,value.id);setArtifact({value,nodeId});};
  const prepareFigureRefinement=async(value:Artifact)=>{
    if(!detail)return;
    const run=detail.runs.find(item=>item.id===value.runId);
    const code=detail.artifacts.find(item=>item.runId===value.runId&&item.kind==='code')?.content||(typeof run?.configuration.code==='string'?run.configuration.code:'');
    const sourceId=run?.configuration.sourceDatasetArtifactId||run?.configuration.datasetArtifactId;
    const dataset=detail.artifacts.find(item=>item.id===sourceId&&item.kind==='dataset')||run?.inputs.find(input=>input.artifact.kind==='dataset')?.artifact||detail.artifacts.find(item=>item.runId===value.runId&&item.kind==='dataset');
    if(!code||!dataset){report(new Error('This figure has no retained generating code and exact dataset for a new analysis. Its saved image, caption and provenance remain available.'));return;}
    const id=crypto.randomUUID(),parentId=detail.project.canvas.nodes.find(item=>item.id===value.nodeId)?.parentId??null;
    const operations:Mutation[]=[{type:'addNode',node:{id,kind:'activity',parentId,title:`Refine ${value.title}`.slice(0,200),description:`Revise the retained generating code using exact figure ${value.id} and dataset ${dataset.id}. No new analysis has run.`,...emptyPosition(detail.project.canvas,parentId,expandedIds)}}];
    if(detail.project.canvas.nodes.some(item=>item.id===value.nodeId))operations.push({type:'addConnection',connection:{id:crypto.randomUUID(),source:value.nodeId,target:id,label:'figure refinement'}});
    if(!await mutate(operations,'Prepare figure code refinement'))return;
    await action(async()=>{await post(`/api/projects/${projectId}/inputs`,{nodeId:id,artifactId:dataset.id});await post(`/api/projects/${projectId}/inputs`,{nodeId:id,artifactId:value.id});});
    saveLocal(`experiment-code:${id}`,code);saveLocal(`experiment-csv:${id}`,dataset.content);saveLocal(`experiment-dataset-source:${id}`,dataset.id);saveLocal(`experiment-request:${id}`,`Refine ${value.title}`);saveLocal(`experiment-parameters:${id}`,JSON.stringify(run?.configuration.parameters??{},null,2));saveLocal(`experiment-backend:${id}`,['docker-python','nebius-sandbox','bounded'].includes(String(run?.configuration.backend))?run!.configuration.backend:'docker-python');saveLocal(`node-tab:${id}`,'experiment');
    setArtifact(null);selectFocus(id);setInspectorId(id);if(parentId)setExpandedIds(current=>[...new Set([...current,parentId])]);
  };
  const navigateReference=(reference:AssistantReference)=>{if(!detail)return;setHistorical(null);if(window.innerWidth<850)setAssistantOpen(false);if(reference.nodeId)revealNode(reference.nodeId);if(reference.kind==='artifact'){const value=detail.artifacts.find(item=>item.id===reference.id);if(value){revealNode(value.nodeId);openArtifact(value,value.nodeId);}}else if(reference.kind==='proposal'){setPreviewId(reference.id);setRos('bar');}else if(reference.kind==='run'){const run=detail.runs.find(item=>item.id===reference.id);if(run){saveLocal(`node-tab:${run.nodeId}`,run.configuration.kind==='local-experiment'?'experiment':'runs');revealNode(run.nodeId,true);}}else if(reference.kind==='node')revealNode(reference.id);else if(reference.kind==='message'){const message=detail.messages.find(item=>item.id===reference.id);if(message?.nodeId){saveLocal(`node-tab:${message.nodeId}`,'work');revealNode(message.nodeId,true);}}};
  const attach=async(value:Artifact,nodeId?:string)=>{if(!nodeId){setAttachment({artifact:value});return;}await action(()=>post(`/api/projects/${projectId}/inputs`,{artifactId:value.id,nodeId}));};
  const pin=async(value:Artifact,nodeId:string)=>{const existing=detail?.highlights?.find(h=>h.nodeId===nodeId&&h.artifactId===value.id);await action(()=>existing?api(`/api/projects/${projectId}/highlights/${existing.id}`,{method:'DELETE'}):post(`/api/projects/${projectId}/highlights`,{nodeId,artifactId:value.id,x:0,y:0}));};
  const preview=!historical?detail?.proposals.find(p=>p.id===previewId&&p.status==='pending'):undefined;const currentCanvas=historical?.canvas||detail?.project.canvas;const selectedNode=currentCanvas?.nodes.find(n=>n.id===selectedId);// While a proposal is previewed, a block it adds or changes opens as proposed, read only.
  const previewed=preview&&detail?previewCanvas(detail.project.canvas,preview):undefined;const proposedNode=inspectorId&&previewed?.marks.get(inspectorId)&&previewed.marks.get(inspectorId)!=='removed'?previewed.canvas.nodes.find(n=>n.id===inspectorId):undefined;const inspectorNode=proposedNode||currentCanvas?.nodes.find(n=>n.id===inspectorId);const inspectorFile=folderStatus?.files.find(file=>file.nodeId===inspectorId);const notebookNode=detail&&inspectorNode?.blockType==='notebook'&&inspectorNode.kind!=='group'&&!historical&&!proposedNode?inspectorNode:undefined;
  // A proposal's new groups open while it is reviewed, and count as seen: one the person closes stays closed once accepted.
  useEffect(()=>{if(!preview||!detail)return;const ids=proposedGroups(preview.operations),seen=seenGroups.current;if(seen?.projectId===detail.project.id)for(const id of ids)seen.ids.add(id);if(ids.length)setExpandedIds(current=>[...new Set([...current,...ids])]);},[preview?.id]);
  const reloadConnections=async()=>{setConnections(await api<ConnectionStatus[]>('/api/connections'));await refresh();};
  // The Mac app's Check for Updates… opens Settings › General, which shows what it finds.
  useEffect(()=>{if(publicDemo)return;const look=()=>{setPage('general');void checkForUpdates().catch(()=>undefined);};window.addEventListener('ros-check-updates',look);return()=>window.removeEventListener('ros-check-updates',look);},[publicDemo]);
  // First launch: a new computer (never seen, no project yet) starts at the welcome page in a window of its own; otherwise
  // the tools card shows by itself when something was found. Seen once, both stay away until Agents asks for the tools
  // card again or Settings › General resets onboarding, which starts again from the welcome page.
  useEffect(()=>{if(loading||publicDemo)return;let stopped=false;const fresh=projects.length===0;const forced=new URLSearchParams(window.location.search).has('welcome');const load=(force=false,welcome?:boolean)=>api<SetupStatus>(`/api/setup${force?'?rescan=1':''}`).then(value=>{if(stopped)return;const start=welcome??(forced||(fresh&&!value.seenAt));setSetup(value);setFirstRun(start);setSetupOpen(!start&&(force||value.show));}).catch(()=>undefined).finally(()=>{if(!stopped)setSetupChecked(true);});void load();const again=(event:Event)=>{setPage('canvas');setSetupRun(run=>run+1);void load(true,(event as CustomEvent<{from?:string}|null>).detail?.from==='welcome');};window.addEventListener('ros-setup-reset',again);return()=>{stopped=true;window.removeEventListener('ros-setup-reset',again);};},[loading,publicDemo]);
  const finishSetup=async(next?:RailPage)=>{setSetupOpen(false);setFirstRun(false);void post('/api/setup/seen').then(()=>api<SetupStatus>('/api/setup')).then(setSetup).catch(()=>undefined);if(next)setPage(next);await reloadConnections().catch(report);};
  // For the start screen's pill: agents linked, the hosted ROS signed in, model servers connected.
  const toolsConnected=setup?setup.agents.filter(agent=>agent.link||agent.entry).length+(setup.cloud.signedIn?1:0)+setup.models.filter(model=>model.connectionId).length:0;
  const settingsOpen=page==='usage'||page==='balances'||page==='general'||page==='memory'||page==='resources';
  const railPage=page==='canvas'?null:<RailPageFrame page={page}>{page==='model'?<ModelPage key={projectId||'local'} projectId={projectId} connections={connections} publicDemo={publicDemo} selected={agentId} onSelect={setAgentId} onInstalled={setInstalledAgents} onChanged={reloadConnections}/>:page==='usage'?<UsageSettings publicDemo={publicDemo}/>:page==='balances'?<BalanceSettings publicDemo={publicDemo}/>:page==='general'?<GeneralSettings projectId={projectId} projectTitle={detail?demoDisplayTitle(detail.project):null} policy={policy} publicDemo={publicDemo} onChanged={()=>refresh()}/>:page==='memory'?<MemoryPage publicDemo={publicDemo}/>:page==='skills'?<SkillsPage publicDemo={publicDemo} selected={skillName} onSelect={setSkillName} onSkills={setSkillList}/>:page==='plugins'?<PluginsPage projectId={projectId} publicDemo={publicDemo} selected={pluginId} onSelect={setPluginId} onInstalled={setInstalledPlugins} onChanged={reloadConnections} onResources={()=>setPage('resources')}/>:detail?<div className="settings-page"><h1>Resources</h1><Resources key={detail.project.id} detail={detail} onChanged={()=>refresh()} onOpenArtifact={openArtifact}/></div>:<div className="settings-page"><h1>Resources</h1><p className="rail-page-note">Open a project to see its resources.</p></div>}</RailPageFrame>;
  // The Mac app window has no system title bar: its strip (mac-app.css) holds the window buttons and the sidebar button.
  const macApp=document.documentElement.classList.contains('mac-app');
  // Hiding or showing the sidebar by its button hands focus to the button that undoes it.
  const toggleSidebar=(open:boolean)=>{setSidebarOpen(open);requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>(`[aria-label="${open?'Hide sidebar':'Show sidebar'}"]`)?.focus({preventScroll:true}));};
  // An open block in its frame. Code puts Run in the header; a Text block gets its label and its conversation as footer chips.
  const blockFrame=(parts:{head?:ReactNode;foot?:ReactNode;status?:ReactNode;body:ReactNode})=>detail&&inspectorNode?<BlockSheet key={inspectorNode.id} node={inspectorNode} mode={blockView} onMode={setBlockView} onClose={()=>setInspectorId(null)} onRename={!historical&&!proposedNode&&!inspectorNode.notion&&inspectorNode.blockType!=='agent'?title=>void mutate([{type:'updateNode',id:inspectorNode.id,patch:{title}}],'Rename block'):undefined} head={parts.head} foot={parts.foot} status={parts.status}>{inspectorFile&&!historical&&!proposedNode&&inspectorNode.blockType!=='agent'&&<FileBar projectId={detail.project.id} file={inspectorFile} onError={report}/>}{parts.body}</BlockSheet>:null;
  const blockTalk=detail&&inspectorNode?{messages:detail.messages.filter(message=>message.nodeId===inspectorNode.id).length,runs:detail.runs.filter(run=>run.nodeId===inspectorNode.id).length}:{messages:0,runs:0};
  const talkChip=(blockTalk.messages>0||blockTalk.runs>0)&&<button type="button" className={`chip-button${blockChat?' set':''}`} aria-pressed={blockChat} onClick={()=>setBlockChat(!blockChat)}><MessageSquare size={12}/>Conversation{blockTalk.messages>0&&` · ${blockTalk.messages}`}</button>;
  const labelChip=detail&&inspectorNode&&!historical&&!proposedNode&&kindName(inspectorNode)==='Text'&&!labelFixed(inspectorNode)&&<LabelChip node={inspectorNode} onPick={value=>void mutate([{type:'updateNode',id:inspectorNode.id,patch:labelPatch(inspectorNode,value)}],value?`Label ${inspectorNode.title} as ${value}`:`Remove the label of ${inspectorNode.title}`)}/>;
  const openBlock=detail&&inspectorNode&&!notebookNode?(
    proposedNode&&previewed&&preview&&proposedNode.blockType==='app'?blockFrame({body:<AppView key={`proposed:${proposedNode.id}`} node={proposedNode} detail={{...detail,project:{...detail.project,canvas:previewed.canvas}}} proposalId={preview.id} readOnly onUpdate={async()=>false} onReveal={nodeId=>{setInspectorId(null);revealNode(nodeId);}}/>})
    :proposedNode&&previewed?blockFrame({foot:talkChip,body:<Inspector key={`proposed:${proposedNode.id}`} node={proposedNode} detail={{...detail,project:{...detail.project,canvas:previewed.canvas}}} mutate={mutate} file={proposedNode.file?shownFile(detail.project.id,proposedNode,folderFiles.get(proposedNode.id)):undefined} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onOpenNote={nodeId=>setInspectorId(nodeId)} onCancel={async()=>false} onRetry={async()=>false} onAttach={()=>undefined} readOnly readOnlyNote="Proposed change · accept it to make edits." conversation={blockChat} onConversation={setBlockChat}/>})
    :inspectorNode.blockType==='agent'?blockFrame({body:<AgentView node={inspectorNode} turn={inspectorNode.agent?assistant?.turns.find(item=>item.id===inspectorNode.agent!.turnId):undefined} detail={detail} onOpenNode={nodeId=>{setInspectorId(null);revealNode(nodeId,true);}} onReveal={nodeId=>{setInspectorId(null);revealNode(nodeId);}} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onReview={id=>{setInspectorId(null);setPreviewId(id);}}/>})
    :inspectorNode.blockType==='app'?blockFrame({body:<AppView key={inspectorNode.id} node={inspectorNode} detail={detail} readOnly={Boolean(historical)} still={historical?'An App from a saved canvas. It runs on the current canvas.':undefined} onUpdate={(patch,label)=>mutate([{type:'updateNode',id:inspectorNode.id,patch}],label)} onReveal={nodeId=>{setInspectorId(null);revealNode(nodeId);}}/>})
    :inspectorNode.blockType==='code'?<CodeBlock key={`${inspectorNode.id}:${codeAttempt?.nodeId===inspectorNode.id?codeAttempt.runId:''}`} initialRunId={codeAttempt?.nodeId===inspectorNode.id?codeAttempt.runId:undefined} node={inspectorNode} detail={detail} policy={policy} onRefresh={()=>refresh()} onUpdate={patch=>mutate([{type:'updateNode',id:inspectorNode.id,patch}],'Edit Code source and settings')} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onReport={value=>{setInspectorId(null);setReportEditor({artifact:value});}} onInterpret={(value,destinationId)=>{setInspectorId(null);setOutputGuide({artifact:value,destinationId});}} onClose={()=>setInspectorId(null)} frame={blockFrame}/>
    :inspectorNode.blockType==='report'&&!inspectorNode.artifactId?blockFrame({body:<ReportEditor key={inspectorNode.id} nodeId={inspectorNode.id} detail={detail} onSaved={(value,nodeId)=>{setInspectorId(null);openArtifact(value,nodeId);}} onChanged={()=>refresh()} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onCancel={()=>setInspectorId(null)}/>})
    :blockFrame({foot:<>{labelChip}{talkChip}</>,body:<Inspector key={inspectorNode.id} node={inspectorNode} detail={detail} mutate={mutate} onCheckSources={()=>void checkSources(inspectorNode)} file={inspectorNode.file?shownFile(detail.project.id,inspectorNode,folderFiles.get(inspectorNode.id)):undefined} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onOpenNote={nodeId=>{saveLocal(`node-tab:${nodeId}`,'overview');revealNode(nodeId,true);}} onCancel={runId=>action(()=>post(`/api/runs/${runId}/cancel`))} onRetry={runId=>action(()=>post(`/api/runs/${runId}/retry`))} onAttach={(value,nodeId)=>setAttachment({artifact:value,nodeId})} readOnly={Boolean(historical)} sql={publicDemo?undefined:{onChanged:()=>refresh()}} onGoogleCopy={historical?undefined:()=>copyGoogle(inspectorNode.id,true)} conversation={blockChat} onConversation={setBlockChat}/>})
  ):null;
  if(firstRun&&setup)return <>{macApp&&<div className="mac-titlebar"/>}<FirstRun key={setupRun} status={setup} onDone={()=>void finishSetup()} onAgents={()=>void finishSetup('model')} onChanged={reloadConnections}/></>;
  return <div className={`app-shell single-canvas-shell ${sidebarOpen?'':'sidebar-hidden'}`}>
    {macApp&&<div className="mac-titlebar"><button className="icon-button mac-titlebar-button" aria-label={sidebarOpen?'Hide sidebar':'Show sidebar'} onClick={()=>toggleSidebar(!sidebarOpen)}><PanelLeft size={16}/></button></div>}
    <AppRail page={page} onPage={setPage}/>
    <aside className="sidebar" aria-label="Projects and notes" inert={!sidebarOpen}>
      <div className="brand-row"><a className="wordmark" href="/" aria-label="ros.ai home"><Wordmark/></a><button className="icon-button" aria-label="Hide sidebar" onClick={()=>toggleSidebar(false)}><PanelLeftClose size={17}/></button></div>
      {!settingsOpen&&page!=='plugins'&&page!=='skills'&&page!=='model'&&<button className="new-project-button" data-testid="new-project" onClick={()=>{if(detail){setPage('canvas');setNewProject(true);}else setStartFocus(value=>value+1);}}><Plus size={16}/> New project</button>}
      {settingsOpen?<div className="sidebar-content"><SettingsSidebar section={page as SettingsSection} onSection={setPage}/></div>:page==='plugins'?<div className="sidebar-content"><PluginsSidebar installed={installedPlugins} selected={pluginId} onSelect={setPluginId}/></div>:page==='skills'?<div className="sidebar-content"><SkillsSidebar skills={skillList} selected={skillName} onSelect={setSkillName}/></div>:page==='model'?<div className="sidebar-content"><AgentsSidebar installed={installedAgents} selected={agentId} onSelect={setAgentId}/></div>:<div className="sidebar-content"><div className="sidebar-label">Projects <span>{projects.length}</span></div><nav className="project-list" aria-label="Projects">{projects.map(p=><div key={p.id} className={`project-group ${p.id===projectId?'active':''}`}><div className={`project-row ${p.id===projectId?'active':''}`}><button className={`project-item ${p.id===projectId?'active':''}`} onClick={()=>{if(p.id===projectId)setProjectOpen(!projectOpen);else{setProjectId(p.id);setProjectOpen(true);}if(window.innerWidth<950&&p.id!==projectId)setSidebarOpen(false);}} aria-expanded={p.id===projectId?projectOpen:undefined}><FolderOpen size={15}/><span title={p.title}>{demoDisplayTitle(p)}</span></button><button className="icon-button project-menu-toggle" aria-label={`Project actions for ${demoDisplayTitle(p)}`} aria-expanded={projectMenu===p.id} onClick={()=>setProjectMenu(projectMenu===p.id?null:p.id)}><MoreHorizontal size={16}/></button>{projectMenu===p.id&&<div className="project-menu"><button className="danger" onClick={()=>{setDeleteCandidate(p);setProjectMenu(null);}}><Trash2 size={14}/> Remove project…</button></div>}{p.id===projectId&&<button className="icon-button project-fold" aria-label={projectOpen?'Collapse blocks':'Show blocks'} onClick={()=>setProjectOpen(!projectOpen)}>{projectOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>}</div>{p.id===projectId&&projectOpen&&detail&&<div className="project-blocks"><NoteTree key={detail.project.id} projectId={detail.project.id} nodes={detail.project.canvas.nodes} runs={detail.runs} selectedId={selectedId} limit={5} onSelect={id=>{revealNode(id);if(window.innerWidth<950)setSidebarOpen(false);}}/></div>}</div>)}</nav></div>}
      <div className="sidebar-footer">{publicDemo?<div className="local-label"><span className="local-square"/> Saved for this browser on the demo server</div>:<ProfileButton onUsage={()=>setPage('usage')} onSettings={()=>setPage('general')} onChanged={reloadConnections}/>}</div>
    </aside>
    {sidebarOpen&&<button className="sidebar-backdrop" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}/>}
    <main className="workspace">{railPage}<header className="workspace-header"><div className="workspace-heading">{!sidebarOpen&&<button className="icon-button" aria-label="Show sidebar" onClick={()=>toggleSidebar(true)}><PanelLeftOpen size={17}/></button>}<h1 data-tour-target="project-title">{(detail&&demoDisplayTitle(detail.project))||(loading?'Opening workspace…':'Your research')}</h1>{!publicDemo&&(folderStatus?<FolderChip status={folderStatus} onClick={()=>setFolderDialog(true)}/>:<span className="local-badge">Local</span>)}</div>{(detail||!publicDemo)&&<div className="workspace-actions">{detail&&<span className="saved-indicator">{saving?<LoaderCircle size={12} className="spin"/>:<Check size={12}/>} {saving?'Saving':'Saved'}</span>}{!publicDemo&&<UpdateButton/>}</div>}</header>
      {setupOpen&&setup?<div className="workspace-body"><SetupScreen key={setupRun} status={setup} onDone={()=>void finishSetup()} onAgents={()=>void finishSetup('model')} onChanged={reloadConnections}/></div>:!detail?<div className="workspace-body"><div className="workspace-welcome">{loading||projectId||(!publicDemo&&!setupChecked)?<><LoaderCircle size={25} className="spin"/><p>Opening your workspace…</p></>:<StartScreen folders={!publicDemo} focusKey={startFocus} tools={toolsConnected} onTools={()=>setPage('model')} onCreate={createProject} onOpenFolder={openFolder} onDemo={startDemo}/>}</div></div>:<div className={`workspace-body single-workspace ${rightPanel?'assistant-open':'assistant-closed'}`}><div className="canvas-stage"><ResearchCanvas agentTurns={agentTurns} notices={<>{policy?.stopped&&<div className="canvas-notice" role="status"><Square size={13}/> Work in this project is paused. <button className="text-button" onClick={()=>void action(()=>post(`/api/projects/${projectId}/policy/resume`))}>Resume</button></div>}{historical&&<div className="canvas-notice history-banner"><Clock3 size={15}/><div><strong>Viewing revision {historical.revision}</strong><span>{historical.label} · {date(historical.createdAt)}</span></div><button className="small secondary" onClick={()=>setHistorical(null)}>Back to current canvas</button></div>}</>} proposalCard={preview&&<ProposalPreview proposal={preview} canvas={detail.project.canvas} revision={detail.project.revision} onClose={()=>setPreviewId(null)} onAccept={async()=>{if(await action(()=>post(`/api/projects/${projectId}/proposals/${preview.id}/accept`)))setPreviewId(null);}} onDismiss={async()=>{if(await action(()=>post(`/api/projects/${projectId}/proposals/${preview.id}/dismiss`)))setPreviewId(null);}} onRefine={()=>{setAssistantOpen(true);setChatPrefill(`Refine the proposal “${preview.summary}”: `);}} busy={saving>0}/>} detail={detail} selectedId={selectedId} onSelect={id=>selectFocus(id)} onInspect={id=>revealNode(id,true)} onArtifact={openArtifact} onReuse={(value,nodeId)=>void attach(value,nodeId)} onPin={(value,nodeId)=>void pin(value,nodeId)} highlights={detail.highlights||[]} onMoveHighlight={(id,nodeId,position)=>void action(()=>api(`/api/projects/${projectId}/highlights/${id}`,{method:'PATCH',body:JSON.stringify({nodeId,...position})}))} mutate={mutate} onAdd={addQuick} onBrowse={(scope,kind)=>setAddWindow({scope,kind})} local={!publicDemo} onUndo={()=>void action(()=>post(`/api/projects/${projectId}/undo`))} onRedo={()=>void action(()=>post(`/api/projects/${projectId}/redo`))} onHistory={()=>setHistoryOpen(!historyOpen)} onDemo={demoSession?()=>{if(window.innerWidth<=850)setRightPanel(null);setDemoOpenVersion(version=>version+1);setDemoOpen(true);setTourOpen(false);}:undefined} demoLabel="Tutorial" onTour={!demoSession&&demoEvidence(detail).article?()=>{showTourStage('stage-explore');setTourOpen(true);}:undefined} historyOpen={historyOpen} busy={saving>0} proposal={preview} historyCanvas={historical?.canvas} expandedIds={expandedIds} onExpandedChange={setExpandedIds} focusId={focusId} frame={frame} missingFiles={missingFiles} folderFiles={folderFiles} onDropFiles={(files,position)=>void dropFiles(files,position)} onGoogleCopy={historical?undefined:nodeId=>copyGoogle(nodeId,false)}/>
        {detail&&notebookNode&&<NotebookView key={notebookNode.id} node={notebookNode} detail={detail} file={inspectorFile} mode={policy?policy.overrides[notebookNode.id]??policy.mode:undefined} onClose={()=>setInspectorId(null)} onRefresh={()=>refresh()} onError={report} onPermissions={()=>setDialog('policy')} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onReport={value=>setReportEditor({artifact:value})} onInterpret={(value,destinationId)=>setOutputGuide({artifact:value,destinationId})}/>}
        {rosMode==='bar'&&!notebookNode&&<RosBar state={liveAssistant} detail={detail} policy={policy} focus={assistantFocus} busy={chatBusy===threadKey} threadId={threadId} onThread={chooseThread} onSend={sendChat} onCancel={turnId=>action(()=>post(`/api/projects/${projectId}/assistant/turns/${turnId}/cancel`))} onClearFocus={()=>selectFocus(null)} onRefresh={()=>refresh().catch(report)} onConnections={()=>setPage('model')} onPermissions={()=>setDialog('policy')} onOpen={setRos} onSkills={openSkills} onOpenPlugin={openPlugin}/>}
        {historyOpen&&<div id="canvas-content-history"><CanvasHistory detail={detail} historical={historical} onClose={()=>setHistoryOpen(false)} onCanvas={change=>{setHistorical(change);setPreviewId(null);}} onEvidence={value=>{setHistorical(null);openArtifact(value,value.nodeId);}}/></div>}
    {detail&&demoSession&&demoOpen&&demoSession.projectId===detail.project.id&&(demoSession.scenario==='workflow'?<WorkflowDemo key={`${demoSession.projectId}:${demoOpenVersion}`} session={demoSession} detail={detail} onSession={setDemoSession} onRefresh={()=>refresh()} onFrame={frameBlocks} onOpen={nodeId=>{const node=detail.project.canvas.nodes.find(item=>item.id===nodeId),value=node?.artifactId?detail.artifacts.find(item=>item.id===node.artifactId):undefined;if(value&&!['code','notebook'].includes(node?.blockType??'')){setInspectorId(null);setDialog(null);openArtifact(value,nodeId);}else{saveLocal(`node-tab:${nodeId}`,'overview');setArtifact(null);revealNode(nodeId,true);}}} onClose={()=>setDemoOpen(false)}/>:<ExecutableDemo key={`${demoSession.projectId}:${demoOpenVersion}`} session={demoSession} detail={detail} onSession={setDemoSession} onRefresh={()=>refresh()} onStage={showTourStage} onNote={nodeId=>{saveLocal(`node-tab:${nodeId}`,'overview');setArtifact(null);revealNode(nodeId,true);}} onArtifact={value=>{setInspectorId(null);setDialog(null);openArtifact(value,value.nodeId);}} onClose={()=>setDemoOpen(false)}/>)}
    {detail&&tourOpen&&<DemoTour key={detail.project.id} detail={detail} modelAvailable={assistant?.modelAvailable??false} onArtifact={value=>{setInspectorId(null);setDialog(null);openArtifact(value,value.nodeId);}} onResources={()=>{setArtifact(null);setInspectorId(null);setDialog(null);setPage('resources');}} onStage={showTourStage} onNote={nodeId=>{setArtifact(null);setDialog(null);revealNode(nodeId,true);}} onPrepareRefinement={nodeId=>{setArtifact(null);setInspectorId(null);selectFocus(nodeId);setRightPanel('assistant');setChatPrefill('Using only this draft and its selected evidence, propose one paragraph revision that makes the study coverage and methodological limitations clearer. Retain citations and qualified claims. Do not search or execute code. Show the proposed paragraph for review.');}} onExit={()=>setTourOpen(false)}/>}
      {blockView==='sheet'&&openBlock}</div>{blockView==='panel'&&openBlock}{newProject&&<NewProjectCard folders={!publicDemo} onClose={()=>setNewProject(false)} onCreate={createProject} onOpenFolder={openFolder} onDemo={startDemo}/>}{assistantOpen&&<AssistantPanel key={`${detail.project.id}:${threadKey}`} threadId={threadId} onThread={chooseThread} onRenameThread={(id,title)=>action(()=>post(`/api/projects/${projectId}/assistant/threads/${id}`,{title}))} onDeleteThread={async id=>{if(await action(()=>api(`/api/projects/${projectId}/assistant/threads/${id}`,{method:'DELETE'}))&&id===threadId)chooseThread(undefined);}} onSkills={openSkills} onOpenPlugin={openPlugin} state={liveAssistant} detail={detail} policy={policy} focus={assistantFocus} busy={chatBusy===threadKey} loadError={assistantLoadError} onSend={sendChat} onRefresh={()=>refresh().catch(report)} onConnections={()=>setPage('model')} onCancel={turnId=>action(()=>post(`/api/projects/${projectId}/assistant/turns/${turnId}/cancel`))} onClearFocus={()=>selectFocus(null)} onReference={navigateReference} onPermissions={()=>setDialog('policy')} onClose={()=>setRos('bar')} mode={rosMode==='full'?'full':'half'} onMode={setRos} prefill={chatPrefill} onPrefillUsed={()=>setChatPrefill('')} onDecision={async(actionId,decision)=>{await action(()=>post(`/api/projects/${projectId}/assistant/actions/${actionId}/decision`,{decision}));}} onProposal={async(proposalId,decision)=>{if(await action(()=>post(`/api/projects/${projectId}/proposals/${proposalId}/${decision}`))&&previewId===proposalId)setPreviewId(null);}} onProposals={async(proposalIds,decision)=>{if(await action(()=>post(`/api/projects/${projectId}/proposals/decide`,{ids:proposalIds,decision}))&&previewId&&proposalIds.includes(previewId))setPreviewId(null);}} onInspectAction={item=>{if(item.reportProposalId){setAgentReportId(item.reportProposalId);return;}if(item.nodeId){saveLocal(`node-tab:${item.nodeId}`,item.type==='experiment'?'experiment':'runs');revealNode(item.nodeId,true);}}}/>} </div>}
      <FeedbackButton publicDemo={publicDemo} quiet={!detail||setupOpen||newProject||tourOpen||demoOpen||assistantOpen||page!=='canvas'} before={publicDemo?undefined:<RosDownloadChip onOpen={()=>{setAgentId('ros');setPage('model');}} onReady={()=>void reloadConnections().catch(()=>undefined)}/>}/>
    </main>
    {error&&<div className="error-toast" role="alert"><div><strong>Couldn’t complete that action</strong><p>{error}</p></div><button className="icon-button" aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button></div>}

    {detail&&policy&&dialog==='policy'&&<Modal title="Permissions" className="settings-modal" onClose={()=>setDialog(null)}><PolicyPanel detail={detail} policy={policy} onRefresh={()=>refresh()}/></Modal>}
    {detail&&folderDialog&&folderStatus&&<Modal title="Project folder" className="settings-modal" onClose={()=>setFolderDialog(false)}><FolderPanel projectId={detail.project.id} projectTitle={detail.project.title} status={folderStatus} nodes={detail.project.canvas.nodes} onStatus={next=>{folder.update(next);folder.reload();}} onChanged={()=>refresh()} onOpenFolder={openFolder} onRemoveBlock={nodeId=>mutate([{type:'removeNode',id:nodeId}],'Remove block whose file is missing')}/></Modal>}

    {detail&&artifact&&<Modal title={artifact.value.title} className="artifact-modal" nonBlocking={tourOpen||demoOpen} onClose={()=>setArtifact(null)}>{artifact.value.metadata?.tutorialOrigin?<div className="artifact-dialog-meta">{artifact.value.metadata.tutorialOrigin==='saved'&&<span className="tag">Saved demonstration result</span>}{artifact.value.metadata.tutorialOrigin==='prepared'&&<span className="tag">Prepared tutorial content</span>}{artifact.value.metadata.tutorialOrigin==='recorded'&&<span className="tag">Recorded for this demo</span>}</div>:null}<ArtifactViewer key={artifact.value.id} artifact={artifact.value} detail={detail} sql={!publicDemo} onChanged={()=>refresh()} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onOpenAttempt={runId=>{const run=detail.runs.find(item=>item.id===runId);if(run){setArtifact(null);setCodeAttempt({nodeId:run.nodeId,runId:run.id});saveLocal(`node-tab:${run.nodeId}`,run.configuration.kind==='local-experiment'?'experiment':'runs');revealNode(run.nodeId,true);}}} onReviseFigure={value=>void prepareFigureRefinement(value)} more={<><div className="row gap wrap"><button className="secondary" onClick={()=>setReportEditor({artifact:artifact.value})}>{artifact.value.metadata?.report?'Edit report':'Use in a report'}</button><button className="secondary" onClick={()=>{const id=crypto.randomUUID();const blockType=artifact.value.kind==='plot'?'figure':artifact.value.kind==='dataset'||artifact.value.kind==='table'?'dataset':artifact.value.kind==='code'?'code':'note';void mutate([{type:'addNode',node:{id,kind:'topic',blockType,artifactId:artifact.value.id,title:artifact.value.title,description:'',...emptyPosition(detail.project.canvas)}}],`Place saved ${blockType} on canvas`);}}>Place on canvas</button>{['article','paper'].includes(String(artifact.value.metadata?.demoRole))&&<button className="secondary" onClick={()=>{const nodeId=artifact.nodeId;setArtifact(null);revealNode(nodeId,true);}}>Open editable draft</button>}<button className="secondary" onClick={()=>void pin(artifact.value,artifact.nodeId)}><Pin size={14}/>{detail.highlights?.some(h=>h.artifactId===artifact.value.id&&h.nodeId===artifact.nodeId)?'Unpin highlight':'Pin highlight'}</button></div><ResultActions inspect={false} artifact={artifact.value} detail={detail} onChanged={()=>refresh()} onOpen={value=>openArtifact(value,value.nodeId)} onInterpret={(value,destinationId)=>{setArtifact(null);setOutputGuide({artifact:value,destinationId});}}/></>}/></Modal>}
    {detail&&outputGuide&&<WorkspaceGuide key={outputGuide.artifact.id} detail={detail} initialSelection={outputGuide} onClose={()=>setOutputGuide(null)} onConnections={()=>{setOutputGuide(null);setPage('model');}} onChanged={()=>refresh()} onReference={navigateReference}/> }
    {addWindow&&detail&&<AllBlocksWindow initial={addWindow.kind} scope={addWindow.scope} groups={detail.project.canvas.nodes.filter(node=>node.kind==='group').map(node=>({id:node.id,title:node.title}))} folder={Boolean(folderStatus?.attached)} local={!publicDemo} onClose={()=>setAddWindow(null)} onCreate={(kind,options)=>{noteKindUse(kind.id);return addNode(kind.kind,options.scope,options.title,kind.id==='text'?(options.label==='report'?'report':undefined):kind.blockType,options.file,options.notion,kind.id==='text'?options.label:undefined,options.googleLink,options.training);}} onPaper={(scope,paper)=>{noteKindUse('paper');return addPaper(scope,paper);}}/>}
    {deleteCandidate&&<RemoveProjectDialog key={deleteCandidate.id} project={deleteCandidate} busy={saving>0} folders={!publicDemo} onCancel={()=>setDeleteCandidate(null)} onRemove={files=>void trashProject(deleteCandidate,files)}/>}
    {detail&&agentReportId&&<Modal title="Review agent report revision" className="artifact-modal" onClose={()=>setAgentReportId(null)}><AgentReportReview id={agentReportId} detail={detail} onChanged={()=>refresh()} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onClose={()=>setAgentReportId(null)}/></Modal>}
    {detail&&reportEditor&&<Modal title={reportEditor.artifact?.metadata?.report?'Edit report':'Write a report'} className="artifact-modal" onClose={()=>setReportEditor(null)}><ReportEditor key={reportEditor.artifact?.id||'new'} detail={detail} seed={reportEditor.artifact?.metadata?.report?undefined:reportEditor.artifact} artifact={reportEditor.artifact?.metadata?.report?reportEditor.artifact:undefined} onSaved={(value,nodeId)=>{setReportEditor(null);openArtifact(value,nodeId);}} onChanged={()=>refresh()} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onCancel={()=>setReportEditor(null)}/></Modal>}
    {attachment&&detail&&<AttachModal detail={detail} initial={attachment} onClose={()=>setAttachment(null)} onAttach={async(artifactId,nodeId,excerpt)=>{if(await action(()=>post(`/api/projects/${projectId}/inputs`,{artifactId,nodeId,...(excerpt?{excerpt}:{})}))){setAttachment(null);setExpandedIds(ids=>[...new Set([...ids,nodeId])]);}}}/>}
    <NetworkPrompt publicDemo={publicDemo}/>
    {!publicDemo&&<UpdateOverlay/>}
  </div>;
}


function demoDisplayTitle(project:Project) {
  const names:Record<string,string>={
    'Demo · AI adoption in Dutch businesses · the banking question':'Dutch AI adoption',
    'Demo · When market conditions change · a historical risk baseline':'Historical market risk',
  };
  return project.canvas.nodes.some(node=>!node.parentId&&/^01[ ·]/.test(node.title)) ? names[project.title]||project.title : project.title;
}

/** The group a block moves into (null: out of its group) when an update does nothing else but lay it out. */
const regroup = (operation: Mutation) => operation.type === 'updateNode' && 'parentId' in operation.patch && layoutOnly(Object.fromEntries(Object.entries(operation.patch).filter(([key]) => key !== 'parentId'))) ? operation.patch.parentId ?? null : undefined;
function ProposalPreview({ proposal, canvas, revision, onClose, onAccept, onDismiss, onRefine, busy }: { proposal: Proposal; canvas: Canvas; revision: number; onClose: () => void; onAccept: () => Promise<void>; onDismiss: () => Promise<void>; onRefine: () => void; busy: boolean }) {
  const stale = proposal.baseRevision !== revision;
  // Blocks that only move are left out, and blocks moving into a group this proposal adds are counted on that group.
  const added = new Set(proposal.operations.flatMap(operation => operation.type === 'addNode' ? [operation.node.id] : []));
  const joining = (groupId: string) => proposal.operations.filter(operation => regroup(operation) === groupId).length;
  const shown = proposal.operations.filter(operation => !(operation.type === 'updateNode' && layoutOnly(operation.patch)) && !added.has(regroup(operation) ?? ''));
  // A removal names the block and counts the blocks inside it, which go with it.
  const removal = (id: string) => { const inside = groupMembers(canvas, id).length; return `− Remove ${canvas.nodes.find(node => node.id === id)?.title || 'a block'}${inside ? ` · ${inside} block${inside === 1 ? '' : 's'} inside` : ''}`; };
  const label = (operation: Mutation) => { const into = regroup(operation), count = operation.type === 'addNode' ? joining(operation.node.id) : 0; return operation.type === 'addNode' ? `+ ${operation.node.title}${count ? ` · ${count} block${count === 1 ? '' : 's'}` : ''}` : into !== undefined ? into ? 'Move into a group' : 'Move out of its group' : operation.type === 'updateNode' ? `Edit ${operation.patch.title || 'node'}` : operation.type === 'removeNode' ? removal(operation.id) : operation.type === 'addConnection' ? '+ Link' : operation.type === 'removeConnection' ? '− Link' : 'Link changed'; };
  const [heading, ...reason] = proposal.summary.split('\n');
  return <section className={`proposal-preview ${stale ? 'stale' : ''}`} aria-label="Proposal preview" data-testid="proposal-preview"><header><span className="eyebrow"><GitBranch size={13} /> Proposed change</span><button className="icon-button" aria-label="Close proposal preview" onClick={onClose}><X size={15} /></button></header><h3 title={proposal.summary}>{heading}</h3>{reason.length > 0 && <p className="proposal-reason">{reason.join(' ').replace(/^Why:\s*/u, '')}</p>}<div className="proposal-operations">{shown.map((operation, index) => <span className={`operation-tag ${operation.type.startsWith('remove') ? 'remove' : operation.type.startsWith('add') ? 'add' : 'edit'}`} key={index}>{label(operation)}</span>)}</div>{stale && <p className="stale-warning">The canvas changed since. Ask ROS to update this.</p>}<div className="proposal-actions"><button className="small primary" data-testid="accept-proposal" disabled={stale || busy} onClick={() => void onAccept()}><Check size={13} /> Accept</button><button className="small text-button" onClick={onRefine}>Refine</button><button className="small text-button" disabled={busy} data-testid="dismiss-proposal" onClick={() => void onDismiss()}>Dismiss</button></div></section>;
}

function AttachModal({ detail, initial, onClose, onAttach }: { detail: ProjectDetail; initial: { artifact?: Artifact; nodeId?: string }; onClose: () => void; onAttach: (artifactId: string, nodeId: string, excerpt: string) => Promise<void> }) {
  const [artifactId, setArtifactId] = useState(initial.artifact?.id || ''); const [nodeId, setNodeId] = useState(initial.nodeId || ''); const [excerpt, setExcerpt] = useState(initial.artifact && initial.artifact.content !== detail.artifacts.find(a => a.id === initial.artifact?.id)?.content ? initial.artifact.content : ''); const [busy, setBusy] = useState(false);
  const artifact = detail.artifacts.find(a => a.id === artifactId); const available = detail.artifacts.filter(a => !initial.nodeId || a.nodeId !== initial.nodeId);
  const validExcerpt = !excerpt || Boolean(artifact?.content.includes(excerpt));
  return <Modal title="Attach a selected input" onClose={onClose}><p className="modal-description">Choose a saved version to share. Future results will not replace this selection or run the destination node.</p><form onSubmit={async event => { event.preventDefault(); if (!artifactId || !nodeId || busy || !validExcerpt) return; setBusy(true); await onAttach(artifactId, nodeId, excerpt); setBusy(false); }}><label className="field-label" htmlFor="attach-artifact">Saved result or source</label><select id="attach-artifact" value={artifactId} onChange={event => { setArtifactId(event.target.value); setExcerpt(''); }}><option value="">Choose an artifact…</option>{available.map(a => <option key={a.id} value={a.id}>{a.kind === 'source' ? 'Source' : 'Result'} · {a.title} · {date(a.createdAt)}</option>)}</select>{!available.length && <p className="subtle">Run research in another node to create a saved result.</p>}<label className="field-label" htmlFor="attach-node">Use in this node</label><select id="attach-node" value={nodeId} onChange={event => setNodeId(event.target.value)}><option value="">Choose a node…</option>{detail.project.canvas.nodes.filter(n => n.id !== artifact?.nodeId).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select>{artifact && <><details className="attach-content"><summary>Inspect captured content</summary><pre>{artifact.content}</pre><span className="subtle">Source run {artifact.runId.slice(0, 8)} · version {artifact.hash.slice(0, 12)}</span></details><label className="field-label" htmlFor="attach-excerpt">Selected excerpt <span>optional</span></label><textarea id="attach-excerpt" value={excerpt} onChange={event => setExcerpt(event.target.value)} placeholder="Paste an exact passage, or leave empty to attach the whole artifact." rows={3} />{!validExcerpt && <p className="inline-error">The excerpt must match an exact passage in this saved artifact.</p>}</>}<div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={!artifactId || !nodeId || busy || !validExcerpt}><ArrowRight size={14} /> Attach input</button></div></form></Modal>;
}

