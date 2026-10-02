import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// An explicit local demonstration, not a live application-model run. Only the
// app API writes its database; exact Ask approvals never create ongoing grants.
if(!process.argv.includes('--run'))throw Error('Pass --run to execute the two local example analyses. No provider inference is used.');
const base=process.env.ROS_EXAMPLE_URL||'http://127.0.0.1:4310';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('A local ros.ai API is required.');
const recordPath=new URL('../evidence/collaborator/weather-project.json',import.meta.url);
const report=JSON.parse(readFileSync(recordPath,'utf8'));
if(report.status==='local-demonstration-completed'){console.log(JSON.stringify(report,null,2));process.exit(0);}
const api=async(path,body)=>{const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||String(r.status));return v;};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const save=()=>writeFileSync(recordPath,JSON.stringify(report,null,2)+'\n');
const scope='/api/projects/'+report.projectId;
const initial=await api(scope);
assert.equal(initial.project.title,report.title);
assert.equal((await api(scope+'/policy')).mode,'ask','Keep the example in Ask mode.');
assert((await api('/api/connections')).every(c=>c.limitUsd===0),'Paid application authorization must be disabled.');
assert.equal(initial.artifacts.find(a=>a.id===report.datasetArtifactId)?.hash,report.sourceHash);
const otherProjects=(await api('/api/projects')).filter(p=>p.id!==report.projectId);
const before=await Promise.all(otherProjects.map(async p=>[p.id,digest(await api('/api/projects/'+p.id))]));
const usage=digest(await api('/api/usage'));
const code=readFileSync(new URL('../examples/amsterdam-cycling-weather/analysis.py',import.meta.url),'utf8');
const followupId='seasonal-weather-analysis';
if(!initial.project.canvas.nodes.some(n=>n.id===followupId))await api(scope+'/mutations',{
  expectedRevision:initial.project.revision,label:'Add the requested example seasonal follow-up; independent local Action',operations:[{type:'addNode',node:{id:followupId,title:'Compare seasons & trace assumptions',kind:'activity',parentId:'season-question',x:0,y:0,description:'Real local follow-up using the exact original KNMI CSV and the baseline result selected explicitly. Open Experiment → Attempts & results for saved Python, tables, a seasonal distribution plot and trace sensitivity. Code was authored by the coding assistant; no application-model inference was used. Cycling counts remain missing.'}}],
});
let detail=await api(scope);
if(!detail.inputs.some(i=>i.nodeId===followupId&&i.artifactId===report.datasetArtifactId))await api(scope+'/inputs',{nodeId:followupId,artifactId:report.datasetArtifactId});
const finish=async id=>{for(let i=0;i<200;i++){const p=await api('/api/experiments/'+id);if(!['queued','running'].includes(p.run.status)){assert.equal(p.run.status,'completed',p.run.error);return p.run;}await new Promise(r=>setTimeout(r,250));}throw Error('Local run did not finish within 50 seconds. Inspect the saved run; no automatic retry.');};
async function run(field,nodeId,phase,request){
  if(report[field])return finish(report[field]);
  const p=await api(scope+'/experiments/preview',{nodeId,request,datasetArtifactId:report.datasetArtifactId,backend:'docker-python',code,parameters:{phase}});
  report[field]=p.run.id;save();
  assert.equal(p.approval.status,'pending');
  await api('/api/experiments/'+p.run.id+'/decision',{fingerprint:p.approval.fingerprint,decision:'allow'});
  return finish(p.run.id);
}
try{
  await run('overviewRunId',report.nodeId,'overview','Requested example: execute this exact local weather-data audit and descriptive comparison on real KNMI 2024 observations. Show coverage, weekday/weekend rainfall, monthly patterns and clear limits. Code is authored for the demonstration; no app-model planning is claimed.');
  detail=await api(scope);
  const baseline=detail.artifacts.find(a=>a.runId===report.overviewRunId&&a.kind==='result');
  assert(baseline,'Overview must retain an actual computed conclusion.');
  if(!detail.inputs.some(i=>i.nodeId===followupId&&i.artifactId===baseline.id))await api(scope+'/inputs',{nodeId:followupId,artifactId:baseline.id});
  await run('seasonalRunId',followupId,'seasonal','Requested example follow-up: using the exact original data and explicitly selected baseline conclusion, compare weekday/weekend distributions within seasons and quantify sensitivity to assigning 0.025 mm per trace hour. Preserve the baseline; no cycling or causal inference. Execute only this exact local program.');
  detail=await api(scope);
  const outputs=detail.artifacts.filter(a=>[report.overviewRunId,report.seasonalRunId].includes(a.runId)&&['plot','table','metric','result'].includes(a.kind));
  assert(outputs.some(a=>a.kind==='plot'));
  const highlights=[outputs.find(a=>a.runId===report.overviewRunId&&a.kind==='plot'),outputs.find(a=>a.runId===report.seasonalRunId&&a.kind==='plot')].filter(Boolean);
  for(const [i,a]of highlights.entries())if(!detail.highlights?.some(h=>h.artifactId===a.id))await api(scope+'/highlights',{nodeId:i===0?'amsterdam-question':'season-question',artifactId:a.id,x:0,y:0});
  if(!report.exportId){const exported=await api(scope+'/local-connections/'+report.outputConnectionId+'/export',{artifactIds:outputs.map(a=>a.id)});report.exportId=exported.id;report.exportedFiles=exported.files;save();}
  assert.equal(digest(await api('/api/usage')),usage);
  for(const [id,hash]of before)assert.equal(digest(await api('/api/projects/'+id)),hash,'Unrelated saved project changed');
  assert.equal((await api(scope+'/local-connections')).find(c=>c.id===report.connectionId).writable,false);
  report.status='local-demonstration-completed';report.completedAt=new Date().toISOString();report.localAnalysisRuns=2;report.artifacts=detail.artifacts.length;report.outputCount=outputs.length;report.plots=outputs.filter(a=>a.kind==='plot').length;report.newProviderCalls=0;report.providerLedgerUnchanged=true;report.existingProjectsUnchanged=true;report.sourceReadOnly=true;report.execution='Actual Docker Python with captured code/data/parameters/outputs. Program authored by coding assistant; live app-model loop remains unverified.';report.data='Real KNMI weather; cycling observations unavailable, no cycling relationship claimed.';save();console.log(JSON.stringify(report,null,2));
}catch(error){report.error=error.message;save();throw error;}
