/** Disposable, explicitly illustrative local viewer fixture. No inference/execution. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {Store} from '../src/server/store.js';
import type {Artifact,Run} from '../src/shared/types.js';
const store=new Store('.ros-ai',{recoverInterrupted:false});
try {
 const project=store.getProject('269507ef-9f3a-4bef-a39c-0dd327e24df8');
 if(project.title!=='Workspace review · disposable September 30'||project.canvas.nodes.length)throw new Error('Fixture requires the exact empty disposable project; no other research is edited.');
 const note={id:randomUUID(),title:'What can these observations support?',description:'Illustrative viewer fixture: 80 authored rows. This is not observed research or an executed experiment.',kind:'topic' as const,x:0,y:0};
 const action={id:randomUUID(),title:'Inspect limits before analysis',description:'No work has run. Compare missing cells before choosing an analysis.',kind:'activity' as const,x:504,y:0};
 store.mutate(project.id,[{type:'addNode',node:note},{type:'addNode',node:action}],'Add disposable illustrative research blocks');
 const run:Run={id:randomUUID(),projectId:project.id,nodeId:note.id,request:'Manually authored local viewer fixture',useSearch:false,status:'running',createdAt:new Date().toISOString(),projectRevision:store.getProject(project.id).revision,node:note,inputs:[],messages:[],provider:'local',model:'manual-viewer-fixture',modelVersion:null,configuration:{kind:'manual-viewer-fixture',freshExecution:false},tools:[],events:[{at:new Date().toISOString(),type:'manual-fixture',message:'Authored illustrative data/image. No code, model or external request ran.'}],artifactIds:[]};
 store.createRun(run);
 const save=(input:Pick<Artifact,'kind'|'title'|'content'|'mediaType'>)=>store.addArtifact({...input,projectId:project.id,nodeId:note.id,runId:run.id,capture:'generated',metadata:{illustrative:true,contribution:'user interpretation',freshExecution:false}});
 const csv='row,category,value\n'+Array.from({length:80},(_,i)=>`${i+1},${i%2?'B':'A'},${(i+1)%10===0?'':(i+1)*2}`).join('\n');
 const dataset=save({kind:'dataset',title:'Illustrative observations · 80 rows',content:csv,mediaType:'text/csv'});
 const figure=save({kind:'plot',title:'Illustrative figure · saved SVG',content:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320"><rect width="640" height="320" fill="white"/><text x="38" y="38" font-size="22" fill="#253e3b">Illustrative observations</text><path d="M60 260H580M60 260V65" fill="none" stroke="#698580" stroke-width="2"/><path d="M70 245L130 210L200 195L280 160L360 130L440 110L560 80" fill="none" stroke="#32857a" stroke-width="4"/><text x="70" y="302" font-size="15" fill="#536864">Authored viewer fixture · no measured analysis</text></svg>',mediaType:'image/svg+xml'});
 const code=save({kind:'code',title:'Example analysis code · never executed',content:'# Illustrative retained-code fixture; no execution has run.\nmetric("Rows", len(df))\nfig, ax = plt.subplots()\nax.plot(df["row"], df["value"])\nplot("Illustrative observations", fig)',mediaType:'text/x-python'});
 store.updateRun(run.id,{status:'completed',endedAt:new Date().toISOString(),artifactIds:[dataset.id,figure.id,code.id]});
 store.mutate(project.id,[{type:'addNode',node:{id:randomUUID(),title:dataset.title,description:'Authored viewer fixture; source is immutable.',kind:'topic',blockType:'dataset',artifactId:dataset.id,x:0,y:360}},{type:'addNode',node:{id:randomUUID(),title:figure.title,description:'Authored image; no raw observations inferred from SVG.',kind:'topic',blockType:'figure',artifactId:figure.id,x:504,y:360}},{type:'addConnection',connection:{id:randomUUID(),source:note.id,target:action.id,label:'raises a question'}}],'Place exact illustrative dataset and figure blocks');
 const receipt={projectId:project.id,noteId:note.id,actionId:action.id,runId:run.id,datasetId:dataset.id,figureId:figure.id,codeId:code.id,rows:80,missingCells:8,modelCalls:0,executionCalls:0,externalCalls:0};
 writeFileSync('evidence/workspace-2026-09-30/fixture.json',JSON.stringify(receipt,null,2)+'\n');console.log(receipt);
}finally{store.close();}
