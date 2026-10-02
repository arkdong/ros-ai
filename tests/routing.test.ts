import assert from 'node:assert/strict';
import test from 'node:test';
import { routeAnchor, routeIntersectsNode, routeRelationship, type RouteNode, type RouteSide } from '../src/shared/routing.js';

const node = (id: string, x: number, y: number, width = 360, height = 240, parentId?: string): RouteNode => ({ id, x, y, width, height, ...(parentId ? { parentId } : {}) });
const source = node('source', 0, 0);
function orthogonal(points: { x: number; y: number }[]) {
  for (let index = 1; index < points.length; index++) assert.ok(points[index].x === points[index - 1].x || points[index].y === points[index - 1].y, 'Every segment is orthogonal');
}

test('automatic endpoints adapt to all four directions instead of retaining right-left defaults', () => {
  const cases: [RouteNode, RouteSide, RouteSide][] = [[node('target', 700, 0), 'right', 'left'], [node('target', -700, 0), 'left', 'right'], [node('target', 0, 500), 'bottom', 'top'], [node('target', 0, -500), 'top', 'bottom']];
  for (const [target, from, to] of cases) {
    const result = routeRelationship({ source: source.id, target: target.id, nodes: [source, target] })!;
    assert.equal(result.sourceHandle, from); assert.equal(result.targetHandle, to);
    assert.equal(result.obstructed, false); assert.equal(result.points.length, 2);
    assert.deepEqual(result.points[0], routeAnchor(source, from)); assert.deepEqual(result.points.at(-1), routeAnchor(target, to));
  }
});

test('saved deliberate endpoints stay fixed even when they point away from the destination', () => {
  const target = node('target', 700, 350), nodes = [source, target];
  const result = routeRelationship({ source: source.id, target: target.id, nodes, sourceHandle: 'left', targetHandle: 'bottom' })!;
  assert.equal(result.sourceHandle, 'left'); assert.equal(result.targetHandle, 'bottom');
  assert.deepEqual(result.points[0], { x: 0, y: 120 }); assert.deepEqual(result.points.at(-1), { x: 880, y: 590 });
  assert.equal(result.obstructed, false); orthogonal(result.points);
  assert.equal(routeIntersectsNode(result.points.slice(1, -1), source), false);
  assert.equal(routeIntersectsNode(result.points.slice(1, -1), target), false);
  assert.match(result.path, / Q /, 'Bends are rounded');
});

test('adaptive and fixed-endpoint routes avoid unrelated note interiors and leave relationship data untouched', () => {
  const target = node('target', 950, 0), obstacle = node('middle', 480, -90, 220, 420), nodes = [source, obstacle, target];
  const before = structuredClone(nodes);
  for (const handles of [{}, { sourceHandle: 'right' as const, targetHandle: 'left' as const }]) {
    const result = routeRelationship({ source: source.id, target: target.id, nodes, ...handles })!;
    assert.equal(result.obstructed, false); assert.equal(routeIntersectsNode(result.points, obstacle), false); orthogonal(result.points);
    assert.ok(result.length < 1700, 'The detour stays local to the obstacle');
    assert.ok(result.labelWidth >= 44 && result.labelWidth <= 180);
  }
  assert.deepEqual(nodes, before);
});

test('small diagonal movements retain automatic sides while a clear orientation change switches them', () => {
  const initialTarget = node('target', 500, 380);
  const initial = routeRelationship({ source: source.id, target: initialTarget.id, nodes: [source, initialTarget] })!;
  for (const offset of [-3, 1, -1, 3, 0]) {
    const moved = routeRelationship({ source: source.id, target: initialTarget.id, nodes: [source, { ...initialTarget, y: initialTarget.y + offset }], previous: initial })!;
    assert.equal(moved.sourceHandle, initial.sourceHandle); assert.equal(moved.targetHandle, initial.targetHandle);
  }
  const vertical = routeRelationship({ source: source.id, target: 'target', nodes: [source, node('target', 0, 800)], previous: initial })!;
  assert.equal(vertical.sourceHandle, 'bottom'); assert.equal(vertical.targetHandle, 'top');
});

test('moved obstacle geometry reroutes a saved pair immediately without moving the endpoints', () => {
  const target = node('target', 950, 0), obstacle = node('middle', 480, 500, 220, 240);
  const request = { source: source.id, target: target.id, sourceHandle: 'right' as const, targetHandle: 'left' as const };
  const original = routeRelationship({ ...request, nodes: [source, target, obstacle] })!;
  const movedObstacle = { ...obstacle, y: 0 };
  const moved = routeRelationship({ ...request, nodes: [source, target, movedObstacle], previous: original })!;
  assert.notEqual(moved.path, original.path);
  assert.equal(moved.sourceHandle, original.sourceHandle); assert.equal(moved.targetHandle, original.targetHandle);
  assert.equal(routeIntersectsNode(moved.points, movedObstacle), false);
});

test('nested routes can leave ancestor groups while avoiding unrelated groups and their contents', () => {
  const left = node('left', 0, 0, 720, 700), right = node('right', 1200, 0, 720, 700);
  const a = node('a', 100, 280, 360, 240, left.id), b = node('b', 1300, 280, 360, 240, right.id);
  const unrelated = node('unrelated', 820, 230, 250, 350);
  const result = routeRelationship({ source: a.id, target: b.id, nodes: [left, a, unrelated, right, b] })!;
  assert.equal(result.obstructed, false);
  assert.equal(routeIntersectsNode(result.points, unrelated), false);
  assert.deepEqual(result.points[0], routeAnchor(a, result.sourceHandle));
  assert.deepEqual(result.points.at(-1), routeAnchor(b, result.targetHandle));
});

test('route results are deterministic across node ordering and overlapping notes fail gracefully', () => {
  const target = node('target', 950, 300), obstacles = [node('middle-a', 470, 0, 150, 200), node('middle-b', 700, 270, 150, 330)], nodes = [source, target, ...obstacles];
  const first = routeRelationship({ source: source.id, target: target.id, nodes })!;
  assert.deepEqual(routeRelationship({ source: source.id, target: target.id, nodes: [...nodes].reverse() }), first);
  assert.equal(first.obstructed, false); for (const obstacle of obstacles) assert.equal(routeIntersectsNode(first.points, obstacle), false);
  const overlap = routeRelationship({ source: source.id, target: 'overlap', nodes: [source, node('overlap', 80, 20)], sourceHandle: 'right', targetHandle: 'left' })!;
  assert.equal(overlap.obstructed, true); assert.ok(!/NaN|Infinity/.test(overlap.path)); orthogonal(overlap.points);
  assert.equal(routeRelationship({ source: 'missing', target: source.id, nodes }), undefined);
  assert.equal(routeRelationship({ source: source.id, target: source.id, nodes }), undefined);
});

test('a deliberately blocked endpoint is reported as obstructed rather than claiming a clear detour', () => {
  const target = node('target', 800, 0), narrowBlocker = node('blocker', 365, 100, 2, 40);
  const result = routeRelationship({ source: source.id, target: target.id, nodes: [source, target, narrowBlocker], sourceHandle: 'right', targetHandle: 'left' })!;
  assert.equal(result.sourceHandle, 'right'); assert.equal(result.targetHandle, 'left');
  assert.equal(result.obstructed, true, 'Routing cannot move a saved endpoint through an overlapping card');
});
