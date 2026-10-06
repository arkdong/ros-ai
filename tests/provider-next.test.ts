import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { ExperimentService } from '../src/server/experiments.js';
import { createApp, apiErrorHandler } from '../src/server/app.js';
import { BudgetLedger, ExecutionService } from '../src/server/execution.js';
import { DEFAULT_MODEL, NebiusAdapter, type ModelAdapter, type ModelInfo, type ModelRequest } from '../src/server/providers.js';

function fixture() {
  const path=mkdtempSync(join(tmpdir(),'ros-next-provider-')),store=new Store(path),project=store.createProject('Isolated provider fixture');
  store.mutate(project.id,[{type:'addNode',node:{id:'a',title:'Dataset analysis',description:'One independent activity',kind:'activity',x:0,y:0}}],'Fixture');
  new Authority(store).configure(project.id, { mode: 'ask' });
  return {path,store,project,close:()=>{try{store.close();}catch{}rmSync(path,{recursive:true,force:true});}};
}
async function terminal(store:Store,id:string) { for(let i=0;i<200;i++) {const run=store.getRun(id);if(!['queued','running'].includes(run.status))return run;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Fixture timed out'); }
const catalog = {data:[{id:DEFAULT_MODEL,context_length:1048576,pricing:{prompt:'0.000001',completion:'0.000003',request:'0'},supported_features:['tools','reasoning'],quantization:'fp4'}]};

test('offline Ultra text-JSON contract sends a schema prompt without native tools or response_format', async () => {
  const previousFetch = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  const schema = { type: 'object', properties: { type: { const: 'experiment' }, code: { type: 'string' } }, required: ['type', 'code'], additionalProperties: false };
  const object = { type: 'experiment', code: 'metric("Mean", df["value"].mean())' };
  let features: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.tokenfactory.us-central1.nebius.com');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer offline-text-json-fixture');
    if (url.pathname === '/v1/models') return new Response(JSON.stringify({ data: [{ ...catalog.data[0], supported_features: features }] }));
    assert.equal(url.pathname, '/v1/chat/completions', 'The offline stub never delegates to real fetch.');
    assert.equal(init?.method, 'POST');
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: 'offline-json-response', model: DEFAULT_MODEL, choices: [{ message: { content: JSON.stringify(object) }, finish_reason: 'stop' }], usage: { prompt_tokens: 18, completion_tokens: 41 } }));
  };
  try {
    const messages = [{ role: 'system' as const, content: 'Scoped research instructions.' }, { role: 'user' as const, content: 'Plan this captured dataset.' }];
    const request: ModelRequest = { messages, schema, responseMode: 'text-json', responseName: 'research_step', maxOutputTokens: 321 };
    const original = structuredClone(request);
    // This transport deliberately does not depend on either advertised native feature.
    for (features of [[], ['tools', 'reasoning'], ['structured_outputs', 'tools']]) {
      const model = new NebiusAdapter('offline-text-json-fixture', DEFAULT_MODEL), signal = new AbortController().signal;
      await model.prepare(signal);
      const response = await model.complete(request, signal);
      const wire = sent.at(-1)!;
      assert.deepEqual(Object.keys(wire).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
      assert.equal(wire.tools, undefined); assert.equal(wire.tool_choice, undefined); assert.equal(wire.response_format, undefined);
      assert.equal(wire.model, DEFAULT_MODEL); assert.equal(wire.max_tokens, 321);
      const wireMessages = wire.messages as { role: string; content: string }[];
      assert.equal(wireMessages[0].role, 'system');
      assert.match(wireMessages[0].content, /Return one JSON object/);
      assert.match(wireMessages[0].content, /proposal only, never execution or permission/);
      assert.ok(wireMessages[0].content.includes(JSON.stringify(schema)), 'The complete response schema must be model-visible.');
      assert.deepEqual(wireMessages.slice(1), messages);
      assert.deepEqual(JSON.parse(response.content), object);
      assert.equal(response.metadata.responseContract, 'application-validated-json');
      assert.deepEqual(response.metadata.wireRequest, wire);
      assert.deepEqual(response.usage, { inputTokens: 18, outputTokens: 41 });
      assert.doesNotMatch(JSON.stringify({ request, response, wire }), /offline-text-json-fixture/);
    }
    assert.equal(sent.length, 3, 'Exactly one mocked completion per explicit request, with no retries.');
    assert.deepEqual(request, original, 'Adding the contract prompt must not mutate captured caller inputs.');
  } finally { globalThis.fetch = previousFetch; }
});

test('offline text-JSON responses reject invalid JSON, arrays, scalars and unsolicited tools without retry', async () => {
  const previousFetch = globalThis.fetch;
  let content = '{}', toolCalls: unknown[] | undefined;
  let completions = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/models') return new Response(JSON.stringify(catalog));
    assert.equal(path, '/v1/chat/completions', 'Unexpected requests fail inside the offline fixture.');
    assert.equal(init?.method, 'POST');
    completions++;
    return new Response(JSON.stringify({ model: DEFAULT_MODEL, choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] }));
  };
  try {
    const model = new NebiusAdapter('offline-rejection-fixture', DEFAULT_MODEL), signal = new AbortController().signal;
    await model.prepare(signal);
    const request: ModelRequest = { messages: [{ role: 'user', content: 'Return a proposed research step.' }], schema: { type: 'object' }, responseMode: 'text-json', responseName: 'research_step', maxOutputTokens: 300 };
    for (content of ['not JSON', '{"type": invalid}', '{"type":"conclusion"} trailing prose', '[]', '[{"type":"conclusion"}]', 'null', 'true', '42', '"a string"']) {
      const before = completions;
      await assert.rejects(model.complete(request, signal), /did not return a JSON object.*No action was executed/);
      assert.equal(completions, before + 1, 'Malformed responses must not cause an automatic retry.');
    }
    content = '{"type":"conclusion","summary":"A fixture only."}';
    toolCalls = [{ id: 'unsolicited-fixture', type: 'function', function: { name: 'research_step', arguments: content } }];
    await assert.rejects(model.complete(request, signal), /unsolicited tool requests; nothing was executed/);
    toolCalls = [{ id: 'unsafe-fixture', type: 'function', function: { name: 'shell', arguments: '{"command":"do not execute"}' } }];
    await assert.rejects(model.complete(request, signal), /unsolicited tool requests; nothing was executed/);
    toolCalls = [];
    assert.deepEqual(JSON.parse((await model.complete(request, signal)).content), { type: 'conclusion', summary: 'A fixture only.' });
    content = '```json\n{"type":"conclusion","summary":"A fenced fixture."}\n```';
    assert.deepEqual(JSON.parse((await model.complete(request, signal)).content), { type: 'conclusion', summary: 'A fenced fixture.' });
  } finally { globalThis.fetch = previousFetch; }
});

test('Ultra native function contract avoids unsupported structured output and rejects wrong/multiple requests',async()=>{
  const previousFetch=globalThis.fetch,oldModel=process.env.NEBIUS_MODEL;
  process.env.NEBIUS_MODEL='Qwen/historical-choice';
  const sent:any[]=[];let toolCalls:any[]=[{id:'fixture-call',type:'function',function:{name:'propose_local_experiment',arguments:JSON.stringify({explanation:'Fixture',code:'metric("N", 4)',parameters:{}})}}];
  globalThis.fetch=async(input,init)=>{if(String(input).includes('/models'))return new Response(JSON.stringify(catalog));sent.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({id:'fixture-response',model:DEFAULT_MODEL,choices:[{message:{content:null,tool_calls:toolCalls},finish_reason:'tool_calls'}],usage:{prompt_tokens:12,completion_tokens:30}}));};
  try {
    const model=new NebiusAdapter('fixture-secret');assert.equal(model.model,DEFAULT_MODEL);
    const signal=new AbortController().signal,info=await model.prepare(signal);
    assert.equal(info.capabilities.structuredOutput,false);assert.equal(info.capabilities.toolCalling,true);
    const request={messages:[{role:'user' as const,content:'Plan fixture'}],maxOutputTokens:2000,schema:{type:'object'},responseName:'propose_local_experiment'};
    const response=await model.complete(request,signal);
    assert.equal(sent[0].response_format,undefined);assert.equal(sent[0].tool_choice.function.name,'propose_local_experiment');
    assert.equal(sent[0].reasoning_effort,undefined);assert.equal(response.metadata.responseContract,'function-call');
    assert.doesNotMatch(JSON.stringify({info,response,sent}),/fixture-secret|Qwen/);
    toolCalls=[{id:'unsafe',type:'function',function:{name:'shell',arguments:'{}'}}];await assert.rejects(model.complete(request,signal),/unexpected tool request/);
    toolCalls=[{id:'1',type:'function',function:{name:'propose_local_experiment',arguments:'{}'}},{id:'2',type:'function',function:{name:'propose_local_experiment',arguments:'{}'}}];await assert.rejects(model.complete(request,signal),/unexpected tool request/);
    toolCalls=[{id:'1',type:'function',function:{name:'propose_local_experiment',arguments:'invalid'}}];await assert.rejects(model.complete(request,signal),/invalid tool arguments/);
  } finally {globalThis.fetch=previousFetch;if(oldModel===undefined)delete process.env.NEBIUS_MODEL;else process.env.NEBIUS_MODEL=oldModel;}
});

test('new cloud work fails closed without fresh authorization and local chat proposes only one independent accepted step',async()=>{
  const f=fixture(),previousFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('Must not fetch');};
  const service=new ExecutionService(f.store,{model:new NebiusAdapter('fixture-key'),includeSetupUsage:false});
  try {
    assert.throws(()=>service.startRun(f.project.id,'a',{request:'Cloud research',useSearch:false}),/fresh explicit Nebius/);
    const first=await service.chat(f.project.id,'Finance');assert.equal(first.proposal,undefined);assert.match(first.message.content,/What would you like/);
    await service.chat(f.project.id,'I want to compare approaches using a small dataset and produce a tested result.');
    const second=await service.chat(f.project.id,'Add an Activity for comparing the measurements');
    assert.match(second.message.content,/fixed rules, no model inference/);assert.doesNotMatch(second.message.content,/What would you like/);
    assert.equal(second.proposal?.operations.length,1);assert.equal(f.store.getProject(f.project.id).canvas.nodes.length,1);
    f.store.acceptProposal(f.project.id,second.proposal!.id);
    assert.equal(f.store.getProject(f.project.id).canvas.nodes.length,2);assert.equal(f.store.getProject(f.project.id).canvas.connections.length,0);
    assert.equal(f.store.listRuns(f.project.id).length,0);assert.equal(f.store.listUsage().length,0);assert.equal(calls,0);
  } finally {await service.shutdown();globalThis.fetch=previousFetch;f.close();}
});

test('fresh authorization has separate durable accounting and request cap; historical records remain intact',()=>{
  const f=fixture();
  try {
    const historical=new BudgetLedger(f.store,{nebius:5,tavily:10});const prior=historical.reserve('nebius',0.3,'Historical fixture','Historical authorization');
    const fresh=new BudgetLedger(f.store,{nebius:5,tavily:0},'explicit-next-build-fixture',2);
    fresh.reserve('nebius',2.105552,'Plan','Full-context reserve');fresh.reserve('nebius',2.105552,'Interpret','Full-context reserve');
    assert.throws(()=>fresh.reserve('nebius',0.01,'Third','No'),/request limit/);
    assert.throws(()=>fresh.reserve('tavily',0.008,'Search','No'),/request limit|budget/);
    assert.equal(fresh.accounted('nebius'),4.211104);assert.equal(f.store.listUsage().find(u=>u.id===prior.id)?.reservedUsd,0.3);
    f.store.close();const reopened=new Store(f.path);
    try {const resumed=new BudgetLedger(reopened,{nebius:5,tavily:0},'explicit-next-build-fixture',2);assert.throws(()=>resumed.reserve('nebius',0.001,'Restart','No reset'),/request limit/);assert.equal(reopened.listUsage().length,3);}finally{reopened.close();}
  } finally {f.close();}
});

test('model experiment proposal captures exact selected dataset and node context without executing or changing graph',async()=>{
  const f=fixture(),requests:ModelRequest[]=[];
  const info:ModelInfo={id:'offline-fixture',contextTokens:100000,inputUsdPerToken:0.0000001,outputUsdPerToken:0.0000003,capabilities:{structuredOutput:false,toolCalling:true,cancellation:'abort-request',modelVersion:false},metadata:{fixture:true}};
  const model:ModelAdapter={provider:'nebius',model:info.id,configured:true,prepare:async()=>info,complete:async request=>{requests.push(request);return {model:info.id,modelVersion:null,usage:{inputTokens:20,outputTokens:50},metadata:{fixture:true},content:JSON.stringify({explanation:'Fixture plan only',code:'values = column("value")\nmetric("Mean", mean(values))\nplot("Values", values)',parameters:{}})};}};
  const service=new ExecutionService(f.store,{model,includeSetupUsage:false});
  try {
    const local=new ExperimentService(f.store);
    const preview=local.preview(f.project.id,{nodeId:'a',request:'Inspect supplied fixture',csv:'value\n10\n20\n30\n40\n'});
    local.decide(preview.run.id,preview.approval.fingerprint,'cancel');
    const dataset=f.store.detail(f.project.id).artifacts.find(a=>a.kind==='dataset')!;
    await local.shutdown();
    f.store.addMessage(f.project.id,null,'user','PRIVATE_PROJECT_CONTEXT');
    const revision=f.store.getProject(f.project.id).revision;
    const started=service.startExperimentPlan(f.project.id,'a',{request:'Compute mean and plot values',datasetArtifactId:dataset.id});
    const run=await terminal(f.store,started.id);
    assert.equal(run.status,'completed');assert.equal(run.inputs[0].artifact.hash,dataset.hash);assert.equal(run.inputs[0].excerpt,dataset.content);
    assert.equal(run.configuration.backend,'bounded');assert.match(requests[0].messages[0].content,/Exposed APIs: column\(name\)/);
    assert.match(requests[0].messages[0].content,/value\n10\n20\n30\n40/);assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_PROJECT_CONTEXT/);
    assert.equal(requests[0].responseName,'propose_local_experiment');assert.equal((run.configuration.experimentPlan as any).parameters.constructor,Object);
    assert.equal((run.tools[0] as any).decision,'preview-required');assert.equal(f.store.getProject(f.project.id).revision,revision);
    assert.equal(f.store.detail(f.project.id).artifacts.filter(a=>a.kind==='plot'||a.kind==='metric').length,0);
    assert.equal(f.store.listRuns(f.project.id).length,2);
  } finally {await service.shutdown();f.close();}
});

test('Docker experiment planning HTTP request captures the selected runtime and rich Python contract without executing',async()=>{
  const f=fixture(),requests:ModelRequest[]=[];
  const info:ModelInfo={id:'offline-docker-plan',contextTokens:100000,inputUsdPerToken:0.0000001,outputUsdPerToken:0.0000003,capabilities:{structuredOutput:false,toolCalling:true,cancellation:'abort-request',modelVersion:false},metadata:{fixture:true}};
  const code='metric("Mean", df["value"].mean())\ntable("Summary", df.describe().reset_index())\nfig, ax = plt.subplots()\nax.plot(df["value"])\nplot("Values", fig)';
  const model:ModelAdapter={provider:'nebius',model:info.id,configured:true,prepare:async()=>info,complete:async request=>{
    requests.push(request);
    return {model:info.id,modelVersion:null,usage:{inputTokens:20,outputTokens:50},metadata:{fixture:true},content:JSON.stringify({explanation:'Docker fixture plan only',code,parameters:{}})};
  }};
  const service=new ExecutionService(f.store,{model,includeSetupUsage:false}),local=new ExperimentService(f.store);
  const app=createApp(f.store,service,local);app.use(apiErrorHandler);
  const server=app.listen(0,'127.0.0.1');
  try {
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();assert(address&&typeof address==='object');
    const preview=local.preview(f.project.id,{nodeId:'a',request:'Capture fixture dataset',csv:'value\n10\n20\n30\n40\n'});
    local.decide(preview.run.id,preview.approval.fingerprint,'cancel');
    const dataset=f.store.detail(f.project.id).artifacts.find(artifact=>artifact.kind==='dataset')!;
    const url=`http://127.0.0.1:${address.port}/api/projects/${f.project.id}/nodes/a/experiment-plan`;
    const body={request:'Compute mean and plot values',datasetArtifactId:dataset.id,backend:'docker-python'};
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,201);
    const started=await response.json(),run=await terminal(f.store,started.id);
    assert.equal(run.status,'completed');assert.equal(run.configuration.backend,'docker-python');
    assert.equal(run.inputs[0].artifact.hash,dataset.hash);
    assert.equal(requests.length,1);assert.equal(requests[0].responseName,'propose_local_experiment');
    const prompt=requests[0].messages[0].content;
    assert.match(prompt,/isolated Docker research runtime \(docker-python\)/);
    assert.match(prompt,/Injected globals: df, params, pd, np, plt, scipy/);
    assert.match(prompt,/metric\(title,value\).*table\(title,DataFrame_or_Series_or_rows\).*plot\(title,figure\)/);
    assert.match(prompt,/export_csv\(title,DataFrame\).*conclusion\(text\)/);
    assert.doesNotMatch(prompt,/Code targets the local bounded Python expression runner|Exposed APIs: column\(name\)/);
    assert.equal((run.configuration.experimentPlan as {code:string}).code,code);
    assert.equal(f.store.detail(f.project.id).artifacts.filter(artifact=>artifact.kind==='plot'||artifact.kind==='metric').length,0);
    const invalid=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,backend:'unsupported-runtime'})});
    assert.equal(invalid.status,400);assert.equal(requests.length,1);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await local.shutdown();await service.shutdown();f.close();
  }
});

test('Nebius sandbox planning captures the standard-library contract and preserves it on an explicit retry',async()=>{
  const f=fixture(),requests:ModelRequest[]=[];
  const info:ModelInfo={id:'offline-remote-plan',contextTokens:100000,inputUsdPerToken:0.0000001,outputUsdPerToken:0.0000003,capabilities:{structuredOutput:false,toolCalling:true,cancellation:'abort-request',modelVersion:false},metadata:{fixture:true}};
  const code='import statistics\nvalues = [float(row["value"]) for row in rows]\nmetric("Mean", statistics.mean(values))\nplot("Values", values)';
  const model:ModelAdapter={provider:'nebius',model:info.id,configured:true,prepare:async()=>info,complete:async request=>{
    requests.push(request);
    if(requests.length===1) throw new Error('Offline first-attempt failure');
    return {model:info.id,modelVersion:null,usage:{inputTokens:20,outputTokens:50},metadata:{fixture:true},content:JSON.stringify({explanation:'Standard-library fixture plan',code,parameters:{}})};
  }};
  const service=new ExecutionService(f.store,{model,includeSetupUsage:false}),local=new ExperimentService(f.store);
  const app=createApp(f.store,service,local);app.use(apiErrorHandler);
  const server=app.listen(0,'127.0.0.1');
  try {
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();assert(address&&typeof address==='object');
    const preview=local.preview(f.project.id,{nodeId:'a',request:'Capture fixture dataset',csv:'value\n10\n20\n30\n40\n'});
    local.decide(preview.run.id,preview.approval.fingerprint,'cancel');
    const dataset=f.store.detail(f.project.id).artifacts.find(artifact=>artifact.kind==='dataset')!;
    const base=`http://127.0.0.1:${address.port}`;
    const response=await fetch(`${base}/api/projects/${f.project.id}/nodes/a/experiment-plan`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:'Compute a mean and plot',datasetArtifactId:dataset.id,backend:'nebius-sandbox'})});
    assert.equal(response.status,201);
    const started=await response.json(),failed=await terminal(f.store,started.id);
    assert.equal(failed.status,'failed');assert.equal(failed.configuration.backend,'nebius-sandbox');assert.equal(requests.length,1);
    const retry=await fetch(`${base}/api/runs/${failed.id}/retry`,{method:'POST'});
    assert.equal(retry.status,201);
    const retried=await retry.json(),run=await terminal(f.store,retried.id);
    assert.equal(run.status,'completed');assert.equal(run.configuration.backend,'nebius-sandbox');assert.equal(requests.length,2);
    for(const request of requests) {
      const prompt=request.messages[0].content;
      assert.match(prompt,/Python 3\.12 standard library in a remote Nebius Sandbox/);
      assert.match(prompt,/rows, a list of dictionaries.*string values/);
      assert.match(prompt,/pandas, NumPy, SciPy and Matplotlib are NOT installed/);
      assert.match(prompt,/plot\(title,numeric_values\[,labels\]\)/);
      assert.match(prompt,/separate explicit execution approval/);
      assert.doesNotMatch(prompt,/Injected globals: df|Exposed APIs: column\(name\)/);
    }
    assert.equal(run.inputs[0].artifact.hash,dataset.hash);
    assert.equal((run.configuration.experimentPlan as {code:string}).code,code);
    assert.equal(f.store.detail(f.project.id).artifacts.filter(artifact=>artifact.kind==='plot'||artifact.kind==='metric').length,0);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await local.shutdown();await service.shutdown();f.close();
  }
});

test('provider diagnostics are bounded and redact outgoing credentials without hiding HTTP and field',async()=>{
  const original=globalThis.fetch;
  const key='fixture-secret-that-must-not-be-retained';
  globalThis.fetch=async(input)=>String(input).includes('/models')?new Response(JSON.stringify(catalog)):new Response(JSON.stringify({error:{message:`Unsupported parameter for this model; key ${key}`,param:'reasoning_effort',code:'invalid_request_error'}}),{status:400});
  try {
    const model=new NebiusAdapter(key),signal=new AbortController().signal;await model.prepare(signal);
    await assert.rejects(model.complete({messages:[{role:'user',content:'Fixture'}],maxOutputTokens:64},signal),(error:Error)=>{
      assert.match(error.message,/HTTP 400|reasoning_effort/);assert.doesNotMatch(error.message,/fixture-secret/);assert.ok(error.message.length<500);return true;
    });
  } finally {globalThis.fetch=original;}
});
