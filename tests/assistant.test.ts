import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { ExperimentService } from '../src/server/experiments.js';
import { AssistantService } from '../src/server/assistant.js';
import { SandboxBudget } from '../src/server/sandbox-budget.js';
import type { ModelAdapter, ModelRequest, ModelResponse, SearchAdapter } from '../src/server/providers.js';
import type { ExecutionBackend, SandboxCapabilities, SandboxResult } from '../src/server/sandbox.js';
import type { Artifact, Run } from '../src/shared/types.js';
import type { AssistantReference, AssistantTurn, ResearchMemory } from '../src/shared/assistant.js';

// These doubles exercise orchestration and persistence. They never call a model,
// search provider or execution runtime, and do not establish live integration.
const response = (content: unknown): ModelResponse => ({ content: JSON.stringify(content), model: 'offline-assistant-fixture', modelVersion: null, usage: { inputTokens: 20, outputTokens: 30 }, metadata: { offlineFixture: true } });
const reply = (patch: Record<string, unknown> = {}) => ({ reply: 'Labelled offline assistant response.', question: null, references: [], memory: [], tools: [], ...patch });
const caps: SandboxCapabilities = { available: true, backend: 'docker-python', policy: 'offline-fixture', runtime: 'offline fixture', workerHash: 'fixture-worker', imageId: 'fixture-image', libraries: {}, enforcement: ['No actual execution'], limitations: ['Offline fixture only'], timeoutMs: 30000, maxMemoryMb: 512, maxOutputBytes: 1000000 };
type Answer = unknown | (() => unknown | Promise<unknown>);
function services(store: Store, answers: Answer[], configured = true, runtimeOverride?: ExecutionBackend) {
  const requests: ModelRequest[] = [], signals: AbortSignal[] = [], searches: string[] = [], starts: unknown[] = [];
  const model: ModelAdapter = {
    provider: 'nebius', model: 'offline-assistant-fixture', configured,
    async prepare() { return { id: this.model, contextTokens: 100000, inputUsdPerToken: 0.0000001, outputUsdPerToken: 0.0000003, capabilities: { structuredOutput: false, toolCalling: false, cancellation: 'abort-request', modelVersion: false }, metadata: { offlineFixture: true } }; },
    async complete(request, signal) {
      requests.push(structuredClone(request)); signals.push(signal);
      if (!answers.length) throw new Error('Offline fixture exhausted; no live fallback exists.');
      const answer = answers.shift();
      return response(typeof answer === 'function' ? await answer() : answer);
    },
  };
  const search: SearchAdapter = { configured: true, async search(query) { searches.push(query); return { results: [{ title: 'Offline source excerpt', url: 'https://example.org/offline-fixture', content: 'EXACT_OFFLINE_SOURCE_CLAIM; incomplete excerpt.', locator: 'chars 0-54' }], credits: 1, requestId: 'offline-search-only' }; } };
  const runtime: ExecutionBackend = runtimeOverride ?? { capabilities: () => structuredClone(caps), start(input) { starts.push(input); throw new Error('No execution is permitted by this orchestration fixture.'); } };
  const execution = new ExecutionService(store, { model, search, limits: { nebius: 5, tavily: 10 }, includeSetupUsage: false });
  const experiments = new ExperimentService(store, { sandbox: runtime, nebiusSandbox: runtime, sandboxBudget: new SandboxBudget(store, {}) });
  const assistant = new AssistantService(store, execution, experiments);
  return { assistant, execution, experiments, requests, signals, searches, starts, async shutdown() { await assistant.shutdown(); await execution.shutdown(); await experiments.shutdown(); } };
}
function fixture(answers: Answer[] = [], configured = true, runtimeOverride?: ExecutionBackend) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-assistant-fixture-')), store = new Store(dir), project = store.createProject('Offline continuous assistant fixture');
  store.mutate(project.id, ['a', 'b'].map((id, i) => ({ type: 'addNode' as const, node: { id, title: `Fixture ${id}`, description: 'Fixture research context', kind: 'activity' as const, x: i * 384, y: 0 } })), 'Fixture setup');
  const api = services(store, answers, configured, runtimeOverride);
  api.experiments.authority.configure(project.id, { mode: 'ask' });
  return { dir, store, project, ...api, async close() { await api.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } throw new Error('Offline assistant fixture timed out.'); }
async function finished(f: { assistant: AssistantService; project: { id: string } }, id?: string) {
  const turn = () => { const turns = f.assistant.state(f.project.id).turns; return id ? turns.find(t => t.id === id)! : turns.at(-1)!; };
  await until(() => turn().status !== 'running'); return turn();
}
function capture(store: Store, projectId: string, nodeId: string, artifacts: { kind: Artifact['kind']; content: string; capture?: Artifact['capture']; title?: string }[], options: { configuration?: Record<string, unknown>; status?: Run['status']; error?: string } = {}) {
  const project = store.getProject(projectId), node = project.canvas.nodes.find(n => n.id === nodeId)!;
  const run = store.createRun({ id: randomUUID(), projectId, nodeId, node: structuredClone(node), request: 'Offline saved evidence fixture', useSearch: false, status: 'running', createdAt: new Date().toISOString(), projectRevision: project.revision, inputs: [], messages: [], provider: 'offline-fixture', model: 'offline-fixture', modelVersion: null, configuration: options.configuration ?? {}, tools: [], events: [], artifactIds: [] });
  const outputs = artifacts.map((a, i) => store.addArtifact({ ...a, title: a.title ?? `Fixture output ${i}`, projectId, nodeId, runId: run.id }));
  const saved = store.updateRun(run.id, { status: options.status ?? 'completed', artifactIds: outputs.map(a => a.id), error: options.error, ...(options.status === 'running' ? {} : { endedAt: new Date().toISOString() }) });
  return { run: saved, outputs };
}
const ref = (kind: AssistantReference['kind'], id: string): AssistantReference => ({ kind, id, label: 'Offline evidence reference' });
const modelProject = (request: ModelRequest) => JSON.parse(request.messages[0].content.slice(request.messages[0].content.lastIndexOf('\nProject: ') + '\nProject: '.length));

test('outline relationship references identify source and consumer without mutating stored connections', async () => {
  const f = fixture([], false);
  try {
    f.store.mutate(f.project.id, [{ type: 'addConnection', connection: { id: 'data-link', source: 'b', target: 'a', label: 'uses data from', sourceHandle: 'left', targetHandle: 'right' } }, { type: 'addConnection', connection: { id: 'claim-link', source: 'a', target: 'b', label: 'challenges' } }], 'Fixture relationships');
    const before = f.store.getProject(f.project.id);
    const outline = f.assistant.state(f.project.id).outline;
    assert.deepEqual(outline.find(entry => entry.nodeId === 'a')!.references.slice(1).map(ref => ref.label), ['Provides data to → Fixture b', 'Fixture a → Fixture b · challenges']);
    assert.deepEqual(outline.find(entry => entry.nodeId === 'b')!.references.slice(1).map(ref => ref.label), ['Data from ← Fixture a', 'Fixture a → Fixture b · challenges']);
    assert.deepEqual(f.store.getProject(f.project.id), before);
    assert.equal(f.requests.length, 0);
    assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

test('invalid model contracts retain the captured response, apply no tools and remain readable', async () => {
  const invalid = reply({ references: [{ kind: 'dataset', id: 'invalid', label: 'Invalid reference kind' }], tools: [{ type: 'search', nodeId: 'a', query: 'Must not dispatch' }] });
  const f = fixture([invalid]);
  try {
    f.assistant.start(f.project.id, { message: 'Exercise malformed model output' });
    const turn = await finished(f);
    assert.equal(turn.status, 'failed'); assert.match(turn.error!, /expected contract.*references.0.kind/);
    assert.equal(turn.actions.length, 0); assert.equal(f.searches.length, 0);
    const saved = f.store.record<AssistantTurn & { steps: { response: string }[] }>('assistant-turn', turn.id)!;
    assert.deepEqual(JSON.parse(saved.steps[0].response), invalid);
    saved.steps[0].response = '{invalid JSON';
    f.store.saveRecord('assistant-turn', turn.id, f.project.id, saved);
    assert.equal(f.assistant.state(f.project.id).turns[0].question, null);
    assert.equal(f.assistant.state(f.project.id).turns[0].status, 'failed');
  } finally { await f.close(); }
});

test('continuous conversation preserves the original question and focus without importing node or other-project chats', async () => {
  const f = fixture([reply({ question: 'Clarified fixture question', memory: [{ kind: 'decision', text: 'Use the captured fixture context.', references: [] }] }), reply()]);
  try {
    f.store.addMessage(f.project.id, 'a', 'user', 'PRIVATE_NODE_A_CHAT');
    f.store.addMessage(f.project.id, 'b', 'user', 'PRIVATE_NEIGHBOR_CHAT');
    const other = f.store.createProject('PRIVATE_OTHER_PROJECT'); f.store.addMessage(other.id, null, 'user', 'PRIVATE_OTHER_PROJECT_CHAT');
    const initial = f.assistant.start(f.project.id, { message: 'Original fixture research question', focus: { nodeId: 'a' } });
    assert.equal((await finished(f, initial.activeTurnId!)).status, 'completed');
    f.assistant.start(f.project.id, { message: 'Continue the same question in another note', focus: { nodeId: 'b' } }); await finished(f);
    const state = f.assistant.state(f.project.id);
    assert.equal(state.memory.originalQuestion, 'Original fixture research question');
    assert.deepEqual(state.memory.questionHistory.map(q => q.text), ['Original fixture research question', 'Clarified fixture question']);
    assert.equal(state.turns[0].focus.nodeId, 'a'); assert.equal(state.turns[1].focus.nodeId, 'b');
    assert.match(JSON.stringify(f.requests[1]), /Original fixture research question|Use the captured fixture context/);
    assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE_NODE_A_CHAT|PRIVATE_NEIGHBOR_CHAT|PRIVATE_OTHER_PROJECT/);
    assert.equal(state.messages.length, 4); assert.ok(state.messages.every(m => m.nodeId === null));
    assert.equal(f.store.listMessages(f.project.id, 'a').length, 1);
  } finally { await f.close(); }
});

test('Ask carries out a direct request for ten blank blocks in one proposal without a written reason', async () => {
  const blank = Array.from({ length: 10 }, (_, index) => ({ title: `Block ${index + 1}`, description: '', kind: 'topic', parentId: null, rationale: '' }));
  const f = fixture([reply({ tools: [{ type: 'notes', summary: 'Ten blank blocks', notes: blank, relationships: [] }] })]);
  try {
    const before = f.store.getProject(f.project.id).canvas.nodes.length; f.assistant.start(f.project.id, { message: 'create 10 blank text blocks' }); const turn = await finished(f);
    assert.equal(turn.status, 'completed'); assert.equal(turn.actions.length, 1); assert.equal(turn.actions[0].status, 'pending');
    assert.match(JSON.stringify(f.requests[0]), /carry it out now with the notes tool/);
    assert.equal(f.execution.acceptGovernedProposal(f.project.id, turn.actions[0].proposalId!), true);
    const added = f.store.getProject(f.project.id).canvas.nodes.slice(before);
    assert.equal(added.length, 10); assert.ok(added.every(node => node.description === ''));
  } finally { await f.close(); }
});

test('Ask note proposals preserve structure until accepted and tools cannot use a pending note', async () => {
  const f = fixture([reply({ tools: [{ type: 'notes', summary: 'Fixture proposal', notes: [{ id: 'new-note', title: 'New fixture note', description: 'Research direction', kind: 'topic', parentId: null, rationale: 'Clarify the original fixture question.' }], relationships: [] }, { type: 'search', nodeId: 'new-note', query: 'Must wait for note acceptance' }] })]);
  try {
    const before = f.store.getProject(f.project.id); f.assistant.start(f.project.id, { message: 'Propose one useful note' }); const turn = await finished(f);
    assert.equal(turn.status, 'completed'); assert.deepEqual(f.store.getProject(f.project.id).canvas, before.canvas);
    assert.equal(turn.actions[0].status, 'pending'); assert.equal(turn.actions[1].status, 'failed');
    assert.match(turn.actions[1].error!, /does not exist|Accept/); assert.equal(f.searches.length, 0);
    assert.equal(f.execution.acceptGovernedProposal(f.project.id, turn.actions[0].proposalId!), true);
    assert.ok(f.store.getProject(f.project.id).canvas.nodes.some(n => n.id === 'new-note' && n.description.includes('Why this note exists')));
    assert.equal(f.assistant.state(f.project.id).turns[0].actions[0].status, 'completed');
    assert.equal(f.experiments.authority.policy(f.project.id).used.createdActions, 1); assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

test('evidence reuse needs an explicit decision, selects the exact immutable version and never starts work', async () => {
  const answers: Answer[] = [], f = fixture(answers);
  try {
    const original = capture(f.store, f.project.id, 'a', [{ kind: 'result', content: 'ORIGINAL_CAPTURE_VERSION' }]).outputs[0];
    capture(f.store, f.project.id, 'a', [{ kind: 'result', content: 'NEWER_CAPTURE_VERSION' }]);
    answers.push(reply({ tools: [{ type: 'reuse', artifactId: original.id, targetNodeId: 'b', reason: 'Inspect this specific original version.' }] }));
    f.assistant.start(f.project.id, { message: 'Suggest reusing the original output' }); const turn = await finished(f), action = turn.actions[0];
    assert.equal(action.status, 'pending'); assert.equal(f.store.detail(f.project.id).inputs.length, 0);
    const runCount = f.store.listRuns(f.project.id).length;
    f.assistant.decide(f.project.id, action.id, 'accept');
    const inputs = f.store.detail(f.project.id).inputs; assert.equal(inputs.length, 1); assert.equal(inputs[0].artifactId, original.id); assert.equal(inputs[0].excerpt, original.content);
    assert.equal(f.store.listRuns(f.project.id).length, runCount); assert.equal(f.starts.length, 0);
    assert.throws(() => f.assistant.decide(f.project.id, action.id, 'accept'), /no pending reuse/);
    answers.push(reply({ tools: [{ type: 'reuse', artifactId: original.id, targetNodeId: 'a', reason: 'A separately dismissible suggestion.' }] }));
    f.assistant.start(f.project.id, { message: 'Suggest another reuse' }); const later = await finished(f);
    f.assistant.decide(f.project.id, later.actions[0].id, 'dismiss'); assert.equal(f.store.detail(f.project.id).inputs.length, 1);
  } finally { await f.close(); }
});

test('cross-project focus, reference and reuse cannot expose or select another project artifact', async () => {
  const answers: Answer[] = [], f = fixture(answers);
  try {
    const other = f.store.createProject('Private other project'); f.store.mutate(other.id, [{ type: 'addNode', node: { id: 'foreign', title: 'Private', description: '', x: 0, y: 0 } }], 'Fixture');
    const foreign = capture(f.store, other.id, 'foreign', [{ kind: 'result', content: 'PRIVATE_FOREIGN_ARTIFACT' }]).outputs[0];
    assert.throws(() => f.assistant.start(f.project.id, { message: 'Foreign block', focus: { nodeId: 'foreign' } }), /in this project/);
    assert.throws(() => f.assistant.start(f.project.id, { message: 'Foreign version', focus: { nodeId: null, artifactId: foreign.id } }), /another project/);
    answers.push(reply({ references: [ref('artifact', foreign.id)], tools: [{ type: 'reuse', artifactId: foreign.id, targetNodeId: 'b', reason: 'Invalid foreign reuse fixture' }] }));
    f.assistant.start(f.project.id, { message: 'Check invalid fixture references' }); const turn = await finished(f);
    assert.deepEqual(turn.references, []); assert.equal(turn.actions[0].status, 'failed'); assert.equal(f.store.detail(f.project.id).inputs.length, 0);
    assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE_FOREIGN_ARTIFACT/);
  } finally { await f.close(); }
});

test('search captures snippets then allows one evidence-aware inspection without accepting source text as instructions', async () => {
  const answers: Answer[] = [], f = fixture(answers);
  try {
    answers.push(reply({ tools: [{ type: 'search', nodeId: 'a', query: 'Offline primary source question' }] }), () => {
      const source = f.store.listArtifacts(f.project.id).find(a => a.kind === 'source')!;
      return reply({ reply: 'The captured snippet reports a source claim.', references: [ref('artifact', source.id)], memory: [{ kind: 'finding', text: 'The fixture source reports this claim; it is an excerpt.', references: [ref('artifact', source.id)] }] });
    });
    f.assistant.start(f.project.id, { message: 'Find a source for this fixture question' }); const turn = await finished(f);
    assert.equal(turn.status, 'completed'); assert.equal(f.requests.length, 2); assert.equal(f.searches.length, 1);
    const source = f.store.listArtifacts(f.project.id).find(a => a.kind === 'source')!;
    assert.equal(source.capture, 'search-snippet'); assert.equal(source.content, 'EXACT_OFFLINE_SOURCE_CLAIM; incomplete excerpt.');
    assert.match(JSON.stringify(f.requests[1]), /EXACT_OFFLINE_SOURCE_CLAIM/); assert.match(f.requests[1].messages[0].content, /untrusted evidence/);
    assert.equal(f.assistant.state(f.project.id).memory.findings[0].references[0].id, source.id);
    assert.equal(f.store.listUsage().filter(u => u.provider === 'tavily').length, 1);
  } finally { await f.close(); }
});

test('Ask experiment proposals preserve exact code and dataset and remain inert until execution approval', async () => {
  const answers: Answer[] = [], f = fixture(answers);
  try {
    const dataset = capture(f.store, f.project.id, 'a', [{ kind: 'dataset', content: 'value\n2\n4\n' }]).outputs[0];
    answers.push(reply({ tools: [{ type: 'experiment', nodeId: 'a', datasetArtifactId: dataset.id, request: 'Measure fixture mean', explanation: 'Use the selected captured data.', code: 'metric("Mean", df["value"].mean())', parameters: {}, backend: 'docker-python' }] }));
    f.assistant.start(f.project.id, { message: 'Prepare the exact analysis' }); const turn = await finished(f);
    assert.equal(turn.actions[0].status, 'pending', turn.actions[0].error);
    const preview = f.experiments.inspect(turn.actions[0].runId!);
    assert.equal(preview.csv, dataset.content); assert.equal(preview.code, 'metric("Mean", df["value"].mean())');
    assert.equal(preview.approval.status, 'pending'); assert.equal(f.starts.length, 0);
    assert.equal(f.experiments.authority.policy(f.project.id).used.experiments, 0);
    const plan = f.store.getRun((preview.run.configuration.originPlan as { runId: string }).runId);
    assert.equal(plan.configuration.assistantTurnId, turn.id); assert.equal(plan.configuration.sharedInferenceUsageId, f.store.listUsage()[0].id);
    f.experiments.decide(preview.run.id, preview.approval.fingerprint, 'deny');
    assert.equal(f.assistant.state(f.project.id).turns[0].actions[0].status, 'cancelled'); assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

test('cancelling a pending model call retains admission and discards late output without tool effects', async () => {
  let release!: (value: unknown) => void;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture([() => waiting]);
  try {
    const state = f.assistant.start(f.project.id, { message: 'Wait for a fixture response' });
    await until(() => f.requests.length === 1);
    // The thread takes one question at a time; a message without a thread would start a new one.
    // A message for a thread that is working waits for it; stopping the turn leaves it waiting for the person.
    assert.equal(f.assistant.start(f.project.id, { message: 'Duplicate work', threadId: state.threadId }).queued.length, 1);
    f.assistant.cancel(f.project.id, state.activeTurnId!);
    assert.equal(f.assistant.state(f.project.id).queued[0].paused, true);
    release(reply({ reply: 'LATE_RESPONSE_MUST_NOT_PERSIST', tools: [{ type: 'notes', summary: 'Late note', notes: [{ id: 'late-note', title: 'Late note', description: '', kind: 'topic', parentId: null, rationale: 'Too late.' }], relationships: [] }] }));
    await until(() => f.store.listUsage()[0].status === 'uncertain');
    assert.equal(f.signals[0].aborted, true); assert.equal((await finished(f, state.activeTurnId!)).status, 'cancelled');
    assert.doesNotMatch(JSON.stringify(f.assistant.state(f.project.id)), /LATE_RESPONSE_MUST_NOT_PERSIST|late-note/);
    assert.ok(f.store.listUsage()[0].reservedUsd > 0); assert.equal(f.store.detail(f.project.id).proposals.length, 0);
  } finally { release(reply()); await f.close(); }
});

test('immediate cancellation of the saved-record view is not overwritten by its queued continuation', async () => {
  const f = fixture([], false);
  try {
    const initial = f.assistant.start(f.project.id, { message: 'Record this question locally' });
    f.assistant.cancel(f.project.id, initial.activeTurnId!);
    await delay(10);
    assert.equal(f.assistant.state(f.project.id).turns[0].status, 'cancelled');
    assert.equal(f.store.listMessages(f.project.id, null).filter(m => m.role === 'assistant').length, 0);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('cancelling an automatically admitted experiment reaches its saved run and retains shared resource consumption', async () => {
  let runtimeStarts = 0, runtimeCancels = 0;
  const runtime: ExecutionBackend = {
    capabilities: () => structuredClone(caps),
    start() {
      runtimeStarts++; let resolve!: (result: SandboxResult) => void;
      const done = new Promise<SandboxResult>(settle => { resolve = settle; });
      return { done, cancel() { runtimeCancels++; resolve({ status: 'cancelled', outputs: [], stdout: '', stderr: '', exitCode: null, signal: null, runtime: 'offline fixture', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), enforcement: ['Offline fixture; no execution'] }); } };
    },
  };
  const answers: Answer[] = [], f = fixture(answers, true, runtime);
  try {
    const data = capture(f.store, f.project.id, 'a', [{ kind: 'dataset', content: 'value\n2\n4\n' }]).outputs[0];
    f.experiments.authority.configure(f.project.id, { mode: 'full' });
    answers.push(reply({ tools: [{ type: 'experiment', nodeId: 'a', datasetArtifactId: data.id, request: 'Start the controlled fixture', explanation: 'Cancellation test only.', code: 'metric("Mean", df["value"].mean())', parameters: {}, backend: 'docker-python' }] }));
    const initial = f.assistant.start(f.project.id, { message: 'Run under the configured fixture grant' });
    await until(() => runtimeStarts === 1);
    const action = f.assistant.state(f.project.id).turns[0].actions[0]; assert.ok(action.runId, 'Cancellation must have a durable run identity while execution is active.');
    f.assistant.cancel(f.project.id, initial.activeTurnId!);
    await until(() => f.store.getRun(action.runId!).status === 'cancelled');
    assert.ok(runtimeCancels >= 1); assert.equal(f.assistant.state(f.project.id).turns[0].status, 'cancelled');
    assert.equal(f.experiments.authority.policy(f.project.id).used.experiments, 1);
    assert.equal(f.experiments.authority.policy(f.project.id).used.runtimeSeconds, 30);
    assert.equal(f.requests.length, 1); assert.equal(f.store.listUsage().length, 1);
  } finally { await f.close(); }
});

test('restart preserves project memory, focus, pending reuse and traces without replaying model or tools', async () => {
  const answers: Answer[] = [], f = fixture(answers);
  const artifact = capture(f.store, f.project.id, 'a', [{ kind: 'result', content: 'Persisted captured evidence' }]).outputs[0];
  answers.push(reply({ memory: [{ kind: 'decision', text: 'Retain this fixture decision.', references: [] }], tools: [{ type: 'reuse', artifactId: artifact.id, targetNodeId: 'b', reason: 'Await the user decision.' }] }));
  f.assistant.start(f.project.id, { message: 'Preserve the original question', focus: { nodeId: 'a', artifactId: artifact.id } });
  const turn = await finished(f); await f.shutdown();
  const stored = f.store.record<AssistantTurn & { steps: unknown[] }>('assistant-turn', turn.id)!;
  f.store.saveRecord('assistant-turn', turn.id, f.project.id, { ...stored, status: 'running' });
  const before = f.assistant.state(f.project.id); f.store.close();
  const store = new Store(f.dir), api = services(store, []);
  try {
    const state = api.assistant.state(f.project.id); assert.equal(state.turns[0].status, 'interrupted'); assert.equal(state.activeTurnId, null);
    assert.equal('steps' in state.turns[0], false, 'Private model request traces persist in the record without leaking into ordinary assistant state.');
    assert.deepEqual(state.memory, before.memory); assert.deepEqual(state.turns[0].focus, before.turns[0].focus); assert.deepEqual(state.messages, before.messages);
    assert.equal(state.turns[0].actions[0].status, 'pending'); assert.equal(store.record<{ steps: unknown[] }>('assistant-turn', turn.id)!.steps.length, 1);
    await delay(10); assert.equal(api.requests.length, 0); assert.equal(api.searches.length, 0); assert.equal(api.starts.length, 0);
    api.assistant.decide(f.project.id, turn.actions[0].id, 'accept'); assert.equal(store.detail(f.project.id).inputs[0].artifactId, artifact.id);
  } finally { await api.shutdown(); store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('findings require completed experiment outputs or captured sources, not code or unfinished/model-plan runs', async () => {
  const answers: Answer[] = [], f = fixture(answers);
  try {
    const code = capture(f.store, f.project.id, 'a', [{ kind: 'code', content: 'Unexecuted code proposal' }], { configuration: { purpose: 'experiment-plan' } });
    const noResult = capture(f.store, f.project.id, 'a', [{ kind: 'code', content: 'Completed but no captured result' }], { configuration: { kind: 'local-experiment' } });
    const metric = capture(f.store, f.project.id, 'a', [{ kind: 'metric', content: '{"value":3}' }], { configuration: { kind: 'local-experiment' } });
    const pending = capture(f.store, f.project.id, 'b', [], { status: 'running', configuration: { purpose: 'experiment-plan' } });
    answers.push(reply({ memory: [
      { kind: 'finding', text: 'UNEXECUTED_CODE_IS_NOT_OBSERVED', references: [ref('artifact', code.outputs[0].id)] },
      { kind: 'finding', text: 'MODEL_PLAN_IS_NOT_OBSERVED', references: [ref('run', code.run.id)] },
      { kind: 'finding', text: 'PENDING_RUN_IS_NOT_OBSERVED', references: [ref('run', pending.run.id)] },
      { kind: 'finding', text: 'Completed metric is recorded evidence.', references: [ref('artifact', metric.outputs[0].id)] },
      { kind: 'finding', text: 'UNKNOWN_REFERENCE_IS_NOT_OBSERVED', references: [ref('artifact', 'not-real')] },
      { kind: 'finding', text: 'NO_RESULT_OUTPUT_IS_NOT_OBSERVED', references: [ref('run', noResult.run.id)] },
    ] }));
    f.assistant.start(f.project.id, { message: 'Inspect evidence status carefully' }); await finished(f);
    const memory = f.assistant.state(f.project.id).memory;
    assert.deepEqual(memory.findings.map(m => m.text), ['Completed metric is recorded evidence.']);
    assert.equal(memory.hypotheses.length, 5); assert.ok(memory.hypotheses.every(m => m.status === 'proposed'));
    assert.equal(memory.findings[0].status, 'observed');
  } finally { await f.close(); }
});

test('bounded context keeps explicitly focused recent evidence instead of dropping it behind old artifacts', async () => {
  const f = fixture([reply()]);
  try {
    const outputs = capture(f.store, f.project.id, 'a', Array.from({ length: 30 }, (_, i) => ({ kind: 'metric' as const, content: i === 29 ? 'FOCUSED_LATEST_EVIDENCE' : `Older metric fixture ${i}` })), { configuration: { kind: 'local-experiment' } }).outputs;
    f.assistant.start(f.project.id, { message: 'Inspect the exact focused output', focus: { nodeId: 'a', artifactId: outputs.at(-1)!.id } }); await finished(f);
    assert.match(f.requests[0].messages[0].content, /FOCUSED_LATEST_EVIDENCE/);
  } finally { await f.close(); }
});

test('repair context includes actual failed code, traceback, completed tables and exact selected evidence', async () => {
  const f = fixture([reply()]);
  try {
    const dataset = capture(f.store, f.project.id, 'a', [{ kind: 'dataset', content: 'value\n2\n4\n' }]).outputs[0];
    const result = capture(f.store, f.project.id, 'b', [{ kind: 'result', content: 'Full prior capture: EXACT_SELECTED_RESULT_EXCERPT. Other saved text.' }, { kind: 'table', content: '[{"season":"winter","mean":3.5}]' }], { configuration: { kind: 'local-experiment' } });
    const selection = f.store.addInput(f.project.id, 'a', result.outputs[0].id, 'EXACT_SELECTED_RESULT_EXCERPT');
    const code = 'df = pd.read_csv("/work/fictional.csv")\nmetric("Mean", df["value"].mean())';
    const failed = capture(f.store, f.project.id, 'a', [{ kind: 'code', content: code }, { kind: 'log', content: JSON.stringify({ stdout: '', stderr: 'Traceback:\n' + 'stack frame\n'.repeat(1000) + 'FileNotFoundError: /work/fictional.csv', error: 'Recorded Python failure' }) }], { status: 'failed', error: 'FileNotFoundError: /work/fictional.csv', configuration: { kind: 'local-experiment', backend: 'docker-python', sourceDatasetArtifactId: dataset.id, code } });
    const runBefore = f.store.getRun(failed.run.id), artifactBefore = f.store.getArtifact(result.outputs[1].id);
    f.assistant.start(f.project.id, { message: 'Inspect what happened and prepare a repair', focus: { nodeId: 'a' } });
    assert.equal((await finished(f)).status, 'completed');
    const project = modelProject(f.requests[0]), actual = project.recentRuns.find((r: { id: string }) => r.id === failed.run.id);
    assert.equal(actual.status, 'failed'); assert.equal(actual.error, failed.run.error); assert.equal(actual.code, code); assert.equal(actual.datasetArtifactId, dataset.id);
    assert.match(actual.diagnostics.stderr, /FileNotFoundError: \/work\/fictional.csv/); assert.match(actual.diagnostics.stderr, /Preview truncated/);
    assert.equal(project.artifacts.find((a: { id: string }) => a.id === result.outputs[1].id).content, result.outputs[1].content);
    const selected = project.selectedInputs.find((i: { selectionId: string }) => i.selectionId === selection.id);
    assert.equal(selected.excerpt, 'EXACT_SELECTED_RESULT_EXCERPT'); assert.equal(selected.hash, result.outputs[0].hash); assert.equal(selected.targetNodeId, 'a'); assert.equal(selected.sourceNodeId, 'b');
    assert.match(f.requests[0].messages[0].content, /ALREADY loaded as df.*NEVER read_csv/);
    assert.deepEqual(f.store.getRun(failed.run.id), runBefore); assert.deepEqual(f.store.getArtifact(result.outputs[1].id), artifactBefore);
  } finally { await f.close(); }
});

test('large escaped Unicode projects compact below 60 KB while retaining questions, focus, latest request and actual failure', async () => {
  const f = fixture([reply()]);
  try {
    const rich = '雨"\\\n';
    f.store.mutate(f.project.id, Array.from({ length: 130 }, (_, i) => ({ type: 'addNode' as const, node: { id: `old-${i}`, title: `Old context ${i}`, description: rich.repeat(900), x: 0, y: i * 240 } })), 'Large offline fixture');
    f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'a', patch: { description: 'FOCUSED_NOTE_START ' + rich.repeat(900) + ' FOCUSED_NOTE_END' } }], 'Focused note fixture');
    const original = 'ORIGINAL_START ' + rich.repeat(2600) + ' ORIGINAL_END';
    f.store.addMessage(f.project.id, null, 'user', original);
    for (let i = 0; i < 30; i++) f.store.addMessage(f.project.id, null, i % 2 ? 'user' : 'assistant', `OLDER_MESSAGE_${i} ` + rich.repeat(1600));
    const memory: ResearchMemory = { originalQuestion: original, questionHistory: [{ id: 'original', text: original, at: '2026-09-22' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `question-${i}`, text: `OLDER_QUESTION_${i} ` + rich.repeat(300), at: '2026-09-22' })), { id: 'latest-question', text: 'LATEST_QUESTION_START ' + rich.repeat(400) + ' LATEST_QUESTION_END', at: '2026-09-22' }], decisions: [], findings: [], hypotheses: [], gaps: [] };
    for (const kind of ['decision', 'finding', 'hypothesis', 'gap'] as const) {
      const list = kind === 'decision' ? memory.decisions : kind === 'finding' ? memory.findings : kind === 'hypothesis' ? memory.hypotheses : memory.gaps;
      for (let i = 0; i < 40; i++) list.push({ id: `${kind}-${i}`, kind, text: `Saved ${kind} ${i} ` + rich.repeat(350), at: '2026-09-22', references: [], status: kind === 'decision' ? 'recorded' : kind === 'finding' ? 'observed' : kind === 'hypothesis' ? 'proposed' : 'unverified' });
    }
    f.store.saveRecord('research-memory', f.project.id, f.project.id, memory);
    capture(f.store, f.project.id, 'b', Array.from({ length: 35 }, (_, i) => ({ kind: 'table' as const, content: `OLD_TABLE_${i} ` + rich.repeat(1500) })), { configuration: { kind: 'local-experiment' } });
    const code = 'CODE_START\n' + '# ' + rich.repeat(1700) + '\nCODE_END';
    const failed = capture(f.store, f.project.id, 'a', [{ kind: 'code', content: code }, { kind: 'log', content: JSON.stringify({ stderr: 'TRACEBACK_START\n' + rich.repeat(4000) + '\nFINAL_RECORDED_EXCEPTION' }) }], { status: 'failed', error: 'ACTUAL_FAILURE_START ' + rich.repeat(1000) + ' ACTUAL_FAILURE_END', configuration: { kind: 'local-experiment', code, backend: 'docker-python' } });
    const focused = capture(f.store, f.project.id, 'a', [{ kind: 'table', content: 'FOCUSED_CAPTURE_START ' + rich.repeat(2000) }], { configuration: { kind: 'local-experiment' } }).outputs[0];
    // The messages saved above are the conversation from before threads, now the first thread; the request continues it.
    const legacyThread = f.assistant.state(f.project.id).threads[0].id;
    const historyBefore = f.store.listMessages(f.project.id, null), memoryBefore = structuredClone(memory), focusedBefore = f.store.getArtifact(focused.id), failedBefore = f.store.getRun(failed.run.id);
    const request = 'LATEST_REQUEST_START ' + rich.repeat(2600) + ' LATEST_REQUEST_END';
    f.assistant.start(f.project.id, { message: request, focus: { nodeId: 'a', artifactId: focused.id }, threadId: legacyThread });
    const turn = await finished(f); assert.equal(turn.status, 'completed', turn.error);
    assert.equal(f.requests.length, 1); const sent = f.requests[0], project = modelProject(sent);
    const bytes = Buffer.byteLength(JSON.stringify(sent.messages)) + Buffer.byteLength(JSON.stringify(sent.schema));
    assert.ok(bytes <= 60000, `Actual serialized context including schema was ${bytes} bytes`); assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= 64000);
    assert.ok(project.contextBudget.compactionLevel > 0); assert.ok(project.contextBudget.truncatedTextFields > 0);
    assert.ok(project.contextBudget.omitted.notes > 0); assert.ok(project.contextBudget.omitted.history > 0); assert.ok(project.contextBudget.omitted.findings > 0);
    assert.match(project.memory.originalQuestion, /ORIGINAL_START/); assert.match(project.memory.originalQuestion, /ORIGINAL_END/);
    assert.match(project.memory.latestQuestion, /LATEST_QUESTION_START/); assert.match(project.memory.latestQuestion, /LATEST_QUESTION_END/);
    const focusNote = project.notes.find((n: { id: string }) => n.id === 'a'); assert.match(focusNote.description, /FOCUSED_NOTE_START/); assert.match(focusNote.description, /FOCUSED_NOTE_END/);
    assert.equal(project.artifacts[0].id, focused.id); assert.match(project.artifacts[0].content, /FOCUSED_CAPTURE_START/);
    const outcome = project.recentRuns.find((r: { id: string }) => r.id === failed.run.id); assert.match(outcome.error, /ACTUAL_FAILURE_END/); assert.match(outcome.code, /CODE_END/); assert.match(outcome.diagnostics.stderr, /FINAL_RECORDED_EXCEPTION/);
    assert.equal(sent.messages.at(-1)!.role, 'user'); assert.match(sent.messages.at(-1)!.content, /LATEST_REQUEST_START/); assert.match(sent.messages.at(-1)!.content, /LATEST_REQUEST_END/);
    assert.deepEqual(f.store.record('research-memory', f.project.id), memoryBefore); assert.deepEqual(f.store.listMessages(f.project.id, null).slice(0, historyBefore.length), historyBefore);
    assert.deepEqual(f.store.getArtifact(focused.id), focusedBefore); assert.deepEqual(f.store.getRun(failed.run.id), failedBefore);
    assert.deepEqual(f.store.record<{ steps: { messages: unknown[] }[] }>('assistant-turn', turn.id)!.steps[0].messages, sent.messages);
  } finally { await f.close(); }
});

test('saved-record replies show the original question once', async () => {
  const f = fixture([], false);
  try {
    f.assistant.start(f.project.id, { message: 'UNIQUE_ORIGINAL_QUESTION' }); const turn = await finished(f);
    assert.equal(turn.reply.split('UNIQUE_ORIGINAL_QUESTION').length - 1, 1);
  } finally { await f.close(); }
});

test('threads keep their own history, two run at once, and the earlier conversation becomes the first thread', async () => {
  let releaseFirst!: (value: unknown) => void;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const f = fixture([() => first, reply({ reply: 'SECOND_THREAD_REPLY' }), reply({ reply: 'FOLLOW_UP_REPLY' })]);
  try {
    // The conversation saved before threads existed becomes the first thread, named after its first message, with its agent session.
    f.store.addMessage(f.project.id, null, 'user', 'EARLIER_QUESTION about the fixture');
    f.store.addMessage(f.project.id, null, 'assistant', 'EARLIER_ANSWER');
    f.store.saveRecord('claude-session', f.project.id, f.project.id, { sessionId: 'legacy-session' });
    const before = f.assistant.state(f.project.id), legacy = before.threads[0]?.id;
    assert.equal(before.threads.length, 1); assert.equal(before.threads[0].title, 'EARLIER_QUESTION about the fixture');
    assert.ok(before.messages.length === 2 && before.messages.every(message => message.threadId === legacy));
    assert.deepEqual(f.store.record('claude-session', legacy), { sessionId: 'legacy-session' });
    // While the first thread works it refuses another question, and a message without a thread starts a new one at once.
    const one = f.assistant.start(f.project.id, { message: 'Continue the earlier question', threadId: legacy });
    assert.equal(one.threadId, legacy);
    await until(() => f.requests.length === 1);
    const waiting = f.assistant.start(f.project.id, { message: 'Too soon', threadId: legacy });
    assert.equal(waiting.queued.length, 1); assert.equal(waiting.turns.filter(turn => turn.threadId === legacy && turn.status === 'running').length, 1);
    f.assistant.removeQueued(f.project.id, waiting.queued[0].id);
    const two = f.assistant.start(f.project.id, { message: 'A separate question in a new thread' });
    assert.ok(two.threadId && two.threadId !== legacy); assert.equal(two.threads.filter(thread => thread.running).length, 2);
    assert.equal(two.threads.find(thread => thread.id === two.threadId)!.title, 'A separate question in a new thread');
    const second = await finished(f, two.turns.find(turn => turn.threadId === two.threadId)!.id);
    assert.equal(second.status, 'completed', second.error); assert.equal(second.reply, 'SECOND_THREAD_REPLY');
    // The new thread's model saw its own message, not the other thread's conversation.
    assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /EARLIER_ANSWER|Continue the earlier question/);
    releaseFirst(reply({ reply: 'FIRST_THREAD_REPLY' }));
    assert.equal((await finished(f, one.activeTurnId!)).reply, 'FIRST_THREAD_REPLY');
    // A follow-up continues its own thread; the list puts the newest activity first; Rename and Delete act on one thread.
    const three = f.assistant.start(f.project.id, { message: 'Follow up in the second thread', threadId: two.threadId });
    await finished(f, three.turns.find(turn => turn.threadId === two.threadId && turn.status === 'running')!.id);
    assert.match(JSON.stringify(f.requests[2].messages), /SECOND_THREAD_REPLY/); assert.doesNotMatch(JSON.stringify(f.requests[2].messages), /FIRST_THREAD_REPLY/);
    const renamed = f.assistant.renameThread(f.project.id, two.threadId, { title: 'Second line of work' });
    assert.equal(renamed.threads[0].id, two.threadId); assert.equal(renamed.threads[0].title, 'Second line of work'); assert.equal(renamed.threads[0].last?.status, 'completed');
    const deleted = f.assistant.deleteThread(f.project.id, two.threadId);
    assert.equal(deleted.threads.length, 1); assert.ok(deleted.turns.length === 1 && deleted.turns.every(turn => turn.threadId === legacy));
    assert.ok(f.store.listMessages(f.project.id, null).every(message => message.threadId === legacy));
  } finally { await f.close(); }
});
