// Explicit local-app verification steps; never resets provider accounting.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const base='http://127.0.0.1:4310', root='evidence/continuous-collaborator';
const api=async(path,body)=>{const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const projectFile=`${root}/live-project.json`;
if(process.argv[2]==='create'){
  if(existsSync(projectFile))throw Error('Verification project already exists; do not duplicate.');
  const p=await api('/api/projects',{title:'Schiphol weather · live assistant research',start:'blank'});writeFileSync(projectFile,JSON.stringify({projectId:p.id,createdAt:new Date().toISOString(),operator:'Coding assistant exercising the real application; prompts are demonstration inputs, not additional user assertions.'},null,2));
  const r=await fetch(base+`/api/projects/${p.id}/policy`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'ask',scope:'Public KNMI weather research demonstration with exact experiment approvals; no private data, purchases, or unrestricted tools.',nodeIds:[],datasetIds:[],allowActionCreation:false,limits:{experiments:6,modelCalls:10,createdActions:6,runtimeSeconds:180,spendUsd:10}})});if(!r.ok)throw Error(await r.text());console.log(p.id);
}else{
  const p=JSON.parse(readFileSync(projectFile,'utf8')),step=process.argv[2],file=`${root}/live-${step}.json`;
  if(!/^[1-6]$/.test(step)||existsSync(file))throw Error('Choose one unrecorded step 1–6; no implicit retry.');
  const message=readFileSync(process.argv[3],'utf8');writeFileSync(file,JSON.stringify({projectId:p.projectId,message,startedAt:new Date().toISOString(),status:'about-to-submit'},null,2));
  const initial=await api(`/api/projects/${p.projectId}/assistant/messages`,{message,focus:{nodeId:null}}),turnId=initial.activeTurnId;
  for(let i=0;i<220;i++){
    await new Promise(r=>setTimeout(r,500));const state=await api(`/api/projects/${p.projectId}/assistant`),turn=state.turns.find(t=>t.id===turnId);
    if(turn.status!=='running'){writeFileSync(file,JSON.stringify({projectId:p.projectId,message,turn,finishedAt:new Date().toISOString()},null,2));console.log(JSON.stringify({turnId,status:turn.status,error:turn.error,reply:turn.reply,actions:turn.actions},null,2));break;}
    if(i===219)throw Error('Turn still active; inspect saved state, do not resubmit.');
  }
}
