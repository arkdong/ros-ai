import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { reservePaidUsage, settlePaidUsage } from '../src/server/paid-usage.js';
import { SpendingBudget } from '../src/server/spending-budget.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-paid-usage-')), store = new Store(directory), project = store.createProject('Paid usage');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project };
}
const turn = (projectId: string, amountUsd = 5) => ({ provider: 'claude', amountUsd, purpose: 'Claude Code assistant turn', basis: 'Fixture cap for one turn', trace: { requestId: 'request-a', projectId } });

test('a paid request is written to Usage before it is sent and settles once, at the cost the provider reports', t => {
  const { store, project } = fixture(t);
  const usage = reservePaidUsage(store, turn(project.id));
  assert.equal(usage.status, 'reserved'); assert.equal(usage.reservedUsd, 5); assert.equal(usage.estimatedUsd, null);
  assert.deepEqual(store.listUsage().map(row => row.id), [usage.id]);
  settlePaidUsage(store, usage.id, 0.42, { subtype: 'success' });
  const settled = store.getUsage(usage.id)!;
  assert.equal(settled.status, 'settled'); assert.equal(settled.estimatedUsd, 0.42); assert.equal(settled.reservedUsd, 5);
  assert.deepEqual(settled.reportedUsage, { requestId: 'request-a', projectId: project.id, subtype: 'success' });
  assert.throws(() => settlePaidUsage(store, usage.id, 0.1, {}), /already settled/);
  assert.throws(() => settlePaidUsage(store, 'no-such-request', 0.1, {}), /missing/);
  assert.equal(store.getUsage(usage.id)!.estimatedUsd, 0.42);
});

test('with no monthly budget nothing is capped; with one, a request it has no room for is refused and leaves no record', t => {
  const { store, project } = fixture(t), budget = new SpendingBudget(store);
  for (let index = 0; index < 3; index++) reservePaidUsage(store, turn(project.id, 20));
  assert.equal(store.listUsage().length, 3);
  budget.set('all', undefined, 62);
  assert.throws(() => reservePaidUsage(store, turn(project.id, 5)), /budget for all projects \(US\$62\.00\) has no room/);
  assert.equal(store.listUsage().length, 3);
  // A settled request counts at what it cost, not at what it reserved, so room comes back.
  settlePaidUsage(store, store.listUsage()[0]!.id, 1, {});
  assert.equal(reservePaidUsage(store, turn(project.id, 5)).status, 'reserved');
  budget.set('project', project.id, 40);
  assert.throws(() => reservePaidUsage(store, turn(project.id, 5)), /This project's monthly budget \(US\$40\.00\) has no room/);
});

test('a request whose cost cannot be estimated is not recorded or sent', t => {
  const { store, project } = fixture(t);
  assert.throws(() => reservePaidUsage(store, turn(project.id, Number.NaN)), /could not be estimated/);
  assert.throws(() => settlePaidUsage(store, 'any', -1, {}), /unreadable/);
  assert.equal(store.listUsage().length, 0);
});
