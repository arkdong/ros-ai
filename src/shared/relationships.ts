import type { CanvasNode, Connection } from './types.js';

/** Display direction is separate from historical storage direction. Only known
 * dependency wording is normalized; free-form relations retain their meaning.
 * A dependency describes provenance, never permission, imports or scheduling.
 */
export function displayRelationship(connection: Connection) {
  const label = connection.label.trim().replace(/\s+/g, ' ').toLowerCase();
  const inverse: Record<string, string> = {
    'uses data from': 'provides data to',
    'reuses result from': 'provides results to',
    'reuses results from': 'provides results to',
    'uses results from': 'provides results to',
    'depends on': 'supports',
  };
  const forward = ['provides data to', 'provides results to', 'feeds into', 'supports', 'supports draft', 'qualifies draft'];
  const reversed = Object.hasOwn(inverse, label);
  return {
    ...connection,
    source: reversed ? connection.target : connection.source,
    target: reversed ? connection.source : connection.target,
    sourceHandle: reversed ? connection.targetHandle : connection.sourceHandle,
    targetHandle: reversed ? connection.sourceHandle : connection.targetHandle,
    label: reversed ? inverse[label] : connection.label,
    reversed,
    dependency: reversed || forward.includes(label),
  };
}

/** Read a relationship relative to either endpoint without reversing a
 * free-form claim or changing stored direction, labels, or handle choices. */
export function relationshipReferenceLabel(connection: Connection, nodeId: string, nodes: Pick<CanvasNode, 'id' | 'title'>[]): string {
  const relation = displayRelationship(connection);
  const title = (id: string) => nodes.find(node => node.id === id)?.title ?? id;
  const key = relation.label.trim().replace(/\s+/g, ' ').toLowerCase();
  const wording: Record<string, { outgoing: string; incoming: string }> = {
    'provides data to': { outgoing: 'Provides data to', incoming: 'Data from' },
    'provides results to': { outgoing: 'Provides results to', incoming: 'Results from' },
    'supports': { outgoing: 'Supports', incoming: 'Supported by' },
    'feeds into': { outgoing: 'Feeds into', incoming: 'Fed by' },
  };
  if (Object.hasOwn(wording, key)) {
    if (nodeId === relation.source) return `${wording[key].outgoing} → ${title(relation.target)}`;
    if (nodeId === relation.target) return `${wording[key].incoming} ← ${title(relation.source)}`;
  }
  return `${title(relation.source)} → ${title(relation.target)}${relation.label ? ` · ${relation.label}` : ''}`;
}
