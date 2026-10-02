import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { CombinedNebiusBudget } from '../src/server/combined-budget.js';
import { arrangeCanvas } from '../src/shared/layout.js';
import type { CanvasNode, Mutation, Run } from '../src/shared/types.js';

const node = (id: string, parentId?: string): CanvasNode => ({ id, title: `Note ${id}`, description: `Research context ${id}`, kind: 'activity', x: 0, y: 0, ...(parentId ? { parentId } : {}) });
const add = (...nodes: CanvasNode[]): Mutation[] => nodes.map(node => ({ type: 'addNode', node }));
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-interactions-'));
  let store = new Store(directory);
  const project = store.createProject('Direct workspace interactions');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { project, get store() { return store; }, reopen() { store.close(); store = new Store(directory); } };
}
function startRun(store: Store, projectId: string, nodeId: string, status: 'running' | 'queued' = 'running') {
  const project = store.getProject(projectId);
  const run: Run = { id: randomUUID(), projectId, nodeId, request: 'Offline captured fixture', useSearch: false, status, createdAt: '2026-09-22T09:00:00Z', projectRevision: project.revision, node: project.canvas.nodes.find(n => n.id === nodeId)!, inputs: [], messages: [], provider: 'local', model: 'fixture', modelVersion: null, configuration: {}, tools: [], events: [], artifactIds: [] };
  return store.createRun(run);
}
function capturedResult(store: Store, projectId: string, nodeId: string) {
  const run = startRun(store, projectId, nodeId);
  const artifact = store.addArtifact({ projectId, nodeId, runId: run.id, kind: 'result', title: 'Saved evidence', content: 'Exact immutable evidence from this branch.', capture: 'generated' });
  store.updateRun(run.id, { status: 'completed', artifactIds: [artifact.id], endedAt: '2026-09-22T09:00:01Z' });
  return artifact;
}

test('direct cross-parent relationships preserve ownership and do not import evidence, conversations or start work', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, add(node('left'), node('right'), node('nested', 'left'), node('source', 'nested'), node('destination', 'right')), 'Branches');
  const artifact = capturedResult(f.store, id, 'source');
  f.store.addMessage(id, 'source', 'user', 'Private to the source conversation');
  f.store.addMessage(id, 'destination', 'user', 'Independent destination question');
  const before = f.store.detail(id), policy = new Authority(f.store).policy(id);
  f.store.mutate(id, [{ type: 'addConnection', connection: { id: 'cross-branch', source: 'source', target: 'destination', sourceHandle: 'bottom', targetHandle: 'top', label: '' } }, { type: 'addConnection', connection: { id: 'cross-depth', source: 'source', target: 'right', label: '' } }], 'Connect notes across branches');
  const after = f.store.detail(id);
  assert.deepEqual(after.project.canvas.nodes, before.project.canvas.nodes, 'Connecting never moves or duplicates nodes');
  assert.equal(after.project.canvas.connections.length, 2);
  assert.deepEqual(after.runs, before.runs);
  assert.deepEqual(after.inputs, before.inputs);
  assert.deepEqual(after.artifacts, before.artifacts);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(f.store.getArtifact(artifact.id).content, artifact.content);
  assert.deepEqual(new Authority(f.store).policy(id), policy);
  assert.equal(after.project.revision, before.project.revision + 1);
});

test('optional relationship handles and later labels survive undo, redo and reopening', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, add(node('a'), node('b'), node('c')), 'Notes');
  f.store.mutate(id, [{ type: 'addConnection', connection: { id: 'legacy', source: 'a', target: 'b', label: '' } }, { type: 'addConnection', connection: { id: 'direct', source: 'b', target: 'c', label: '', sourceHandle: 'top', targetHandle: 'bottom' } }], 'Direct links');
  const before = f.store.getProject(id).canvas;
  const connection = before.connections.find(c => c.id === 'direct')!;
  f.store.mutate(id, [{ type: 'removeConnection', id: connection.id }, { type: 'addConnection', connection: { ...connection, label: 'Compare assumptions' } }], 'Edit relationship label');
  const after = f.store.getProject(id).canvas;
  assert.equal(after.connections.find(c => c.id === 'direct')!.label, 'Compare assumptions');
  assert.deepEqual(f.store.undo(id).canvas, before);
  assert.deepEqual(f.store.redo(id).canvas, after);
  f.reopen();
  assert.deepEqual(f.store.getProject(id).canvas, after);
  assert.equal(f.store.getProject(id).canvas.connections.find(c => c.id === 'legacy')!.sourceHandle, undefined);
  assert.deepEqual(f.store.undo(id).canvas, before);
});

test('Arrange saves more than 200 note positions without content history and content undo keeps the arrangement', t => {
  const f = fixture(t), id = f.project.id;
  const notes = Array.from({ length: 230 }, (_, index) => node(`note-${String(index).padStart(3, '0')}`));
  f.store.mutate(id, add(...notes.slice(0, 115)), 'First notes');
  f.store.mutate(id, add(...notes.slice(115)), 'More notes');
  f.store.mutate(id, [{ type: 'addConnection', connection: { id: 'relationship', source: notes[0].id, target: notes.at(-1)!.id, label: 'Compare' } }], 'Relationship');
  const before = f.store.getProject(id), historyCount = f.store.listChanges(id).length;
  const { canvas } = arrangeCanvas(before.canvas);
  const operations: Mutation[] = canvas.nodes.flatMap(n => {
    const old = before.canvas.nodes.find(previous => previous.id === n.id)!;
    return old.x === n.x && old.y === n.y ? [] : [{ type: 'updateNode' as const, id: n.id, patch: { x: n.x, y: n.y } }];
  });
  assert.ok(operations.length > 200, 'Fixture exercises the full-canvas mutation allowance');
  const arranged = f.store.mutate(id, operations, 'Arrange canvas');
  assert.deepEqual(arranged.canvas, canvas);
  assert.equal(arranged.revision, before.revision);
  assert.equal(f.store.listChanges(id).length, historyCount);
  const undone = f.store.undo(id);
  assert.deepEqual(undone.canvas.nodes, canvas.nodes);
  assert.deepEqual(undone.canvas.connections, [], 'Undo removes the last content edit, the relationship');
  assert.deepEqual(f.store.redo(id).canvas, canvas);
  assert.equal(f.store.detail(id).inputs.length, 0);
  assert.equal(f.store.listRuns(id).length, 0);
});

test('Trash and restore retain exact project history, artifacts, policy and consumed budgets through restart', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, add(node('source'), node('destination')), 'Notes');
  const artifact = capturedResult(f.store, id, 'source');
  f.store.addInput(id, 'destination', artifact.id);
  f.store.addMessage(id, null, 'user', 'Project conversation survives Trash');
  f.store.saveRecord('highlight', 'fixture-highlight', id, { id: 'fixture-highlight', projectId: id, nodeId: 'source', artifactId: artifact.id, x: 48, y: 240 });
  const authority = new Authority(f.store);
  authority.configure(id, { mode: 'review', scope: 'Offline fixture research', nodeIds: ['source', 'destination'], datasetIds: [], allowActionCreation: true, limits: { experiments: 5, modelCalls: 5, createdActions: 2, runtimeSeconds: 100, spendUsd: 10 } });
  authority.reserve(id, { kind: 'model', nodeId: 'source', fingerprint: 'retained-project-spend', spendUsd: 3 });
  const authorization = { authorizationId: 'offline-trash-test', maxUsd: 10 };
  const budget = new CombinedNebiusBudget(f.store, authorization);
  f.store.addUsage({ id: 'retained-provider-usage', provider: 'nebius', purpose: 'Offline fixture', reservedUsd: 3, estimatedUsd: .01, reportedUsage: null, status: 'settled', basis: 'Offline conservative fixture', createdAt: '2026-09-22T09:00:00Z' });
  budget.reserve({ kind: 'inference', attemptId: 'retained-provider-usage', projectId: id, amountUsd: 3, basis: 'Offline conservative fixture' });
  f.store.mutate(id, [{ type: 'updateNode', id: 'source', patch: { title: 'A later title' } }], 'Rename');
  f.store.undo(id);
  const before = f.store.detail(id), policy = authority.policy(id), usage = f.store.listUsage(), budgetBefore = budget.status(), admissions = f.store.records('admission', id);
  assert.equal(before.canRedo, true);
  const neighbor = f.store.createProject('Unrelated project remains available');
  assert.deepEqual(f.store.trashProject(id), before.project);
  assert.deepEqual(f.store.listProjects().map(p => p.id), [neighbor.id]);
  assert.deepEqual(f.store.listTrashedProjects(), [before.project]);
  assert.throws(() => f.store.getProject(id), /Trash/);
  assert.throws(() => f.store.mutate(id, [{ type: 'updateNode', id: 'source', patch: { title: 'Must not change' } }], 'Edit trashed project'), /Trash/);
  assert.deepEqual(budget.status(), budgetBefore, 'Trash cannot release shared spending reservations');
  f.reopen();
  assert.deepEqual(f.store.listTrashedProjects(), [before.project]);
  assert.deepEqual(new CombinedNebiusBudget(f.store, authorization).status(), budgetBefore);
  assert.deepEqual(f.store.restoreProject(id), before.project);
  assert.deepEqual(f.store.detail(id), before);
  assert.deepEqual(new Authority(f.store).policy(id), policy);
  assert.deepEqual(f.store.listUsage(), usage);
  assert.deepEqual(f.store.records('admission', id), admissions);
  assert.deepEqual(f.store.getArtifact(artifact.id), artifact);
  assert.equal(f.store.listTrashedProjects().length, 0);
  assert.equal(f.store.redo(id).canvas.nodes.find(n => n.id === 'source')!.title, 'A later title');
});

test('Trash refuses queued or running work and accepts the project only after explicit completion', t => {
  const f = fixture(t), id = f.project.id;
  f.store.mutate(id, add(node('a'), node('b')), 'Notes');
  const running = startRun(f.store, id, 'a'), queued = startRun(f.store, id, 'b', 'queued');
  const before = f.store.detail(id);
  assert.throws(() => f.store.trashProject(id), /Stop active research/);
  assert.deepEqual(f.store.detail(id), before);
  assert.equal(f.store.listTrashedProjects().length, 0);
  f.store.updateRun(running.id, { status: 'completed' });
  assert.throws(() => f.store.trashProject(id), /Stop active research/);
  f.store.updateRun(queued.id, { status: 'cancelled' });
  f.store.trashProject(id);
  assert.equal(f.store.listTrashedProjects().length, 1);
  f.store.restoreProject(id);
  assert.equal(f.store.getRun(running.id).status, 'completed');
  assert.equal(f.store.getRun(queued.id).status, 'cancelled');
});

test('Trash also refuses active assistant turns and research sessions between model or experiment runs', t => {
  const f = fixture(t), id = f.project.id;
  for (const namespace of ['assistant-turn', 'research']) {
    const record = { id: `${namespace}-fixture`, projectId: id, status: 'running' };
    f.store.saveRecord(namespace, record.id, id, record);
    assert.throws(() => f.store.trashProject(id), /Stop active research/, `${namespace} must block Trash without a current run`);
    assert.equal(f.store.listTrashedProjects().length, 0);
    assert.equal(f.store.listProjects().some(p => p.id === id), true);
    f.store.saveRecord(namespace, record.id, id, { ...record, status: 'completed' });
  }
  f.store.trashProject(id);
  assert.equal(f.store.listTrashedProjects().length, 1);
});
