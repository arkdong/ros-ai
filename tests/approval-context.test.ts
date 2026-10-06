import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { ExperimentService } from '../src/server/experiments.js';
import { SandboxBudget, type SandboxBudgetOptions } from '../src/server/sandbox-budget.js';
import type { ExecutionBackend, SandboxCapabilities, SandboxInput, SandboxResult } from '../src/server/sandbox.js';
import type { CanvasNode } from '../src/shared/types.js';

const terms: SandboxBudgetOptions = {
  authorizationId: 'offline-approval-context', maxRuns: 2, maxUsd: 2, maxCostPerRunUsd: 1,
  pricingBasis: 'Offline fixture only: hypothetical $1 ceiling; not a provider price.',
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-approval-context-'));
  const store = new Store(dir), inputs: SandboxInput[] = [];
  const capabilities: SandboxCapabilities = {
    available: true, backend: 'nebius-sandbox', policy: 'offline-fixture', runtime: 'fixture Python',
    workerHash: 'worker-1', imageId: 'image-1', libraries: {}, enforcement: ['fixture'],
    limitations: ['No live execution'], timeoutMs: 30000, maxMemoryMb: null, maxOutputBytes: 1000000,
  };
  const backend: ExecutionBackend = {
    capabilities: () => structuredClone(capabilities),
    start(input) {
      inputs.push(input);
      return { cancel() {}, done: Promise.resolve({
        status: 'completed', outputs: [], stdout: '', stderr: '', exitCode: 0, signal: null,
        runtime: 'fixture Python', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        enforcement: ['fixture'],
      } satisfies SandboxResult) };
    },
  };
  const project = store.createProject('Offline approval context');
  store.mutate(project.id, ['a', 'b', 'group'].map((id, i) => ({
    type: 'addNode' as const, node: { id, title: id, description: '', kind: 'activity' as const, x: i * 400, y: 0 },
  })), 'Fixture nodes');
  const grant = new SandboxBudget(store, terms);
  const service = new ExperimentService(store, { sandbox: backend, nebiusSandbox: backend, sandboxBudget: grant });
  service.authority.configure(project.id, { mode: 'ask' });
  return { store, project, service, grant, backend, capabilities, inputs, async cleanup() {
    await service.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

function preview(f: ReturnType<typeof fixture>) {
  return f.service.preview(f.project.id, {
    nodeId: 'a', request: 'Review this exact offline experiment', backend: 'nebius-sandbox',
    csv: 'value\n2\n4\n', code: 'metric("Mean", 3)', parameters: { label: 'captured' },
  });
}

async function finished(store: Store, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = store.getRun(id);
    if (!['queued', 'running'].includes(run.status)) return run;
    await delay(5);
  }
  throw new Error('Offline experiment did not finish');
}

test('moving, resizing and arranging nodes preserves an exact pending approval and its captured data', async () => {
  const f = fixture();
  try {
    const source = f.service.preview(f.project.id, { nodeId: 'b', request: 'Capture a dataset', csv: 'value\n2\n4\n' });
    f.service.decide(source.run.id, source.approval.fingerprint, 'deny');
    const dataset = source.run.artifactIds.map(id => f.store.getArtifact(id)).find(artifact => artifact.kind === 'dataset')!;
    f.store.addInput(f.project.id, 'a', dataset.id, 'value\n2\n');
    const pending = preview(f), capturedNode = structuredClone(pending.run.node);
    const capturedArtifacts = pending.run.artifactIds.map(id => f.store.getArtifact(id));
    const contentRevision = f.store.getProject(f.project.id).revision, changes = f.store.listChanges(f.project.id);
    f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { x: 400, y: 400 } }], 'Move Action');
    f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { width: 600 } }], 'Resize Action');
    f.store.mutate(f.project.id, ['a', 'b', 'group'].map((id, i) => ({
      type: 'updateNode' as const, id, patch: { x: i * 400, y: 800 },
    })), 'Arrange positions');
    assert.notDeepEqual(f.store.getProject(f.project.id).canvas.nodes.find(node => node.id === 'a'), capturedNode);
    assert.equal(f.store.getProject(f.project.id).revision, contentRevision);
    assert.deepEqual(f.store.listChanges(f.project.id), changes, 'Layout saves do not create content history');
    assert.equal(f.inputs.length, 0);
    assert.equal(f.service.authority.policy(f.project.id).used.experiments, 0);
    f.service.decide(pending.run.id, pending.approval.fingerprint, 'allow');
    const run = await finished(f.store, pending.run.id);
    assert.equal(run.status, 'completed');
    assert.equal(f.inputs.length, 1);
    assert.equal(f.inputs[0].code, pending.code);
    assert.equal(f.inputs[0].csv, pending.csv);
    assert.deepEqual(f.inputs[0].parameters, pending.parameters);
    assert.deepEqual(run.node, capturedNode, 'The historical node snapshot retains its original coordinates and width');
    assert.deepEqual(run.inputs, pending.run.inputs, 'The exact selected version and excerpt stay captured');
    assert.equal(f.service.inspect(run.id).approval.fingerprint, pending.approval.fingerprint);
    assert.deepEqual(capturedArtifacts.map(artifact => f.store.getArtifact(artifact.id)), capturedArtifacts);
    assert.equal(f.service.authority.policy(f.project.id).used.experiments, 1);
    assert.equal(f.grant.status().remainingRuns, 1);
  } finally { await f.cleanup(); }
});

function assertNoAdmission(f: ReturnType<typeof fixture>, runId: string) {
  assert.equal(f.inputs.length, 0);
  assert.equal(f.service.inspect(runId).approval.status, 'pending');
  assert.equal(f.service.authority.policy(f.project.id).used.experiments, 0);
  assert.equal(f.service.authority.policy(f.project.id).used.spendUsd, 0);
  assert.equal(f.grant.status().remainingRuns, 2);
}

test('title, description, kind and parent changes still invalidate exact approval', async () => {
  const changes: Partial<CanvasNode>[] = [
    { title: 'Different analysis' }, { description: 'Changed research context' },
    { kind: 'topic' }, { parentId: 'group' },
  ];
  for (const patch of changes) {
    const f = fixture();
    try {
      const pending = preview(f);
      f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { x: 1200, y: 400, ...patch } }], 'Change context');
      assert.throws(() => f.service.decide(pending.run.id, pending.approval.fingerprint, 'allow'), /stale/, JSON.stringify(patch));
      assertNoAdmission(f, pending.run.id);
    } finally { await f.cleanup(); }
  }
});

test('selected artifact versions and excerpts still invalidate approval after movement', async () => {
  for (const change of ['version', 'excerpt']) {
    const f = fixture();
    try {
      const datasets = ['value\n2\n4\n', 'value\n8\n10\n'].map(csv => {
        const source = f.service.preview(f.project.id, { nodeId: 'b', request: 'Capture exact dataset version', csv });
        f.service.decide(source.run.id, source.approval.fingerprint, 'deny');
        return source.run.artifactIds.map(id => f.store.getArtifact(id)).find(artifact => artifact.kind === 'dataset')!;
      });
      const selection = f.store.addInput(f.project.id, 'a', datasets[0].id, 'value\n2\n');
      const pending = f.service.preview(f.project.id, { nodeId: 'a', request: 'Use selected data', backend: 'nebius-sandbox' });
      assert.equal(pending.csv, 'value\n2\n');
      f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { x: 1200 } }], 'Move');
      f.store.removeInput(f.project.id, selection.id);
      f.store.addInput(f.project.id, 'a', change === 'version' ? datasets[1].id : datasets[0].id, change === 'version' ? undefined : datasets[0].content);
      assert.throws(() => f.service.decide(pending.run.id, pending.approval.fingerprint, 'allow'), /stale/, change);
      assertNoAdmission(f, pending.run.id);
      assert.equal(f.service.inspect(pending.run.id).csv, 'value\n2\n', 'Captured data remains immutable');
    } finally { await f.cleanup(); }
  }
});

test('edited code, CSV and parameters require their own approval token', async () => {
  for (const change of [{ code: 'metric("Mean", 8)' }, { csv: 'value\n8\n10\n' }, { parameters: { label: 'changed' } }]) {
    const f = fixture();
    try {
      const original = preview(f);
      f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { y: 400 } }], 'Move');
      const replacement = f.service.preview(f.project.id, {
        nodeId: 'a', request: original.run.request, backend: 'nebius-sandbox',
        code: original.code, csv: original.csv, parameters: original.parameters, ...change,
      });
      assert.equal(f.store.getRun(original.run.id).status, 'cancelled');
      assert.throws(() => f.service.decide(original.run.id, original.approval.fingerprint, 'allow'), /no longer pending/);
      assert.throws(() => f.service.decide(replacement.run.id, original.approval.fingerprint, 'allow'), /fingerprint/);
      assertNoAdmission(f, replacement.run.id);
    } finally { await f.cleanup(); }
  }
});

test('changed worker and container image remain blocked before dispatch', async () => {
  for (const change of [{ workerHash: 'worker-2' }, { imageId: 'image-2' }]) {
    const f = fixture();
    try {
      const pending = preview(f);
      Object.assign(f.capabilities, change);
      assert.throws(() => f.service.decide(pending.run.id, pending.approval.fingerprint, 'allow'), /runtime changed/);
      assertNoAdmission(f, pending.run.id);
    } finally { await f.cleanup(); }
  }
});

test('changed remote pricing or authorization cannot use an existing approval', async () => {
  for (const change of [{ pricingBasis: 'Different offline fixture terms' }, { authorizationId: 'different-offline-authorization' }]) {
    const f = fixture();
    let reconfigured: ExperimentService | undefined;
    try {
      const pending = preview(f);
      reconfigured = new ExperimentService(f.store, {
        sandbox: f.backend, nebiusSandbox: f.backend, sandboxBudget: new SandboxBudget(f.store, { ...terms, ...change }),
      });
      assert.throws(() => reconfigured!.decide(pending.run.id, pending.approval.fingerprint, 'allow'), /pricing or authorization changed/);
      assertNoAdmission(f, pending.run.id);
    } finally { await reconfigured?.shutdown(); await f.cleanup(); }
  }
});

test('position-only approval still respects current project stop and resource limits', async () => {
  for (const change of ['stop', 'limit']) {
    const f = fixture();
    try {
      const pending = preview(f);
      f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { x: 1200 } }], 'Move');
      if (change === 'stop') f.service.authority.setStopped(f.project.id, true);
      else {
        f.service.authority.configure(f.project.id, { mode: 'ask' });
      }
      assert.throws(() => f.service.decide(pending.run.id, pending.approval.fingerprint, 'allow'), /stopped|experiments limit/);
      assertNoAdmission(f, pending.run.id);
    } finally { await f.cleanup(); }
  }
});
