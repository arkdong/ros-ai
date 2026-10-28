import type { Artifact, BlockType, CanvasNode, ProjectDetail } from './types.js';

/** Actual consumers only. Notebook, spreadsheet and database engines can add a
 * definition plus a viewer without turning organizational frames into engines. */
export const blockRegistry: Record<BlockType, { label: string; preview: 'text'|'table'|'figure'|'code' }> = {
  note: { label: 'Note', preview: 'text' }, action: { label: 'Action', preview: 'text' },
  dataset: { label: 'Dataset', preview: 'table' }, figure: { label: 'Figure', preview: 'figure' },
  code: { label: 'Code', preview: 'code' }, notebook: { label: 'Notebook', preview: 'code' }, report: { label: 'Report', preview: 'text' },
  agent: { label: 'Agent', preview: 'text' }, search: { label: 'Search', preview: 'text' }, finding: { label: 'Finding', preview: 'text' }, notion: { label: 'Notion', preview: 'table' }, file: { label: 'File', preview: 'figure' }, google: { label: 'Google', preview: 'table' }, app: { label: 'App', preview: 'figure' }, training: { label: 'Training', preview: 'table' }, web: { label: 'Web', preview: 'text' },
};
export function artifactBlockType(artifact: Artifact): BlockType {
  return artifact.kind === 'plot' ? 'figure' : ['table','dataset'].includes(artifact.kind) ? 'dataset' : artifact.kind === 'code' ? 'code' : artifact.kind === 'notebook' ? 'notebook' : artifact.mediaType === 'text/markdown' ? 'report' : 'note';
}
export function nodeBlockType(node: CanvasNode): BlockType {
  return node.blockType ?? (node.kind === 'activity' || node.legacyKind === 'activity' ? 'action' : 'note');
}
/** Saved outputs only; program/input captures remain available in the full
 * attempt, and an imported notebook snapshot is not an execution result. */
export function isOutputArtifact(artifact: Artifact): boolean {
  if (artifact.metadata?.executionRole === 'input' || artifact.metadata?.executionRole === 'program') return false;
  if (artifact.kind === 'dataset') return artifact.metadata?.executionRole === 'output' || artifact.metadata?.origin === 'external-notebook-output';
  if (artifact.kind === 'log') return artifact.metadata?.origin === 'external-notebook-output';
  return ['result', 'metric', 'table', 'plot'].includes(artifact.kind);
}
export function primaryArtifact(node: CanvasNode, detail: ProjectDetail): Artifact | undefined {
  const manualBlock = ['code', 'notebook'].includes(nodeBlockType(node));
  if (node.artifactId) {
    const artifact = detail.artifacts.find(item => item.id === node.artifactId);
    if (artifact && (!manualBlock || isOutputArtifact(artifact))) return artifact;
  }
  const pinned = detail.highlights?.find(highlight => highlight.nodeId === node.id);
  if (pinned) {
    const artifact=detail.artifacts.find(item=>item.id===pinned.artifactId);
    if (artifact && (!manualBlock || isOutputArtifact(artifact))) return artifact;
  }
  const artifacts = detail.artifacts.filter(artifact => artifact.nodeId === node.id && isOutputArtifact(artifact)
    && detail.runs.find(run => run.id === artifact.runId)?.status === 'completed');
  const latest = artifacts.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const newestRun=latest[0]?.runId;
  const current=latest.filter(artifact=>artifact.runId===newestRun);
  return current.find(artifact => artifact.kind === 'plot') ?? current.find(artifact => artifact.kind === 'metric') ?? current[0];
}
