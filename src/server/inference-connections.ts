import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, fstatSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { InferenceConnectionStatus } from '../shared/inference.js';
import { modelMaker } from '../shared/model-settings.js';
import type { UsageRecord } from '../shared/types.js';
import type { ModelAdapter, ModelInfo, ModelRequest, ModelResponse } from './providers.js';
import { Store, StoreError } from './store.js';
import { captureChatCompletion } from './response-normalization.js';

const namespace='inference-connection';
const indexNamespace='inference-registry';
const UNITS_PER_USD=1_000_000_000;
const units=(usd:number)=>Number.isFinite(usd)&&usd>=0?Math.min(Number.MAX_SAFE_INTEGER,Math.ceil(usd*UNITS_PER_USD)):Number.MAX_SAFE_INTEGER;
const ceilingUnits=(usd:number)=>Math.floor(usd*UNITS_PER_USD);
const idSchema=z.string().regex(/^custom-[a-f0-9-]{36}$/);
const keySchema=z.string().trim().min(1).max(4096).refine(value=>!/[\s\x00-\x1f\x7f]/.test(value),'Enter one API key without spaces.');
const makerSchema=z.object({id:z.enum(['nvidia','moonshot','openai','unknown']),label:z.string().trim().min(1).max(60),monogram:z.string().trim().min(1).max(4)}).strict();
const modelSchema=z.object({id:z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]*$/),label:z.string().trim().min(1).max(100),contextTokens:z.number().int().min(256).max(8_000_000),inputUsdPerMillion:z.number().finite().min(0).max(10000).optional(),outputUsdPerMillion:z.number().finite().min(0).max(10000).optional(),maker:makerSchema.optional()}).strict();
const capsSchema=z.object({maxInputBytes:z.number().int().min(256).max(64000),maxOutputTokens:z.number().int().min(1).max(32768),timeoutMs:z.number().int().min(1000).max(300000),maxConcurrent:z.number().int().min(1).max(4),maxResponseBytes:z.number().int().min(1024).max(512000).default(128000)}).strict();
const connectionFields={name:z.string().trim().min(1).max(100),endpoint:z.string().trim().min(1).max(2000),apiKey:keySchema.nullable().optional(),models:z.array(modelSchema).min(1).max(16),caps:capsSchema,enabled:z.boolean()};
const connectionSchema=z.object(connectionFields).strict();
const patchSchema=z.object(connectionFields).partial().strict().refine(value=>Object.keys(value).length>0,'Provide a connection change.');
const privateSchema=connectionSchema.extend({id:idSchema,createdAt:z.string(),updatedAt:z.string()});
const fileSchema=z.object({version:z.literal(1),connections:z.array(privateSchema).max(32)}).strict();
type PrivateConnection=z.infer<typeof privateSchema>;
type Admission={usageId:string;reservedUnits:number;createdAt:string};
type State={revision:number;updatedAt:string;allowanceEnabled:boolean;requestCeiling:number;usdCeiling:number;admissions:Admission[];endpointFingerprints:string[];summary:InferenceConnectionStatus};
type Reservation={provider:string;amountUsd:number;purpose:string;basis:string;runId?:string;trace?:Record<string,unknown>};

function endpoint(value:string){
  let url:URL;try{url=new URL(value);}catch{throw new StoreError('Enter a valid compatible inference endpoint.');}
  if(url.username||url.password||url.search||url.hash)throw new StoreError('Keep credentials in the API-key field; endpoint queries, fragments and embedded credentials are not accepted.');
  const local=['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname.toLowerCase());
  if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw new StoreError('Remote inference requires HTTPS. HTTP is permitted only for loopback endpoints.');
  url.pathname=url.pathname.replace(/\/+$/,'');
  return {url,destination:local?'local-unverified' as const:'remote' as const,fingerprint:createHash('sha256').update(url.href).digest('hex')};
}
function validateConnection(connection:PrivateConnection){
  const parsed=endpoint(connection.endpoint),ids=connection.models.map(model=>model.id);
  if(new Set(ids).size!==ids.length)throw new StoreError('Each configured model needs a unique stable model ID.');
  for(const model of connection.models){
    if(connection.caps.maxOutputTokens>=model.contextTokens)throw new StoreError('The output cap must be below every configured model context cap.');
    if(parsed.destination==='remote'&&(!Number.isFinite(model.inputUsdPerMillion)||!Number.isFinite(model.outputUsdPerMillion)||Math.max(model.inputUsdPerMillion??0,model.outputUsdPerMillion??0)<=0))throw new StoreError('Every remote model needs explicit conservative input and output USD rates before it can be configured.');
    if(parsed.destination==='local-unverified'&&((model.inputUsdPerMillion??0)!==0||(model.outputUsdPerMillion??0)!==0))throw new StoreError('Loopback usage is recorded without a provider USD debit; remote billing must use a remote connection. Local processing remains unverified.');
  }
  return {...connection,endpoint:parsed.url.href};
}

/** Server-only keys and full endpoints live in an owner-readable file. SQLite
 * holds only masked registry entries and retained admission identities. */
export class InferenceConnections{
  private readonly file:string;
  private connections:PrivateConnection[]=[];
  private readonly active=new Map<string,number>();
  constructor(private readonly store:Store,dataDir:string){
    mkdirSync(dataDir,{recursive:true,mode:0o700});this.file=join(dataDir,'inference-connections.json');
    if(existsSync(this.file)){
      const fd=openSync(this.file,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const info=fstatSync(fd);if(!info.isFile()||info.size>1_000_000||(info.mode&0o077)!==0||(typeof process.getuid==='function'&&info.uid!==process.getuid()))throw Error();this.connections=fileSchema.parse(JSON.parse(readFileSync(fd,'utf8'))).connections.map(validateConnection);}
      catch{throw new StoreError('Could not read private inference connections. The file must be valid and readable only by its owner.',500);}finally{closeSync(fd);}
    }
    this.syncIndex();
  }
  private state(id:string){return this.store.globalRecord<State>(namespace,id);}
  private persist(connections:PrivateConnection[]){
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    try{writeFileSync(temporary,JSON.stringify({version:1,connections}),{flag:'wx',mode:0o600});renameSync(temporary,this.file);}catch{if(existsSync(temporary))unlinkSync(temporary);throw new StoreError('Could not save private inference connections.',500);}
    this.connections=connections;
  }
  private ids(){return [...new Set([...(this.store.globalRecord<{connections:InferenceConnectionStatus[]}>(indexNamespace,'all')?.connections??[]).map(item=>item.id),...this.connections.map(item=>item.id)])];}
  private syncIndex(){this.store.saveGlobalRecord(indexNamespace,'all',{connections:this.ids().map(id=>this.status(id))});}
  private accounted(state:State){const usage=new Map(this.store.listUsage().map(row=>[row.id,row]));return state.admissions.reduce((total,item)=>{const row=usage.get(item.usageId);return Math.min(Number.MAX_SAFE_INTEGER,total+Math.max(item.reservedUnits,units(row?.reservedUsd??0),units(row?.estimatedUsd??0)));},0);}
  status(id:string,requiredUsd?:number):InferenceConnectionStatus{
    idSchema.parse(id);const config=this.connections.find(item=>item.id===id),state=this.state(id);
    if(!config&&!state)throw new StoreError('Inference connection not found.',404);
    const parsed=config?endpoint(config.endpoint):undefined,destination=parsed?.destination??state!.summary.destination;
    const accounted=state?this.accounted(state):0,usdCeiling=state?.usdCeiling??0,remaining=Math.max(0,ceilingUnits(usdCeiling)-accounted),usedRequests=state?.admissions.length??0,requestCeiling=state?.requestCeiling??0;
    const enabled=Boolean(config?.enabled),allowanceEnabled=state?.allowanceEnabled??false,remainingRequests=Math.max(0,requestCeiling-usedRequests);
    const available=Boolean(config)&&(this.active.get(id)??0)<config!.caps.maxConcurrent;
    let reason=destination==='local-unverified'?'Configured loopback endpoint; processing location and runtime behavior are unverified. Requests use a retained request limit, deadline and byte/output caps.':'Configured remote endpoint; selected research is transferred there. Pricing and model context caps are user-declared conservative values, not verified account prices.';
    if(!config)reason='Connection removed. Its stable identity and previous usage remain retained.';
    else if(!enabled)reason='Connection disabled. Re-enable it deliberately; previous usage remains retained.';
    else if(!allowanceEnabled)reason='Enable a separate bounded connection allowance before inference. Setup and keys do not grant usage.';
    else if(!available)reason='This connection concurrency cap is reached. Wait for an active request to finish or stop it before requesting more usage.';
    else if(!remainingRequests)reason='Connection request ceiling exhausted. Failed and uncertain requests remain counted.';
    else if(destination==='remote'&&(remaining===0||requiredUsd!==undefined&&units(requiredUsd)>remaining))reason='The conservative reservation exceeds this remote connection allowance. Previous reservations remain retained.';
    const amountValid=requiredUsd===undefined||Number.isFinite(requiredUsd)&&requiredUsd>=0&&(destination==='local-unverified'||requiredUsd>0);
    const ready=enabled&&available&&allowanceEnabled&&remainingRequests>0&&amountValid&&(destination==='local-unverified'||remaining>0&&(requiredUsd===undefined||units(requiredUsd)<=remaining));
    return {id,name:config?.name??state!.summary.name,enabled,deleted:!config,ready,reason,revision:state?.revision??0,endpointOrigin:parsed?.url.origin??state!.summary.endpointOrigin,keyConfigured:Boolean(config?.apiKey),destination,models:config?.models.map(model=>({...model,maker:model.maker??modelMaker(model.id)}))??state!.summary.models,caps:config?.caps??state!.summary.caps,allowanceEnabled,requestCeiling,usdCeiling,usedRequests,accountedUsd:accounted/UNITS_PER_USD,remainingRequests,remainingUsd:remaining/UNITS_PER_USD,pricingBasis:destination==='local-unverified'?'No provider USD debit; loopback processing location is unverified.':'Operator-declared input/output upper rates; both full input and full output model context are reserved because hidden/billed reasoning limits are unverified. Account prices and tokenizer are unverified.',updatedAt:state?.updatedAt??config!.updatedAt};
  }
  statuses(){return this.ids().map(id=>this.status(id));}
  create(supplied:unknown){
    const input=connectionSchema.parse(supplied),at=new Date().toISOString(),parsed=endpoint(input.endpoint);
    const existing=this.ids().find(id=>this.state(id)?.endpointFingerprints.includes(parsed.fingerprint));
    if(existing&&this.connections.some(item=>item.id===existing))throw new StoreError('This endpoint already has a stable connection. Edit that connection instead of creating a new usage ledger.',409);
    if(this.connections.length>=32)throw new StoreError('Configure at most 32 inference connections.');
    const id=existing??`custom-${randomUUID()}`,config=validateConnection({...input,id,createdAt:at,updatedAt:at});
    this.persist([...this.connections,config]);
    this.writeState(id,{allowanceEnabled:false,endpointFingerprint:parsed.fingerprint});return this.status(id);
  }
  update(id:string,supplied:unknown){
    idSchema.parse(id);const prior=this.connections.find(item=>item.id===id);if(!prior)throw new StoreError('Inference connection not found.',404);
    const patch=patchSchema.parse(supplied),config=validateConnection({...prior,...patch,updatedAt:new Date().toISOString()});
    const fingerprint=endpoint(config.endpoint).fingerprint;
    if(this.ids().some(other=>other!==id&&this.state(other)?.endpointFingerprints.includes(fingerprint)))throw new StoreError('This endpoint belongs to another retained connection identity.',409);
    this.persist(this.connections.map(item=>item.id===id?config:item));this.writeState(id,{endpointFingerprint:fingerprint});return this.status(id);
  }
  remove(id:string){idSchema.parse(id);const prior=this.connections.find(item=>item.id===id);if(!prior)throw new StoreError('Inference connection not found.',404);const summary=this.status(id);this.persist(this.connections.filter(item=>item.id!==id));this.writeState(id,{allowanceEnabled:false,summary});return this.status(id);}
  private writeState(id:string,changes:{allowanceEnabled?:boolean;requestCeiling?:number;usdCeiling?:number;endpointFingerprint?:string;summary?:InferenceConnectionStatus}){
    const prior=this.state(id),at=new Date().toISOString(),summary=changes.summary??this.status(id);
    const state:State={revision:(prior?.revision??0)+1,updatedAt:at,allowanceEnabled:changes.allowanceEnabled??prior?.allowanceEnabled??false,requestCeiling:changes.requestCeiling??prior?.requestCeiling??0,usdCeiling:changes.usdCeiling??prior?.usdCeiling??0,admissions:prior?.admissions??[],endpointFingerprints:[...new Set([...(prior?.endpointFingerprints??[]),...(changes.endpointFingerprint?[changes.endpointFingerprint]:[])])],summary};
    this.store.saveGlobalRecord(namespace,id,state);this.syncIndex();
  }
  saveAllowance(id:string,supplied:unknown){
    const config=this.connections.find(item=>item.id===id);if(!config)throw new StoreError('Inference connection not found.',404);
    const input=z.object({requestCeiling:z.number().int().min(1).max(10000),usdCeiling:z.number().finite().min(0).max(1000),enabled:z.literal(true),acknowledged:z.literal(true)}).strict().parse(supplied),status=this.status(id);
    if(status.destination==='remote'&&input.usdCeiling<=0)throw new StoreError('Remote inference needs a positive conservative USD ceiling.');
    // Migrating a retained remote identity to loopback never erases historical
    // charges. Its ceiling can retain those charges, but new local use debits $0.
    if(status.destination==='local-unverified'&&input.usdCeiling>Math.max(status.usdCeiling,status.accountedUsd))throw new StoreError('Loopback inference uses request/resource caps and no new provider USD debit. Retain only an existing historical USD ceiling, or use zero for a new connection.');
    if(input.requestCeiling<status.usedRequests||ceilingUnits(input.usdCeiling)<units(status.accountedUsd))throw new StoreError('New ceilings cannot be below already retained connection usage.',409);
    this.writeState(id,{allowanceEnabled:true,requestCeiling:input.requestCeiling,usdCeiling:input.usdCeiling});return this.status(id);
  }
  pause(id:string,supplied:unknown){z.object({}).strict().parse(supplied);this.status(id);this.writeState(id,{allowanceEnabled:false});return this.status(id);}
  assertRevision(id:string,expectedRevision:number){if(this.status(id).revision!==expectedRevision)throw new StoreError('Inference connection or allowance changed during preparation. No new dispatch occurred; review its current terms.',409);}
  reserve(input:Reservation,expectedRevision:number):UsageRecord{
    return this.store.atomic(()=>{
      this.assertRevision(input.provider,expectedRevision);const status=this.status(input.provider,input.amountUsd),state=this.state(input.provider);
      if(!state||!status.ready)throw new StoreError(status.reason,409);
      if(status.destination==='local-unverified'&&input.amountUsd!==0)throw new StoreError('Loopback inference must not debit provider USD.');
      if(!input.purpose.trim()||input.purpose.length>4000||!input.basis.trim()||input.basis.length>4000)throw new StoreError('Provide a bounded request purpose and pricing basis.');
      const at=new Date().toISOString(),reserved=units(input.amountUsd),usage:UsageRecord={id:randomUUID(),provider:input.provider,purpose:input.purpose,...(input.runId?{runId:input.runId}:{}),reservedUsd:reserved/UNITS_PER_USD,estimatedUsd:null,reportedUsage:{...(input.trace??{}),inferenceConnectionId:input.provider,inferenceConnectionRevision:expectedRevision,destination:status.destination},status:'reserved',basis:input.basis,createdAt:at};
      this.store.addUsage(usage);this.store.saveGlobalRecord(namespace,input.provider,{...state,admissions:[...state.admissions,{usageId:usage.id,reservedUnits:reserved,createdAt:at}]});this.syncIndex();return usage;
    });
  }
  adapter(id:string,model:string):ModelAdapter{
    return new CompatibleHttpAdapter(id,model,()=>{const config=this.connections.find(item=>item.id===id);if(!config?.enabled||!config.models.some(item=>item.id===model))throw new StoreError('Choose an enabled registered connection and its configured model.',409);return {config:structuredClone(config),revision:this.status(id).revision};},this.active);
  }
}

/** Text-only chat-completions transport; no shell, tools, catalog probes or
 * automatic fallback. prepare() reads declarations and performs no network. */
export class CompatibleHttpAdapter implements ModelAdapter{
  private prepared?:{config:PrivateConnection;revision:number};
  constructor(readonly provider:string,readonly model:string,private readonly snapshot:()=>{config:PrivateConnection;revision:number},private readonly active:Map<string,number>){}
  get configured(){try{this.snapshot();return true;}catch{return false;}}
  async prepare(signal:AbortSignal):Promise<ModelInfo>{
    if(signal.aborted)throw new StoreError('Inference was stopped before preparation.',409);
    this.prepared=this.snapshot();const {config}=this.prepared,model=config.models.find(item=>item.id===this.model)!,destination=endpoint(config.endpoint).destination;
    return {id:this.model,contextTokens:model.contextTokens,inputUsdPerToken:(model.inputUsdPerMillion??0)/1_000_000,outputUsdPerToken:(model.outputUsdPerMillion??0)/1_000_000,capabilities:{structuredOutput:false,toolCalling:false,cancellation:'abort-request',modelVersion:false},metadata:{connectionId:this.provider,endpointOrigin:endpoint(config.endpoint).url.origin,destination,declaredContextTokens:model.contextTokens,caps:config.caps,pricingBasis:destination==='remote'?'Operator-declared upper token rates and both full input and output model context; unverified. Output max_tokens is requested but hidden/billed reasoning behavior is unverified.':'No provider USD debit; loopback processing location and runtime behavior remain unverified.',processingVerified:false,requestedModel:this.model}};
  }
  describeRequest(request:ModelRequest):Record<string,unknown>{
    const {config}=this.prepared??this.snapshot();
    if(!Number.isInteger(request.maxOutputTokens)||request.maxOutputTokens<1||request.maxOutputTokens>config.caps.maxOutputTokens)throw new StoreError('Requested output exceeds this connection completion cap.');
    if(!Array.isArray(request.messages)||request.messages.some(message=>!message||!['system','user','assistant'].includes(message.role)||typeof message.content!=='string'))throw new StoreError('Only bounded scalar-text messages are supported by this connection.');
    const textMessages=request.messages.map(message=>({role:message.role,content:message.content}));
    const messages=request.schema?[{role:'system',content:`Return one JSON object matching this response contract, without Markdown fences or surrounding prose. It is a proposal only, never execution or permission. JSON Schema: ${JSON.stringify(request.schema)}`},...textMessages]:textMessages;
    const wire={model:this.model,messages,max_tokens:request.maxOutputTokens,n:1,stream:false};
    if(Buffer.byteLength(JSON.stringify(wire),'utf8')>config.caps.maxInputBytes)throw new StoreError('The complete text request exceeds this connection input-byte cap.');
    return wire;
  }
  inputTokenBound(){return null;}
  async complete(request:ModelRequest,signal:AbortSignal):Promise<ModelResponse>{
    const prepared=this.prepared??this.snapshot(),current=this.snapshot();if(prepared.revision!==current.revision)throw new StoreError('Connection terms changed before dispatch.',409);
    const {config}=prepared,wire=this.describeRequest(request),count=this.active.get(this.provider)??0;
    if(count>=config.caps.maxConcurrent)throw new StoreError('This connection concurrency cap is reached.',409);
    const combined=AbortSignal.any([signal,AbortSignal.timeout(config.caps.timeoutMs)]);if(combined.aborted)throw new StoreError('Inference was stopped before dispatch.',409);
    const url=endpoint(config.endpoint).url;if(!url.pathname.endsWith('/chat/completions'))url.pathname=`${url.pathname.replace(/\/+$/,'')}/chat/completions`;
    this.active.set(this.provider,count+1);
    try{
      const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(config.apiKey?{Authorization:`Bearer ${config.apiKey}`}:{})},body:JSON.stringify(wire),signal:combined});
      if(!response.ok){await response.body?.cancel();throw new StoreError(`Configured inference endpoint returned HTTP ${response.status}. No automatic retry occurred.`,503);}
      const reader=response.body?.getReader();if(!reader)throw new StoreError('Configured inference endpoint returned an empty response.',503);
      const chunks:Uint8Array[]=[];let bytes=0;
      for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.byteLength;if(bytes>config.caps.maxResponseBytes){await reader.cancel();throw new StoreError('Inference response exceeded its configured byte cap.',503);}chunks.push(result.value);}
      let result:any;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new StoreError('Configured inference endpoint returned invalid transport JSON.',503);}
      const captured=captureChatCompletion(result,{provider:this.provider,requestedModel:this.model,modelVersion:false,requireExactModel:true,responseContract:request.schema?'application-validated-json':'text',wireRequest:wire});
      return {...captured,metadata:{...captured.metadata,connectionId:this.provider,requestedModel:this.model,reportedModel:captured.model,destination:endpoint(config.endpoint).destination,endpointOrigin:endpoint(config.endpoint).url.origin,processingVerified:false,responseBytes:bytes,outputLimitBasis:'Operator-declared output upper bound requested as max_tokens; hidden/billed reasoning behavior is unverified.'}};
    }catch(error){if(error instanceof StoreError)throw error;throw new StoreError(combined.aborted?'Inference stopped or reached its deadline. Outcome may be uncertain; no automatic retry occurred.':'Configured inference connection failed. No automatic retry occurred.',503);}
    finally{const remaining=(this.active.get(this.provider)??1)-1;if(remaining>0)this.active.set(this.provider,remaining);else this.active.delete(this.provider);}
  }
}

export function registeredInferenceConnections(store:Store){return store.globalRecord<{connections:InferenceConnectionStatus[]}>(indexNamespace,'all')?.connections??[];}
export function attachInferenceConnectionRoutes(app:Express,connections:InferenceConnections){
  const json=(req:{is:(value:string)=>unknown})=>{if(!req.is('application/json'))throw new StoreError('Send a JSON inference configuration request.',415);};
  app.get('/api/connections/inference',(_req,res)=>res.json({connections:connections.statuses()}));
  app.post('/api/connections/inference',(req,res)=>{json(req);res.status(201).json(connections.create(req.body));});
  app.patch('/api/connections/inference/:id',(req,res)=>{json(req);res.json(connections.update(idSchema.parse(req.params.id),req.body));});
  app.delete('/api/connections/inference/:id',(req,res)=>res.json(connections.remove(idSchema.parse(req.params.id))));
  app.put('/api/connections/inference/:id/allowance',(req,res)=>{json(req);res.json(connections.saveAllowance(idSchema.parse(req.params.id),req.body));});
  app.post('/api/connections/inference/:id/pause',(req,res)=>{json(req);res.json(connections.pause(idSchema.parse(req.params.id),req.body));});
}
