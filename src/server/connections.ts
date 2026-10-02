import { constants, closeSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import type { Artifact, Run } from '../shared/types.js';
import type { Highlight, LocalConnection, ProjectResource, ResourcePreview } from '../shared/research.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
type StoredConnection=LocalConnection & {device:number;inode:number};
type CopiedResource=ProjectResource & {storage:'copied';content:string};
const MAX_CSV_BYTES=500000;
export interface DataConnector {readonly kind:string; read(connection:LocalConnection):{content:string;hash:string;metadata:Record<string,unknown>};}
/** Source access is a server operation on a separately selected file. Models get
 * immutable CSV copies, never paths, file descriptors, credentials or this API. */
export class LocalConnections {
  constructor(private store:Store){}
  list(projectId:string):LocalConnection[]{return this.store.records<StoredConnection>('connection',projectId).map(({device:_,inode:__,...value})=>value);}
  resources(projectId:string):ProjectResource[] {
    const linked:ProjectResource[]=this.list(projectId).filter(connection=>connection.kind==='csv').map(connection=>({id:connection.id,projectId,name:connection.name,storage:'linked',kind:'csv',createdAt:connection.createdAt,path:connection.path,fileName:basename(connection.path),connectionId:connection.id,originKey:`connection:${connection.id}`}));
    const copied=this.store.records<CopiedResource>('resource-copy',projectId).map(({content:_,...resource})=>({...resource,originKey:`copy:${resource.id}`}));
    const artifacts=this.store.listArtifacts(projectId), byId=new Map(artifacts.map(artifact=>[artifact.id,artifact]));
    const origin=(artifact:Artifact):Artifact=>{
      const seen=new Set<string>(); let current=artifact;
      while(typeof current.metadata?.sourceArtifactId==='string'&&!seen.has(current.id)) {
        seen.add(current.id); const source=byId.get(current.metadata.sourceArtifactId);
        // An excerpt or transformed table is a distinct resource, even when it
        // points at a source. Only exact input recaptures share this identity.
        if(!source||source.kind!==current.kind||source.hash!==current.hash)break;
        current=source;
      }
      return current;
    };
    const captured:ProjectResource[]=artifacts.filter(artifact=>artifact.kind==='dataset'||artifact.kind==='source').map(artifact=>{
      const source=origin(artifact);
      const originKey=typeof source.metadata?.connectionId==='string'?`connection:${source.metadata.connectionId}`:typeof source.metadata?.resourceId==='string'?`copy:${source.metadata.resourceId}`:`artifact:${source.id}`;
      return {id:artifact.id,projectId,name:artifact.title,storage:'captured',kind:artifact.kind==='dataset'?'csv':'source',createdAt:artifact.createdAt,bytes:Buffer.byteLength(artifact.content,'utf8'),hash:artifact.hash,artifactId:artifact.id,nodeId:artifact.nodeId,originKey,...(artifact.url?{url:artifact.url}:{}),...(artifact.locator?{locator:artifact.locator}:{})};
    });
    return [...linked,...copied,...captured].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
  }
  addResource(projectId:string,supplied:unknown):ProjectResource {
    this.store.getProject(projectId);
    const name=z.string().trim().min(1).max(160);
    const body=z.discriminatedUnion('mode',[
      z.object({mode:z.literal('link'),name,path:z.string().min(1).max(4000)}).strict(),
      z.object({mode:z.literal('copy'),name,fileName:z.string().min(1).max(255),content:z.string().min(1).max(MAX_CSV_BYTES)}).strict(),
    ]).parse(supplied);
    if(body.mode==='link') {const connection=this.add(projectId,{name:body.name,path:body.path,kind:'csv'});return this.resources(projectId).find(resource=>resource.id===connection.id)!;}
    const fileName=body.fileName.split(/[\\/]/u).at(-1)!;
    if(extname(fileName).toLowerCase()!=='.csv')throw new StoreError('Choose a UTF-8 CSV file. Other file types are not supported yet.');
    const bytes=Buffer.byteLength(body.content,'utf8');
    if(bytes>MAX_CSV_BYTES)throw new StoreError('CSV files must be no larger than 500 KB (500,000 bytes).');
    if(body.content.includes('\0'))throw new StoreError('CSV contains binary data.');
    const resource:CopiedResource={id:randomUUID(),projectId,name:body.name,kind:'csv',storage:'copied',fileName,bytes,hash:hash(body.content),createdAt:now(),content:body.content};
    this.store.saveRecord('resource-copy',resource.id,projectId,resource);
    const {content:_,...summary}=resource;return summary;
  }
  previewResource(projectId:string,id:string):ResourcePreview {
    const resource=this.resources(projectId).find(item=>item.id===id);
    if(!resource)throw new StoreError('Resource not found in this project.',404);
    if(resource.storage==='linked') {const capture=this.read(projectId,resource.connectionId!);return {resource:{...resource,bytes:Number(capture.metadata.bytes),hash:capture.hash},content:capture.content,hash:capture.hash};}
    if(resource.storage==='copied') {const copied=this.store.record<CopiedResource>('resource-copy',id)!;return {resource,content:copied.content,hash:copied.hash!};}
    const artifact=this.store.getArtifact(resource.artifactId!);return {resource,content:artifact.content,hash:artifact.hash};
  }
  useResource(projectId:string,id:string,nodeId:string):Artifact {
    const resource=this.resources(projectId).find(item=>item.id===id);
    if(!resource)throw new StoreError('Resource not found in this project.',404);
    if(resource.storage==='captured') {const artifact=this.store.getArtifact(resource.artifactId!);this.store.addInput(projectId,nodeId,artifact.id);return artifact;}
    if(resource.storage==='linked')return this.import(projectId,resource.connectionId!,nodeId);
    const source=this.previewResource(projectId,id);
    const googleDrive=this.store.record('google-drive-capture',id);
    return this.capture(projectId,nodeId,{content:source.content,hash:source.hash,metadata:{resourceId:id,fileName:resource.fileName!,bytes:resource.bytes!,capturedAt:now(),permission:'immutable project copy',origin:googleDrive?'google-drive':'browser-upload',...(googleDrive?{googleDrive}:{})}});
  }
  add(projectId:string,supplied:unknown):LocalConnection {
    const body=z.object({name:z.string().trim().min(1).max(160),kind:z.enum(['csv','output-folder']),path:z.string().min(1).max(4000)}).strict().parse(supplied);
    if(!isAbsolute(body.path))throw new StoreError('Select an absolute local file or folder path.');
    const path=realpathSync(body.path), info=statSync(path);
    if(body.kind==='csv'&&(!info.isFile()||extname(path).toLowerCase()!=='.csv'||info.size>500000))throw new StoreError('Select a CSV file no larger than 500 KB.');
    if(body.kind==='output-folder'&&!info.isDirectory())throw new StoreError('Select an existing output folder.');
    const timestamp=now(),connection:StoredConnection={id:randomUUID(),projectId,...body,path,writable:body.kind==='output-folder',createdAt:timestamp,updatedAt:timestamp,device:info.dev,inode:info.ino};
    this.store.saveRecord('connection',connection.id,projectId,connection);return this.list(projectId).find(c=>c.id===connection.id)!;
  }
  private get(projectId:string,id:string):StoredConnection {const c=this.store.record<StoredConnection>('connection',id);if(!c||c.projectId!==projectId)throw new StoreError('Local connection not found.',404);return c;}
  private unchanged(c:StoredConnection) {const actual=realpathSync(c.path),info=statSync(actual);if(actual!==c.path||info.dev!==c.device||info.ino!==c.inode)throw new StoreError('The selected path was replaced or redirected; select the connection again.');return info;}
  setWritable(projectId:string,id:string,writable:boolean){const c=this.get(projectId,id);this.unchanged(c);c.writable=writable;c.updatedAt=now();this.store.saveRecord('connection',id,projectId,c);return this.list(projectId).find(v=>v.id===id)!;}
  read(projectId:string,id:string){
    const c=this.get(projectId,id);if(c.kind!=='csv')throw new StoreError('This connection is not a CSV source.');
    this.unchanged(c);const fd=openSync(c.path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const info=fstatSync(fd);if(info.dev!==c.device||info.ino!==c.inode||info.size>MAX_CSV_BYTES)throw new StoreError('CSV identity or size changed.');
      // Bound the actual read as well as the initial stat, including a source
      // that grows while open. Decode strictly so hashes never hide replacement bytes.
      const bytes=Buffer.alloc(MAX_CSV_BYTES+1);let length=0;
      while(length<bytes.length){const read=readSync(fd,bytes,length,bytes.length-length,null);if(!read)break;length+=read;}
      if(length>MAX_CSV_BYTES)throw new StoreError('CSV files must be no larger than 500 KB (500,000 bytes).');
      let content:string;
      try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length));}
      catch{throw new StoreError('CSV is not valid UTF-8 text. Save it as UTF-8 before importing.');}
      if(content.includes('\0'))throw new StoreError('CSV contains binary data.');
      return {content,hash:hash(content),metadata:{connectionId:c.id,fileName:basename(c.path),bytes:length,capturedAt:now(),permission:'read-only captured copy'}};
    }finally{closeSync(fd);}
  }
  import(projectId:string,id:string,nodeId:string):Artifact {
    return this.capture(projectId,nodeId,this.read(projectId,id));
  }
  private capture(projectId:string,nodeId:string,source:{content:string;hash:string;metadata:Record<string,unknown>}):Artifact {
    const project=this.store.getProject(projectId),node=project.canvas.nodes.find(n=>n.id===nodeId);if(!node)throw new StoreError('Node not found.');
    return this.store.atomic(()=>{
      const run:Run={id:randomUUID(),projectId,nodeId,request:`Import selected CSV: ${source.metadata.fileName}`,useSearch:false,status:'running',createdAt:now(),startedAt:now(),projectRevision:project.revision,node,inputs:[],messages:[],provider:'local',model:'local-file-connector-v1',modelVersion:null,configuration:{kind:'file-import',...source.metadata,sourceHash:source.hash},tools:[],events:[],artifactIds:[]};this.store.createRun(run);
      const artifact=this.store.addArtifact({projectId,nodeId,runId:run.id,kind:'dataset',title:String(source.metadata.fileName),content:source.content,mediaType:'text/csv',capture:'full-content',metadata:source.metadata});
      this.store.updateRun(run.id,{status:'completed',endedAt:now(),artifactIds:[artifact.id]});this.store.addInput(projectId,nodeId,artifact.id);return artifact;
    });
  }
  export(projectId:string,id:string,artifactIds:string[]){
    const c=this.get(projectId,id);if(c.kind!=='output-folder'||!c.writable)throw new StoreError('This connection has no output-folder write permission.',403);this.unchanged(c);
    if(!artifactIds.length||artifactIds.length>50)throw new StoreError('Choose 1–50 artifacts to export.');
    const artifacts=artifactIds.map(id=>this.store.getArtifact(id));if(artifacts.some(a=>a.projectId!==projectId))throw new StoreError('Choose artifacts from this project.');
    const files=artifacts.map(a=>{const suffix=a.mediaType==='image/svg+xml'?'.svg':a.mediaType==='text/csv'?'.csv':a.kind==='code'?'.py':a.mediaType==='application/json'?'.json':'.md';const path=join(c.path,`${a.title.replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,70)}-${a.id}-${randomUUID().slice(0,8)}${suffix}`);writeFileSync(path,a.content,{flag:'wx',mode:0o600});return {artifactId:a.id,hash:a.hash,path};});
    const record={id:randomUUID(),connectionId:id,at:now(),files};this.store.saveRecord('export',record.id,projectId,record);return record;
  }
  replace(projectId:string,id:string,expectedHash:string,content:string){
    const c=this.get(projectId,id);if(c.kind!=='csv'||!c.writable)throw new StoreError('Original source is read-only. A separate connection write permission is required.',403);this.unchanged(c);
    z.string().min(1).max(500000).parse(content);if(content.includes('\0'))throw new StoreError('CSV contains binary data.');
    const fd=openSync(c.path,constants.O_RDWR|constants.O_NOFOLLOW);
    try {const info=fstatSync(fd);if(info.dev!==c.device||info.ino!==c.inode)throw new StoreError('Source identity changed.');const previous=readFileSync(fd,'utf8');if(hash(previous)!==expectedHash)throw new StoreError('Source changed; inspect it before modifying.',409);
      const audit={id:randomUUID(),connectionId:id,at:now(),previous,previousHash:expectedHash,nextHash:hash(content)};this.store.saveRecord('source-write',audit.id,projectId,audit);
      const data=Buffer.from(content);let offset=0;while(offset<data.length)offset+=writeSync(fd,data,offset,data.length-offset,offset);ftruncateSync(fd,data.length);return {hash:audit.nextHash,backupId:audit.id};
    }finally{closeSync(fd);}
  }
}
export class Highlights {
  constructor(private store:Store){}
  save(projectId:string,supplied:unknown,id?:string){
    const body=z.object({nodeId:z.string(),artifactId:z.string().optional(),x:z.number().finite().min(-1000000).max(1000000),y:z.number().finite().min(-1000000).max(1000000)}).strict().parse(supplied);
    const old=id?this.store.record<Highlight>('highlight',id):undefined;if(id&&(!old||old.projectId!==projectId))throw new StoreError('Highlight not found.',404);
    const artifact=this.store.getArtifact(body.artifactId??old?.artifactId??'');if(artifact.projectId!==projectId)throw new StoreError('Choose an artifact in this project.');
    if(!this.store.getProject(projectId).canvas.nodes.some(n=>n.id===body.nodeId))throw new StoreError('Choose an active group.');
    if(artifact.nodeId!==body.nodeId)this.store.addInput(projectId,body.nodeId,artifact.id);
    const highlight:Highlight={id:id??randomUUID(),projectId,nodeId:body.nodeId,artifactId:artifact.id,x:body.x,y:body.y,createdAt:old?.createdAt??now()};return this.store.saveRecord('highlight',highlight.id,projectId,highlight);
  }
  remove(projectId:string,id:string){this.store.removeRecord('highlight',id,projectId);}
}
