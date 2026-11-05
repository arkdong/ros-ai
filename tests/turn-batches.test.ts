import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { currentTurn, inTurn } from '../src/server/turn-context.js';
import type { Mutation, Proposal } from '../src/shared/types.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-turn-batches-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project: store.createProject('One turn') };
}
const note = (id: string): Mutation => ({ type: 'addNode', node: { id, title: id, description: '', kind: 'topic', x: 0, y: 0 } });

test('the changes one turn proposes stay acceptable through each other and through the turn’s own writes', async t => {
  const { store, project } = fixture(t);
  const propose = (summary: string, operations: Mutation[]) => store.createProposal(project.id, store.getProject(project.id).revision, summary, operations);
  let made: Proposal[] = [];
  await inTurn('turn-1', async () => {
    made = [propose('Add A', [note('a')]), propose('Add B', [note('b')])];
    // The turn writes to the canvas itself, as a search saving its sources or saved findings do.
    store.mutate(project.id, [note('finding')], 'Agent saved 1 finding');
    made.push(propose('Add C', [note('c')]));
  });
  assert.deepEqual(made.map(proposal => proposal.batch), ['turn-1', 'turn-1', 'turn-1']);
  // Accept all, as from the turn's card: each accept leaves the rest acceptable.
  for (const proposal of made) store.acceptProposal(project.id, proposal.id);
  assert.deepEqual(store.getProject(project.id).canvas.nodes.map(node => node.id).sort(), ['a', 'b', 'c', 'finding']);
});

test('a change stays out of date after a write that is not its turn’s, or that it no longer fits', async t => {
  const { store, project } = fixture(t);
  store.mutate(project.id, [note('x')], 'Add x');
  const revision = () => store.getProject(project.id).revision;
  let theirs: Proposal | undefined, unfit: Proposal | undefined, late: Promise<void> | undefined;
  await inTurn('turn-2', async () => { theirs = store.createProposal(project.id, revision(), 'Add D', [note('d')]); });
  // The person, or another thread, changes the canvas: the agent did not see it, so its change asks to be redone.
  store.mutate(project.id, [note('person')], 'The person adds a note');
  assert.throws(() => store.acceptProposal(project.id, theirs!.id), /canvas has changed/u);

  await inTurn('turn-3', async () => {
    unfit = store.createProposal(project.id, revision(), 'Rename x', [{ type: 'updateNode', id: 'x', patch: { title: 'X2' } }]);
    store.mutate(project.id, [{ type: 'removeNode', id: 'x' }], 'Remove x');
    // A callback that outlives the turn's work is no longer the turn.
    late = new Promise(resolve => setTimeout(() => { assert.equal(currentTurn(), undefined); resolve(); }, 5));
  });
  await late;
  assert.throws(() => store.acceptProposal(project.id, unfit!.id), /canvas has changed/u);
  assert.equal(currentTurn(), undefined);
});
