// Inspect only values already configured locally; report names/paths, never values.
import {parse} from 'dotenv';
import {readdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const credentials=Object.entries(parse(readFileSync('.env.local'))).filter(([name,value])=>/(API_KEY|PROJECT_ID)$/.test(name)&&value.length>8);
const walk=root=>readdirSync(root).flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory()?walk(path):[path];});
const paths=['src','docs','evidence','scripts','examples','public','dist/client'].flatMap(walk).concat(['README.md','RESULT.md','WORKLOG.md','.env.example']);
const matches=[];
for(const path of paths){const content=readFileSync(path);for(const[name,value]of credentials)if(content.includes(Buffer.from(value)))matches.push({path,credentialName:name});}
for(const path of ['/api/connections','/api/experiments/capabilities','/api/usage']){const text=await fetch('http://127.0.0.1:4310'+path).then(r=>r.text());for(const[name,value]of credentials)if(text.includes(value))matches.push({api:path,credentialName:name});}
const report={at:new Date().toISOString(),status:matches.length?'failed':'passed',credentialCount:credentials.length,filesChecked:paths.length,checked:'Configured API keys and provider project ID compared to source/docs/evidence/scripts/examples/public/build and read-only local API responses. No credential values emitted.',matches};
writeFileSync(process.argv[2] || 'evidence/continuous-collaborator/secret-scan.json',JSON.stringify(report,null,2));
if(matches.length)throw Error('Sensitive values detected; inspect report paths without printing contents.');
console.log('Secret scan passed; no credential values emitted.');
