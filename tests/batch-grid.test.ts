import assert from 'node:assert/strict';
import test from 'node:test';
import { batchGrid } from '../src/server/store';
import type { CanvasNode, Mutation } from '../src/shared/types';

const block = (id: string, x: number, y: number): CanvasNode => ({ id, kind: 'topic', title: id, description: 'A short note.', x, y });
const add = (node: CanvasNode): Mutation => ({ type: 'addNode', node });

test('a batch of new blocks becomes a compact four-column grid', () => {
  const loose = Array.from({ length: 6 }, (_, i) => add(block(`n${i}`, 480 + i * 900, i * 600)));
  const placed = batchGrid(loose, []).map(op => op.type === 'addNode' ? op.node : null);
  assert.deepEqual(placed.map(node => node!.x), [480, 960, 1440, 1920, 480, 960]);
  assert.equal(new Set(placed.slice(0, 4).map(node => node!.y)).size, 1);
  assert.ok(placed[4]!.y > placed[0]!.y && placed[4]!.y - placed[0]!.y < 600);
});

test('the grid moves below existing blocks it would cover, and small proposals keep their positions', () => {
  const placed = batchGrid([add(block('a', 0, 0)), add(block('b', 100, 0)), add(block('c', 200, 0))], [block('old', 0, 0)]);
  assert.ok(placed.every(op => op.type === 'addNode' && op.node.y >= 420));
  const two = [add(block('a', 5000, 5000)), add(block('b', 9000, 9000))];
  assert.deepEqual(batchGrid(two, []), two);
});
