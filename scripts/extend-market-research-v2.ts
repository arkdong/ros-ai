/** Approved local market-demo extension; existing projects and run evidence are preserved. */
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { Highlights } from '../src/server/connections.js';
import type {Artifact,CanvasNode,Run} from '../src/shared/types.js';
const projectId='bff8fb76-ee4b-433b-9b27-e8cf3ab19ce4';
const dir=resolve('examples/demo-market-risk/research-v2'),reportPath=dir+'/native-extension.json';
const store=new Store(resolve('.ros-ai'),{recoverInterrupted:false});
const report:any=existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')):{projectId,createdAt:new Date().toISOString(),execution:'Prepared research plus actual local Docker; no new app-provider calls yet.',newPaidCalls:0};
const read=(name:string)=>readFileSync(dir+'/'+name,'utf8');
const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
const at=()=>new Date().toISOString();
function capture(nodeId:string,title:string,content:string,kind:Artifact['kind']='result',metadata:Record<string,unknown>={}){
 const project=store.getProject(projectId),runId=randomUUID();
 const inputs=store.detail(projectId).inputs.filter(i=>i.nodeId===nodeId).map(i=>({...i,artifact:store.getArtifact(i.artifactId)}));
 return store.atomic(()=>{
 const run:Run={id:runId,projectId,nodeId,request:title,useSearch:false,status:'running',createdAt:at(),startedAt:at(),projectRevision:project.revision,node:project.canvas.nodes.find(n=>n.id===nodeId)!,inputs,messages:[],provider:'local',model:'coding-assistant-prepared-import-v1',modelVersion:null,configuration:{kind:'prepared-research-import',preparedBy:'coding assistant',noProviderRequest:true},tools:[],events:[{at:at(),type:'import',message:'Prepared research/writing capture, not inference or code execution.'}],artifactIds:[]};
 store.createRun(run);
 const a=store.addArtifact({projectId,nodeId,runId,kind,title,content,capture:'generated',mediaType:'text/markdown',metadata:{preparedBy:'coding assistant',...metadata}});
 store.updateRun(runId,{status:'completed',endedAt:at(),artifactIds:[a.id]});return a;
 });
}
async function api(path:string,body?:unknown){const r=await fetch('http://127.0.0.1:4310'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||String(r.status));return data;}
const command=process.argv[2];
try{
 if(command==='prepare'){
  if(report.preparedAt)throw Error('Extension already prepared; do not duplicate captures.');
  const p=store.getProject(projectId);
  for(const id of ['stage-explore','stage-evidence','stage-analyze','stage-draft'])if(!p.canvas.nodes.some(n=>n.id===id))throw Error('Required parent absent: '+id);
  const plan=read('pre-analysis-plan.md'),sources=read('source-review.md');
  const node=(id:string,title:string,description:string,parentId:string,x:number,y:number,kind:CanvasNode['kind']='topic'):CanvasNode=>({id,title,description,parentId,x,y,kind,width:440});
  const nodes=[
   node('research-exploration','From a broad idea to a testable question',plan,'stage-explore',0,480),
   node('literature-review','What earlier research warns us about',sources,'stage-evidence',0,480),
   node('source-assessment','Why retain this price snapshot?', 'Selection decision: retain the actual 2018–2021 S&P 500 price-index snapshot and original 252-session baseline. A common 755-session sample permits one short-history sensitivity and timing inspection. One index, no dividends, missing-session exclusions and restricted reproduction rights remain material limits. Research summaries and exact imported data are distinct.\n\n'+sources.split('3. **')[1]?.split('4. **')[0], 'stage-evidence',520,480),
   node('window-sensitivity','Does shorter history change the picture?', 'Prepared follow-up: compare 126 and 252 strictly preceding loss windows on the same 755 sessions. Save yearly rates, descriptive 2020 quarter counts, two new plots and exact no-look-ahead checks. This is a sensitivity extension after the original baseline was known; no optimized winner or future calibration is claimed.', 'stage-analyze',0,480,'activity'),
   node('interpretation-review','Challenge the aggregate breach rate','Initial tempting interpretation: an overall rate below 5% means the baseline is reliable. Challenge: inspect the same preselected periods and one declared window sensitivity. Preserve current and future data exclusion, report denominators, and distinguish descriptive breach timing from future calibration. New inference, if authorized, will be labelled separately from this prepared critique.', 'stage-analyze',520,480),
   node('paper','Research paper · editable working draft','A short cited paper will combine the preserved baseline with the actual local sensitivity outputs. No prepared prose will be described as new model inference.', 'stage-draft',0,480),
  ];
  const edges=[['research-exploration','literature-review','focuses evidence review'],['literature-review','window-sensitivity','motivates sensitivity'],['source','window-sensitivity','provides data to'],['window-sensitivity','interpretation-review','tests interpretation'],['interpretation-review','paper','qualifies draft'],['analysis','paper','supports draft'],['literature-review','paper','supports method discussion']];
  store.mutate(projectId,[...nodes.map(node=>({type:'addNode' as const,node})),...edges.map(([source,target,label],i)=>({type:'addConnection' as const,connection:{id:'market-v2-'+i,source,target,label}}))],'Extend existing market research with evidence assessment, one sensitivity and a draft',p.revision);
  const planArtifact=capture('research-exploration','Research extension plan · before new calculation',plan);
  const sourceArtifact=capture('literature-review','Selected primary literature · attributed prepared review',sources,'source',{discovery:'Coding assistant free web browsing on 2026-09-23; no Tavily request',sourceUrls:['https://www.rba.gov.au/publications/rdp/1997/9708/value-at-risk.html','https://www.federalreserve.gov/econres/feds/the-hidden-dangers-of-historical-simulation.htm','https://fred.stlouisfed.org/series/SP500','https://fredhelp.stlouisfed.org/fred/graphs/share-my-fred-graph/cite/']});
  for(const id of ['source-assessment','window-sensitivity'])store.addInput(projectId,id,'7ac2c750-2313-4c53-a5d9-2d5cbcc84711');
  for(const id of ['window-sensitivity','paper'])store.addInput(projectId,id,planArtifact.id);
  for(const id of ['window-sensitivity','paper','source-assessment'])store.addInput(projectId,id,sourceArtifact.id);
  report.preparedAt=at();report.nodeIds=nodes.map(n=>n.id);report.planArtifactId=planArtifact.id;report.sourceReviewArtifactId=sourceArtifact.id;save();
 }else if(command==='evidence'){
  if(report.evidenceAssessmentArtifactId)throw Error('Assessment already captured.');
  const text=read('evidence-assessment.md');
  const sources=store.detail(projectId).artifacts.filter(a=>a.capture==='search-snippet');
  for(const a of sources)store.addInput(projectId,'source-assessment',a.id);
  const a=capture('source-assessment','Selected evidence · actual Tavily search assessment',text,'source',{demoRole:'evidence-source',sourceArtifactIds:sources.map(x=>x.id),discovery:'Two actual Tavily basic searches plus separately recorded official-page browsing'});
  store.addInput(projectId,'paper',a.id);
  store.mutate(projectId,[{type:'updateNode',id:'source-assessment',patch:{description:text}}],'Save selected search evidence and coverage assessment',store.getProject(projectId).revision);
  report.evidenceAssessmentArtifactId=a.id;save();
 }else if(command==='review'){
  if(report.reviewArtifactId)throw Error('Review already captured.');
  const review=read('model-review.md');
  const a=capture('interpretation-review','Review the actual model proposal before execution',review,'result',{demoRole:'challenge'});
  for(const id of ['window-sensitivity','paper'])store.addInput(projectId,id,a.id);
  store.mutate(projectId,[{type:'updateNode',id:'interpretation-review',patch:{description:review}}],'Record substantive code and interpretation review',store.getProject(projectId).revision);
  report.reviewArtifactId=a.id;save();
 }else if(command==='analyze'){
  if(!report.preparedAt||report.runId)throw Error('Prepare first; a recorded run must not be resubmitted.');
  const preview=await api('/api/projects/'+projectId+'/experiments/preview',{nodeId:'window-sensitivity',request:'Execute the exact user-authorized local market-risk sensitivity: two preceding-loss windows on the common original sample, yearly and quarter counts, two plots and direct no-look-ahead checks. Reviewed and corrected code informed by the actual Ultra proposal; full warm-up restored before common evaluation. Inference/code authorship tracked separately.',datasetArtifactId:'7ac2c750-2313-4c53-a5d9-2d5cbcc84711',backend:'docker-python',code:read('sensitivity.py'),parameters:{}});
  report.runId=preview.run.id;report.runSubmittedAt=at();save();
  await api('/api/experiments/'+report.runId+'/decision',{fingerprint:preview.approval.fingerprint,decision:'allow'});
  let run;
  for(let i=0;i<160;i++){run=(await api('/api/experiments/'+report.runId)).run;if(!['queued','running'].includes(run.status))break;await new Promise(r=>setTimeout(r,300));}
  report.runStatus=run.status;report.runError=run.error;save();
  if(run.status!=='completed')throw Error('Local run '+run.status+': '+(run.error||'inspect captured state; no automatic retry'));
  const artifacts=store.detail(projectId).artifacts.filter(a=>a.runId===report.runId);
  mkdirSync(dir+'/outputs',{recursive:true});
  report.artifacts=artifacts.filter(a=>['table','metric','result','plot','dataset'].includes(a.kind)).map(a=>{
   const ext=a.kind==='plot'?'svg':a.kind==='dataset'?'csv':a.kind==='result'?'md':'json';
   const path=dir+'/outputs/'+a.id+'.'+ext;writeFileSync(path,a.content);
   return {id:a.id,kind:a.kind,title:a.title,hash:a.hash,path};
  });
  for(const a of artifacts.filter(a=>['table','metric','result','plot'].includes(a.kind)))for(const id of ['interpretation-review','paper'])store.addInput(projectId,id,a.id);
  for(const id of ['29b7b2d3-9698-448b-96cd-04facea9c3b5','5403f5fb-df56-4721-ac54-2b1c0760cdac','70978a24-eccb-4df6-a851-1fbcefa4b3b2'])store.addInput(projectId,'paper',id);
  report.calculatedAt=at();save();
 }else if(command==='finalize'){
  if(report.completedAt)throw Error('Already finalized.');
  const review=read('model-review.md');
  const corrected=capture('interpretation-review','Code review · corrected editorial note',review,'result',{demoRole:'code-review',supersedesArtifactId:report.reviewArtifactId});
  store.addInput(projectId,'paper',corrected.id);
  store.mutate(projectId,[{type:'updateNode',id:'interpretation-review',patch:{description:review}}],'Correct editorial newline observation; preserve substantive warm-up review',store.getProject(projectId).revision);
  for(const input of store.detail(projectId).inputs.filter(i=>i.nodeId==='paper'&&i.artifactId===report.reviewArtifactId))store.removeInput(projectId,input.id);
  const highlights=new Highlights(store);
  const plots=report.artifacts.filter((a:any)=>a.kind==='plot');
  for(const [i,a] of plots.entries())highlights.save(projectId,{nodeId:'window-sensitivity',artifactId:a.id,x:i*360,y:0});
  const interpretation=JSON.parse(read('live-interpret.json')),proposal=JSON.parse(read('plan-reconciliation.json'));
  report.correctedReviewArtifactId=corrected.id;report.interpretationArtifactId=interpretation.artifactId;
  report.newPaidCalls=4;report.actualProviderRequests={nebius:2,tavily:2};report.inferenceRetainedUsd=interpretation.scopeRetainedUsd;report.inferenceEstimatedUsd=proposal.estimatedUsd+interpretation.estimatedUsd;report.tavilyIncrementalCredits=2;report.tavilyIncrementalUsd=.016;report.tavilyCumulativeRetainedUsd=interpretation.tavilyCumulativeRetainedUsd;
  report.execution='Two actual Tavily basic searches, two actual Ultra inference requests, reviewed/corrected code and one actual local Docker calculation. Original failed receipt wrapper is preserved; no inference retry.';
  report.selectedPlotIds=plots.map((a:any)=>a.id);report.completedAt=at();save();
 }else if(command==='paper'){
  if(report.runStatus!=='completed'||report.paperArtifactId)throw Error('One completed new analysis and no previous paper capture required.');
  const paper=read('paper.md');
  const a=capture('paper','Working paper · challenge-qualified market-risk baseline',paper,'result',{demoRole:'paper'});
  const p=store.getProject(projectId);
  store.mutate(projectId,[{type:'updateNode',id:'paper',patch:{description:paper}}],'Save editable cited research paper from actual evidence and calculations',p.revision);
  report.paperArtifactId=a.id;report.paperSavedAt=at();save();
 }else throw Error('Use prepare, analyze or paper. This script never enables provider spending.');
 console.log(JSON.stringify({command,projectId,runId:report.runId,runStatus:report.runStatus,paperArtifactId:report.paperArtifactId,reportPath}));
}finally{store.close();}
