import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { ExecutionService } from '../src/server/execution.js';
import { TAVILY_CREDIT_USD, type ModelAdapter, type ModelInfo, type ModelRequest, type ModelResponse, type SearchAdapter, type SearchResponse } from '../src/server/providers.js';

// All provider calls below are deferred in-memory fixtures. Late responses ignore
// abort deliberately; these tests do not contact Tavily, Nebius or a runtime.
const info: ModelInfo = { id: 'offline-search-lifecycle-model', contextTokens: 100000, inputUsdPerToken: .0000001, outputUsdPerToken: .0000003, capabilities: { structuredOutput: true, cancellation: 'abort-request', toolCalling: false, modelVersion: false }, metadata: { fixture: true } };
const answer = (): ModelResponse => ({ content: 'Independent fixture answer', model: info.id, modelVersion: null, usage: { inputTokens: 10, outputTokens: 5 }, metadata: { fixture: true } });
const sources = (): SearchResponse => ({ results: [{ title: 'Offline source', url: 'https://example.org/offline-only', content: 'Captured excerpt; not independent verification.', locator: 'Offline excerpt characters 0–47' }], credits: 1, requestId: 'offline-search-fixture' });
class DeferredSearch implements SearchAdapter {
  readonly configured = true;
  requests: { query: string; signal: AbortSignal; resolve: (value: SearchResponse) => void }[] = [];
  search(query: string, signal: AbortSignal) { return new Promise<SearchResponse>(resolve => this.requests.push({ query, signal, resolve })); }
}
class DeferredModel implements ModelAdapter {
  readonly configured = true; readonly provider = 'nebius'; readonly model = info.id;
  requests: { request: ModelRequest; signal: AbortSignal; resolve: (value: ModelResponse) => void }[] = [];
  async prepare() { return info; }
  complete(request: ModelRequest, signal: AbortSignal) { return new Promise<ModelResponse>(resolve => this.requests.push({ request, signal, resolve })); }
}
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(); } throw new Error('Offline fixture did not settle'); }
const observed = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
function fixture(t: TestContext, options: { timeoutMs?: number; maxConcurrent?: number; tavilyLimit?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-assistant-search-')), store = new Store(directory), project = store.createProject('Offline search lifecycle');
  store.mutate(project.id, ['a', 'b', 'c'].map(id => ({ type: 'addNode' as const, node: { id, title: id, description: 'Independent fixture note', x: 0, y: 0 } })), 'Fixture notes');
  const authority = new Authority(store);
  authority.configure(project.id, { mode: 'ask' });
  const search = new DeferredSearch(), model = new DeferredModel();
  const service = new ExecutionService(store, { search, model, limits: { nebius: 10, tavily: options.tavilyLimit ?? 10 }, timeoutMs: options.timeoutMs ?? 30000, maxConcurrent: options.maxConcurrent ?? 2, includeSetupUsage: false });
  t.after(async () => { await service.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = () => store.listRuns(project.id).find(r => r.configuration.purpose === 'assistant-search')!;
  return { store, project, authority, search, model, service, run };
}

test('assistant source discovery captures one search with no implicit model synthesis or duplicate dispatch', async t => {
  const f = fixture(t);
  const pending = observed(f.service.assistantSearch(f.project.id, 'a', 'Offline source question', new AbortController().signal, 'turn-fixture'));
  await until(() => f.search.requests.length === 1);
  await assert.rejects(f.service.assistantSearch(f.project.id, 'a', 'Offline source question', new AbortController().signal, 'turn-fixture'), /already responding/);
  assert.throws(() => f.service.startRun(f.project.id, 'a', { request: 'A different model task', useSearch: false }), /different active work/);
  f.search.requests[0].resolve(sources());
  const result = await pending;
  assert.equal(result.error, undefined); assert.equal(result.value!.status, 'completed');
  assert.equal(f.search.requests.length, 1); assert.equal(f.model.requests.length, 0);
  const detail = f.store.detail(f.project.id);
  assert.equal(detail.runs.length, 1); assert.equal(detail.inputs.length, 0);
  assert.equal(detail.artifacts.length, 1); assert.equal(detail.artifacts[0].capture, 'search-snippet');
  assert.equal(detail.artifacts[0].content, sources().results[0].content);
  assert.equal(f.store.listUsage().length, 1); assert.equal(f.store.listUsage()[0].status, 'settled');
  assert.equal(f.store.listUsage()[0].reservedUsd, TAVILY_CREDIT_USD);
  assert.equal(f.authority.policy(f.project.id).used.modelCalls, 1);
});

test('cancelRun aborts assistant search while another note keeps its independent concurrency slot and result', async t => {
  const f = fixture(t);
  const pending = observed(f.service.assistantSearch(f.project.id, 'a', 'Cancel only this search', new AbortController().signal, 'turn-cancel'));
  await until(() => f.search.requests.length === 1);
  const nodeRun = f.service.startRun(f.project.id, 'b', { request: 'Independent note request', useSearch: false });
  assert.throws(() => f.service.startRun(f.project.id, 'c', { request: 'Third work item', useSearch: false }), /Concurrency limit/);
  await until(() => f.model.requests.length === 1);
  const searchRun = f.run();
  const cancelled = f.service.cancelRun(searchRun.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(f.search.requests[0].signal.aborted, true);
  assert.equal(f.model.requests[0].signal.aborted, false);
  assert.match((await pending).error!.message, /stopped|timed out/);
  assert.deepEqual(f.store.getRun(searchRun.id), cancelled, 'Abort completion preserves the immutable terminal event');
  f.model.requests[0].resolve(answer());
  await until(() => f.store.getRun(nodeRun.id).status === 'completed');
  f.search.requests[0].resolve(sources()); await delay();
  assert.deepEqual(f.store.getRun(searchRun.id), cancelled);
  assert.equal(f.store.listArtifacts(f.project.id).filter(a => a.runId === searchRun.id).length, 0);
  assert.equal(f.store.listUsage().find(row => row.runId === searchRun.id)!.status, 'uncertain');
  assert.equal(f.store.getRun(nodeRun.id).status, 'completed');
  assert.throws(() => f.service.retryRun(searchRun.id), /search-only run/);
  assert.equal(f.search.requests.length, 1); assert.equal(f.model.requests.length, 1);
});

test('project stop aborts search through the assistant lock and the saved run lifecycle', async t => {
  const f = fixture(t);
  const pending = observed(f.service.assistantSearch(f.project.id, 'a', 'Project stop fixture', new AbortController().signal, 'turn-stop'));
  await until(() => f.search.requests.length === 1);
  const run = f.run();
  // The ResearchService.stopProject path applies these calls in this order.
  f.authority.setStopped(f.project.id, true);
  f.service.cancelProjectChat(f.project.id);
  for (const current of f.store.listRuns(f.project.id)) if (['queued', 'running'].includes(current.status)) f.service.cancelRun(current.id);
  assert.equal(f.search.requests[0].signal.aborted, true);
  assert.ok((await pending).error);
  assert.equal(f.store.getRun(run.id).status, 'cancelled');
  assert.equal(f.store.listUsage()[0].status, 'uncertain');
  f.search.requests[0].resolve(sources()); await delay();
  assert.equal(f.store.listArtifacts(f.project.id).length, 0);
  assert.deepEqual(f.service.assistantCapabilities(f.project.id), { modelAvailable: false, searchAvailable: false });
});

test('shutdown awaits search cleanup, retains interrupted state and discards responses from an abort-ignoring adapter', async t => {
  const f = fixture(t);
  const pending = observed(f.service.assistantSearch(f.project.id, 'a', 'Shutdown fixture', new AbortController().signal, 'turn-shutdown'));
  await until(() => f.search.requests.length === 1);
  const runId = f.run().id;
  await f.service.shutdown();
  assert.equal(f.search.requests[0].signal.aborted, true);
  assert.ok((await pending).error);
  const ended = f.store.getRun(runId), usage = f.store.listUsage();
  assert.equal(ended.status, 'interrupted'); assert.equal(ended.events.at(-1)!.type, 'interrupted');
  assert.equal(usage[0].status, 'uncertain', 'Shutdown waits for retained usage cleanup before returning');
  f.search.requests[0].resolve(sources()); await delay();
  assert.deepEqual(f.store.getRun(runId), ended); assert.deepEqual(f.store.listUsage(), usage);
  assert.equal(f.store.listArtifacts(f.project.id).length, 0);
  await assert.rejects(f.service.assistantSearch(f.project.id, 'b', 'No restart', new AbortController().signal, 'turn-after-shutdown'), /shutting down/);
  assert.equal(f.search.requests.length, 1);
});

test('a cancelled parent prevents undispatched search admission and an in-flight timeout never retries', async t => {
  const f = fixture(t, { timeoutMs: 20 });
  const controller = new AbortController();
  const cancelled = observed(f.service.assistantSearch(f.project.id, 'a', 'Cancel before dispatch', controller.signal, 'turn-undispatched'));
  controller.abort();
  assert.ok((await cancelled).error);
  assert.equal(f.search.requests.length, 0); assert.equal(f.store.listUsage().length, 0);
  assert.equal(f.authority.policy(f.project.id).used.modelCalls, 0);
  const timed = observed(f.service.assistantSearch(f.project.id, 'b', 'Timeout fixture', new AbortController().signal, 'turn-timeout'));
  await until(() => f.search.requests.length === 1);
  await until(() => f.run().status === 'failed');
  assert.match((await timed).error!.message, /stopped|timed out/);
  assert.equal(f.search.requests[0].signal.aborted, true);
  assert.equal(f.store.listUsage()[0].status, 'uncertain');
  f.search.requests[0].resolve(sources()); await delay();
  assert.equal(f.search.requests.length, 1); assert.equal(f.store.listArtifacts(f.project.id).length, 0);
});

test('failed search budget admission rolls back the project reservation before dispatch', async t => {
  const f = fixture(t, { tavilyLimit: 0 });
  const result = await observed(f.service.assistantSearch(f.project.id, 'a', 'No search budget', new AbortController().signal, 'turn-no-budget'));
  assert.match(result.error!.message, /budget admission/);
  assert.equal(f.run().status, 'failed'); assert.equal(f.search.requests.length, 0);
  assert.equal(f.store.listUsage().length, 0); assert.equal(f.authority.policy(f.project.id).used.modelCalls, 0);
  assert.equal(f.authority.policy(f.project.id).used.spendUsd, 0);
});

test('project-aware capabilities respect stop, zero/default allowance, call exhaustion and the exact search ceiling without changing grants', t => {
  const f = fixture(t);
  const global = f.service.assistantCapabilities();
  assert.deepEqual(global, { modelAvailable: true, searchAvailable: true });
  const empty = f.store.createProject('No project allowance');
  assert.deepEqual(f.service.assistantCapabilities(empty.id), { modelAvailable: false, searchAvailable: false });
  assert.equal(f.store.record('policy', empty.id), undefined, 'A capability check never mints a project allowance');
  const configure = (modelCalls: number, spendUsd: number) => f.authority.configure(f.project.id, { mode: 'ask' });
  configure(1, TAVILY_CREDIT_USD / 2);
  assert.deepEqual(f.service.assistantCapabilities(f.project.id), { modelAvailable: true, searchAvailable: false });
  configure(1, TAVILY_CREDIT_USD);
  assert.deepEqual(f.service.assistantCapabilities(f.project.id), global);
  f.authority.reserve(f.project.id, { kind: 'model', nodeId: 'a', fingerprint: 'fixture-exhaustion', spendUsd: TAVILY_CREDIT_USD });
  const policy = f.authority.policy(f.project.id);
  assert.deepEqual(f.service.assistantCapabilities(f.project.id), { modelAvailable: false, searchAvailable: false });
  assert.deepEqual(f.authority.policy(f.project.id), policy);
  configure(1, 10);
  assert.deepEqual(f.service.assistantCapabilities(f.project.id), { modelAvailable: false, searchAvailable: false }, 'Call exhaustion is independent of remaining spend');
  configure(2, TAVILY_CREDIT_USD);
  assert.deepEqual(f.service.assistantCapabilities(f.project.id), { modelAvailable: false, searchAvailable: false }, 'Spend exhaustion is independent of remaining calls');
  assert.deepEqual(f.service.assistantCapabilities(), global, 'No-argument capability checks retain the global view');
});
