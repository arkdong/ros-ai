import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { usageAnalytics } from '../src/server/budget-report.js';
import { createApp, apiErrorHandler } from '../src/server/app.js';
import type { UsageRecord, Run } from '../src/shared/types.js';

const instant = new Date('2026-09-23T10:30:00.000Z');
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-budget-report-')), store = new Store(directory);
  const project = store.createProject('Budget fixture');
  store.mutate(project.id, [{ type: 'addNode', node: { id: 'node-a', title: 'Saved analysis', description: '', x: 0, y: 0 } }], 'Fixture note');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project: store.getProject(project.id) };
}
function usage(id: string, patch: Partial<UsageRecord> = {}): UsageRecord {
  return { id, provider: 'nebius', purpose: 'Model research', reservedUsd: 1, estimatedUsd: null, reportedUsage: null, status: 'uncertain', basis: 'Fixture basis', createdAt: instant.toISOString(), ...patch };
}
function savedRun(store: Store, projectId: string, id: string, patch: Partial<Run> = {}) {
  const project = store.getProject(projectId);
  return store.createRun({ id, projectId, nodeId: 'node-a', node: project.canvas.nodes[0], projectRevision: project.revision, request: 'Fixture', useSearch: false, status: 'completed', createdAt: instant.toISOString(), provider: 'nebius', model: 'fixture', modelVersion: null, configuration: {}, tools: [], events: [], artifactIds: [], inputs: [], messages: [], ...patch });
}

test('with nothing recorded, Usage is empty and reading it changes nothing', t => {
  const { store, project } = fixture(t), before = store.detail(project.id);
  const report = usageAnalytics(store, {}, instant);
  assert.deepEqual(report, { generatedAt: instant.toISOString(), events: [] });
  assert.deepEqual(store.detail(project.id), before);
});

test('each request goes to its project, with reported quantities and unknown costs kept apart', t => {
  const { store, project } = fixture(t), other = store.createProject('Other');
  savedRun(store, project.id, 'analysis');
  store.addUsage(usage('assistant', { estimatedUsd: .006, status: 'settled', reportedUsage: { projectId: project.id, authorizationId: 'do-not-expose', model: 'nvidia/nemotron-3-super-120b-a12b', request: { privatePrompt: 'secret' }, response: { text: 'private-response', usage: { inputTokens: 1000, outputTokens: 200 } } } }));
  store.addUsage(usage('legacy-run', { runId: 'analysis' }));
  store.addUsage(usage('search', { provider: 'tavily', runId: 'analysis', purpose: 'Web search', reservedUsd: .008, estimatedUsd: 0, status: 'settled', reportedUsage: { credits: 0 } }));
  store.addUsage(usage('other-project', { reportedUsage: { projectId: other.id } }));
  store.addUsage(usage('unattributed'));
  const before = store.detail(project.id), ledger = store.listUsage();
  const report = usageAnalytics(store, {}, instant), event = (id: string) => report.events.find(value => value.id === id)!;
  assert.equal(report.events.length, 5);
  assert.deepEqual(report.events.filter(value => value.projectId === project.id).map(value => value.id).sort(), ['assistant', 'legacy-run', 'search']);
  assert.equal(event('other-project').projectTitle, 'Other');
  assert.equal(event('unattributed').projectId, null);
  const assistant = event('assistant');
  assert.equal(assistant.inputTokens, 1000); assert.equal(assistant.outputTokens, 200); assert.equal(assistant.costUsd, .006);
  assert.equal(assistant.providerName, 'Nebius'); assert.equal(assistant.model, 'Nemotron 3 Super'); assert.equal(assistant.nodeTitle, null);
  assert.equal(event('legacy-run').nodeTitle, 'Saved analysis');
  assert.equal(event('legacy-run').costUsd, null, 'A request with no reported cost stays unknown, not zero');
  const search = event('search');
  assert.equal(search.costUsd, 0); assert.equal(search.task, 'Web search'); assert.equal(search.inputTokens, null);
  for (const hidden of ['do-not-expose', 'privatePrompt', 'private-response']) assert.equal(JSON.stringify(report).includes(hidden), false);
  assert.deepEqual(store.detail(project.id), before); assert.deepEqual(store.listUsage(), ledger);
});

test('older records that name only a ROS turn or a September admission still find their project', t => {
  const { store, project } = fixture(t);
  store.saveRecord('assistant-turn', 'turn-a', project.id, { projectId: project.id, steps: [] });
  store.addUsage(usage('trace-turn', { reportedUsage: { assistantTurnId: 'turn-a' } }));
  store.addUsage(usage('admission-reference'));
  store.saveRecord('combined-nebius-admission', 'inference-admission-reference', project.id, { projectId: project.id, kind: 'inference', attemptId: 'admission-reference' });
  const report = usageAnalytics(store, {}, instant);
  assert.equal(report.events.length, 2);
  assert(report.events.every(row => row.projectId === project.id && row.nodeTitle === null));
});

test('Usage over HTTP is read-only and exposes no provider traces', async t => {
  const { store, project } = fixture(t);
  store.addUsage(usage('private-trace', { reportedUsage: { projectId: project.id, authorizationId: 'private-id', response: { text: 'private-response', usage: { inputTokens: 5, outputTokens: 2 } } } }));
  const before = store.detail(project.id), ledger = store.listUsage();
  const unavailable = (): never => { throw new Error('No provider calls permitted.'); };
  const app = createApp(store, { chat: async () => unavailable(), startRun: unavailable, cancelRun: unavailable, retryRun: unavailable, connectionStatuses: () => [] });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/usage/analytics`;
  try {
    const response = await fetch(base); assert.equal(response.status, 200);
    const report = await response.json(); assert.equal(report.events[0].projectId, project.id); assert.equal(report.events[0].inputTokens, 5);
    assert.equal(JSON.stringify(report).includes('private-id'), false); assert.equal(JSON.stringify(report).includes('private-response'), false);
    assert.equal((await fetch(base, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/budget`)).status, 404, 'The September per-project budget page is gone');
    assert.deepEqual(store.detail(project.id), before); assert.deepEqual(store.listUsage(), ledger);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
