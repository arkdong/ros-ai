import type { Canvas, CanvasNode, Connection } from './types';
import { isTrail } from './links';

export type RelationshipContribution = {
  connection: Connection;
  sourceTitle: string;
  targetTitle: string;
};
/** One line on the canvas: every link between the same two visible blocks, in either direction. */
export type AggregateRelationship = {
  id: string;
  source: string;
  target: string;
  bidirectional: boolean;
  contributions: RelationshipContribution[];
};

/** Canvas-only summaries. Underlying endpoints, labels, and reuse stay intact.
 * Links inside one top-level group belong in note details, not on the canvas. */
export function aggregateTopLevelRelationships(canvas: Canvas, expandedIds?:readonly string[]): AggregateRelationship[] {
  const nodes = new Map(canvas.nodes.map(node => [node.id, node]));
  const expanded = new Set(expandedIds);
  const rootOf = (id: string): string | undefined => {
    const visited = new Set<string>();
    let node = nodes.get(id);
    let visible = node;
    while (node?.parentId && !visited.has(node.id)) {
      visited.add(node.id); node = nodes.get(node.parentId);
      if (expandedIds === undefined || node && !expanded.has(node.id)) visible = node;
    }
    return node && !node.parentId ? visible?.id : undefined;
  };
  const pairs = new Map<string, AggregateRelationship>();
  for (const connection of canvas.connections) {
    // Direct membership is already drawn by the enclosing Group frame. Keep
    // the saved relationship available in details without a second canvas wire.
    if (connection.label.trim().toLowerCase() === 'contains'
      && nodes.get(connection.source)?.kind === 'group'
      && nodes.get(connection.target)?.parentId === connection.source) continue;
    const source = rootOf(connection.source), target = rootOf(connection.target);
    if (!source || !target || source === target) continue;
    const id = `group-relationship:${[source, target].sort().map(encodeURIComponent).join(':')}`;
    let aggregate = pairs.get(id);
    if (!aggregate) {
      aggregate = { id, source, target, bidirectional: false, contributions: [] };
      pairs.set(id, aggregate);
    } else if (aggregate.source !== source) aggregate.bidirectional = true;
    aggregate.contributions.push({ connection, sourceTitle: nodes.get(connection.source)!.title, targetTitle: nodes.get(connection.target)!.title });
  }
  return [...pairs.values()];
}

/** The word a line shows on the canvas: one link's own word, a count for several, nothing for trails or an unnamed link. */
export function linkWord(group: AggregateRelationship, node: (id: string) => CanvasNode | undefined): string {
  if (group.contributions.every(item => isTrail(item.connection, node))) return '';
  return group.contributions.length === 1 ? group.contributions[0].connection.label.replace(/\s+/gu, ' ').trim() : `${group.contributions.length} links`;
}
