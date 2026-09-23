import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import type { Run, Mutation } from '../shared/types.js';

/** Bundled, attributed public data. This starter never claims a model or
 * experiment ran; the user can inspect its source before requesting research. */
export function seedDemo(store:Store,projectId:string){
  const ids=['question','weather','analysis','follow-up'].map(()=>randomUUID());
  const descriptions=[
    ['Weather, patterns & evidence','Which seasonal patterns appear in Schiphol’s 2024 weather observations, and what can we responsibly infer? Start by clarifying the question with the assistant.','topic'],
    ['KNMI weather · 2024','366 daily rows derived from 8,784 hourly KNMI observations at station 240 (Schiphol). Captured 21 September 2026. Public weather observations; no cycling counts. Inspect the saved CSV and source note.','topic'],
    ['Explore the seasonal pattern','Compare monthly temperature, rainfall and wind. Ask the assistant to discover source documentation and propose exact code against the captured CSV. No analysis has run in this starter.','activity'],
    ['Challenge the conclusion','Explicitly select a result from the first experiment, then test its robustness in a follow-up. A relationship alone does not import data or schedule execution.','activity'],
  ];
  const operations:Mutation[]=descriptions.map(([title,description,kind],i)=>({type:'addNode',node:{id:ids[i],title,description,kind:kind as 'topic'|'activity',parentId:null,x:(i%2)*432,y:Math.floor(i/2)*288}}));
  operations.push(...[[0,1],[1,2],[2,3]].map(([a,b])=>({type:'addConnection' as const,connection:{id:randomUUID(),source:ids[a],target:ids[b],label:''}})));
  store.mutate(projectId,operations,'Explore the public weather example');
  const project=store.getProject(projectId),at=new Date().toISOString();
  const run:Run={id:randomUUID(),projectId,nodeId:ids[1],request:'Load the bundled public KNMI example',useSearch:false,status:'running',createdAt:at,startedAt:at,projectRevision:project.revision,node:project.canvas.nodes.find(n=>n.id===ids[1])!,inputs:[],messages:[],provider:'local',model:'bundled-public-data-v1',modelVersion:null,configuration:{kind:'example-data-import',preparedBy:'coding assistant',autonomousResearch:false},tools:[],events:[],artifactIds:[]};store.createRun(run);
  const csv=readFileSync(new URL('../../examples/amsterdam-cycling-weather/schiphol-weather-2024.csv',import.meta.url),'utf8');
  const data=store.addArtifact({projectId,nodeId:ids[1],runId:run.id,kind:'dataset',title:'Schiphol daily weather · 2024',content:csv,mediaType:'text/csv',capture:'full-content',metadata:{source:'KNMI station 240',retrievedAt:'2026-09-21T21:25:14.138635+00:00',preparedBy:'coding assistant',autonomousResearch:false}});
  const source=store.addArtifact({projectId,nodeId:ids[1],runId:run.id,kind:'source',title:'KNMI provenance and limitations',url:'https://www.daggegevens.knmi.nl/klimatologie/uurgegevens',capture:'full-content',content:'Bundled data was retrieved from KNMI station 240 on 21 September 2026 and aggregated to local Amsterdam calendar days. Raw response and preparation code are preserved in examples/amsterdam-cycling-weather. This is an attributed local example prepared by the coding assistant, not a new live application search or autonomous experiment. Schiphol is a weather station proxy; the dataset contains no cycling counts. A weather association cannot establish cycling demand or causality.'});
  store.updateRun(run.id,{status:'completed',endedAt:at,artifactIds:[data.id,source.id]});
  store.addInput(projectId,ids[1],data.id);
  store.addMessage(projectId,null,'system','This example contains real, previously captured public KNMI weather data and four starter notes. No model inference, web search or experiment has run in this new project. Ask a question, inspect the data, then approve an experiment.');
  return store.getProject(projectId);
}
