import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { cardWidth, estimatedCardHeight } from '../src/shared/card-size.js';
import { LAYOUT_GAP } from '../src/shared/layout.js';
import type { CanvasNode } from '../src/shared/types.js';

const node = (id: string, width?: number): CanvasNode => ({ id, title: id, description: 'The complete saved research purpose.', x: 0, y: 0, ...(width === undefined ? {} : { width }) });

test('card width is optional on existing records and saved resizing stays outside content undo across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-card-width-'));
  let store = new Store(directory);
  try {
    const project = store.createProject('Width persistence');
    store.mutate(project.id, [{ type: 'addNode', node: node('legacy') }], 'Original card');
    const original = store.getProject(project.id).canvas.nodes[0];
    assert.equal(Object.hasOwn(original, 'width'), false);
    assert.equal(cardWidth(original), 408);
    store.mutate(project.id, [{ type: 'updateNode', id: 'legacy', patch: { width: 575 } }], 'Resize card');
    assert.deepEqual(store.getProject(project.id).canvas.nodes[0], { ...original, width: 575 });
    assert.equal(store.undo(project.id).canvas.nodes.length, 0, 'Resizing did not append an undo step');
    store.redo(project.id);
    store.close(); store = new Store(directory);
    assert.deepEqual(store.getProject(project.id).canvas.nodes[0], { ...original, width: 575 });
    assert.equal(store.undo(project.id).canvas.nodes.length, 0);
    assert.deepEqual(store.redo(project.id).canvas.nodes[0], { ...original, width: 575 });
    assert.equal(Object.hasOwn(store.listChanges(project.id)[1].canvas.nodes[0], 'width'), false, 'Old history is never backfilled');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('invalid card widths reject atomically, while both limits are accepted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-card-width-'));
  const store = new Store(directory);
  try {
    const project = store.createProject('Width validation');
    store.mutate(project.id, [{ type: 'addNode', node: node('card') }], 'Original card');
    for (const width of [319, 1201, 400.5, Infinity, NaN]) {
      assert.throws(() => store.mutate(project.id, [
        { type: 'updateNode', id: 'card', patch: { title: 'Must roll back' } },
        { type: 'updateNode', id: 'card', patch: { width } },
      ], 'Invalid resize'));
      assert.throws(() => store.mutate(project.id, [{ type: 'addNode', node: node('invalid', width) }], 'Invalid initial width'));
      assert.equal(store.getProject(project.id).revision, 1);
      assert.equal(store.getProject(project.id).canvas.nodes[0].title, 'card');
    }
    for (const width of [320, 1200]) {
      store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { width } }], 'Resize to allowed limit');
      assert.equal(store.getProject(project.id).canvas.nodes[0].width, width);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('new and proposed cards respect unequal widths with deterministic snapped placement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-card-width-'));
  const store = new Store(directory);
  try {
    const project = store.createProject('Mixed widths');
    store.mutate(project.id, [{ type: 'addNode', node: node('wide', 720) }], 'Wide card');
    const proposal = store.createProposal(project.id, 1, 'Add varied cards', [
      { type: 'addNode', node: node('narrow', 320) },
      { type: 'addNode', node: node('odd', 575) },
      { type: 'addNode', node: node('default') },
      { type: 'addNode', node: { ...node('left', 720), x: -480 } },
    ]);
    const accepted = store.acceptProposal(project.id, proposal.id);
    assert.deepEqual(accepted.canvas.nodes.slice(1), proposal.operations.filter(operation => operation.type === 'addNode').map(operation => operation.node));
    for (const card of accepted.canvas.nodes) {
      assert.equal(Math.abs(card.x % 24), 0);
      assert.equal(Math.abs(card.y % 24), 0);
      for (const other of accepted.canvas.nodes.filter(candidate => candidate.id !== card.id)) {
        const separated = card.x >= other.x + cardWidth(other) + LAYOUT_GAP
          || other.x >= card.x + cardWidth(card) + LAYOUT_GAP
          // A batch is laid out by each row's own card height (estimatedCardHeight), not the tallest possible card.
          || Math.abs(card.y - other.y) >= estimatedCardHeight(card.y < other.y ? card : other) + LAYOUT_GAP;
        assert.equal(separated, true, `${card.id} and ${other.id} keep their reading gap`);
      }
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a card height set by resizing is layout, stays within its limits and is given back to the content with null', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-card-height-'));
  let store = new Store(directory);
  try {
    const project = store.createProject('Height persistence');
    store.mutate(project.id, [{ type: 'addNode', node: node('card') }], 'Original card');
    const original = store.getProject(project.id).canvas.nodes[0];
    for (const height of [223, 1201, 300.5, Infinity, NaN]) assert.throws(() => store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { height } }], 'Invalid height'));
    store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { height: 640, width: 560, x: -48, y: -24 } }], 'Resize block');
    assert.deepEqual(store.getProject(project.id).canvas.nodes[0], { ...original, height: 640, width: 560, x: -48, y: -24 });
    assert.equal(estimatedCardHeight(store.getProject(project.id).canvas.nodes[0]), 640);
    assert.equal(store.undo(project.id).canvas.nodes.length, 0, 'Resizing did not append an undo step');
    store.redo(project.id);
    store.close(); store = new Store(directory);
    assert.equal(store.getProject(project.id).canvas.nodes[0].height, 640);
    store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { height: null } }], 'Fit block to its content');
    assert.equal(Object.hasOwn(store.getProject(project.id).canvas.nodes[0], 'height'), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
