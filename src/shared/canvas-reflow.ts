import { cardWidth, setCardHeight, CARD_DEFAULT_HEIGHT } from './card-size';
import { GROUP_FOOTER, GROUP_INSET, LAYOUT_GAP, type CanvasSize, type LayoutOptions } from './layout';
import { displayRelationship } from './relationships';
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
const rootScope = '\u0000root';
const snap = (value: number) => Math.ceil(value / 24) * 24;
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const scopeOf = (node: CanvasNode) => node.parentId || rootScope;

export function createCanvasReflowPlan(canvas: Canvas, sizes: Record<string, CanvasSize>): CanvasReflowPlan {
  const plan: CanvasReflowPlan = {};
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  const scopeNode = (id: string, scope: string): string | undefined => {
    const seen = new Set<string>();
    let node = byId.get(id);
    while (node && !seen.has(node.id)) {
      if (scopeOf(node) === scope) return node.id;
      seen.add(node.id); node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  };
  const dependencies = canvas.connections.map(displayRelationship).filter(connection => connection.dependency);
  for (const scope of new Set(canvas.nodes.map(scopeOf))) {
    const siblings = canvas.nodes.filter(node => scopeOf(node) === scope).sort((a, b) => compareId(a.id, b.id));
    const anchors = Object.fromEntries(siblings.map(node => [node.id, { x: scope === rootScope ? node.x : Math.max(0, node.x), y: scope === rootScope ? node.y : Math.max(0, node.y) }]));
    const separations: Separation[] = [];
    const related = new Set(dependencies.flatMap(connection => {
      const source = scopeNode(connection.source, scope), target = scopeNode(connection.target, scope);
      return source && target && source !== target ? [`${source}\u0000${target}`] : [];
    }));
    for (let i = 0; i < siblings.length; i++) for (let j = i + 1; j < siblings.length; j++) {
      const a = siblings[i], b = siblings[j];
      const sa = sizes[a.id] || { width: cardWidth(a), height: setCardHeight(a) ?? CARD_DEFAULT_HEIGHT };
      const sb = sizes[b.id] || { width: cardWidth(b), height: setCardHeight(b) ?? CARD_DEFAULT_HEIGHT };
      const pa = anchors[a.id], pb = anchors[b.id];
      const separatedX = pa.x + sa.width <= pb.x || pb.x + sb.width <= pa.x;
      const separatedY = pa.y + sa.height <= pb.y || pb.y + sb.height <= pa.y;
      // A source already above its consumer stays above it, including projected
      // nested relationships. Cyclic/same-row links keep geometric order; no
      // dependency can introduce a cycle in the per-axis constraint graph.
      const orderedDependency = (related.has(`${a.id}\u0000${b.id}`) && pa.y + sa.height <= pb.y)
        || (related.has(`${b.id}\u0000${a.id}`) && pb.y + sb.height <= pa.y);
      const axis: Axis = orderedDependency || (separatedY && !separatedX) ? 'y'
        : separatedX && !separatedY ? 'x'
        : Math.abs(pb.y - pa.y) / Math.max(sa.height, sb.height) >= Math.abs(pb.x - pa.x) / Math.max(sa.width, sb.width) ? 'y' : 'x';
      const before = pa[axis] < pb[axis] || (pa[axis] === pb[axis] && compareId(a.id, b.id) < 0) ? a : b;
      const after = before === a ? b : a;
      const extent = axis === 'x' ? 'width' : 'height';
      const distance = anchors[after.id][axis] - anchors[before.id][axis] - (sizes[before.id]?.[extent] ?? (axis === 'x' ? cardWidth(before) : setCardHeight(before) ?? CARD_DEFAULT_HEIGHT));
      // Retain deliberately placed gaps. Expansion-created displacement is
      // absent from this stable plan, so collapse still pulls neighbours back.
      separations.push({ before: before.id, after: after.id, axis, gap: distance > 0 ? Math.max(32, distance) : LAYOUT_GAP });
    }
    // Aligned rows/columns share the open gap after their largest frame. A
    // shorter parallel sibling must not mistake that frame's reserved area for
    // intentional empty space when a plan is captured with a group expanded.
    const alignedGap = new Map<string, number>();
    const alignmentKey = (edge: Separation) => `${edge.axis}:${anchors[edge.before][edge.axis]}:${anchors[edge.after][edge.axis]}`;
    for (const edge of separations) alignedGap.set(alignmentKey(edge), Math.min(alignedGap.get(alignmentKey(edge)) ?? Infinity, edge.gap));
    for (const edge of separations) edge.gap = alignedGap.get(alignmentKey(edge))!;
    // All pairs establish non-overlap, but a distant pair's measured gap can
    // include an entire intervening expanded frame. Retaining that redundant
    // constraint would freeze expansion space after reload or manual Arrange.
    // Keep only adjacent constraints in each axis DAG; their transitive paths
    // still guarantee every pair's separation and preserve genuine open gaps.
    const reduced: Separation[] = [];
    for (const axis of ['x', 'y'] as const) {
      const outgoing = new Map<string, Separation[]>(), reachable = new Map<string, Set<string>>();
      for (const edge of separations) if (edge.axis === axis) outgoing.set(edge.before, [...(outgoing.get(edge.before) || []), edge]);
      const descendants = (id: string): Set<string> => {
        if (!reachable.has(id)) {
          const ids = new Set<string>([id]);
          for (const edge of outgoing.get(id) || []) for (const target of descendants(edge.after)) ids.add(target);
          reachable.set(id, ids);
        }
        return reachable.get(id)!;
      };
      for (const edges of outgoing.values()) for (const edge of edges) if (!edges.some(other => other !== edge && descendants(other.after).has(edge.after))) reduced.push(edge);
    }
    plan[scope] = { anchors, separations: reduced };
  }
  return plan;
}

/** New notes do not turn earlier automatic displacement into deliberate space.
 * Capture their relationships against the last displayed sizes, retaining the
 * established anchors/gaps for surviving neighbours. Manual moves start a new
 * plan instead, so the user's own spacing remains authoritative.
 */
export function extendCanvasReflowPlan(canvas: Canvas, sizes: Record<string, CanvasSize>, previous: CanvasReflowPlan): CanvasReflowPlan {
  const next = createCanvasReflowPlan(canvas, sizes);
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
 */
export function reflowCanvas(source: Canvas, plan: CanvasReflowPlan, options: LayoutOptions = {}): { canvas: Canvas; sizes: Record<string, CanvasSize> } {
  const canvas = structuredClone(source), sizes: Record<string, CanvasSize> = {};
  const expanded = new Set(options.expandedIds || []), visiting = new Set<string>();
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  for (const node of canvas.nodes) {
    const seen = new Set<string>([node.id]); let parent = node.parentId;
    while (parent) {
      if (seen.has(parent)) throw new Error('Cannot reflow a cyclic canvas');
      const owner = byId.get(parent); if (!owner) throw new Error('Cannot reflow missing parent groups');
      seen.add(parent); parent = owner.parentId;
    }
    sizes[node.id] = options.nodeSizes?.[node.id] || { width: cardWidth(node), height: setCardHeight(node) ?? CARD_DEFAULT_HEIGHT };
  }
  const settle = (scope: string): CanvasSize => {
    if (visiting.has(scope)) throw new Error('Cannot reflow a cyclic canvas');
    visiting.add(scope);
    const siblings = canvas.nodes.filter(node => scopeOf(node) === scope);
    for (const node of siblings) {
      const children = expanded.has(node.id) ? settle(node.id) : { width: 0, height: 0 }, extra = options.extraContent?.[node.id];
      const contentHeight = extra ? Math.max(children.height ? children.height + LAYOUT_GAP : 0, extra.minY || 0) + extra.height : children.height;
      sizes[node.id] = expanded.has(node.id)
        ? { width: snap(Math.max(768, Math.max(children.width, extra?.width || 0) + GROUP_INSET.x * 2)), height: snap(Math.max(408, contentHeight + GROUP_INSET.y + GROUP_FOOTER)) }
        : options.nodeSizes?.[node.id] || { width: cardWidth(node), height: setCardHeight(node) ?? CARD_DEFAULT_HEIGHT };
    }
    const current = plan[scope];
    if (siblings.length && (!current || siblings.some(node => !current.anchors[node.id]))) throw new Error('Cannot reflow a changed canvas with a stale layout plan');
    for (const axis of ['x', 'y'] as const) {
      const extent = axis === 'x' ? 'width' : 'height';
      const positions = new Map<string, number>();
      const place = (id: string): number => {
        if (positions.has(id)) return positions.get(id)!;
        const incoming = current.separations.filter(edge => edge.axis === axis && edge.after === id);
        const value = incoming.length ? snap(Math.max(...incoming.map(edge => place(edge.before) + sizes[edge.before][extent] + edge.gap))) : current.anchors[id][axis];
        positions.set(id, value); return value;
      };
      for (const node of siblings) node[axis] = place(node.id);
    }
    visiting.delete(scope);
    return { width: Math.max(0, ...siblings.map(node => node.x + sizes[node.id].width)), height: Math.max(0, ...siblings.map(node => node.y + sizes[node.id].height)) };
  };
  settle(rootScope);
  if (Object.keys(sizes).length !== canvas.nodes.length) throw new Error('Cannot reflow missing or cyclic parent groups');
  return { canvas, sizes };
}
