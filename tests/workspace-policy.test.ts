import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Authority } from '../src/server/authority.js';
import { Highlights, LocalConnections } from '../src/server/connections.js';
import { Store } from '../src/server/store.js';
import type { ApprovalMode, ReviewDecision } from '../src/shared/research.js';
import type { Artifact, CanvasNode, Run } from '../src/shared/types.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-workspace-policy-'));
  let store = new Store(join(directory, 'store'));
  const project = store.createProject('Rainfall and cycling');
  store.mutate(project.id, ['question', 'analysis', 'other'].map(id => ({
    type: 'addNode', node: node(id),
  })), 'Independent workspaces');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, project, get store() { return store; }, reopen() { store.close(); store = new Store(join(directory, 'store')); } };
}

function node(id: string, parentId?: string): CanvasNode {
  return { id, title: id, description: 'Rainfall research', kind: 'activity', x: 0, y: 0, ...(parentId ? { parentId } : {}) };
}

function artifact(store: Store, projectId: string, nodeId = 'analysis', content = 'rain_mm\n1\n2\n', kind: Artifact['kind'] = 'dataset'): Artifact {
  const project = store.getProject(projectId);
  const run: Run = {
    id: randomUUID(), projectId, nodeId, request: 'Captured fixture evidence', useSearch: false, status: 'running',
    createdAt: new Date().toISOString(), projectRevision: project.revision,
    node: project.canvas.nodes.find(item => item.id === nodeId)!, inputs: [], messages: [],
    provider: 'local', model: 'fixture', modelVersion: null, configuration: {}, tools: [], events: [], artifactIds: [],
  };
  store.createRun(run);
  const result = store.addArtifact({ projectId, nodeId, runId: run.id, kind, title: 'Captured evidence', content, mediaType: 'text/csv', capture: 'full-content' });
  store.updateRun(run.id, { status: 'completed', endedAt: new Date().toISOString(), artifactIds: [result.id] });
  return result;
}

function grant(authority: Authority, projectId: string, mode: ApprovalMode = 'review') {
  return authority.configure(projectId, { mode });
}
const experiment = (fingerprint = randomUUID()) => ({
  kind: 'experiment' as const, nodeId: 'analysis', fingerprint,
  code: 'import pandas as pd\nmetric("mean", df["rain_mm"].mean())', runtimeSeconds: 10,
});

test('Actions inherit the project default, while overrides remain local and removable across deeper nesting', t => {
  const f = fixture(t), authority = new Authority(f.store);
  assert.equal(authority.mode(f.project.id, 'analysis'), 'ask');
  grant(authority, f.project.id, 'review');
  authority.override(f.project.id, 'analysis', 'full');
  f.store.mutate(f.project.id, [
    { type: 'addNode', node: node('child', 'analysis') },
    { type: 'addNode', node: node('grandchild', 'child') },
  ], 'Add nested Actions');
  assert.equal(authority.mode(f.project.id, 'analysis'), 'full');
  assert.equal(authority.mode(f.project.id, 'child'), 'review', 'New Action inherits the project, not its parent override');
  assert.equal(authority.mode(f.project.id, 'grandchild'), 'review');
  grant(authority, f.project.id, 'ask');
  assert.equal(authority.mode(f.project.id, 'grandchild'), 'ask');
  assert.equal(authority.mode(f.project.id, 'analysis'), 'full', 'Changing the default preserves explicit overrides');
  authority.override(f.project.id, 'analysis', null);
  assert.equal(authority.mode(f.project.id, 'analysis'), 'ask');
  assert.throws(() => authority.override(f.project.id, 'missing', 'full'), /not found/);
  f.reopen();
  assert.equal(new Authority(f.store).mode(f.project.id, 'grandchild'), 'ask');
});

test('Approve for me runs plain analysis, escalates unfamiliar code and new blocks, and records its decisions', t => {
  const f = fixture(t), authority = new Authority(f.store);
  grant(authority, f.project.id, 'review');
  const safe = experiment();
  assert.equal(authority.review(f.project.id, safe).outcome, 'allow');
  for (const code of ['import os\nprint(os.getcwd())', 'df = pd.read_csv("original.csv")', 'eval("1+1")', 'x = df.__class__', 'x = 1; import os\nprint(os.getcwd())', 'if True: import socket']) {
    const decision = authority.review(f.project.id, { ...safe, fingerprint: randomUUID(), code });
    assert.equal(decision.outcome, 'escalate', code);
    assert.match(decision.reason, /review/i);
  }
  assert.equal(authority.review(f.project.id, { kind: 'create-action', nodeId: 'analysis', fingerprint: randomUUID() }).outcome, 'escalate');
  const decisions = f.store.records<ReviewDecision>('review', f.project.id);
  assert.equal(decisions.length, 8);
  assert.equal(decisions[0].fingerprint, safe.fingerprint);
  assert.equal(decisions[0].mode, 'review');
  assert.equal(authority.policy(f.project.id).used.experiments, 0, 'Review itself does not consume an execution');
});

test('Ask escalates exact work; Full access allows any code and new blocks without asking', t => {
  const f = fixture(t), authority = new Authority(f.store);
  grant(authority, f.project.id, 'ask');
  const action = experiment();
  assert.equal(authority.review(f.project.id, action).outcome, 'escalate');
  assert.equal(authority.review(f.project.id, { kind: 'create-action', nodeId: 'analysis', fingerprint: randomUUID() }).outcome, 'escalate');
  grant(authority, f.project.id, 'full');
  assert.equal(authority.review(f.project.id, action).outcome, 'allow');
  assert.equal(authority.review(f.project.id, { ...action, code: 'import os\nprint(os.getcwd())' }).outcome, 'allow');
  assert.equal(authority.review(f.project.id, { kind: 'create-action', nodeId: 'other', fingerprint: randomUUID() }).outcome, 'allow');
});

test('usage tallies persist once per admission and changing mode or undoing structure never resets them', t => {
  const f = fixture(t), authority = new Authority(f.store);
  grant(authority, f.project.id, 'full');
  const first = { ...experiment(), spendUsd: .2 };
  authority.reserve(f.project.id, first);
  authority.reserve(f.project.id, { kind: 'model', nodeId: 'analysis', fingerprint: 'model-1', spendUsd: .3 });
  authority.reserve(f.project.id, { kind: 'create-action', nodeId: 'analysis', fingerprint: 'child-1' });
  const used = { experiments: 1, modelCalls: 1, createdActions: 1, runtimeSeconds: 10, spendUsd: .5 };
  assert.deepEqual(authority.policy(f.project.id).used, used);
  assert.throws(() => authority.reserve(f.project.id, first), /already consumed/);
  assert.throws(() => authority.reserve(f.project.id, { kind: 'model', nodeId: 'analysis', fingerprint: 'negative', spendUsd: -1 }), /Invalid spendUsd/);
  assert.throws(() => authority.reserve(f.project.id, { kind: 'model', nodeId: 'analysis', fingerprint: 'infinite', runtimeSeconds: Infinity }), /Invalid runtimeSeconds/);
  grant(authority, f.project.id, 'ask');
  f.store.mutate(f.project.id, [{ type: 'addNode', node: node('spawned', 'analysis') }], 'Related Action');
  f.store.undo(f.project.id);
  assert.deepEqual(authority.policy(f.project.id).used, used, 'Undoing structure does not refund execution or spending');
  f.reopen();
  assert.deepEqual(new Authority(f.store).policy(f.project.id).used, used);
  assert.equal(f.store.records('admission', f.project.id).length, 3);
});

test('stopped projects reject new work across modes until explicit resume and retain usage', t => {
  const f = fixture(t), authority = new Authority(f.store);
  grant(authority, f.project.id, 'full');
  const first = { kind: 'model' as const, nodeId: 'analysis', fingerprint: 'before-stop', spendUsd: .1 };
  authority.reserve(f.project.id, first);
  authority.setStopped(f.project.id, true);
  grant(authority, f.project.id, 'review');
  const next = { ...first, fingerprint: 'after-stop' };
  const decision = authority.review(f.project.id, next);
  assert.equal(decision.outcome, 'deny');
  assert.match(decision.reason, /stopped.*Resume explicitly/);
  assert.throws(() => authority.reserve(f.project.id, next), /stopped/);
  f.reopen();
  const reopened = new Authority(f.store);
  assert.equal(reopened.policy(f.project.id).stopped, true);
  reopened.setStopped(f.project.id, false);
  assert.equal(reopened.review(f.project.id, next).outcome, 'allow');
  reopened.reserve(f.project.id, next);
  assert.equal(reopened.policy(f.project.id).used.modelCalls, 2);
  assert.equal(reopened.policy(f.project.id).used.spendUsd, .2);
});

test('local CSV import and output export preserve exact contents, hashes and a durable captured copy', t => {
  const f = fixture(t), connections = new LocalConnections(f.store);
  const content = 'name,rain_mm\r\n"Amsterdam, west",1.2\r\n';
  const source = join(f.directory, 'observations.csv'), output = join(f.directory, 'outputs');
  writeFileSync(source, content); mkdirSync(output);
  const sourceConnection = connections.add(f.project.id, { name: 'Selected readings', kind: 'csv', path: source });
  assert.equal(sourceConnection.writable, false);
  const captured = connections.read(f.project.id, sourceConnection.id);
  assert.equal(captured.content, content);
  assert.equal(captured.hash, createHash('sha256').update(content).digest('hex'));
  const imported = connections.import(f.project.id, sourceConnection.id, 'analysis');
  assert.equal(imported.content, content);
  assert.equal(imported.hash, captured.hash);
  assert.equal(f.store.getRun(imported.runId).status, 'completed');
  assert.equal(f.store.detail(f.project.id).inputs[0].artifactId, imported.id);
  const outputConnection = connections.add(f.project.id, { name: 'Selected output folder', kind: 'output-folder', path: output });
  const exported = connections.export(f.project.id, outputConnection.id, [imported.id]);
  assert.equal(exported.files.length, 1);
  assert.equal(dirname(exported.files[0].path), outputConnection.path);
  assert.equal(readFileSync(exported.files[0].path, 'utf8'), content);
  assert.equal(exported.files[0].hash, imported.hash);
  writeFileSync(source, 'name,rain_mm\nChanged,9\n');
  assert.equal(f.store.getArtifact(imported.id).content, content, 'Changing the source cannot alter a captured input');
  connections.setWritable(f.project.id, outputConnection.id, false);
  assert.throws(() => connections.export(f.project.id, outputConnection.id, [imported.id]), /write permission/);
  f.reopen();
  assert.equal(f.store.getArtifact(imported.id).content, content);
  assert.equal(new LocalConnections(f.store).list(f.project.id).length, 2);
  assert.equal(f.store.records('export', f.project.id).length, 1);
});

test('Full access cannot write a read-only original; separate connection permission and expected hash are enforced', t => {
  const f = fixture(t), connections = new LocalConnections(f.store), authority = new Authority(f.store);
  grant(authority, f.project.id, 'full');
  const source = join(f.directory, 'original.csv'), original = 'value\n123456\n';
  writeFileSync(source, original);
  const connection = connections.add(f.project.id, { name: 'Original', kind: 'csv', path: source });
  const captured = connections.read(f.project.id, connection.id);
  assert.throws(() => connections.replace(f.project.id, connection.id, captured.hash, 'value\n7\n'), /separate connection write permission/);
  assert.equal(readFileSync(source, 'utf8'), original);
  connections.setWritable(f.project.id, connection.id, true);
  assert.throws(() => connections.replace(f.project.id, connection.id, '0'.repeat(64), 'value\n7\n'), /Source changed/);
  assert.equal(f.store.records('source-write', f.project.id).length, 0);
  const replacement = connections.replace(f.project.id, connection.id, captured.hash, 'value\n7\n');
  assert.equal(readFileSync(source, 'utf8'), 'value\n7\n', 'Short replacement truncates old trailing bytes');
  assert.equal(connections.read(f.project.id, connection.id).hash, replacement.hash);
  const audit = f.store.record<{ previous: string; previousHash: string; nextHash: string }>('source-write', replacement.backupId)!;
  assert.equal(audit.previous, original);
  assert.equal(audit.previousHash, captured.hash);
  assert.equal(audit.nextHash, replacement.hash);
  assert.throws(() => connections.replace(f.project.id, connection.id, captured.hash, 'value\n8\n'), /Source changed/);
  connections.setWritable(f.project.id, connection.id, false);
  assert.throws(() => connections.replace(f.project.id, connection.id, replacement.hash, 'value\n8\n'), /read-only/);
});

test('a redirected source or output directory cannot inherit the selected connection permission', t => {
  const f = fixture(t), connections = new LocalConnections(f.store);
  const source = join(f.directory, 'source.csv'), target = join(f.directory, 'different.csv');
  writeFileSync(source, 'value\n1\n'); writeFileSync(target, 'value\n999\n');
  const sourceConnection = connections.add(f.project.id, { name: 'Source', kind: 'csv', path: source });
  connections.setWritable(f.project.id, sourceConnection.id, true);
  const oldHash = connections.read(f.project.id, sourceConnection.id).hash;
  renameSync(source, `${source}.saved`); symlinkSync(target, source);
  assert.throws(() => connections.read(f.project.id, sourceConnection.id), /replaced or redirected/);
  assert.throws(() => connections.replace(f.project.id, sourceConnection.id, oldHash, 'value\n5\n'), /replaced or redirected/);
  assert.equal(readFileSync(target, 'utf8'), 'value\n999\n');
  const output = join(f.directory, 'output'), differentOutput = join(f.directory, 'different-output');
  mkdirSync(output); mkdirSync(differentOutput);
  const outputConnection = connections.add(f.project.id, { name: 'Output', kind: 'output-folder', path: output });
  const result = artifact(f.store, f.project.id);
  renameSync(output, `${output}.saved`); symlinkSync(differentOutput, output, 'dir');
  assert.throws(() => connections.export(f.project.id, outputConnection.id, [result.id]), /replaced or redirected/);
  assert.deepEqual(readdirSync(differentOutput), []);
});

test('highlight reuse across groups selects the exact artifact version, survives restart and rejects other projects', t => {
  const f = fixture(t), highlights = new Highlights(f.store);
  const original = artifact(f.store, f.project.id, 'analysis', 'value\n42\n', 'table');
  const pinned = highlights.save(f.project.id, { nodeId: 'analysis', artifactId: original.id, x: 24, y: 48 });
  assert.equal(f.store.detail(f.project.id).inputs.length, 0);
  highlights.save(f.project.id, { nodeId: 'other', x: 72, y: 96 }, pinned.id);
  const selected = f.store.detail(f.project.id).inputs[0];
  assert.equal(selected.nodeId, 'other');
  assert.equal(selected.artifactId, original.id);
  assert.equal(selected.excerpt, 'value\n42\n');
  highlights.save(f.project.id, { nodeId: 'other', x: 120, y: 96 }, pinned.id);
  assert.equal(f.store.detail(f.project.id).inputs.length, 1, 'Moving a pinned result does not duplicate selected inputs');
  const newer = artifact(f.store, f.project.id, 'analysis', 'value\n99\n', 'table');
  assert.notEqual(newer.id, original.id);
  const otherProject = f.store.createProject('Unrelated');
  f.store.mutate(otherProject.id, [{ type: 'addNode', node: node('elsewhere') }], 'Other node');
  assert.throws(() => highlights.save(otherProject.id, { nodeId: 'elsewhere', artifactId: original.id, x: 0, y: 0 }), /in this project/);
  assert.throws(() => highlights.save(otherProject.id, { nodeId: 'elsewhere', x: 0, y: 0 }, pinned.id), /not found/);
  f.reopen();
  assert.equal(f.store.detail(f.project.id).highlights?.[0].artifactId, original.id);
  assert.equal(f.store.getArtifact(original.id).content, 'value\n42\n');
  assert.equal(f.store.detail(f.project.id).inputs[0].artifactId, original.id);
  new Highlights(f.store).remove(f.project.id, pinned.id);
  assert.equal(f.store.detail(f.project.id).highlights?.length, 0);
  assert.equal(f.store.detail(f.project.id).inputs.length, 1, 'Unpinning does not silently remove evidence already selected for research');
});

test('deeper nesting rejects cycles atomically; recursive deletion and undo preserve prior runs and evidence', t => {
  const f = fixture(t);
  f.store.mutate(f.project.id, [
    { type: 'addNode', node: node('child', 'question') },
    { type: 'addNode', node: node('grandchild', 'child') },
    { type: 'addNode', node: node('great-grandchild', 'grandchild') },
    { type: 'addNode', node: node('sibling', 'grandchild') },
    { type: 'addConnection', connection: { id: 'siblings', source: 'great-grandchild', target: 'sibling', label: 'Related' } },
  ], 'Nested research');
  const result = artifact(f.store, f.project.id, 'great-grandchild', 'Earlier conclusion', 'result');
  f.store.addMessage(f.project.id, 'great-grandchild', 'user', 'Preserve my research context');
  f.store.addInput(f.project.id, 'other', result.id);
  const before = f.store.getProject(f.project.id), runBefore = f.store.getRun(result.runId);
  assert.throws(() => f.store.mutate(f.project.id, [
    { type: 'updateNode', id: 'analysis', patch: { title: 'Must roll back' } },
    { type: 'updateNode', id: 'question', patch: { parentId: 'great-grandchild' } },
  ], 'Parent cycle'), /parent cycle/);
  assert.deepEqual(f.store.getProject(f.project.id), before);
  assert.throws(() => f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'child', patch: { parentId: 'child' } }], 'Self cycle'), /itself|cycle/);
  assert.throws(() => f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'child', patch: { parentId: 'missing' } }], 'Missing parent'), /not active/);
  f.store.mutate(f.project.id, [{ type: 'removeNode', id: 'question' }], 'Remove nested group');
  assert.deepEqual(f.store.getProject(f.project.id).canvas.nodes.map(item => item.id), ['analysis', 'other']);
  assert.equal(f.store.getProject(f.project.id).canvas.connections.length, 0);
  assert.deepEqual(f.store.getRun(result.runId), runBefore);
  assert.equal(f.store.getArtifact(result.id).content, 'Earlier conclusion');
  assert.equal(f.store.listMessages(f.project.id, 'great-grandchild')[0].content, 'Preserve my research context');
  assert.equal(f.store.detail(f.project.id).inputs[0].artifactId, result.id);
  assert.deepEqual(f.store.undo(f.project.id).canvas, before.canvas);
  f.store.redo(f.project.id);
  f.reopen();
  assert.deepEqual(f.store.getRun(result.runId), runBefore);
  assert.deepEqual(f.store.undo(f.project.id).canvas, before.canvas);
});
