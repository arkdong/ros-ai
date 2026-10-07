import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/server/store.js';
import {ExperimentService} from '../src/server/experiments.js';
import {SandboxBudget, type SandboxBudgetOptions} from '../src/server/sandbox-budget.js';
import type {ExecutionBackend, RemoteExecutionState, SandboxCapabilities, SandboxInput, SandboxResult} from '../src/server/sandbox.js';

const terms:SandboxBudgetOptions={authorizationId:'offline-contract-only',maxRuns:2,maxUsd:2,maxCostPerRunUsd:1,pricingBasis:'Test fixture only: a hypothetical verified $1 total ceiling. Not a Nebius rate.'};
const caps:SandboxCapabilities={available:true,backend:'nebius-sandbox',policy:'remote-fixture',runtime:'fixture Python',workerHash:'worker-1',imageId:'image-1',libraries:{},enforcement:['fixture'],limitations:['Not a live sandbox'],timeoutMs:30000,maxMemoryMb:null,maxOutputBytes:1000000};
const terminal:RemoteExecutionState={phase:'terminal',operationId:'operation-fixture',status:'SUCCESS',rawCost:14,costUnit:'unknown'};
function backend(){
  const inputs:SandboxInput[]=[];
  const value:ExecutionBackend={capabilities:()=>({...caps}),start(input){inputs.push(input);input.onProgress?.({phase:'submitting'});input.onProgress?.({phase:'submitted',operationId:'operation-fixture'});return {cancel(){},done:Promise.resolve({status:'completed',outputs:[{kind:'metric',title:'Mean',content:'{"value":3}',mediaType:'application/json'}],stdout:'done',stderr:'',exitCode:0,signal:null,runtime:'fixture Python',startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),enforcement:['fixture'],remote:terminal} satisfies SandboxResult)};}};
  return {value,inputs};
}
function fixture(budget:SandboxBudgetOptions={}){
  const dir=mkdtempSync(join(tmpdir(),'ros-remote-test-')),store=new Store(dir),remote=backend();
  const project=store.createProject('Remote contract fixture');
  store.mutate(project.id,['a','b'].map(id=>({type:'addNode' as const,node:{id,title:id,description:'',x:0,y:0}})),'fixture');
  const grant=new SandboxBudget(store,budget),service=new ExperimentService(store,{sandbox:remote.value,nebiusSandbox:remote.value,sandboxBudget:grant});
  service.authority.configure(project.id, { mode: 'ask' });
  return {dir,store,project,remote,grant,service,async cleanup(){await service.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const preview=(f:ReturnType<typeof fixture>,nodeId='a')=>f.service.preview(f.project.id,{nodeId,request:'Offline remote fixture',backend:'nebius-sandbox',csv:'value\n2\n4\n',code:'metric("Mean", 3)'});
async function finished(store:Store,id:string){for(let n=0;n<100;n++){const run=store.getRun(id);if(!['queued','running'].includes(run.status))return run;await delay(5);}throw new Error('Fixture timeout');}

test('remote preview is inert and missing pricing fails before grant, project counters or transport',async()=>{
  const f=fixture();try{
    const p=preview(f);assert.equal(p.approval.status,'pending');assert.equal(p.run.provider,'nebius-sandbox');assert.equal(f.remote.inputs.length,0);
    assert.equal(f.service.capabilities().nebiusSandbox?.costGate?.ready,false);
    assert.throws(()=>f.service.decide(p.run.id,p.approval.fingerprint,'allow'),/verified worst-case/);
    assert.equal(f.remote.inputs.length,0);assert.equal(f.service.authority.policy(f.project.id).used.experiments,0);
    assert.equal(f.service.inspect(p.run.id).approval.status,'pending');
  }finally{await f.cleanup();}
});

test('approved remote capture persists exact inputs, operation, results and separate cumulative admission',async()=>{
  const f=fixture(terms);try{
    const p=preview(f);f.service.decide(p.run.id,p.approval.fingerprint,'allow');const run=await finished(f.store,p.run.id);
    assert.equal(run.status,'completed');assert.equal(f.remote.inputs[0].csv,p.csv);assert.equal(f.remote.inputs[0].code,p.code);
    assert.deepEqual(run.configuration.remote,terminal);assert.ok(run.events.some(e=>e.type==='remote-submitting'));
    assert.equal((run.cost as {reservedUsd:number}).reservedUsd,1);assert.equal((run.cost as {estimatedUsd:null}).estimatedUsd,null);
    assert.equal(f.store.listUsage().length,0,'sandbox does not consume the inference grant');
    assert.equal(f.service.authority.policy(f.project.id).used.spendUsd,1);
    const artifacts=run.artifactIds.map(id=>f.store.getArtifact(id));assert.equal(artifacts.find(a=>a.title==='Mean')?.content,'{"value":3}');
    assert.equal(JSON.parse(artifacts.find(a=>a.kind==='log')!.content).remote.costUnit,'unknown');
    const retry=f.service.retry(run.id);assert.equal(retry.run.configuration.backend,'nebius-sandbox');assert.equal(retry.approval.status,'pending');
    f.service.decide(retry.run.id,retry.approval.fingerprint,'allow');await finished(f.store,retry.run.id);
    const third=preview(f,'b');assert.throws(()=>f.service.decide(third.run.id,third.approval.fingerprint,'allow'),/exhausted/);assert.equal(f.remote.inputs.length,2);
  }finally{await f.cleanup();}
});

test('remote always asks under Full access and cannot enter local group; project denial rolls back remote admission',async()=>{
  const f=fixture(terms);try{
    f.service.authority.configure(f.project.id, { mode: 'full' });
    const attempt=preview(f);assert.equal(attempt.approval.status,'pending');assert.equal(f.remote.inputs.length,0);
    assert.throws(()=>f.service.startAuto(f.project.id,{scope:'fixture',outcome:'fixture',runIds:[attempt.run.id],fingerprints:{[attempt.run.id]:attempt.approval.fingerprint}}),/individual approval/);
    assert.throws(()=>f.service.decide(attempt.run.id,attempt.approval.fingerprint,'allow'),/spendUsd/);
    assert.equal(f.grant.status().remainingRuns,2);assert.equal(f.service.authority.policy(f.project.id).used.experiments,0);
  }finally{await f.cleanup();}
});

test('remote restart reconciles a known operation without resubmission and keeps unknown submission uncertain',async()=>{
  const f=fixture(terms),known=preview(f),unknown=preview(f,'b');
  f.grant.reserve(known.run.id,f.project.id);f.grant.reserve(unknown.run.id,f.project.id);
  f.store.updateRun(known.run.id,{status:'running',configuration:{...known.run.configuration,remote:{phase:'submitted',operationId:'existing-operation'},approval:{...known.approval,status:'allowed'}}});
  f.store.updateRun(unknown.run.id,{status:'running',configuration:{...unknown.run.configuration,remote:{phase:'submitting'},approval:{...unknown.approval,status:'allowed'}}});
  // Simulate process death: no service shutdown, persisted records are the only authority.
  f.store.close();const store=new Store(f.dir),remote=backend(),reconciled:string[]=[];
  const service=new ExperimentService(store,{sandbox:remote.value,nebiusSandbox:{...remote.value,async reconcile(id){reconciled.push(id);return {phase:'terminal',operationId:id,status:'CANCELLED',cancellationConfirmed:true};}},sandboxBudget:new SandboxBudget(store,terms)});
  try{
    await delay(10);assert.deepEqual(reconciled,['existing-operation']);assert.equal(remote.inputs.length,0);
    assert.equal(store.getRun(known.run.id).status,'interrupted');assert.equal(service.inspect(known.run.id).remoteRecovery?.cancellationConfirmed,true);
    assert.equal(service.inspect(unknown.run.id).remoteRecovery?.phase,'uncertain');
    assert.equal(new SandboxBudget(store,terms).status().remainingRuns,0);
  }finally{await service.shutdown();store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('approval storage failure rolls back both admissions before any remote submission',async()=>{
  const f=fixture(terms);try{
    const p=preview(f),original=f.store.updateRun.bind(f.store);
    f.store.updateRun=(id,patch)=>{
      if((patch.configuration?.approval as {status?:string}|undefined)?.status==='allowed')throw new Error('Injected approval storage failure');
      return original(id,patch);
    };
    assert.throws(()=>f.service.decide(p.run.id,p.approval.fingerprint,'allow'),/storage failure/);
    f.store.updateRun=original;
    assert.equal(f.service.inspect(p.run.id).approval.status,'pending');assert.equal(f.grant.status().remainingRuns,2);
    assert.equal(f.service.authority.policy(f.project.id).used.experiments,0);assert.equal(f.remote.inputs.length,0);
    f.service.decide(p.run.id,p.approval.fingerprint,'allow');assert.equal((await finished(f.store,p.run.id)).status,'completed');
  }finally{await f.cleanup();}
});

test('sandbox allowance never treats an omitted price as zero, and persists across projects and changed settings',async()=>{
  const f=fixture();try{
    assert.equal(new SandboxBudget(f.store,{...terms,maxCostPerRunUsd:undefined}).status().ready,false);
    const free=new SandboxBudget(f.store,{...terms,authorizationId:'fixture-free-terms',maxUsd:0,maxCostPerRunUsd:0,pricingBasis:'Offline test: hypothetical documented free allowance'});assert.equal(free.status().ready,true);
    free.reserve('test-free',f.project.id);assert.equal(free.status().remainingRuns,1);free.reserve('test-free',f.project.id);assert.equal(free.status().remainingRuns,1);
    const other=f.store.createProject('Other project');const paid=new SandboxBudget(f.store,terms);paid.reserve('first',f.project.id);paid.reserve('second',other.id);
    assert.equal(new SandboxBudget(f.store,terms).status().ready,false);
    assert.equal(new SandboxBudget(f.store,{...terms,maxRuns:10}).status().ready,false);
    assert.match(new SandboxBudget(f.store,{...terms,maxRuns:10}).status().reason,/different limits/);
  }finally{await f.cleanup();}
});
