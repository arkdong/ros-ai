import { GROUP_INSET } from './layout.js';
import type { Canvas, Mutation } from './types.js';
/** Only group children are bounded by their parent's content inset. Root notes
 * live on an unbounded plane; the viewport is never a persistence boundary. */
export function savedCanvasPosition(position: { x: number; y: number }, nested: boolean) {
  const snap = (value: number) => Math.round(value / 24) * 24;
  const x = snap(position.x - (nested ? GROUP_INSET.x : 0));
  const y = snap(position.y - (nested ? GROUP_INSET.y : 0));
  return { x: nested ? Math.max(0, x) : x, y: nested ? Math.max(0, y) : y };
}
/** A change that only moves or resizes a block is layout, not research content. */
export const layoutOnly = (patch: object) => Object.keys(patch).every(key => key === 'x' || key === 'y' || key === 'width' || key === 'height');
/** What a canvas change does, as the approval modes weigh it. Moving, resizing or regrouping a block arranges it; changing
 * anything else about it edits it. A field sent with the value it already has changes nothing. */
export type CanvasChange = 'add' | 'arrange' | 'edit' | 'remove';
export function canvasChange(operation: Mutation, canvas: Canvas): CanvasChange {
  if (operation.type === 'addNode' || operation.type === 'addConnection') return 'add';
  if (operation.type !== 'updateNode') return 'remove';
  const node: Record<string, unknown> = canvas.nodes.find(item => item.id === operation.id) ?? {};
  const changed = Object.entries(operation.patch).filter(([key, value]) => key !== 'parentId' && JSON.stringify(value ?? null) !== JSON.stringify(node[key] ?? null));
  return layoutOnly(Object.fromEntries(changed)) ? 'arrange' : 'edit';
}
