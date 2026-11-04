import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { cardScale } from '../src/shared/card-size.js';
import type { CanvasNode } from '../src/shared/types.js';

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, description: 'A note.', x: 0, y: 0, ...extra });

test('a block is full size unless shrunk, and a Group never shrinks itself', () => {
  assert.equal(cardScale(node('a')), 1);
  assert.equal(cardScale(node('a', { scale: 0.4 })), 0.4);
  assert.equal(cardScale(node('a', { scale: null })), 1);
  assert.equal(cardScale(node('a', { scale: 0.1 })), 0.25);
  assert.equal(cardScale(node('g', { kind: 'group', scale: 0.4 })), 1);
});

test('shrinking a block is saved, and full size or null takes the scale off', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-card-scale-'));
  const store = new Store(directory);
  try {
    const project = store.createProject('Scale');
    store.mutate(project.id, [{ type: 'addNode', node: node('card') }], 'Card');
    store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { scale: 0.4 } }], 'Shrink');
    assert.equal(store.getProject(project.id).canvas.nodes[0].scale, 0.4);
    store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { scale: null } }], 'Full');
    assert.equal(Object.hasOwn(store.getProject(project.id).canvas.nodes[0], 'scale'), false);
    store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { scale: 0.7 } }], 'Shrink');
    store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { scale: 1 } }], 'Full');
    assert.equal(Object.hasOwn(store.getProject(project.id).canvas.nodes[0], 'scale'), false);
    for (const scale of [0.2, 1.5, NaN]) assert.throws(() => store.mutate(project.id, [{ type: 'updateNode', id: 'card', patch: { scale } }], 'Bad'));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
