import { routeRelationship, roundedPath, type RelationshipRoute, type RouteNode, type RoutePoint, type RouteRequest, type RouteSide } from './routing';

type ResearchNodeIdentity = { id: string; parentId?: string | null; title: string };
export type RelationshipBoundary = {
  frameId: string; nodeId: string; title: string; role: 'source' | 'target';
  point: RoutePoint; side: RouteSide; collapsed: boolean;
  label?: RoutePoint; labelWidth?: number; labelHeight?: number;
};
export type NestedRelationshipRoute = RelationshipRoute & {
  visibleSource: string; visibleTarget: string;
  /** Stable React Flow wrappers; custom paths retain the true child endpoints. */
  renderSource: string; renderTarget: string;
  sourceLeg?: RelationshipRoute; targetLeg?: RelationshipRoute;
  boundaries: RelationshipBoundary[];
  labelLeader?: RoutePoint;
};
type NestedRouteRequest = RouteRequest & {
  hierarchy: readonly ResearchNodeIdentity[];
  connectionId: string;
  connections: readonly { id: string; source: string; target: string }[];
};
const opposite: Record<RouteSide, RouteSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** A frame port is derived display geometry, never a stored node or connection.
 * The outside segment joins the outermost divergent frames. Inside segments
 * retain the original child endpoints; a folded child is named at its port.
 */
export function routeNestedRelationship(request: NestedRouteRequest): NestedRelationshipRoute | undefined {
  const identities = new Map(request.hierarchy.map(node => [node.id, node]));
  const visible = new Map(request.nodes.map(node => [node.id, node]));
  const chain = (id: string) => {
    const result: string[] = [], seen = new Set<string>();
    let next: string | undefined | null = id;
    while (next && !seen.has(next)) {
      seen.add(next); result.push(next); next = identities.get(next)?.parentId;
    }
    return result;
  };
  const sourceChain = chain(request.source), targetChain = chain(request.target);
  const sourceId = sourceChain.find(id => visible.has(id)), targetId = targetChain.find(id => visible.has(id));
  if (!sourceId || !targetId || sourceId === targetId) return;
  const common = sourceChain.find(id => targetChain.includes(id));
  const visibleBranch = (ids: string[]) => ids.slice(0, common ? ids.indexOf(common) : ids.length).filter(id => visible.has(id));
  const sourceBranch = visibleBranch(sourceChain), targetBranch = visibleBranch(targetChain);
  const sourceFrame = visible.get(sourceBranch.at(-1) ?? sourceId)!;
  const targetFrame = visible.get(targetBranch.at(-1) ?? targetId)!;
  const isNested = sourceFrame.id !== request.source || targetFrame.id !== request.target;
  if (!isNested) {
    const route = routeRelationship(request);
    return route ? { ...route, visibleSource: sourceId, visibleTarget: targetId, renderSource: sourceId, renderTarget: targetId, boundaries: [] } : undefined;
  }
  const anchors = (frame: RouteNode, role: 'source' | 'target') => {
    // A child can participate in several different relationships. Give each
    // connection endpoint its own stable port, including opposing directions.
    const lanes = request.connections.flatMap(connection => {
      const withinSource = chain(connection.source).includes(frame.id), withinTarget = chain(connection.target).includes(frame.id);
      if (withinSource === withinTarget) return [];
      return [{ id: connection.id, role: withinSource ? 'source' : 'target' }];
    }).sort((a, b) => a.id.localeCompare(b.id) || a.role.localeCompare(b.role));
    const rank = Math.max(0, lanes.findIndex(lane => lane.id === request.connectionId && lane.role === role));
    const fraction = (rank + 1) / (lanes.length + 1);
    const x = frame.x + 24 + Math.max(0, frame.width - 48) * fraction;
    const y = frame.y + 36 + Math.max(0, frame.height - 60) * fraction;
    return { top: { x, y: frame.y }, bottom: { x, y: frame.y + frame.height }, left: { x: frame.x, y }, right: { x: frame.x + frame.width, y } };
  };
  const route = routeRelationship({
    ...request, source: sourceFrame.id, target: targetFrame.id,
    sourceHandle: sourceFrame.id === request.source ? request.sourceHandle : undefined,
    targetHandle: targetFrame.id === request.target ? request.targetHandle : undefined,
    sourceAnchors: sourceFrame.id !== request.source ? anchors(sourceFrame, 'source') : undefined,
    targetAnchors: targetFrame.id !== request.target ? anchors(targetFrame, 'target') : undefined,
  });
  if (!route) return;
  const boundaries: RelationshipBoundary[] = [];
  const insideLeg = (role: 'source' | 'target', frame: RouteNode, visibleId: string, original: string, branch: string[], point: RoutePoint, side: RouteSide) => {
    if (frame.id === original) return undefined;
    const title = identities.get(original)?.title ?? 'Nested note';
    boundaries.push({ frameId: frame.id, nodeId: original, title, role, point, side, collapsed: visibleId !== original });
    if (frame.id === visibleId) return undefined;
    // This zero-sized routing target exists only for this calculation. It is
    // not passed to React Flow, saved to the canvas or exposed as research.
    const portId = `boundary:${role}:${frame.id}:${original}`;
    const port: RouteNode = { id: portId, parentId: frame.id, ...point, width: 0, height: 0 };
    const leg = routeRelationship({
      source: visibleId, target: portId, nodes: [...request.nodes, port], bounds: frame,
      sourceHandle: visibleId === original ? (role === 'source' ? request.sourceHandle : request.targetHandle) : undefined,
      targetHandle: opposite[side],
    });
    if (!leg) return undefined;
    // Deeper nesting retains a marked crossing at every exited frame.
    for (const id of branch.filter(id => id !== frame.id && id !== original)) {
      const inner = visible.get(id)!;
      const crossing = id === visibleId
        ? { point: leg.points[0], side: leg.sourceHandle }
        : lastBoundaryCrossing(leg.points, inner);
      if (crossing) boundaries.push({ frameId: id, nodeId: original, title, role, ...crossing, collapsed: visibleId !== original });
    }
    if (role === 'source') return leg;
    const points = [...leg.points].reverse();
    return { ...leg, points, path: roundedPath(points), sourceHandle: leg.targetHandle, targetHandle: leg.sourceHandle };
  };
  const sourceLeg = insideLeg('source', sourceFrame, sourceId, request.source, sourceBranch, route.points[0], route.sourceHandle);
  const targetLeg = insideLeg('target', targetFrame, targetId, request.target, targetBranch, route.points.at(-1)!, route.targetHandle);
  return {
    ...route, visibleSource: sourceId, visibleTarget: targetId, renderSource: sourceFrame.id, renderTarget: targetFrame.id, sourceLeg, targetLeg, boundaries,
    obstructed: route.obstructed || !!sourceLeg?.obstructed || !!targetLeg?.obstructed,
  };
}

function lastBoundaryCrossing(points: readonly RoutePoint[], frame: RouteNode): { point: RoutePoint; side: RouteSide } | undefined {
  let crossing: { point: RoutePoint; side: RouteSide } | undefined;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (a.x === b.x && a.x >= frame.x && a.x <= frame.x + frame.width) {
      const sides: RouteSide[] = b.y > a.y ? ['top', 'bottom'] : ['bottom', 'top'];
      for (const side of sides) {
        const y = side === 'top' ? frame.y : frame.y + frame.height;
        if (y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) crossing = { point: { x: a.x, y }, side };
      }
    } else if (a.y === b.y && a.y >= frame.y && a.y <= frame.y + frame.height) {
      const sides: RouteSide[] = b.x > a.x ? ['left', 'right'] : ['right', 'left'];
      for (const side of sides) {
        const x = side === 'left' ? frame.x : frame.x + frame.width;
        if (x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x)) crossing = { point: { x, y: a.y }, side };
      }
    }
  }
  return crossing;
}
