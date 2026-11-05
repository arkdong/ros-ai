import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Authority } from '../src/server/authority.js';
import { Store } from '../src/server/store.js';
import { approvalModeFor } from '../src/shared/research.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-reserved-ids-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, authority: new Authority(store), project: store.createProject('Reserved ids') };
}

test('a block id that every object has, such as __proto__, still asks before its code runs', t => {
  const { authority, project } = fixture(t);
  authority.configure(project.id, { mode: 'ask' });
  for (const nodeId of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(authority.review(project.id, { kind: 'experiment', nodeId, fingerprint: 'f', code: 'print(1)' }).outcome, 'escalate', nodeId);
    assert.equal(authority.mode(project.id, nodeId), 'ask', nodeId);
  }
  // A mode saved for such an id is its own entry and is read back as one; anything that is not a mode is ignored.
  assert.equal(approvalModeFor({ mode: 'ask', overrides: JSON.parse('{"__proto__":"full"}') }, '__proto__'), 'full');
  assert.equal(approvalModeFor({ mode: 'review', overrides: JSON.parse('{"__proto__":"anything"}') }, '__proto__'), 'review');
});

test('new blocks may not take an id that every object has', t => {
  const { store, project } = fixture(t);
  for (const id of ['__proto__', 'constructor', 'toString'])
    assert.throws(() => store.mutate(project.id, [{ type: 'addNode', node: { id, title: 'Code', description: '', x: 0, y: 0 } }], 'Add'), /reserved/u, id);
  assert.doesNotThrow(() => store.mutate(project.id, [{ type: 'addNode', node: { id: 'proto', title: 'Code', description: '', x: 0, y: 0 } }], 'Add'));
});
