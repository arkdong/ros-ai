import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'ros-ai-fresh-'));
let child;
const report={startedAt:new Date().toISOString(),node:process.version,checks:[]};
try{
  for(const path of ['package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','src'])cpSync(path,join(dir,path),{recursive:true});
  const install=spawnSync('npm',['ci'],{cwd:dir,encoding:'utf8',timeout:120000});
  assert.equal(install.status,0,install.stderr);report.installOutput=install.stdout;report.checks.push('Fresh npm ci from lockfile with no copied node_modules or credentials');
  let output='';
  child=spawn('npm',['start'],{cwd:dir,detached:true,env:{...process.env,ROS_PORT:'4318',ROS_DATA_DIR:join(dir,'data'),ROS_DEV:'0',NEBIUS_API_KEY:'',TAVILY_API_KEY:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk});
  let ready=false;
  for(let i=0;i<100;i++){try{const response=await fetch('http://127.0.0.1:4318/api/health');if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}
  assert(ready,output);assert.match(output,/Building the browser interface for first launch/);assert.match(output,/http:\/\/127.0.0.1:4318/);
  const providers=await(await fetch('http://127.0.0.1:4318/api/connections')).json();assert(providers.every(p=>!p.configured));
  const created=await fetch('http://127.0.0.1:4318/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Works without credentials'})});assert.equal(created.status,201);
  const html=await(await fetch('http://127.0.0.1:4318/')).text();assert.match(html,/assets\/index-/);
  report.checks.push('One normal npm start builds missing assets and serves both layers on loopback','No-credential canvas/API usable and providers visibly unconfigured');
  report.startOutput=output;report.status='passed';report.completedAt=new Date().toISOString();
}catch(error){report.status='failed';report.error=error.message;throw error;}
finally{if(child?.pid){try{process.kill(-child.pid,'SIGTERM')}catch{}await new Promise(resolve=>child.once('exit',resolve));}writeFileSync('evidence/fresh-setup.json',JSON.stringify(report,null,2)+'\n');rmSync(dir,{recursive:true,force:true});}
console.log('Fresh setup and one-command launch passed without credentials.');
