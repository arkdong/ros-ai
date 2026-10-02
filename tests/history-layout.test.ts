import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import type { Canvas, CanvasNode, Change } from '../src/shared/types.js';

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, description: 'Saved research context', x: 0, y: 0, ...extra });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-content-history-'));
  let store = new Store(directory);
  const project = store.createProject('Content history');
  const database = () => new DatabaseSync(join(directory, 'ros-ai.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { project, get store() { return store; }, database, reopen() { store.close(); store = new Store(directory); } };
}
function rawHistory(f: ReturnType<typeof fixture>) {
  const db = f.database();
  try { return JSON.parse((db.prepare('SELECT history FROM projects WHERE id = ?').get(f.project.id) as { history: string }).history) as { stack: Canvas[]; cursor: number }; }
  finally { db.close(); }
}
function rawChanges(f: ReturnType<typeof fixture>) {
  const db = f.database();
  try { return db.prepare('SELECT data FROM changes WHERE project_id = ? ORDER BY revision').all(f.project.id).map(row => row.data); }
  finally { db.close(); }
}
function seedLegacy(f: ReturnType<typeof fixture>, stack: Canvas[], cursor: number) {
  const db = f.database();
  try {
    const current = { ...f.project, revision: stack.length - 1, canvas: stack[cursor] };
    db.prepare('UPDATE projects SET data = ?, history = ? WHERE id = ?').run(JSON.stringify(current), JSON.stringify({ stack, cursor }), current.id);
    db.prepare('DELETE FROM changes WHERE project_id = ?').run(current.id);
    for (const [revision, canvas] of stack.entries()) {
      // Labels intentionally say nothing useful about the actual difference.
      const change: Change = { id: `legacy-${revision}`, projectId: current.id, revision, label: 'Saved edit', canvas, createdAt: current.createdAt };
      db.prepare('INSERT INTO changes(id, project_id, revision, data) VALUES (?, ?, ?, ?)').run(change.id, current.id, revision, JSON.stringify(change));
      for (const item of canvas.nodes) db.prepare('INSERT OR IGNORE INTO node_identities(project_id, node_id) VALUES (?, ?)').run(current.id, item.id);
    }
  } finally { db.close(); }
}

test('layout preserves content revision, redo, raw snapshots and latest view across restart', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, [{ type: 'addNode', node: node('a') }], 'Add note');
  f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { title: 'New finding' } }], 'Rename');
  f.store.undo(id);
  const before = f.store.getProject(id), stack = rawHistory(f), records = rawChanges(f);
  for (let i = 1; i <= 5; i++) f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { x: -i * 24, y: i * 48, width: 600 } }], 'Automatic reflow', before.revision);
  assert.equal(f.store.getProject(id).revision, before.revision);
  assert.equal(f.store.detail(id).canRedo, true);
  assert.deepEqual(rawHistory(f).stack, stack.stack);
  assert.equal(rawHistory(f).cursor, stack.cursor);
  assert.deepEqual(rawChanges(f), records);
  f.reopen();
  assert.equal(f.store.detail(id).canRedo, true);
  assert.deepEqual(f.store.redo(id).canvas.nodes[0], node('a', { title: 'New finding', x: -120, y: 240, width: 600 }));
  assert.deepEqual(f.store.undo(id).canvas.nodes[0], node('a', { x: -120, y: 240, width: 600 }));
});

test('mixed edits undo content while keeping view, and identical edits do not erase redo', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, [{ type: 'addNode', node: node('a') }], 'Add');
  f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { title: 'Refined', description: 'Changed question', kind: 'activity', x: -120, width: 500 } }], 'Arrange canvas');
  assert.equal(f.store.getProject(id).revision, 2, 'Classification uses actual content, never the label');
  assert.deepEqual(f.store.undo(id).canvas.nodes[0], node('a', { x: -120, width: 500 }));
  const before = f.store.detail(id);
  f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { title: 'a', x: -120 } }], 'No change');
  assert.deepEqual(f.store.detail(id), before);
  assert.equal(f.store.redo(id).canvas.nodes[0].title, 'Refined');
});

test('content removal restores last saved layout and reparent undo retains scope-relative positions', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, [{ type: 'addNode', node: node('group') }, { type: 'addNode', node: node('child') }], 'Add');
  f.store.mutate(id, [{ type: 'updateNode', id: 'child', patch: { x: -240, y: 72, width: 520 } }], 'Move root');
  f.store.mutate(id, [{ type: 'updateNode', id: 'child', patch: { parentId: 'group', x: 24, y: 24 } }], 'Move into group');
  f.store.mutate(id, [{ type: 'updateNode', id: 'child', patch: { x: 72, y: 96, width: 600 } }], 'Move child');
  const undone = f.store.undo(id).canvas.nodes.find(item => item.id === 'child')!;
  assert.equal(undone.parentId, undefined);
  assert.deepEqual({ x: undone.x, y: undone.y, width: undone.width }, { x: -240, y: 72, width: 600 });
  const redone = f.store.redo(id).canvas.nodes.find(item => item.id === 'child')!;
  assert.deepEqual({ x: redone.x, y: redone.y, width: redone.width, parentId: redone.parentId }, { x: 72, y: 96, width: 600, parentId: 'group' });
  f.store.mutate(id, [{ type: 'removeNode', id: 'group' }], 'Remove group and child');
  f.reopen();
  assert.deepEqual(f.store.undo(id).canvas.nodes.find(item => item.id === 'child'), redone);
});

test('legacy layout entries are hidden and skipped without rewriting old changes or history on read', t => {
  const f = fixture(t), id = f.project.id;
  const empty: Canvas = { nodes: [], connections: [] };
  const first: Canvas = { nodes: [node('a')], connections: [] };
  const moved: Canvas = { nodes: [node('a', { x: -120, width: 500 })], connections: [] };
  const edited: Canvas = { nodes: [node('a', { title: 'Refined', x: -120, width: 500 })], connections: [] };
  const resized: Canvas = { nodes: [node('a', { title: 'Refined', x: 48, width: 600 })], connections: [] };
  seedLegacy(f, [empty, first, moved, edited, resized], 4);
  const records = rawChanges(f), history = rawHistory(f);
  f.reopen();
  assert.deepEqual(f.store.listChanges(id).map(change => change.revision), [0, 1, 3]);
  assert.equal(f.store.detail(id).canUndo, true);
  assert.equal(f.store.detail(id).canRedo, false);
  assert.deepEqual(rawChanges(f), records);
  assert.deepEqual(rawHistory(f), history, 'Read and reopen do not migrate legacy state');
  const undo = f.store.undo(id);
  assert.deepEqual(undo.canvas.nodes[0], node('a', { x: 48, width: 600 }));
  assert.equal(f.store.undo(id).canvas.nodes.length, 0);
  assert.equal(f.store.detail(id).canUndo, false);
  assert.deepEqual(f.store.redo(id).canvas.nodes[0], node('a', { x: 48, width: 600 }));
  assert.equal(f.store.redo(id).canvas.nodes[0].title, 'Refined');
  assert.equal(f.store.detail(id).canRedo, false);
  assert.deepEqual(rawChanges(f).slice(0, records.length), records, 'Old immutable snapshots remain byte-for-byte intact');
  assert.deepEqual(rawHistory(f).stack, history.stack);
});

test('legacy cursor with only equivalent layout neighbors has no undo or redo; relationships remain content', t => {
  const f = fixture(t), id = f.project.id;
  const initial: Canvas = { nodes: [node('a'), node('b', { x: 480 })], connections: [] };
  const rearranged: Canvas = { nodes: [node('b', { x: 720 }), node('a', { x: -240, width: 600 })], connections: [] };
  seedLegacy(f, [initial, rearranged, structuredClone(initial)], 1);
  assert.equal(f.store.detail(id).canUndo, false);
  assert.equal(f.store.detail(id).canRedo, false);
  assert.equal(f.store.listChanges(id).length, 1, 'Node order does not make a content change');
  assert.throws(() => f.store.undo(id), /Nothing to undo/);
  assert.throws(() => f.store.redo(id), /Nothing to redo/);
  f.store.mutate(id, [{ type: 'addConnection', connection: { id: 'edge', source: 'a', target: 'b', label: 'Compare' } }], 'Connect');
  const before = f.store.getProject(id).canvas.nodes;
  assert.equal(f.store.detail(id).canUndo, true);
  assert.deepEqual(f.store.undo(id).canvas.nodes, before);
  assert.equal(f.store.getProject(id).canvas.connections.length, 0);
  assert.equal(f.store.redo(id).canvas.connections[0].label, 'Compare');
});

test('layout saves preserve pending proposal freshness; subsequent content edits still conflict', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, [{ type: 'addNode', node: node('a') }], 'Add');
  const proposal = f.store.createProposal(id, 1, 'Refine question', [{ type: 'updateNode', id: 'a', patch: { title: 'Accepted refinement' } }]);
  f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { x: -240, y: -96, width: 600 } }], 'Resize and move');
  const accepted = f.store.acceptProposal(id, proposal.id);
  assert.deepEqual(accepted.canvas.nodes[0], node('a', { title: 'Accepted refinement', x: -240, y: -96, width: 600 }));
  const stale = f.store.createProposal(id, accepted.revision, 'Old question', [{ type: 'updateNode', id: 'a', patch: { description: 'New description' } }]);
  f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { title: 'Manual refinement' } }], 'Refine again');
  assert.throws(() => f.store.acceptProposal(id, stale.id), /has changed/);
});

test('layout and content undo leave captured results, selections and spending audits unchanged', t => {
  const f = fixture(t), id = f.project.id;
  const project = f.store.mutate(id, [{ type: 'addNode', node: node('a') }, { type: 'addNode', node: node('b') }], 'Add');
  const run = f.store.createRun({ id: 'saved-run', projectId: id, nodeId: 'a', request: 'Previously completed fixture', useSearch: false, status: 'running', createdAt: project.createdAt, projectRevision: project.revision, node: project.canvas.nodes[0], inputs: [], messages: [], provider: 'offline-fixture', model: 'fixture', modelVersion: null, configuration: { approved: 'exact captured input' }, tools: [], events: [], artifactIds: [] });
  const artifact = f.store.addArtifact({ projectId: id, nodeId: 'a', runId: run.id, kind: 'result', title: 'Saved result', content: 'Exact saved finding', capture: 'generated' });
  f.store.updateRun(run.id, { status: 'completed', artifactIds: [artifact.id] });
  f.store.addInput(id, 'b', artifact.id);
  f.store.addUsage({ id: 'saved-spend', provider: 'nebius', runId: run.id, purpose: 'Historical fixture', reservedUsd: 1, estimatedUsd: null, reportedUsage: null, status: 'uncertain', basis: 'Unknown historical outcome', createdAt: project.createdAt });
  f.store.saveRecord('admission', 'saved-admission', id, { projectId: id, consumed: 1 });
  const captured = { run: f.store.getRun(run.id), artifact: f.store.getArtifact(artifact.id), inputs: f.store.detail(id).inputs, usage: f.store.listUsage(), admission: f.store.records('admission', id) };
  f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { title: 'Revised question' } }], 'Edit content');
  f.store.mutate(id, [{ type: 'updateNode', id: 'a', patch: { x: -720, width: 700 } }], 'Resize and move');
  f.store.undo(id);
  f.reopen();
  f.store.redo(id);
  assert.deepEqual({ run: f.store.getRun(run.id), artifact: f.store.getArtifact(artifact.id), inputs: f.store.detail(id).inputs, usage: f.store.listUsage(), admission: f.store.records('admission', id) }, captured);
});
