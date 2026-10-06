import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { BudgetLedger, ExecutionService, evidenceSpans } from '../src/server/execution.js';
import { DeferredAgentRuntime, NebiusAdapter, type ModelAdapter, type ModelInfo, type ModelRequest, type ModelResponse, type SearchAdapter } from '../src/server/providers.js';

const info:ModelInfo = {id:'fake-contract-model',contextTokens:100000,inputUsdPerToken:0.0000001,outputUsdPerToken:0.0000003,capabilities:{structuredOutput:true,cancellation:'abort-request',toolCalling:false,modelVersion:false},metadata:{testFixture:true}};
const response = (content='A bounded model-only answer.'):ModelResponse=>({content,model:info.id,modelVersion:null,usage:{inputTokens:100,outputTokens:30},metadata:{testFixture:true}});
class FakeModel implements ModelAdapter {
  readonly provider='nebius';readonly model=info.id;readonly configured=true;
  requests:ModelRequest[]=[];
  constructor(public answer:(request:ModelRequest,signal:AbortSignal)=>Promise<ModelResponse>=async()=>response()){}
  async prepare(){ return structuredClone(info); }
  async complete(request:ModelRequest,signal:AbortSignal){ this.requests.push(structuredClone(request)); return this.answer(request,signal); }
}
class FakeSearch implements SearchAdapter {
  readonly configured=true;queries:string[]=[];
  async search(query:string){this.queries.push(query);return {results:[{title:'Captured source',url:'https://example.com/source',content:'Exact captured evidence says B.',locator:'search result snippet'}],credits:1,requestId:'fake-search'};}
}
function setup(){
  const path=mkdtempSync(join(tmpdir(),'ros-ai-execution-'));
  const store=new Store(path);const project=store.createProject('Separate investigations');
  store.mutate(project.id,['a','b','c'].map((id,index)=>({type:'addNode' as const,node:{id,title:`Node ${id}`,description:'Independent',x:index*312,y:0}})),'Create independent nodes');
  new Authority(store).configure(project.id, { mode: 'ask' });
  return {store,project,path,cleanup:()=>{store.close();rmSync(path,{recursive:true,force:true});}};
}
async function until(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out waiting for local fixture');}

test('node context excludes project and neighbors; graph edges import nothing; selected artifacts capture immutable versions',async()=>{
  const f=setup();const model=new FakeModel();const service=new ExecutionService(f.store,{model,search:new FakeSearch(),includeSetupUsage:false});
  try{
    f.store.addMessage(f.project.id,null,'user','PROJECT_SECRET_CONTEXT');
    f.store.addMessage(f.project.id,'b','user','NEIGHBOR_SECRET_CONTEXT');
    f.store.mutate(f.project.id,[{type:'addConnection',connection:{id:'edge',source:'a',target:'b',label:'Relationship'}}],'Relationship');
    const first=service.startRun(f.project.id,'a',{request:'Write a short answer',useSearch:false});
    await until(()=>f.store.getRun(first.id).status==='completed');
    const result=f.store.detail(f.project.id).artifacts.find(a=>a.runId===first.id&&a.kind==='result')!;
    const selected=f.store.addInput(f.project.id,'b',result.id,'bounded model-only');
    const second=service.startRun(f.project.id,'b',{request:'Use the selected phrase',useSearch:false});
    f.store.removeInput(f.project.id,selected.id);
    f.store.mutate(f.project.id,[{type:'updateNode',id:'a',patch:{description:'Changed after capture'}}],'Edit source');
    await until(()=>f.store.getRun(second.id).status==='completed');
    assert.equal(model.requests.length,2);
    assert.doesNotMatch(JSON.stringify(model.requests[0]),/PROJECT_SECRET_CONTEXT|NEIGHBOR_SECRET_CONTEXT/);
    assert.doesNotMatch(JSON.stringify(model.requests[1]),/PROJECT_SECRET_CONTEXT|Changed after capture/);
    assert.match(JSON.stringify(model.requests[1]),/NEIGHBOR_SECRET_CONTEXT|bounded model-only/);
    assert.equal(f.store.getRun(first.id).inputs.length,0);
    assert.equal(f.store.getRun(second.id).inputs[0].artifact.hash,result.hash);
    assert.equal(f.store.getRun(second.id).inputs[0].excerpt,'bounded model-only');
    assert.equal(f.store.listRuns(f.project.id).length,2);
  }finally{await service.shutdown();f.cleanup();}
});

test('project model produces preview only; discussion and rejected proposals never change canvas, trace persists',async()=>{
  const f=setup();let payload={reply:'Here is one proposed node.',summary:'Explore costs',operations:[{type:'addNode',node:{id:'new',title:'Costs',description:'An idea',x:0,y:400}}]};
  const model=new FakeModel(async()=>response(JSON.stringify(payload)));const service=new ExecutionService(f.store,{model,includeSetupUsage:false});
  try{
    f.store.addMessage(f.project.id,'a','user','PRIVATE_NODE_CHAT');
    const before=f.store.getProject(f.project.id);
    const reply=await service.chat(f.project.id,'Suggest a node');
    assert.ok(reply.proposal);
    assert.deepEqual(f.store.getProject(f.project.id),before);
    assert.doesNotMatch(JSON.stringify(model.requests),/PRIVATE_NODE_CHAT/);
    assert.ok((f.store.listUsage()[0].reportedUsage as any).request.schema);
    f.store.dismissProposal(f.project.id,reply.proposal!.id);
    assert.deepEqual(f.store.getProject(f.project.id),before);
    const accepted=await service.chat(f.project.id,'Suggest it again');
    f.store.acceptProposal(f.project.id,accepted.proposal!.id);
    assert.equal(f.store.getProject(f.project.id).canvas.nodes.length,4);
    payload={reply:'Discussing.',summary:'',operations:[]};
    const revision=f.store.getProject(f.project.id).revision;
    await service.chat(f.project.id,'Let us discuss options');
    assert.equal(f.store.getProject(f.project.id).revision,revision);
    payload={reply:'Invalid reference.',summary:'Invalid',operations:[{type:'addConnection',connection:{id:'bad',source:'missing',target:'a',label:''}}]} as any;
    await assert.rejects(service.chat(f.project.id,'Bad reference'));
    assert.equal(f.store.getProject(f.project.id).revision,revision);
  }finally{await service.shutdown();f.cleanup();}
});

test('one optional search produces exact captured excerpts and linked citations without graph edits',async()=>{
  const f=setup();const search=new FakeSearch();const model=new FakeModel(async()=>response('The source says B. [S1]\nAn uncited inference.\nAn invented reference. [S9]'));
  const service=new ExecutionService(f.store,{model,search,includeSetupUsage:false});
  try{
    const revision=f.store.getProject(f.project.id).revision;
    const run=service.startRun(f.project.id,'a',{request:'Find evidence about B',useSearch:true});
    await until(()=>f.store.getRun(run.id).status==='completed');
    assert.equal(search.queries.length,1);assert.equal(model.requests.length,1);
    const stored=f.store.getRun(run.id);const artifacts=f.store.detail(f.project.id).artifacts;
    const source=artifacts.find(a=>a.kind==='source')!;
    assert.equal(source.content,'Exact captured evidence says B.');assert.equal(source.capture,'search-snippet');
    assert.match(model.requests[0].messages[0].content,/Exact captured evidence says B\./);
    assert.ok(stored.tools.length===2);
    const spans=(stored.events.find(e=>e.type==='evidence')!.data as any).spans;
    assert.deepEqual(spans.map((s:any)=>s.supported),[true,false,false]);
    assert.deepEqual(spans[0].artifactIds,[source.id]);
    assert.equal(f.store.getProject(f.project.id).revision,revision);
    assert.deepEqual(f.store.listUsage().map(r=>r.provider),['tavily','nebius']);
  }finally{await service.shutdown();f.cleanup();}
});

test('duplicate click reuses run, concurrency is bounded, cancelling one discards late response and preserves other run',async()=>{
  const f=setup();const pending=new Map<string,(value:ModelResponse)=>void>();
  const model=new FakeModel(request=>new Promise(resolve=>pending.set(request.messages.at(-1)!.content,resolve)));
  const service=new ExecutionService(f.store,{model,includeSetupUsage:false,maxConcurrent:2});
  try{
    const a=service.startRun(f.project.id,'a',{request:'First',useSearch:false});
    const duplicate=service.startRun(f.project.id,'a',{request:'First',useSearch:false});assert.equal(duplicate.id,a.id);
    const b=service.startRun(f.project.id,'b',{request:'Second',useSearch:false});
    assert.throws(()=>service.startRun(f.project.id,'c',{request:'Third',useSearch:false}),/Concurrency/);
    await until(()=>pending.size===2);
    service.cancelRun(a.id);
    pending.get('Second')!(response('Second is intact'));
    await until(()=>f.store.getRun(b.id).status==='completed');
    pending.get('First')!(response('Must be discarded'));
    await new Promise(r=>setTimeout(r,10));
    assert.equal(f.store.getRun(a.id).status,'cancelled');
    assert.equal(f.store.detail(f.project.id).artifacts.filter(a=>a.runId===duplicate.id).length,0);
    assert.equal(f.store.listUsage().find(u=>u.runId===a.id)?.status,'uncertain');
    assert.equal(f.store.getRun(b.id).status,'completed');
  }finally{await service.shutdown();f.cleanup();}
});

test('failure and explicit retry retain separate records; restarting does not reissue uncertain requests',async()=>{
  const f=setup();const model=new FakeModel(async()=>{throw new Error('Simulated connection failure');});
  const service=new ExecutionService(f.store,{model,includeSetupUsage:false});
  let reopened:Store|undefined;
  try{
    const failed=service.startRun(f.project.id,'a',{request:'Try once',useSearch:false});
    await until(()=>f.store.getRun(failed.id).status==='failed');
    model.answer=async()=>response('Retry result');
    const retried=service.retryRun(failed.id);
    await until(()=>f.store.getRun(retried.id).status==='completed');
    assert.equal(retried.retryOf,failed.id);assert.equal(f.store.getRun(failed.id).status,'failed');
    assert.equal(model.requests.length,2);
    await service.shutdown();f.store.close();
    reopened=new Store(f.path);
    const replacement=new ExecutionService(reopened,{model,includeSetupUsage:false});
    assert.equal(reopened.getRun(retried.id).status,'completed');
    assert.equal(reopened.listUsage().find(u=>u.runId===failed.id)?.status,'uncertain');
    await replacement.shutdown();assert.equal(model.requests.length,2);
  }finally{await service.shutdown();reopened?.close();rmSync(f.path,{recursive:true,force:true});}
});

test('persistent budgets account in-flight, settled and unknown calls separately per provider',()=>{
  const f=setup();
  try{
    const ledger=new BudgetLedger(f.store,{nebius:0.03,tavily:0.016});
    const n=ledger.reserve('nebius',0.02,'test','test');
    f.store.updateUsage(n.id,{status:'settled',estimatedUsd:0.00001});
    assert.throws(()=>ledger.reserve('nebius',0.02,'test','test'),/budget/);
    ledger.reserve('tavily',0.008,'test','test');ledger.reserve('tavily',0.008,'test','test');
    assert.throws(()=>ledger.reserve('tavily',0.008,'test','test'),/budget/);
    assert.equal(ledger.accounted('nebius'),0.02);assert.equal(ledger.accounted('tavily'),0.016);
  }finally{f.cleanup();}
});

test('insufficient budget rejects before inference; timeout retains reservation and no artifacts',async()=>{
  const f=setup();const model=new FakeModel(async()=>new Promise(()=>{}));
  const service=new ExecutionService(f.store,{model,limits:{nebius:0.001},includeSetupUsage:false});
  try{
    const run=service.startRun(f.project.id,'a',{request:'No budget',useSearch:false});
    await until(()=>f.store.getRun(run.id).status==='failed');assert.equal(model.requests.length,0);
    await service.shutdown();
    const timeoutService=new ExecutionService(f.store,{model,timeoutMs:20,includeSetupUsage:false});
    const timed=timeoutService.startRun(f.project.id,'b',{request:'Time out',useSearch:false});
    await until(()=>f.store.getRun(timed.id).status==='failed');
    assert.equal(f.store.listUsage().find(u=>u.runId===timed.id)?.status,'uncertain');
    assert.equal(f.store.getRun(timed.id).artifactIds.length,0);
    await timeoutService.shutdown();
  }finally{await service.shutdown();f.cleanup();}
});

test('model contract validates catalog capability and preserves usage; external runtime reports honest unsupported traces',async()=>{
  const original=globalThis.fetch;const requests:any[]=[];
  let price:unknown='0.0000001';
  globalThis.fetch=async(input,init)=>{
    requests.push({url:String(input),body:init?.body});
    return new Response(JSON.stringify(String(input).includes('/models') ? {data:[{id:'fixture',context_length:100000,pricing:{prompt:price,completion:'0.0000003',request:'0'},supported_features:['structured_outputs'],quantization:'fp8'}]} : {model:'fixture',id:'request-id',choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:5}}),{status:200});
  };
  try{
    const model=new NebiusAdapter('server-only-fixture-secret','fixture');const signal=new AbortController().signal;
    const prepared=await model.prepare(signal);assert.equal(prepared.capabilities.structuredOutput,true);
    const result=await model.complete({messages:[{role:'user',content:'Test'}],maxOutputTokens:64,schema:{type:'object'}},signal);
    assert.deepEqual(result.usage,{inputTokens:20,outputTokens:5});assert.equal(result.modelVersion,null);
    assert.equal(JSON.parse(requests[1].body).max_tokens,64);
    assert.doesNotMatch(JSON.stringify({prepared,result,requests}),/server-only-fixture-secret/);
    price=null;await assert.rejects(model.prepare(signal),/price unavailable/);
    const runtime=new DeferredAgentRuntime('codex');assert.equal(runtime.capabilities.available,false);assert.equal(runtime.capabilities.toolTrace,false);
    const events=[];for await(const event of runtime.run({request:'Test',materials:[]},signal))events.push(event);
    assert.equal(events[0].type,'error');assert.match((events[0] as any).message,/deferred/);
  }finally{globalThis.fetch=original;}
});


test('evidence support belongs to individual sentences and exact selected excerpts',()=>{
  const artifact={id:'artifact',projectId:'p',nodeId:'n',runId:'r',kind:'source' as const,title:'Source',content:'Long source with chosen phrase plus other text.',hash:'hash',createdAt:'now',capture:'search-snippet' as const,sourceId:'S1'};
  const spans=evidenceSpans('Uncited first sentence. Cited second sentence. [S1] Uncited third sentence. Selected input claim [I1].',[artifact],[{artifact,excerpt:'chosen phrase'}]);
  assert.deepEqual(spans.map(s=>s.supported),[false,true,false,true]);
  assert.equal(spans[1].text,'Cited second sentence. [S1]');
  assert.equal(spans[3].evidence[0].excerpt,'chosen phrase');
});
