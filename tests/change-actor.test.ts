import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { inTurn } from '../src/server/turn-context.js';
import { actorName } from '../src/shared/vocabulary.js';
import type { CanvasNode, ChangeActor } from '../src/shared/types.js';

const node = (id: string): CanvasNode => ({ id, title: id, description: '', x: 0, y: 0 });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-change-actor-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.createProject('Who changed what');
  const last = (): ChangeActor | undefined => store.listChanges(project.id).at(-1)!.actor;
  return { store, project, last };
}

test('every change says who made it: the person, the agent whose turn it was, or the project folder', async t => {
  const { store, project, last } = fixture(t);
  store.mutate(project.id, [{ type: 'addNode', node: node('mine') }], 'Add a block');
  assert.deepEqual(last(), { kind: 'person' });
  assert.equal(actorName(last()), undefined, 'the person\'s own edits carry no name in the list');

  store.saveRecord('assistant-turn', 'turn-1', project.id, { id: 'turn-1', source: 'claude-agent', threadId: 'thread-1' });
  await inTurn('turn-1', async () => { store.mutate(project.id, [{ type: 'addNode', node: node('agents') }], 'Agent saved 1 finding'); });
  assert.deepEqual(last(), { kind: 'agent', agent: 'claude', turnId: 'turn-1', threadId: 'thread-1' });
  assert.equal(actorName(last()), 'Claude Code');

  store.saveRecord('assistant-turn', 'turn-2', project.id, { id: 'turn-2', source: 'outside-agent', model: 'Your Codex' });
  await inTurn('turn-2', async () => { store.mutate(project.id, [{ type: 'addNode', node: node('outside') }], 'Agent saved 1 finding'); });
  assert.equal(actorName(last()), 'Your Codex');

  store.actingAs({ kind: 'folder' }, () => store.mutate(project.id, [{ type: 'updateNode', id: 'mine', patch: { description: 'Edited in another app.' } }], 'Edited outside ros.ai: mine.md'));
  assert.deepEqual(last(), { kind: 'folder' });
  assert.equal(actorName(last()), 'Project folder');

  store.mutate(project.id, [{ type: 'updateNode', id: 'mine', patch: { title: 'Mine again' } }], 'Rename block');
  assert.deepEqual(last(), { kind: 'person' }, 'the folder\'s name does not stick to later edits');
  assert.deepEqual(store.getChange(project.id, store.listChanges(project.id).at(-1)!.id).actor, { kind: 'person' });
});

test('an accepted proposal is the agent\'s change, accepted by the person', async t => {
  const { store, project, last } = fixture(t);
  store.saveRecord('assistant-turn', 'turn-1', project.id, { id: 'turn-1', source: 'model-agent', threadId: 'thread-1' });
  const proposal = await inTurn('turn-1', async () => store.createProposal(project.id, store.getProject(project.id).revision, 'Add a plan', [{ type: 'addNode', node: node('plan') }]));
  store.acceptProposal(project.id, proposal.id);
  assert.deepEqual(last(), { kind: 'agent', agent: 'model', turnId: 'turn-1', threadId: 'thread-1', accepted: true });
  assert.equal(actorName(last()), 'ROS');
});
