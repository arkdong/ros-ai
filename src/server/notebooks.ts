import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import { parseCsv } from '../shared/data-view.js';
import { NOTEBOOK_LIMITS, type NotebookCaptureSummary, type NotebookCellPreview, type NotebookOpen, type NotebookOutputPreview,
  type NotebookSessionStatus, type NotebookSnapshot, type NotebookSnapshotSummary, type NotebookState } from '../shared/notebooks.js';
import type { Artifact, CanvasNode, Run } from '../shared/types.js';
import { Store, StoreError } from './store.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const now = () => new Date().toISOString();
const hash = (content:string) => createHash('sha256').update(content,'utf8').digest('hex');
const bytes = (content:string) => Buffer.byteLength(content,'utf8');
const object = (value:unknown):Record<string,unknown>|null => value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text = (value:unknown):string|null => typeof value==='string'?value:Array.isArray(value)&&value.every(item=>typeof item==='string')?value.join(''):null;
const label = (value:unknown,max=128) => typeof value==='string'?value.slice(0,max):undefined;
const warnings = ['Saved notebook outputs were produced externally; ros.ai did not execute these cells.',
  'Execution counts are reported notebook metadata, not verified execution order or dependency evidence.',
  'A user-managed Jupyter kernel has its own permissions; ros.ai Docker isolation and execution grants do not apply to it.'];

type Session = {id:string;projectId:string;nodeId:string;name:string;endpoint:string;token?:string;interface:'lab'|'notebook';revision:number;
  available:boolean|null;checkedAt:string|null;reason:string;disabled?:boolean};
type SnapshotRecord = NotebookSnapshotSummary;
type Output = { preview:NotebookOutputPreview; kind:Artifact['kind']; content:string; mediaType:string; metadata?:Record<string,unknown> };
type Parsed = {cells:NotebookCellPreview[];outputs:Output[][];kernelName?:string;language?:string;warnings:string[]};

/** Reject the current connection credential even when JSON decoding or nbformat
 * multiline fields would reconstruct it. Diagnostics never echo its value. */
export function assertNotebookCredentialAbsent(content:string,token?:string):void {
  if(!token)return;
  const reject=()=>{throw new StoreError('Notebook response contains the connection credential; it was not saved or displayed.');};
  if(content.includes(token))reject();
  let decoded:unknown;try{decoded=JSON.parse(content);}catch{throw new StoreError('Notebook response is not supported JSON.');}
  const pending:unknown[]=[decoded];
  while(pending.length){
    const value=pending.pop();
    if(typeof value==='string'){if(value.includes(token))reject();}
    else if(Array.isArray(value)){
      // nbformat source/text/MIME/traceback fields may be string arrays on disk.
      // Also cover string-array metadata before saving the exact source JSON.
      if(value.every(item=>typeof item==='string')&&value.join('').includes(token))reject();
      for(const item of value)pending.push(item);
    }else if(value!==null&&typeof value==='object')for(const [key,item] of Object.entries(value)){
      if(key.includes(token))reject();pending.push(item);
    }
  }
}

/** Only literal loopback destinations; no URL credentials, tokens, queries or redirects. */
export function notebookEndpoint(supplied:string):string {
  let url:URL;try{url=new URL(supplied);}catch{throw new StoreError('Enter a local Jupyter base URL, such as http://127.0.0.1:8888/.');}
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) {
    throw new StoreError('Jupyter must use a literal loopback base URL without credentials, query parameters or a token. Enter the token separately.');
  }
  const port=Number(url.port||(url.protocol==='https:'?443:80));
  if(port<1024||port>65535)throw new StoreError('Use an explicit local Jupyter port from 1024 to 65535.');
  if(url.pathname.split('/').some(segment=>{try{return ['.','..'].includes(decodeURIComponent(segment))||/[\\\u0000-\u001f]/u.test(decodeURIComponent(segment));}catch{return true;}}))throw new StoreError('Use a valid Jupyter base path.');
  return url.origin+url.pathname.replace(/\/?$/u,'/');
}
export function notebookPath(supplied:string):string {
  if(!supplied||supplied.length>1000||supplied.startsWith('/')||/[\\\u0000-\u001f]/u.test(supplied)||supplied.split('/').some(segment=>!segment||segment==='.'||segment==='..')||!supplied.toLowerCase().endsWith('.ipynb')) {
    throw new StoreError('Choose a relative .ipynb path inside the connected Jupyter root, without parent traversal.');
  }
  return supplied;
}
const encodedPath=(path:string)=>path.split('/').map(encodeURIComponent).join('/');
const connectSchema=z.object({endpoint:z.string().min(1).max(1200),token:z.string().min(8).max(4096).regex(/^[A-Za-z0-9._~-]+$/u).optional(),
  interface:z.enum(['lab','notebook']).default('lab'),name:z.string().trim().min(1).max(120).default('Local Jupyter'),path:z.string().min(1).max(1000)}).strict();
const png = (supplied:string):string|null => {
  const content=supplied.replace(/\s/gu,'');
  if(content.length>NOTEBOOK_LIMITS.outputBytes||!/^[A-Za-z0-9+/]+={0,2}$/u.test(content)||content.length%4!==0)return null;
  const data=Buffer.from(content,'base64');
  if(data.length<33||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.toString('ascii',12,16)!=='IHDR')return null;
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  return width>0&&height>0&&width<=10000&&height<=10000&&width*height<=16_000_000?content:null;
};
const safeSvg = (content:string):boolean => {
  if(!/^\s*<svg\b/u.test(content)||!/<\/svg>\s*$/u.test(content)||/<[!?]|\son[a-z]+\s*=|javascript:|data:|\b(?:src|style)\s*=|<style\b/iu.test(content))return false;
  const tags=[...content.matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)\b/gu)].map(match=>match[1]);
  if(tags.some(tag=>!['svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','clipPath','marker','pattern','linearGradient','radialGradient','stop','title','desc','use'].includes(tag)))return false;
  if([...content.matchAll(/(?:href|xlink:href)\s*=\s*([^\s>]+)/giu)].some(match=>!/^['"]#[A-Za-z0-9_.:-]+['"]$/u.test(match[1])))return false;
  return !/url\(\s*[^#\s]/iu.test(content);
};
function output(value:unknown,index:number):Output {
  const item=object(value),type=item?.output_type;
  let kind:NotebookOutputPreview['kind']='unsupported',artifactKind:Artifact['kind']='result',content=JSON.stringify(value),mediaType='application/json',title=`Output ${index+1}`,reason:string|undefined;
  if(type==='stream'&&text(item?.text)!==null){kind='text';artifactKind='log';content=text(item?.text)!;mediaType='text/plain';title=item?.name==='stderr'?'Saved stderr':'Saved stdout';}
  else if(type==='error') {kind='text';artifactKind='log';content=[label(item?.ename,100),label(item?.evalue,4000),text(item?.traceback)].filter(Boolean).join('\n');mediaType='text/plain';title='Saved notebook error';}
  else if(type==='display_data'||type==='execute_result') {
    const data=object(item?.data),csv=text(data?.['text/csv']),image=text(data?.['image/png']),svg=text(data?.['image/svg+xml']),plain=text(data?.['text/plain']);
    if(csv!==null&&csv!==undefined){try{parseCsv(csv,true);kind='csv';artifactKind='dataset';content=csv;mediaType='text/csv';title='Saved CSV table';}catch{reason='Invalid CSV remains an inert JSON output.';}}
    else if(image){const validated=png(image);if(validated){kind='figure';artifactKind='plot';content=validated;mediaType='image/png';title='Saved PNG figure';}else reason='PNG exceeds image limits or has an unsupported header.';}
    else if(svg&&safeSvg(svg)){kind='figure';artifactKind='plot';content=svg;mediaType='image/svg+xml';title='Saved SVG figure';}
    else if(Object.hasOwn(data??{},'application/json')){kind='json';content=JSON.stringify(data!['application/json'],null,2);mediaType='application/json';title='Saved JSON output';}
    else if(plain!==null&&plain!==undefined){kind='text';artifactKind='log';content=plain;mediaType='text/plain';title='Saved text representation';reason='Other representations remain in the exact notebook snapshot; HTML/scripts are never rendered.';}
    else reason='Unsupported representations can be captured as an inert JSON download; they are not executed or rendered.';
  } else reason='Unsupported notebook output can be captured as inert JSON only.';
  const capturable=bytes(content)<=NOTEBOOK_LIMITS.outputBytes;
  if(!capturable)reason=`This output exceeds the ${NOTEBOOK_LIMITS.outputBytes.toLocaleString()}-byte capture limit.`;
  const truncated=kind!=='figure'&&content.length>NOTEBOOK_LIMITS.previewCharacters;
  return {kind:artifactKind,content,mediaType,metadata:mediaType==='image/png'?{contentEncoding:'base64'}:undefined,
    preview:{index,kind,title,mediaType,content:kind==='figure'?(capturable?content:undefined):content.slice(0,NOTEBOOK_LIMITS.previewCharacters),capturable,...(reason?{reason}:{}),...(truncated?{truncated:true}:{})}};
}

/** Parse bounded nbformat 4 without executing code, markup, attachments or outputs. */
export function inspectNotebookSource(content:string,token?:string):Parsed {
  if(bytes(content)>NOTEBOOK_LIMITS.snapshotBytes)throw new StoreError(`Notebook snapshots are limited to ${NOTEBOOK_LIMITS.snapshotBytes.toLocaleString()} bytes.`);
  assertNotebookCredentialAbsent(content,token);
  let document:Record<string,unknown>|null;try{document=object(JSON.parse(content));}catch{throw new StoreError('Upload valid notebook JSON.');}
  if(document?.nbformat!==4||!Array.isArray(document.cells)||document.cells.length>NOTEBOOK_LIMITS.cells)throw new StoreError(`Use nbformat 4 with no more than ${NOTEBOOK_LIMITS.cells} cells.`);
  const rawCells=document.cells,counts=new Map<string,number>();
  for(const raw of rawCells){const cell=object(raw);if(typeof cell?.id==='string')counts.set(cell.id,(counts.get(cell.id)??0)+1);}
  const allOutputs:Output[][]=[];
  const cells=rawCells.map((raw,index):NotebookCellPreview=>{
    const cell=object(raw),source=text(cell?.source);
    if(!cell||!['code','markdown','raw'].includes(String(cell.cell_type))||source===null||source.length>NOTEBOOK_LIMITS.cellSourceCharacters)throw new StoreError('Notebook has an unsupported cell or oversized source.');
    const cellId=typeof cell.id==='string'&&/^[A-Za-z0-9_-]{1,64}$/u.test(cell.id)&&counts.get(cell.id)===1?cell.id:null;
    const outputs=cell.cell_type==='code'?cell.outputs??[]:[];
    if(!Array.isArray(outputs)||outputs.length>NOTEBOOK_LIMITS.outputsPerCell)throw new StoreError('Notebook cell has too many outputs.');
    const described=outputs.map(output);allOutputs.push(described);
    const executionCount=typeof cell.execution_count==='number'&&Number.isSafeInteger(cell.execution_count)&&cell.execution_count>=0?cell.execution_count:null;
    return {index,id:cellId,locator:cellId?`cell-id:${cellId}`:`cell-index:${index}`,cellType:cell.cell_type as NotebookCellPreview['cellType'],source,sourceHash:hash(source),executionCount,outputs:described.map(result=>result.preview)};
  });
  const metadata=object(document.metadata),kernel=object(metadata?.kernelspec),language=object(metadata?.language_info);
  return {cells,outputs:allOutputs,kernelName:label(kernel?.name),language:label(language?.name),warnings:[...warnings,
    ...(cells.some(cell=>!cell.id)?['Some cells have no unique stable ID; their locator is valid only within this exact snapshot.']:[])]};
}

export class NotebookService {
  private readonly active=new Map<string,AbortController>();
  private closed=false;
  constructor(private readonly store:Store){}
  private node(projectId:string,nodeId:string):CanvasNode {if(this.closed)throw new StoreError('Notebook service is shutting down.',503);const node=this.store.getProject(projectId).canvas.nodes.find(node=>node.id===nodeId);if(!node||node.blockType!=='notebook')throw new StoreError('Choose a Notebook block in this project.',404);return node;}
  private session(projectId:string,nodeId:string):Session|null {
    const node=this.node(projectId,nodeId),session=node.notebook?.sessionId?this.store.globalRecord<Session>('notebook-session-private',node.notebook.sessionId):undefined;
    if(session&&(session.projectId!==projectId||session.nodeId!==nodeId))throw new StoreError('Notebook connection does not belong to this block.');
    return session??null;
  }
  private publicSession(session:Session):NotebookSessionStatus {return {id:session.id,name:session.name,endpoint:session.endpoint,interface:session.interface,tokenConfigured:Boolean(session.token),
    available:session.disabled?false:session.available,checkedAt:session.checkedAt,reason:session.disabled?'Connection was disconnected. Reconnect deliberately.':session.reason,runtimeOwner:'user-managed-jupyter',isolation:'external-unverified'};}
  private summaries(projectId:string,nodeId:string){return this.store.records<SnapshotRecord>('notebook-snapshot',projectId).filter(snapshot=>snapshot.nodeId===nodeId).reverse();}
  snapshot(projectId:string,nodeId:string,snapshotId:string):NotebookSnapshot {
    this.node(projectId,nodeId);const saved=this.store.record<SnapshotRecord>('notebook-snapshot',snapshotId);
    if(!saved||saved.projectId!==projectId||saved.nodeId!==nodeId)throw new StoreError('Notebook snapshot not found in this block.',404);
    const artifact=this.store.getArtifact(saved.sourceArtifactId);
    if(artifact.projectId!==projectId||artifact.nodeId!==nodeId||artifact.hash!==saved.hash||artifact.kind!=='notebook')throw new StoreError('Notebook source version failed its integrity check.',500);
    return {...saved,cells:inspectNotebookSource(artifact.content,this.session(projectId,nodeId)?.token).cells};
  }
  state(projectId:string,nodeId:string):NotebookState {
    const session=this.session(projectId,nodeId),snapshots=this.summaries(projectId,nodeId).slice(0,20),latest=snapshots[0];
    return {session:session?this.publicSession(session):null,snapshot:latest?this.snapshot(projectId,nodeId,latest.id):null,snapshots,
      captures:this.store.records<NotebookCaptureSummary&{nodeId:string}>('notebook-output-capture',projectId).filter(capture=>capture.nodeId===nodeId).slice(-40).reverse().map(({nodeId:_,...capture})=>capture),limits:NOTEBOOK_LIMITS,
      reason:session?'Open Jupyter to edit/run with its own permissions. Save there, then deliberately read a new snapshot here.':'Connect an existing local Jupyter server to open/use a notebook. Uploading a snapshot provides capture only.'};
  }
  private matching(session:Session,path:string) {const current=this.session(session.projectId,session.nodeId);if(this.closed||!current||current.disabled||current.id!==session.id||current.revision!==session.revision||this.node(session.projectId,session.nodeId).notebook?.path!==path)throw new StoreError('Notebook connection or path changed. Review the current block before trying again.',409);}
  private async request(session:Session,path:string,query:string,signal:AbortSignal):Promise<unknown> {
    const url=new URL(path+query,session.endpoint);
    // Rewrite localhost for the API transport, preventing DNS from changing the
    // destination. The native browser URL retains the user's chosen hostname.
    if(url.hostname==='localhost')url.hostname='127.0.0.1';
    const response=await fetch(url,{method:'GET',headers:session.token?{Authorization:`token ${session.token}`,Accept:'application/json'}:{Accept:'application/json'},redirect:'error',signal});
    if(!response.ok){await response.body?.cancel();throw new StoreError(response.status===401||response.status===403?'Jupyter rejected API authentication. Enter its current token, or authenticate in its native UI.':`Jupyter read returned HTTP ${response.status}. Check the notebook path and local session.`);}
    const reader=response.body?.getReader();if(!reader)throw new StoreError('Jupyter returned no JSON body.');
    const chunks:Uint8Array[]=[];let length=0;
    try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>NOTEBOOK_LIMITS.responseBytes)throw new StoreError('Jupyter response exceeds the bounded capture limit.');chunks.push(part.value);}}
    finally{await reader.cancel().catch(()=>undefined);}
    const raw=Buffer.concat(chunks).toString('utf8');
    assertNotebookCredentialAbsent(raw,session.token);
    try{return JSON.parse(raw);}catch{throw new StoreError('Jupyter returned an unsupported response. Check its base URL and API authentication.');}
  }
  private async read(session:Session,path:string,content:boolean):Promise<Record<string,unknown>> {
    if(this.closed)throw new StoreError('Notebook service is shutting down.',503);
    const key=`${session.projectId}:${session.nodeId}`;if(this.active.has(key))throw new StoreError('A notebook read is already pending for this block.',409);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),NOTEBOOK_LIMITS.timeoutMs);this.active.set(key,controller);
    try{
      this.matching(session,path);const model=object(await this.request(session,'api/contents/'+encodedPath(path),`?type=notebook&content=${content?1:0}`,controller.signal));this.matching(session,path);
      if(!model||model.type!=='notebook'||model.path!==path)throw new StoreError('Jupyter did not return the requested notebook path.');
      return model;
    }catch(error){if(error instanceof StoreError)throw error;throw new StoreError('The local Jupyter read failed or timed out. No cell was executed or retried.');}
    finally{clearTimeout(timer);if(this.active.get(key)===controller)this.active.delete(key);}
  }
  async connect(projectId:string,nodeId:string,supplied:unknown):Promise<NotebookState> {
    const body=connectSchema.parse(supplied),endpoint=notebookEndpoint(body.endpoint),path=notebookPath(body.path);this.node(projectId,nodeId);
    if(body.token&&[endpoint,decodeURIComponent(new URL(endpoint).pathname),path,body.name].some(value=>value.includes(body.token!)))throw new StoreError('Keep the token in its private field, outside names, paths and URLs.');
    const previous=this.session(projectId,nodeId);
    const session:Session={id:randomUUID(),projectId,nodeId,name:body.name,endpoint,interface:body.interface,token:body.token,revision:0,available:null,checkedAt:null,reason:'Configured only. Check read-only notebook access; this does not start a kernel.'};
    this.store.atomic(()=>{this.store.saveGlobalRecord('notebook-session-private',session.id,session);this.store.mutate(projectId,[{type:'updateNode',id:nodeId,patch:{notebook:{sessionId:session.id,path}}}],'Connect local Notebook');
      if(previous)this.store.saveGlobalRecord('notebook-session-private',previous.id,{...previous,token:undefined,disabled:true,available:false});});
    return this.check(projectId,nodeId);
  }
  async check(projectId:string,nodeId:string):Promise<NotebookState> {
    const session=this.session(projectId,nodeId),path=this.node(projectId,nodeId).notebook?.path;
    if(!session||session.disabled||!path)throw new StoreError('Connect a local notebook first.');
    let available=false,reason='';try{await this.read(session,notebookPath(path),false);available=true;reason='Jupyter authenticated the read-only notebook path. No cell or kernel was started.';}catch(error){reason=error instanceof StoreError?error.message:'Local Jupyter is unavailable.';}
    this.matching(session,path);this.store.saveGlobalRecord('notebook-session-private',session.id,{...session,available,checkedAt:now(),reason});return this.state(projectId,nodeId);
  }
  open(projectId:string,nodeId:string):NotebookOpen {
    const session=this.session(projectId,nodeId),path=this.node(projectId,nodeId).notebook?.path;
    if(!session||session.disabled||!path)throw new StoreError('Connect an existing local notebook first.');
    const suffix=session.interface==='lab'?'lab/tree/':'notebooks/';
    return {url:new URL(suffix+encodedPath(notebookPath(path)),session.endpoint).href,nativeAuthentication:true,
      reason:'Token-free native Jupyter tab. Sign in there if needed; its kernel executes with its own permissions, outside ros.ai isolation.'};
  }
  private saveSnapshot(projectId:string,nodeId:string,content:string,path:string,origin:NotebookSnapshotSummary['origin'],session?:Session):NotebookState {
    const parsed=inspectNotebookSource(content,session?.token??this.session(projectId,nodeId)?.token);const node=this.node(projectId,nodeId);
    return this.store.atomic(()=>{
      const project=this.store.getProject(projectId),at=now(),run=this.captureRun(projectId,node,at,'Read saved notebook source',{origin,notebookPath:path,sessionId:session?.id??null,executionEvidence:'No execution observed; saved notebook snapshot only'});
      this.store.createRun(run);
      const artifact=this.store.addArtifact({projectId,nodeId,runId:run.id,kind:'notebook',title:path.split('/').at(-1)??'Notebook snapshot',content,mediaType:'application/x-ipynb+json',capture:'external',
        metadata:{origin:'external-notebook-source',notebookPath:path,sessionId:session?.id??null,runtimeOwner:origin==='jupyter'?'user-managed-jupyter':'unknown-external-notebook',sourceSerialization:origin==='jupyter'?'Serialized exact Contents API notebook JSON':origin==='project-file'?'Exact UTF-8 file from the project folder':'Uploaded exact UTF-8 snapshot',executionObserved:false,warnings:parsed.warnings}});
      this.store.updateRun(run.id,{status:'completed',endedAt:at,artifactIds:[artifact.id]});
      const snapshot:SnapshotRecord={id:randomUUID(),projectId,nodeId,hash:artifact.hash,sourceArtifactId:artifact.id,runId:run.id,capturedAt:at,path,origin,...(session?{sessionId:session.id}:{}),cells:parsed.cells.length,kernelName:parsed.kernelName,language:parsed.language,warnings:parsed.warnings};
      this.store.saveRecord('notebook-snapshot',snapshot.id,projectId,snapshot);return this.state(projectId,nodeId);
    });
  }
  async readSnapshot(projectId:string,nodeId:string):Promise<NotebookState> {
    const session=this.session(projectId,nodeId),path=this.node(projectId,nodeId).notebook?.path;
    if(!session||session.disabled||!path)throw new StoreError('Connect an existing local notebook first.');
    const model=await this.read(session,notebookPath(path),true);this.matching(session,path);
    if(!object(model.content))throw new StoreError('Jupyter did not return notebook JSON content.');
    return this.saveSnapshot(projectId,nodeId,JSON.stringify(model.content),path,'jupyter',session);
  }
  import(projectId:string,nodeId:string,supplied:unknown):NotebookState {
    const body=z.object({name:z.string().min(1).max(200),content:z.string().min(1).max(NOTEBOOK_LIMITS.snapshotBytes)}).strict().parse(supplied);
    if(body.name.includes('/')||body.name.includes('\\'))throw new StoreError('Use an .ipynb filename, not a filesystem path.');
    assertNotebookCredentialAbsent(body.content,this.session(projectId,nodeId)?.token);
    return this.saveSnapshot(projectId,nodeId,body.content,notebookPath(body.name),'uploaded-ipynb');
  }
  /** The block's .ipynb in the project folder, read after another app saved it. */
  importProjectFile(projectId:string,nodeId:string,path:string,content:string):NotebookState {
    assertNotebookCredentialAbsent(content,this.session(projectId,nodeId)?.token);
    return this.saveSnapshot(projectId,nodeId,content,notebookPath(path),'project-file');
  }
  private captureRun(projectId:string,node:CanvasNode,at:string,title:string,configuration:Record<string,unknown>):Run {
    const project=this.store.getProject(projectId);
    return {id:randomUUID(),projectId,nodeId:node.id,request:title,useSearch:false,status:'running',createdAt:at,startedAt:at,projectRevision:project.revision,node:structuredClone(node),inputs:[],messages:[],provider:'external-notebook',model:'not-applicable',modelVersion:null,
      configuration:{kind:'external-notebook-capture',runtimeOwner:configuration.origin==='jupyter'?'user-managed-jupyter':'unknown-external-notebook',executionObserved:false,...configuration},tools:[],events:[{at,type:'external-capture',message:'User requested a saved external notebook capture. This local record describes capture only; ros.ai did not execute code, start a kernel or call a model.'}],artifactIds:[]};
  }
  capture(projectId:string,nodeId:string,supplied:unknown):NotebookCaptureSummary {
    const body=z.object({snapshotId:id,cellIndex:z.number().int().nonnegative(),outputIndices:z.array(z.number().int().nonnegative()).min(1).max(NOTEBOOK_LIMITS.selectedOutputs)}).strict().parse(supplied);
    if(new Set(body.outputIndices).size!==body.outputIndices.length)throw new StoreError('Select each output once.');
    const snapshot=this.snapshot(projectId,nodeId,body.snapshotId),source=this.store.getArtifact(snapshot.sourceArtifactId),parsed=inspectNotebookSource(source.content,this.session(projectId,nodeId)?.token),cell=parsed.cells[body.cellIndex];
    if(!cell)throw new StoreError('Choose a cell from this exact saved snapshot.');
    const selected=body.outputIndices.map(index=>{const value=parsed.outputs[body.cellIndex][index];if(!value||!value.preview.capturable)throw new StoreError('Choose bounded capturable outputs from this cell.');return value;});
    return this.store.atomic(()=>{
      const node=this.node(projectId,nodeId),at=now(),run=this.captureRun(projectId,node,at,`Capture saved cell ${body.cellIndex+1} outputs`,{origin:snapshot.origin,notebookSnapshotId:snapshot.id,notebookSourceArtifactId:source.id,sourceHash:source.hash,cellIndex:cell.index,cellId:cell.id,cellLocator:cell.locator,cellSourceHash:cell.sourceHash,executionCount:cell.executionCount,outputIndices:body.outputIndices,executionOrder:'unverified',dependencies:'unverified'});
      this.store.createRun(run);
      const artifacts=selected.map((value,index)=>this.store.addArtifact({projectId,nodeId,runId:run.id,kind:value.kind,title:`${snapshot.path.split('/').at(-1)} · cell ${cell.index+1} · ${value.preview.title}`,content:value.content,mediaType:value.mediaType,capture:'external',
        locator:`notebook:${snapshot.hash}/${cell.locator}/output:${body.outputIndices[index]}`,metadata:{...value.metadata,origin:'external-notebook-output',notebookOutputKind:value.preview.kind,notebookPath:snapshot.path,notebookSnapshotId:snapshot.id,notebookSourceArtifactId:source.id,sourceHash:source.hash,cellIndex:cell.index,cellId:cell.id,cellLocator:cell.locator,cellSourceHash:cell.sourceHash,outputIndex:body.outputIndices[index],executionCount:cell.executionCount,executionObserved:false,executionOrder:'unverified',dependencies:'unverified',runtimeOwner:snapshot.origin==='jupyter'?'user-managed-jupyter':'unknown-external-notebook',warnings:snapshot.warnings}}));
      this.store.updateRun(run.id,{status:'completed',endedAt:at,artifactIds:artifacts.map(artifact=>artifact.id)});
      const capture:NotebookCaptureSummary={runId:run.id,snapshotId:snapshot.id,snapshotHash:snapshot.hash,cellIndex:cell.index,cellId:cell.id,cellLocator:cell.locator,outputIndices:body.outputIndices,artifactIds:artifacts.map(artifact=>artifact.id),capturedAt:at};
      this.store.saveRecord('notebook-output-capture',run.id,projectId,{...capture,nodeId});return capture;
    });
  }
  disconnect(projectId:string,nodeId:string):NotebookState {
    const session=this.session(projectId,nodeId),node=this.node(projectId,nodeId);
    this.store.atomic(()=>{if(session)this.store.saveGlobalRecord('notebook-session-private',session.id,{...session,token:undefined,disabled:true,available:false,reason:'Disconnected by user.'});
      this.store.mutate(projectId,[{type:'updateNode',id:nodeId,patch:{notebook:{path:node.notebook?.path??''}}}],'Disconnect local Notebook');});return this.state(projectId,nodeId);
  }
  shutdown(){this.closed=true;for(const controller of this.active.values())controller.abort();}
}

export function attachNotebookRoutes(app:Express,store:Store):NotebookService {
  const service=new NotebookService(store);app.locals.notebooks=service;
  const base='/api/projects/:id/nodes/:nodeId/notebook';
  const owned=(req:Request)=>[id.parse(req.params.id),id.parse(req.params.nodeId)] as const;
  const json=(req:Request)=>{if(!req.is('application/json'))throw new StoreError('Send a JSON notebook request.',415);};
  app.get(base,(req,res)=>res.json(service.state(...owned(req))));
  app.post(base+'/connect',async(req,res)=>{json(req);res.json(await service.connect(...owned(req),req.body));});
  app.post(base+'/check',async(req,res)=>{json(req);z.object({}).strict().parse(req.body);res.json(await service.check(...owned(req)));});
  app.get(base+'/open',(req,res)=>res.json(service.open(...owned(req))));
  app.post(base+'/snapshot',async(req,res)=>{json(req);z.object({}).strict().parse(req.body);res.status(201).json(await service.readSnapshot(...owned(req)));});
  app.post(base+'/import',(req,res)=>{json(req);res.status(201).json(service.import(...owned(req),req.body));});
  app.get(base+'/snapshots/:snapshotId',(req,res)=>res.json(service.snapshot(...owned(req),id.parse(req.params.snapshotId))));
  app.post(base+'/capture',(req,res)=>{json(req);res.status(201).json(service.capture(...owned(req),req.body));});
  app.delete(base+'/connect',(req,res)=>res.json(service.disconnect(...owned(req))));
  return service;
}
