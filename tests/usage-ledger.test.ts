import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { SpendingBudget } from '../src/server/spending-budget.js';
import type { UsageRecord } from '../src/shared/types.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-usage-ledger-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = new Store(directory); } };
}
const big = 'x'.repeat(100_000);
const request = (id: string, projectId: string): UsageRecord => ({
  id, provider: 'nebius', purpose: 'Continuous project assistant', reservedUsd: 0.5, estimatedUsd: null, status: 'reserved', basis: 'Test pricing', createdAt: new Date().toISOString(),
  reportedUsage: { projectId, authorizationId: 'auth-1', model: 'nvidia/nemotron-3-nano', request: { messages: [{ role: 'user', content: big }] }, wireRequest: big },
});

test('budgets read a slim ledger with the amounts and the fields they use, never the saved request or reply', t => {
  const f = fixture(t), project = f.store.createProject('Usage');
  f.store.addUsage(request('u1', project.id));
  const reserved = f.store.getUsage('u1')!;
  f.store.updateUsage('u1', { status: 'settled', estimatedUsd: 0.2, reportedUsage: { ...(reserved.reportedUsage as object), response: { usage: { inputTokens: 10, outputTokens: 5 }, content: big } } });
  const [entry] = f.store.usageLedger();
  assert.deepEqual(entry.reportedUsage, { authorizationId: 'auth-1', projectId: project.id, model: 'nvidia/nemotron-3-nano', response: { usage: { inputTokens: 10, outputTokens: 5 } } });
  assert.equal(entry.status, 'settled');
  assert.equal(entry.estimatedUsd, 0.2);
  assert.ok(JSON.stringify(entry).length < 1000);
  // The full record keeps everything it saved.
  assert.equal((f.store.getUsage('u1')!.reportedUsage as { wireRequest: string }).wireRequest, big);
  assert.equal(f.store.listUsage().length, 1);
  assert.equal(f.store.getUsage('missing'), undefined);
  assert.equal(new SpendingBudget(f.store).status(project.id).project?.spentUsd, 0.2);
});

test('a record changed by an earlier ros.ai on the same data is read again, and the ledger keeps the order of the records', t => {
  const f = fixture(t), project = f.store.createProject('Usage');
  for (const id of ['a', 'b', 'c']) f.store.addUsage(request(id, project.id));
  f.store.updateUsage('a', { status: 'settled', estimatedUsd: 0.1 });
  assert.deepEqual(f.store.usageLedger().map(entry => entry.id), ['a', 'b', 'c'], 'An update keeps the record in its place');
  // An earlier version settles b straight in the full record, as it knows nothing of the ledger.
  const db = new DatabaseSync(join(f.directory, 'ros-ai.sqlite'));
  try {
    const row = db.prepare('SELECT data FROM usage WHERE id = ?').get('b') as { data: string };
    db.prepare('UPDATE usage SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.data), status: 'settled', estimatedUsd: 0.7 }), 'b');
  } finally { db.close(); }
  const ledger = f.store.usageLedger();
  assert.deepEqual(ledger.map(entry => [entry.id, entry.status, entry.estimatedUsd]), [['a', 'settled', 0.1], ['b', 'settled', 0.7], ['c', 'reserved', null]]);
  assert.equal((ledger[1].reportedUsage as { wireRequest?: string }).wireRequest, undefined);
  assert.equal(new SpendingBudget(f.store).status(project.id).project?.spentUsd, 0.1 + 0.7 + 0.5);
});

test('records saved before the ledger get it once at startup, and requests left open become uncertain in both', t => {
  const f = fixture(t), project = f.store.createProject('Usage');
  f.store.addUsage(request('u2', project.id));
  const db = new DatabaseSync(join(f.directory, 'ros-ai.sqlite'));
  try { db.exec('DELETE FROM usage_ledger'); } finally { db.close(); }
  f.reopen();
  const [entry] = f.store.usageLedger();
  assert.equal(entry.id, 'u2');
  assert.equal(entry.status, 'uncertain');
  assert.equal(f.store.getUsage('u2')!.status, 'uncertain');
  assert.equal((entry.reportedUsage as { wireRequest?: string }).wireRequest, undefined);
});
