import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { CombinedNebiusBudget, type CombinedNebiusReservation } from '../src/server/combined-budget.js';
import { SandboxBudget, type SandboxBudgetOptions } from '../src/server/sandbox-budget.js';

const authorization = { authorizationId: 'offline-combined-budget-fixture', maxUsd: 10 };
const sandboxTerms: SandboxBudgetOptions = { authorizationId: 'offline-sandbox-fixture', maxRuns: 10, maxUsd: 10, maxCostPerRunUsd: 1, pricingBasis: 'Offline hypothetical $1 ceiling; not a real Nebius price.' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-combined-budget-'));
  const store = new Store(dir), project = store.createProject('Combined budget fixture');
  const budget = new CombinedNebiusBudget(store, authorization);
  const request = (attemptId: string, amountUsd: number, kind: 'inference' | 'sandbox' = 'inference'): CombinedNebiusReservation => ({ kind, attemptId, amountUsd, projectId: project.id, basis: 'Offline conservative pricing fixture.' });
  return { dir, store, project, budget, request, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function addUsage(store: Store, id: string, amount: number) {
  return store.addUsage({ id, provider: 'nebius', purpose: 'Offline fixture', reservedUsd: amount, estimatedUsd: null, reportedUsage: null, status: 'reserved', basis: 'Offline fixture', createdAt: new Date().toISOString() });
}

test('combined authorization is explicit, capped at $10, and cannot infer a price or account balance', () => {
  const f = fixture();
  try {
    for (const config of [{}, { maxUsd: 10 }, { authorizationId: 'fixture' }, { ...authorization, maxUsd: 35 }, { ...authorization, maxUsd: 10.000000001 }, { ...authorization, maxUsd: NaN }, { ...authorization, maxUsd: 0 }]) {
      const budget = new CombinedNebiusBudget(f.store, config);
      assert.equal(budget.status().ready, false);
      assert.throws(() => budget.reserve(f.request('denied', 1)), /explicit combined/);
    }
    assert.equal(f.budget.status().remainingUsd, 10);
    assert.throws(() => f.budget.reserve(f.request('negative', -1)), /Invalid/);
    assert.throws(() => f.budget.reserve(f.request('infinite', Infinity)), /Invalid/);
    assert.throws(() => f.budget.reserve(f.request('zero-inference', 0)), /Invalid/);
  } finally { f.close(); }
});

test('inference and sandbox share one ceiling across projects while old grants remain untouched', () => {
  const f = fixture();
  try {
    addUsage(f.store, 'historical-exhausted', 4.218304);
    const historical = f.store.listUsage();
    f.budget.reserve(f.request('model-first', 6));
    const second = f.store.createProject('Another project');
    const remote = new SandboxBudget(f.store, { ...sandboxTerms, maxCostPerRunUsd: 4, combinedBudget: f.budget });
    remote.reserve('remote-first', second.id);
    assert.equal(f.budget.status().accountedUsd, 10);
    assert.equal(f.budget.status().remainingUsd, 0);
    assert.throws(() => f.budget.reserve({ ...f.request('model-retry', 0.000001), projectId: second.id }), /combined Nebius budget/);
    assert.throws(() => remote.reserve('remote-retry', second.id), /combined Nebius budget/);
    assert.equal(remote.status().remainingRuns, 9);
    assert.deepEqual(f.store.listUsage(), historical);
    assert.equal(f.store.records('combined-nebius-admission', second.id).length, 1);
  } finally { f.close(); }
});

test('settlement never releases reservations and higher reported inference usage stops further admission', () => {
  const f = fixture();
  try {
    const first = addUsage(f.store, 'settled-small', 4);
    f.budget.reserve(f.request(first.id, 4));
    f.store.updateUsage(first.id, { status: 'settled', estimatedUsd: 0.001 });
    const uncertain = addUsage(f.store, 'cancelled-uncertain', 3);
    f.budget.reserve(f.request(uncertain.id, 3));
    f.store.updateUsage(uncertain.id, { status: 'uncertain', estimatedUsd: null });
    assert.equal(f.budget.status().accountedUsd, 7);
    f.store.updateUsage(first.id, { estimatedUsd: 7.01 });
    assert.equal(f.budget.status().accountedUsd, 10.01);
    assert.equal(f.budget.status().ready, false);
    assert.throws(() => f.budget.reserve(f.request('after-overrun', 0.01)), /combined Nebius budget/);
  } finally { f.close(); }
});

test('restart preserves uncertain admissions and changing a grant ID or ceiling cannot replenish the build', () => {
  const f = fixture();
  addUsage(f.store, 'interrupted', 8);
  f.budget.reserve(f.request('interrupted', 8));
  f.store.close();
  const store = new Store(f.dir);
  try {
    const resumed = new CombinedNebiusBudget(store, authorization);
    assert.equal(resumed.status().remainingUsd, 2);
    assert.equal(store.listUsage()[0].status, 'uncertain');
    for (const config of [{ ...authorization, authorizationId: 'unused-new-id' }, { ...authorization, maxUsd: 9 }]) {
      const replacement = new CombinedNebiusBudget(store, config);
      assert.equal(replacement.status().remainingUsd, 2);
      assert.equal(replacement.status().ready, false);
      assert.throws(() => replacement.reserve(f.request('replacement', 1)), /changing identifiers or limits/);
    }
    resumed.reserve(f.request('explicit-retry', 2));
    assert.throws(() => new CombinedNebiusBudget(store, authorization).reserve(f.request('extra', 1)), /combined Nebius budget/);
  } finally { store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('known admission failure rolls back combined, provider, project and sandbox counters atomically', () => {
  const f = fixture();
  try {
    const authority = new Authority(f.store);
    const remote = new SandboxBudget(f.store, { ...sandboxTerms, combinedBudget: f.budget });
    assert.throws(() => f.store.atomic(() => {
      addUsage(f.store, 'rollback-model', 2);
      f.budget.reserve(f.request('rollback-model', 2));
      remote.reserve('rollback-sandbox', f.project.id);
      authority.reserve(f.project.id, { kind: 'model', nodeId: 'project', fingerprint: 'fixture-denial', spendUsd: 2 });
    }), /spendUsd/);
    assert.equal(f.budget.status().accountedUsd, 0);
    assert.equal(f.store.listUsage().length, 0);
    assert.equal(remote.status().remainingRuns, 10);
    assert.equal(authority.policy(f.project.id).used.modelCalls, 0);
    assert.equal(f.store.records('combined-nebius-admission', f.project.id).length, 0);
    const policy = authority.policy(f.project.id);
    authority.configure(f.project.id, { mode: 'ask', scope: 'Offline fixture', nodeIds: [], datasetIds: [], allowActionCreation: false, limits: { ...policy.limits, spendUsd: 10 } });
    assert.throws(() => f.store.atomic(() => {
      authority.reserve(f.project.id, { kind: 'model', nodeId: 'project', fingerprint: 'rollback-persistence', spendUsd: 2 });
      remote.reserve('rollback-persistence', f.project.id);
      throw new Error('Fixture approval persistence failure');
    }), /persistence failure/);
    assert.equal(f.budget.status().accountedUsd, 0);
    assert.equal(authority.policy(f.project.id).used.modelCalls, 0);
    assert.equal(remote.status().remainingRuns, 10);
  } finally { f.close(); }
});

test('rechecking one exact admission is idempotent, but cannot hide another attempt or project', () => {
  const f = fixture();
  try {
    const input = f.request('same-attempt', 7);
    const original = f.budget.reserve(input);
    assert.deepEqual(f.budget.reserve(input), original);
    assert.equal(f.budget.status().accountedUsd, 7);
    assert.throws(() => f.budget.reserve({ ...input, amountUsd: 1 }), /different request terms/);
    assert.throws(() => f.budget.reserve({ ...input, basis: 'Different price' }), /different request terms/);
    const other = f.store.createProject('Other project');
    assert.throws(() => f.budget.reserve({ ...input, projectId: other.id }), /different request terms/);
    f.budget.reserve(f.request('same-attempt', 3, 'sandbox'));
    assert.equal(f.budget.status().accountedUsd, 10);
    assert.equal(f.store.records('combined-nebius-admission', f.project.id).length, 2);
  } finally { f.close(); }
});

test('a shared $10 authorization cannot bypass unknown sandbox pricing or silently add historical sandbox attempts', () => {
  const f = fixture();
  try {
    const unknown = new SandboxBudget(f.store, { ...sandboxTerms, maxCostPerRunUsd: undefined, combinedBudget: f.budget });
    assert.equal(unknown.status().ready, false);
    assert.throws(() => unknown.reserve('unknown-price', f.project.id), /verified worst-case/);
    assert.equal(f.budget.status().accountedUsd, 0);
    const noCombinedAuthorization = new SandboxBudget(f.store, { ...sandboxTerms, combinedBudget: new CombinedNebiusBudget(f.store, {}) });
    assert.equal(noCombinedAuthorization.status().ready, false);
    assert.throws(() => noCombinedAuthorization.reserve('priced-but-unauthorized', f.project.id), /explicit combined/);
    assert.equal(noCombinedAuthorization.status().remainingRuns, 10);
    const historical = new SandboxBudget(f.store, sandboxTerms);
    historical.reserve('old-sandbox-attempt', f.project.id);
    const current = new SandboxBudget(f.store, { ...sandboxTerms, combinedBudget: f.budget });
    current.reserve('old-sandbox-attempt', f.project.id);
    assert.equal(f.budget.status().accountedUsd, 0);
    current.reserve('new-sandbox-attempt', f.project.id);
    assert.equal(f.budget.status().accountedUsd, 1);
    assert.notEqual(current.fingerprint(), historical.fingerprint());
  } finally { f.close(); }
});

test('admission rounds charges upward without a tolerance above the ceiling; documented free sandbox attempts stay bounded', () => {
  const f = fixture();
  try {
    f.budget.reserve(f.request('almost-all', 9.9999999991));
    assert.equal(f.budget.status().accountedUsd, 10);
    assert.throws(() => f.budget.reserve(f.request('tiny-positive', 1e-12)), /combined Nebius budget/);
    const free = new SandboxBudget(f.store, { ...sandboxTerms, maxRuns: 1, maxUsd: 0, maxCostPerRunUsd: 0, pricingBasis: 'Offline fixture for explicitly documented free terms.', combinedBudget: f.budget });
    assert.equal(free.status().ready, true);
    free.reserve('documented-free-fixture', f.project.id);
    assert.equal(f.budget.status().accountedUsd, 10);
    assert.throws(() => free.reserve('extra-free-fixture', f.project.id), /exhausted/);
  } finally { f.close(); }
});
