import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, FileUp, History, LoaderCircle, NotebookText, RefreshCw, Save, X } from 'lucide-react';
import type { Artifact, CanvasNode, ProjectDetail } from '../shared/types';
import { NOTEBOOK_LIMITS, type NotebookCellPreview, type NotebookOpen, type NotebookOutputPreview, type NotebookSnapshot, type NotebookState } from '../shared/notebooks';
import { artifactTable } from '../shared/data-view';
import { api, post } from './api';
import { DataViewer } from './DataViewer';
import { ResultActions } from './ResultActions';
import { CodeView } from './code';
import './notebook-block.css';

type NotebookBlockProps = {
  node:CanvasNode;
  detail:ProjectDetail;
  onRefresh:()=>Promise<unknown>;
  onUpdate:(patch:Partial<CanvasNode>)=>Promise<unknown>;
  onOpenArtifact:(artifact:Artifact)=>void;
  onReport?:(artifact:Artifact)=>void;
  onInterpret?:(artifact:Artifact,destinationId:string)=>void;
  onClose?:()=>void;
};
const errorText = (cause:unknown) => cause instanceof Error ? cause.message : String(cause);
const stamp = (value:string) => new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const sourceLabel = (snapshot:NotebookSnapshot) => snapshot.origin === 'jupyter' ? 'Saved in Jupyter' : snapshot.origin === 'project-file' ? 'Saved in the project folder' : 'Uploaded .ipynb';

function OutputPreview({output,viewKey}:{output:NotebookOutputPreview;viewKey:string}) {
  const table=useMemo(()=>{
    if(output.kind!=='csv'||!output.content||output.truncated)return null;
    try{return artifactTable(output.content,true);}catch{return null;}
  },[output.kind,output.content,output.truncated]);
  const image=output.kind==='figure'&&output.content
    ? output.mediaType==='image/png'&&/^[A-Za-z0-9+/]+={0,2}$/u.test(output.content)
      ? `data:image/png;base64,${output.content}`
      : output.mediaType==='image/svg+xml' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(output.content)}` : null
    : null;
  return <div className="notebook-output-preview">
    {image ? <img src={image} alt={output.title}/> : table ? <DataViewer data={table} compact viewKey={viewKey} name={output.title}/> : output.content ? <pre tabIndex={0}>{output.content}</pre> : <p className="notebook-muted">No renderable preview.</p>}
    {output.reason&&<p className="notebook-muted">{output.reason}</p>}
    {output.truncated&&<small>Bounded preview. Capture retains the supported saved output within the output limit.</small>}
  </div>;
}

/** Reads saved notebook versions and captures selected output; never sends kernel execution. */
export function NotebookBlock({node,detail,onRefresh,onUpdate,onOpenArtifact,onReport,onInterpret,onClose}:NotebookBlockProps) {
  const base=`/api/projects/${encodeURIComponent(detail.project.id)}/nodes/${encodeURIComponent(node.id)}/notebook`;
  const [state,setState]=useState<NotebookState|null>(null),[snapshot,setSnapshot]=useState<NotebookSnapshot|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [endpoint,setEndpoint]=useState('http://127.0.0.1:8888/'),[token,setToken]=useState(''),[path,setPath]=useState(node.notebook?.path??'');
  const [interfaceName,setInterfaceName]=useState<'lab'|'notebook'>('lab'),[connectionEditing,setConnectionEditing]=useState(false);
  const [openInfo,setOpenInfo]=useState<NotebookOpen|null>(null),[openError,setOpenError]=useState('');
  const [cellIndex,setCellIndex]=useState(0),[selections,setSelections]=useState<Map<number,number[]>>(new Map());
  const [upload,setUpload]=useState<{name:string;content:string;bytes:number}|null>(null),[reading,setReading]=useState(false);
  const [title,setTitle]=useState(node.title);
  const context=useRef(base),mounted=useRef(false),readSequence=useRef(0),snapshotSequence=useRef(0),fileSequence=useRef(0);
  context.current=base;
  const current=(requestedBase:string)=>mounted.current&&context.current===requestedBase;
  const limits=state?.limits??NOTEBOOK_LIMITS;

  const acceptState=useCallback((value:NotebookState,latest=false)=>{
    setState(value);
    setSnapshot(previous=>latest||!previous||previous.id===value.snapshot?.id?value.snapshot:previous);
  },[]);
  const load=useCallback(async(latest=false)=>{
    const sequence=++readSequence.current,value=await api<NotebookState>(base);
    if(current(base)&&sequence===readSequence.current)acceptState(value,latest);
    return value;
  },[base,acceptState]);
  useEffect(()=>{
    mounted.current=true;setLoading(true);setState(null);setSnapshot(null);setError('');setNotice('');setBusy('');
    setToken('');setEndpoint('http://127.0.0.1:8888/');setPath(node.notebook?.path??'');setInterfaceName('lab');setConnectionEditing(false);
    setOpenInfo(null);setOpenError('');setUpload(null);setReading(false);setTitle(node.title);
    void load(true).then(value=>{
      if(!current(base))return;
      if(value.session){setEndpoint(value.session.endpoint);setInterfaceName(value.session.interface);}
      if(value.snapshot&&!node.notebook?.path)setPath(value.snapshot.path);
    }).catch(cause=>{if(current(base))setError(errorText(cause));}).finally(()=>{if(current(base))setLoading(false);});
    return()=>{mounted.current=false;++readSequence.current;++snapshotSequence.current;++fileSequence.current;};
  // A project/node change resets private form state; parent refreshes do not reset the inspected version.
  },[base,load]);
  useEffect(()=>{setTitle(node.title);},[node.title]);
  useEffect(()=>{
    setSelections(new Map());setCellIndex(snapshot?.cells.find(cell=>cell.outputs.length)?.index??snapshot?.cells[0]?.index??0);
  },[snapshot?.id]);
  useEffect(()=>{
    let cancelled=false;setOpenInfo(null);setOpenError('');
    if(state?.session)void api<NotebookOpen>(`${base}/open`).then(value=>{if(!cancelled&&current(base))setOpenInfo(value);}).catch(cause=>{if(!cancelled&&current(base))setOpenError(errorText(cause));});
    return()=>{cancelled=true;};
  },[base,state?.session?.id,state?.session?.interface,node.notebook?.path]);

  const act=async(label:string,operation:()=>Promise<void>)=>{
    if(busy)return;setBusy(label);setError('');setNotice('');
    try{await operation();}catch(cause){if(current(base))setError(errorText(cause));}
    finally{if(current(base))setBusy('');}
  };
  const connect=async(event:FormEvent)=>{
    event.preventDefault();
    await act('connect',async()=>{
      const value=await post<NotebookState>(`${base}/connect`,{endpoint:endpoint.trim(),path:path.trim(),interface:interfaceName,...(token?{token}:{})});
      if(!current(base))return;acceptState(value,true);setToken('');setConnectionEditing(false);
      setNotice(value.session?.available?'Local notebook session is available. Open it to edit and run cells.':value.session?.reason??value.reason);
      await onRefresh();
    });
  };
  const readSaved=()=>act('snapshot',async()=>{
    const value=await post<NotebookState>(`${base}/snapshot`,{});
    if(!current(base))return;acceptState(value,true);setNotice('Saved notebook version captured. Earlier versions and outputs remain unchanged.');await onRefresh();
  });
  const chooseSnapshot=async(id:string)=>{
    const sequence=++snapshotSequence.current;setError('');setBusy('preview');
    try{const value=await api<NotebookSnapshot>(`${base}/snapshots/${encodeURIComponent(id)}`);if(current(base)&&sequence===snapshotSequence.current)setSnapshot(value);}
    catch(cause){if(current(base)&&sequence===snapshotSequence.current)setError(errorText(cause));}
    finally{if(current(base)&&sequence===snapshotSequence.current)setBusy('');}
  };
  const chooseFile=async(file:File|undefined)=>{
    const sequence=++fileSequence.current;setUpload(null);setError('');if(!file)return;
    if(!/\.ipynb$/iu.test(file.name)||!file.size||file.size>limits.snapshotBytes){setError(`Choose a non-empty .ipynb file no larger than ${(limits.snapshotBytes/1000).toLocaleString()} KB.`);return;}
    setReading(true);
    try{
      const content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      if(current(base)&&sequence===fileSequence.current)setUpload({name:file.name,content,bytes:file.size});
    }catch{if(current(base)&&sequence===fileSequence.current)setError('Could not read this notebook as UTF-8 text.');}
    finally{if(current(base)&&sequence===fileSequence.current)setReading(false);}
  };
  const importSaved=()=>act('import',async()=>{
    if(!upload)return;const value=await post<NotebookState>(`${base}/import`,{name:upload.name,content:upload.content});
    if(!current(base))return;acceptState(value,true);setUpload(null);setNotice('Uploaded notebook snapshot saved. Its cells were not executed.');await onRefresh();
  });
  const toggleOutput=(cell:NotebookCellPreview,index:number,checked:boolean)=>{
    setSelections(previous=>{const next=new Map(previous),values=next.get(cell.index)??[];
      if(checked&&values.length<limits.selectedOutputs)next.set(cell.index,[...values,index]);else if(!checked)next.set(cell.index,values.filter(value=>value!==index));return next;});
  };
  const captureCell=(cell:NotebookCellPreview)=>act('capture',async()=>{
    const outputIndices=selections.get(cell.index)??[];if(!snapshot||!outputIndices.length)return;
    await post(`${base}/capture`,{snapshotId:snapshot.id,cellIndex:cell.index,outputIndices});
    if(!current(base))return;
    setSelections(previous=>{const next=new Map(previous);next.delete(cell.index);return next;});
    setNotice(`${outputIndices.length} output${outputIndices.length===1?'':'s'} from cell ${cell.index+1} saved with this notebook and cell version.`);
    await load();if(current(base))await onRefresh();
  });
  const saveTitle=()=>{
    const value=title.trim();if(!value){setTitle(node.title);return;}if(value===node.title)return;
    void act('title',async()=>{await onUpdate({title:value});});
  };
  const cell=snapshot?.cells.find(value=>value.index===cellIndex)??snapshot?.cells[0],selected=cell?(selections.get(cell.index)??[]):[];
  const captures=state?.captures??[],latestSource=state?.snapshot?.hash;
  const session=state?.session;
  return <section className="notebook-block" aria-label={`Notebook block ${node.title}`}>
    <header className="notebook-heading"><NotebookText size={22}/><div><label className="sr-only" htmlFor={`notebook-title-${node.id}`}>Notebook block title</label><input id={`notebook-title-${node.id}`} value={title} maxLength={200} onChange={event=>setTitle(event.target.value)} onBlur={saveTitle} disabled={!!busy} /><p>Open a local notebook. Capture the outputs you choose.</p></div>{onClose&&<button className="icon-button" aria-label="Close notebook block" onClick={onClose}><X size={18}/></button>}</header>
    {loading?<p className="notebook-status" role="status"><LoaderCircle size={15} className="spin"/> Loading saved notebook…</p>:<>
      {session&&<div className="notebook-session"><div><strong>{session.name}</strong><span className="notebook-availability">{session.available===true?'Available':session.available===false?'Unavailable':'Not checked'}</span><small>{session.endpoint} · {node.notebook?.path||snapshot?.path||path}</small><small>User-managed Jupyter · execution outside ros.ai</small></div><div className="notebook-session-actions">{openInfo&&<a className="secondary" href={openInfo.url} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14}/> Open notebook</a>}<button className="secondary" disabled={!!busy} onClick={()=>void act('check',async()=>{const value=await post<NotebookState>(`${base}/check`,{});if(current(base)){acceptState(value);setNotice(value.session?.reason??value.reason);}})}><RefreshCw size={14}/> Check</button><button className="text-button" aria-expanded={connectionEditing} disabled={!!busy} onClick={()=>{setConnectionEditing(!connectionEditing);setToken('');}}>Edit connection</button></div></div>}
      {session?.available===false&&<p className="notebook-error" role="status">{session.reason} Open the notebook to check its native session, or edit the connection.</p>}
      {(!session||connectionEditing)&&<form className="notebook-connect" onSubmit={event=>void connect(event)}><h3>{session?'Local connection settings':'Connect a local notebook'}</h3><p>Use an existing Jupyter server on this computer. ros.ai does not start a kernel.</p><div className="notebook-connect-grid"><label className="field-label">Jupyter address<input aria-label="Jupyter address" type="url" value={endpoint} onChange={event=>setEndpoint(event.target.value)} placeholder="http://127.0.0.1:8888/" required disabled={!!busy} maxLength={1000}/></label><label className="field-label">Notebook path<input aria-label="Notebook path" value={path} onChange={event=>setPath(event.target.value)} placeholder="research/analysis.ipynb" required disabled={!!busy} maxLength={1000}/></label><label className="field-label"><span>API token <span className="notebook-optional">optional</span></span><input aria-label="Jupyter API token" type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} disabled={!!busy} maxLength={4096} placeholder={session?.tokenConfigured?'Re-enter token when reconnecting':'Jupyter API token'}/><small>Kept on the local server. Never included in the notebook URL.{session?.tokenConfigured?' Reconnecting replaces the saved token.':''}</small></label><label className="field-label">Open with<select aria-label="Notebook interface" value={interfaceName} disabled={!!busy} onChange={event=>setInterfaceName(event.target.value as 'lab'|'notebook')}><option value="lab">JupyterLab</option><option value="notebook">Notebook</option></select></label></div><div className="notebook-connect-actions"><button className="primary" disabled={!!busy||!path.trim()||!endpoint.trim()}>{busy==='connect'?<LoaderCircle size={14} className="spin"/>:<Check size={14}/>} Connect</button>{session&&<><button type="button" className="secondary" disabled={!!busy} onClick={()=>{setConnectionEditing(false);setToken('');setEndpoint(session.endpoint);setInterfaceName(session.interface);setPath(node.notebook?.path??'');}}>Cancel</button><button type="button" className="text-button" disabled={!!busy} onClick={()=>void act('disconnect',async()=>{const value=await api<NotebookState>(`${base}/connect`,{method:'DELETE'});if(!current(base))return;acceptState(value);setToken('');setConnectionEditing(false);setNotice('Disconnected. Saved notebook versions and captured outputs remain available.');await onRefresh();})}>Disconnect</button></>}</div></form>}
      {session&&<div className="notebook-read"><button className="primary" disabled={!!busy} onClick={()=>void readSaved()}>{busy==='snapshot'?<LoaderCircle size={14} className="spin"/>:<Save size={14}/>} {state?.snapshot?'Refresh saved cells':'Read saved cells'}</button><span>Run and save in Jupyter, then refresh here. Unsaved kernel output is not read.</span></div>}
      {session&&<details className="notebook-disclosure"><summary>Connection & runtime details</summary><p>{session.reason}</p><p>{openInfo?.reason||'The native Jupyter tab uses its own browser sign-in; the server API token is separate.'}</p><p>This external runtime has its own permissions. ros.ai cannot verify its isolation, execution order or cell dependencies.</p>{session.checkedAt&&<small>Last checked {stamp(session.checkedAt)}</small>}</details>}
      {openError&&<p className="notebook-error" role="alert">Could not prepare the notebook link: {openError}</p>}
      <details className="notebook-disclosure notebook-import"><summary><FileUp size={14}/> Import a saved .ipynb snapshot</summary><p>Fallback for captured source and saved outputs. Uploading does not connect to a live session or execute cells.</p><label className="field-label">Saved notebook file<input aria-label="Saved notebook file" type="file" accept=".ipynb,application/json" disabled={!!busy||reading} onChange={event=>void chooseFile(event.target.files?.[0])}/><small>Up to {(limits.snapshotBytes/1000).toLocaleString()} KB · {limits.cells} cells · supported outputs only</small></label>{upload&&<p>{upload.name} · {upload.bytes.toLocaleString()} bytes</p>}<button className="secondary" disabled={!!busy||reading||!upload} onClick={()=>void importSaved()}>{busy==='import'||reading?<LoaderCircle size={14} className="spin"/>:<FileUp size={14}/>} Import snapshot</button></details>
      {error&&<p className="notebook-error" role="alert">{error}</p>}{notice&&<p className="notebook-notice" role="status">{notice}</p>}
      {snapshot?<div className="notebook-snapshot"><div className="notebook-snapshot-heading"><div><h3>Saved cells</h3><p>{sourceLabel(snapshot)} · {stamp(snapshot.capturedAt)} · {snapshot.cells.length} cells</p></div><label className="field-label">Source version<select aria-label="Notebook source version" value={snapshot.id} disabled={!!busy} onChange={event=>void chooseSnapshot(event.target.value)}>{!state?.snapshots.some(value=>value.id===snapshot.id)&&<option value={snapshot.id}>{stamp(snapshot.capturedAt)} · {snapshot.hash.slice(0,8)} · producing snapshot</option>}{state?.snapshots.map(value=><option key={value.id} value={value.id}>{stamp(value.capturedAt)} · {value.hash.slice(0,8)} · {value.origin==='jupyter'?'Jupyter':'Upload'}</option>)}</select><small>20 most recent snapshots; captured outputs can reopen older producing versions.</small></label></div>{latestSource&&snapshot.hash!==latestSource&&<p className="notebook-version-note">Inspecting an earlier saved source version. Newer snapshots do not replace these outputs.</p>}
        <details className="notebook-disclosure"><summary>Source version & provenance</summary><dl><dt>Notebook</dt><dd>{snapshot.path}</dd><dt>Snapshot SHA256</dt><dd><code>{snapshot.hash}</code></dd><dt>Runtime reported by notebook</dt><dd>{snapshot.kernelName||'Unknown kernel'} · {snapshot.language||'Unknown language'}</dd><dt>Capture origin</dt><dd>{sourceLabel(snapshot)} · user-managed external execution</dd></dl>{snapshot.warnings.map((warning,index)=><p key={index}>{warning}</p>)}{detail.artifacts.find(artifact=>artifact.id===snapshot.sourceArtifactId)&&<button className="text-button" onClick={()=>onOpenArtifact(detail.artifacts.find(artifact=>artifact.id===snapshot.sourceArtifactId)!)}>Inspect captured notebook source</button>}</details>
        {snapshot.cells.length?<div className="notebook-cell-workspace"><nav className="notebook-cell-list" aria-label="Saved notebook cells">{snapshot.cells.map(value=><button key={value.index} className={value.index===cell?.index?'selected':''} aria-pressed={value.index===cell?.index} onClick={()=>setCellIndex(value.index)}><span>Cell {value.index+1}<small>{value.cellType} · {value.outputs.length} output{value.outputs.length===1?'':'s'}</small></span><span className="notebook-cell-snippet">{value.source.split('\n').find(line=>line.trim())?.slice(0,120)||'Empty source'}</span>{!!selections.get(value.index)?.length&&<small>{selections.get(value.index)!.length} selected</small>}</button>)}</nav>{cell&&<div className="notebook-cell-detail"><header><h4>Cell {cell.index+1} <span>{cell.cellType}</span></h4>{cell.cellType==='code'&&<small>Saved execution count: {cell.executionCount??'unknown'}</small>}</header><CodeView className="notebook-source" code={cell.source||'(empty source)'} language={cell.cellType==='code'&&cell.source?snapshot.language||'python':'text'}/><details className="notebook-disclosure"><summary>Cell locator & source hash</summary><p>{cell.locator}</p><p>Cell ID: {cell.id??'Not available; located within this snapshot'}</p><code>{cell.sourceHash}</code><p>Saved output does not establish when this cell ran or which cells it depended on.</p></details>
          <div className="notebook-output-heading"><h4>Saved outputs</h4><span>{selected.length}/{limits.selectedOutputs} selected</span></div>{cell.outputs.length?cell.outputs.map(output=><div className="notebook-output" key={output.index}><label className="notebook-output-choice"><input type="checkbox" aria-label={`Capture cell ${cell.index+1} output ${output.index+1}: ${output.title}`} checked={selected.includes(output.index)} disabled={!!busy||!output.capturable||(!selected.includes(output.index)&&selected.length>=limits.selectedOutputs)} onChange={event=>toggleOutput(cell,output.index,event.target.checked)}/><span><strong>{output.title}</strong><small>{output.mediaType} · {output.capturable?output.kind==='unsupported'?'Inert JSON capture available':'Saved output available for capture':'Exceeds supported capture limits'}</small></span></label><OutputPreview output={output} viewKey={`${snapshot.id}:${cell.index}:${output.index}`}/></div>):<p className="notebook-muted">No saved outputs in this cell. Run and save in Jupyter to include output in the next snapshot.</p>}<div className="notebook-capture-actions"><button className="primary" disabled={!!busy||!selected.length} onClick={()=>void captureCell(cell)}>{busy==='capture'?<LoaderCircle size={14} className="spin"/>:<Save size={14}/>} Capture {selected.length||'selected'} output{selected.length===1?'':'s'}</button><small>Exact notebook and cell versions are retained. Capture does not run any block.</small></div>
        </div>}</div>:<p className="notebook-muted">This saved notebook has no cells.</p>}
      </div>:<p className="notebook-empty">{state?.reason||'Connect a local session and read its saved cells, or import a saved notebook snapshot.'}</p>}
      <section className="notebook-captures" aria-label="Captured notebook outputs"><h3><History size={16}/> Captured outputs <span>{captures.length} recent capture{captures.length===1?'':'s'}</span></h3>{captures.length?captures.map(capture=><article key={capture.runId} className="notebook-capture"><div className="notebook-capture-meta"><strong>Cell {capture.cellIndex+1} · {capture.outputIndices.length} output{capture.outputIndices.length===1?'':'s'}</strong><small>{stamp(capture.capturedAt)} · external capture</small>{latestSource&&capture.snapshotHash!==latestSource&&<small>Earlier notebook source version</small>}</div>{capture.artifactIds.map(id=>{const artifact=detail.artifacts.find(value=>value.id===id);return artifact?<div key={id} className="notebook-captured-output"><strong>{artifact.title}</strong><small>{artifact.kind} · version {artifact.hash.slice(0,12)}</small><ResultActions artifact={artifact} detail={detail} onChanged={onRefresh} onOpen={onOpenArtifact} onReport={onReport} onInterpret={onInterpret}/></div>:<p key={id} className="notebook-muted">Saved output {id.slice(0,8)} · refresh the workspace to inspect.</p>;})}<details className="notebook-disclosure"><summary>Capture provenance</summary><p>{capture.cellLocator}</p><dl><dt>Snapshot SHA256</dt><dd><code>{capture.snapshotHash}</code></dd><dt>Saved outputs</dt><dd>{capture.outputIndices.map(index=>index+1).join(', ')}</dd><dt>Capture record</dt><dd><code>{capture.runId}</code></dd></dl><p>Output is external saved evidence; ros.ai did not execute this cell.</p><button className="text-button" disabled={!!busy} onClick={()=>void chooseSnapshot(capture.snapshotId)}>Inspect producing snapshot</button></details></article>):<p className="notebook-muted">Choose useful outputs from a saved cell and capture them here. Captured versions stay available for explicit reuse.</p>}</section>
    </>}
  </section>;
}
