import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { projectBudgetReport } from '../src/server/budget-report.js';
import { budgetPeriodStart, summarizeBudgetPeriod, type BudgetUsage } from '../src/shared/budget-report.js';
import { createApp, apiErrorHandler } from '../src/server/app.js';
import type { UsageRecord, Run } from '../src/shared/types.js';

const instant = new Date('2026-09-23T10:30:00.000Z');
const combined = { ready: false, reason: 'Fixture', authorizationId: 'secret-authorization', maxUsd: 10, accountedUsd: 4, remainingUsd: 6 };
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
function entry(id: string, at: string, patch: Partial<BudgetUsage> = {}): BudgetUsage {
  return { id, at, provider: 'nebius', purpose: 'Fixture', status: 'settled', reservedUsd: 1, estimatedUsd: .01, inputTokens: 100, outputTokens: 10, credits: null, rawCost: null, nodeTitle: null, ...patch };
}
function savedRun(store: Store, projectId: string, id: string, patch: Partial<Run> = {}) {
  const project = store.getProject(projectId);
  return store.createRun({ id, projectId, nodeId: 'node-a', node: project.canvas.nodes[0], projectRevision: project.revision, request: 'Fixture', useSearch: false, status: 'completed', createdAt: instant.toISOString(), provider: 'nebius', model: 'fixture', modelVersion: null, configuration: {}, tools: [], events: [], artifactIds: [], inputs: [], messages: [], ...patch });
}

test('an empty budget is read-only and distinguishes no requests from unknown account credit', t => {
  const { store, project } = fixture(t), before = store.detail(project.id);
  const report = projectBudgetReport(store, project.id, { connections: [], combined, now: instant });
  assert.equal(report.remainingUsd, 0); assert.equal(report.limits.spendUsd, 0);
  assert.deepEqual(report.entries, []); assert.equal(report.providerAccountCredit, null);
  assert.equal(report.combined.accountedUsd, 4, 'A shared provider gate is not attributed to the empty project');
  assert.equal(report.used.spendUsd, 0); assert.equal(report.sandbox, null);
  assert.deepEqual(store.detail(project.id), before);
  assert.equal(store.record('policy', project.id), undefined, 'Reading a default grant does not persist it');
  const summary = summarizeBudgetPeriod(report.entries, 'hour', instant);
  assert.equal(summary.knownEstimatedUsd, 0); assert.equal(summary.unknownEstimates, 0);
  assert(!JSON.stringify(report).includes('secret-authorization'));
});

test('project ownership, reported quantities, unknown costs and retained sandbox admission stay separate', t => {
  const { store, project } = fixture(t), other = store.createProject('Other');
  savedRun(store, project.id, 'analysis');
  savedRun(store, project.id, 'sandbox-run', { provider: 'nebius-sandbox', configuration: { remote: { phase: 'completed', rawCost: 73, costUnit: 'unknown' } } });
  store.addUsage(usage('assistant', { estimatedUsd: .006, status: 'settled', reportedUsage: { projectId: project.id, authorizationId: 'do-not-expose', request: { privatePrompt: 'secret' }, response: { usage: { inputTokens: 1000, outputTokens: 200 } } } }));
  store.addUsage(usage('legacy-run', { runId: 'analysis' }));
  store.addUsage(usage('search', { provider: 'tavily', runId: 'analysis', reservedUsd: .008, estimatedUsd: 0, status: 'settled', reportedUsage: { credits: 0 } }));
  store.addUsage(usage('other-project', { reportedUsage: { projectId: other.id } }));
  store.addUsage(usage('unattributed'));
  store.saveRecord('sandbox-admission', 'sandbox-run', project.id, { runId: 'sandbox-run', reservedUsd: .2, at: instant.toISOString(), authorization: 'never-expose' });
  store.saveRecord('combined-nebius-admission', 'sandbox-sandbox-run', project.id, { kind: 'sandbox', attemptId: 'sandbox-run', amountUsd: .2, reservedUsd: .2 });
  store.saveRecord('combined-nebius-admission', 'inference-assistant', project.id, { kind: 'inference', attemptId: 'assistant', amountUsd: 1, reservedUsd: 1 });
  const authority = new Authority(store), base = authority.policy(project.id);
  authority.configure(project.id, { mode: 'ask', scope: '', nodeIds: [], datasetIds: [], allowActionCreation: false, limits: { ...base.limits, spendUsd: 5 } });
  authority.reserve(project.id, { kind: 'model', nodeId: 'project', fingerprint: 'fixture', spendUsd: 1.208 });
  const before = store.detail(project.id), ledger = store.listUsage();
  const report = projectBudgetReport(store, project.id, { connections: [{ provider: 'tavily', configured: false, detail: 'Contains no balance', limitUsd: 10, accountedUsd: 2 }], combined, sandbox: { ready: false, reason: 'Unknown price', maxCostPerRunUsd: null, pricingBasis: null, remainingRuns: 0, remainingUsd: 0 }, now: instant });
  assert.equal(report.entries.length, 4, 'Shared grant admissions do not duplicate request rows');
  assert.equal(report.unattributedWorkspaceRequests, 1);
  assert.equal(report.remainingUsd, 5 - 1.208); assert.equal(report.used.spendUsd, 1.208);
  assert.deepEqual(report.providerAllowances.map(value => value.remainingUsd), [8]);
  assert.equal(report.combined.remainingUsd, 6); assert.equal(report.sandbox?.perAttemptUsd, null);
  const assistant = report.entries.find(value => value.id === 'assistant')!;
  assert.equal(assistant.inputTokens, 1000); assert.equal(assistant.outputTokens, 200); assert.equal(assistant.nodeTitle, null);
  assert.equal(report.entries.find(value => value.id === 'legacy-run')?.nodeTitle, 'Saved analysis');
  const search = report.entries.find(value => value.id === 'search')!;
  assert.equal(search.credits, 0); assert.equal(search.estimatedUsd, 0);
  const remote = report.entries.find(value => value.provider === 'nebius-sandbox')!;
  assert.equal(remote.rawCost, 73); assert.equal(remote.estimatedUsd, null); assert.equal(remote.reservedUsd, .2);
  const summary = summarizeBudgetPeriod(report.entries, 'hour', instant);
  assert.equal(summary.knownEstimatedUsd, .006); assert.equal(summary.unknownEstimates, 2);
  assert.equal(summary.retainedUsd, 2.208); assert.equal(summary.inputTokens, 1000);
  assert.equal(JSON.stringify(report).includes('do-not-expose'), false); assert.equal(JSON.stringify(report).includes('privatePrompt'), false);
  assert.equal(JSON.stringify(report).includes('never-expose'), false);
  assert.deepEqual(store.detail(project.id), before); assert.deepEqual(store.listUsage(), ledger);
});

test('rolling views include the start boundary, exclude future and invalid timestamps, and retain unknowns', () => {
  const rows = [entry('boundary', '2026-09-23T09:30:00Z', { estimatedUsd: null }), entry('old', '2026-09-23T09:29:59.999Z'), entry('current', instant.toISOString(), { estimatedUsd: 0, inputTokens: 0 }), entry('future', '2026-09-23T10:30:00.001Z'), entry('invalid', 'not-a-date')];
  const summary = summarizeBudgetPeriod(rows, 'hour', instant);
  assert.deepEqual(summary.entries.map(value => value.id), ['current', 'boundary']);
  assert.equal(summary.knownEstimatedUsd, 0); assert.equal(summary.unknownEstimates, 1); assert.equal(summary.retainedUsd, 2);
  assert.equal(budgetPeriodStart('day', instant), instant.getTime() - 86400000);
});

test('legacy assistant and combined-admission identities establish ownership without inventing a run', t => {
  const { store, project } = fixture(t);
  store.saveRecord('assistant-turn', 'turn-a', project.id, { projectId: project.id, steps: [] });
  store.addUsage(usage('trace-turn', { reportedUsage: { assistantTurnId: 'turn-a' } }));
  store.addUsage(usage('admission-reference'));
  store.saveRecord('combined-nebius-admission', 'inference-admission-reference', project.id, { projectId: project.id, kind: 'inference', attemptId: 'admission-reference' });
  const report = projectBudgetReport(store, project.id, { connections: [], combined });
  assert.equal(report.entries.length, 2);
  assert.equal(report.unattributedWorkspaceRequests, 0);
  assert(report.entries.every(row => row.nodeTitle === null));
});

test('Today follows the browser local day through both daylight-saving transitions', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Amsterdam';
    const spring = new Date('2026-03-29T21:30:00Z');
    assert.equal(new Date(budgetPeriodStart('today', spring)).toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal((spring.getTime() - budgetPeriodStart('today', spring)) / 3600000, 22.5);
    const fall = new Date('2026-10-25T22:30:00Z');
    assert.equal(new Date(budgetPeriodStart('today', fall)).toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal((fall.getTime() - budgetPeriodStart('today', fall)) / 3600000, 24.5);
    const rows = [entry('yesterday', '2026-10-24T21:59:59.999Z'), entry('midnight', '2026-10-24T22:00:00Z')];
    assert.deepEqual(summarizeBudgetPeriod(rows, 'today', fall).entries.map(value => value.id), ['midnight']);
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(new Date(budgetPeriodStart('today', instant)).toISOString(), '2026-09-23T07:00:00.000Z');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('budget HTTP projection is project scoped, read-only and exposes no provider traces', async t => {
  const { store, project } = fixture(t);
  store.addUsage(usage('private-trace', { reportedUsage: { projectId: project.id, authorizationId: 'private-id', response: { text: 'private-response', usage: { inputTokens: 5, outputTokens: 2 } } } }));
  const before = store.detail(project.id), ledger = store.listUsage();
  const unavailable = (): never => { throw new Error('No provider calls permitted.'); };
  const app = createApp(store, { chat: async () => unavailable(), startRun: unavailable, cancelRun: unavailable, retryRun: unavailable, connectionStatuses: () => [] });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/projects/${project.id}/budget`;
  try {
    const response = await fetch(base); assert.equal(response.status, 200);
    const report = await response.json(); assert.equal(report.projectId, project.id); assert.equal(report.entries[0].inputTokens, 5);
    assert.equal(JSON.stringify(report).includes('private-id'), false); assert.equal(JSON.stringify(report).includes('private-response'), false);
    assert.equal((await fetch(base, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(base.replace(project.id, 'missing-project'))).status, 404);
    assert.deepEqual(store.detail(project.id), before); assert.deepEqual(store.listUsage(), ledger);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
