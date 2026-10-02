import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Only the running app API owns writes. Never open its live database in a second Store.
// This explicitly requested example uses local computation only, with no provider calls.
if (!process.argv.includes('--create')) throw Error('Run with --create to create the requested local example and execute its bounded numerical programs.');
const base=process.env.ROS_EXAMPLE_URL || 'http://127.0.0.1:4310';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('The example requires the local ros.ai API.');
const title='Coffee cooling lab — lid or no lid?';
const api=async(path,body)=>{
  const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json(); if(!response.ok)throw Error(value.error || `HTTP ${response.status}`); return value;
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const projects=await api('/api/projects');
const existing=projects.find(project=>project.title===title);
if(existing){console.log(JSON.stringify({status:'already-exists',projectId:existing.id,title,url:base,message:'Existing example left unchanged; no new runs or paid calls.'}));process.exit(0);}
const capability=await api('/api/experiments/capabilities');
assert(capability.available,'Installed local Python must be available.');
// Fixed-rule project conversation is used only when no cloud grant exists.
const providers=await api('/api/connections');
assert(providers.every(provider=>provider.limitUsd===0),'Disable fresh paid grants before creating this no-spend example.');
const beforeUsage=digest(await api('/api/usage'));
const beforeProjects=await Promise.all(projects.map(async project=>[project.id,digest(await api(`/api/projects/${project.id}`))]));
const csv=readFileSync(new URL('../examples/coffee-cooling/observations.csv',import.meta.url),'utf8');
const compareCode=readFileSync(new URL('../examples/coffee-cooling/compare.py',import.meta.url),'utf8');
const targetCode=readFileSync(new URL('../examples/coffee-cooling/target.py',import.meta.url),'utf8');
const project=await api('/api/projects',{title});
const scope=`/api/projects/${project.id}`;
mkdirSync(new URL('../evidence/example-project/',import.meta.url),{recursive:true});
const report={createdAt:new Date().toISOString(),title,projectId:project.id,base,dataset:'Synthetic, authored solely for this example; not measured coffee temperatures.',execution:'Real local bounded Python, code authored for this requested demonstration. No model-generated-code claim.',status:'creating'};
const writeReport=()=>writeFileSync(new URL('../evidence/example-project/created.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
writeReport();
const node=(id,kind,title,description,x,y,parentId=null)=>({id,kind,title,description,x,y,parentId});
const nodes=[
  node('cooling-evidence','topic','Cooling evidence','Start here: 12 synthetic observations of two cups over 22 minutes. Open this workspace to explore the assumptions and the temperature-target experiment. This example demonstrates real computation on invented teaching data.',0,0),
  node('compare-retention','activity','Compare heat retention','Open Experiment for saved CSV, real code, approval records, comparison metrics and three plots. The synthetic lid advantage at minute 22 is 10.8 C. No real cups were measured; no provider inference was used.',312,0),
  node('real-world-evidence','topic','Real-world evidence','What evidence would justify a claim? Repeat with matched cups; record room temperature, volume, starting temperature, material, lid opening and thermometer position. Inspect Inputs for explicitly selected comparison evidence. This node is independent and has not been run.',0,216),
  node('cooling-assumptions','topic','Cooling assumptions','These are synthetic paired observations, not physical evidence. Equal volume, cup material and room conditions are assumptions. A straight line is only a 0–22 minute approximation. Plots use observation order; samples are two minutes apart. New experiments would need repetition and uncertainty estimates.',0,0,'cooling-evidence'),
  node('time-to-target','activity','Time above target','Open Experiment → Attempts & results: the 70 C run estimates 7.07 extra minutes with a lid; changing only target_c to 75 estimates 4.85. Both attempts preserve code, input version, parameters, logs and tables. Load a saved version, change target_c to 72, preview, and approve your own new run.',312,0,'cooling-evidence'),
];
try{
  await api(scope+'/mutations',{expectedRevision:0,label:'Create user-requested coffee cooling example; independent Topic and Activity workspaces',operations:nodes.map(node=>({type:'addNode',node}))});
  await api(scope+'/chat',{message:'This is a requested, self-contained demonstration using synthetic coffee-cooling observations. The outcome is an inspectable comparison and a revised temperature-target experiment. Open Compare heat retention for plots; Cooling evidence for nested topics/activities; Real-world evidence for explicit result reuse. Code is authored for this example and runs locally. Keep structure as it is for now; no remote research or provider calls.'});
  const comparison=await api(scope+'/experiments/preview',{nodeId:'compare-retention',request:'Requested example: compute paired heat retention from the labelled synthetic CSV. Run the reviewed local demonstration code; show comparison metrics, a table and plots. No cloud model, no real-world performance claim.',csv,code:compareCode,parameters:{}});
  const dataset=(await api(scope)).artifacts.find(a=>a.runId===comparison.run.id&&a.kind==='dataset');
  await api(scope+'/inputs',{nodeId:'time-to-target',artifactId:dataset.id});
  const target70=await api(scope+'/experiments/preview',{nodeId:'time-to-target',request:'Requested example: fit straight lines over synthetic 0–22 minute observations and estimate each cup reaching target_c=70. This is an illustrative model, not a validated cooling law.',datasetArtifactId:dataset.id,code:targetCode,parameters:{target_c:70}});
  const group=await api(scope+'/auto-research',{scope:'Only the two exact local programs prepared for the user-requested synthetic coffee example: paired comparison and a 70 C target estimate. No new structure, remote services or retries.',outcome:'Produce independent, inspectable local metrics/tables/plots with captured inputs and grants.',runIds:[comparison.run.id,target70.run.id],fingerprints:{[comparison.run.id]:comparison.approval.fingerprint,[target70.run.id]:target70.approval.fingerprint},maxConcurrency:2});
  const finished=async id=>{for(let i=0;i<150;i++){const value=await api(`/api/experiments/${id}`);if(!['queued','running'].includes(value.run.status)){assert.equal(value.run.status,'completed',value.run.error);return value.run;}await new Promise(r=>setTimeout(r,100));}throw Error('Local example did not complete within 15 seconds.');};
  await Promise.all([finished(comparison.run.id),finished(target70.run.id)]);
  const target75=await api(scope+'/experiments/preview',{nodeId:'time-to-target',request:'Revision of the same synthetic experiment: change only target_c from 70 to 75. Preserve the 70 C attempt and its selected dataset version. Execute only this exact local revision.',datasetArtifactId:dataset.id,code:targetCode,parameters:{target_c:75},retryOf:target70.run.id});
  await api(`/api/experiments/${target75.run.id}/decision`,{fingerprint:target75.approval.fingerprint,decision:'allow'});
  await finished(target75.run.id);
  let detail=await api(scope);
  const metric=(runId,title)=>JSON.parse(detail.artifacts.find(a=>a.runId===runId&&a.kind==='metric'&&a.title===title).content).value;
  assert.equal(metric(comparison.run.id,'Lid advantage at 22 minutes (C)'),10.8);
  assert.equal(metric(comparison.run.id,'Mean paired lid advantage (C)'),6.375);
  assert.equal(metric(target70.run.id,'Extra minutes above target with lid (model)'),7.07);
  assert.equal(metric(target75.run.id,'Extra minutes above target with lid (model)'),4.85);
  const comparisonTable=detail.artifacts.find(a=>a.runId===comparison.run.id&&a.kind==='table');
  await api(scope+'/inputs',{nodeId:'real-world-evidence',artifactId:comparisonTable.id});
  await api(scope+'/chat',{message:'Add an Activity for Compare cup materials'});
  detail=await api(scope);
  assert.equal(detail.project.canvas.nodes.length,5,'The optional proposal must not silently change the canvas.');
  assert.equal(detail.runs.length,3);
  assert(detail.runs.every(run=>run.status==='completed'&&run.provider==='local'));
  assert.equal(digest(await api('/api/usage')),beforeUsage,'The provider ledger must remain unchanged.');
  const unchanged=[];for(const [id,before] of beforeProjects)unchanged.push({id,unchanged:digest(await api(`/api/projects/${id}`))===before});
  report.status='completed';report.completedAt=new Date().toISOString();report.nodes=5;report.completedRuns=3;report.artifacts=detail.artifacts.length;report.plots=detail.artifacts.filter(a=>a.kind==='plot').length;report.autoResearchId=group.id;report.datasetArtifactId=dataset.id;report.comparisonRunId=comparison.run.id;report.target70RunId=target70.run.id;report.target75RunId=target75.run.id;report.pendingProposalId=detail.proposals.find(p=>p.status==='pending')?.id;report.metrics={endLidAdvantageC:10.8,meanPairedAdvantageC:6.375,extraMinutesAt70C:7.07,extraMinutesAt75C:4.85};report.existingProjectsUnchanged=unchanged.every(p=>p.unchanged);report.providerLedgerUnchanged=true;report.newProviderCalls=0;writeReport();
  console.log(JSON.stringify(report,null,2));
}catch(error){report.status='incomplete';report.error=error.message;writeReport();throw error;}
