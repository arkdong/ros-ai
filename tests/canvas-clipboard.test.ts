import test from 'node:test';
import assert from 'node:assert/strict';
import { copyBlocks, pasteOperations, readCopiedBlocks } from '../src/shared/canvas-clipboard.js';
import type { Canvas, CanvasNode } from '../src/shared/types.js';

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, description: '', x: 0, y: 0, ...patch });
const canvas: Canvas = {
  nodes: [
    node('group', { kind: 'group', x: 100, y: 100, groupHighlights: [{ nodeId: 'inner', artifactId: 'a1', hash: 'f'.repeat(64) }] }),
    node('inner', { parentId: 'group', x: 24, y: 48, artifactId: 'a1' }),
    node('nested', { kind: 'group', parentId: 'group', x: 480, y: 0 }),
    node('deep', { parentId: 'nested', x: 0, y: 0 }),
    node('outside', { x: 900, y: 0, agent: { runtime: 'claude', turnId: 't1' }, blockType: 'agent' }),
  ],
  connections: [
    { id: 'c1', source: 'inner', target: 'deep', label: 'feeds' },
    { id: 'c2', source: 'inner', target: 'outside', label: 'leaves' },
  ],
};
let counter = 0;
const ids = () => `new-${++counter}`;

test('copying a Group takes everything inside it and only the links between copied blocks', () => {
  const copy = copyBlocks(canvas, ['group', 'inner'], 'p1')!;
  assert.deepEqual(copy.nodes.map(item => item.id), ['group', 'inner', 'nested', 'deep']);
  assert.deepEqual(copy.connections.map(item => item.id), ['c1']);
  assert.equal(copyBlocks(canvas, ['missing'], 'p1'), null);
  assert.deepEqual(readCopiedBlocks(JSON.stringify(copy)), copy);
  assert.equal(readCopiedBlocks('plain words'), null);
});

test('pasting makes new blocks on the nearest free spot and keeps the inside of a Group in place', () => {
  counter = 0;
  const copy = copyBlocks(canvas, ['group'], 'p1')!;
  const { operations, ids: roots } = pasteOperations(copy, canvas, 'p1', ids, item => item.id === 'group' ? { width: 768, height: 408 } : undefined);
  const added = operations.flatMap(op => op.type === 'addNode' ? [op.node] : []);
  assert.equal(roots.length, 1);
  const group = added.find(item => item.id === roots[0])!, inner = added.find(item => item.title === 'inner')!, deep = added.find(item => item.title === 'deep')!;
  // Right of the Group is taken by 'outside', so the copy goes below it.
  assert.deepEqual([group.x, group.y], [100, 100 + 504]);
  assert.equal(group.parentId, null);
  assert.equal(group.groupHighlights, undefined);
  assert.deepEqual([inner.parentId, inner.x, inner.y, inner.artifactId], [group.id, 24, 48, 'a1']);
  assert.equal(deep.parentId, added.find(item => item.title === 'nested')!.id);
  const link = operations.find(op => op.type === 'addConnection');
  assert.ok(link?.type === 'addConnection' && link.connection.source === inner.id && link.connection.target === deep.id && link.connection.id !== 'c1');
  assert.ok(added.every(item => !canvas.nodes.some(original => original.id === item.id)));
});

test('a pasted block keeps its Group when that Group is on the canvas, and drops what belongs to another project', () => {
  const copy = copyBlocks(canvas, ['inner', 'outside'], 'p1')!;
  const here = pasteOperations(copy, canvas, 'p1', ids).operations.flatMap(op => op.type === 'addNode' ? [op.node] : []);
  assert.equal(here.find(item => item.title === 'inner')!.parentId, 'group');
  assert.equal(here.find(item => item.title === 'outside')!.agent, undefined);
  assert.equal(here.find(item => item.title === 'outside')!.blockType, 'agent');
  const elsewhere = pasteOperations(copy, { nodes: [], connections: [] }, 'p2', ids).operations.flatMap(op => op.type === 'addNode' ? [op.node] : []);
  assert.equal(elsewhere.find(item => item.title === 'inner')!.parentId, null);
  assert.equal(elsewhere.find(item => item.title === 'inner')!.artifactId, undefined);
});

test('pasting the same block again finds the next free spot', () => {
  const lone: Canvas = { nodes: [node('a', { x: 0, y: 0 })], connections: [] };
  const copy = copyBlocks(lone, ['a'], 'p1')!;
  const first = pasteOperations(copy, lone, 'p1', ids).operations.flatMap(op => op.type === 'addNode' ? [op.node] : []);
  assert.deepEqual([first[0].x, first[0].y], [480, 0]);
  const next = pasteOperations(copy, { ...lone, nodes: [...lone.nodes, ...first] }, 'p1', ids).operations.flatMap(op => op.type === 'addNode' ? [op.node] : []);
  assert.deepEqual([next[0].x, next[0].y], [0, 504]);
});
