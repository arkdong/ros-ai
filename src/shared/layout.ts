import type { Canvas, CanvasNode } from './types';
import { CARD_DEFAULT_WIDTH, CARD_DEFAULT_HEIGHT, CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, cardWidth } from './card-size';
import { displayRelationship } from './relationships';
import { relationshipLabelSize } from './relationship-label';
import { aggregateTopLevelRelationships } from './aggregate-relationships';

export const CARD_SIZE = { width: CARD_DEFAULT_WIDTH, height: CARD_DEFAULT_HEIGHT };
export const GROUP_INSET = { x: 32, y: 264 };
export const GROUP_FOOTER = 64;
export const LAYOUT_GAP = 72;
export type CanvasSize = { width: number; height: number };
export type LayoutOptions = { expandedIds?: readonly string[]; extraContent?: Record<string, CanvasSize & { minY?: number }>; nodeSizes?: Record<string, CanvasSize> };

/** A user-written numbered sequence remains readable after dragging/Arrange.
 * This is presentation order only, never scheduling or automatic reuse. */
export function numberedStageOrder(nodes: readonly Pick<CanvasNode, 'id' | 'title'>[]): Map<string, number> | null {
  if (nodes.length < 2 || nodes.length > 8) return null;
  const entries = nodes.map(node => {
    const match = node.title.match(/^\s*(\d+)\s*[.·:—–)]\s*/u);
    return match ? [node.id, Number(match[1])] as const : null;
  });
  if (entries.some(entry => !entry) || new Set(entries.map(entry => entry![1])).size !== entries.length) return null;
  return new Map(entries.filter((entry): entry is readonly [string, number] => entry !== null).sort((a, b) => a[1] - b[1]).map(([id], index) => [id, index]));
}

/** Explicit, position-only arrangement. Known provenance relationships place
 * sources above consumers; this never schedules research or imports evidence.
 * Preserve ownership and spatial order within each dependency level. Unknown
 * relationships retain the ordinary reading-order grid.
 */
export function arrangeCanvas(source: Canvas, options: LayoutOptions = {}): { canvas: Canvas; sizes: Record<string, CanvasSize> } {
  const canvas = structuredClone(source);
  const expanded = new Set(options.expandedIds || []);
  const sizes: Record<string, CanvasSize> = {};
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  const dependencies = canvas.connections.map(displayRelationship).filter(connection => connection.dependency);
  const children = new Map<string | null, CanvasNode[]>();
  for (const node of canvas.nodes) {
    const parent = node.parentId || null;
    children.set(parent, [...(children.get(parent) || []), node]);
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const snap = (value: number) => Math.ceil(value / 24) * 24;
  // Project a nested endpoint onto the direct child visible in this scope.
  // Ancestor/self edges do not force a parent to move relative to its contents.
  const inScope = (id: string, parentId: string | null) => {
    const visited = new Set<string>();
    let node = byId.get(id);
    while (node && !visited.has(node.id)) {
      if ((node.parentId || null) === parentId) return node.id;
      visited.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return undefined;
  };
  const dependencyLevels = (siblings: CanvasNode[], parentId: string | null) => {
    const edges = new Map(siblings.map(node => [node.id, new Set<string>()]));
    for (const dependency of dependencies) {
      const source = inScope(dependency.source, parentId), target = inScope(dependency.target, parentId);
      if (source && target && source !== target) edges.get(source)?.add(target);
    }
    // Collapse strongly connected components before ranking. Reciprocal and
    // cyclic evidence relationships remain visible without unstable ordering.
    const indexes = new Map<string, number>(), low = new Map<string, number>();
    const stack: string[] = [], active = new Set<string>(), components: string[][] = [];
    const visit = (id: string) => {
      indexes.set(id, indexes.size); low.set(id, indexes.get(id)!);
      stack.push(id); active.add(id);
      for (const target of edges.get(id) || []) {
        if (!indexes.has(target)) { visit(target); low.set(id, Math.min(low.get(id)!, low.get(target)!)); }
        else if (active.has(target)) low.set(id, Math.min(low.get(id)!, indexes.get(target)!));
      }
      if (low.get(id) === indexes.get(id)) {
        const component: string[] = [];
        let member: string;
        do { member = stack.pop()!; active.delete(member); component.push(member); } while (member !== id);
        components.push(component);
      }
    };
    siblings.forEach(node => { if (!indexes.has(node.id)) visit(node.id); });
    const componentOf = new Map(components.flatMap((component, index) => component.map(id => [id, index] as const)));
    const incoming = components.map(() => new Set<number>());
    for (const [source, targets] of edges) for (const target of targets) {
      const from = componentOf.get(source)!, to = componentOf.get(target)!;
      if (from !== to) incoming[to].add(from);
    }
    const levels = new Map<number, number>();
    const level = (component: number): number => {
      if (!levels.has(component)) levels.set(component, Math.max(0, ...[...incoming[component]].map(parent => level(parent) + 1)));
      return levels.get(component)!;
    };
    return new Map(siblings.map(node => [node.id, level(componentOf.get(node.id)!)]));
  };
  const visiting = new Set<string | null>();
  const place = (parentId: string | null): CanvasSize => {
    if (visiting.has(parentId)) throw new Error('Cannot arrange a cyclic canvas');
    visiting.add(parentId);
    const siblings = [...(children.get(parentId) || [])].sort((a, b) => a.y - b.y || a.x - b.x || compare(a.id, b.id));
    for (const node of siblings) {
      const content = place(node.id);
      const extra = options.extraContent?.[node.id];
      const contentWidth = Math.max(content.width, extra?.width || 0);
      // Pinned/dragged results may intentionally sit below the compacted notes.
      // Reserve that offset as well as their extent; do not move stored pins.
      const extraTop = Math.max(content.height ? content.height + LAYOUT_GAP : 0, extra?.minY || 0);
      const contentHeight = extra ? extraTop + extra.height : content.height;
      const measured = options.nodeSizes?.[node.id];
      sizes[node.id] = expanded.has(node.id)
        ? { width: snap(Math.max(768, contentWidth + GROUP_INSET.x * 2)), height: snap(Math.max(408, contentHeight + GROUP_INSET.y + GROUP_FOOTER)) }
        : { width: measured?.width ?? cardWidth(node), height: Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, measured?.height ?? CARD_SIZE.height)) };
    }
    if (!siblings.length) { visiting.delete(parentId); return { width: 0, height: 0 }; }
    const columns = Math.ceil(Math.sqrt(siblings.length));
    const levels = (parentId === null ? numberedStageOrder(siblings) : null) || dependencyLevels(siblings, parentId);
    const rowsByLevel = new Map<number, CanvasNode[]>();
    for (const node of siblings) rowsByLevel.set(levels.get(node.id)!, [...(rowsByLevel.get(levels.get(node.id)!) || []), node]);
    const cells: { node: CanvasNode; row: number; column: number }[] = [];
    let rows = 0;
    for (const [, members] of [...rowsByLevel].sort(([a], [b]) => a - b)) {
      members.forEach((node, index) => cells.push({ node, row: rows + Math.floor(index / columns), column: index % columns }));
      rows += Math.ceil(members.length / columns);
    }
    const widths = Array<number>(columns).fill(0), heights = Array<number>(rows).fill(0);
    cells.forEach(({ node, row, column }) => {
      widths[column] = Math.max(widths[column], sizes[node.id].width);
      heights[row] = Math.max(heights[row], sizes[node.id].height);
    });
    // Only top-level summaries are drawn. Internal evidence connections keep
    // their meaning but need no canvas label or boundary-port gutters.
    const rowGaps = Array<number>(Math.max(0, rows - 1)).fill(LAYOUT_GAP);
    const columnGaps = Array<number>(Math.max(0, columns - 1)).fill(LAYOUT_GAP);
    if (parentId === null) {
      const cellById = new Map(cells.map(cell => [cell.node.id, cell]));
      for (const connection of aggregateTopLevelRelationships(canvas)) {
        const from = cellById.get(connection.source), to = cellById.get(connection.target);
        if (!from || !to) continue;
        const label = relationshipLabelSize(connection.label);
        if (from.row === to.row) {
          for (let column = Math.min(from.column, to.column); column < Math.max(from.column, to.column); column++) columnGaps[column] = Math.max(columnGaps[column], label.width + 48);
        } else {
          const row = Math.min(from.row, to.row);
          rowGaps[row] = Math.max(rowGaps[row], label.height + 64);
        }
      }
    }
    // Root alignment stays in the same part of the canvas. Inner groups compact
    // their own contents; ancestors reserve the resulting complete footprint.
    const origin = parentId === null
      ? { x: Math.round(Math.min(...siblings.map(n => n.x)) / 24) * 24, y: Math.round(Math.min(...siblings.map(n => n.y)) / 24) * 24 }
      : { x: 0, y: 0 };
    const xs = [origin.x], ys = [origin.y];
    for (let i = 1; i < columns; i++) xs.push(xs[i - 1] + snap(widths[i - 1] + columnGaps[i - 1]));
    for (let i = 1; i < rows; i++) ys.push(ys[i - 1] + snap(heights[i - 1] + rowGaps[i - 1]));
    cells.forEach(({ node, row, column }) => { node.x = xs[column]; node.y = ys[row]; });
    visiting.delete(parentId);
    return { width: Math.max(...cells.map(({node}) => node.x + sizes[node.id].width)), height: ys.at(-1)! + heights.at(-1)! };
  };
  place(null);
  if (Object.keys(sizes).length !== canvas.nodes.length) throw new Error('Cannot arrange missing or cyclic parent groups');
  return { canvas, sizes };
}
