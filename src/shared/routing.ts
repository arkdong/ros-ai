/** Display geometry only. Routing never changes saved note or relationship data. */
export type RouteSide = 'top' | 'right' | 'bottom' | 'left';
export type RoutePoint = { x: number; y: number };
export type RouteNode = RoutePoint & { id: string; width: number; height: number; parentId?: string };
export type RelationshipRoute = {
  sourceHandle: RouteSide; targetHandle: RouteSide; points: RoutePoint[]; path: string;
  label: RoutePoint; labelWidth: number; labelHeight?: number; length: number; obstructed: boolean;
};
export type RouteRequest = {
  source: string; target: string; nodes: readonly RouteNode[];
  sourceHandle?: RouteSide; targetHandle?: RouteSide;
  previous?: Pick<RelationshipRoute, 'sourceHandle' | 'targetHandle'>;
  sourceAnchors?: Partial<Record<RouteSide, RoutePoint>>; targetAnchors?: Partial<Record<RouteSide, RoutePoint>>;
  labelSize?: { width: number; height: number };
  bounds?: RouteNode;
};
type Rect = { left: number; right: number; top: number; bottom: number };
const SIDES: RouteSide[] = ['right', 'bottom', 'left', 'top'];
const CLEARANCE = 14, STUB = 26, BEND_COST = 16, SIDE_HYSTERESIS = 36;
const same = (a: RoutePoint, b: RoutePoint) => Math.abs(a.x - b.x) < .001 && Math.abs(a.y - b.y) < .001;
const distance = (a: RoutePoint, b: RoutePoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const rect = (node: RouteNode, padding = CLEARANCE): Rect => ({ left: node.x - padding, right: node.x + node.width + padding, top: node.y - padding, bottom: node.y + node.height + padding });
const within = (p: RoutePoint, box: Rect) => p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
const inside = (p: RoutePoint, box: Rect) => p.x > box.left + .001 && p.x < box.right - .001 && p.y > box.top + .001 && p.y < box.bottom - .001;
function intersects(a: RoutePoint, b: RoutePoint, box: Rect) {
  if (a.x === b.x) return a.x > box.left + .001 && a.x < box.right - .001 && Math.max(a.y, b.y) > box.top + .001 && Math.min(a.y, b.y) < box.bottom - .001;
  if (a.y === b.y) return a.y > box.top + .001 && a.y < box.bottom - .001 && Math.max(a.x, b.x) > box.left + .001 && Math.min(a.x, b.x) < box.right - .001;
  return true;
}
export function routeIntersectsNode(points: readonly RoutePoint[], node: RouteNode) {
  return points.slice(1).some((point, index) => intersects(points[index], point, rect(node, 0)));
}
export function routeAnchor(node: RouteNode, side: RouteSide): RoutePoint {
  return side === 'left' ? { x: node.x, y: node.y + node.height / 2 } : side === 'right' ? { x: node.x + node.width, y: node.y + node.height / 2 } : side === 'top' ? { x: node.x + node.width / 2, y: node.y } : { x: node.x + node.width / 2, y: node.y + node.height };
}
const outside = (point: RoutePoint, side: RouteSide): RoutePoint => ({ x: point.x + (side === 'right' ? STUB : side === 'left' ? -STUB : 0), y: point.y + (side === 'bottom' ? STUB : side === 'top' ? -STUB : 0) });
function simplify(points: RoutePoint[]) {
  const out: RoutePoint[] = [];
  for (const point of points) {
    if (out.length && same(out.at(-1)!, point)) continue;
    while (out.length > 1) {
      const a = out.at(-2)!, b = out.at(-1)!;
      if ((a.x === b.x && b.x === point.x && (b.y - a.y) * (point.y - b.y) >= 0) || (a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0)) out.pop(); else break;
    }
    out.push(point);
  }
  return out;
}
const pathLength = (points: RoutePoint[]) => points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0);
const pathScore = (points: RoutePoint[]) => pathLength(points) + Math.max(0, points.length - 2) * BEND_COST;
const clear = (points: RoutePoint[], boxes: Rect[]) => !points.slice(1).some((point, index) => boxes.some(box => intersects(points[index], point, box)));
const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
function overlaps(a: Rect, b: Rect) { return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top; }

/** Short doglegs handle ordinary layouts without building a large visibility grid.
 * A single bend turns near the source and arrives straight, so links from one
 * block to several others branch beside it and each reaches its block on its own line. */
function shortRoute(a: RoutePoint, b: RoutePoint, boxes: Rect[], bounds?: Rect, arriveHorizontally = false): RoutePoint[] | undefined {
  const usable = (points: RoutePoint[]) => clear(points, boxes) && (!bounds || points.every(point => within(point, bounds)));
  const candidates: RoutePoint[][] = [];
  if ((a.x === b.x || a.y === b.y) && usable([a, b])) return [a, b];
  const across: RoutePoint[] = [a, { x: b.x, y: a.y }, b], along: RoutePoint[] = [a, { x: a.x, y: b.y }, b];
  candidates.push(...(arriveHorizontally ? [along, across] : [across, along]));
  const elbow = candidates.map(simplify).find(usable);
  if (elbow) return elbow;
  const region = { left: Math.min(a.x, b.x) - STUB, right: Math.max(a.x, b.x) + STUB, top: Math.min(a.y, b.y) - STUB, bottom: Math.max(a.y, b.y) + STUB };
  const near = boxes.filter(box => overlaps(box, region)).sort((first, second) => Math.abs((first.left + first.right) / 2 - (a.x + b.x) / 2) + Math.abs((first.top + first.bottom) / 2 - (a.y + b.y) / 2) - Math.abs((second.left + second.right) / 2 - (a.x + b.x) / 2) - Math.abs((second.top + second.bottom) / 2 - (a.y + b.y) / 2)).slice(0, 18);
  const xs = unique([(a.x + b.x) / 2, region.left - STUB, region.right + STUB, ...near.flatMap(box => [box.left, box.right])]);
  const ys = unique([(a.y + b.y) / 2, region.top - STUB, region.bottom + STUB, ...near.flatMap(box => [box.top, box.bottom])]);
  for (const x of xs) candidates.push([a, { x, y: a.y }, { x, y: b.y }, b]);
  for (const y of ys) candidates.push([a, { x: a.x, y }, { x: b.x, y }, b]);
  return candidates.map(simplify).filter(usable).sort((first, second) => pathScore(first) - pathScore(second))[0];
}

/** Bounded rectilinear visibility search for corridors needing more than two bends. */
function corridorRoute(a: RoutePoint, b: RoutePoint, boxes: Rect[], limit?: Rect): RoutePoint[] | undefined {
  const bounds = { left: Math.min(a.x, b.x) - 120, right: Math.max(a.x, b.x) + 120, top: Math.min(a.y, b.y) - 120, bottom: Math.max(a.y, b.y) + 120 };
  const nearby = boxes.filter(box => overlaps(box, bounds)).slice(0, 48);
  const xs = unique([a.x, b.x, ...nearby.flatMap(box => [box.left, box.right]), Math.min(bounds.left, ...nearby.map(box => box.left)) - STUB, Math.max(bounds.right, ...nearby.map(box => box.right)) + STUB]);
  const ys = unique([a.y, b.y, ...nearby.flatMap(box => [box.top, box.bottom]), Math.min(bounds.top, ...nearby.map(box => box.top)) - STUB, Math.max(bounds.bottom, ...nearby.map(box => box.bottom)) + STUB]);
  const width = xs.length, start = ys.indexOf(a.y) * width + xs.indexOf(a.x), goal = ys.indexOf(b.y) * width + xs.indexOf(b.x);
  const point = (index: number): RoutePoint => ({ x: xs[index % width], y: ys[Math.floor(index / width)] });
  const blocked = new Set<number>();
  for (let y = 0; y < ys.length; y++) for (let x = 0; x < xs.length; x++) if ((limit && !within({ x: xs[x], y: ys[y] }, limit)) || boxes.some(box => inside({ x: xs[x], y: ys[y] }, box))) blocked.add(y * width + x);
  if (blocked.has(start) || blocked.has(goal)) return;
  type Entry = { key: number; index: number; direction: number; score: number; cost: number };
  const queue: Entry[] = [{ key: start * 3, index: start, direction: 0, score: distance(a, b), cost: 0 }], costs = new Map([[start * 3, 0]]), previous = new Map<number, number>();
  const segments = new Map<string, boolean>();
  while (queue.length) {
    queue.sort((first, second) => second.score - first.score || second.key - first.key);
    const entry = queue.pop()!;
    if (entry.cost !== costs.get(entry.key)) continue;
    if (entry.index === goal) {
      const points: RoutePoint[] = []; let key: number | undefined = entry.key;
      while (key !== undefined) { points.push(point(Math.floor(key / 3))); key = previous.get(key); }
      return simplify(points.reverse());
    }
    const x = entry.index % width, y = Math.floor(entry.index / width);
    const next = [[x - 1, y, 1], [x + 1, y, 1], [x, y - 1, 2], [x, y + 1, 2]];
    for (const [nx, ny, direction] of next) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
      const index = ny * width + nx; if (blocked.has(index)) continue;
      const segmentKey = `${Math.min(entry.index, index)}:${Math.max(entry.index, index)}`;
      if (!segments.has(segmentKey)) segments.set(segmentKey, clear([point(entry.index), point(index)], boxes));
      if (!segments.get(segmentKey)) continue;
      const key = index * 3 + direction, cost = entry.cost + distance(point(entry.index), point(index)) + (entry.direction && entry.direction !== direction ? BEND_COST : 0);
      if (cost >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, cost); previous.set(key, entry.key);
      queue.push({ key, index, direction, cost, score: cost + distance(point(index), b) });
    }
  }
}
export function roundedPath(points: RoutePoint[]) {
  if (!points.length) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1], b = points[index], c = points[index + 1], radius = Math.min(10, distance(a, b) / 2, distance(b, c) / 2);
    const before = { x: b.x + Math.sign(a.x - b.x) * radius, y: b.y + Math.sign(a.y - b.y) * radius }, after = { x: b.x + Math.sign(c.x - b.x) * radius, y: b.y + Math.sign(c.y - b.y) * radius };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  const end = points.at(-1)!; return `${path} L ${end.x} ${end.y}`;
}
function labelPlacement(points: RoutePoint[], boxes: Rect[], size?: { width: number; height: number }) {
  const candidates = points.slice(1).flatMap((b, index) => {
    const a = points[index], horizontal = a.y === b.y, length = distance(a, b);
    const width = size?.width ?? (horizontal ? Math.max(44, Math.min(180, length - 16)) : 150);
    const height = size?.height ?? 36;
    return [.5, .25, .75].map(fraction => {
      const label = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
      const area = { left: label.x - width / 2 - 6, right: label.x + width / 2 + 6, top: label.y - height / 2 - 6, bottom: label.y + height / 2 + 6 };
      return { label, width, height, length, blocked: boxes.some(box => overlaps(area, box)), central: fraction === .5 };
    });
  }).sort((a, b) => Number(a.blocked) - Number(b.blocked) || b.length - a.length || Number(b.central) - Number(a.central));
  return { label: candidates[0]?.label ?? points[0], labelWidth: candidates[0]?.width ?? 150, labelHeight: candidates[0]?.height ?? 36 };
}

export function routeRelationship(request: RouteRequest): RelationshipRoute | undefined {
  const byId = new Map(request.nodes.map(node => [node.id, node]));
  const source = byId.get(request.source), target = byId.get(request.target);
  if (!source || !target || source.id === target.id) return;
  const ancestors = new Set<string>();
  for (const node of [source, target]) {
    let parentId = node.parentId;
    while (parentId && !ancestors.has(parentId)) { ancestors.add(parentId); parentId = byId.get(parentId)?.parentId; }
  }
  // Parent boundaries are traversable: a child relationship must be able to
  // leave its own group. Unrelated groups and their cards remain obstacles.
  const obstacles = request.nodes.filter(node => !ancestors.has(node.id));
  const boxes = obstacles.map(node => rect(node));
  const sourceSides = request.sourceHandle ? [request.sourceHandle] : SIDES, targetSides = request.targetHandle ? [request.targetHandle] : SIDES;
  const pairs = sourceSides.flatMap(sourceHandle => targetSides.map(targetHandle => {
    const from = request.sourceAnchors?.[sourceHandle] ?? routeAnchor(source, sourceHandle), to = request.targetAnchors?.[targetHandle] ?? routeAnchor(target, targetHandle), a = outside(from, sourceHandle), b = outside(to, targetHandle);
    return { sourceHandle, targetHandle, from, to, a, b, distance: distance(a, b) };
  })).sort((a, b) => a.distance - b.distance);
  const candidates: { points: RoutePoint[]; sourceHandle: RouteSide; targetHandle: RouteSide; score: number }[] = [];
  const eligible: typeof pairs = [];
  const sourceBoxes = obstacles.filter(node => node.id !== source.id).map(node => rect(node));
  const targetBoxes = obstacles.filter(node => node.id !== target.id).map(node => rect(node));
  for (const pair of pairs) {
    // A clear short route cannot be improved by endpoint pairs whose minimum
    // Manhattan length is already longer than it (including side hysteresis).
    const priorPair = pair.sourceHandle === request.previous?.sourceHandle && pair.targetHandle === request.previous?.targetHandle;
    if (candidates.length && pair.distance + STUB * 2 > Math.min(...candidates.map(candidate => candidate.score)) + (priorPair ? SIDE_HYSTERESIS : 0)) continue;
    // Short endpoint stubs may cross only their own note boundary.
    if (!clear([pair.from, pair.a], sourceBoxes) || !clear([pair.b, pair.to], targetBoxes)) continue;
    eligible.push(pair);
    const middle = shortRoute(pair.a, pair.b, boxes, request.bounds ? rect(request.bounds, 0) : undefined, pair.targetHandle === 'left' || pair.targetHandle === 'right');
    if (middle) { const points = simplify([pair.from, ...middle, pair.to]); candidates.push({ points, sourceHandle: pair.sourceHandle, targetHandle: pair.targetHandle, score: pathScore(points) }); }
  }
  if (!candidates.length) {
    for (const pair of eligible.slice(0, 4)) {
      const middle = corridorRoute(pair.a, pair.b, boxes, request.bounds ? rect(request.bounds, 0) : undefined);
      if (middle) { const points = simplify([pair.from, ...middle, pair.to]); candidates.push({ points, sourceHandle: pair.sourceHandle, targetHandle: pair.targetHandle, score: pathScore(points) }); break; }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  let best = candidates[0];
  const prior = candidates.find(candidate => candidate.sourceHandle === request.previous?.sourceHandle && candidate.targetHandle === request.previous?.targetHandle);
  if (best && prior && prior.score <= best.score + SIDE_HYSTERESIS) best = prior;
  let obstructed = false;
  if (!best) {
    const pair = pairs[0]; const points = simplify([pair.from, pair.a, { x: pair.a.x, y: pair.b.y }, pair.b, pair.to]);
    best = { points, sourceHandle: pair.sourceHandle, targetHandle: pair.targetHandle, score: pathScore(points) }; obstructed = true;
  }
  return { sourceHandle: best.sourceHandle, targetHandle: best.targetHandle, points: best.points, path: roundedPath(best.points), ...labelPlacement(best.points, obstacles.map(node => rect(node, 0)), request.labelSize), length: pathLength(best.points), obstructed };
}
