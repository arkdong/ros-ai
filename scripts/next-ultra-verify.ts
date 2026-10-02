/** Exactly two authorized Ultra requests: proposed code, then real-result interpretation.
 * September 21 explicit authorization: $5 Nebius, max two requests, no Tavily.
 * Refuses replay; never resets either new-session or historical accounting.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { ExperimentService } from '../src/server/experiments.js';
import { DEFAULT_MODEL, NebiusAdapter } from '../src/server/providers.js';

const reportPath=resolve('evidence/next-ultra-live.json'),dataPath=resolve('evidence/next-ultra-data');
if (!process.argv.includes('--allow-billable')) throw Error('Requires --allow-billable and the explicit September 21 $5 / two-request authorization.');
if (existsSync(reportPath)) throw Error('Verification evidence already exists; no automatic re-run is authorized.');
dotenv.config({path:'.env.local',quiet:true});
if(!process.env.NEBIUS_API_KEY)throw Error('NEBIUS_API_KEY missing.');
mkdirSync(dataPath,{recursive:true});
const store=new Store(dataPath);
if(store.listUsage().length || store.listProjects().length) {store.close();throw Error('Existing verification state must be reviewed; this script never resets or repeats it.');}
const authorization={id:'adam-2026-09-21-ultra-two-requests',nebiusUsd:5,tavilyUsd:0,maxRequests:2};
const model=new NebiusAdapter(process.env.NEBIUS_API_KEY,DEFAULT_MODEL);
const execution=new ExecutionService(store,{model,liveAuthorization:authorization,maxConcurrent:1,maxOutputTokens:2000,timeoutMs:90000,includeSetupUsage:false});
const local=new ExperimentService(store);
const report:Record<string,unknown>={startedAt:new Date().toISOString(),authorization,scope:'Synthetic dataset only; one Ultra code proposal and one interpretation of actual local Python results; no Tavily.',model:DEFAULT_MODEL,localDataPath:dataPath};
let projectId:string|undefined;
async function waitRun(id:string) {for(let n=0;n<1000;n++){const run=store.getRun(id);if(!['queued','running'].includes(run.status))return run;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Run did not terminate; no retry will be attempted.');}
try {
 const project=store.createProject('Ultra verification — synthetic numeric fixture');projectId=project.id;
 store.mutate(project.id,[{type:'addNode',node:{id:'analysis',kind:'activity',title:'Inspect a synthetic relationship',description:'Fit y against x and report the computed result. Synthetic fixture, not market evidence.',x:0,y:0}},{type:'addNode',node:{id:'interpretation',kind:'activity',title:'Interpret selected observed output',description:'Interpret only the explicitly selected result.',x:312,y:0}}],'Create isolated verification activities');
 const csv='x,y\n1,3\n2,5\n3,7\n4,9\n';
 const inspected=local.preview(project.id,{nodeId:'analysis',request:'Inspect synthetic x/y fixture',csv});
 local.decide(inspected.run.id,inspected.approval.fingerprint,'cancel');
 const dataset=store.detail(project.id).artifacts.find(a=>a.runId===inspected.run.id&&a.kind==='dataset')!;
 const planRun=execution.startExperimentPlan(project.id,'analysis',{request:'Fit a straight line predicting y from x. Propose short bounded code that uses linear_fit, emits slope, intercept and r_squared metrics, a table of descriptive y statistics, and a plot of observed y. Use the actual dataset and no invented outputs. Return the requested tool response.',datasetArtifactId:dataset.id});
 const planned=await waitRun(planRun.id);report.planRunId=planned.id;
 if(planned.status!=='completed')throw Error(`Ultra plan ${planned.status}: ${planned.error??'no result'}`);
 const plan=planned.configuration.experimentPlan as {code:string;parameters:Record<string,string|number|boolean>;explanation:string};
 console.log(JSON.stringify({proposal:plan,sourcePlanRunId:planned.id,sourceDatasetHash:dataset.hash}));
 const review=createInterface({input:process.stdin,output:process.stdout});
 const decision=await review.question('Inspect the exact proposed numerical code above. Type allow to approve this one local synthetic-data action: ');
 review.close();
 if(decision.trim()!=='allow')throw Error('Local execution was not approved; no interpretation request was made.');
 const preview=local.preview(project.id,{nodeId:'analysis',request:'Run the reviewed Ultra-proposed code on the exact synthetic CSV',planRunId:planned.id,datasetArtifactId:dataset.id,code:plan.code,parameters:plan.parameters});
 store.updateRun(preview.run.id,{configuration:{...preview.run.configuration,sourcePlanRunId:planned.id,review:{reviewer:'build-agent-under-explicit-local-verification-scope',decision:'allow',scope:'Bounded numerical code using synthetic x/y data; worker AST policy still enforces allowed functions.'}}});
 local.decide(preview.run.id,preview.approval.fingerprint,'allow');
 const executed=await waitRun(preview.run.id);report.localRunId=executed.id;
 if(executed.status!=='completed')throw Error(`Local execution ${executed.status}: ${executed.error??'no result'}`);
 const artifacts=store.detail(project.id).artifacts.filter(a=>a.runId===executed.id);
 const observed=artifacts.filter(a=>['metric','table'].includes(a.kind));
 if(!observed.length || !artifacts.some(a=>a.kind==='plot'))throw Error('Local run produced no inspectable metrics/table/plot.');
 for(const artifact of observed)store.addInput(project.id,'interpretation',artifact.id,artifact.content);
 const interpreted=await waitRun(execution.startRun(project.id,'interpretation',{request:'Interpret the selected outputs of a real local run on four synthetic x/y observations. State the measured slope, intercept and R squared, and the limitation of inferring causality or real-world performance from this tiny constructed dataset. Cite the selected input labels. Keep it under 160 words.',useSearch:false}).id);
 report.interpretationRunId=interpreted.id;
 if(interpreted.status!=='completed')throw Error(`Ultra interpretation ${interpreted.status}: ${interpreted.error??'no result'}`);
 report.outcome='completed';
} catch(error) {report.outcome='failed';report.error=error instanceof Error?error.message:'Unknown failure';process.exitCode=1;}
finally {
 await execution.shutdown();await local.shutdown();
 report.finishedAt=new Date().toISOString();report.usage=store.listUsage();
 report.accountedUsd=execution.ledger.accounted('nebius');
 if(projectId)report.project=store.detail(projectId);
 writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');store.close();
 console.log(JSON.stringify({outcome:report.outcome,error:report.error,report:reportPath,accountedUsd:report.accountedUsd,requests:(report.usage as unknown[]).length}));
}
