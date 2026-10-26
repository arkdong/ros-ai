import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Braces, Check, ChevronDown, ChevronRight, Database, File as FileIcon, FileText, Group, NotebookPen, Clock3, FolderOpen, GitBranch, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, Play, Plus, Square, Text as TextIcon, Trash2, X } from 'lucide-react';
import type { Artifact, CanvasNode, Change, ConnectionStatus, Mutation, NodeKind, NotionRead, NotionView, Project, ProjectDetail, Proposal } from '../shared/types';
import { checkSourcesRequest } from '../shared/source-check';
import type { ResearchPolicy, ResearchSession } from '../shared/research';
import { api, post, upload } from './api';
import { emptyPosition, KindIcon, previewCanvas, ResearchCanvas, shownFile } from './Canvas';
import { fileMediaType } from '../shared/files';
import { BrandLogo } from './brand-logos';
import { TEXT_LABELS, kindName, textLabel } from '../shared/vocabulary';
import { ArtifactViewer } from './ArtifactViewer';
import { ReportEditor } from './ReportEditor';
import { date, RichText, time } from './Content';
import { Inspector } from './Inspector';
import { CodeBlock, blankCode } from './CodeBlock';
import { NotebookView } from './notebook/NotebookView';
import { WorkspaceGuide } from './WorkspaceGuide';
import { ResultActions } from './ResultActions';
import { PolicyPanel, ResearchPanel } from './ResearchControls';
import { readSaved, saveLocal } from './persistence';
import { layoutOnly } from '../shared/canvas-position';
import { AssistantPanel } from './AssistantPanel';
import { RosBar, RosStart, type RosMode } from './RosDock';
import { useLiveTurns, withLive } from './live-reply';
import { NoteTree } from './NoteTree';
import { Resources } from './Resources';
import { DemoTour, demoEvidence } from './DemoTour';
import { DemoOnboarding } from './DemoOnboarding';
import { ExecutableDemo } from './ExecutableDemo';
import { WorkflowDemo } from './WorkflowDemo';
import type { TutorialSession } from '../shared/tutorial';
import { NetworkPrompt } from './NetworkPrompt';
import { BalanceSettings, GeneralSettings, SettingsSidebar, UsageSettings, type SettingsSection } from './SettingsPage';
import { PluginsPage, PluginsSidebar, type PluginsSection } from './PluginsPage';
import { SkillsPage } from './SkillsPage';
import type { SkillSummary } from '../shared/skills';
import { AgentsSidebar, type AgentId } from './ModelPage';
import type { PluginId } from '../shared/plugins';
import { MemoryPage } from './MemoryPage';
import { AppRail, RailPageFrame, type RailPage } from './AppRail';
import { Modal } from './Modal';
import { Wordmark } from './Brand';
import { SetupScreen } from './Setup';
import type { SetupStatus } from '../shared/setup';
import { AgentReportReview } from './AgentReportReview';
import { AgentView } from './AgentView';
import { ModelPage } from './ModelPage';
import { CanvasHistory } from './CanvasHistory';
import { FileBar, FolderChip, FolderField, FolderPanel, folderName, useFolderSuggestion, useProjectFolder } from './ProjectFolder';
import './demo-polish.css';
import type { AssistantState, AssistantFocus, AssistantReference } from '../shared/assistant';
import type { OutsideAgentsStatus } from '../shared/outside-agents';

type NewBlockType = 'dataset' | 'code' | 'notebook' | 'report' | 'notion' | 'file';

export function App(){
  const [agentId,setAgentId]=useState<AgentId|null>(null),[installedAgents,setInstalledAgents]=useState<AgentId[]>([]);
  const [pluginId,setPluginId]=useState<PluginId|null>(null),[installedPlugins,setInstalledPlugins]=useState<PluginId[]>([]);
  // Skills share the Plugins page: its sidebar switches between the two.
  const [pluginsSection,setPluginsSection]=useState<PluginsSection>('plugins'),[skillName,setSkillName]=useState<string|null>(null),[skillList,setSkillList]=useState<SkillSummary[]>([]);
  const [projectOpen,setProjectOpenState]=useState<boolean>(()=>readSaved('sidebar-project-open',true));const setProjectOpen=(open:boolean)=>{setProjectOpenState(open);saveLocal('sidebar-project-open',open);};
  const [projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState<string|null>(null),[detail,setDetail]=useState<ProjectDetail|null>(null);
  const [setup,setSetup]=useState<SetupStatus|null>(null),[setupOpen,setSetupOpen]=useState(false);
  const [connections,setConnections]=useState<ConnectionStatus[]>([]),[policy,setPolicy]=useState<ResearchPolicy|null>(null),[sessions,setSessions]=useState<ResearchSession[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null),[expandedIds,setExpandedIds]=useState<string[]>([]),[focusId,setFocusId]=useState<string|null>(null),[frame,setFrame]=useState<{ids:string[];key:number}|null>(null);
  const [inspectorId,updateInspectorId]=useState<string|null>(null),[researchNodeId,setResearchNodeId]=useState<string|null>(null),[artifact,setArtifact]=useState<{value:Artifact;nodeId:string}|null>(null);
  const [dialog,setDialog]=useState<'policy'|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(0);
  const [newProject,setNewProject]=useState(false),[addScope,setAddScope]=useState<string|null|undefined>(undefined),[sidebarOpen,setSidebarOpen]=useState(window.innerWidth>1100);
  const [previewId,setPreviewId]=useState<string|null>(null),[historyOpen,setHistoryOpen]=useState(false),[historical,setHistorical]=useState<Change|null>(null),[attachment,setAttachment]=useState<{artifact?:Artifact;nodeId?:string}|null>(null);
  const [assistant,setAssistant]=useState<AssistantState|null>(null),[rosMode,updateRosMode]=useState<RosMode>(()=>{const saved=readSaved<string>('ros-mode','bar');return saved==='half'||saved==='full'?saved:'bar';}),[page,setPage]=useState<RailPage>('canvas'),[chatBusy,setChatBusy]=useState(false),[assistantLoadError,setAssistantLoadError]=useState(''),[chatPrefill,setChatPrefill]=useState('');
  /** The / menu of the Ros bar opens the Skills page. */
  const openSkills=useCallback(()=>{setPage('plugins');setPluginsSection('skills');setSkillName(null);},[]);
  // Agent blocks show their turn's live state; the timeline itself stays with the assistant turn.
  const agentTurns=useMemo(()=>Object.fromEntries((assistant?.turns??[]).filter(turn=>turn.source==='claude-agent'||turn.source==='codex-agent'||turn.source==='model-agent').map(turn=>[turn.id,{status:turn.status,runtime:turn.source==='claude-agent'?'Claude Code':turn.source==='model-agent'?turn.model??'Agent':'Codex',thought:[...turn.events].reverse().find(event=>event.kind==='thought')?.message,pending:turn.actions.filter(item=>item.status==='pending'&&(!item.proposalId||detail?.proposals.find(proposal=>proposal.id===item.proposalId)?.status==='pending')).length}])),[assistant?.turns,detail?.proposals]);
  const [assistantFocus,setAssistantFocus]=useState<AssistantFocus>({nodeId:null}),[deleteCandidate,setDeleteCandidate]=useState<Project|null>(null),[projectMenu,setProjectMenu]=useState<string|null>(null);
  const [tourOpen,setTourOpen]=useState(false),[reportEditor,setReportEditor]=useState<{artifact?:Artifact}|null>(null),[agentReportId,setAgentReportId]=useState<string|null>(null);
  const [inspectorConversation,setInspectorConversation]=useState(false),[folderDialog,setFolderDialog]=useState(false);
  const setInspectorId=(id:string|null)=>{updateInspectorId(id);setInspectorConversation(false);};
  const [codeAttempt,setCodeAttempt]=useState<{nodeId:string;runId:string}|null>(null);
  const [outputGuide,setOutputGuide]=useState<{artifact:Artifact;destinationId:string}|null>(null);
  const [demoPicker,setDemoPicker]=useState(()=>!readSaved('demo-offer-seen',false)),[demoSession,setDemoSession]=useState<TutorialSession|null>(null),[demoOpen,setDemoOpen]=useState(false),[demoOpenVersion,setDemoOpenVersion]=useState(0);
  const dismissDemoPicker=()=>{saveLocal('demo-offer-seen',true);setDemoPicker(false);};
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
    const [detailResult,policyResult,sessionsResult,assistantResult]=await Promise.allSettled([api<ProjectDetail>(`/api/projects/${id}`),api<ResearchPolicy>(`/api/projects/${id}/policy`),api<ResearchSession[]>(`/api/projects/${id}/research`),api<AssistantState>(`/api/projects/${id}/assistant`)]);
    if(detailResult.status==='rejected')throw detailResult.reason;
    const next=detailResult.value;
    const nextAssistant=assistantResult.status==='fulfilled'?assistantResult.value:null;
    if(projectRef.current===id&&request>appliedRefresh.current){
      appliedRefresh.current=request;setDetail(next);noteRevision(id,next.project.revision);if(policyResult.status==='fulfilled')setPolicy(policyResult.value);if(sessionsResult.status==='fulfilled')setSessions(sessionsResult.value);if(nextAssistant){setAssistant(nextAssistant);setAssistantLoadError('');}else setAssistantLoadError(assistantResult.status==='rejected'?(assistantResult.reason instanceof Error?assistantResult.reason.message:String(assistantResult.reason)):'The saved conversation could not be loaded.');
      setAssistantFocus(current=>current.nodeId&&!next.project.canvas.nodes.some(node=>node.id===current.nodeId)?{nodeId:null}:current);
      if(nextAssistant&&restoreFocus&&focusAtStart===focusSequence.current){setAssistantFocus(nextAssistant.focus);setSelectedId(nextAssistant.focus.nodeId);}
      setProjects(current=>current.map(project=>project.id===id?next.project:project));
    }
    return next;
  },[]);
  useEffect(()=>{const changed=()=>{void refresh().catch(report);};window.addEventListener('ros-ai-model-settings',changed);return()=>window.removeEventListener('ros-ai-model-settings',changed);},[refresh,report]);
  useEffect(()=>{void Promise.all([api<Project[]>('/api/projects'),api<ConnectionStatus[]>('/api/connections')]).then(([list,providers])=>{setProjects(list);setConnections(providers);let last:string|null=null;try{last=localStorage.getItem('ros-ai-project');}catch{/* Storage can be blocked; fall back to the first project. */}setProjectId(list.some(p=>p.id===last)?last:list[0]?.id||null);}).catch(report).finally(()=>setLoading(false));return()=>{if(errorTimer.current)clearTimeout(errorTimer.current);};},[report]);
  useEffect(()=>{if(!projectId){setDetail(null);setAssistant(null);return;}try{localStorage.setItem('ros-ai-project',projectId);}catch{/* The service keeps the project; only the last-opened choice is lost. */}setDetail(null);setPolicy(null);setSessions([]);setAssistant(null);setAssistantFocus({nodeId:null});setProjectMenu(null);setArtifact(null);setReportEditor(null);setAgentReportId(null);setResearchNodeId(null);const saved=readSaved<{selectedId:string|null}>(`navigation:${projectId}`,{selectedId:null});setSelectedId(saved.selectedId);setExpandedIds(readSaved(`expanded-groups:${projectId}`,[]));setInspectorId(null);setDialog(null);setFolderDialog(false);setHistorical(null);setPreviewId(null);setHistoryOpen(false);void refresh(projectId,true).catch(report);},[projectId,refresh,report]);
  useEffect(()=>{if(projectId&&detail?.project.id===projectId){saveLocal(`navigation:${projectId}`,{selectedId,workNodeId:selectedId});saveLocal(`expanded-groups:${projectId}`,expandedIds);}},[projectId,detail?.project.id,selectedId,expandedIds]);
  const hasActive=detail?.runs.some(run=>['running','queued'].includes(run.status))||sessions.some(s=>s.status==='running')||Boolean(assistant?.activeTurnId),notebookRunning=Boolean(detail?.notebooks?.some(item=>item.running));
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
  const live=useLiveTurns(projectId,Boolean(assistant?.activeTurnId)||chatBusy,()=>void refresh().catch(report)),liveAssistant=useMemo(()=>withLive(assistant,live),[assistant,live]);
  useEffect(()=>{if(!hasActive&&!chatBusy&&!notebookRunning)return;let polling=false;const interval=setInterval(()=>{if(polling)return;polling=true;void refresh().catch(report).finally(()=>{polling=false;});},1500);return()=>clearInterval(interval);},[hasActive,chatBusy,notebookRunning,refresh,report]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&!(event.target instanceof Element&&event.target.closest('.cm-editor'))){setNewProject(false);setDialog(null);setFolderDialog(false);setAttachment(null);setAddScope(undefined);setInspectorId(null);setResearchNodeId(null);setArtifact(null);setReportEditor(null);setAgentReportId(null);setDeleteCandidate(null);setProjectMenu(null);setDemoPicker(false);saveLocal('demo-offer-seen',true);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  const action=useCallback(async(fn:()=>Promise<unknown>,shouldRefresh=true)=>{setSaving(n=>n+1);try{await fn();if(shouldRefresh)await refresh();return true;}catch(cause){report(cause);if(shouldRefresh)await refresh().catch(()=>undefined);return false;}finally{setSaving(n=>n-1);}},[refresh,report]);
  // Run canvas edits one at a time against the newest revision this browser has seen,
  // so quick consecutive edits do not trip the server's stale-canvas check.
  const mutationQueue=useRef<Promise<unknown>>(Promise.resolve()),knownRevision=useRef<{projectId:string;revision:number}|null>(null);
  const noteRevision=(id:string,revision:number)=>{const known=knownRevision.current;if(known?.projectId!==id||revision>known.revision)knownRevision.current={projectId:id,revision};};
  const mutate=(operations:Mutation[],label:string)=>{if(!projectId||!detail||historical)return Promise.resolve(false);const id=projectId,seen=detail.project.revision;
    const run=mutationQueue.current.then(()=>action(async()=>{noteRevision(id,seen);const project=await post<Project>(`/api/projects/${id}/mutations`,{operations,label,expectedRevision:knownRevision.current!.revision});noteRevision(id,project.revision);}));
    mutationQueue.current=run.catch(()=>undefined);return run;};
  const selectFocus=(nodeId:string|null,artifactId:string|null=null)=>{
    // A block that only exists in a proposal can be selected, but Ros cannot focus on it yet.
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
  const showTourStage=(nodeId:string)=>{setArtifact(null);setInspectorId(null);setDialog(null);setResearchNodeId(null);revealNode(nodeId);setExpandedIds(current=>[...new Set([...current,nodeId])]);};
  // The guided demo shows each step's new blocks together.
  const frameBlocks=(ids:string[])=>{setArtifact(null);setInspectorId(null);setDialog(null);setResearchNodeId(null);setFocusId(null);if(selectedId)selectFocus(null);setFrame({ids,key:Date.now()});};
  /** A PDF or image chosen or dropped is saved into files/ in the project folder; the block shows it from there. */
  const saveFile=async(file:File)=>{
    if(!detail)throw new Error('Open a project first.');
    if(!fileMediaType(file.name))throw new Error(`${file.name} is not a PDF, PNG or JPEG.`);
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
  const addNode=async(kind:NodeKind,scope:string|null,title:string,blockType?:NewBlockType,chosenFile?:File,notion?:NotionView,label?:string)=>{
    if(!detail)return;
    const id=crypto.randomUUID();
    let display=blockType==='notion'?'Notion':blockType==='dataset'?'Data':blockType&&blockType!=='report'?blockType[0].toUpperCase()+blockType.slice(1):kind==='group'?'Group':label?label[0].toUpperCase()+label.slice(1):'Text';
    // A Notion link is read once first, so a wrong link or filter is caught before the block exists,
    // and the block learns whether it shows a page or a database.
    let read:NotionRead|undefined;
    if(notion){try{read=await post<NotionRead>('/api/notion/views/preview',notion);}catch(reason){report(reason);return;}notion={...notion,kind:read.kind==='page'?'page':'database'};display=read.kind==='page'?'Notion page':'Notion database';}
    const notebookFile=blockType==='notebook'?chosenFile:undefined;
    let file:{path:string}|undefined;
    if(blockType==='file'){if(!chosenFile)return;try{file=await saveFile(chosenFile);}catch(reason){report(reason);return;}}
    let name=title.trim()||read?.title.slice(0,200)||(notebookFile?.name.replace(/\.ipynb$/iu,'').trim().slice(0,200)??'')||(file?chosenFile!.name.replace(/\.[^.]+$/u,'').trim().slice(0,200):'');
    if(!name){
      const titles=new Set(detail.project.canvas.nodes.map(node=>node.title.toLocaleLowerCase()));
      name=display;
      for(let suffix=2;titles.has(name.toLocaleLowerCase());suffix++)name=`${display} ${suffix}`;
    }
    const canvas={...detail.project.canvas,nodes:detail.project.canvas.nodes.filter(n=>(n.parentId||null)===scope)};
    if(await mutate([{type:'addNode',node:{id,kind,blockType,parentId:scope,title:name,description:'',...(label?{label}:{}),...(blockType==='code'?{code:blankCode}:{}),...(notion?{notion}:{}),...(file?{file}:{}),...emptyPosition(canvas)}}],`Add ${display}`)){
      setAddScope(undefined);
      if(notebookFile&&blockType==='notebook')await post(`/api/projects/${detail.project.id}/nodes/${id}/notebook/import`,{name:notebookFile.name,content:await notebookFile.text()}).catch(report);
      // Code and notebooks open straight into their editors once the block exists on the canvas.
      setInspectorId(blockType==='code'||blockType==='notebook'?id:null);
      selectFocus(id);
      if(scope)setExpandedIds(current=>[...new Set([...current,scope])]);
      setFocusId(id);
      setPreviewId(null);
    }
  };
  const queueAssistantMessage=(id:string,message:string,focus:AssistantFocus)=>{
    // Message admission also saves focus, so keep it ordered with selections.
    const request=(focusWrites.current.get(id)||Promise.resolve()).then(()=>post<AssistantState>(`/api/projects/${id}/assistant/messages`,{message,focus}));
    focusWrites.current.set(id,request.then(()=>undefined,()=>undefined));
    return request;
  };
  const createProject=async(title:string,start:'blank'|'demo'|'conversation',question:string,folder?:string)=>{let created:Project|undefined;const success=await action(async()=>{created=await post<Project>('/api/projects',{title,start,...(folder?{folder}:{})});const project=created;setProjects(current=>[project,...current]);setProjectId(project.id);setAssistantOpen(start==='conversation'||start==='demo');},false);if(!success||!created)return;setNewProject(false);if(start==='conversation'&&question.trim()){setChatBusy(true);try{await queueAssistantMessage(created.id,question.trim(),{nodeId:null});await refresh(created.id);}catch(cause){setChatPrefill(question);report(cause);}finally{setChatBusy(false);}}};
  // A folder ros.ai made reconnects to its project; any other folder becomes a new project.
  const openFolder=async(path:string)=>{const success=await action(async()=>{const project=await post<Project>('/api/folders/open',{path});setProjects(current=>[project,...current.filter(item=>item.id!==project.id)]);if(projectRef.current===project.id){await refresh(project.id);folder.reload();}else setProjectId(project.id);},false);if(success){setNewProject(false);setFolderDialog(false);}return success;};
  const openCreatedDemo=async(session:TutorialSession)=>{dismissDemoPicker();setNewProject(false);setTourOpen(false);setDemoSession(session);if(session.scenario==='workflow'){updateRightPanel(null);setSidebarOpen(false);}const next=await api<ProjectDetail>(`/api/projects/${session.projectId}`);setProjects(current=>[next.project,...current.filter(project=>project.id!==next.project.id)]);setProjectId(session.projectId);setDemoOpen(true);};
  const sendChat=async(message:string)=>{if(!projectId||chatBusy)return false;const id=projectId;setChatBusy(true);try{const admitted=await queueAssistantMessage(id,message,assistantFocus);if(projectRef.current===id)setAssistant(admitted);await refresh(id).catch(report);return true;}catch(cause){report(cause);await refresh(id).catch(()=>undefined);throw cause;}finally{setChatBusy(false);}};
  /** Check sources on a block: Ros takes the block in focus and checks its claims on the web. */
  const checkSources=async(node:CanvasNode)=>{if(!projectId||chatBusy)return;const id=projectId;setInspectorId(null);setSelectedId(node.id);setAssistantFocus({nodeId:node.id});setChatBusy(true);try{const admitted=await queueAssistantMessage(id,checkSourcesRequest(node.title),{nodeId:node.id});if(projectRef.current===id)setAssistant(admitted);await refresh(id).catch(report);}catch(cause){report(cause);await refresh(id).catch(()=>undefined);}finally{setChatBusy(false);}};
  const trashProject=async(project:Project)=>{if(await action(async()=>{await post(`/api/projects/${project.id}/trash`,{});const list=await api<Project[]>('/api/projects');setProjects(list);if(projectRef.current===project.id)setProjectId(list[0]?.id||null);},false)){setDeleteCandidate(null);setProjectMenu(null);}};
  const openArtifact=(value:Artifact,nodeId:string)=>{selectFocus(nodeId,value.id);setArtifact({value,nodeId});};
  const prepareFigureRefinement=async(value:Artifact)=>{
    if(!detail)return;
    const run=detail.runs.find(item=>item.id===value.runId);
    const code=detail.artifacts.find(item=>item.runId===value.runId&&item.kind==='code')?.content||(typeof run?.configuration.code==='string'?run.configuration.code:'');
    const sourceId=run?.configuration.sourceDatasetArtifactId||run?.configuration.datasetArtifactId;
    const dataset=detail.artifacts.find(item=>item.id===sourceId&&item.kind==='dataset')||run?.inputs.find(input=>input.artifact.kind==='dataset')?.artifact||detail.artifacts.find(item=>item.runId===value.runId&&item.kind==='dataset');
    if(!code||!dataset){report(new Error('This figure has no retained generating code and exact dataset for a new analysis. Its saved image, caption and provenance remain available.'));return;}
    const id=crypto.randomUUID(),parentId=detail.project.canvas.nodes.find(item=>item.id===value.nodeId)?.parentId??null;
    const scopeCanvas={...detail.project.canvas,nodes:detail.project.canvas.nodes.filter(item=>(item.parentId??null)===parentId)};
    const operations:Mutation[]=[{type:'addNode',node:{id,kind:'activity',parentId,title:`Refine ${value.title}`.slice(0,200),description:`Revise the retained generating code using exact figure ${value.id} and dataset ${dataset.id}. No new analysis has run.`,...emptyPosition(scopeCanvas)}}];
    if(detail.project.canvas.nodes.some(item=>item.id===value.nodeId))operations.push({type:'addConnection',connection:{id:crypto.randomUUID(),source:value.nodeId,target:id,label:'figure refinement'}});
    if(!await mutate(operations,'Prepare figure code refinement'))return;
    await action(async()=>{await post(`/api/projects/${projectId}/inputs`,{nodeId:id,artifactId:dataset.id});await post(`/api/projects/${projectId}/inputs`,{nodeId:id,artifactId:value.id});});
    saveLocal(`experiment-code:${id}`,code);saveLocal(`experiment-csv:${id}`,dataset.content);saveLocal(`experiment-dataset-source:${id}`,dataset.id);saveLocal(`experiment-request:${id}`,`Refine ${value.title}`);saveLocal(`experiment-parameters:${id}`,JSON.stringify(run?.configuration.parameters??{},null,2));saveLocal(`experiment-backend:${id}`,['docker-python','nebius-sandbox','bounded'].includes(String(run?.configuration.backend))?run!.configuration.backend:'docker-python');saveLocal(`node-tab:${id}`,'experiment');
    setArtifact(null);selectFocus(id);setInspectorId(id);if(parentId)setExpandedIds(current=>[...new Set([...current,parentId])]);
  };
  const navigateReference=(reference:AssistantReference)=>{if(!detail)return;setHistorical(null);if(window.innerWidth<850)setAssistantOpen(false);if(reference.nodeId)revealNode(reference.nodeId);if(reference.kind==='artifact'){const value=detail.artifacts.find(item=>item.id===reference.id);if(value){revealNode(value.nodeId);openArtifact(value,value.nodeId);}}else if(reference.kind==='proposal'){setPreviewId(reference.id);setRos('bar');}else if(reference.kind==='run'){const run=detail.runs.find(item=>item.id===reference.id);if(run){saveLocal(`node-tab:${run.nodeId}`,run.configuration.kind==='local-experiment'?'experiment':'runs');revealNode(run.nodeId,true);}}else if(reference.kind==='node')revealNode(reference.id);else if(reference.kind==='message'){const message=detail.messages.find(item=>item.id===reference.id);if(message?.nodeId){saveLocal(`node-tab:${message.nodeId}`,'work');revealNode(message.nodeId,true);setInspectorConversation(true);}}};
  const attach=async(value:Artifact,nodeId?:string)=>{if(!nodeId){setAttachment({artifact:value});return;}await action(()=>post(`/api/projects/${projectId}/inputs`,{artifactId:value.id,nodeId}));};
  const pin=async(value:Artifact,nodeId:string)=>{const existing=detail?.highlights?.find(h=>h.nodeId===nodeId&&h.artifactId===value.id);await action(()=>existing?api(`/api/projects/${projectId}/highlights/${existing.id}`,{method:'DELETE'}):post(`/api/projects/${projectId}/highlights`,{nodeId,artifactId:value.id,x:0,y:0}));};
  const preview=!historical?detail?.proposals.find(p=>p.id===previewId&&p.status==='pending'):undefined;const currentCanvas=historical?.canvas||detail?.project.canvas;const selectedNode=currentCanvas?.nodes.find(n=>n.id===selectedId);// While a proposal is previewed, a block it adds or changes opens as proposed, read only.
  const previewed=preview&&detail?previewCanvas(detail.project.canvas,preview):undefined;const proposedNode=inspectorId&&previewed?.marks.get(inspectorId)&&previewed.marks.get(inspectorId)!=='removed'?previewed.canvas.nodes.find(n=>n.id===inspectorId):undefined;const inspectorNode=proposedNode||currentCanvas?.nodes.find(n=>n.id===inspectorId);const inspectorFile=folderStatus?.files.find(file=>file.nodeId===inspectorId);const notebookNode=detail&&inspectorNode?.blockType==='notebook'&&inspectorNode.kind!=='group'&&!inspectorConversation&&!historical&&!proposedNode?inspectorNode:undefined;
  const reloadConnections=async()=>{setConnections(await api<ConnectionStatus[]>('/api/connections'));await refresh();};
  // First launch: what ros.ai found on this computer. Seen once, the screen stays away until Agents asks for it again.
  useEffect(()=>{if(loading||publicDemo)return;let stopped=false;const load=()=>api<SetupStatus>('/api/setup').then(value=>{if(stopped)return;setSetup(value);setSetupOpen(value.show);}).catch(()=>undefined);void load();const again=()=>{setPage('canvas');void load();};window.addEventListener('ros-setup-reset',again);return()=>{stopped=true;window.removeEventListener('ros-setup-reset',again);};},[loading,publicDemo]);
  const finishSetup=async(next?:RailPage)=>{setSetupOpen(false);void post('/api/setup/seen').catch(()=>undefined);if(next)setPage(next);await reloadConnections().catch(report);};
  const settingsOpen=page==='usage'||page==='balances'||page==='general'||page==='memory'||page==='resources';
  const railPage=page==='canvas'?null:<RailPageFrame page={page}>{page==='model'?<ModelPage key={projectId||'local'} projectId={projectId} connections={connections} publicDemo={publicDemo} selected={agentId} onSelect={setAgentId} onInstalled={setInstalledAgents} onChanged={reloadConnections}/>:page==='usage'?<UsageSettings publicDemo={publicDemo}/>:page==='balances'?<BalanceSettings publicDemo={publicDemo}/>:page==='general'?<GeneralSettings projectId={projectId} projectTitle={detail?demoDisplayTitle(detail.project):null} policy={policy} publicDemo={publicDemo} onChanged={()=>refresh()}/>:page==='memory'?<MemoryPage publicDemo={publicDemo}/>:page==='plugins'?pluginsSection==='skills'?<SkillsPage publicDemo={publicDemo} selected={skillName} onSelect={setSkillName} onSkills={setSkillList}/>:<PluginsPage projectId={projectId} publicDemo={publicDemo} selected={pluginId} onSelect={setPluginId} onInstalled={setInstalledPlugins} onChanged={reloadConnections} onResources={()=>setPage('resources')}/>:detail?<div className="settings-page"><h1>Resources</h1><Resources key={detail.project.id} detail={detail} onChanged={()=>refresh()} onOpenArtifact={openArtifact}/></div>:<div className="settings-page"><h1>Resources</h1><p className="rail-page-note">Open a project to see its resources.</p></div>}</RailPageFrame>;
  return <div className={`app-shell single-canvas-shell ${sidebarOpen?'':'sidebar-hidden'}`}>
    <AppRail page={page} onPage={setPage}/>
    <aside className="sidebar" aria-label="Projects and notes">
      <div className="brand-row"><a className="wordmark" href="/" aria-label="ros.ai home"><Wordmark/></a><button className="icon-button" aria-label="Hide sidebar" onClick={()=>setSidebarOpen(false)}><PanelLeftClose size={17}/></button></div>
      {!settingsOpen&&page!=='plugins'&&page!=='model'&&<button className="new-project-button" data-testid="new-project" onClick={()=>setNewProject(true)}><Plus size={16}/> New project</button>}
      {settingsOpen?<div className="sidebar-content"><SettingsSidebar section={page as SettingsSection} onSection={setPage}/></div>:page==='plugins'?<div className="sidebar-content"><PluginsSidebar section={pluginsSection} onSection={section=>{setPluginsSection(section);setPluginId(null);setSkillName(null);}} installed={installedPlugins} selected={pluginId} onSelect={setPluginId} skills={skillList} skill={skillName} onSkill={setSkillName}/></div>:page==='model'?<div className="sidebar-content"><AgentsSidebar installed={installedAgents} selected={agentId} onSelect={setAgentId}/></div>:<div className="sidebar-content"><div className="sidebar-label">Projects <span>{projects.length}</span></div><nav className="project-list" aria-label="Projects">{projects.map(p=><div key={p.id} className={`project-group ${p.id===projectId?'active':''}`}><div className={`project-row ${p.id===projectId?'active':''}`}><button className={`project-item ${p.id===projectId?'active':''}`} onClick={()=>{if(p.id===projectId)setProjectOpen(!projectOpen);else{setProjectId(p.id);setProjectOpen(true);}if(window.innerWidth<950&&p.id!==projectId)setSidebarOpen(false);}} aria-expanded={p.id===projectId?projectOpen:undefined}><FolderOpen size={15}/><span title={p.title}>{demoDisplayTitle(p)}</span></button><button className="icon-button project-menu-toggle" aria-label={`Project actions for ${demoDisplayTitle(p)}`} aria-expanded={projectMenu===p.id} onClick={()=>setProjectMenu(projectMenu===p.id?null:p.id)}><MoreHorizontal size={16}/></button>{projectMenu===p.id&&<div className="project-menu"><button className="danger" onClick={()=>{setDeleteCandidate(p);setProjectMenu(null);}}><Trash2 size={14}/> Remove project…</button></div>}{p.id===projectId&&<button className="icon-button project-fold" aria-label={projectOpen?'Collapse blocks':'Show blocks'} onClick={()=>setProjectOpen(!projectOpen)}>{projectOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>}</div>{p.id===projectId&&projectOpen&&detail&&<div className="project-blocks"><NoteTree key={detail.project.id} projectId={detail.project.id} nodes={detail.project.canvas.nodes} runs={detail.runs} selectedId={selectedId} limit={5} onSelect={id=>{revealNode(id);if(window.innerWidth<950)setSidebarOpen(false);}}/></div>}</div>)}</nav></div>}
      <div className="sidebar-footer"><div className="local-label"><span className="local-square"/> {publicDemo?'Saved for this browser on the demo server':'Saved on this computer'}</div></div>
    </aside>
    {sidebarOpen&&<button className="sidebar-backdrop" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}/>}
    <main className="workspace">{railPage}<header className="workspace-header"><div className="workspace-heading">{!sidebarOpen&&<button className="icon-button" aria-label="Show sidebar" onClick={()=>setSidebarOpen(true)}><PanelLeftOpen size={17}/></button>}<h1 data-tour-target="project-title">{(detail&&demoDisplayTitle(detail.project))||(loading?'Opening workspace…':'Your research')}</h1>{!publicDemo&&(folderStatus?<FolderChip status={folderStatus} onClick={()=>setFolderDialog(true)}/>:<span className="local-badge">Local</span>)}</div>{detail&&<div className="workspace-actions"><span className="saved-indicator">{saving?<LoaderCircle size={12} className="spin"/>:<Check size={12}/>} {saving?'Saving':'Saved'}</span></div>}</header>
      {setupOpen&&setup?<div className="workspace-body"><SetupScreen status={setup} onDone={()=>void finishSetup()} onAgents={()=>void finishSetup('model')} onChanged={reloadConnections}/></div>:!detail?<div className="workspace-body"><div className="workspace-welcome">{loading||projectId?<><LoaderCircle size={25} className="spin"/><p>Opening your workspace…</p></>:<RosStart folders={!publicDemo} onStart={(title,question,folder)=>createProject(title,'conversation',question,folder)} onAdvanced={()=>setNewProject(true)} onDemo={()=>setDemoPicker(true)}/>}</div></div>:<div className={`workspace-body single-workspace ${rightPanel?'assistant-open':'assistant-closed'}`}><div className="canvas-stage"><ResearchCanvas agentTurns={agentTurns} notices={<>{policy?.stopped&&<div className="canvas-notice" role="status"><Square size={13}/> Research is stopped. <button className="text-button" onClick={()=>void action(()=>post(`/api/projects/${projectId}/policy/resume`))}>Resume</button></div>}{historical&&<div className="canvas-notice history-banner"><Clock3 size={15}/><div><strong>Viewing revision {historical.revision}</strong><span>{historical.label} · {date(historical.createdAt)}</span></div><button className="small secondary" onClick={()=>setHistorical(null)}>Back to current canvas</button></div>}</>} proposalCard={preview&&<ProposalPreview proposal={preview} revision={detail.project.revision} onClose={()=>setPreviewId(null)} onAccept={async()=>{if(await action(()=>post(`/api/projects/${projectId}/proposals/${preview.id}/accept`)))setPreviewId(null);}} onDismiss={async()=>{if(await action(()=>post(`/api/projects/${projectId}/proposals/${preview.id}/dismiss`)))setPreviewId(null);}} onRefine={()=>{setAssistantOpen(true);setChatPrefill(`Refine the proposal “${preview.summary}”: `);}} busy={saving>0}/>} detail={detail} selectedId={selectedId} onSelect={id=>selectFocus(id)} onInspect={id=>revealNode(id,true)} onArtifact={openArtifact} onReuse={(value,nodeId)=>void attach(value,nodeId)} onPin={(value,nodeId)=>void pin(value,nodeId)} highlights={detail.highlights||[]} onMoveHighlight={(id,nodeId,position)=>void action(()=>api(`/api/projects/${projectId}/highlights/${id}`,{method:'PATCH',body:JSON.stringify({nodeId,...position})}))} mutate={mutate} onAdd={setAddScope} onUndo={()=>void action(()=>post(`/api/projects/${projectId}/undo`))} onRedo={()=>void action(()=>post(`/api/projects/${projectId}/redo`))} onHistory={()=>setHistoryOpen(!historyOpen)} onDemo={demoSession?()=>{if(window.innerWidth<=850)setRightPanel(null);setDemoOpenVersion(version=>version+1);setDemoOpen(true);setTourOpen(false);}:undefined} demoLabel="Tutorial" onTour={!demoSession&&demoEvidence(detail).article?()=>{showTourStage('stage-explore');setTourOpen(true);}:undefined} historyOpen={historyOpen} busy={saving>0} proposal={preview} historyCanvas={historical?.canvas} expandedIds={expandedIds} onExpandedChange={setExpandedIds} focusId={focusId} frame={frame} missingFiles={missingFiles} folderFiles={folderFiles} onDropFiles={(files,position)=>void dropFiles(files,position)}/>
        {detail&&notebookNode&&<NotebookView key={notebookNode.id} node={notebookNode} detail={detail} file={inspectorFile} mode={policy?policy.overrides[notebookNode.id]??policy.mode:undefined} onClose={()=>setInspectorId(null)} onRefresh={()=>refresh()} onError={report} onPermissions={()=>setDialog('policy')} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onReport={value=>setReportEditor({artifact:value})} onInterpret={(value,destinationId)=>setOutputGuide({artifact:value,destinationId})}/>}
        {selectedNode&&!historical&&!preview&&!notebookNode&&<div className="selection-toolbar" role="toolbar" aria-label="Selected workspace actions"><span><KindIcon kind={selectedNode.kind} blockType={selectedNode.blockType}/><strong>{selectedNode.title}</strong></span><button className="secondary small" onClick={()=>setInspectorId(selectedNode.id)}>Details</button><button className="secondary small" onClick={()=>{saveLocal(`node-tab:${selectedNode.id}`,'work');setInspectorId(selectedNode.id);setInspectorConversation(true);}}><MessageSquare size={13}/> Discuss</button>{selectedNode.kind==='group'&&<button className="secondary small" onClick={()=>setAddScope(selectedNode.id)}><Plus size={13}/> Add inside</button>}<button className="primary small" onClick={()=>setResearchNodeId(selectedNode.id)}><Play size={13}/> Research</button></div>}
        {hasActive&&<div className="project-floating-actions"><button className="secondary danger" onClick={()=>void action(()=>post(`/api/projects/${projectId}/stop`))}><Square size={13}/> Stop all research</button></div>}
        {rosMode==='bar'&&!notebookNode&&<RosBar state={liveAssistant} detail={detail} policy={policy} focus={assistantFocus} busy={chatBusy} onSend={sendChat} onCancel={turnId=>action(()=>post(`/api/projects/${projectId}/assistant/turns/${turnId}/cancel`))} onClearFocus={()=>selectFocus(null)} onRefresh={()=>refresh().catch(report)} onConnections={()=>setPage('model')} onPermissions={()=>setDialog('policy')} onOpen={setRos} onSkills={openSkills}/>}
        {historyOpen&&<div id="canvas-content-history"><CanvasHistory detail={detail} historical={historical} onClose={()=>setHistoryOpen(false)} onCanvas={change=>{setHistorical(change);setPreviewId(null);}} onEvidence={value=>{setHistorical(null);openArtifact(value,value.nodeId);}}/></div>}
    {detail&&!demoPicker&&demoSession&&demoOpen&&demoSession.projectId===detail.project.id&&(demoSession.scenario==='workflow'?<WorkflowDemo key={`${demoSession.projectId}:${demoOpenVersion}`} session={demoSession} detail={detail} onSession={setDemoSession} onRefresh={()=>refresh()} onFrame={frameBlocks} onOpen={nodeId=>{const node=detail.project.canvas.nodes.find(item=>item.id===nodeId),value=node?.artifactId?detail.artifacts.find(item=>item.id===node.artifactId):undefined;if(value&&!['code','notebook'].includes(node?.blockType??'')){setInspectorId(null);setDialog(null);openArtifact(value,nodeId);}else{saveLocal(`node-tab:${nodeId}`,'overview');setArtifact(null);revealNode(nodeId,true);}}} onClose={()=>setDemoOpen(false)}/>:<ExecutableDemo key={`${demoSession.projectId}:${demoOpenVersion}`} session={demoSession} detail={detail} onSession={setDemoSession} onRefresh={()=>refresh()} onStage={showTourStage} onNote={nodeId=>{saveLocal(`node-tab:${nodeId}`,'overview');setArtifact(null);revealNode(nodeId,true);}} onArtifact={value=>{setInspectorId(null);setDialog(null);openArtifact(value,value.nodeId);}} onClose={()=>setDemoOpen(false)}/>)}
    {detail&&tourOpen&&<DemoTour key={detail.project.id} detail={detail} modelAvailable={assistant?.modelAvailable??false} onArtifact={value=>{setInspectorId(null);setDialog(null);setResearchNodeId(null);openArtifact(value,value.nodeId);}} onResources={()=>{setArtifact(null);setInspectorId(null);setDialog(null);setPage('resources');}} onStage={showTourStage} onNote={nodeId=>{setArtifact(null);setDialog(null);revealNode(nodeId,true);}} onPrepareRefinement={nodeId=>{setArtifact(null);setInspectorId(null);selectFocus(nodeId);setRightPanel('assistant');setChatPrefill('Using only this draft and its selected evidence, propose one paragraph revision that makes the study coverage and methodological limitations clearer. Retain citations and qualified claims. Do not search or execute code. Show the proposed paragraph for review.');}} onExit={()=>setTourOpen(false)}/>}
      </div>{assistantOpen&&<AssistantPanel key={detail.project.id} onSkills={openSkills} state={liveAssistant} detail={detail} policy={policy} focus={assistantFocus} busy={chatBusy} loadError={assistantLoadError} onSend={sendChat} onRefresh={()=>refresh().catch(report)} onConnections={()=>setPage('model')} onCancel={turnId=>action(()=>post(`/api/projects/${projectId}/assistant/turns/${turnId}/cancel`))} onClearFocus={()=>selectFocus(null)} onReference={navigateReference} onPermissions={()=>setDialog('policy')} onClose={()=>setRos('bar')} mode={rosMode==='full'?'full':'half'} onMode={setRos} prefill={chatPrefill} onPrefillUsed={()=>setChatPrefill('')} onDecision={async(actionId,decision)=>{await action(()=>post(`/api/projects/${projectId}/assistant/actions/${actionId}/decision`,{decision}));}} onProposal={async(proposalId,decision)=>{if(await action(()=>post(`/api/projects/${projectId}/proposals/${proposalId}/${decision}`))&&previewId===proposalId)setPreviewId(null);}} onInspectAction={item=>{if(item.reportProposalId){setAgentReportId(item.reportProposalId);return;}if(item.nodeId){saveLocal(`node-tab:${item.nodeId}`,item.type==='experiment'?'experiment':'runs');revealNode(item.nodeId,true);}}}/>} </div>}
    </main>
    {error&&<div className="error-toast" role="alert"><div><strong>Couldn’t complete that action</strong><p>{error}</p></div><button className="icon-button" aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button></div>}

    {detail&&policy&&dialog==='policy'&&<Modal title="Permissions" className="settings-modal" onClose={()=>setDialog(null)}><PolicyPanel detail={detail} policy={policy} onRefresh={()=>refresh()}/></Modal>}
    {detail&&folderDialog&&folderStatus&&<Modal title="Project folder" className="settings-modal" onClose={()=>setFolderDialog(false)}><FolderPanel projectId={detail.project.id} projectTitle={detail.project.title} status={folderStatus} nodes={detail.project.canvas.nodes} onStatus={next=>{folder.update(next);folder.reload();}} onChanged={()=>refresh()} onOpenFolder={openFolder} onRemoveBlock={nodeId=>mutate([{type:'removeNode',id:nodeId}],'Remove block whose file is missing')}/></Modal>}

    {detail&&inspectorNode&&!notebookNode&&<Modal title={`${kindName(inspectorNode)}${textLabel(inspectorNode)?` · ${textLabel(inspectorNode)}`:''} · ${inspectorNode.title}`} className={proposedNode?'node-modal':!inspectorConversation&&inspectorNode.blockType==='code'?'code-modal':!inspectorConversation&&inspectorNode.blockType==='report'&&!inspectorNode.artifactId?'artifact-modal':'node-modal'} nonBlocking={tourOpen||demoOpen} onClose={()=>setInspectorId(null)}><>{inspectorFile&&!inspectorConversation&&!historical&&!proposedNode&&inspectorNode.blockType!=='agent'&&<FileBar projectId={detail.project.id} file={inspectorFile} onError={report}/>}{proposedNode&&previewed?<Inspector key={`proposed:${proposedNode.id}`} node={proposedNode} detail={{...detail,project:{...detail.project,canvas:previewed.canvas}}} mutate={mutate} file={proposedNode.file?shownFile(detail.project.id,proposedNode,folderFiles.get(proposedNode.id)):undefined} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onOpenNote={nodeId=>setInspectorId(nodeId)} onRun={async()=>false} onCancel={async()=>false} onRetry={async()=>false} onAttach={()=>undefined} readOnly readOnlyNote="Proposed change · accept it to make edits."/>:inspectorNode.blockType==='agent'?<AgentView node={inspectorNode} turn={inspectorNode.agent?assistant?.turns.find(item=>item.id===inspectorNode.agent!.turnId):undefined} detail={detail} onOpenNode={nodeId=>{setInspectorId(null);revealNode(nodeId,true);}} onReveal={nodeId=>{setInspectorId(null);revealNode(nodeId);}} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onReview={id=>{setInspectorId(null);setPreviewId(id);}}/>:!inspectorConversation&&inspectorNode.blockType==='code'?<CodeBlock key={`${inspectorNode.id}:${codeAttempt?.nodeId===inspectorNode.id?codeAttempt.runId:''}`} initialRunId={codeAttempt?.nodeId===inspectorNode.id?codeAttempt.runId:undefined} node={inspectorNode} detail={detail} policy={policy} onRefresh={()=>refresh()} onUpdate={patch=>mutate([{type:'updateNode',id:inspectorNode.id,patch}],'Edit Code source and settings')} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onReport={value=>{setInspectorId(null);setReportEditor({artifact:value});}} onInterpret={(value,destinationId)=>{setInspectorId(null);setOutputGuide({artifact:value,destinationId});}} onClose={()=>setInspectorId(null)}/>:!inspectorConversation&&inspectorNode.blockType==='report'&&!inspectorNode.artifactId?<ReportEditor key={inspectorNode.id} nodeId={inspectorNode.id} detail={detail} onSaved={(value,nodeId)=>{setInspectorId(null);openArtifact(value,nodeId);}} onChanged={()=>refresh()} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onCancel={()=>setInspectorId(null)}/>:<Inspector key={inspectorNode.id} node={inspectorNode} detail={detail} mutate={mutate} onCheckSources={()=>void checkSources(inspectorNode)} file={inspectorNode.file?shownFile(detail.project.id,inspectorNode,folderFiles.get(inspectorNode.id)):undefined} onOpenArtifact={value=>{setInspectorId(null);openArtifact(value,value.nodeId);}} onOpenNote={nodeId=>{saveLocal(`node-tab:${nodeId}`,'overview');revealNode(nodeId,true);}} onRun={(nodeId,request,useSearch)=>action(()=>post(`/api/projects/${projectId}/runs`,{nodeId,request,useSearch}))} onCancel={runId=>action(()=>post(`/api/runs/${runId}/cancel`))} onRetry={runId=>action(()=>post(`/api/runs/${runId}/retry`))} onAttach={(value,nodeId)=>setAttachment({artifact:value,nodeId})} readOnly={Boolean(historical)}/>}</></Modal>}
    {detail&&researchNodeId&&<Modal title="Research with ros.ai" className="settings-modal" onClose={()=>setResearchNodeId(null)}><ResearchPanel detail={detail} nodeId={researchNodeId} sessions={sessions} policy={policy} onRefresh={()=>refresh()} onInspect={id=>{saveLocal(`node-tab:${id}`,'experiment');setResearchNodeId(null);setInspectorId(id);}} onProposal={id=>{setResearchNodeId(null);setPreviewId(id);}}/></Modal>}
    {detail&&artifact&&<Modal title={artifact.value.title} className="artifact-modal" nonBlocking={tourOpen||demoOpen} onClose={()=>setArtifact(null)}>{artifact.value.metadata?.tutorialOrigin?<div className="artifact-dialog-meta">{artifact.value.metadata.tutorialOrigin==='saved'&&<span className="tag">Saved demonstration result</span>}{artifact.value.metadata.tutorialOrigin==='prepared'&&<span className="tag">Prepared tutorial content</span>}{artifact.value.metadata.tutorialOrigin==='recorded'&&<span className="tag">Recorded for this demo</span>}</div>:null}<ArtifactViewer key={artifact.value.id} artifact={artifact.value} detail={detail} onChanged={()=>refresh()} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onOpenAttempt={runId=>{const run=detail.runs.find(item=>item.id===runId);if(run){setArtifact(null);setCodeAttempt({nodeId:run.nodeId,runId:run.id});saveLocal(`node-tab:${run.nodeId}`,run.configuration.kind==='local-experiment'?'experiment':'runs');revealNode(run.nodeId,true);}}} onReviseFigure={value=>void prepareFigureRefinement(value)} more={<><div className="row gap wrap"><button className="secondary" onClick={()=>setReportEditor({artifact:artifact.value})}>{artifact.value.metadata?.report?'Edit report':'Use in a report'}</button><button className="secondary" onClick={()=>{const id=crypto.randomUUID();const blockType=artifact.value.kind==='plot'?'figure':artifact.value.kind==='dataset'||artifact.value.kind==='table'?'dataset':artifact.value.kind==='code'?'code':'note';void mutate([{type:'addNode',node:{id,kind:'topic',blockType,artifactId:artifact.value.id,title:artifact.value.title,description:'',...emptyPosition(detail.project.canvas)}}],`Place saved ${blockType} on canvas`);}}>Place on canvas</button>{['article','paper'].includes(String(artifact.value.metadata?.demoRole))&&<button className="secondary" onClick={()=>{const nodeId=artifact.nodeId;setArtifact(null);revealNode(nodeId,true);}}>Open editable draft</button>}<button className="secondary" onClick={()=>void pin(artifact.value,artifact.nodeId)}><Pin size={14}/>{detail.highlights?.some(h=>h.artifactId===artifact.value.id&&h.nodeId===artifact.nodeId)?'Unpin highlight':'Pin highlight'}</button></div><ResultActions inspect={false} artifact={artifact.value} detail={detail} onChanged={()=>refresh()} onOpen={value=>openArtifact(value,value.nodeId)} onInterpret={(value,destinationId)=>{setArtifact(null);setOutputGuide({artifact:value,destinationId});}}/></>}/></Modal>}
    {detail&&outputGuide&&<WorkspaceGuide key={outputGuide.artifact.id} detail={detail} initialSelection={outputGuide} onClose={()=>setOutputGuide(null)} onConnections={()=>{setOutputGuide(null);setPage('model');}} onChanged={()=>refresh()} onReference={navigateReference}/> }
    {addScope!==undefined&&<NewNodeModal scope={addScope?detail?.project.canvas.nodes.find(n=>n.id===addScope)?.title:undefined} onClose={()=>setAddScope(undefined)} onCreate={(kind,title,blockType,file,notion,label)=>addNode(kind,addScope,title,blockType,file,notion,label)}/>}
    {deleteCandidate&&<Modal title="Remove this project?" onClose={()=>setDeleteCandidate(null)}><p className="modal-description"><strong>{deleteCandidate.title}</strong> will leave your project list. Its folder on your computer is not touched.</p><div className="modal-actions"><button className="secondary" onClick={()=>setDeleteCandidate(null)}>Keep project</button><button className="primary danger-primary" disabled={saving>0} onClick={()=>void trashProject(deleteCandidate)}><Trash2 size={15}/> Remove project</button></div></Modal>}
    {detail&&agentReportId&&<Modal title="Review agent report revision" className="artifact-modal" onClose={()=>setAgentReportId(null)}><AgentReportReview id={agentReportId} detail={detail} onChanged={()=>refresh()} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onClose={()=>setAgentReportId(null)}/></Modal>}
    {detail&&reportEditor&&<Modal title={reportEditor.artifact?.metadata?.report?'Edit report':'Write a report'} className="artifact-modal" onClose={()=>setReportEditor(null)}><ReportEditor key={reportEditor.artifact?.id||'new'} detail={detail} seed={reportEditor.artifact?.metadata?.report?undefined:reportEditor.artifact} artifact={reportEditor.artifact?.metadata?.report?reportEditor.artifact:undefined} onSaved={(value,nodeId)=>{setReportEditor(null);openArtifact(value,nodeId);}} onChanged={()=>refresh()} onOpenArtifact={value=>openArtifact(value,value.nodeId)} onCancel={()=>setReportEditor(null)}/></Modal>}
    {newProject&&<NewProjectModal folders={!publicDemo} onClose={()=>setNewProject(false)} onCreate={createProject} onOpenFolder={openFolder} onDemo={()=>{setNewProject(false);setDemoPicker(true);}}/>}
    {demoPicker&&!setupOpen&&<Modal title="Explore ros.ai" className="demo-onboarding-modal" onClose={dismissDemoPicker}><DemoOnboarding onCreated={session=>{void openCreatedDemo(session).catch(report);}} onSkip={dismissDemoPicker}/></Modal>}
    {attachment&&detail&&<AttachModal detail={detail} initial={attachment} onClose={()=>setAttachment(null)} onAttach={async(artifactId,nodeId,excerpt)=>{if(await action(()=>post(`/api/projects/${projectId}/inputs`,{artifactId,nodeId,...(excerpt?{excerpt}:{})}))){setAttachment(null);setExpandedIds(ids=>[...new Set([...ids,nodeId])]);}}}/>}
    <NetworkPrompt publicDemo={publicDemo}/>
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
function ProposalPreview({ proposal, revision, onClose, onAccept, onDismiss, onRefine, busy }: { proposal: Proposal; revision: number; onClose: () => void; onAccept: () => Promise<void>; onDismiss: () => Promise<void>; onRefine: () => void; busy: boolean }) {
  const stale = proposal.baseRevision !== revision;
  // Blocks that only move are left out, and blocks moving into a group this proposal adds are counted on that group.
  const added = new Set(proposal.operations.flatMap(operation => operation.type === 'addNode' ? [operation.node.id] : []));
  const joining = (groupId: string) => proposal.operations.filter(operation => regroup(operation) === groupId).length;
  const shown = proposal.operations.filter(operation => !(operation.type === 'updateNode' && layoutOnly(operation.patch)) && !added.has(regroup(operation) ?? ''));
  const label = (operation: Mutation) => { const into = regroup(operation), count = operation.type === 'addNode' ? joining(operation.node.id) : 0; return operation.type === 'addNode' ? `+ ${operation.node.title}${count ? ` · ${count} block${count === 1 ? '' : 's'}` : ''}` : into !== undefined ? into ? 'Move into a group' : 'Move out of its group' : operation.type === 'updateNode' ? `Edit ${operation.patch.title || 'node'}` : operation.type === 'removeNode' ? '− Remove node' : operation.type === 'addConnection' ? '+ Relationship' : '− Relationship'; };
  const [heading, ...reason] = proposal.summary.split('\n');
  return <section className={`proposal-preview ${stale ? 'stale' : ''}`} aria-label="Proposal preview" data-testid="proposal-preview"><header><span className="eyebrow"><GitBranch size={13} /> Proposed change</span><button className="icon-button" aria-label="Close proposal preview" onClick={onClose}><X size={15} /></button></header><h3 title={proposal.summary}>{heading}</h3>{reason.length > 0 && <p className="proposal-reason">{reason.join(' ').replace(/^Why:\s*/u, '')}</p>}<div className="proposal-operations">{shown.map((operation, index) => <span className={`operation-tag ${operation.type.startsWith('remove') ? 'remove' : operation.type.startsWith('add') ? 'add' : 'edit'}`} key={index}>{label(operation)}</span>)}</div>{stale && <p className="stale-warning">The canvas changed since. Ask Ros to update this.</p>}<div className="proposal-actions"><button className="small primary" data-testid="accept-proposal" disabled={stale || busy} onClick={() => void onAccept()}><Check size={13} /> Accept</button><button className="small text-button" onClick={onRefine}>Refine</button><button className="small text-button" disabled={busy} data-testid="dismiss-proposal" onClick={() => void onDismiss()}>Dismiss</button></div></section>;
}

function NewProjectModal({ folders, onClose, onCreate, onOpenFolder, onDemo }: { folders: boolean; onDemo: () => void; onClose: () => void; onCreate: (title: string, start: 'blank'|'demo'|'conversation', question:string, folder?:string) => Promise<void>; onOpenFolder: (path:string) => Promise<boolean> }) {
  const [title,setTitle]=useState(''),[start,setStart]=useState<'blank'|'demo'|'conversation'|'folder'>('blank'),[question,setQuestion]=useState(''),[busy,setBusy]=useState(false);
  const suggestion=useFolderSuggestion(title,folders);
  const [folder,setFolder]=useState(''),[folderEdited,setFolderEdited]=useState(false),[existing,setExisting]=useState('');
  // The suggested folder follows the project name until the person types or picks their own.
  useEffect(()=>{if(suggestion&&!folderEdited)setFolder(suggestion.path);},[suggestion,folderEdited]);
  const needsFolder=Boolean(suggestion);
  const ready=start==='folder'?Boolean(existing.trim()):(start!=='conversation'||Boolean(question.trim()))&&(!needsFolder||Boolean(folder.trim()));
  const choices=[{id:'blank' as const,title:'Start blank',description:'An open canvas, ready for your notes.',icon:<Plus size={19}/>},{id:'demo' as const,title:'Explore a demo',description:'Build a guided example step by step.',icon:<BookOpen size={19}/>},{id:'conversation' as const,title:'Start a conversation',description:'Bring a question. Shape the research with ros.ai.',icon:<MessageSquare size={19}/>},...(needsFolder?[{id:'folder' as const,title:'Open a folder',description:'Use a folder you already have, or one ros.ai made before.',icon:<FolderOpen size={19}/>}]:[])];
  return <Modal title="Start a new project" className="new-project-modal" onClose={onClose}><p className="modal-description">Choose a starting point. Your canvas can grow in any direction.</p><form onSubmit={async event=>{event.preventDefault();if(busy||!ready)return;setBusy(true);try{if(start==='folder')await onOpenFolder(existing.trim());else await onCreate(title.trim()||(needsFolder&&folder.trim()?folderName(folder.trim()):'Untitled'),start,question,needsFolder?folder.trim():undefined);}finally{setBusy(false);}}}><div className="project-start-choices" role="radiogroup" aria-label="Project starting point">{choices.map(choice=><button key={choice.id} type="button" role="radio" aria-checked={start===choice.id} className={start===choice.id?'selected':''} onClick={()=>choice.id==='demo'?onDemo():setStart(choice.id)}>{choice.icon}<span><strong>{choice.title}</strong><small>{choice.description}</small></span><span className="choice-radio">{start===choice.id&&<Check size={11}/>}</span></button>)}</div>
    {start==='folder'?<><label className="field-label" htmlFor="existing-folder">Folder</label><FolderField id="existing-folder" value={existing} picker={Boolean(suggestion?.picker)} placeholder="~/Documents/My research" onChange={path=>setExisting(path)}/><p className="folder-note">A folder ros.ai made opens with its canvas and history. Any other folder becomes a new project, and you choose which of its files to add.</p></>
    :<><label className="field-label" htmlFor="project-name">Project name</label><input id="project-name" data-testid="project-name" value={title} maxLength={200} onChange={event=>setTitle(event.target.value)} placeholder="Untitled"/>
    {needsFolder&&<><label className="field-label" htmlFor="project-folder">Folder</label><FolderField id="project-folder" value={folder} picker={Boolean(suggestion?.picker)} onChange={(path,picked)=>{setFolder(path);setFolderEdited(true);if(picked&&!title.trim())setTitle(folderName(path));}}/><p className="folder-note">Notes, code and notebooks are saved here as ordinary files you can open in other apps. ros.ai creates the folder if needed.</p></>}</>}
    {start==='conversation'&&<><label className="field-label" htmlFor="initial-question">Your first question</label><textarea id="initial-question" rows={3} value={question} onChange={event=>setQuestion(event.target.value)} placeholder="What would you like to understand or investigate?"/><p className="subtle start-conversation-note">ros.ai can suggest a few connected notes after you discuss the question. Your project permissions apply.</p></>}{start==='demo'&&<p className="subtle start-conversation-note">The demo is a saved example, clearly labelled. Opening it does not run a model or an experiment.</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" data-testid="create-project" disabled={busy||!ready}>{busy?<LoaderCircle size={15} className="spin"/>:<ArrowRight size={15}/>} {start==='folder'?'Open folder':start==='conversation'?'Start conversation':start==='demo'?'Open demo':'Create project'}</button></div></form></Modal>;
}
function AttachModal({ detail, initial, onClose, onAttach }: { detail: ProjectDetail; initial: { artifact?: Artifact; nodeId?: string }; onClose: () => void; onAttach: (artifactId: string, nodeId: string, excerpt: string) => Promise<void> }) {
  const [artifactId, setArtifactId] = useState(initial.artifact?.id || ''); const [nodeId, setNodeId] = useState(initial.nodeId || ''); const [excerpt, setExcerpt] = useState(initial.artifact && initial.artifact.content !== detail.artifacts.find(a => a.id === initial.artifact?.id)?.content ? initial.artifact.content : ''); const [busy, setBusy] = useState(false);
  const artifact = detail.artifacts.find(a => a.id === artifactId); const available = detail.artifacts.filter(a => !initial.nodeId || a.nodeId !== initial.nodeId);
  const validExcerpt = !excerpt || Boolean(artifact?.content.includes(excerpt));
  return <Modal title="Attach a selected input" onClose={onClose}><p className="modal-description">Choose a saved version to share. Future results will not replace this selection or run the destination node.</p><form onSubmit={async event => { event.preventDefault(); if (!artifactId || !nodeId || busy || !validExcerpt) return; setBusy(true); await onAttach(artifactId, nodeId, excerpt); setBusy(false); }}><label className="field-label" htmlFor="attach-artifact">Saved result or source</label><select id="attach-artifact" value={artifactId} onChange={event => { setArtifactId(event.target.value); setExcerpt(''); }}><option value="">Choose an artifact…</option>{available.map(a => <option key={a.id} value={a.id}>{a.kind === 'source' ? 'Source' : 'Result'} · {a.title} · {date(a.createdAt)}</option>)}</select>{!available.length && <p className="subtle">Run research in another node to create a saved result.</p>}<label className="field-label" htmlFor="attach-node">Use in this node</label><select id="attach-node" value={nodeId} onChange={event => setNodeId(event.target.value)}><option value="">Choose a node…</option>{detail.project.canvas.nodes.filter(n => n.id !== artifact?.nodeId).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select>{artifact && <><details className="attach-content"><summary>Inspect captured content</summary><pre>{artifact.content}</pre><span className="subtle">Source run {artifact.runId.slice(0, 8)} · version {artifact.hash.slice(0, 12)}</span></details><label className="field-label" htmlFor="attach-excerpt">Selected excerpt <span>optional</span></label><textarea id="attach-excerpt" value={excerpt} onChange={event => setExcerpt(event.target.value)} placeholder="Paste an exact passage, or leave empty to attach the whole artifact." rows={3} />{!validExcerpt && <p className="inline-error">The excerpt must match an exact passage in this saved artifact.</p>}</>}<div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={!artifactId || !nodeId || busy || !validExcerpt}><ArrowRight size={14} /> Attach input</button></div></form></Modal>;
}

type BlockChoice = {id:'text'|'code'|'notebook'|'dataset'|'file'|'notion'|'group';kind:NodeKind;blockType?:NewBlockType;label:string;description:string;icon:ReactNode};
/** One flat list. Text is the default; what a Text block means is its label, not a separate kind. */
const blockChoices: BlockChoice[] = [
  {id:'text',kind:'topic',label:'Text',description:'Write it, or let an agent fill it',icon:<TextIcon size={18}/>},
  {id:'code',kind:'topic',blockType:'code',label:'Code',description:'Write and run an isolated program',icon:<Braces size={18}/>},
  {id:'notebook',kind:'topic',blockType:'notebook',label:'Notebook',description:'Run Python cell by cell, or open a .ipynb',icon:<NotebookPen size={18}/>},
  {id:'dataset',kind:'topic',blockType:'dataset',label:'Data',description:'Import and inspect a CSV',icon:<Database size={18}/>},
  {id:'file',kind:'topic',blockType:'file',label:'File',description:'Show a PDF, PNG or JPEG',icon:<FileIcon size={18}/>},
  {id:'notion',kind:'topic',blockType:'notion',label:'Notion',description:'Show a page or database live from Notion',icon:<BrandLogo id="notion" size={18}/>},
  {id:'group',kind:'group',label:'Group',description:'A frame for blocks that belong together',icon:<Group size={18}/>},
];

function NewNodeModal({scope,onClose,onCreate}: {scope?:string;onClose:()=>void;onCreate:(kind:NodeKind,title:string,blockType?:NewBlockType,notebookFile?:File,notion?:NotionView,label?:string)=>Promise<void>}) {
  const [choiceId,setChoiceId]=useState<BlockChoice['id']>('text');
  const [label,setLabel]=useState('');
  const [notionUrl,setNotionUrl]=useState(''),[notionFilter,setNotionFilter]=useState('');
  const [notebookFile,setNotebookFile]=useState<File|null>(null);
  const [title,setTitle]=useState('');
  const [busy,setBusy]=useState(false);
  const choice=blockChoices.find(value=>value.id===choiceId)!;
  const text=choice.id==='text';
  return <Modal title={scope?`Add inside ${scope}`:'Add to project canvas'} onClose={onClose}>
    <form onSubmit={async event=>{
      event.preventDefault();
      if(busy)return;
      setBusy(true);
      // A report keeps its own editor, so that label becomes the report block type underneath.
      try{await onCreate(choice.kind,title.trim(),text?(label==='report'?'report':undefined):choice.blockType,choice.blockType==='notebook'||choice.blockType==='file'?notebookFile??undefined:undefined,choice.blockType==='notion'?{url:notionUrl.trim(),...(notionFilter.trim()?{filter:notionFilter.trim()}:{})}:undefined,text&&label?label:undefined);}finally{setBusy(false);}
    }}>
      <div className="kind-choices" role="group" aria-label="Block kind">
        {blockChoices.map(({id,label:name,description,icon})=><button key={id} type="button" className={choiceId===id?'selected':''} aria-pressed={choiceId===id} disabled={busy} onClick={()=>setChoiceId(id)}>
          <strong>{icon}{name}</strong><span>{description}</span>
        </button>)}
      </div>
      {text&&<><label className="field-label" htmlFor="new-node-label">Label <span>(optional)</span></label><select id="new-node-label" value={label} onChange={event=>setLabel(event.target.value)} disabled={busy}><option value="">None</option>{TEXT_LABELS.map(word=><option key={word} value={word}>{word}</option>)}</select></>}
      <label className="field-label" htmlFor="new-node-title">Name <span>(optional)</span></label>
      <input id="new-node-title" value={title} onChange={event=>setTitle(event.target.value)} maxLength={200} placeholder={(choice.blockType==='notebook'||choice.blockType==='file')&&notebookFile?notebookFile.name.replace(/\.[^.]+$/u,''):text&&label?label[0].toUpperCase()+label.slice(1):choice.label} disabled={busy}/>
      {choice.blockType==='notebook'&&<><label className="field-label" htmlFor="new-notebook-file">Start from a Jupyter notebook <span>(optional .ipynb)</span></label><input id="new-notebook-file" type="file" accept=".ipynb,application/x-ipynb+json" disabled={busy} onChange={event=>setNotebookFile(event.target.files?.[0]??null)}/></>}
      {choice.blockType==='file'&&<><label className="field-label" htmlFor="new-file">File</label><input id="new-file" type="file" required accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" disabled={busy} onChange={event=>setNotebookFile(event.target.files?.[0]??null)}/></>}
      {choice.blockType==='notion'&&<><label className="field-label" htmlFor="new-notion-url">Notion page or database link</label><input id="new-notion-url" type="url" required value={notionUrl} onChange={event=>setNotionUrl(event.target.value)} maxLength={500} placeholder="https://www.notion.so/…" disabled={busy}/><label className="field-label" htmlFor="new-notion-filter">For a database, only rows where <span>(optional)</span></label><input id="new-notion-filter" value={notionFilter} onChange={event=>setNotionFilter(event.target.value)} maxLength={1000} placeholder={'"Teams" LIKE \'%Research%\''} disabled={busy}/></>}
      <p className="subtle node-kind-note">{choice.blockType==='file'?'The file is saved into files/ in the project folder and shown from there. A PDF\'s text is read so agents can use it.':choice.blockType==='notion'?'The page or rows stay in Notion: the block reads them live through your Notion connection.':choice.blockType==='code'?'Adds it to the canvas and opens the editor so you can start writing.':choice.blockType==='notebook'?notebookFile?'Opens a copy of this notebook in ros.ai. Nothing runs until you run a cell.':'Adds it to the canvas and opens an empty notebook, ready for Python.':text&&label==='report'?'Adds a report you write from exact saved evidence.':'Add it to the canvas now. Open the block when you’re ready to work on it.'}</p>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={busy}>{busy?choice.blockType==='notion'?'Reading Notion…':choice.blockType==='file'?'Saving…':'Adding…':choice.blockType==='code'?'Add & write code':choice.blockType==='notebook'?'Add & open notebook':text&&label?`Add ${label}`:`Add ${choice.label}`}</button></div>
    </form>
  </Modal>;
}
