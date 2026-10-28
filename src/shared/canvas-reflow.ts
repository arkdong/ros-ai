import { cardWidth, setCardHeight, CARD_DEFAULT_HEIGHT } from './card-size';
import { LAYOUT_GAP, openGroupSize, type CanvasSize, type LayoutOptions } from './layout';
import type { Canvas, CanvasNode } from './types';

type Axis = 'x' | 'y';
type Separation = { before: string; after: string; axis: Axis; gap: number };
type ScopePlan = { anchors: Record<string, { x: number; y: number }>; separations: Separation[] };
/** A stable reading-order plan, rather than a new grid on each measurement.
 * Keeping this across automatic moves lets a shrinking frame pull its neighbours
 * back, without changing their left/right or above/below relationship each time.
 * Explicit Arrange and manual movement replace the plan with the user's layout.
 */
export type CanvasReflowPlan = Record<string, ScopePlan>;
/** Groups opened since the last reflow keep their place; their content moves into the frame's corner. */
export type ReflowOptions = LayoutOptions & { opening?: readonly string[] };
const rootScope = '\u0000root';
const snap = (value: number) => Math.ceil(value / 24) * 24;
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const scopeOf = (node: CanvasNode) => node.parentId || rootScope;
const extentOf = (axis: Axis) => axis === 'x' ? 'width' : 'height';
const defaultSize = (node: CanvasNode): CanvasSize => ({ width: cardWidth(node), height: setCardHeight(node) ?? CARD_DEFAULT_HEIGHT });
const add = <K, V>(map: Map<K, V[]>, key: K, value: V) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };

/** Each pair of blocks in a scope keeps its side of the other on every axis it is apart on as shown, so a
 * block below and to the right of an open Group follows both its row and its column. Blocks shown on top of
 * each other are kept apart along the axes they are apart on with Groups closed. A block keeps the gap to
 * the nearest block before it; the blocks further back keep it too, so a row sits below the tallest block
 * of the row above and moves up again when that block closes. `sizes` are the sizes blocks are shown at;
 * `closedSizes` the sizes they take with every Group closed.
 */
export function createCanvasReflowPlan(canvas: Canvas, sizes: Record<string, CanvasSize>, closedSizes: Record<string, CanvasSize> = sizes): CanvasReflowPlan {
  const plan: CanvasReflowPlan = {};
  for (const scope of new Set(canvas.nodes.map(scopeOf))) {
    const siblings = canvas.nodes.filter(node => scopeOf(node) === scope).sort((a, b) => compareId(a.id, b.id));
    const anchors = Object.fromEntries(siblings.map(node => [node.id, { x: scope === rootScope ? node.x : Math.max(0, node.x), y: scope === rootScope ? node.y : Math.max(0, node.y) }]));
    const shown = (node: CanvasNode) => sizes[node.id] || defaultSize(node), closed = (node: CanvasNode) => closedSizes[node.id] || shown(node);
    const apart = (a: CanvasNode, b: CanvasNode, axis: Axis, size: (node: CanvasNode) => CanvasSize) =>
      anchors[a.id][axis] + size(a)[extentOf(axis)] <= anchors[b.id][axis] || anchors[b.id][axis] + size(b)[extentOf(axis)] <= anchors[a.id][axis];
    const separations: Separation[] = [], pushed: Separation[] = [], paired = new Set<string>();
    const separate = (before: CanvasNode, after: CanvasNode, axis: Axis) => {
      paired.add(`${axis}\u0000${before.id}\u0000${after.id}`);
      // Gaps are measured from the grid line after each block, as blocks are placed, so a plan made from a
      // reflowed layout gives back the same gaps and opening and closing never drifts by a grid step.
      const edge = { before: before.id, after: after.id, axis, gap: anchors[after.id][axis] - anchors[before.id][axis] - snap(shown(before)[extentOf(axis)]) };
      separations.push(edge); return edge;
    };
    for (let i = 0; i < siblings.length; i++) for (let j = i + 1; j < siblings.length; j++) {
      const a = siblings[i], b = siblings[j], pa = anchors[a.id], pb = anchors[b.id];
      let axes = (['x', 'y'] as const).filter(axis => apart(a, b, axis, shown));
      const covered = !axes.length;
      if (covered) axes = (['x', 'y'] as const).filter(axis => apart(a, b, axis, closed));
      if (!axes.length) {
        const sa = closed(a), sb = closed(b);
        axes = [Math.abs(pb.y - pa.y) / Math.max(sa.height, sb.height) >= Math.abs(pb.x - pa.x) / Math.max(sa.width, sb.width) ? 'y' : 'x'];
      }
      for (const axis of axes) {
        const before = pa[axis] < pb[axis] || (pa[axis] === pb[axis] && compareId(a.id, b.id) < 0) ? a : b, after = before === a ? b : a;
        const edge = separate(before, after, axis);
        if (covered) pushed.push(edge);
      }
    }
    // A block shown on top of an open Group moves clear of it along the rows and columns of the closed layout,
    // and the rest of its row (or column) moves with it, as when the Group is opened: the row stays a row.
    const byId = new Map(siblings.map(node => [node.id, node]));
    for (const edge of pushed) for (const node of siblings) {
      const axis = edge.axis, before = byId.get(edge.before)!;
      if (node.id === edge.before || node.id === edge.after || anchors[node.id][axis] !== anchors[edge.after][axis]) continue;
      if (anchors[before.id][axis] + closed(before)[extentOf(axis)] > anchors[node.id][axis] || paired.has(`${axis}\u0000${before.id}\u0000${node.id}`)) continue;
      separate(before, node, axis);
    }
    // A pair already kept apart through blocks between them needs no constraint of its own: its gap would
    // include those blocks. Bit sets of the blocks each block reaches keep this quick on a full canvas.
    const index = new Map(siblings.map((node, position) => [node.id, position])), words = Math.ceil(siblings.length / 32), reduced: Separation[] = [];
    for (const axis of ['x', 'y'] as const) {
      const order = (a: string, b: string) => anchors[a][axis] - anchors[b][axis] || compareId(a, b);
      const outgoing = new Map<string, Separation[]>(), reach = new Map<string, Uint32Array>();
      for (const edge of separations) if (edge.axis === axis) add(outgoing, edge.before, edge);
      for (const id of siblings.map(node => node.id).sort((a, b) => order(b, a))) {
        const own = new Uint32Array(words);
        for (const edge of (outgoing.get(id) || []).sort((a, b) => order(a.after, b.after))) {
          const target = index.get(edge.after)!;
          if (own[target >> 5] & (1 << (target & 31))) continue;
          reduced.push(edge);
          const further = reach.get(edge.after)!;
          for (let word = 0; word < words; word++) own[word] |= further[word];
        }
        own[index.get(id)! >> 5] |= 1 << (index.get(id)! & 31);
        reach.set(id, own);
      }
    }
    const nearest = new Map<string, number>(), key = (edge: Separation) => `${edge.axis}\u0000${edge.after}`;
    for (const edge of reduced) nearest.set(key(edge), Math.min(nearest.get(key(edge)) ?? Infinity, edge.gap));
    // Retain deliberately placed gaps; blocks shown on top of each other are set apart by the usual gap.
    for (const edge of reduced) { const distance = nearest.get(key(edge))!; edge.gap = distance > 0 ? Math.max(32, distance) : LAYOUT_GAP; }
    plan[scope] = { anchors, separations: reduced };
  }
  return plan;
}

/** Whether blocks shown together (on the canvas or in an open Group) cover each other, or an open Group's content
 * leaves room before its first block: a layout changed elsewhere, which a reflow settles without a resize. */
export function unsettled(canvas: Canvas, sizes: Record<string, CanvasSize>, expandedIds: readonly string[]) {
  const open = new Set(expandedIds), scopes = new Map<string, CanvasNode[]>();
  for (const node of canvas.nodes) add(scopes, scopeOf(node), node);
  const shown: string[] = [rootScope];
  for (let index = 0; index < shown.length; index++) for (const node of scopes.get(shown[index]) || []) if (open.has(node.id) && scopes.has(node.id) && !shown.includes(node.id)) shown.push(node.id);
  return shown.some(scope => {
    const siblings = scopes.get(scope) || [], size = (node: CanvasNode) => sizes[node.id] || defaultSize(node);
    if (scope !== rootScope && siblings.length && (Math.min(...siblings.map(node => node.x)) > 0 || Math.min(...siblings.map(node => node.y)) > 0)) return true;
    return siblings.some((a, i) => siblings.slice(i + 1).some(b => a.x < b.x + size(b).width && b.x < a.x + size(a).width && a.y < b.y + size(b).height && b.y < a.y + size(a).height));
  });
}

/** New notes do not turn earlier automatic displacement into deliberate space.
 * Capture their relationships against the last displayed sizes, retaining the
 * established anchors/gaps for surviving neighbours. Manual moves start a new
 * plan instead, so the user's own spacing remains authoritative.
 */
export function extendCanvasReflowPlan(canvas: Canvas, sizes: Record<string, CanvasSize>, previous: CanvasReflowPlan, closedSizes: Record<string, CanvasSize> = sizes): CanvasReflowPlan {
  const next = createCanvasReflowPlan(canvas, sizes, closedSizes);
  const key = (edge: Separation) => `${edge.before}\u0000${edge.after}\u0000${edge.axis}`;
  for (const [scope, current] of Object.entries(next)) {
    const saved = previous[scope];
    if (!saved) continue;
    for (const id of Object.keys(current.anchors)) if (saved.anchors[id]) current.anchors[id] = saved.anchors[id];
    const gaps = new Map(saved.separations.map(edge => [key(edge), edge.gap]));
    for (const edge of current.separations) edge.gap = gaps.get(key(edge)) ?? edge.gap;
  }
  return next;
}

/** Settle children before ancestors using measured collapsed frames and the
 * same visible result footprint as the renderer. No viewport or content changes.
 * An open Group's content starts at its frame's corner: when blocks inside it
 * leave room on its left or top, the frame moves to them and they stay where
 * they are (a Group being opened stays put and its content moves instead). The
 * returned plan keeps that, so closing the Group again leaves its card there.
 */
export function reflowCanvas(source: Canvas, current: CanvasReflowPlan, options: ReflowOptions = {}): { canvas: Canvas; sizes: Record<string, CanvasSize>; plan: CanvasReflowPlan } {
  const canvas = structuredClone(source), plan = structuredClone(current), sizes: Record<string, CanvasSize> = {};
  const expanded = new Set(options.expandedIds || []), opening = new Set(options.opening || []), visiting = new Set<string>();
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  for (const node of canvas.nodes) {
    const seen = new Set<string>([node.id]); let parent = node.parentId;
    while (parent) {
      if (seen.has(parent)) throw new Error('Cannot reflow a cyclic canvas');
      const owner = byId.get(parent); if (!owner) throw new Error('Cannot reflow missing parent groups');
      seen.add(parent); parent = owner.parentId;
    }
    sizes[node.id] = options.nodeSizes?.[node.id] || defaultSize(node);
  }
  const settle = (scope: string): CanvasSize & { offset: { x: number; y: number } } => {
    if (visiting.has(scope)) throw new Error('Cannot reflow a cyclic canvas');
    visiting.add(scope);
    const siblings = canvas.nodes.filter(node => scopeOf(node) === scope);
    const scopePlan = plan[scope];
    if (siblings.length && (!scopePlan || siblings.some(node => !scopePlan.anchors[node.id]))) throw new Error('Cannot reflow a changed canvas with a stale layout plan');
    for (const node of siblings) {
      const children = expanded.has(node.id) ? settle(node.id) : { width: 0, height: 0, offset: { x: 0, y: 0 } }, extra = options.extraContent?.[node.id];
      const contentHeight = extra ? Math.max(children.height ? children.height + LAYOUT_GAP : 0, extra.minY || 0) + extra.height : children.height;
      sizes[node.id] = expanded.has(node.id)
        ? openGroupSize({ width: Math.max(children.width, extra?.width || 0), height: contentHeight })
        : options.nodeSizes?.[node.id] || defaultSize(node);
      if (opening.has(node.id)) continue;
      for (const axis of ['x', 'y'] as const) if (children.offset[axis]) {
        scopePlan.anchors[node.id][axis] += children.offset[axis];
        for (const edge of scopePlan.separations) if (edge.after === node.id && edge.axis === axis) edge.gap += children.offset[axis];
      }
    }
    const offset = { x: 0, y: 0 };
    for (const axis of ['x', 'y'] as const) {
      const extent = extentOf(axis), incoming = new Map<string, Separation[]>(), positions = new Map<string, number>();
      for (const edge of scopePlan?.separations || []) if (edge.axis === axis) add(incoming, edge.after, edge);
      const place = (id: string): number => {
        if (positions.has(id)) return positions.get(id)!;
        const edges = incoming.get(id) || [];
        const value = edges.length ? snap(Math.max(...edges.map(edge => place(edge.before) + snap(sizes[edge.before][extent]) + edge.gap))) : scopePlan.anchors[id][axis];
        positions.set(id, value); return value;
      };
      for (const node of siblings) node[axis] = place(node.id);
      // Inside a Group, room left before the first block is taken out.
      const least = scope === rootScope || !siblings.length ? 0 : Math.min(...siblings.map(node => node[axis]));
      if (least > 0) {
        offset[axis] = least;
        for (const node of siblings) { node[axis] -= least; scopePlan.anchors[node.id][axis] -= least; }
      }
    }
    visiting.delete(scope);
    return { width: Math.max(0, ...siblings.map(node => node.x + sizes[node.id].width)), height: Math.max(0, ...siblings.map(node => node.y + sizes[node.id].height)), offset };
  };
  settle(rootScope);
  if (Object.keys(sizes).length !== canvas.nodes.length) throw new Error('Cannot reflow missing or cyclic parent groups');
  return { canvas, sizes, plan };
}
