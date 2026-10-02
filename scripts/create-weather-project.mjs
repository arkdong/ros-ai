import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

if(!process.argv.includes('--create'))throw Error('Pass --create to add the real-weather prerequisite project through the local app. No provider work is started.');
const base=process.env.ROS_EXAMPLE_URL||'http://127.0.0.1:4310';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Local API required.');
const api=async(path,body)=>{const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const title='Amsterdam cycling & weather — evidence first';
const projects=await api('/api/projects'),existing=projects.find(p=>p.title===title);if(existing){console.log(JSON.stringify({status:'already-exists',projectId:existing.id}));process.exit(0);}
const before=await Promise.all(projects.map(async p=>[p.id,digest(await api('/api/projects/'+p.id))]));
const usage=digest(await api('/api/usage'));
const brief=readFileSync(new URL('../examples/amsterdam-cycling-weather/research-brief.md',import.meta.url),'utf8');
const project=await api('/api/projects',{title}),scope='/api/projects/'+project.id;
const nodes=[
  {id:'amsterdam-question',title:'Amsterdam cycling & weather',kind:'topic',description:'Research question: how is rainfall associated with cycling counts, and do weekdays/weekends differ? Real weather is available; cycling observations are missing. No cycling relationship has been measured. Explore prerequisites and preserve the evidence gap.',x:0,y:0,parentId:null},
  {id:'weather-prerequisite',title:'Audit the real weather data',kind:'activity',description:brief.slice(0,19000),x:0,y:0,parentId:'amsterdam-question'},
  {id:'cycling-gap',title:'Cycling observations needed',kind:'topic',description:'NDW candidate Amsterdam radar stations are verified (Erasmusgracht and Zuiderzeeweg), but public count exports require email/CAPTCHA or authenticated API access. No export was submitted. Import a licensed count CSV with site, dates, interval/time zone, directions, coverage and quality flags before joining. Weather alone cannot answer the cycling question.',x:336,y:0,parentId:'amsterdam-question'},
  {id:'sources-and-alignment',title:'Sources & local-day alignment',kind:'topic',description:'KNMI station 240 Schiphol: 8,784 actual hourly observations for 2024 aggregated into 366 Europe/Amsterdam local days. CC BY 4.0; attribute Royal Netherlands Meteorological Institute (KNMI). Rain traces counted as zero, with trace counts retained. DST days have 23/25 hours. Schiphol is a regional weather proxy, not a bicycle-site rain gauge. Source and preparation files are in examples/amsterdam-cycling-weather/.',x:936,y:0,parentId:null},
  {id:'season-question',title:'Does the pattern vary by season?',kind:'topic',description:'Suggested user-directed follow-up after the first analysis: compare precipitation distributions by weekday/weekend within season and assess trace-as-zero versus 0.025 mm per trace hour. This remains a weather prerequisite until cycling counts are available. Use Continue to preserve the original analysis.',x:936,y:240,parentId:null},
];
await api(scope+'/mutations',{label:'Create requested real-weather research prerequisite; cycling counts explicitly missing',expectedRevision:0,operations:nodes.map(node=>({type:'addNode',node}))});
const connection=await api(scope+'/local-connections',{name:'KNMI Schiphol 2024 — real observations',kind:'csv',path:fileURLToPath(new URL('../examples/amsterdam-cycling-weather/schiphol-weather-2024.csv',import.meta.url))});
const dataset=await api(scope+'/local-connections/'+connection.id+'/import',{nodeId:'weather-prerequisite'});
assert.equal(dataset.hash,'52ab235da9f5c4581d483d23c7404baa08cffe1ada87b1945c90ba7f7640df1a');
const outputPath=fileURLToPath(new URL('../.ros-ai/exports/amsterdam-weather/',import.meta.url));mkdirSync(outputPath,{recursive:true});
const output=await api(scope+'/local-connections',{name:'Amsterdam weather generated outputs',kind:'output-folder',path:outputPath});
assert.equal(digest(await api('/api/usage')),usage);
for(const [id,old]of before)assert.equal(digest(await api('/api/projects/'+id)),old,'Existing project changed');
const report={at:new Date().toISOString(),projectId:project.id,title,datasetArtifactId:dataset.id,sourceHash:dataset.hash,connectionId:connection.id,outputConnectionId:output.id,nodeId:'weather-prerequisite',status:'ready-for-authorized-model-research',data:'Real KNMI weather; bicycle counts unavailable. No model planning or experiment has been claimed.',existingProjectsUnchanged:true,providerLedgerUnchanged:true};
mkdirSync(new URL('../evidence/collaborator/',import.meta.url),{recursive:true});writeFileSync(new URL('../evidence/collaborator/weather-project.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
