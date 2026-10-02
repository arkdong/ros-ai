import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import type { CanvasNode, Mutation, Run } from '../src/shared/types.js';

const node = (id: string, x = 0, y = 0): CanvasNode => ({ id, title: id, description: '', x, y });
const add = (...ids: string[]): Mutation[] => ids.map(id => ({ type: 'addNode', node: node(id) }));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ros-ai-store-'));
  const store = new Store(directory);
  return { store, directory, dispose: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function run(store: Store, projectId: string, nodeId: string, overrides: Partial<Run> = {}): Run {
  const project = store.getProject(projectId);
  return {
    id: randomUUID(), projectId, nodeId, request: 'Research this question', useSearch: false, status: 'running',
    createdAt: new Date().toISOString(), projectRevision: project.revision, node: project.canvas.nodes.find(item => item.id === nodeId)!,
    inputs: [], messages: [{ role: 'user', content: 'Research this question' }], provider: 'test', model: 'local-fake', modelVersion: null,
    configuration: {}, tools: [], events: [], artifactIds: [], ...overrides,
  };
}

test('mutations are atomic, snap to a grid, avoid initial overlap, and validate references', () => {
  const f = fixture();
  try {
    const project = f.store.createProject('Independent investigation');
    const changed = f.store.mutate(project.id, add('idea', 'dataset'), 'Two starting points');
    assert.equal(changed.revision, 1);
    assert.equal(changed.canvas.nodes.length, 2);
    assert.notDeepEqual(changed.canvas.nodes[0], changed.canvas.nodes[1]);
    assert.equal(changed.canvas.nodes[1].x, 480, 'New cards leave room for the actual 408px width and reading gap');
    assert.equal(changed.canvas.nodes[1].y, 0);
    assert.throws(() => f.store.mutate(project.id, [
      { type: 'updateNode', id: 'idea', patch: { title: 'Should roll back' } },
      { type: 'addConnection', connection: { id: 'bad', source: 'idea', target: 'missing', label: '' } },
    ], 'Invalid batch'), /not active/);
    assert.equal(f.store.getProject(project.id).canvas.nodes[0].title, 'idea');
    assert.equal(f.store.listChanges(project.id).length, 2);
    assert.throws(() => f.store.mutate(project.id, [{ type: 'updateNode', id: 'idea', patch: { x: Infinity } }], 'Invalid position'));
    assert.throws(() => f.store.mutate(project.id, add('idea'), 'Duplicate'), /already exists/);
    assert.throws(() => f.store.mutate(project.id, [{ type: 'updateNode', id: 'idea', patch: { y: 0 }, unexpected: true } as Mutation], 'Unexpected properties'));
    assert.equal(f.store.getProject(project.id).revision, 1);
  } finally { f.dispose(); }
});

test('proposals preview and dismiss without mutation; acceptance is one undoable revision and stale previews fail', () => {
  const f = fixture();
  try {
    const project = f.store.createProject('Project');
    const preview = f.store.createProposal(project.id, 0, 'Explore two related ideas', [
      ...add('one', 'two'), { type: 'addConnection', connection: { id: 'rel', source: 'one', target: 'two', label: 'Related' } },
    ]);
    assert.equal(f.store.getProject(project.id).canvas.nodes.length, 0);
    assert.equal(f.store.getProject(project.id).revision, 0);
    const accepted = f.store.acceptProposal(project.id, preview.id);
    assert.equal(accepted.canvas.nodes.length, 2);
    assert.equal(accepted.canvas.connections.length, 1);
    assert.deepEqual(accepted.canvas.nodes, preview.operations.filter(item => item.type === 'addNode').map(item => item.node));
    assert.equal(accepted.revision, 1);
    assert.equal(f.store.undo(project.id).canvas.nodes.length, 0);
    assert.equal(f.store.redo(project.id).canvas.nodes.length, 2);
    assert.equal(f.store.getProject(project.id).revision, 3);
    const stale = f.store.createProposal(project.id, 3, 'Rename', [{ type: 'updateNode', id: 'one', patch: { title: 'Proposed' } }]);
    f.store.mutate(project.id, [{ type: 'updateNode', id: 'one', patch: { title: 'Manual' } }], 'Rename manually');
    assert.throws(() => f.store.acceptProposal(project.id, stale.id), /has changed/);
    assert.equal(f.store.getProject(project.id).canvas.nodes[0].title, 'Manual');
    f.store.dismissProposal(project.id, stale.id);
    assert.equal(f.store.getProject(project.id).revision, 4);
    assert.equal(f.store.detail(project.id).proposals.find(item => item.id === stale.id)?.status, 'dismissed');
    assert.throws(() => f.store.acceptProposal(project.id, preview.id), /resolved/);
  } finally { f.dispose(); }
});

test('undo after undo discards the redo branch without deleting inspectable historical states', () => {
  const f = fixture();
  try {
    const project = f.store.createProject('History');
    f.store.mutate(project.id, add('first'), 'First');
    f.store.mutate(project.id, [{ type: 'updateNode', id: 'first', patch: { title: 'Old branch' } }], 'Rename');
    f.store.undo(project.id);
    f.store.mutate(project.id, [{ type: 'updateNode', id: 'first', patch: { title: 'New branch' } }], 'New rename');
    const detail = f.store.detail(project.id);
    assert.equal(detail.canRedo, false);
    assert.equal(detail.project.revision, 4);
    assert.equal(detail.changes[2].canvas.nodes[0].title, 'Old branch');
    assert.equal(detail.changes[4].canvas.nodes[0].title, 'New branch');
    assert.throws(() => f.store.redo(project.id), /Nothing to redo/);
    assert.equal(f.store.getProject(project.id).canvas.nodes[0].title, 'New branch');
  } finally { f.dispose(); }
});

test('conversation scopes are isolated and removing a node preserves its history and inputs for undo', () => {
  const f = fixture();
  try {
    const project = f.store.createProject('Conversation');
    const other = f.store.createProject('Other project');
    f.store.mutate(project.id, add('a', 'b'), 'Nodes');
    f.store.mutate(other.id, add('elsewhere'), 'Other node');
    f.store.addMessage(project.id, null, 'user', 'Project-only idea');
    f.store.addMessage(project.id, 'a', 'user', 'Node A question');
    f.store.addMessage(project.id, 'b', 'assistant', 'Node B answer');
    assert.deepEqual(f.store.listMessages(project.id, null).map(item => item.content), ['Project-only idea']);
    assert.deepEqual(f.store.listMessages(project.id, 'a').map(item => item.content), ['Node A question']);
    assert.equal(f.store.listMessages(other.id, null).length, 0);
    assert.throws(() => f.store.addMessage(other.id, 'a', 'user', 'Cross project'), /not found/);
    const firstRun = f.store.createRun(run(f.store, project.id, 'a'));
    const artifact = f.store.addArtifact({ projectId: project.id, nodeId: 'a', runId: firstRun.id, kind: 'result', title: 'Result', content: 'Captured finding', capture: 'generated' });
    f.store.addInput(project.id, 'b', artifact.id);
    f.store.mutate(project.id, [{ type: 'removeNode', id: 'a' }], 'Remove');
    assert.equal(f.store.listMessages(project.id, 'a').length, 1);
    assert.equal(f.store.listRuns(project.id).length, 1);
    assert.equal(f.store.detail(project.id).inputs.length, 1);
    assert.equal(f.store.getArtifact(artifact.id).content, 'Captured finding');
    assert.throws(() => f.store.mutate(project.id, add('a'), 'Reuse id'), /removed node/);
    f.store.undo(project.id);
    assert.equal(f.store.getProject(project.id).canvas.nodes.length, 2);
    assert.equal(f.store.listMessages(project.id, 'a')[0].content, 'Node A question');
  } finally { f.dispose(); }
});

test('selected artifacts retain exact immutable content versions and connections alone import nothing', () => {
  const f = fixture();
  try {
    const project = f.store.createProject('Evidence');
    const other = f.store.createProject('Unrelated');
    f.store.mutate(project.id, [...add('source', 'destination'), { type: 'addConnection', connection: { id: 'edge', source: 'source', target: 'destination', label: '' } }], 'Connected');
    f.store.mutate(other.id, add('other'), 'Node');
    assert.equal(f.store.detail(project.id).inputs.length, 0);
    const sourceRun = f.store.createRun(run(f.store, project.id, 'source'));
    const original = f.store.addArtifact({ projectId: project.id, nodeId: 'source', runId: sourceRun.id, kind: 'source', title: 'Source', content: 'Exact captured passage. More context.', capture: 'search-snippet', url: 'https://example.org/source' });
    const input = f.store.addInput(project.id, 'destination', original.id, 'Exact captured passage.');
    assert.equal(f.store.addInput(project.id, 'destination', original.id, input.excerpt).id, input.id);
    assert.throws(() => f.store.addInput(project.id, 'destination', original.id, 'Invented passage'), /exactly/);
    assert.throws(() => f.store.addInput(other.id, 'other', original.id), /not part/);
    assert.throws(() => f.store.removeInput(other.id, input.id), /not found/);
    const captured = f.store.createRun(run(f.store, project.id, 'destination', { inputs: [{ ...input, artifact: original }] }));
    f.store.addArtifact({ projectId: project.id, nodeId: 'source', runId: sourceRun.id, kind: 'result', title: 'Newer result', content: 'Changed conclusion', capture: 'generated' });
    f.store.removeInput(project.id, input.id);
    assert.equal(f.store.getRun(captured.id).inputs[0].artifact.content, 'Exact captured passage. More context.');
    assert.equal(f.store.getRun(captured.id).inputs[0].artifact.hash, original.hash);
    assert.equal(f.store.getRun(captured.id).inputs[0].excerpt, 'Exact captured passage.');
    const database = new DatabaseSync(join(f.directory, 'ros-ai.sqlite'), { readOnly: true });
    const row = database.prepare('SELECT data FROM runs WHERE id = ?').get(captured.id) as { data: string };
    assert.deepEqual(JSON.parse(row.data).inputs[0].artifact, { id: original.id, hash: original.hash });
    database.close();
    assert.throws(() => f.store.updateRun(captured.id, { inputs: [] }), /immutable/);
    assert.equal(f.store.getArtifact(original.id).content, 'Exact captured passage. More context.');
    const files = readdirSync(join(f.directory, 'artifacts'));
    assert.equal(files.length, 2);
    assert.equal(readFileSync(join(f.directory, 'artifacts', `${original.hash}.txt`), 'utf8'), original.content);
  } finally { f.dispose(); }
});

test('restart preserves projects, history, selections and artifacts, and marks uncertain work interrupted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-ai-restart-'));
  let store = new Store(directory);
  try {
    const project = store.createProject('Survives restart');
    store.mutate(project.id, add('a', 'b'), 'Add');
    store.addMessage(project.id, null, 'user', 'Persist this discussion');
    const active = store.createRun(run(store, project.id, 'a'));
    const artifact = store.addArtifact({ projectId: project.id, nodeId: 'a', runId: active.id, kind: 'result', title: 'Partial result', content: 'Durable output' });
    store.addInput(project.id, 'b', artifact.id);
    const queued = store.createRun(run(store, project.id, 'b', { status: 'queued' }));
    const usage = { id: randomUUID(), provider: 'nebius' as const, purpose: 'Test', runId: active.id, reservedUsd: 0.01, estimatedUsd: null, reportedUsage: null, status: 'reserved' as const, basis: 'Test reservation', createdAt: new Date().toISOString() };
    store.addUsage(usage);
    store.createProposal(project.id, 1, 'Persist preview', [{ type: 'updateNode', id: 'b', patch: { title: 'Preview title' } }]);
    store.close();
    store = new Store(directory);
    const detail = store.detail(project.id);
    assert.equal(detail.project.canvas.nodes.length, 2);
    assert.equal(detail.messages[0].content, 'Persist this discussion');
    assert.equal(detail.inputs[0].artifactId, artifact.id);
    assert.equal(detail.artifacts[0].content, 'Durable output');
    assert.equal(detail.proposals[0].status, 'pending');
    assert.equal(store.getRun(active.id).status, 'interrupted');
    assert.equal(store.getRun(queued.id).status, 'interrupted');
    assert.equal(store.getRun(active.id).events.filter(item => item.type === 'interrupted').length, 1);
    assert.equal(store.listUsage()[0].status, 'uncertain');
    assert.equal(store.listUsage()[0].reservedUsd, 0.01);
    assert.equal(store.undo(project.id).canvas.nodes.length, 0);
    store.close();
    store = new Store(directory);
    assert.equal(store.getRun(active.id).events.filter(item => item.type === 'interrupted').length, 1);
    assert.equal(store.detail(project.id).canRedo, true);
    assert.equal(store.redo(project.id).canvas.nodes.length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('proposal and run identities cannot cross projects, and duplicate active runs are rejected per node', () => {
  const f = fixture();
  try {
    const first = f.store.createProject('One');
    const second = f.store.createProject('Two');
    f.store.mutate(first.id, add('a', 'b'), 'Nodes');
    f.store.mutate(second.id, add('c'), 'Node');
    const proposal = f.store.createProposal(first.id, 1, 'Rename a', [{ type: 'updateNode', id: 'a', patch: { title: 'New title' } }]);
    assert.throws(() => f.store.acceptProposal(second.id, proposal.id), /not found/);
    assert.throws(() => f.store.dismissProposal(second.id, proposal.id), /not found/);
    const active = f.store.createRun(run(f.store, first.id, 'a'));
    assert.throws(() => f.store.createRun(run(f.store, first.id, 'a')), /active work/);
    assert.equal(f.store.createRun(run(f.store, first.id, 'b')).status, 'running');
    assert.throws(() => f.store.addMessage(second.id, 'c', 'assistant', 'Wrong run', active.id), /does not belong/);
    assert.throws(() => f.store.createRun(run(f.store, second.id, 'c', { retryOf: active.id })), /this node/);
    f.store.updateRun(active.id, { status: 'failed', error: 'Expected test failure' });
    assert.throws(() => f.store.updateRun(active.id, { error: 'Rewrite failure' }), /immutable/);
    assert.throws(() => f.store.addArtifact({ projectId: first.id, nodeId: 'a', runId: active.id, kind: 'result', title: 'Late output', content: 'Should not appear after failure' }), /Finished runs/);
    const retry = f.store.createRun(run(f.store, first.id, 'a', { retryOf: active.id }));
    assert.equal(retry.retryOf, active.id);
    assert.equal(f.store.getRun(active.id).error, 'Expected test failure');
  } finally { f.dispose(); }
});
