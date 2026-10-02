import type { Artifact, CodeDocument, ProjectDetail } from './types';
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export function outputFreshness(artifact:Artifact,detail:ProjectDetail):{state:'current'|'stale'|'unverifiable';message:string} {
  const run=detail.runs.find(value=>value.id===artifact.runId),node=detail.project.canvas.nodes.find(value=>value.id===artifact.nodeId);
  const codeSource=(run?.configuration.codeSource??artifact.metadata?.codeSource) as CodeDocument|undefined;
  if(codeSource) {
    if(!node?.code)return {state:'unverifiable',message:'Producing Code source is retained; current source is unavailable.'};
    if(canonical(codeSource)!==canonical(node.code))return {state:'stale',message:'Code, parameters or selected input changed. This output keeps its producing version.'};
    return {state:'current',message:'Matches the saved Code source and selected input. This does not guarantee deterministic replay.'};
  }
  if(artifact.capture==='external'||run?.configuration.kind==='external-notebook-capture') {
    const sourceId=artifact.metadata?.notebookSourceArtifactId;
    const current=detail.artifacts.find(value=>value.nodeId===artifact.nodeId&&value.kind==='notebook');
    if(typeof sourceId==='string'&&current&&sourceId!==current.id)return {state:'stale',message:'A newer notebook snapshot is saved. This output retains its original snapshot and cell locator.'};
    return {state:'unverifiable',message:'Captured external notebook output. Current kernel state, execution order and dependencies are not verified.'};
  }
  return {state:'unverifiable',message:'Exact captured version retained; its relationship to the current source is not verified.'};
}
