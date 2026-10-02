import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import type { CanvasNode, Mutation } from '../src/shared/types.js';

const node = (id: string, kind?: CanvasNode['kind'], parentId?: string): CanvasNode => ({ id, title: id, description: '', x: 0, y: 0, ...(kind ? { kind } : {}), ...(parentId ? { parentId } : {}) });
const add = (...nodes: CanvasNode[]): Mutation[] => nodes.map(node => ({ type: 'addNode', node }));

test('legacy kinds work at deeper scopes; cycles are rejected and edits are atomic', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-workspaces-'));
  const store = new Store(directory);
  try {
    const project = store.createProject('Scope and meaning');
    store.mutate(project.id, add(node('outer-topic', 'topic'), node('outer-activity', 'activity'), node('inner-topic', 'topic', 'outer-activity'), node('inner-activity', 'activity', 'outer-topic')), 'Independent kinds');
    let canvas = store.getProject(project.id).canvas;
    assert.equal(canvas.nodes.length, 4);
    assert.equal(canvas.nodes.find(n => n.id === 'inner-topic')!.x, 0, 'Separate scopes can use the same coordinates');
    assert.equal(store.listRuns(project.id).length, 0);
    assert.equal(store.detail(project.id).inputs.length, 0);
    store.mutate(project.id, add(node('grandchild', 'activity', 'inner-topic')), 'Deeper workspace');
    assert.throws(() => store.mutate(project.id, [{ type: 'updateNode', id: 'outer-activity', patch: { parentId: 'grandchild' } }], 'Would create a cycle'), /cycle/);
    canvas=store.getProject(project.id).canvas;
    assert.throws(() => store.mutate(project.id, add(node('orphan', 'topic', 'missing')), 'Missing parent'), /not active/);
    store.mutate(project.id, [{ type: 'addConnection', connection: { id: 'cross', source: 'outer-topic', target: 'inner-topic', label: 'Related' } }], 'Across branches');
    assert.equal(store.getProject(project.id).canvas.connections.length,1);
    assert.equal(store.getProject(project.id).revision, 3, 'Only the valid cross-branch relationship adds a revision');
    canvas=store.getProject(project.id).canvas;
    store.mutate(project.id, [{ type: 'removeNode', id: 'outer-activity' }], 'Remove workspace');
    assert.deepEqual(store.getProject(project.id).canvas.nodes.map(n => n.id), ['outer-topic', 'inner-activity']);
    assert.deepEqual(store.undo(project.id).canvas, canvas);
    assert.equal(store.redo(project.id).canvas.nodes.length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('scoped proposals retain atomic acceptance, stale rejection and no execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-scope-preview-'));
  const store = new Store(directory);
  try {
    const project = store.createProject('Proposal');
    const proposal = store.createProposal(project.id, 0, 'One workspace and one direction', add(node('parent', 'activity'), node('child', 'topic', 'parent')));
    assert.equal(store.getProject(project.id).canvas.nodes.length, 0);
    const accepted = store.acceptProposal(project.id, proposal.id);
    assert.equal(accepted.revision, 1);
    assert.equal(store.listRuns(project.id).length, 0);
    store.undo(project.id);
    assert.equal(store.getProject(project.id).canvas.nodes.length, 0);
    store.redo(project.id);
    const stale = store.createProposal(project.id, 3, 'New direction', add(node('another', 'activity', 'parent')));
    store.mutate(project.id, [{ type: 'updateNode', id: 'child', patch: { title: 'User edit' } }], 'User edit');
    assert.throws(() => store.acceptProposal(project.id, stale.id), /changed/);
    assert.equal(store.getProject(project.id).canvas.nodes.length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('additive node schema leaves legacy data and stored history byte-for-byte intact on reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-legacy-'));
  let store = new Store(directory);
  try {
    const project = store.createProject('Legacy');
    store.mutate(project.id, add(node('legacy')), 'Foundation node');
    store.addMessage(project.id, 'legacy', 'user', 'Original conversation');
    store.addUsage({ id: 'prior-reservation', provider: 'nebius', purpose: 'Historical', reservedUsd: 0.32, estimatedUsd: 0.001, reportedUsage: null, status: 'settled', basis: 'Historical basis', createdAt: '2026-09-20T00:00:00Z' });
    store.close();
    const beforeDb = new DatabaseSync(join(directory, 'ros-ai.sqlite'), { readOnly: true });
    const before = beforeDb.prepare('SELECT data, history FROM projects').all();
    beforeDb.close();
    store = new Store(directory);
    const legacy = store.getProject(project.id).canvas.nodes[0];
    assert.equal(legacy.kind, undefined, 'Do not invent historical semantic meaning');
    assert.equal(legacy.parentId, undefined);
    assert.equal(store.listMessages(project.id, 'legacy')[0].content, 'Original conversation');
    assert.equal(store.listUsage()[0].reservedUsd, 0.32);
    const afterDb = new DatabaseSync(join(directory, 'ros-ai.sqlite'), { readOnly: true });
    assert.deepEqual(afterDb.prepare('SELECT data, history FROM projects').all(), before);
    afterDb.close();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
