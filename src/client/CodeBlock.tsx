import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, Play, ShieldCheck, Square } from 'lucide-react';
import type { Artifact, CanvasNode, CodeDocument, ProjectDetail, Run } from '../shared/types';
import type { ExperimentCapabilities, ExperimentPreview } from '../shared/experiments';
import type { ResearchPolicy } from '../shared/research';
import { api, post } from './api';
import { ArtifactContent } from './Experiment';
import { ResultActions } from './ResultActions';
import { readSaved, saveLocal } from './persistence';
import { date } from './Content';
import { modeLabel } from './ResearchControls';
import { parseCsv } from '../shared/data-view';
import { CodeEditor, CodeView, modKey, type CodeEditorApi, type ErrorMark } from './code';
import { outputHelpers, paramsRead, starters, type CodeContext } from './code/context';
import { logFailure, tracebackLines } from './code/traceback';
import { openOnPress } from './press';
import './code-block.css';

export const blankCode:CodeDocument={language:'python',source:'',parameters:{},inputArtifactId:null};
export function CodeBlock({initialRunId,node,detail,policy,onRefresh,onUpdate,onOpenArtifact,onReport,onInterpret,onClose}:{initialRunId?:string;onClose:()=>void;node:CanvasNode;detail:ProjectDetail;policy:ResearchPolicy|null;onRefresh:()=>Promise<unknown>;onUpdate:(patch:Partial<CanvasNode>)=>Promise<boolean>;onOpenArtifact:(artifact:Artifact)=>void;onReport:(artifact:Artifact)=>void;onInterpret:(artifact:Artifact,destinationId:string)=>void}) {
  const saved=node.code??{...blankCode,source:detail.artifacts.find(value=>value.id===node.artifactId&&value.kind==='code')?.content??''};
  const savedKey=JSON.stringify(saved),draftKey=`code-editor-draft:${node.id}`;
  const [restored]=useState(()=>readSaved<{base:string;source:string;language:string;params:string;input:string}|null>(draftKey,null));
  const validDraft=restored?.base===savedKey?restored:null;
  const [source,setSource]=useState(validDraft?.source??saved.source),[language,setLanguage]=useState(validDraft?.language??saved.language),[params,setParams]=useState(validDraft?.params??JSON.stringify(saved.parameters,null,2)),[input,setInput]=useState(validDraft?.input??saved.inputArtifactId??'');
  const [capabilities,setCapabilities]=useState<ExperimentCapabilities|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState(initialRunId??''),[preview,setPreview]=useState<ExperimentPreview|null>(null);
  const previous=useRef(saved),ownSave=useRef<string|null>(null),[changedElsewhere,setChangedElsewhere]=useState(false);
  // A changed saved record replaces only fields the user has not edited since, so typing during a save round-trip is kept.
  useEffect(()=>{const prior=previous.current;if(prior.source!==saved.source&&saved.source!==ownSave.current&&source!==prior.source&&source!==saved.source)setChangedElsewhere(true);if(prior.source!==saved.source)setSource(current=>current===prior.source?saved.source:current);if(prior.language!==saved.language)setLanguage(current=>current===prior.language?saved.language:current);if(JSON.stringify(prior.parameters)!==JSON.stringify(saved.parameters))setParams(current=>JSON.stringify(draftSafe(current))===JSON.stringify(prior.parameters)?JSON.stringify(saved.parameters,null,2):current);if(prior.inputArtifactId!==saved.inputArtifactId)setInput(current=>current===(prior.inputArtifactId??'')?saved.inputArtifactId??'':current);previous.current=saved;},[savedKey]);
  useEffect(()=>{if(source===saved.source)setChangedElsewhere(false);},[source,saved.source]);
  // Browser drafts are written shortly after typing stops, and flushed when the editor closes.
  const pendingDraft=useRef<{key:string;value:unknown}|null>(null);
  const flushDraft=()=>{const value=pendingDraft.current;pendingDraft.current=null;if(value)saveLocal(value.key,value.value);};
  useEffect(()=>{if(pendingDraft.current&&pendingDraft.current.key!==draftKey)flushDraft();pendingDraft.current={key:draftKey,value:{base:savedKey,source,language,params,input}};const timer=setTimeout(flushDraft,250);return()=>clearTimeout(timer);},[draftKey,savedKey,source,language,params,input]);
  useEffect(()=>{const hidden=()=>{if(document.visibilityState==='hidden')flushDraft();};window.addEventListener('pagehide',flushDraft);document.addEventListener('visibilitychange',hidden);return()=>{window.removeEventListener('pagehide',flushDraft);document.removeEventListener('visibilitychange',hidden);flushDraft();};},[]);
  useEffect(()=>{void api<ExperimentCapabilities>('/api/experiments/capabilities').then(setCapabilities).catch(cause=>setError(String(cause)));},[]);
  // A demo can bring saved results from an earlier run of the same code; they are listed as such.
  const runs=detail.runs.filter(value=>value.nodeId===node.id&&(value.configuration.kind==='local-experiment'||value.configuration.kind==='tutorial-saved-import'));
  const run=runs.find(value=>value.id===selected)??runs[0];
  useEffect(()=>{if(run&&run.configuration.kind==='local-experiment')void api<ExperimentPreview>(`/api/experiments/${run.id}`).then(setPreview).catch(cause=>setError(String(cause)));else setPreview(null);},[run?.id,run?.status,run?.configuration.approval]);
  const active=runs.find(value=>['queued','running'].includes(value.status));
  const results=run?detail.artifacts.filter(value=>value.runId===run.id&&value.kind!=='code'&&value.metadata?.executionRole!=='input'&&!(value.kind==='dataset'&&value.metadata?.origin&&['selected-artifact-version','user-supplied','built-in-sample'].includes(String(value.metadata.origin)))):[];
  const datasets=detail.artifacts.filter(value=>['dataset','table'].includes(value.kind)&&value.mediaType==='text/csv');
  const draft=():CodeDocument=>{const parsed:unknown=JSON.parse(params);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error('Parameters must be a JSON object.');return {language:language.trim(),source,parameters:parsed as CodeDocument['parameters'],inputArtifactId:input||null};};
  // The editor differs from the saved code; the record's key order and a missing input do not count as a change.
  const codeKey=(code:CodeDocument)=>JSON.stringify({language:code.language,source:code.source,parameters:code.parameters,inputArtifactId:code.inputArtifactId??null});
  const changed=(()=>{try{return codeKey(draft())!==codeKey(saved);}catch{return true;}})();
  // A block that never saved a code record saves one on its first run.
  const dirty=changed||!node.code;
  const work=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();await onRefresh();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}};
  const save=async()=>{const code=draft();ownSave.current=code.source;if(!await onUpdate({code}))throw new Error('Code was not saved. Review the workspace before running.');setChangedElsewhere(false);return code;};
  const prepare=()=>work(async()=>{const code=dirty?await save():draft();if(active)throw new Error('Stop or decide the existing attempt before preparing another.');const next=await post<ExperimentPreview>(`/api/projects/${detail.project.id}/experiments/preview`,{nodeId:node.id,request:'Run Code block',manualCode:true,backend:'docker-python',code:code.source,parameters:code.parameters,...(code.inputArtifactId?{datasetArtifactId:code.inputArtifactId}:{})});setSelected(next.run.id);setPreview(next);});
  const decide=(decision:'allow'|'cancel')=>work(async()=>{if(!preview)return;await post(`/api/experiments/${preview.run.id}/decision`,{fingerprint:preview.approval.fingerprint,decision});});
  const pending=preview?.run.id===run?.id&&preview?.approval.status==='pending';
  const matches=Boolean(preview&&source===preview.code&&JSON.stringify(draftSafe(params))===JSON.stringify(preview.parameters)&&input===(preview.run.configuration.sourceDatasetArtifactId??'')&&language.toLowerCase()==='python');
  const python=language.trim().toLowerCase()==='python';
  const runnable=python&&Boolean(capabilities?.sandbox?.available);
  const editor=useRef<CodeEditorApi|null>(null);
  const selectedCsv=datasets.find(value=>value.id===input);
  const context=useMemo<CodeContext>(()=>({runtime:'docker',columns:selectedCsv?parseCsv(selectedCsv.content.slice(0,65536))[0]?.filter(Boolean)??[]:null,paramKeys:Object.keys(draftSafe(params)??{})}),[selectedCsv?.id,params]);
  // Mark the failing line of the selected attempt while the editor still holds that attempt's code.
  const failureLog=run?.status==='failed'?results.find(value=>value.kind==='log'):undefined;
  const failure=failureLog?logFailure(failureLog.content):null;
  const failureLines=failure?tracebackLines(failure.stderr):[];
  const marksApply=Boolean(failure&&preview?.run.id===run?.id&&preview?.code===source);
  const errors=useMemo<ErrorMark[]>(()=>marksApply?failureLines.map((value,index)=>({...value,primary:index===failureLines.length-1,message:index===failureLines.length-1?failure!.error:'Called from here'})):[],[marksApply,failureLog?.id]);
  const canRun=!busy&&!active&&Boolean(source.trim())&&runnable;
  const runShortcut=()=>{if(canRun)void prepare();};
  const saveShortcut=()=>{if(!busy&&changed)void work(save);};
  const status=run?(pending?'Awaiting approval':run.status==='cancelled'?'Stopped':run.status):'';
  return <div className="code-block" aria-label="Code block editor"><div className="code-authoring">
    <div className="code-toolbar">
      <button className="primary" disabled={!canRun} onClick={()=>void prepare()} title={`Run (${modKey}Enter)`}>{busy?<LoaderCircle size={14} className="spin"/>:<Play size={14}/>} {changed?'Save & run':'Run'}</button>
      <button className="secondary" disabled={busy||!changed} onClick={()=>void work(save)} title={`Save (${modKey}S)`}><Check size={14}/> Save</button>
      {active&&<button className="secondary" disabled={busy} onClick={()=>void work(()=>post(`/api/experiments/${active.id}/cancel`))}><Square size={14}/> Stop</button>}
      {changed&&<span className="subtle code-save-state">Unsaved changes</span>}</div>
    {python&&capabilities?.sandbox&&!capabilities.sandbox.available&&<p className="runtime-blocker" role="status">{capabilities.sandbox.limitations[0]}</p>}
    {!python&&<p className="runtime-blocker" role="status">Only Python runs. Other languages are saved as source.</p>}
    {!source.trim()&&python&&<div className="code-starters" role="group" aria-label="Start from an example"><span>Start from</span>{starters(context).map(value=><button key={value.label} type="button" className="chip" onClick={()=>{setSource(value.code);editor.current?.focus();}}>{value.label}</button>)}</div>}
    {changedElsewhere&&<div className="code-changed-elsewhere" role="status"><span>This code was changed elsewhere, for example in another app, while you had unsaved edits.</span><button type="button" className="small secondary" onClick={()=>{setSource(saved.source);setChangedElsewhere(false);}}>Use the new version</button><button type="button" className="small text-button" onClick={()=>setChangedElsewhere(false)}>Keep mine</button></div>}
    <CodeEditor apiRef={editor} ariaLabel="Code source" value={source} onChange={setSource} language={language} context={context} errors={errors} autoFocus maxLength={100000} onRun={runShortcut} onSave={saveShortcut} onEscape={onClose} placeholder={`# Write Python here. Ctrl+Space shows suggestions.\nmetric("Answer", 6 * 7)`}/>
    <div className="code-under-editor">{python&&<div className="code-helpers" role="group" aria-label="Insert a helper"><span>Save as output</span>{outputHelpers.map(helper=><span key={helper.name} className="helper-chip"><button type="button" className="chip mono" aria-describedby={`helper-${helper.name}`} onClick={()=>editor.current?.insert(helper.insert)}>{helper.name}</button><span role="tooltip" id={`helper-${helper.name}`} className="helper-tip"><code>{helper.insert}</code><span>{helper.what}</span><span><strong>Shows as:</strong> {helper.shows}</span><span className="helper-example"><strong>Example</strong><code>{helper.example}</code></span><small>Click to insert at the cursor.</small></span></span>)}</div>}<span className="code-keys"><kbd>{modKey}Enter</kbd> run <kbd>{modKey}S</kbd> save <kbd>Esc</kbd> close</span></div>
    {marksApply&&failureLines.length>0&&<p className="code-error-hint" role="status">Line {failureLines.at(-1)!.line} raised {failure!.error.split(':')[0]}. It is underlined in the editor.</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {pending&&<section className="code-approval" aria-label="Exact Code execution approval"><strong><ShieldCheck size={15}/> Review captured attempt</strong><p>One local isolated run · {preview!.inputMode==='single-csv'?'exact captured CSV':'no dataset'} · up to 30 seconds. To skip this step, set Permissions to Full access.</p><code>Approval {preview!.approval.fingerprint.slice(0,12)}</code><details><summary>Captured code, input and parameters</summary><CodeView code={preview!.code}/><pre>{preview!.csv||'No dataset'}</pre><pre>{JSON.stringify(preview!.parameters,null,2)}</pre></details>{(!matches||changed)&&<p className="inline-error">The editor differs from this saved attempt. Cancel it before running revised code.</p>}<div className="row gap"><button className="primary" disabled={busy||!matches||changed} onClick={()=>void decide('allow')}><Play size={14}/> Allow & run</button><button className="secondary" disabled={busy} onClick={()=>void decide('cancel')}>Cancel attempt</button></div></section>}
    <section className="code-section" aria-label="Inputs"><h4>Inputs</h4><div className="code-inputs">
      <label className="code-field"><span>Data</span><select aria-label="Code input CSV" value={input} onChange={event=>setInput(event.target.value)}><option value="">None</option>{datasets.map(value=><option key={value.id} value={value.id}>{value.title} · {value.hash.slice(0,8)}</option>)}</select><small>{input?`The code reads it as df, a pandas table${context.columns?.length?` with ${context.columns.length} columns`:''}.`:'Pick a CSV to read in the code as df. Leave None if the code makes its own data.'}</small></label>
      <div className="code-field"><span>Parameters</span><CodeEditor compact ariaLabel="Code parameters" value={params} onChange={setParams} language="json" onRun={runShortcut} onSave={saveShortcut} onEscape={onClose}/><ParamsGuide source={source} params={params} onChange={setParams}/></div>
      <label className="code-field"><span>Language</span><input aria-label="Code language" value={language} maxLength={50} list="code-languages" onChange={event=>setLanguage(event.target.value)}/><datalist id="code-languages"><option value="python"/><option value="c"/><option value="haskell"/></datalist></label>
    </div></section>
    <details className="code-runtime-details"><summary>Runtime and permissions</summary><p>{modeLabel(policy?.overrides[node.id]??policy?.mode??'ask')} · {policy?.used.experiments??0} code runs in this project so far.</p>{capabilities?.sandbox?.enforcement.map(value=><p key={value}>{value}</p>)}{capabilities?.sandbox?.limitations.map(value=><p key={value}>{value}</p>)}</details>
  </div><div className="code-results"><div className="code-results-head"><h4>Results</h4>{run&&<AttemptPicker runs={runs} selected={run} onSelect={setSelected}/>}</div>{run?<>{(active||pending||!['completed'].includes(run.status))&&<p className={`run-status-line code-run-status ${run.status}`}><strong>{status}</strong> {active&&<span>{run.events.at(-1)?.message}</span>}</p>}{run.error&&<p className="inline-error">{run.error}</p>}{run.configuration.kind==='tutorial-saved-import'&&<p className="subtle">Saved results that came with the demo, from an earlier run of this code. Run it to calculate them again.</p>}{results.length?[...results].sort((a,b)=>Number(a.kind==='log')-Number(b.kind==='log')).map(value=><section className="code-output" key={value.id}>{value.kind==='log'?<><div className="code-output-head"><strong>Console</strong></div><CodeConsole artifact={value}/></>:<><div className="code-output-head"><strong>{value.title}</strong><small>{value.kind}</small></div><ArtifactContent artifact={value}/></>}<ResultActions artifact={value} detail={detail} onChanged={onRefresh} onOpen={onOpenArtifact} onReport={onReport} onInterpret={onInterpret}/></section>):!active&&<p className="subtle">This attempt saved no outputs.</p>}<details className="code-attempt-trace"><summary>Full attempt record</summary><pre>{JSON.stringify(run,null,2)}</pre><p>Observable execution records; no guarantee of deterministic replay.</p></details></>:<div className="code-output-empty"><p>Run the code to see results here.</p></div>}</div></div>;
}

/** The attempt menu: newest first, each with its time and outcome. */
function AttemptPicker({runs,selected,onSelect}:{runs:Run[];selected:Run;onSelect:(id:string)=>void}){
  const [open,setOpen]=useState(false),box=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const away=(event:PointerEvent)=>{if(!box.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',away);return()=>document.removeEventListener('pointerdown',away);},[open]);
  const label=(run:Run)=>run.status==='cancelled'?'Stopped':run.status[0].toUpperCase()+run.status.slice(1);
  if(runs.length<2)return <small className="attempt-time">{date(selected.createdAt)}</small>;
  return <div className="attempt-picker" ref={box} onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);}}}>
    <button type="button" className="attempt-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label="Code attempt" {...openOnPress(()=>setOpen(value=>!value))}><span className={`attempt-dot ${selected.status}`}/>{date(selected.createdAt)}<ChevronDown size={14}/></button>
    {open&&<div className="attempt-menu" role="listbox" aria-label="Attempts">{runs.map((run,index)=><button key={run.id} type="button" role="option" aria-selected={run.id===selected.id} className={run.id===selected.id?'selected':''} onClick={()=>{onSelect(run.id);setOpen(false);}}><span className={`attempt-dot ${run.status}`}/><span className="attempt-when">{date(run.createdAt)}</span><span className="attempt-outcome">{index===0?'Latest · ':''}{label(run)}</span>{run.id===selected.id&&<Check size={14}/>}</button>)}</div>}
  </div>;
}
/** Explains parameters and lines up the keys the code reads with the keys set here. */
function ParamsGuide({source,params,onChange}:{source:string;params:string;onChange:(value:string)=>void}){
  const parsed=draftSafe(params),valid=parsed&&typeof parsed==='object'&&!Array.isArray(parsed);
  const read=paramsRead(source),set=valid?Object.keys(parsed):[];
  const missing=read.filter(item=>!set.includes(item.key)),unused=set.filter(key=>!read.some(item=>item.key===key));
  const add=()=>onChange(JSON.stringify({...(valid?parsed:{}),...Object.fromEntries(missing.map(item=>[item.key,item.fallback??null]))},null,2));
  return <div className="params-guide">
    {!valid?<small className="params-warning">This is not a JSON object yet, for example {'{"n": 10}'}.</small>
    :read.length===0&&set.length===0?<small>Settings you change between runs without touching the code, such as a sample size or a column name. Write {'{"n": 10}'} here and read it in code as <code>params["n"]</code>.</small>
    :<small>{read.length>0&&<>The code reads {read.map((item,index)=><span key={item.key}>{index?', ':''}<code className={set.includes(item.key)?'':'params-missing'}>{item.key}</code></span>)}. </>}{missing.length>0&&<><button type="button" className="text-button small" onClick={add}>Add {missing.length===1?'it':'them'} here</button> to change {missing.length===1?'it':'them'} without editing code. </>}{unused.length>0&&<>Not used by the code: {unused.map((key,index)=><span key={key}>{index?', ':''}<code>{key}</code></span>)}.</>}{read.length>0&&!missing.length&&!unused.length&&'Change a value and run again to compare attempts.'}</small>}
  </div>;
}
function draftSafe(value:string){try{return JSON.parse(value);}catch{return null;}}

function CodeConsole({artifact}:{artifact:Artifact}){
  let out=artifact.content,err='';
  try{const data=JSON.parse(artifact.content);out=data.stdout??'';err=[data.stderr,data.error].filter(Boolean).join('\n');}catch{}
  return <pre className="code-console">{out||(!err&&<span className="subtle">No printed output.</span>)}{err&&<span className="code-console-error">{err}</span>}</pre>;
}
