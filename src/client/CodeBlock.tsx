import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, History, LoaderCircle, Play, ShieldCheck, Square } from 'lucide-react';
import type { Artifact, CanvasNode, CodeDocument, ProjectDetail } from '../shared/types';
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
import { helperInserts, starters, type CodeContext } from './code/context';
import { logFailure, tracebackLines } from './code/traceback';
import './code-block.css';

export const blankCode:CodeDocument={language:'python',source:'',parameters:{},inputArtifactId:null};
export function CodeBlock({initialRunId,node,detail,policy,onRefresh,onUpdate,onOpenArtifact,onReport,onInterpret}:{initialRunId?:string;node:CanvasNode;detail:ProjectDetail;policy:ResearchPolicy|null;onRefresh:()=>Promise<unknown>;onUpdate:(patch:Partial<CanvasNode>)=>Promise<boolean>;onOpenArtifact:(artifact:Artifact)=>void;onReport:(artifact:Artifact)=>void;onInterpret:(artifact:Artifact,destinationId:string)=>void}) {
  const saved=node.code??{...blankCode,source:detail.artifacts.find(value=>value.id===node.artifactId&&value.kind==='code')?.content??''};
  const savedKey=JSON.stringify(saved),draftKey=`code-editor-draft:${node.id}`;
  const [restored]=useState(()=>readSaved<{base:string;source:string;language:string;params:string;input:string}|null>(draftKey,null));
  const validDraft=restored?.base===savedKey?restored:null;
  const [source,setSource]=useState(validDraft?.source??saved.source),[language,setLanguage]=useState(validDraft?.language??saved.language),[params,setParams]=useState(validDraft?.params??JSON.stringify(saved.parameters,null,2)),[input,setInput]=useState(validDraft?.input??saved.inputArtifactId??'');
  const [capabilities,setCapabilities]=useState<ExperimentCapabilities|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState(initialRunId??''),[preview,setPreview]=useState<ExperimentPreview|null>(null);
  const previous=useRef(saved);
  // A changed saved record replaces only fields the user has not edited since, so typing during a save round-trip is kept.
  useEffect(()=>{const prior=previous.current;if(prior.source!==saved.source)setSource(current=>current===prior.source?saved.source:current);if(prior.language!==saved.language)setLanguage(current=>current===prior.language?saved.language:current);if(JSON.stringify(prior.parameters)!==JSON.stringify(saved.parameters))setParams(current=>JSON.stringify(draftSafe(current))===JSON.stringify(prior.parameters)?JSON.stringify(saved.parameters,null,2):current);if(prior.inputArtifactId!==saved.inputArtifactId)setInput(current=>current===(prior.inputArtifactId??'')?saved.inputArtifactId??'':current);previous.current=saved;},[savedKey]);
  // Browser drafts are written shortly after typing stops, and flushed when the editor closes.
  const pendingDraft=useRef<{key:string;value:unknown}|null>(null);
  const flushDraft=()=>{const value=pendingDraft.current;pendingDraft.current=null;if(value)saveLocal(value.key,value.value);};
  useEffect(()=>{if(pendingDraft.current&&pendingDraft.current.key!==draftKey)flushDraft();pendingDraft.current={key:draftKey,value:{base:savedKey,source,language,params,input}};const timer=setTimeout(flushDraft,250);return()=>clearTimeout(timer);},[draftKey,savedKey,source,language,params,input]);
  useEffect(()=>{const hidden=()=>{if(document.visibilityState==='hidden')flushDraft();};window.addEventListener('pagehide',flushDraft);document.addEventListener('visibilitychange',hidden);return()=>{window.removeEventListener('pagehide',flushDraft);document.removeEventListener('visibilitychange',hidden);flushDraft();};},[]);
  useEffect(()=>{void api<ExperimentCapabilities>('/api/experiments/capabilities').then(setCapabilities).catch(cause=>setError(String(cause)));},[]);
  const runs=detail.runs.filter(value=>value.nodeId===node.id&&value.configuration.kind==='local-experiment');
  const run=runs.find(value=>value.id===selected)??runs[0];
  useEffect(()=>{if(run)void api<ExperimentPreview>(`/api/experiments/${run.id}`).then(setPreview).catch(cause=>setError(String(cause)));else setPreview(null);},[run?.id,run?.status,run?.configuration.approval]);
  const active=runs.find(value=>['queued','running'].includes(value.status));
  const results=run?detail.artifacts.filter(value=>value.runId===run.id&&value.kind!=='code'&&value.metadata?.executionRole!=='input'&&!(value.kind==='dataset'&&value.metadata?.origin&&['selected-artifact-version','user-supplied','built-in-sample'].includes(String(value.metadata.origin)))):[];
  const datasets=detail.artifacts.filter(value=>['dataset','table'].includes(value.kind)&&value.mediaType==='text/csv');
  const draft=():CodeDocument=>{const parsed:unknown=JSON.parse(params);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error('Parameters must be a JSON object.');return {language:language.trim(),source,parameters:parsed as CodeDocument['parameters'],inputArtifactId:input||null};};
  const dirty=(()=>{try{return !node.code||JSON.stringify(draft())!==JSON.stringify(saved);}catch{return true;}})();
  const work=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();await onRefresh();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}};
  const save=async()=>{const code=draft();if(!await onUpdate({code}))throw new Error('Code was not saved. Review the workspace before running.');return code;};
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
  const saveShortcut=()=>{if(!busy&&dirty)void work(save);};
  return <div className="code-block" aria-label="Code block editor"><div className="code-authoring">
    <div className="code-toolbar"><label className="code-language"><span>Language</span><input aria-label="Code language" value={language} maxLength={50} list="code-languages" onChange={event=>setLanguage(event.target.value)}/><datalist id="code-languages"><option value="python"/><option value="c"/><option value="haskell"/></datalist></label>
      <button className="secondary" disabled={busy||!dirty} onClick={()=>void work(save)} title={`Save (${modKey}S)`}><Check size={14}/> Save <kbd>{modKey}S</kbd></button>
      <button className="primary" disabled={!canRun} onClick={()=>void prepare()} title={`Run (${modKey}Enter)`}>{busy?<LoaderCircle size={14} className="spin"/>:<Play size={14}/>} {dirty?'Save & run':'Run'} <kbd>{modKey}↵</kbd></button>
      <button className="secondary" disabled={!active||busy} onClick={()=>void work(()=>post(`/api/experiments/${active!.id}/cancel`))}><Square size={14}/> Stop</button>
      <span className={`code-runtime-badge${runnable?' ready':''}`} title={python?'Python runs in an isolated Docker container':'Saved as source; no execution adapter for this language'}>{python?(capabilities?.sandbox?.available?'Docker Python ready':capabilities?'Docker Python unavailable':'Checking runtime…'):'Source only'}</span>
      <span className="subtle code-save-state">{dirty?'Unsaved changes':'Saved'} · undoable</span></div>
    {!source.trim()&&python&&<div className="code-starters" role="group" aria-label="Start from an example"><span>Start from</span>{starters(context).map(value=><button key={value.label} type="button" className="chip" onClick={()=>{setSource(value.code);editor.current?.focus();}}>{value.label}</button>)}</div>}
    <CodeEditor apiRef={editor} ariaLabel="Code source" value={source} onChange={setSource} language={language} context={context} errors={errors} autoFocus maxLength={100000} onRun={runShortcut} onSave={saveShortcut} placeholder={`# Write Python here. Suggestions appear as you type; Ctrl+Space shows them.\n# ${modKey}Enter runs, ${modKey}S saves.\nmetric("Answer", 6 * 7)`}/>
    {python&&<div className="code-helpers" role="group" aria-label="Insert a helper"><span>Insert</span>{helperInserts('docker').map(value=><button key={value} type="button" className="chip mono" onClick={()=>editor.current?.insert(value)}>{value.slice(0,value.indexOf('('))}</button>)}</div>}
    {marksApply&&failureLines.length>0&&<p className="code-error-hint" role="status">Line {failureLines.at(-1)!.line} raised {failure!.error.split(':')[0]}. It is underlined in the editor.</p>}
    <div className="code-control-row"><label className="field-label">Input · zero or one CSV<select aria-label="Code input CSV" value={input} onChange={event=>setInput(event.target.value)}><option value="">No dataset</option>{datasets.map(value=><option key={value.id} value={value.id}>{value.title} · {value.hash.slice(0,8)}</option>)}</select></label><div className="field-label"><span>Parameters · params (JSON)</span><CodeEditor compact ariaLabel="Code parameters" value={params} onChange={setParams} language="json" onRun={runShortcut} onSave={saveShortcut}/></div></div>
    <p className="subtle">{input?`The exact full CSV is df${context.columns?.length?` (${context.columns.length} columns)`:''}.`:'No sample or hidden data is supplied.'} Helpers: pd, np, plt, scipy, metric, table, plot, export_csv, conclusion. df exists only with a CSV.</p>

    {python&&capabilities?.sandbox&&!capabilities.sandbox.available&&<p className="runtime-blocker" role="status">{capabilities.sandbox.limitations[0]} Start Docker, build the research image and restart ros.ai. No host fallback runs.</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {pending&&<section className="code-approval" aria-label="Exact Code execution approval"><strong><ShieldCheck size={15}/> Review captured attempt</strong><p>One local isolated run · {preview!.inputMode==='single-csv'?'exact captured CSV':'no dataset'} · up to 30 seconds. To skip this step, set Permissions to Full access.</p><code>Approval {preview!.approval.fingerprint.slice(0,12)}</code><details><summary>Captured code, input and parameters</summary><CodeView code={preview!.code}/><pre>{preview!.csv||'No dataset'}</pre><pre>{JSON.stringify(preview!.parameters,null,2)}</pre></details>{(!matches||dirty)&&<p className="inline-error">The editor differs from this saved attempt. Cancel it before running revised code.</p>}<div className="row gap"><button className="primary" disabled={busy||!matches||dirty} onClick={()=>void decide('allow')}><Play size={14}/> Allow & run</button><button className="secondary" disabled={busy} onClick={()=>void decide('cancel')}>Cancel attempt</button></div></section>}
    <details className="code-runtime-details"><summary>Runtime and permissions</summary><p>{modeLabel(policy?.overrides[node.id]??policy?.mode??'ask')} · {policy?.used.experiments??0} code runs in this project so far.</p>{capabilities?.sandbox?.enforcement.map(value=><p key={value}>{value}</p>)}{capabilities?.sandbox?.limitations.map(value=><p key={value}>{value}</p>)}</details>
  </div><div className="code-results"><div className="row between"><h3><History size={16}/> Attempts & outputs</h3><span>{runs.length} saved</span></div>{run?<><label className="field-label">Attempt<select aria-label="Code attempt" value={run.id} onChange={event=>setSelected(event.target.value)}>{runs.map(value=><option key={value.id} value={value.id}>{date(value.createdAt)} · {value.status} · {value.id.slice(0,8)}</option>)}</select></label><p className="run-status-line"><strong>{pending?'Awaiting approval':run.status==='cancelled'?'Stopped':run.status}</strong> <span>{run.events.at(-1)?.message}</span></p>{run.error&&<p className="inline-error">{run.error}</p>}{['queued','running'].includes(run.status)&&!pending&&<p className="subtle">Status updates are polled. Outputs appear when capture finishes; this runtime does not stream.</p>}{results.length?results.map(value=><section className="code-output" key={value.id}><div className="row between"><strong>{value.title}</strong><small>{value.kind} · {value.hash.slice(0,8)}</small></div>{value.kind==='log'?<details><summary>Console output and errors</summary><CodeConsole artifact={value}/></details>:<ArtifactContent artifact={value}/>}<ResultActions artifact={value} detail={detail} onChanged={onRefresh} onOpen={onOpenArtifact} onReport={onReport} onInterpret={onInterpret}/></section>):<p className="subtle">No outputs captured for this attempt. Earlier results remain in the attempt selector.</p>}<details className="code-attempt-trace"><summary>Exact source, inputs, approval and runtime receipt</summary><pre>{JSON.stringify(run,null,2)}</pre><p>Observable execution records; no guarantee of deterministic replay.</p></details></>:<div className="code-output-empty"><strong>Your results will appear here.</strong><p>Write a program and run it. The assistant is optional.</p></div>}</div></div>;
}
function draftSafe(value:string){try{return JSON.parse(value);}catch{return null;}}

function CodeConsole({artifact}:{artifact:Artifact}){let content=artifact.content;try{const data=JSON.parse(content);content=[data.stdout,data.stderr,data.error].filter(Boolean).join('\n')||'No stdout or stderr.';}catch{}return <pre>{content}</pre>;}
