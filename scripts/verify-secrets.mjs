import { parse } from 'dotenv';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const keys=Object.entries(parse(readFileSync('.env.local'))).filter(([name,value])=>/API_KEY$/.test(name)&&value.length>8);
function files(root){return readdirSync(root).flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory()?files(path):[path];});}
const matches=[];
for(const path of [...files('dist/client'),...files('src'),...files('docs'),...files('evidence')]){
  const content=readFileSync(path);for(const [name,key] of keys)if(content.includes(Buffer.from(key)))matches.push({path,credentialName:name});
}
for(const route of ['/api/connections','/api/projects','/api/usage']){
  const text=await(await fetch('http://127.0.0.1:4310'+route)).text();for(const [name,key] of keys)if(text.includes(key))matches.push({route,credentialName:name});
}
const report={checkedAt:new Date().toISOString(),status:matches.length?'failed':'passed',credentialCount:keys.length,checked:'Browser bundle, application sources, docs, evidence and public API responses compared to configured key values without printing any value.',matches};
writeFileSync('evidence/secret-scan.json',JSON.stringify(report,null,2)+'\n');
if(matches.length)throw new Error('Configured credential value found outside server config; inspect evidence/secret-scan.json.');
console.log('Secret scan passed; no credential values emitted.');
