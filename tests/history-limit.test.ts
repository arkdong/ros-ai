import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HISTORY_STEPS, Store } from '../src/server/store.js';
import type { CanvasNode } from '../src/shared/types.js';

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, description: '', x: 0, y: 0, ...extra });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-history-limit-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const stored = (projectId: string) => {
    const db = new DatabaseSync(join(directory, 'ros-ai.sqlite'), { readOnly: true });
    try { return JSON.parse((db.prepare('SELECT history FROM projects WHERE id = ?').get(projectId) as { history: string }).history) as { stack: unknown[]; cursor: number }; }
    finally { db.close(); }
  };
  return { store, stored };
}
const write = (store: Store, projectId: string, times: number) => {
  for (let index = 1; index <= times; index++) store.mutate(projectId, [{ type: 'updateNode', id: 'note', patch: { description: `Draft ${index}` } }], 'Edit note');
};

test('undo keeps the last hundred steps, so each edit stops growing with the project', t => {
  const { store, stored } = fixture(t), project = store.createProject('Long writing');
  store.mutate(project.id, [{ type: 'addNode', node: node('note') }], 'Add note');
  write(store, project.id, HISTORY_STEPS + 20);
  const history = stored(project.id);
  assert.equal(history.stack.length, HISTORY_STEPS);
  assert.equal(history.cursor, HISTORY_STEPS - 1);
  // Every edit is still listed, and each can be opened.
  assert.equal(store.listChanges(project.id).length, HISTORY_STEPS + 22);
  for (let step = 1; step < HISTORY_STEPS; step++) store.undo(project.id);
  assert.equal(store.getProject(project.id).canvas.nodes[0].description, 'Draft 21', 'The oldest step kept is the edit 99 steps back');
  assert.equal(store.detail(project.id).canUndo, false);
  assert.throws(() => store.undo(project.id), /Nothing to undo/);
  assert.equal(store.redo(project.id).canvas.nodes[0].description, 'Draft 22');
  assert.equal(store.detail(project.id).canRedo, true);
});

test('the project page lists changes without their canvases; one change is fetched when opened', t => {
  const { store } = fixture(t), project = store.createProject('Changes'), other = store.createProject('Other');
  store.mutate(project.id, [{ type: 'addNode', node: node('note') }], 'Add note');
  store.mutate(project.id, [{ type: 'updateNode', id: 'note', patch: { x: 480 } }], 'Move note');
  write(store, project.id, 2);
  const { changes } = store.detail(project.id);
  assert.deepEqual(changes.map(change => change.label), ['Project created', 'Add note', 'Edit note', 'Edit note']);
  assert.ok(changes.every(change => !('canvas' in change)));
  const opened = store.getChange(project.id, changes[2].id);
  assert.equal(opened.label, 'Edit note');
  assert.equal(opened.canvas.nodes[0].description, 'Draft 1');
  assert.throws(() => store.getChange(other.id, changes[2].id), (error: Error & { status?: number }) => error.status === 404);
  assert.throws(() => store.getChange(project.id, 'missing'), /Change not found/);
});

test('blocks pasted with their saved versions stay one undo step when undo is full', t => {
  const { store } = fixture(t), source = store.createProject('Source'), project = store.createProject('Target');
  store.mutate(source.id, [{ type: 'addNode', node: node('finding') }], 'Add finding');
  const at = new Date().toISOString(), sourceNode = store.getProject(source.id).canvas.nodes[0];
  const run = store.createRun({ id: randomUUID(), projectId: source.id, nodeId: 'finding', request: 'Find', useSearch: false, status: 'running', createdAt: at, projectRevision: 1, node: sourceNode, inputs: [], messages: [], provider: 'test', model: 'fake', modelVersion: null, configuration: {}, tools: [], events: [], artifactIds: [] });
  const saved = store.addArtifact({ projectId: source.id, nodeId: 'finding', runId: run.id, kind: 'result', title: 'Finding', content: 'Saved result', capture: 'generated' });
  store.mutate(project.id, [{ type: 'addNode', node: node('note') }], 'Add note');
  write(store, project.id, HISTORY_STEPS);
  const before = store.getProject(project.id);
  const pasted = store.pasteBlocks(project.id, [{ type: 'addNode', node: node('copy', { x: 960 }) }], 'Paste 1 block', before.revision, [{ nodeId: 'copy', artifactId: saved.id }]);
  assert.ok(pasted.canvas.nodes.find(item => item.id === 'copy')?.artifactId);
  const undone = store.undo(project.id);
  assert.equal(undone.canvas.nodes.some(item => item.id === 'copy'), false, 'One Undo takes the pasted block away');
  assert.equal(undone.canvas.nodes[0].description, `Draft ${HISTORY_STEPS}`);
});
