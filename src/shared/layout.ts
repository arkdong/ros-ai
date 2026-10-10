import type { Canvas, CanvasNode } from './types';
import { CARD_DEFAULT_WIDTH, CARD_DEFAULT_HEIGHT, CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, cardWidth } from './card-size';
import { displayRelationship } from './relationships';
import { relationshipLabelSize } from './relationship-label';
import { aggregateTopLevelRelationships, relationshipBadgeText } from './aggregate-relationships';

export const CARD_SIZE = { width: CARD_DEFAULT_WIDTH, height: CARD_DEFAULT_HEIGHT };
export const GROUP_INSET = { x: 32, y: 144 };
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

/** Explicit, position-only arrangement. Blocks joined by relationships are laid
 * out as trees read left to right, each block centred beside the blocks it
 * points to, so an agent's searches and their results line up in rows. A
 * relationship never schedules research or imports evidence. Unconnected
 * blocks keep the reading-order grid, and a numbered sequence of stages keeps
 * its order. Spatial order is kept among siblings.
 */
export function arrangeCanvas(source: Canvas, options: LayoutOptions = {}): { canvas: Canvas; sizes: Record<string, CanvasSize> } {
  const canvas = structuredClone(source);
  const expanded = new Set(options.expandedIds || []);
  const sizes: Record<string, CanvasSize> = {};
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
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
  // Only top-level summaries are drawn with a label; the gap after a column fits it.
  const labels = new Map(aggregateTopLevelRelationships(canvas).map(group => [`${group.source}\u0000${group.target}`, relationshipBadgeText(group, id => byId.get(id))]));
  const flow = (siblings: CanvasNode[], parentId: string | null) => {
    const targets = new Map(siblings.map(node => [node.id, [] as string[]]));
    for (const connection of canvas.connections) {
      // A Group frame already draws its direct membership.
      if (connection.label.trim().toLowerCase() === 'contains' && byId.get(connection.source)?.kind === 'group' && byId.get(connection.target)?.parentId === connection.source) continue;
      const shown = displayRelationship(connection);
      const from = inScope(shown.source, parentId), to = inScope(shown.target, parentId);
      if (from && to && from !== to && !targets.get(from)!.includes(to)) targets.get(from)!.push(to);
    }
    return targets;
  };
  /** Trees read left to right. Cycles are broken where a depth-first walk meets
   * a block it is still inside; each block takes the column after its furthest
   * parent and sits beside its first parent, centred on its own children. */
  const trees = (members: CanvasNode[], targets: Map<string, string[]>, origin: { x: number; y: number }, labelGap: (from: string, to: string) => number) => {
    const rank = new Map(members.map((node, index) => [node.id, index]));
    const out = (id: string) => (targets.get(id) || []).filter(target => rank.has(target)).sort((a, b) => rank.get(a)! - rank.get(b)!);
    const parents = new Map(members.map(node => [node.id, [] as string[]]));
    const state = new Map<string, 1 | 2>();
    const walk = (id: string) => {
      state.set(id, 1);
      for (const target of out(id)) {
        if (state.get(target) === 1) continue;
        parents.get(target)!.push(id);
        if (!state.has(target)) walk(target);
      }
      state.set(id, 2);
    };
    const incoming = new Set(members.flatMap(node => out(node.id)));
    for (const node of members) if (!incoming.has(node.id) && !state.has(node.id)) walk(node.id);
    for (const node of members) if (!state.has(node.id)) walk(node.id);
    const columns = new Map<string, number>();
    const column = (id: string): number => {
      if (!columns.has(id)) { columns.set(id, 0); columns.set(id, Math.max(0, ...parents.get(id)!.map(parent => column(parent) + 1))); }
      return columns.get(id)!;
    };
    members.forEach(node => column(node.id));
    const kids = new Map(members.map(node => [node.id, [] as string[]]));
    const roots: string[] = [];
    for (const node of members) {
      const parent = parents.get(node.id)!.filter(id => columns.get(id) === columns.get(node.id)! - 1).sort((a, b) => rank.get(a)! - rank.get(b)!)[0];
      if (parent) kids.get(parent)!.push(node.id); else roots.push(node.id);
    }
    const height = (id: string) => snap(sizes[id].height);
    const breadths = new Map<string, number>();
    const breadth = (id: string): number => {
      if (!breadths.has(id)) { const own = kids.get(id)!; breadths.set(id, Math.max(height(id), own.reduce((sum, kid) => sum + breadth(kid), 0) + Math.max(0, own.length - 1) * LAYOUT_GAP)); }
      return breadths.get(id)!;
    };
    const ys = new Map<string, number>();
    const stack = (id: string, top: number) => {
      const own = kids.get(id)!, span = breadth(id);
      const block = own.reduce((sum, kid) => sum + breadth(kid), 0) + Math.max(0, own.length - 1) * LAYOUT_GAP;
      ys.set(id, top + (span - height(id)) / 2);
      let at = top + (span - block) / 2;
      for (const kid of own) { stack(kid, at); at += breadth(kid) + LAYOUT_GAP; }
    };
    let top = origin.y;
    for (const root of roots) { stack(root, top); top += breadth(root) + LAYOUT_GAP * 2; }
    const count = Math.max(...columns.values()) + 1;
    const widths = Array<number>(count).fill(0), gaps = Array<number>(count).fill(LAYOUT_GAP);
    for (const node of members) widths[columns.get(node.id)!] = Math.max(widths[columns.get(node.id)!], sizes[node.id].width);
    for (const node of members) for (const target of out(node.id)) if (columns.get(target) === columns.get(node.id)! + 1) gaps[columns.get(node.id)!] = Math.max(gaps[columns.get(node.id)!], labelGap(node.id, target));
    const xs = [origin.x];
    for (let i = 1; i < count; i++) xs.push(xs[i - 1] + snap(widths[i - 1] + gaps[i - 1]));
    for (const node of members) { node.x = xs[columns.get(node.id)!]; node.y = snap(ys.get(node.id)!); }
    return { right: Math.max(...members.map(node => node.x + sizes[node.id].width)), bottom: Math.max(...members.map(node => node.y + sizes[node.id].height)) };
  };
  /** The reading-order grid for blocks without relationships, or rows in a numbered stage order. */
  const grid = (members: CanvasNode[], origin: { x: number; y: number }, levels: Map<string, number> | null, parentId: string | null) => {
    const columns = Math.ceil(Math.sqrt(members.length));
    const rowsByLevel = new Map<number, CanvasNode[]>();
    for (const node of members) rowsByLevel.set(levels?.get(node.id) ?? 0, [...(rowsByLevel.get(levels?.get(node.id) ?? 0) || []), node]);
    const cells: { node: CanvasNode; row: number; column: number }[] = [];
    let rows = 0;
    for (const [, level] of [...rowsByLevel].sort(([a], [b]) => a - b)) {
      level.forEach((node, index) => cells.push({ node, row: rows + Math.floor(index / columns), column: index % columns }));
      rows += Math.ceil(level.length / columns);
    }
    const widths = Array<number>(columns).fill(0), heights = Array<number>(rows).fill(0);
    cells.forEach(({ node, row, column }) => {
      widths[column] = Math.max(widths[column], sizes[node.id].width);
      heights[row] = Math.max(heights[row], sizes[node.id].height);
    });
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
    const xs = [origin.x], ys = [origin.y];
    for (let i = 1; i < columns; i++) xs.push(xs[i - 1] + snap(widths[i - 1] + columnGaps[i - 1]));
    for (let i = 1; i < rows; i++) ys.push(ys[i - 1] + snap(heights[i - 1] + rowGaps[i - 1]));
    cells.forEach(({ node, row, column }) => { node.x = xs[column]; node.y = ys[row]; });
    return { right: Math.max(...cells.map(({ node }) => node.x + sizes[node.id].width)), bottom: ys.at(-1)! + heights.at(-1)! };
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
    // Root alignment stays in the same part of the canvas. Inner groups compact
    // their own contents; ancestors reserve the resulting complete footprint.
    const origin = parentId === null
      ? { x: Math.round(Math.min(...siblings.map(n => n.x)) / 24) * 24, y: Math.round(Math.min(...siblings.map(n => n.y)) / 24) * 24 }
      : { x: 0, y: 0 };
    const stages = parentId === null ? numberedStageOrder(siblings) : null;
    const targets = stages ? new Map<string, string[]>() : flow(siblings, parentId);
    const linked = new Set([...targets].flatMap(([source, list]) => list.length ? [source, ...list] : []));
    const labelGap = (from: string, to: string) => {
      const label = parentId === null ? labels.get(`${from}\u0000${to}`) ?? labels.get(`${to}\u0000${from}`) : undefined;
      return label ? relationshipLabelSize(label).width + 48 : 0;
    };
    // Each set of linked blocks is its own tree, stacked in reading order.
    const groups: CanvasNode[][] = [];
    const seen = new Set<string>();
    for (const node of siblings) {
      if (!linked.has(node.id) || seen.has(node.id)) continue;
      const members: CanvasNode[] = [], queue = [node.id];
      seen.add(node.id);
      while (queue.length) {
        const id = queue.shift()!;
        members.push(byId.get(id)!);
        for (const [source, list] of targets) for (const target of list) {
          const next = source === id ? target : target === id ? source : null;
          if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      groups.push(members.sort((a, b) => a.y - b.y || a.x - b.x || compare(a.id, b.id)));
    }
    let bottom = origin.y, right = origin.x;
    groups.forEach((members, index) => {
      const placed = trees(members, targets, { x: origin.x, y: index ? snap(bottom + LAYOUT_GAP * 2) : origin.y }, labelGap);
      bottom = placed.bottom; right = Math.max(right, placed.right);
    });
    const loose = siblings.filter(node => !linked.has(node.id));
    if (loose.length) {
      const placed = grid(loose, { x: origin.x, y: groups.length ? snap(bottom + LAYOUT_GAP * 2) : origin.y }, stages, parentId);
      bottom = placed.bottom; right = Math.max(right, placed.right);
    }
    visiting.delete(parentId);
    return { width: right - origin.x, height: bottom - origin.y };
  };
  place(null);
  if (Object.keys(sizes).length !== canvas.nodes.length) throw new Error('Cannot arrange missing or cyclic parent groups');
  return { canvas, sizes };
}
