import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTimeline } from '../src/shared/content-timeline.js';
import type { Artifact, Run, ProjectDetail } from '../src/shared/types.js';

test('saved evidence is grouped by actual execution ownership without changing undo history',()=>{
  const node={id:'n',title:'Captured node title',description:'',x:0,y:0};
  const run:Run={id:'r',projectId:'p',nodeId:'n',node,request:'',useSearch:false,status:'completed',createdAt:'2026-09-23T10:00:00Z',projectRevision:1,inputs:[],messages:[],provider:'local',model:'python',modelVersion:null,configuration:{},tools:[],events:[],artifactIds:['result','plot','log']};
  const make=(id:string,kind:Artifact['kind'],createdAt:string):Artifact=>({id,kind,createdAt,projectId:'p',nodeId:'n',runId:'r',title:id,content:id,hash:id});
  const detail:Pick<ProjectDetail,'project'|'changes'|'runs'|'artifacts'>={project:{id:'p',title:'Now',revision:2,canvas:{nodes:[node],connections:[]},createdAt:'2026-09-23T09:00:00Z',updatedAt:'2026-09-23T11:00:00Z'},changes:[{id:'edit',projectId:'p',revision:2,label:'Edit note',canvas:{nodes:[node],connections:[]},createdAt:'2026-09-23T11:00:00Z'}],runs:[run],artifacts:[make('plot','plot','2026-09-23T10:02:00Z'),make('result','result','2026-09-23T10:03:00Z'),make('log','log','2026-09-23T10:04:00Z'),make('orphan','metric','2026-09-23T10:05:00Z'),{...make('foreign','metric','2026-09-23T10:06:00Z'),projectId:'other'}]};
  const before=structuredClone(detail),entries=contentTimeline(detail);
  assert.equal(entries.length,2);
  assert.equal(entries[0].kind,'canvas');
  const evidence=entries[1];assert.equal(evidence.kind,'evidence');
  if(evidence.kind==='evidence'){
    assert.equal(evidence.title,'Captured node title');
    assert.equal(evidence.createdAt,'2026-09-23T10:03:00Z');
    assert.deepEqual(evidence.artifacts.map(a=>a.id),['result','plot']);
  }
  assert.deepEqual(detail,before);
});

test('empty projects have no invented evidence milestones',()=>{
  assert.deepEqual(contentTimeline({project:{id:'p',title:'Empty',revision:0,canvas:{nodes:[],connections:[]},createdAt:'',updatedAt:''},changes:[],runs:[],artifacts:[]}),[]);
});
