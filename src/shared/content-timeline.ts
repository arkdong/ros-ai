import type { Artifact, Change, ProjectDetail } from './types';

export type ContentTimelineEntry =
  | {kind:'canvas'; id:string; createdAt:string; change:Change}
  | {kind:'evidence'; id:string; createdAt:string; title:string; artifacts:Artifact[]};

/** Evidence milestones are a read-only index of saved versions, never undo states. */
export function contentTimeline(detail:Pick<ProjectDetail,'project'|'changes'|'runs'|'artifacts'>):ContentTimelineEntry[] {
  const runs=new Map(detail.runs.filter(run=>run.projectId===detail.project.id).map(run=>[run.id,run]));
  const groups=new Map<string,Artifact[]>();
  const rank:Partial<Record<Artifact['kind'],number>>={result:0,plot:1,table:2,metric:3,dataset:4};
  for(const artifact of detail.artifacts){
    const run=runs.get(artifact.runId);
    if(artifact.projectId!==detail.project.id||!run||run.nodeId!==artifact.nodeId||!run.artifactIds.includes(artifact.id)||rank[artifact.kind]===undefined)continue;
    const group=groups.get(run.id)??[];
    group.push(artifact);groups.set(run.id,group);
  }
  const entries:ContentTimelineEntry[]=detail.changes.map(change=>({kind:'canvas',id:`canvas:${change.id}`,createdAt:change.createdAt,change}));
  for(const [runId,artifacts] of groups){
    const run=runs.get(runId)!;
    artifacts.sort((a,b)=>rank[a.kind]!-rank[b.kind]!||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const createdAt=artifacts.reduce((latest,artifact)=>artifact.createdAt>latest?artifact.createdAt:latest,artifacts[0].createdAt);
    entries.push({kind:'evidence',id:`evidence:${runId}`,createdAt,title:run.node.title,artifacts});
  }
  return entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
}
