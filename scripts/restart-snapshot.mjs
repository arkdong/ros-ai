import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const api=async path=>(await fetch('http://127.0.0.1:4310'+path)).json();
const projects=await api('/api/projects');const details=await Promise.all(projects.map(p=>api('/api/projects/'+p.id)));const usage=await api('/api/usage');
assert(details.every(d=>d.runs.every(r=>!['queued','running'].includes(r.status))),'Wait for active live verification before testing restart.');
const hash=createHash('sha256').update(JSON.stringify({projects,details,usage})).digest('hex');
const snapshot={capturedAt:new Date().toISOString(),hash,projects:projects.length,nodes:details.reduce((n,d)=>n+d.project.canvas.nodes.length,0),connections:details.reduce((n,d)=>n+d.project.canvas.connections.length,0),messages:details.reduce((n,d)=>n+d.messages.length,0),proposals:details.reduce((n,d)=>n+d.proposals.length,0),runs:details.reduce((n,d)=>n+d.runs.length,0),artifacts:details.reduce((n,d)=>n+d.artifacts.length,0),inputs:details.reduce((n,d)=>n+d.inputs.length,0),history:details.reduce((n,d)=>n+d.changes.length,0),usageRecords:usage.length};
if(process.argv[2]==='before'){writeFileSync('evidence/restart-before.json',JSON.stringify(snapshot,null,2)+'\n');console.log('Captured all local project/history/run/artifact state before restart.');}
else{const before=JSON.parse(readFileSync('evidence/restart-before.json','utf8'));assert.equal(snapshot.hash,before.hash,'Persisted API state changed across clean restart.');writeFileSync('evidence/restart.json',JSON.stringify({status:'passed',before,after:snapshot,checks:['All persisted API state identical after process restart','No duplicate run or provider usage request appeared']},null,2)+'\n');console.log('Restart preserved all project and provider-ledger state exactly.');}
