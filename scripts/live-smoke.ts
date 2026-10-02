/** Explicit opt-in, bounded live integration verification. Never invoked by npm test. */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import type { Project, ProjectDetail, Proposal, Run, UsageRecord } from '../src/shared/types.js';
const base = 'http://127.0.0.1:4310';
const output = 'evidence/live-smoke.json';
if (!process.argv.includes('--allow-billable')) throw new Error('Live verification requires explicit --allow-billable and uses the persistent application budget ledger.');
if (existsSync(output)) throw new Error('Live evidence already exists. Inspect it; this script does not repeat paid calls automatically.');
async function api<T>(path:string,body?:unknown):Promise<T> {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json(); if(!response.ok) throw new Error(`${response.status}: ${data.error}`); return data;
}
async function finished(projectId:string,runId:string):Promise<Run> {
  const end=Date.now()+105000;
  while(Date.now()<end) {
    const detail=await api<ProjectDetail>(`/api/projects/${projectId}`);
    const run=detail.runs.find(run=>run.id===runId)!;
    if(!['running','queued'].includes(run.status)) { assert.equal(run.status,'completed',run.error); return run; }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Run did not finish within verification timeout. No retry was attempted.');
}
const evidence:Record<string,unknown>={startedAt:new Date().toISOString(),kind:'Real Nebius and Tavily integration; no mocks',checks:[]};
try {
  const before=await api<UsageRecord[]>('/api/usage');
  evidence.beforeUsage=before.map(({reportedUsage,...record})=>record);
  const urban=await api<Project>('/api/projects',{title:'City heat and shade'});
  evidence.urbanProjectId=urban.id;
  const reply=await api<{proposal?:Proposal}>(`/api/projects/${urban.id}/chat`,{message:'Please propose two independent research nodes for investigating how urban trees affect summer heat: "Shade evidence" and "Questions to test". Give them short useful descriptions and connect them with a relationship labelled "Informs". Do not run research.'});
  assert(reply.proposal,'Real model must return a valid structural proposal');
  const preview=await api<ProjectDetail>(`/api/projects/${urban.id}`);
  assert.equal(preview.project.revision,0);assert.equal(preview.project.canvas.nodes.length,0);assert.equal(preview.runs.length,0);
  await api(`/api/projects/${urban.id}/proposals/${reply.proposal.id}/accept`,{});
  const accepted=await api<ProjectDetail>(`/api/projects/${urban.id}`);
  assert.equal(accepted.project.canvas.nodes.length,2);assert.equal(accepted.project.canvas.connections.length,1);assert.equal(accepted.inputs.length,0);assert.equal(accepted.runs.length,0);
  const source=accepted.project.canvas.nodes.find(node=>/shade/i.test(node.title)) ?? accepted.project.canvas.nodes[0];
  const destination=accepted.project.canvas.nodes.find(node=>node.id!==source.id)!;
  console.log('Live proposal preview and atomic acceptance passed; starting one Tavily-assisted request.');
  const grounded=await api<Run>(`/api/projects/${urban.id}/runs`,{nodeId:source.id,useSearch:true,request:'urban trees shade cooling urban heat EPA evidence. Give two concise findings on how trees can reduce summer heat, cite each finding to the captured search snippets, and state one limitation.'});
  await finished(urban.id,grounded.id);
  const researched=await api<ProjectDetail>(`/api/projects/${urban.id}`);
  const result=researched.artifacts.find(artifact=>artifact.runId===grounded.id&&artifact.kind==='result')!;
  const sources=researched.artifacts.filter(artifact=>artifact.runId===grounded.id&&artifact.kind==='source');
  assert(sources.length>0);assert.match(result.content,/\[S\d+\]/);assert(sources.every(source=>source.content&&source.url&&source.capture==='search-snippet'));
  const selected=await api(`/api/projects/${urban.id}/inputs`,{nodeId:destination.id,artifactId:result.id});
  const reused=await api<Run>(`/api/projects/${urban.id}/runs`,{nodeId:destination.id,useSearch:false,request:'Using the explicitly selected prior result [I1], write three practical questions that a small neighborhood shade investigation could test. Separate what the input supports from suggestions. Keep this under 180 words.'});
  assert.equal(reused.inputs[0].artifactId,result.id);assert.equal(reused.inputs[0].artifact.hash,result.hash);
  const reusedDone=await finished(urban.id,reused.id);
  assert.equal(reusedDone.useSearch,false);assert(reusedDone.messages.some(message=>message.content.includes(result.content)));
  console.log('Live grounded result and explicit version reuse passed; checking a distinct model-only investigation.');
  const writing=await api<Project>('/api/projects',{title:'A focused writing experiment'});
  evidence.writingProjectId=writing.id;
  const writingNode={id:crypto.randomUUID(),title:'Design a personal experiment',description:'Explore an everyday question about writing habits without prescribing a workflow.',x:0,y:0};
  await api(`/api/projects/${writing.id}/mutations`,{label:'Add an independent idea',expectedRevision:writing.revision,operations:[{type:'addNode',node:writingNode}]});
  const modelOnly=await api<Run>(`/api/projects/${writing.id}/runs`,{nodeId:writingNode.id,useSearch:false,request:'Design a simple five-day personal experiment to compare morning and afternoon writing sessions. Give one outcome to record, a fairness precaution, and a limitation. This is a planning exercise; avoid claiming sourced scientific facts. Under 180 words.'});
  const modelOnlyDone=await finished(writing.id,modelOnly.id);
  assert.equal(modelOnlyDone.inputs.length,0);assert.equal(modelOnlyDone.tools.length,0);
  assert(!modelOnlyDone.messages.some(message=>message.content.includes('urban trees')));
  const usage=await api<UsageRecord[]>('/api/usage');
  evidence.runIds=[grounded.id,reused.id,modelOnly.id];evidence.proposalId=reply.proposal.id;evidence.selection=selected;
  evidence.checks=['Live authenticated Nebius structured proposal','Preview does not mutate or execute','Acceptance creates two nodes and one relationship atomically','Relationship imports no inputs and starts no work','One live basic Tavily search, exact snippet capture and Nebius synthesis','Explicit immutable result attachment and model-only follow-up','Distinct model-only investigation','Node/project context isolation'];
  evidence.afterUsage=usage.map(({reportedUsage,...record})=>({...record,providerReported:reportedUsage&&typeof reportedUsage==='object'?('credits' in reportedUsage?{credits:(reportedUsage as {credits:unknown}).credits}:'response' in reportedUsage?{usage:(reportedUsage as {response:{usage:unknown}}).response.usage}:null):null}));
  evidence.completedAt=new Date().toISOString();evidence.status='passed';
  writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
  console.log('Live smoke passed. Evidence: '+output);
} catch(error) {
  evidence.status='failed';evidence.error=error instanceof Error?error.message:String(error);evidence.endedAt=new Date().toISOString();
  writeFileSync('evidence/live-smoke-failure.json',JSON.stringify(evidence,null,2)+'\n');
  throw error;
}
