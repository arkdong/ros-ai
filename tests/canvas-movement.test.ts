import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedCanvasPosition } from '../src/shared/canvas-position.js';
import { arrangeCanvas, GROUP_INSET } from '../src/shared/layout.js';
import { Store } from '../src/server/store.js';
test('root notes can move left and above origin and survive restart without a view-history entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-movement-')); let store = new Store(dir);
  try {
    const project = store.createProject('Movement');
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'root', title: 'Root', description: '', x: 0, y: 0 } }], 'Add');
    store.mutate(project.id, [{ type: 'updateNode', id: 'root', patch: savedCanvasPosition({ x: -170, y: -80 }, false) }], 'Move');
    store.close(); store = new Store(dir);
    const canvas = store.getProject(project.id).canvas;
    assert.equal(canvas.nodes[0].x, -168); assert.equal(canvas.nodes[0].y, -72);
    assert.deepEqual(arrangeCanvas(canvas).canvas.nodes, canvas.nodes, 'Arrange keeps the negative root corner');
    assert.equal(store.listChanges(project.id).length, 2);
    assert.equal(store.getProject(project.id).revision, 1);
    assert.equal(store.undo(project.id).canvas.nodes.length, 0, 'Undo targets adding the note, not its movement');
    assert.equal(store.redo(project.id).canvas.nodes[0].y, -72);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('child movement keeps its group content boundary and stores relative coordinates', () => {
  assert.deepEqual(savedCanvasPosition({ x: -30, y: -100 }, true), { x: 0, y: 0 });
  assert.deepEqual(savedCanvasPosition({ x: GROUP_INSET.x + 97, y: GROUP_INSET.y + 71 }, true), { x: 96, y: 72 });
});
