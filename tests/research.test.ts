import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/server/store.js';
import {ExecutionService} from '../src/server/execution.js';
import {ExperimentService} from '../src/server/experiments.js';
import {ResearchService} from '../src/server/research.js';
import {LocalConnections} from '../src/server/connections.js';
import {DockerPythonBackend} from '../src/server/sandbox.js';
import type {ModelAdapter,ModelRequest} from '../src/server/providers.js';
import type {ApprovalMode} from '../src/shared/research.js';

const backend=new DockerPythonBackend();
const plan=(code='metric("Mean", df["value"].mean())\ntable("Summary", df.describe().reset_index())\nfig, ax = plt.subplots()\nax.plot(df["value"])\nplot("Values", fig)')=>({type:'experiment',summary:'Measure the fixture values using the selected CSV.',hypothesis:'The fixture mean is measurable.',code,parameters:{}});
const conclusion={type:'conclusion',summary:'The actual saved metric reports a mean of 5. This fixture is not live model verification.',suggestions:['Compare groups in a user-directed follow-up.']};
async function until(fn:()=>boolean,ms=15000){const start=Date.now();while(Date.now()-start<ms){if(fn())return;await delay(30);}throw new Error('Research fixture timed out.');}
function fixture(answers:unknown[],mode:ApprovalMode='full'){
  const dir=mkdtempSync(join(tmpdir(),'ros-research-fixture-')),store=new Store(dir),project=store.createProject('Labelled model contract fixture');
  store.mutate(project.id,[{type:'addNode',node:{id:'a',title:'Measure values',description:'A fixture only',kind:'activity',x:0,y:0}},{type:'addNode',node:{id:'b',title:'Unrelated',description:'Private neighbor',kind:'topic',x:312,y:0}}],'Fixture');
  const path=join(dir,'data.csv');writeFileSync(path,'value,group\n2,A\n4,A\n6,B\n8,B\n');
  const connections=new LocalConnections(store),connection=connections.add(project.id,{name:'Fixture input',kind:'csv',path}),dataset=connections.import(project.id,connection.id,'a');
  const requests:ModelRequest[]=[];
  const model:ModelAdapter={provider:'nebius',model:'explicit-fixture-model',configured:true,prepare:async()=>({id:'explicit-fixture-model',contextTokens:100000,inputUsdPerToken:0.0000001,outputUsdPerToken:0.0000003,capabilities:{structuredOutput:false,toolCalling:false,cancellation:'abort-request',modelVersion:false},metadata:{fixture:true}}),complete:async request=>{requests.push(structuredClone(request));const answer=answers.shift();if(answer===undefined)throw new Error('Fixture exhausted; never call a live provider.');return {content:JSON.stringify(answer),model:'explicit-fixture-model',modelVersion:null,usage:{inputTokens:100,outputTokens:100},metadata:{fixture:true}};}};
  const execution=new ExecutionService(store,{model}),experiments=new ExperimentService(store,{sandbox:backend});
  experiments.authority.configure(project.id,{mode});
  const research=new ResearchService(store,execution,experiments);
  return {dir,store,project,dataset,requests,execution,experiments,research,async cleanup(){await research.shutdown();await execution.shutdown();await experiments.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('fixture model writes Python, actual sandbox runs it, model inspects captured evidence, and a follow-up preserves history',async()=>{
  assert.equal(backend.capabilities().available,true,'This check requires the built local Docker runtime.');
  const f=fixture([plan(),conclusion,plan('metric("Scaled mean", df["value"].mean()*2)'),{...conclusion,summary:'Scaled mean is 10 from the follow-up output.'}]);
  try{
    f.store.addMessage(f.project.id,null,'user','PRIVATE_PROJECT_CHAT');f.store.addMessage(f.project.id,'b','user','PRIVATE_NEIGHBOR_CHAT');
    const session=f.research.start(f.project.id,{nodeId:'a',question:'Measure selected fixture values',datasetArtifactId:f.dataset.id,maxSteps:4});
    await until(()=>['completed','failed'].includes(f.research.get(session.id).status));assert.equal(f.research.get(session.id).status,'completed',f.research.get(session.id).error);
    const first=f.research.get(session.id);assert.equal(first.runIds.length,3);const local=f.store.getRun(first.runIds[1]);assert.equal(local.status,'completed',local.error);
    assert.equal(local.configuration.backend,'docker-python');assert.equal((local.configuration.originPlan as {runId:string}).runId,first.runIds[0]);
    assert.match(JSON.stringify(f.requests[1]),/Mean|5|Actual latest experiment outputs/);assert.doesNotMatch(JSON.stringify(f.requests),/PRIVATE_PROJECT_CHAT|PRIVATE_NEIGHBOR_CHAT/);
    const hash=f.store.getArtifact(local.artifactIds.find(id=>f.store.getArtifact(id).kind==='code')!).hash;
    const second=f.research.continue(first.id,'Scale the same selected values by two');await until(()=>['completed','failed'].includes(f.research.get(second.id).status));
    assert.equal(f.research.get(second.id).status,'completed',f.research.get(second.id).error);assert.equal(f.research.get(second.id).parentSessionId,first.id);
    assert.equal(f.store.getArtifact(local.artifactIds.find(id=>f.store.getArtifact(id).kind==='code')!).hash,hash);assert.equal(f.experiments.authority.policy(f.project.id).used.experiments,2);assert.equal(f.experiments.authority.policy(f.project.id).used.modelCalls,4);
    assert.ok(f.requests.every(r=>r.responseMode==='text-json'));assert.equal(f.store.listUsage().length,4);
  }finally{await f.cleanup();}
});

test('fixture model inspects a real traceback and repairs within the same cumulative grant',async()=>{
  const f=fixture([plan('metric("Mean", df["missing"].mean())'),plan(),conclusion]);
  try{const s=f.research.start(f.project.id,{nodeId:'a',question:'Measure fixture values',datasetArtifactId:f.dataset.id,maxSteps:4});await until(()=>['completed','failed'].includes(f.research.get(s.id).status));assert.equal(f.research.get(s.id).status,'completed',f.research.get(s.id).error);const locals=f.research.get(s.id).runIds.map(id=>f.store.getRun(id)).filter(r=>r.provider==='local');assert.deepEqual(locals.map(r=>r.status),['failed','completed']);assert.match(JSON.stringify(f.requests[1]),/KeyError|missing/);assert.equal(f.experiments.authority.policy(f.project.id).used.experiments,2);assert.ok(locals[0].artifactIds.some(id=>f.store.getArtifact(id).kind==='log'));}finally{await f.cleanup();}
});

test('Ask pauses exact experiments; denial and stop never trigger a repair or extra provider call',async()=>{
  const f=fixture([plan(),conclusion],'ask');
  try{const s=f.research.start(f.project.id,{nodeId:'a',question:'Measure fixture values',datasetArtifactId:f.dataset.id});await until(()=>f.research.get(s.id).status==='waiting');const waiting=f.research.get(s.id),preview=f.experiments.inspect(waiting.currentRunId!);assert.equal(preview.approval.status,'pending');assert.equal(f.experiments.authority.policy(f.project.id).used.experiments,0);f.experiments.decide(preview.run.id,preview.approval.fingerprint,'deny');await until(()=>f.research.get(s.id).status==='interrupted');assert.equal(f.requests.length,1);f.research.stopProject(f.project.id);assert.throws(()=>f.research.continue(s.id),/Resume/);assert.equal(f.requests.length,1);}finally{await f.cleanup();}
});

test('Ask separately approves a related Action creation and its start, and new Actions inherit the project default',async()=>{
  const f=fixture([{type:'action',summary:'Compare fixture groups next.',title:'Compare groups',description:'Compare the selected values by group',relation:'Comparing fixture groups helps measure the fixture values.',request:'Measure fixture group differences'},plan(),conclusion],'ask');
  try{const s=f.research.start(f.project.id,{nodeId:'a',question:'Measure fixture values',datasetArtifactId:f.dataset.id});await until(()=>f.research.get(s.id).phase==='proposal');const pending=f.research.get(s.id);assert.equal(f.store.getProject(f.project.id).canvas.nodes.length,2);f.research.acceptProposal(f.project.id,pending.pendingProposalId!);const created=f.research.get(s.id);assert.equal(created.status,'waiting');assert.equal(created.phase,'plan');assert.equal(f.requests.length,1);assert.equal(f.experiments.authority.mode(f.project.id,created.nodeId),'ask');f.research.continue(s.id);await until(()=>f.research.get(s.id).phase==='experiment');const preview=f.experiments.inspect(f.research.get(s.id).currentRunId!);assert.equal(preview.approval.status,'pending');f.experiments.decide(preview.run.id,preview.approval.fingerprint,'allow');await until(()=>f.research.get(s.id).status==='completed');assert.equal(f.experiments.authority.policy(f.project.id).used.createdActions,1);assert.equal(f.experiments.authority.policy(f.project.id).used.experiments,1);}finally{await f.cleanup();}
});

test('automatic reviewer escalates unfamiliar code instead of treating model requests as permission',async()=>{
  const f=fixture([plan('import os\nmetric("Files", len(os.listdir("/")))')],'review');
  try{const s=f.research.start(f.project.id,{nodeId:'a',question:'Measure fixture values',datasetArtifactId:f.dataset.id});await until(()=>f.research.get(s.id).status==='waiting');const run=f.store.getRun(f.research.get(s.id).currentRunId!);assert.equal((run.configuration.approval as {status:string}).status,'pending');assert.equal(run.events.some(e=>e.type==='process-start'),false);assert.equal(f.experiments.authority.policy(f.project.id).used.experiments,0);assert.match(JSON.stringify(run.events),/unfamiliar import/i);}finally{await f.cleanup();}
});
