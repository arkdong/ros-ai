import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasReflowPlan, reflowCanvas, unsettled } from '../src/shared/canvas-reflow';
import { cardWidth } from '../src/shared/card-size';
import { freeSpot, groupContentRight, openGroupSize, type CanvasSize } from '../src/shared/layout';
import { Store } from '../src/server/store';
import type { Canvas, CanvasNode } from '../src/shared/types';

const block = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, description: '', kind: 'topic', x, y, ...extra });
const CLOSED = { width: 408, height: 300 };
/** A grid of closed Groups, three by three, each with one block inside: the shape an agent's candidate groups take. */
function grid(): Canvas {
  const nodes: CanvasNode[] = [];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
    const id = `g${row}${column}`;
    nodes.push(block(id, column * 480, row * 384, { kind: 'group' }), block(`${id}-cv`, 0, 0, { parentId: id, width: 720, height: 600 }));
  }
  return { nodes, connections: [] };
}
const closedSizes = (canvas: Canvas) => Object.fromEntries(canvas.nodes.map(node => [node.id, node.parentId ? { width: 720, height: 600 } : CLOSED]));
/** The sizes blocks are shown at with these Groups open. */
function shownSizes(canvas: Canvas, open: string[]): Record<string, CanvasSize> {
  const sizes = closedSizes(canvas);
  for (const id of open) sizes[id] = openGroupSize({ width: 720, height: 600 });
  return sizes;
}
const at = (canvas: Canvas) => Object.fromEntries(canvas.nodes.map(node => [node.id, [node.x, node.y]]));
function apart(canvas: Canvas, sizes: Record<string, CanvasSize>) {
  for (const a of canvas.nodes) for (const b of canvas.nodes) {
    if (a.id === b.id || a.parentId !== b.parentId) continue;
    assert.ok(a.x + sizes[a.id].width + 32 <= b.x || b.x + sizes[b.id].width + 32 <= a.x || a.y + sizes[a.id].height + 32 <= b.y || b.y + sizes[b.id].height + 32 <= a.y, `${a.id} overlaps ${b.id}`);
  }
}

test('opening a Group moves its row and its column together, and closing it puts every block back', () => {
  const closed = grid(), plan = createCanvasReflowPlan(closed, closedSizes(closed));
  const opened = reflowCanvas(closed, plan, { expandedIds: ['g11'], nodeSizes: closedSizes(closed) });
  apart(opened.canvas, opened.sizes);
  const position = at(opened.canvas);
  for (const row of [0, 1, 2]) assert.equal(new Set([0, 1, 2].map(column => position[`g${row}${column}`][1])).size, 1, `row ${row} stays a row`);
  for (const column of [0, 1, 2]) assert.equal(new Set([0, 1, 2].map(row => position[`g${row}${column}`][0])).size, 1, `column ${column} stays a column`);
  assert.deepEqual(position.g00, [0, 0], 'Blocks before the open Group stay put');
  assert.ok(position.g22[0] > 960 && position.g22[1] > 768, 'The block below and to the right moves both ways');
  const shut = reflowCanvas(opened.canvas, opened.plan, { nodeSizes: closedSizes(closed) });
  assert.deepEqual(at(shut.canvas), at(closed), 'Closing it again puts every block back');
  // A plan made while the Group is open (after a reload, or another block moved) closes it the same way.
  const reloaded = createCanvasReflowPlan(opened.canvas, shownSizes(opened.canvas, ['g11']), closedSizes(closed));
  assert.deepEqual(at(reflowCanvas(opened.canvas, reloaded, { expandedIds: ['g11'], nodeSizes: closedSizes(closed) }).canvas), position, 'The plan keeps the layout it was made from');
  assert.deepEqual(at(reflowCanvas(opened.canvas, reloaded, { nodeSizes: closedSizes(closed) }).canvas), at(closed));
});

test('a Group shown open over its neighbours, as another browser or an agent left it, is settled once', () => {
  const canvas = grid(), sizes = shownSizes(canvas, ['g00']);
  assert.equal(unsettled(canvas, closedSizes(canvas), []), false);
  assert.equal(unsettled(canvas, sizes, ['g00']), true);
  const result = reflowCanvas(canvas, createCanvasReflowPlan(canvas, sizes, closedSizes(canvas)), { expandedIds: ['g00'], nodeSizes: closedSizes(canvas) });
  apart(result.canvas, result.sizes);
  assert.equal(unsettled(result.canvas, result.sizes, ['g00']), false);
  const position = at(result.canvas);
  assert.equal(position.g01[1], position.g02[1], 'The pushed row stays a row');
  assert.equal(position.g10[0], position.g20[0], 'The pushed column stays a column');
});

test("an open Group's frame starts at its content: it moves to blocks left inside it, and a Group being opened keeps its place", () => {
  const canvas: Canvas = { nodes: [block('group', 480, 0, { kind: 'group' }), block('right', 2328, 0), block('profile', 24, 72, { parentId: 'group' }), block('cv', 1272, 72, { parentId: 'group', width: 420 })], connections: [] };
  const sizes = { group: CLOSED, right: CLOSED, profile: CLOSED, cv: { width: 420, height: 560 } };
  const open = { ...sizes, group: openGroupSize({ width: 1272 + 420, height: 72 + 560 }) };
  assert.equal(unsettled(canvas, open, ['group']), true);
  const plan = createCanvasReflowPlan(canvas, open, sizes);
  const opened = reflowCanvas(canvas, plan, { expandedIds: ['group'], nodeSizes: sizes, opening: ['group'] });
  assert.deepEqual(at(opened.canvas), { group: [480, 0], right: [480 + opened.sizes.group.width + 72, 0], profile: [0, 0], cv: [1248, 0] }, 'Opened: the frame stays and its content moves into the corner');
  const moved = reflowCanvas(canvas, plan, { expandedIds: ['group'], nodeSizes: sizes });
  assert.deepEqual(at(moved.canvas).group, [504, 72], 'Already open: the frame moves to the blocks, which stay where they are');
  assert.deepEqual([at(moved.canvas).profile, at(moved.canvas).cv], [[0, 0], [1248, 0]]);
  assert.equal(at(moved.canvas).right[0], 2328, 'A neighbour keeps its place when the frame only lost room on its left');
  const shut = reflowCanvas(moved.canvas, moved.plan, { nodeSizes: sizes });
  assert.deepEqual(at(shut.canvas).group, [504, 72], 'Closed again, the card stays where the frame went');
});

test('a closed Group fits what it lists whatever width was saved on it', () => {
  assert.equal(cardWidth({ kind: 'group', width: 1200 }), 408);
  assert.equal(cardWidth({ kind: 'topic', width: 1200 }), 1200);
});

test('a new block goes to the first free spot beside or below the blocks in a Group, not past its right edge', () => {
  const boxes = [{ x: 0, y: 0, width: 720, height: 420 }, { x: 792, y: 0, width: 420, height: 560 }, { x: 0, y: 648, width: 420, height: 440 }];
  assert.equal(groupContentRight(boxes), 1212);
  assert.deepEqual(freeSpot(boxes, { width: 408, height: 420 }, { x: 0, y: 0 }, groupContentRight(boxes)), { x: 504, y: 648 });
  // A Group with one block fills out into columns rather than one long line.
  const one = [{ x: 0, y: 0, width: 408, height: 420 }, { x: 0, y: 492, width: 408, height: 420 }];
  assert.deepEqual(freeSpot(one, { width: 408, height: 420 }, { x: 0, y: 0 }, groupContentRight(one)), { x: 480, y: 0 });
  assert.equal(freeSpot([{ x: 0, y: 0, width: 408, height: 420 }], { width: 720, height: 420 }, { x: 0, y: 0 }, 704), undefined, 'Nothing wider than the room there is');
});

test('a block an agent files into a Group on top of another goes to a free spot that keeps the frame as it is', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-group-layout-'));
  const store = new Store(directory);
  try {
    const project = store.createProject('Candidate groups');
    store.mutate(project.id, [
      { type: 'addNode', node: block('candidate', 0, 0, { kind: 'group' }) },
      { type: 'addNode', node: block('profile', 0, 0, { parentId: 'candidate', width: 720 }) },
      { type: 'addNode', node: block('cv', 792, 0, { parentId: 'candidate', width: 420, height: 560 }) },
      { type: 'addNode', node: block('page', 0, 648, { parentId: 'candidate', width: 420, height: 440 }) },
    ], 'Candidate');
    const proposal = store.createProposal(project.id, 1, 'File the cover letter', [{ type: 'addNode', node: block('letter', 0, 0, { parentId: 'candidate' }) }]);
    const letter = store.acceptProposal(project.id, proposal.id).canvas.nodes.find(node => node.id === 'letter')!;
    assert.deepEqual([letter.x, letter.y], [504, 648]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
