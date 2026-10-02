/** Local-only reconciliation of the already captured provider response. No external calls. */
import {Store} from '../src/server/store.js';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const dir='examples/demo-market-risk/research-v2';
if(existsSync(dir+'/plan-reconciliation.json'))throw Error('Already reconciled; do not duplicate.');
const s=new Store('.ros-ai',{recoverInterrupted:false}),projectId='bff8fb76-ee4b-433b-9b27-e8cf3ab19ce4';
try{
 const failed=JSON.parse(readFileSync(dir+'/live-plan.json','utf8'));
 const rows=s.listUsage().filter(u=>(u.reportedUsage as any)?.authorizationId===failed.modelGrant);
 if(rows.length!==1||rows[0].status!=='settled')throw Error('Expected exact one settled proposal response.');
 const u=rows[0],trace=u.reportedUsage as any,result=JSON.parse(trace.response.content);
 const project=s.getProject(projectId),nodeId='window-sensitivity',runId=randomUUID(),at=new Date().toISOString();
 s.createRun({id:runId,projectId,nodeId,request:'Reconcile exact completed Ultra proposal from captured usage after local immutable-linking error; no repeated inference.',useSearch:false,status:'running',createdAt:at,startedAt:at,projectRevision:project.revision,node:project.canvas.nodes.find(n=>n.id===nodeId)!,inputs:[],messages:trace.request.messages,provider:'local',model:'captured-provider-response-reconciliation',modelVersion:null,configuration:{kind:'read-only-provider-response-reconciliation',originalRunId:failed.inferenceRunId,usageId:u.id,originalModel:trace.model,noNewProviderRequest:true},tools:[],events:[{at,type:'reconciliation',message:'Exact already settled response recovered locally. Failed wrapper remains preserved; no provider retry.'}],artifactIds:[]});
 const artifact=s.addArtifact({projectId,nodeId,runId,kind:'result',title:'Ultra · actual proposed experiment (reconciled receipt)',content:JSON.stringify(result,null,2),capture:'generated',mediaType:'application/json',metadata:{demoRole:'experiment-proposal',actualInference:true,usageId:u.id,originalRunId:failed.inferenceRunId,noNewProviderRequest:true}});
 s.updateRun(runId,{status:'completed',endedAt:new Date().toISOString(),artifactIds:[artifact.id]});
 for(const node of ['window-sensitivity','paper'])s.addInput(projectId,node,artifact.id);
 writeFileSync(dir+'/ultra-proposed-core.py',result.code+'\n');
 writeFileSync(dir+'/plan-reconciliation.json',JSON.stringify({runId,artifactId:artifact.id,usageId:u.id,originalRunId:failed.inferenceRunId,response:result,usage:trace.response.usage,estimatedUsd:u.estimatedUsd,reservedUsd:u.reservedUsd,noAdditionalInference:true,reconciledAt:new Date().toISOString()},null,2)+'\n');
 console.log(JSON.stringify({runId,artifactId:artifact.id,noAdditionalInference:true}));
}finally{s.close();}
