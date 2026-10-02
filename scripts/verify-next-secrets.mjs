import { parse } from 'dotenv';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const keys=existsSync('.env.local')?Object.entries(parse(readFileSync('.env.local'))).filter(([name,value])=>/API_KEY$/.test(name)&&value.length>8):[];
function files(root){return readdirSync(root).flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory()?files(path):[path];});}
const matches=[];
for(const path of [...files('dist/client'),...files('src'),...files('docs'),...files('evidence'),...files('scripts')]){
  const content=readFileSync(path);for(const [name,key] of keys)if(content.includes(Buffer.from(key)))matches.push({path,credentialName:name});
}
const base=process.env.ROS_VERIFY_URL || 'http://127.0.0.1:4317';
if(new URL(base).port==='4310')throw Error('Inspect the isolated server, not saved user projects.');
for(const route of ['/api/connections','/api/projects','/api/usage','/api/experiments/capabilities']){
  const text=await(await fetch(base+route)).text();for(const [name,key] of keys)if(text.includes(key))matches.push({route,credentialName:name});
}
const report={checkedAt:new Date().toISOString(),status:matches.length?'failed':'passed',credentialCount:keys.length,checked:'Browser bundle, application sources, docs, evidence (including new live records), scripts and isolated API responses compared to configured credential values; no values emitted.',matches};
writeFileSync('evidence/next-build/secret-scan.json',JSON.stringify(report,null,2)+'\n');
if(matches.length)throw new Error('Credential value found outside server config; inspect report paths without printing values.');
console.log('Secret scan passed; no credential values emitted.');
