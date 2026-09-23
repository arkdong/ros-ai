import type { AssistantReference, OutlineEntry } from './assistant.js';
import type { ProjectDetail } from './types.js';

export type OutlineBranch = { entry: OutlineEntry; children: OutlineBranch[]; findings: OutlineEntry[] };
export type OutlineHierarchy = { directions: OutlineBranch[]; sharedFindings: OutlineEntry[]; unassignedFindings: OutlineEntry[]; directionCount: number; findingCount: number };
type OutlineContext = Pick<ProjectDetail, 'project' | 'artifacts' | 'runs' | 'messages'>;

/** Present only ownership and evidence associations already in saved records.
 * Canvas relationships never create outline parents or implied input sharing. */
export function buildOutlineHierarchy(entries: OutlineEntry[], detail: OutlineContext): OutlineHierarchy {
  const nodes = new Map(detail.project.canvas.nodes.map(node => [node.id, node]));
  const branches = entries.filter(entry => entry.kind === 'direction').map(entry => ({ entry, children: [], findings: [] } as OutlineBranch));
  const byNode = new Map(branches.filter(branch => branch.entry.nodeId && nodes.has(branch.entry.nodeId)).map(branch => [branch.entry.nodeId!, branch]));
  const directions: OutlineBranch[] = [];
  for (const branch of branches) {
    const nodeId = branch.entry.nodeId;
    const seen = new Set(nodeId ? [nodeId] : []);
    let parentId = nodeId ? nodes.get(nodeId)?.parentId : undefined;
    let parent: OutlineBranch | undefined;
    let cyclic = false;
    while (parentId) {
      if (seen.has(parentId)) { cyclic = true; break; }
      seen.add(parentId);
      parent ??= byNode.get(parentId);
      parentId = nodes.get(parentId)?.parentId;
    }
    // Legacy/malformed ownership cannot hide a whole branch behind a cycle.
    if (parent && !cyclic) parent.children.push(branch);
    else directions.push(branch);
  }

  const artifacts = new Map(detail.artifacts.filter(a => a.projectId === detail.project.id).map(a => [a.id, a.nodeId]));
  const runs = new Map(detail.runs.filter(r => r.projectId === detail.project.id).map(r => [r.id, r.nodeId]));
  const messages = new Map(detail.messages.filter(m => m.projectId === detail.project.id).map(m => [m.id, m.nodeId]));
  const referenceNode = (reference: AssistantReference) => {
    if (reference.kind === 'node') return nodes.has(reference.id) ? reference.id : undefined;
    if (reference.kind === 'artifact') return artifacts.get(reference.id);
    if (reference.kind === 'run') return runs.get(reference.id);
    if (reference.kind === 'message') return messages.get(reference.id) ?? undefined;
    return undefined;
  };
  const sharedFindings: OutlineEntry[] = [], unassignedFindings: OutlineEntry[] = [];
  const findings = entries.filter(entry => entry.kind === 'finding');
  for (const finding of findings) {
    const explicit = finding.nodeId ? byNode.get(finding.nodeId) : undefined;
    if (explicit) { explicit.findings.push(finding); continue; }
    const associated = new Set(finding.references.map(referenceNode).filter(id => id && byNode.has(id)));
    if (associated.size === 1) byNode.get([...associated][0]!)!.findings.push(finding);
    else if (associated.size > 1) sharedFindings.push(finding);
    else unassignedFindings.push(finding);
  }
  return { directions, sharedFindings, unassignedFindings, directionCount: branches.length, findingCount: findings.length };
}
