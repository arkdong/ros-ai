import type { NestedRelationshipRoute, RelationshipBoundary } from './nested-routing';
import type { RouteNode, RoutePoint } from './routing';

type Box = RoutePoint & { width: number; height: number };
type Item = { id: string; route: NestedRelationshipRoute; label: string };
const BOUNDARY_WIDTH = 188, BOUNDARY_HEIGHT = 60, GAP = 12;
const rect = (point: RoutePoint, width: number, height: number): Box => ({ x: point.x - width / 2, y: point.y - height / 2, width, height });
const touches = (a: Box, b: Box) => a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;
const distance = (a: RoutePoint, b: RoutePoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];

/** Pack all relationship text together. Moving a label never changes its
 * relationship or port; a leader keeps displaced text attached to its line.
 * Fixed boundary text boxes make the rendered and arranged footprints agree.
 */
export function placeRelationshipLabels(items: Item[], nodes: readonly RouteNode[]): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ancestors = (id: string) => {
    const result = new Set<string>(); let parentId = byId.get(id)?.parentId;
    while (parentId && !result.has(parentId)) { result.add(parentId); parentId = byId.get(parentId)?.parentId; }
    return result;
  };
  const occupied: Box[] = [];
  const free = (point: RoutePoint, width: number, height: number, ignored: Set<string>) => {
    const box = rect(point, width, height);
    return !occupied.some(other => touches(box, other)) && !nodes.some(node => !ignored.has(node.id) && touches(box, node));
  };
  const reserve = (candidates: RoutePoint[], preferred: RoutePoint, width: number, height: number, ignored: Set<string>) => {
    const point = candidates.sort((a, b) => distance(a, preferred) - distance(b, preferred)).find(candidate => free(candidate, width, height, ignored));
    if (point) { occupied.push(rect(point, width, height)); return point; }
    // Dense manual layouts can lack a local corridor. An outside label remains
    // readable and connected rather than being painted over a card or another label.
    const fallback = { x: Math.min(...nodes.map(node => node.x)) - width / 2 - 32, y: preferred.y };
    while (!free(fallback, width, height, new Set())) fallback.y += height + GAP * 2;
    occupied.push(rect(fallback, width, height)); return fallback;
  };
  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of ordered) for (const boundary of item.route.boundaries) {
    const horizontal = boundary.side === 'top' || boundary.side === 'bottom';
    const direction = boundary.side === 'left' || boundary.side === 'top' ? -1 : 1;
    const preferred = {
      x: boundary.point.x + (horizontal ? 0 : direction * (BOUNDARY_WIDTH / 2 + GAP)),
      y: boundary.point.y + (horizontal ? direction * (BOUNDARY_HEIGHT / 2 + GAP) : 0),
    };
    const candidates = [0, 1, 2, 3].flatMap(outward => offsets.map(offset => ({
      x: preferred.x + (horizontal ? offset * (BOUNDARY_WIDTH + GAP) : direction * outward * (BOUNDARY_WIDTH + GAP)),
      y: preferred.y + (horizontal ? direction * outward * (BOUNDARY_HEIGHT + GAP) : offset * (BOUNDARY_HEIGHT + GAP)),
    })));
    boundary.label = reserve(candidates, preferred, BOUNDARY_WIDTH, BOUNDARY_HEIGHT, ancestors(boundary.frameId));
    boundary.labelWidth = BOUNDARY_WIDTH; boundary.labelHeight = BOUNDARY_HEIGHT;
  }
  for (const item of ordered) {
    if (!item.label) continue;
    const { route } = item, width = route.labelWidth, height = route.labelHeight ?? 36;
    const ignored = new Set([...ancestors(route.visibleSource)].filter(id => ancestors(route.visibleTarget).has(id)));
    const onLine = route.points.slice(1).flatMap((b, index) => {
      const a = route.points[index];
      return [.5, .25, .75, .1, .9].map(fraction => ({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }));
    });
    const direct = [route.label, ...onLine].find(point => free(point, width, height, ignored));
    if (direct) { occupied.push(rect(direct, width, height)); route.label = direct; continue; }
    const candidates = onLine.flatMap(point => offsets.slice(1).flatMap(offset => [
      { x: point.x + offset * (width + GAP), y: point.y },
      { x: point.x, y: point.y + offset * (height + GAP) },
    ]));
    route.label = reserve(candidates, route.label, width, height, ignored);
    route.labelLeader = closestPoint(route.label, route.points);
  }
}

function closestPoint(point: RoutePoint, points: readonly RoutePoint[]): RoutePoint {
  return points.slice(1).map((b, index) => {
    const a = points[index];
    return { x: Math.max(Math.min(a.x, b.x), Math.min(Math.max(a.x, b.x), point.x)), y: Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), point.y)) };
  }).sort((a, b) => distance(a, point) - distance(b, point))[0] ?? point;
}

export function boundaryLabelCenter(boundary: RelationshipBoundary): RoutePoint {
  if (boundary.label) return boundary.label;
  return { x: boundary.point.x, y: boundary.point.y + 42 };
}
