import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasRuleError, applyOperations, type CanvasLookups } from '../src/shared/canvas-ops';
import type { Canvas, CanvasNode, Mutation } from '../src/shared/types';

// The canvas rules run with no store behind them: what they look up comes in from whoever keeps the canvas.
const lookups = (retired: string[] = []): CanvasLookups => ({
  retired: id => retired.includes(id),
  artifact: id => { throw new Error(`No saved version ${id}`); },
  savedArtifact: () => undefined,
});
const empty = (): { id: string; canvas: Canvas } => ({ id: 'p1', canvas: { nodes: [], connections: [] } });
const block = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, description: '', x: 0, y: 0, ...extra });
const add = (node: CanvasNode): Mutation => ({ type: 'addNode', node });

test('a list of changes gives a new canvas and the changes as they landed', () => {
  const project = empty();
  const { canvas, operations } = applyOperations(project, [add(block('a', { x: 10, y: 13 })), add(block('b', { x: 10, y: 13 })), { type: 'addConnection', connection: { id: 'l1', source: 'a', target: 'b', label: 'supports' } }], lookups(), false);
  assert.deepEqual(project.canvas.nodes, [], 'the canvas given is left as it was');
  assert.deepEqual(canvas.nodes.map(node => node.id), ['a', 'b']);
  assert.equal(canvas.connections.length, 1);
  // The first block lands on the grid; the second is moved off it, and the returned change says where.
  const [first, second] = operations.map(op => op.type === 'addNode' ? op.node : null);
  assert.deepEqual([first!.x, first!.y], [0, 24]);
  assert.notDeepEqual([second!.x, second!.y], [first!.x, first!.y]);
  assert.deepEqual(canvas.nodes[1], second);
});

test('two copies that apply the same changes in the same order hold the same canvas', () => {
  const changes: Mutation[][] = [
    [add(block('g', { kind: 'group' })), add(block('a')), add(block('b'))],
    [{ type: 'updateNode', id: 'a', patch: { parentId: 'g', title: 'Question' } }],
    [{ type: 'removeNode', id: 'b' }],
  ];
  const run = () => changes.reduce((canvas, list) => applyOperations({ id: 'p1', canvas }, list, lookups(), false).canvas, empty().canvas);
  assert.deepEqual(run(), run());
  assert.deepEqual(run().nodes.map(node => [node.id, node.parentId ?? null]), [['g', null], ['a', 'g']]);
});

test('a change the rules refuse is refused whole, as a CanvasRuleError', () => {
  const start = applyOperations(empty(), [add(block('g1', { kind: 'group' })), add(block('g2', { kind: 'group', parentId: 'g1' }))], lookups(), false).canvas;
  const refused = (list: Mutation[], retired: string[] = []) => assert.throws(() => applyOperations({ id: 'p1', canvas: start }, list, lookups(retired), false), CanvasRuleError);
  refused([{ type: 'updateNode', id: 'g1', patch: { parentId: 'g2' } }]);
  refused([add(block('old'))], ['old']);
  refused([add(block('fine')), { type: 'removeNode', id: 'missing' }]);
  refused([{ type: 'addConnection', connection: { id: 'l', source: 'g1', target: 'g1', label: '' } }]);
});

test('a proposal may not record decisions', () => {
  const start = applyOperations(empty(), [add(block('a'))], lookups(), false).canvas;
  assert.throws(() => applyOperations({ id: 'p1', canvas: start }, [{ type: 'updateNode', id: 'a', patch: { decisions: [] } }], lookups(), true), CanvasRuleError);
});
