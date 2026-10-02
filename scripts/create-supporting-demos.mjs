import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(!process.argv.includes('--create'))throw Error('Pass --create to add two requested supporting demo projects and run their exact local analyses.');
const base=process.env.ROS_EXAMPLE_URL||'http://127.0.0.1:4310';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Local API required');
const api=async(path,body)=>{const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||JSON.stringify(v));return v;};
const path=rel=>fileURLToPath(new URL('../'+rel,import.meta.url));
const plans=[{
 key:'amsterdam',title:'Amsterdam-area rainfall patterns for cycling planning',original:'How do rainy days relate to cycling activity in Amsterdam?',
 dataset:'examples/demo-amsterdam/schiphol-weather-2024.csv',code:'examples/demo-amsterdam/analysis.py',
 question:'Original question: How do rainy days relate to cycling activity in Amsterdam? Compatible bicycle counts have not been obtained. The documented fallback asks only what rainfall was recorded near Amsterdam in 2024. This saved demonstration uses actual KNMI observations and a real local Docker calculation; no app-model inference is claimed.',
 source:'KNMI station 240, Schiphol. 366 Europe/Amsterdam local days in 2024, from 8,784 hourly observations; DST days correctly have 23/25 hours. Original response captured 2026-09-21, with request/hash in examples/amsterdam-cycling-weather/source/weather-retrieval.json. Source: https://www.daggegevens.knmi.nl/klimatologie/uurgegevens ; methodology: https://www.knmi.nl/kennis-en-datacentrum/achtergrond/data-ophalen-vanuit-een-script . Royal Netherlands Meteorological Institute (KNMI), CC BY 4.0. This unchanged derived CSV converts units and aggregates local days.',
 method:'Wet means daily precipitation ≥1 mm. Below 1 mm includes light rain and traces. Hourly RH=-1 means less than 0.05 mm and contributes zero to the baseline; trace-hour counts are retained. No missing day becomes zero rainfall. Exactly two plots: rainfall over time and monthly wet-day shares with denominators. Monthly statistics, coverage and a 0.025 mm/trace-hour sensitivity scenario are saved.',
 challenge:'Evidence changed the scope: NDW’s Fiets API still requires OAuth (checked 2026-09-23; https://docs.ndw.nu/data-uitwisseling/interface-beschrijvingen/fiets-api/). The previously checked export form required email/CAPTCHA; no export was submitted. Candidate Amsterdam counter metadata is not a usable count series. Weather-only results cannot show cycling demand, behavior, causal impact, future forecasts or route-specific exposure. Schiphol is a geographic proxy. To reopen the original question, acquire one licensed count series with location, units, timestamps and coverage, then match complete local days and stratify weekday/weekend × season.',
 analysisTitle:'What did the weather actually show?',resultTitle:'Read the weather-only conclusion',
 request:'User-authorized supporting demo: run this exact local weather-only fallback program against real KNMI 2024 observations. Save two plots, coverage, monthly denominators, trace sensitivity and a qualified conclusion. No cycling counts or model execution are invented.'
},{
 key:'market-risk',title:'When market conditions change · a historical risk baseline',original:'How stable is a simple market-risk estimate when market conditions change?',
 dataset:'examples/demo-market-risk/source/fred-sp500-2018-2021.csv',code:'examples/demo-market-risk/analysis.py',
 question:'How stable is a simple market-risk estimate when market conditions change? This saved evaluation uses one real S&P 500 daily price series, one 252-day historical 95% loss threshold, and eligible 2019–2021 observations. 2020 was fixed in the brief before calculating results. Real local Python establishes the numbers; code and explanations were prepared by the coding assistant, without app-model inference.',
 source:'S&P Dow Jones Indices LLC, S&P 500 [SP500], retrieved from FRED on 2026-09-23: https://fred.stlouisfed.org/series/SP500 . Exact CSV: https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500&cosd=2018-01-01&coed=2021-12-31 . Daily close; underlying US equities are USD-denominated, but observations are dimensionless index points. Price index excludes dividends; it is not adjusted ETF prices or total return. Index methodology handles constituent/corporate-action maintenance. No further adjustment is applied. Blanks are excluded, not forward-filled; returns span adjacent observed sessions. Data copyright S&P Dow Jones Indices LLC. Reproduction/redistribution requires prior permission per FRED notes; this is a local research capture, not an open redistribution license. Public sharing of raw data/figures is not cleared.',
 method:'Period fixed before evaluation: prices 2018–2021; evaluate eligible 2019–2021 sessions. r_t=P_t/P_(t-1)-1, L_t=-r_t. q_t is the linear empirical 95th percentile of 252 strictly preceding losses; q_t excludes L_t. Exceedance means L_t>q_t. Full warm-up only: first eligible day is 2019-01-04. Missing prices are dropped, not filled. Drawdown is P_t/running_max(P)_t−1, with maximum beginning at the first retained January 2018 price. No transaction costs, dividends, portfolio weights or trading decisions.',
 challenge:'Check the estimate against later observations, not the data that set it. Three exact-window checks independently recompute quantiles and perturb the current loss: today’s own threshold must be unchanged. Compare all eligible observations and each year, with 2020 preselected as a retrospective stress comparison. Daily variability verifies whether that year was more volatile in this sample. Nominal 5% exceedance is a reference rather than a promised frequency. Dependent observations, one index, price-only returns and one chosen window limit generalization. This baseline supports exploratory AISO/AI4Fintech/Earthian AI research themes only; it does not test proprietary technology, imply endorsement or provide investment advice.',
 analysisTitle:'Measure subsequent threshold breaches',resultTitle:'What held up under the stress comparison?',
 request:'User-authorized supporting demo: execute this exact local 252-prior-loss historical threshold against captured real FRED S&P 500 observations. Save two plots, yearly/overall exceedance statistics, daily calculation audit and targeted no-look-ahead checks. No trading, proprietary model comparison or app-model claim.'
}];
const node=(id,title,description,x,y,kind='topic')=>({id,title,description,x,y,kind,parentId:null,width:440});
async function create(p){
 const reportFile=path('examples/demo-'+p.key+'/native-project.json');
 if(existsSync(reportFile)){const saved=JSON.parse(readFileSync(reportFile,'utf8'));if(saved.status==='completed'){console.log(JSON.stringify(saved));return;}throw Error('An incomplete report exists; inspect its saved run before retrying.');}
 const existing=(await api('/api/projects')).find(x=>x.title===p.title);if(existing)throw Error('Project already exists; preserving '+existing.id);
 const project=await api('/api/projects',{title:p.title,start:'blank'}),scope='/api/projects/'+project.id;
 const report={projectId:project.id,title:p.title,createdAt:new Date().toISOString(),status:'creating',execution:'Actual local Docker Python, prepared code; no paid model/search requests.',sourceSha256:createHash('sha256').update(readFileSync(path(p.dataset))).digest('hex')};
 const save=()=>writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');save();
 try{
 const nodes=[node('question','The research question',p.question,0,0),node('source','Captured observations & provenance',p.source,520,0),node('method','A reproducible comparison',p.method,0,330),node('analysis',p.analysisTitle,p.request,520,330,'activity'),node('challenge','Challenge the interpretation',p.challenge,0,660),node('conclusion',p.resultTitle,'Saved result will be attached after the real calculation completes.',520,660)];
 const edges=[['question','source','motivates source review'],['source','analysis','provides data to'],['method','analysis','defines comparison'],['analysis','challenge','tests interpretation'],['challenge','conclusion','qualifies conclusion']];
 await api(scope+'/mutations',{expectedRevision:0,label:'Create requested supporting demonstration with disclosed evidence and limits',operations:[...nodes.map(node=>({type:'addNode',node})),...edges.map(([source,target,label],i)=>({type:'addConnection',connection:{id:'supporting-relation-'+i,source,target,label}}))]});
 // With no paid admission, this keeps original intent in the native project memory.
 const providers=await api('/api/connections');
 if(providers.every(x=>x.limitUsd===0))await api(scope+'/assistant/messages',{message:p.original});
 const connection=await api(scope+'/local-connections',{name:p.key==='amsterdam'?'KNMI Schiphol · complete 2024 local days':'FRED S&P 500 · daily close 2018–2021',kind:'csv',path:path(p.dataset)});
 const data=await api(scope+'/local-connections/'+connection.id+'/import',{nodeId:'source'});report.datasetArtifactId=data.id;report.connectionId=connection.id;save();
 assert.equal(data.hash,report.sourceSha256);
 await api(scope+'/inputs',{nodeId:'analysis',artifactId:data.id});
 const preview=await api(scope+'/experiments/preview',{nodeId:'analysis',request:p.request,datasetArtifactId:data.id,backend:'docker-python',code:readFileSync(path(p.code),'utf8'),parameters:{}});
 report.runId=preview.run.id;save();
 await api('/api/experiments/'+preview.run.id+'/decision',{fingerprint:preview.approval.fingerprint,decision:'allow'});
 let finished;
 for(let i=0;i<160;i++){const v=await api('/api/experiments/'+preview.run.id);if(!['queued','running'].includes(v.run.status)){finished=v.run;break;}await new Promise(r=>setTimeout(r,300));}
 assert.equal(finished?.status,'completed',finished?.error||'Run did not finish in 48 seconds; no retry was sent.');
 let detail=await api(scope);const outputs=detail.artifacts.filter(a=>a.runId===report.runId&&(['plot','table','metric','result'].includes(a.kind)||(a.kind==='dataset'&&a.title.startsWith('Daily calculation'))));
 const plots=outputs.filter(a=>a.kind==='plot');assert.equal(plots.length,2);
 const conclusion=outputs.find(a=>a.kind==='result');assert(conclusion);
 await api(scope+'/inputs',{nodeId:'challenge',artifactId:conclusion.id});
 await api(scope+'/inputs',{nodeId:'conclusion',artifactId:conclusion.id});
 for(const [i,a] of plots.entries())await api(scope+'/highlights',{nodeId:'analysis',artifactId:a.id,x:i*360,y:0});
 const latest=(await api(scope)).project;
 await api(scope+'/mutations',{expectedRevision:latest.revision,label:'Save editable conclusion from actual completed local calculation',operations:[{type:'updateNode',id:'conclusion',patch:{description:conclusion.content+'\n\nPrepared demonstration: open the analysis Action for the two saved plots and exact execution record. Code was prepared by the coding assistant; no app-model inference was used.'}}]});
 const outputPath=path('examples/demo-'+p.key+'/outputs');mkdirSync(outputPath,{recursive:true});
 const output=await api(scope+'/local-connections',{name:'Saved supporting demo outputs',kind:'output-folder',path:outputPath});
 const exported=await api(scope+'/local-connections/'+output.id+'/export',{artifactIds:outputs.map(a=>a.id)});
 detail=await api(scope);
 Object.assign(report,{status:'completed',completedAt:new Date().toISOString(),nodeIds:nodes.map(n=>n.id),artifactCount:detail.artifacts.length,plotArtifactIds:plots.map(a=>a.id),conclusionArtifactId:conclusion.id,conclusion:conclusion.content,metrics:outputs.filter(a=>a.kind==='metric').map(a=>({title:a.title,value:JSON.parse(a.content).value})),exportedFiles:exported.files,newPaidCalls:0});save();console.log(JSON.stringify(report,null,2));
 }catch(error){report.status='incomplete';report.error=error.message;save();throw error;}
}
for(const p of plans)await create(p);
