import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorkspaceGuideReviewInput, WorkspaceGuideManifest } from '../shared/workspace-guide.js';
import { StoreError, type Store } from './store.js';

const id=z.string().min(1).max(120);
export const guideInputSchema=z.object({intent:z.enum(['structure','inputs-outputs','conclusion']),nodeIds:z.array(id).max(100),metadataFields:z.array(z.enum(['title','description','relationships'])).max(3),contentNodeIds:z.array(id).max(20),artifacts:z.array(z.object({artifactId:id,hash:z.string().regex(/^[a-f0-9]{64}$/),excerpt:z.string().min(1).max(12000).optional()}).strict()).max(20),message:z.string().trim().max(4000).optional(),connectionId:id,model:z.string().min(1).max(160),connectionRevision:z.number().int().nonnegative(),acknowledgedDestination:z.literal(true)}).strict();
export type CapturedGuideContext={projectRevision:number;manifest:WorkspaceGuideManifest;packet:Record<string,unknown>;nodeAliases:Record<string,string>;artifactAliases:Record<string,string>;noteHashes:Record<string,string>};
export const noteHash=(note:{title:string;description:string})=>createHash('sha256').update(JSON.stringify({title:note.title,description:note.description})).digest('hex');

/** Build from an allowlist, never from assistant memory, project chats or logs. */
export function captureGuideContext(store:Store,projectId:string,input:WorkspaceGuideReviewInput):CapturedGuideContext{
  const project=store.getProject(projectId),byNode=new Map(project.canvas.nodes.map(n=>[n.id,n]));
  const requested=[...new Set(input.nodeIds)],content=[...new Set(input.contentNodeIds)],fields=[...new Set(input.metadataFields)];
  for(const nodeId of [...requested,...content])if(!byNode.has(nodeId))throw new StoreError('Choose guide context only from this project.');
  if((fields.length||content.length)&&!requested.length)throw new StoreError('Select the specific blocks before including metadata or content.');
  if(content.some(nodeId=>!requested.includes(nodeId)))throw new StoreError('Content must belong to an explicitly selected block.');
  if(input.intent==='conclusion'&&(!input.artifacts.length||(!content.length&&!input.message)))throw new StoreError('A conclusion review requires selected evidence and a selected conclusion or deliberately typed question.');
  const nodes=requested.map(nodeId=>byNode.get(nodeId)!);
  const nodeAliases=Object.fromEntries(nodes.map((n,i)=>[`b${i+1}`,n.id])),reverse=new Map(Object.entries(nodeAliases).map(([alias,nodeId])=>[nodeId,alias]));
  const omissions:string[]=[],noteHashes:Record<string,string>={};
  const clipped=(value:string,limit:number,label:string)=>{if(value.length>limit)omissions.push(`${label} is limited to ${limit} characters.`);return value.slice(0,limit);};
  const structural=nodes.map(n=>{
    const alias=reverse.get(n.id)!;
    const item:Record<string,unknown>={ref:alias,kind:n.kind??'unspecified',blockType:n.blockType??(n.kind==='group'?'group':n.kind==='activity'?'action':'note'),parent:reverse.get(n.parentId??'')??null};
    if(n.parentId&&!reverse.has(n.parentId))item.parentOmitted=true;
    if(requested.includes(n.id)){
      if(fields.includes('title'))item.title=clipped(n.title,160,`${alias} title`);
      if(fields.includes('description'))item.description=clipped(n.description,2000,`${alias} description`);
      if(content.includes(n.id))item.content={title:n.title,description:clipped(n.description,6000,`${alias} content`)};
      if(fields.length||content.includes(n.id))noteHashes[n.id]=noteHash(n);
    }
    return item;
  });
  const relationships=project.canvas.connections.filter(c=>reverse.has(c.source)&&reverse.has(c.target)).slice(0,200).map((c,i)=>({ref:`r${i+1}`,source:reverse.get(c.source),target:reverse.get(c.target),...(fields.includes('relationships')&&requested.includes(c.source)&&requested.includes(c.target)?{label:clipped(c.label,160,`r${i+1} wording`)}:{})}));
  if(project.canvas.connections.filter(c=>reverse.has(c.source)&&reverse.has(c.target)).length>200)omissions.push('Only the first 200 selected structural relationships are included.');
  const artifactAliases:Record<string,string>={},seen=new Set<string>();
  const evidence=input.artifacts.map((selection,i)=>{
    if(seen.has(selection.artifactId))throw new StoreError('Select each evidence version once.');seen.add(selection.artifactId);
    const artifact=store.getArtifact(selection.artifactId);
    if(artifact.projectId!==projectId||artifact.hash!==selection.hash)throw new StoreError('Selected evidence version changed or belongs to another project.',409);
    if(selection.excerpt!==undefined&&!artifact.content.includes(selection.excerpt))throw new StoreError('The selected excerpt must appear in that exact evidence version.');
    const ref=`e${i+1}`;artifactAliases[ref]=artifact.id;
    return {ref,kind:artifact.kind,title:clipped(artifact.title,200,`${ref} title`),content:clipped(selection.excerpt??artifact.content,6000,`${ref} evidence`),contentTruncated:(selection.excerpt??artifact.content).length>6000};
  });
  const packet={intent:input.intent,blocks:structural,relationships,evidence,...(input.message?{instruction:input.message}:{}),omissions};
  if(Buffer.byteLength(JSON.stringify(packet))>42000)throw new StoreError('Selected guide context is too large. Select fewer blocks or shorter excerpts.');
  const hash=createHash('sha256').update(JSON.stringify(packet)).digest('hex');
  return {projectRevision:project.revision,packet,nodeAliases,artifactAliases,noteHashes,manifest:{hash,nodeIds:nodes.map(n=>n.id),metadataFields:fields,contentNodeIds:content,artifacts:structuredClone(input.artifacts),messageIncluded:Boolean(input.message),omissions}};
}
