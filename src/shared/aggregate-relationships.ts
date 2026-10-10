import type { Canvas, CanvasNode, Connection } from './types';
import { displayRelationship } from './relationships';

export type RelationshipContribution = {
  connection: Connection;
  sourceTitle: string;
  targetTitle: string;
};
export type AggregateRelationship = {
  id: string;
  source: string;
  target: string;
  bidirectional: boolean;
  label: string;
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
    const shown = displayRelationship(connection);
    const source = rootOf(shown.source), target = rootOf(shown.target);
    if (!source || !target || source === target) continue;
    const id = `group-relationship:${[source, target].sort().map(encodeURIComponent).join(':')}`;
    let aggregate = pairs.get(id);
    if (!aggregate) {
      aggregate = { id, source, target, bidirectional: false, label: '', contributions: [] };
      pairs.set(id, aggregate);
    } else if (aggregate.source !== source) aggregate.bidirectional = true;
    aggregate.contributions.push({ connection, sourceTitle: nodes.get(connection.source)!.title, targetTitle: nodes.get(connection.target)!.title });
    const count = aggregate.contributions.length;
    aggregate.label = `${count} relationship${count === 1 ? '' : 's'}`;
  }
  return [...pairs.values()];
}

/** Links an agent draws for its own steps (question to agent, agent to its searches,
 * search to its result, agent to blocks it added) carry no badge on the canvas.
 * Their wording stays in the relationship details. */
export function quietRelationship(connection: Connection, node: (id: string) => CanvasNode | undefined): boolean {
  const label = connection.label.trim().replace(/\s+/gu, ' ').toLowerCase(), source = node(connection.source)?.blockType, target = node(connection.target)?.blockType;
  return (source === 'agent' && (target === 'search' || label === 'added')) || (source === 'search' && label === 'found') || (target === 'agent' && label === 'taken on by');
}
/** The badge a top-level relationship shows on the canvas; empty when it has none. */
export function relationshipBadgeText(group: AggregateRelationship, node: (id: string) => CanvasNode | undefined): string {
  if (group.contributions.every(item => quietRelationship(item.connection, node))) return '';
  return group.contributions.length === 1 ? displayRelationship(group.contributions[0].connection).label.replace(/\s+/gu, ' ').trim() || 'Related' : `${group.contributions.length} relationships`;
}
