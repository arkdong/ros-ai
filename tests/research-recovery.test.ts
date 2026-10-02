import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { ExecutionService } from '../src/server/execution.js';
import { ExperimentService } from '../src/server/experiments.js';
import { ResearchService } from '../src/server/research.js';
import type { ApprovalMode, ResearchSession } from '../src/shared/research.js';
import type { ModelAdapter, ModelInfo, ModelRequest, ModelResponse } from '../src/server/providers.js';
import type { ExecutionBackend, SandboxCapabilities, SandboxHandle, SandboxInput, SandboxResult } from '../src/server/sandbox.js';
import type { Artifact, Run } from '../src/shared/types.js';

// These transport doubles test durable coordination only. They are explicitly
// fabricated model/output fixtures, not evidence of model quality or isolation.
const modelInfo: ModelInfo = {
  id: 'labelled-offline-recovery-fixture', contextTokens: 100000, inputUsdPerToken: .0000001, outputUsdPerToken: .0000003,
  capabilities: { structuredOutput: true, toolCalling: true, cancellation: 'abort-request', modelVersion: false },
  metadata: { fixture: true, noProviderRequest: true },
};
const response = (body: unknown): ModelResponse => ({
  model: modelInfo.id, modelVersion: null, content: JSON.stringify(body), usage: { inputTokens: 12, outputTokens: 20 },
  metadata: { fixture: true, noProviderRequest: true },
});

class FakeModel implements ModelAdapter {
  readonly provider = 'nebius';
  readonly model = modelInfo.id;
  readonly configured = true;
  requests: ModelRequest[] = [];
  signals: AbortSignal[] = [];
  constructor(private handler: (request: ModelRequest, signal: AbortSignal) => Promise<ModelResponse> = async () => { throw new Error('Unexpected fixture model call'); }) {}
  async prepare() { return modelInfo; }
  complete(request: ModelRequest, signal: AbortSignal) {
    this.requests.push(structuredClone(request)); this.signals.push(signal);
    return this.handler(request, signal);
  }
}

class FakeSandbox implements ExecutionBackend {
  starts: SandboxInput[] = [];
  capabilities(): SandboxCapabilities {
    return {
      available: true, backend: 'docker-python', policy: 'labelled-fixture-no-isolation', runtime: 'Fake transport; Python not executed',
      workerHash: 'recovery-fixture-worker', imageId: 'fixture-only', libraries: {}, enforcement: [],
      limitations: ['Fixture transport does not execute code and establishes no sandbox claim.'], timeoutMs: 1000,
      maxMemoryMb: 32, maxOutputBytes: 10000,
    };
  }
  start(input: SandboxInput): SandboxHandle {
    this.starts.push(structuredClone(input));
    const result: SandboxResult = {
      status: 'completed', outputs: [{ kind: 'metric', title: 'Fixture mean', content: JSON.stringify({ value: 2, fixture: true }), mediaType: 'application/json' }],
      stdout: 'Labelled fixture output; code not executed', stderr: '', exitCode: 0, signal: null,
      runtime: 'Fake transport', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), enforcement: [],
    };
    return { done: Promise.resolve(result), cancel: () => {} };
  }
}

function fixture(t: TestContext, model = new FakeModel(), providerLimit = 5) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-research-recovery-'));
  const store = new Store(directory), project = store.createProject('Recovery fixtures only');
  store.mutate(project.id, ['a', 'b', 'data'].map(id => ({ type: 'addNode', node: { id, title: id, description: 'Fixture rainfall question', kind: 'activity', x: 0, y: 0 } })), 'Fixture workspaces');
  const dataset = capturedDataset(store, project.id);
  const sandbox = new FakeSandbox(), experiments = new ExperimentService(store, { sandbox });
  const execution = new ExecutionService(store, { model, includeSetupUsage: false, limits: { nebius: providerLimit, tavily: 0 }, timeoutMs: 3000 });
  let research: ResearchService | undefined;
  t.after(async () => {
    await research?.shutdown(); await execution.shutdown(); await experiments.shutdown();
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, store, project, dataset, sandbox, experiments, execution, model,
    research() { research ??= new ResearchService(store, execution, experiments); return research; },
  };
}

function runFixture(store: Store, projectId: string, nodeId: string, configuration: Run['configuration'], inputs: Run['inputs'] = []): Run {
  const project = store.getProject(projectId);
  return store.createRun({
    id: randomUUID(), projectId, nodeId, request: 'Labelled recovery fixture', useSearch: false, status: 'running',
    createdAt: new Date().toISOString(), projectRevision: project.revision, node: project.canvas.nodes.find(node => node.id === nodeId)!,
    inputs, messages: [], provider: 'local', model: 'saved-fixture', modelVersion: null,
    configuration, tools: [], events: [], artifactIds: [],
  });
}

function capturedDataset(store: Store, projectId: string): Artifact {
  const run = runFixture(store, projectId, 'data', { fixture: true });
  const dataset = store.addArtifact({ projectId, nodeId: 'data', runId: run.id, kind: 'dataset', title: 'Synthetic fixture CSV', content: 'rain_mm\n1\n3\n', mediaType: 'text/csv', capture: 'full-content' });
  store.updateRun(run.id, { status: 'completed', endedAt: new Date().toISOString(), artifactIds: [dataset.id] });
  return dataset;
}

type Fixture = ReturnType<typeof fixture>;
function configure(f: Fixture, mode: ApprovalMode, experiments = 10) {
  new Authority(f.store).configure(f.project.id, {
    mode, scope: 'Fixture rainfall analysis and seasonal comparison', nodeIds: ['a', 'b'], datasetIds: [f.dataset.id], allowActionCreation: true,
    limits: { experiments, modelCalls: 10, createdActions: 3, runtimeSeconds: 100, spendUsd: 5 },
  });
}

const plannedExperiment = {
  type: 'experiment', summary: 'Fixture plan: inspect rainfall', hypothesis: 'This is a synthetic recovery fixture',
  code: 'metric("Fixture mean", df["rain_mm"].mean())', parameters: {},
};

function completedPlan(f: Fixture): Run {
  const run = runFixture(f.store, f.project.id, 'a', {
    fixture: true, purpose: 'research-step', datasetArtifactId: f.dataset.id, researchResponse: JSON.stringify(plannedExperiment),
  }, [{ id: randomUUID(), projectId: f.project.id, nodeId: 'a', artifactId: f.dataset.id, excerpt: f.dataset.content, createdAt: new Date().toISOString(), artifact: f.dataset }]);
  return f.store.updateRun(run.id, { status: 'completed', endedAt: new Date().toISOString() });
}

function savedCursor(f: Fixture, modelRun: Run, overrides: Partial<ResearchSession> = {}): ResearchSession {
  const timestamp = new Date().toISOString();
  const session: ResearchSession = {
    id: randomUUID(), projectId: f.project.id, nodeId: 'a', question: 'Inspect fixture rainfall', datasetArtifactId: f.dataset.id,
    status: 'running', phase: 'plan', step: 1, maxSteps: 1, runIds: [modelRun.id], currentRunId: modelRun.id,
    findings: [], suggestions: [], events: [], createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
  return f.store.saveRecord('research', session.id, f.project.id, session);
}

async function until<T>(get: () => T, predicate: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = get(); if (predicate(value)) return value; await delay(10);
  }
  throw new Error(`Fixture condition timed out: ${JSON.stringify(get())}`);
}
const terminal = (store: Store, id: string) => until(() => store.getRun(id), run => !['running', 'queued'].includes(run.status));

test('resume applies a captured model plan without another model call, then waits for exact approval', async t => {
  const f = fixture(t); configure(f, 'ask');
  const plan = completedPlan(f), cursor = savedCursor(f, plan);
  // Construct the coordinator only after persisting the state a crashed process left.
  const research = f.research();
  assert.equal(research.get(cursor.id).status, 'interrupted');
  research.continue(cursor.id);
  const waiting = await until(() => research.get(cursor.id), session => session.status === 'waiting' || session.status === 'failed');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.phase, 'experiment');
  assert.equal(f.model.requests.length, 0, 'Already captured model response must not be requested twice');
  assert.equal(f.sandbox.starts.length, 0, 'Recovery does not grant Ask-mode permission');
  assert.equal(waiting.step, 1);
  const preview = f.experiments.inspect(waiting.currentRunId!);
  assert.deepEqual(preview.run.configuration.originPlan, { runId: plan.id, codeChanged: false, parametersChanged: false, datasetChanged: false });
  assert.equal(preview.code, plannedExperiment.code);
  assert.equal(preview.approval.status, 'pending');
  f.experiments.decide(preview.run.id, preview.approval.fingerprint, 'allow');
  await terminal(f.store, preview.run.id);
  const finished = await until(() => research.get(cursor.id), session => session.status === 'completed' || session.status === 'failed');
  assert.equal(finished.status, 'completed');
  assert.equal(f.sandbox.starts.length, 1);
  assert.equal(f.model.requests.length, 0, 'The persisted step limit is retained after recovery');
  assert.ok(finished.events.some(event => /already captured model response/.test(event.message)));
});

test('resume adopts an experiment created before its cursor write and inspects outputs without duplicate execution', async t => {
  const model = new FakeModel(async request => {
    const marker = 'Actual latest experiment outputs and errors (capture IDs support claims; do not claim independent verification): ';
    const context = request.messages.find(message => message.content.includes(marker))!.content;
    const outcomes: { outputs: { title: string; content: string }[] }[] = JSON.parse(context.slice(context.indexOf(marker) + marker.length));
    const metric = outcomes.flatMap(outcome => outcome.outputs).find(output => output.title === 'Fixture mean');
    assert.ok(metric, 'Inspection must receive the actual saved output capture');
    assert.deepEqual(JSON.parse(metric.content), { value: 2, fixture: true });
    return response({ type: 'conclusion', summary: 'Fixture-only conclusion from the saved mean 2.', suggestions: ['A fixture seasonal follow-up'] });
  });
  const f = fixture(t, model); configure(f, 'full');
  const plan = completedPlan(f), cursor = savedCursor(f, plan, { maxSteps: 2 });
  const effect = f.experiments.preview(f.project.id, {
    nodeId: 'a', request: plannedExperiment.summary, datasetArtifactId: f.dataset.id,
    planRunId: plan.id, backend: 'docker-python', researchSessionId: cursor.id,
  });
  assert.equal((await terminal(f.store, effect.run.id)).status, 'completed');
  assert.equal(f.sandbox.starts.length, 1);
  const beforeRunIds = f.store.listRuns(f.project.id).map(run => run.id);
  const research = f.research(); research.continue(cursor.id);
  const result = await until(() => research.get(cursor.id), session => ['completed', 'failed'].includes(session.status));
  assert.equal(result.status, 'completed', result.error);
  assert.equal(f.sandbox.starts.length, 1, 'Recovery must not reexecute the already materialized effect');
  assert.equal(f.store.listRuns(f.project.id).filter(run => run.configuration.kind === 'local-experiment').length, 1);
  assert.equal(result.runIds.filter(id => id === effect.run.id).length, 1);
  assert.ok(result.processedModelRunIds?.includes(plan.id));
  assert.equal(model.requests.length, 1, 'Only the new inspection step calls the fixture model');
  assert.ok(result.findings.some(finding => /saved mean 2/.test(finding)));
  assert.equal(f.store.listRuns(f.project.id).filter(run => !beforeRunIds.includes(run.id)).length, 1);
  assert.equal(f.experiments.authority.policy(f.project.id).used.experiments, 1);
});

test('a stopped session cannot accept a pending agent Action through the generic proposal path', t => {
  const f = fixture(t); configure(f, 'ask');
  const plan = completedPlan(f);
  const proposal = f.store.createProposal(f.project.id, f.store.getProject(f.project.id).revision, 'Fixture seasonal Action', [{
    type: 'addNode', node: { id: 'new-season', parentId: 'a', title: 'Seasonal rainfall', description: 'Fixture relation', kind: 'activity', x: 0, y: 0 },
  }]);
  const cursor = savedCursor(f, plan, {
    status: 'stopped', phase: 'proposal', pendingProposalId: proposal.id,
    pendingAction: { title: 'Seasonal rainfall', description: 'Fixture only', relation: 'Compare rainfall by season', request: 'Compare fixture seasons' },
  });
  const research = f.research(), revision = f.store.getProject(f.project.id).revision;
  // The API invokes this before falling back to Store.acceptProposal; throwing
  // must prevent the generic fallback from bypassing a stopped research session.
  assert.throws(() => research.acceptProposal(f.project.id, proposal.id), /stopped.*Continue.*explicitly/);
  assert.equal(f.store.getProject(f.project.id).revision, revision);
  assert.equal(f.store.detail(f.project.id).proposals[0].status, 'pending');
  assert.equal(research.get(cursor.id).status, 'stopped');
  assert.equal(f.experiments.authority.policy(f.project.id).used.createdActions, 0);
  assert.equal(f.model.requests.length, 0);
});

test('an Auto Research group exceeding the shared limit rolls back every approval and resource reservation', async t => {
  const f = fixture(t); configure(f, 'ask', 1);
  const previews = ['a', 'b'].map(nodeId => f.experiments.preview(f.project.id, {
    nodeId, request: 'Fixture group admission', datasetArtifactId: f.dataset.id, code: plannedExperiment.code, backend: 'docker-python',
  }));
  assert.throws(() => f.experiments.startAuto(f.project.id, {
    scope: 'Two exact fixture experiments', outcome: 'Two labelled fixture metrics', runIds: previews.map(item => item.run.id),
    fingerprints: Object.fromEntries(previews.map(item => [item.run.id, item.approval.fingerprint])), maxConcurrency: 2,
  }), /Shared project experiments limit/);
  for (const preview of previews) {
    const stored = f.experiments.inspect(preview.run.id);
    assert.equal(stored.approval.status, 'pending');
    assert.equal(stored.run.configuration.autoResearch, undefined);
    assert.equal(stored.run.events.some(event => event.type === 'auto-research-authorized' || event.type === 'process-start'), false);
  }
  assert.deepEqual(f.experiments.authority.policy(f.project.id).used, { experiments: 0, modelCalls: 0, createdActions: 0, runtimeSeconds: 0, spendUsd: 0 });
  assert.equal(f.store.records('admission', f.project.id).length, 0);
  assert.equal(f.sandbox.starts.length, 0);
  assert.deepEqual(f.experiments.listAuto(f.project.id), []);
  // The failed group must not leave a consumed deduplication key either.
  f.experiments.decide(previews[0].run.id, previews[0].approval.fingerprint, 'allow');
  assert.equal((await terminal(f.store, previews[0].run.id)).status, 'completed');
  assert.equal(f.sandbox.starts.length, 1);
  assert.equal(f.experiments.authority.policy(f.project.id).used.experiments, 1);
  assert.equal(f.experiments.inspect(previews[1].run.id).approval.status, 'pending');
});

test('provider-ledger denial rolls back project model-count and spend admission before model submission', async t => {
  const f = fixture(t, new FakeModel(), .000001); configure(f, 'full');
  const before = f.experiments.authority.policy(f.project.id).used;
  const run = f.execution.startResearchStep(f.project.id, 'a', {
    request: 'Fixture admission only', datasetArtifactId: f.dataset.id, sessionId: 'fixture-session',
    messages: [{ role: 'user', content: 'Do not submit if provider admission fails' }], schema: { type: 'object' },
  });
  const failed = await terminal(f.store, run.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /budget admission refused/);
  assert.deepEqual(f.experiments.authority.policy(f.project.id).used, before);
  assert.equal(f.store.records('admission', f.project.id).length, 0);
  assert.equal(f.store.listUsage().length, 0);
  assert.equal(f.model.requests.length, 0);
});

test('stopping the project aborts in-flight project chat and ignores a late model proposal', async t => {
  let complete!: (value: ModelResponse) => void;
  const lateResponse = new Promise<ModelResponse>(resolve => { complete = resolve; });
  const model = new FakeModel(async () => lateResponse);
  const f = fixture(t, model); configure(f, 'full');
  const research = f.research(), revision = f.store.getProject(f.project.id).revision;
  const chatResult = f.execution.chat(f.project.id, 'Add one Action for a seasonal rainfall comparison').then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }),
  );
  await until(() => model.requests.length, count => count === 1);
  research.stopProject(f.project.id);
  assert.equal(model.signals[0].aborted, true);
  // Deliberately let the fake transport ignore AbortSignal and reply anyway.
  complete(response({
    reply: 'LATE_FIXTURE_REPLY_MUST_NOT_BE_SAVED', summary: 'Late fixture proposal', operations: [{
      type: 'addNode', node: { id: 'late-action', title: 'Late proposal', description: 'Fixture only', kind: 'activity', x: 0, y: 600 },
    }],
  }));
  const outcome = await chatResult;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /stopped|timed out/);
  await delay(10);
  assert.equal(f.store.getProject(f.project.id).revision, revision);
  assert.equal(f.store.detail(f.project.id).proposals.length, 0);
  assert.equal(f.store.listMessages(f.project.id, null).some(message => message.content.includes('LATE_FIXTURE_REPLY')), false);
  assert.equal(f.store.listUsage().length, 1);
  assert.equal(f.store.listUsage()[0].status, 'uncertain', 'Cancelling an in-flight request retains its conservative accounting');
  assert.equal(f.experiments.authority.policy(f.project.id).used.modelCalls, 1);
  await assert.rejects(f.execution.chat(f.project.id, 'Try more conversation'), /stopped/);
});

function pendingAction(f: Fixture) {
  const plan = completedPlan(f);
  const proposal = f.store.createProposal(f.project.id, f.store.getProject(f.project.id).revision, 'Fixture seasonal Action', [{
    type: 'addNode', node: { id: 'new-season', parentId: 'a', title: 'Seasonal rainfall', description: 'Fixture relation', kind: 'activity', x: 0, y: 0 },
  }]);
  const cursor = savedCursor(f, plan, {
    status: 'interrupted', phase: 'proposal', pendingProposalId: proposal.id,
    pendingAction: { title: 'Seasonal rainfall', description: 'Fixture only', relation: 'Compare rainfall by season', request: 'Compare fixture seasons' },
  });
  return { proposal, cursor };
}

test('stale Action acceptance rolls back admission and leaves the pending research cursor intact', t => {
  const f = fixture(t); configure(f, 'ask');
  const { proposal, cursor } = pendingAction(f), research = f.research();
  f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'b', patch: { title: 'New manual canvas edit' } }], 'Fixture stale proposal');
  const before = f.store.getProject(f.project.id), policy = f.experiments.authority.policy(f.project.id);
  assert.throws(() => research.acceptProposal(f.project.id, proposal.id), /changed|revision|stale/i);
  assert.deepEqual(f.store.getProject(f.project.id), before);
  assert.deepEqual(f.experiments.authority.policy(f.project.id), policy);
  assert.deepEqual(f.store.records('admission', f.project.id), []);
  assert.equal(f.store.detail(f.project.id).proposals.find(item => item.id === proposal.id)?.status, 'pending');
  assert.deepEqual(research.get(cursor.id), cursor);
  assert.equal(f.model.requests.length, 0);
});

test('Action acceptance commits its child, inherited input, admission and research cursor as one unit', t => {
  const f = fixture(t); configure(f, 'ask');
  const { proposal, cursor } = pendingAction(f), research = f.research();
  const before = f.store.getProject(f.project.id), policy = f.experiments.authority.policy(f.project.id);
  const save = f.store.saveRecord.bind(f.store);
  const mock = t.mock.method(f.store, 'saveRecord', function<T>(namespace: string, id: string, projectId: string, value: T): T {
    if (namespace === 'research' && typeof value === 'object' && value !== null && 'nodeId' in value && value.nodeId === 'new-season') throw new Error('Injected cursor storage failure');
    return save(namespace, id, projectId, value);
  });
  assert.throws(() => research.acceptProposal(f.project.id, proposal.id), /Injected cursor storage failure/);
  mock.mock.restore();
  assert.deepEqual(f.store.getProject(f.project.id), before, 'No accepted child may survive a failed cursor write');
  assert.deepEqual(research.get(cursor.id), cursor);
  assert.deepEqual(f.experiments.authority.policy(f.project.id), policy);
  assert.deepEqual(f.store.records('admission', f.project.id), []);
  assert.equal(f.store.detail(f.project.id).inputs.some(input => input.nodeId === 'new-season'), false);
  assert.equal(f.store.detail(f.project.id).proposals.find(item => item.id === proposal.id)?.status, 'pending');
  assert.equal(research.acceptProposal(f.project.id, proposal.id), true);
  const accepted = research.get(cursor.id), detail = f.store.detail(f.project.id);
  assert.equal(accepted.nodeId, 'new-season'); assert.equal(accepted.phase, 'plan'); assert.equal(accepted.status, 'waiting');
  assert.equal(accepted.question, 'Compare fixture seasons'); assert.equal(accepted.pendingProposalId, undefined); assert.equal(accepted.currentRunId, undefined);
  assert.ok(detail.project.canvas.nodes.some(node => node.id === accepted.nodeId));
  assert.equal(detail.proposals.find(item => item.id === proposal.id)?.status, 'accepted');
  assert.ok(detail.inputs.some(input => input.nodeId === accepted.nodeId && input.artifactId === f.dataset.id));
  assert.equal(f.experiments.authority.policy(f.project.id).used.createdActions, 1);
  assert.ok(f.experiments.authority.policy(f.project.id).nodeIds.includes(accepted.nodeId));
  assert.equal(f.store.records('admission', f.project.id).length, 1);
  assert.equal(f.model.requests.length, 0, 'Ask-mode child creation cannot start another paid step');
});

test('large saved outputs reach inspection within the full request byte limit with explicit truncation', async t => {
  let expectedMetric: Artifact, expectedRunId: string;
  const model = new FakeModel(async request => {
    assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') < 64000);
    assert.ok(Buffer.byteLength(JSON.stringify(request.messages), 'utf8') <= 48000);
    const marker = 'Actual latest experiment outputs and errors (capture IDs support claims; do not claim independent verification): ';
    const content = request.messages.find(message => message.content.includes(marker))!.content;
    assert.match(content, /CSV preview truncated/);
    assert.match(content, /Truncated for model context/);
    const outcomes: { runId: string; outputsOmitted: number; outputs: { id: string; hash: string; content: string; truncated: boolean }[] }[] = JSON.parse(content.slice(content.indexOf(marker) + marker.length));
    const latest = outcomes.find(outcome => outcome.runId === expectedRunId)!;
    assert.ok(latest.outputs.some(output => output.truncated));
    assert.ok(latest.outputsOmitted > 0);
    const metric = latest.outputs.find(output => output.id === expectedMetric.id)!;
    assert.equal(metric.hash, expectedMetric.hash);
    assert.equal(metric.content, expectedMetric.content, 'Small numeric results remain available for reasoning');
    return response({ type: 'conclusion', summary: 'Fixture inspection received bounded previews and the exact saved metric.', suggestions: [] });
  });
  const f = fixture(t, model); configure(f, 'ask');
  const dataRun = runFixture(f.store, f.project.id, 'data', { fixture: true });
  const csv = 'rain_mm,note\n' + '2,"Quoted \\ multilingual 天気 🌧️"\n'.repeat(2000);
  const data = f.store.addArtifact({ projectId: f.project.id, nodeId: 'data', runId: dataRun.id, kind: 'dataset', title: 'Large synthetic CSV', content: csv, mediaType: 'text/csv', capture: 'full-content' });
  f.store.updateRun(dataRun.id, { status: 'completed', artifactIds: [data.id], endedAt: new Date().toISOString() });
  const plan = completedPlan(f), cursor = savedCursor(f, plan, { datasetArtifactId: data.id, maxSteps: 2, question: 'Rainfall fixture '.repeat(600), findings: ['Quoted " finding\\\n天気 '.repeat(500)] });
  const prior = runFixture(f.store, f.project.id, 'a', { kind: 'local-experiment', code: '# prior retained code\n'.repeat(900), parameters: { note: 'prior retained parameter '.repeat(100) }, researchSessionId: cursor.id });
  const priorArtifacts = Array.from({ length: 14 }, (_, index) => f.store.addArtifact({ projectId: f.project.id, nodeId: 'a', runId: prior.id, kind: 'table', title: `Large prior fixture table ${index}`, content: JSON.stringify({ text: 'Quoted "value" \\ 天気 🌧️ '.repeat(1000) }), mediaType: 'application/json', capture: 'generated' }));
  f.store.updateRun(prior.id, { status: 'completed', artifactIds: priorArtifacts.map(artifact => artifact.id), endedAt: new Date().toISOString() });
  const run = runFixture(f.store, f.project.id, 'a', { kind: 'local-experiment', code: '# retained full code\n'.repeat(900), parameters: { note: 'quoted " value\\\n'.repeat(100) }, researchSessionId: cursor.id });
  expectedRunId = run.id;
  const artifacts = Array.from({ length: 14 }, (_, index) => f.store.addArtifact({ projectId: f.project.id, nodeId: 'a', runId: run.id, kind: 'table', title: `Large fixture table ${index}`, content: JSON.stringify({ rows: Array.from({ length: 500 }, (_, row) => ({ row, note: 'quoted "value" \\ 天気 🌧️ '.repeat(4) })) }), mediaType: 'application/json', capture: 'generated' }));
  expectedMetric = f.store.addArtifact({ projectId: f.project.id, nodeId: 'a', runId: run.id, kind: 'metric', title: 'Retained fixture metric', content: '{"value":2,"fixture":true}', mediaType: 'application/json', capture: 'generated' });
  artifacts.push(expectedMetric);
  f.store.updateRun(run.id, { status: 'completed', artifactIds: artifacts.map(artifact => artifact.id), endedAt: new Date().toISOString() });
  f.store.saveRecord('research', cursor.id, f.project.id, { ...cursor, status: 'interrupted', phase: 'experiment', currentRunId: run.id, runIds: [plan.id, prior.id, run.id] });
  const research = f.research(); research.continue(cursor.id);
  const finished = await until(() => research.get(cursor.id), session => ['completed', 'failed'].includes(session.status));
  assert.equal(finished.status, 'completed', finished.error); assert.equal(model.requests.length, 1);
  const inspection = f.store.getRun(finished.currentRunId!);
  assert.deepEqual(inspection.configuration.request, model.requests[0], 'The exact bounded model-visible request is retained');
  assert.deepEqual(inspection.messages, model.requests[0].messages);
  assert.equal(f.store.getArtifact(data.id).content, csv);
  for (const artifact of [...priorArtifacts, ...artifacts]) assert.deepEqual(f.store.getArtifact(artifact.id), artifact, 'Context previews cannot mutate saved captures');
});

test('explicit experiment revision chains retain the session and require their exact approval before inspection', async t => {
  let expectedRevision: string | undefined;
  const code = 'metric("Revised fixture", df["rain_mm"].max())';
  const model = new FakeModel(async request => {
    if (!expectedRevision) return response(plannedExperiment);
    const marker = 'Actual latest experiment outputs and errors (capture IDs support claims; do not claim independent verification): ';
    const content = request.messages.find(message => message.content.includes(marker))!.content;
    const outcomes: { runId: string; status: string; code: string }[] = JSON.parse(content.slice(content.indexOf(marker) + marker.length));
    const inspected = outcomes.find(outcome => outcome.runId === expectedRevision);
    assert.equal(inspected?.status, 'completed'); assert.equal(inspected?.code, code);
    return response({ type: 'conclusion', summary: 'Fixture conclusion inspects the explicitly revised experiment.', suggestions: [] });
  });
  const f = fixture(t, model); configure(f, 'ask');
  const research = f.research(), session = research.start(f.project.id, { nodeId: 'a', question: 'Inspect fixture rainfall', datasetArtifactId: f.dataset.id, maxSteps: 2 });
  const waiting = await until(() => research.get(session.id), value => value.status === 'waiting' || value.status === 'failed');
  assert.equal(waiting.phase, 'experiment', waiting.error);
  const original = f.experiments.inspect(waiting.currentRunId!);
  assert.throws(() => f.experiments.preview(f.project.id, { nodeId: 'b', request: 'Wrong Action', retryOf: original.run.id, code, backend: 'docker-python' }), /same Action/);
  assert.throws(() => f.experiments.preview(f.project.id, { nodeId: 'a', request: 'Changed data', retryOf: original.run.id, csv: 'rain_mm\n99\n', code, backend: 'docker-python' }), /keep its captured dataset/);
  assert.equal(f.store.getRun(original.run.id).status, 'queued', 'Rejected revisions must not cancel the approved lineage');
  const revision = f.experiments.preview(f.project.id, { nodeId: 'a', request: 'Explicit revision', retryOf: original.run.id, csv: f.dataset.content, code, backend: 'docker-python' });
  assert.equal(revision.run.configuration.sourceDatasetArtifactId, f.dataset.id, 'Byte-identical inline CSV retains its captured dataset identity');
  const latest = f.experiments.preview(f.project.id, { nodeId: 'a', request: 'Explicit second revision', retryOf: revision.run.id, code, parameters: { revised: true }, backend: 'docker-python' });
  expectedRevision = latest.run.id;
  assert.equal(latest.run.configuration.researchSessionId, session.id);
  assert.equal(latest.run.configuration.sourceDatasetArtifactId, f.dataset.id);
  assert.deepEqual(latest.run.configuration.originPlan, { ...original.run.configuration.originPlan as object, codeChanged: true, parametersChanged: true });
  const adopted = await until(() => research.get(session.id), value => value.currentRunId === latest.run.id);
  assert.equal(adopted.status, 'waiting'); assert.equal(adopted.phase, 'experiment');
  assert.ok(adopted.runIds.includes(original.run.id)); assert.ok(adopted.runIds.includes(revision.run.id)); assert.ok(adopted.runIds.includes(latest.run.id));
  assert.throws(() => research.continue(session.id), /exact experiment approval/);
  assert.equal(model.requests.length, 1); assert.equal(f.sandbox.starts.length, 0);
  assert.equal(f.experiments.authority.policy(f.project.id).used.experiments, 0);
  f.experiments.decide(latest.run.id, latest.approval.fingerprint, 'allow');
  const result = await until(() => research.get(session.id), value => ['completed', 'failed', 'interrupted'].includes(value.status));
  assert.equal(result.status, 'completed', result.error);
  assert.equal(model.requests.length, 2); assert.equal(f.sandbox.starts.length, 1);
  assert.equal(f.sandbox.starts[0].code, code);
  assert.equal(f.experiments.authority.policy(f.project.id).used.experiments, 1);
});

test('retry adoption updates an interrupted cursor without resuming it and leaves stopped or completed sessions alone', async t => {
  const f = fixture(t); configure(f, 'ask');
  const plan = completedPlan(f), cursor = savedCursor(f, plan, { status: 'interrupted' });
  const original = f.experiments.preview(f.project.id, { nodeId: 'a', request: 'Fixture original', datasetArtifactId: f.dataset.id, code: plannedExperiment.code, backend: 'docker-python', researchSessionId: cursor.id });
  f.store.saveRecord('research', cursor.id, f.project.id, { ...cursor, phase: 'experiment', currentRunId: original.run.id, runIds: [plan.id, original.run.id] });
  const research = f.research();
  const revision = f.experiments.preview(f.project.id, { nodeId: 'a', request: 'Fixture revision', retryOf: original.run.id, code: plannedExperiment.code, backend: 'docker-python' });
  assert.throws(() => research.continue(cursor.id), /exact experiment approval/);
  let adopted = research.get(cursor.id);
  assert.equal(adopted.currentRunId, revision.run.id); assert.equal(adopted.status, 'interrupted');
  f.experiments.cancel(revision.run.id);
  const retry = f.experiments.retry(revision.run.id);
  assert.equal(retry.run.configuration.sourceDatasetArtifactId, f.dataset.id);
  assert.equal(retry.run.configuration.researchSessionId, cursor.id);
  assert.throws(() => research.continue(cursor.id), /exact experiment approval/);
  adopted = research.get(cursor.id);
  assert.equal(adopted.currentRunId, retry.run.id); assert.equal(adopted.status, 'interrupted');
  for (const status of ['stopped', 'completed'] as const) {
    f.store.saveRecord('research', cursor.id, f.project.id, { ...adopted, status, currentRunId: original.run.id });
    await delay(550);
    assert.equal(research.get(cursor.id).status, status);
    assert.equal(research.get(cursor.id).currentRunId, original.run.id);
  }
  assert.equal(f.model.requests.length, 0); assert.equal(f.sandbox.starts.length, 0);
});
