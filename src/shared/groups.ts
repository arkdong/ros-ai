import type { Canvas, CanvasNode, Mutation } from './types.js';

export const isGroup = (node: CanvasNode) => node.kind === 'group';

/** Legacy containers keep their identity, overview and every captured record. */
export function convertLegacyGroups(canvas: Canvas): Canvas {
  const parents = new Set(canvas.nodes.map(node => node.parentId).filter(Boolean));
  return { ...canvas, nodes: canvas.nodes.map(node => parents.has(node.id) && !isGroup(node)
    ? { ...node, kind: 'group', legacyKind: node.kind === 'activity' ? 'activity' : node.kind === 'topic' ? 'topic' : 'unspecified' }
    : node) };
}

export function groupMembers(canvas: Canvas, groupId: string): CanvasNode[] {
  const result: CanvasNode[] = [], seen = new Set([groupId]);
  const visit = (parentId: string) => {
    for (const node of canvas.nodes) if (node.parentId === parentId && !seen.has(node.id)) {
      seen.add(node.id); result.push(node); visit(node.id);
    }
  };
  visit(groupId); return result;
}

/** Scope coordinates remain stable within their destination. Grouping is one
 * undoable content edit and never manufactures evidence connections. */
export function createGroupOperations(canvas: Canvas, ids: readonly string[], id: string, title: string): Mutation[] {
  const picked = canvas.nodes.filter(node => ids.includes(node.id));
  const pickedIds = new Set(picked.map(node => node.id));
  const roots = picked.filter(node => !node.parentId || !pickedIds.has(node.parentId));
  if (!roots.length) return [];
  const parentId = roots[0].parentId ?? null;
  if (roots.some(node => (node.parentId ?? null) !== parentId)) throw new Error('Select blocks in the same group to group them together.');
  const x = Math.min(...roots.map(node => node.x)), y = Math.min(...roots.map(node => node.y));
  return [{ type: 'addNode', node: { id, title, description: '', kind: 'group', parentId, x, y } },
    ...roots.map(node => ({ type: 'updateNode' as const, id: node.id, patch: { parentId: id, x: node.x - x, y: node.y - y } }))];
}

/** Dissolving a new frame retains its overview as a normal note when populated.
 * Legacy containers always retain their research identity and saved outputs. */
export function ungroupOperations(canvas: Canvas, group: CanvasNode): Mutation[] {
  const members = canvas.nodes.filter(node => node.parentId === group.id);
  return [...members.map(node => ({ type: 'updateNode' as const, id: node.id,
    patch: { parentId: group.parentId ?? null, x: group.x + node.x, y: group.y + node.y } })),
    { type: 'updateNode', id: group.id, patch: { kind: group.legacyKind ?? 'topic', ...(group.legacyKind ? {} : {blockType: 'note' as const}), groupHighlights: [] } }];
}

/** Only organizational/presentation fields are omitted. Scientific content,
 * selected evidence and runtime permissions remain part of approval validation. */
export function executionNodeContext(node: CanvasNode) {
  const { x: _x, y: _y, width: _width, parentId: _parent, groupHighlights: _highlights, legacyKind, ...content } = node;
  return { ...content, ...(content.kind==='group' && legacyKind ? { kind: legacyKind } : {}) };
}
