import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { ExperimentService } from '../src/server/experiments.js';
import type { ExperimentPreview } from '../src/shared/experiments.js';

function fixture(options: { python?: string; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-local-experiment-'));
  const store = new Store(dir), service = new ExperimentService(store, options);
  const project = store.createProject('Local experiment test fixture');
  store.mutate(project.id, ['a', 'b', 'c'].map((id, i) => ({ type: 'addNode' as const, node: { id, title: `Independent ${id}`, description: '', x: i * 288, y: 0 } })), 'Fixture nodes');
  return { dir, store, service, project, async cleanup() { await service.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function finished(store: Store, id: string) {
  for (let n = 0; n < 200; n++) { const run = store.getRun(id); if (!['queued', 'running'].includes(run.status)) return run; await delay(10); }
  throw new Error('Worker did not finish in time');
}
function allow(service: ExperimentService, preview: ExperimentPreview) { return service.decide(preview.run.id, preview.approval.fingerprint, 'allow'); }

test('real local Python computes supplied CSV, captures exact revisions, metrics, SVG, runtime, and log', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.capabilities().available, true, 'This verification requires an installed Python 3 runtime.');
    const csv = 'x,y\n1,3\n2,5\n3,7\n4,9\n';
    const code = 'x = column("x")\ny = column("y")\nfit = linear_fit(x, y)\nmetric("Slope", fit["slope"])\nmetric("Mean", mean(y))\ntable("Summary", describe(y))\nplot("Measurements", y)';
    const preview = f.service.preview(f.project.id, { nodeId: 'a', request: 'Fit and inspect this small dataset', csv, code });
    assert.equal(preview.run.status, 'queued');
    assert.equal(preview.approval.status, 'pending');
    assert.equal(f.store.getProject(f.project.id).canvas.connections.length, 0);
    allow(f.service, preview);
    const run = await finished(f.store, preview.run.id);
    assert.equal(run.status, 'completed', run.error);
    const artifacts = run.artifactIds.map(id => f.store.getArtifact(id));
    assert.equal(artifacts.find(a => a.title === 'Slope')!.content, '{\n  "value": 2\n}');
    assert.equal(JSON.parse(artifacts.find(a => a.title === 'Mean')!.content).value, 6);
    assert.equal(JSON.parse(artifacts.find(a => a.kind === 'table')!.content).find((row: { metric: string }) => row.metric === 'count').value, 4);
    assert.match(artifacts.find(a => a.kind === 'plot')!.content, /<polyline points=/);
    assert.equal(artifacts.find(a => a.kind === 'code')!.content, code);
    assert.equal(artifacts.find(a => a.kind === 'dataset')!.content, csv);
    const log = JSON.parse(artifacts.find(a => a.kind === 'log')!.content);
    assert.equal(log.exitCode, 0); assert.match(log.stderr, /resource_limits=/); assert.ok(log.codeHash);
    const oldHashes = artifacts.map(a => a.hash);
    const next = f.service.preview(f.project.id, { nodeId: 'a', request: 'Scale mean', csv, code: 'metric("Scaled mean", mean(column("y")) * params["scale"])', parameters: { scale: 2 }, retryOf: run.id });
    allow(f.service, next);
    assert.equal((await finished(f.store, next.run.id)).status, 'completed');
    assert.deepEqual(run.artifactIds.map(id => f.store.getArtifact(id).hash), oldHashes);
    assert.equal(f.store.listUsage().length, 0);
  } finally { await f.cleanup(); }
});

test('deny, cancelled approval, changed inputs, and superseded code cannot execute through stale grants', async () => {
  const f = fixture();
  try {
    const denied = f.service.preview(f.project.id, { nodeId: 'a', request: 'Denied request' });
    assert.equal(f.service.decide(denied.run.id, denied.approval.fingerprint, 'deny').status, 'cancelled');
    assert.equal(f.store.getRun(denied.run.id).events.some(e => e.type === 'process-start'), false);
    const cancelled = f.service.preview(f.project.id, { nodeId: 'a', request: 'Cancelled request' });
    f.service.decide(cancelled.run.id, cancelled.approval.fingerprint, 'cancel');
    assert.throws(() => allow(f.service, cancelled), /no longer pending/);
    const first = f.service.preview(f.project.id, { nodeId: 'a', request: 'First code' });
    const changed = f.service.preview(f.project.id, { nodeId: 'a', request: 'Changed code', code: 'metric("New", 8)' });
    assert.throws(() => allow(f.service, first), /no longer pending/);
    assert.throws(() => f.service.decide(changed.run.id, first.approval.fingerprint, 'allow'), /fingerprint/);
    f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { description: 'Changed analysis intent' } }], 'Concurrent edit');
    assert.throws(() => allow(f.service, changed), /stale/);
    assert.equal(f.service.capabilities().permissionMode, 'ask');
    assert.equal(f.service.capabilities().approveForMe.available, true);
    assert.equal(f.service.capabilities().fullAccess, true);
    assert.equal(f.service.authority.mode(f.project.id,'a'),'ask');
  } finally { await f.cleanup(); }
});

test('numerical interpreter blocks imports, filesystem, attributes, loops and unbounded sequence multiplication', async () => {
  const f = fixture();
  try {
    const forbiddenFile = join(f.dir, 'must-not-exist');
    for (const code of [
      'import os\nmetric("x", 1)',
      `open(${JSON.stringify(forbiddenFile)}, "w")`,
      'metric("x", (1).__class__)',
      'while True:\n  metric("x", 1)',
      'metric("x", len("x" * 1000000000))',
    ]) {
      const preview = f.service.preview(f.project.id, { nodeId: 'a', request: 'Harmless enforcement fixture', code });
      allow(f.service, preview);
      const run = await finished(f.store, preview.run.id);
      assert.equal(run.status, 'failed', code);
      assert.ok(run.artifactIds.some(id => f.store.getArtifact(id).kind === 'log'));
      assert.equal(run.artifactIds.some(id => f.store.getArtifact(id).kind === 'metric'), false);
    }
    assert.equal(existsSync(forbiddenFile), false);
  } finally { await f.cleanup(); }
});

test('selected dataset versions are explicit, hash pinned and input changes invalidate approval', async () => {
  const f = fixture();
  try {
    const source = f.service.preview(f.project.id, { nodeId: 'a', request: 'Capture source CSV', csv: 'value\n2\n4\n' });
    f.service.decide(source.run.id, source.approval.fingerprint, 'deny');
    const dataset = source.run.artifactIds.map(id => f.store.getArtifact(id)).find(a => a.kind === 'dataset')!;
    const selection = f.store.addInput(f.project.id, 'b', dataset.id);
    const target = f.service.preview(f.project.id, { nodeId: 'b', request: 'Reuse exact dataset' });
    assert.equal(target.csv, dataset.content); assert.equal(target.run.inputs[0].artifact.hash, dataset.hash);
    f.store.removeInput(f.project.id, selection.id);
    assert.throws(() => allow(f.service, target), /stale/);
    const noInputs = f.service.preview(f.project.id, { nodeId: 'b', request: 'Independent fixture with sample' });
    assert.equal(noInputs.run.inputs.length, 0);
    assert.notEqual(noInputs.csv, dataset.content);
  } finally { await f.cleanup(); }
});

test('bounded Auto Research admits only exact accepted scopes and cancellation is isolated', async () => {
  const f = fixture();
  try {
    const a = f.service.preview(f.project.id, { nodeId: 'a', request: 'First independent activity' });
    const b = f.service.preview(f.project.id, { nodeId: 'b', request: 'Second independent activity' });
    const c = f.service.preview(f.project.id, { nodeId: 'c', request: 'Outside this Auto Research grant' });
    assert.throws(() => f.service.startAuto(f.project.id, { scope: 'Two activities', outcome: 'Two summaries', runIds: [a.run.id, b.run.id], fingerprints: { [a.run.id]: a.approval.fingerprint, [b.run.id]: 'stale' } }), /fingerprint/);
    assert.equal(f.service.inspect(a.run.id).approval.status, 'pending');
    const group = f.service.startAuto(f.project.id, { scope: 'Only these two accepted nodes', outcome: 'Inspect each independent summary', runIds: [a.run.id, b.run.id], fingerprints: { [a.run.id]: a.approval.fingerprint, [b.run.id]: b.approval.fingerprint }, maxConcurrency: 1 });
    assert.equal(f.store.getRun(a.run.id).status, 'running');
    assert.equal(f.store.getRun(b.run.id).status, 'queued');
    f.service.cancel(a.run.id);
    assert.equal((await finished(f.store, a.run.id)).status, 'cancelled');
    assert.equal((await finished(f.store, b.run.id)).status, 'completed');
    const log = f.store.getRun(a.run.id).artifactIds.map(id => f.store.getArtifact(id)).find(a => a.kind === 'log')!;
    assert.equal(JSON.parse(log.content).signal, 'SIGKILL');
    assert.equal(f.service.inspect(c.run.id).approval.status, 'pending');
    assert.equal(f.service.listAuto(f.project.id).find(item => item.id === group.id)!.status, 'stopped');
    assert.equal(f.store.getProject(f.project.id).canvas.nodes.length, 3);
    assert.equal(f.store.getProject(f.project.id).canvas.connections.length, 0);
  } finally { await f.cleanup(); }
});

test('server restart preserves interrupted actions without execution or approval replay', async () => {
  const f = fixture();
  const preview = f.service.preview(f.project.id, { nodeId: 'a', request: 'Pending before shutdown' });
  await f.service.shutdown(); f.store.close();
  const store = new Store(f.dir), service = new ExperimentService(store);
  try {
    assert.equal(store.getRun(preview.run.id).status, 'interrupted');
    assert.equal(store.getRun(preview.run.id).events.some(event => event.type === 'process-start'), false);
    assert.throws(() => allow(service, preview), /no longer pending/);
    const retry = service.retry(preview.run.id);
    assert.notEqual(retry.run.id, preview.run.id);
    assert.equal(retry.approval.status, 'pending');
    assert.equal(retry.run.retryOf, preview.run.id);
  } finally { await service.shutdown(); store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('two real local workers run independently and stopping one preserves the other artifacts', async () => {
  const f = fixture();
  try {
    const a = f.service.preview(f.project.id, { nodeId: 'a', request: 'First parallel worker', code: 'metric("A", 10)' });
    const b = f.service.preview(f.project.id, { nodeId: 'b', request: 'Second parallel worker', code: 'metric("B", 20)' });
    f.service.startAuto(f.project.id, { scope: 'Two parallel local actions only', outcome: 'Separate metrics', runIds: [a.run.id, b.run.id], fingerprints: { [a.run.id]: a.approval.fingerprint, [b.run.id]: b.approval.fingerprint }, maxConcurrency: 2 });
    assert.equal(f.store.getRun(a.run.id).status, 'running');
    assert.equal(f.store.getRun(b.run.id).status, 'running');
    f.service.cancel(a.run.id);
    assert.equal((await finished(f.store, a.run.id)).status, 'cancelled');
    const survivor = await finished(f.store, b.run.id);
    assert.equal(survivor.status, 'completed');
    assert.equal(JSON.parse(survivor.artifactIds.map(id => f.store.getArtifact(id)).find(artifact => artifact.kind === 'metric')!.content).value, 20);
    assert.equal(f.store.getRun(a.run.id).artifactIds.some(id => survivor.artifactIds.includes(id)), false);
  } finally { await f.cleanup(); }
});

test('missing Python never turns a reviewer/runtime failure into permission', async () => {
  const f = fixture({ python: '/nonexistent/python-ros-test' });
  try {
    const preview = f.service.preview(f.project.id, { nodeId: 'a', request: 'Unavailable runtime fixture' });
    assert.equal(f.service.capabilities().available, false);
    assert.throws(() => allow(f.service, preview), /runtime unavailable/);
    assert.equal(f.service.inspect(preview.run.id).approval.status, 'pending');
    assert.equal(f.store.getRun(preview.run.id).events.some(event => event.type === 'process-start'), false);
  } finally { await f.cleanup(); }
});

test('actual wall-clock timeout kills child and records exit outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-python-timeout-'));
  const wrapper = join(dir, 'slow-python');
  // Test-only executable delays the real worker while allowing the version probe.
  writeFileSync(wrapper, '#!/bin/sh\nif [ "$3" = "-c" ]; then exec /usr/bin/python3 "$@"; fi\nexec /usr/bin/python3 -I -S -c "import time; time.sleep(5)"\n', { mode: 0o700 });
  const f = fixture({ python: wrapper, timeoutMs: 100 });
  try {
    const preview = f.service.preview(f.project.id, { nodeId: 'a', request: 'Timeout fixture, not model output' });
    allow(f.service, preview);
    const run = await finished(f.store, preview.run.id);
    assert.equal(run.status, 'failed'); assert.match(run.error!, /timed out/);
    const log = JSON.parse(run.artifactIds.map(id => f.store.getArtifact(id)).find(a => a.kind === 'log')!.content);
    assert.equal(log.signal, 'SIGKILL');
  } finally { await f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
