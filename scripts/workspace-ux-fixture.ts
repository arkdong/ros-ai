// Disposable offline UI fixture. Never uses the normal research data directory.
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/server/store.js';
import type {CanvasNode} from '../src/shared/types.js';
const dir='/private/tmp/ros-ai-workspace-ux-20260923-v2';
if(existsSync(dir+'/ros-ai.sqlite'))throw Error('Fixture exists; preserve it rather than reseeding.');
mkdirSync(dir,{recursive:true});const store=new Store(dir);
const project=store.createProject('Disposable workspace UX review');
const explanation='This is a synthetic interface fixture for checking readable previews, geometry and preservation. It does not claim an experiment ran, a source was retrieved, or a model was called. Full research context must remain available when this note is opened. ';
const note=(id:string,title:string,x:number,y:number,parentId?:string):CanvasNode=>({id,title,description:explanation.repeat(4),kind:id.includes('analysis')?'activity':'topic',x,y,...(parentId?{parentId}:{})});
const notes=[
 note('z-question','Research question: how should a workspace keep the complete original research context while presenting a concise readable canvas title?',0,0),
 note('a-hypothesis','Compare the plausible hypotheses and keep their full explanations accessible in the detailed research view',480,0),
 note('m-analysis','Analyze the captured observations and inspect numerical outputs without making unsupported causal claims',0,360),
 note('c-blocker','Alternative explanation to challenge',480,360),
 note('d-followup','Follow-up observation and interpretation',960,360),
 note('b-last','Outstanding evidence gaps',960,0),
 note('nested-a','A child note with a complete original explanation',0,0,'z-question'),
 note('nested-b','Second child deliberately positioned far away',1000,650,'z-question'),
 note('deep-child','Deeper branch',0,0,'nested-a'),
];
store.mutate(project.id,notes.map(node=>({type:'addNode',node})),'Offline fixture notes');
store.mutate(project.id,[
 {type:'addConnection',connection:{id:'vertical',source:'z-question',target:'m-analysis',label:'Tests the question'}},
 {type:'addConnection',connection:{id:'horizontal',source:'z-question',target:'a-hypothesis',label:'Compare assumptions'}},
 {type:'addConnection',connection:{id:'obstacle',source:'m-analysis',target:'d-followup',label:'Compare saved evidence'}},
 {type:'addConnection',connection:{id:'manual',source:'a-hypothesis',target:'c-blocker',label:'Chosen handles',sourceHandle:'left',targetHandle:'right'}},
 {type:'addConnection',connection:{id:'nested',source:'nested-b',target:'d-followup',label:'Cross-group context'}},
],'Offline fixture relationships');
const run=store.createRun({id:randomUUID(),projectId:project.id,nodeId:'z-question',node:notes[0],request:'Synthetic saved artifacts for interface verification; no real execution.',useSearch:false,status:'running',createdAt:new Date().toISOString(),projectRevision:project.revision,inputs:[],messages:[],provider:'offline-fixture',model:'no-model-called',modelVersion:null,configuration:{kind:'ui-fixture',offline:true},tools:[],events:[],artifactIds:[]});
const artifacts=[
 store.addArtifact({projectId:project.id,nodeId:'z-question',runId:run.id,kind:'metric',title:'Illustrative fixture count',content:'{"value":12}',capture:'generated'}),
 store.addArtifact({projectId:project.id,nodeId:'z-question',runId:run.id,kind:'table',title:'Illustrative fixture comparison',content:'[{"sample":"A","value":4},{"sample":"B","value":8}]',capture:'generated'}),
 store.addArtifact({projectId:project.id,nodeId:'z-question',runId:run.id,kind:'result',title:'Synthetic result for readable expansion',content:'Interface fixture only. No scientific finding or actual runtime success is claimed.',capture:'generated'}),
];
store.updateRun(run.id,{status:'completed',endedAt:new Date().toISOString(),artifactIds:artifacts.map(a=>a.id)});
store.addMessage(project.id,null,'user','How can I keep research readable while preserving its full context?');
writeFileSync('evidence/workspace-ux-2026-09-23/fixture.json',JSON.stringify({dataDir:dir,projectId:project.id,nodeIds:notes.map(n=>n.id),artifactIds:artifacts.map(a=>a.id),before:store.getProject(project.id).canvas,offline:true},null,2));store.close();console.log(project.id);
