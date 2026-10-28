import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { Authority } from '../src/server/authority.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { SET_ASIDE, arrivedGroups, proposedGroups } from '../src/shared/groups.js';
import { canvasChange } from '../src/shared/canvas-position.js';
import type { ApprovalMode } from '../src/shared/research.js';
import type { Canvas, Mutation } from '../src/shared/types.js';

// Two candidate groups, each with a profile note, and each candidate's CV saved outside the groups: the canvas a
// "download all CVs" request left behind.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-agent-scope-'));
  const store = new Store(join(dir, 'store')), execution = new ExecutionService(store, { includeSetupUsage: false });
  const project = store.createProject('Recruitment');
  store.mutate(project.id, [
    { type: 'addNode', node: { id: 'group-a', title: 'Candidate A', description: '', kind: 'group', x: 0, y: 0 } },
    { type: 'addNode', node: { id: 'profile-a', title: 'Candidate A profile', description: 'Profile', kind: 'topic', blockType: 'note', parentId: 'group-a', x: 0, y: 0 } },
    { type: 'addNode', node: { id: 'group-b', title: 'Candidate B', description: '', kind: 'group', x: 864, y: 0 } },
    { type: 'addNode', node: { id: 'profile-b', title: 'Candidate B profile', description: 'Profile', kind: 'topic', blockType: 'note', parentId: 'group-b', x: 0, y: 0 } },
    { type: 'addNode', node: { id: 'cv-a', title: 'Candidate A CV', description: 'PDF saved from Notion', kind: 'topic', x: 0, y: 960 } },
    { type: 'addNode', node: { id: 'cv-b', title: 'Candidate B CV', description: 'PDF saved from Notion', kind: 'topic', x: 864, y: 960 } },
  ], 'Recruitment canvas');
  // Full access: every change lands at once.
  const authority = new Authority(store);
  authority.configure(project.id, { mode: 'full' });
  const experiments = { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService;
  const agent = (nodeIds: string[]) => new AgentWorkspaceTools(store, execution, experiments, { projectId: project.id, nodeIds, artifactIds: [] }, `turn-${Math.random()}`, 'claude');
  const propose = (nodeIds: string[], operations: Mutation[]) => agent(nodeIds).call('ros_propose_canvas', { summary: 'Put each CV in its group', rationale: 'The person asked.', operations }) as Promise<{ action: { proposalId: string; status: string } }>;
  const proposal = (id: string) => store.detail(project.id).proposals.find(item => item.id === id)!;
  const mode = (value: ApprovalMode) => authority.configure(project.id, { mode: value });
  const parentOf = (id: string) => store.getProject(project.id).canvas.nodes.find(node => node.id === id)?.parentId;
  return { store, execution, authority, project, mode, parentOf, propose, proposal, agent, async close() { await execution.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const into = (id: string, parentId: string): Mutation => ({ type: 'updateNode', id, patch: { parentId, x: 0, y: 480 } });

test('Ros moves blocks into any group on the canvas, whatever is selected, and with full access the move lands at once', async () => {
  // Nothing selected, one other group selected, or the block's own group selected: each is the same change.
  for (const selected of [[], ['group-b'], ['group-a']]) {
    const f = fixture();
    try {
      const { action } = await f.propose(selected, [into('cv-a', 'group-a'), into('cv-b', 'group-b')]);
      assert.equal(action.status, 'completed', `selected: ${selected.join(', ') || 'nothing'}`);
      assert.deepEqual(['cv-a', 'cv-b'].map(f.parentOf), ['group-a', 'group-b']);
      // One Undo takes the whole change back.
      f.store.undo(f.project.id);
      assert.deepEqual(['cv-a', 'cv-b'].map(f.parentOf), [undefined, undefined]);
    } finally { await f.close(); }
  }
});

test('Full access also edits and removes at once, and Undo brings a removed group back with its blocks', async () => {
  const f = fixture();
  try {
    const edit = await f.propose([], [{ type: 'updateNode', id: 'profile-a', patch: { description: 'Strong writer.' } }]);
    assert.equal(edit.action.status, 'completed');
    const removal = await f.propose(['cv-a'], [{ type: 'removeNode', id: 'group-b' }]);
    assert.equal(removal.action.status, 'completed');
    assert(!f.store.getProject(f.project.id).canvas.nodes.some(node => node.id === 'profile-b'));
    f.store.undo(f.project.id);
    assert.equal(f.parentOf('profile-b'), 'group-b');
  } finally { await f.close(); }
});

test('Approve for me lets new blocks, moves and regrouping land and waits for edits and removals', async () => {
  const f = fixture();
  try {
    f.mode('review');
    assert.equal((await f.propose([], [into('cv-a', 'group-a')])).action.status, 'completed', 'a move lands');
    // A change that sends a field again unchanged is still only a move.
    assert.equal((await f.propose([], [{ type: 'updateNode', id: 'cv-b', patch: { title: 'Candidate B CV', parentId: 'group-b', x: 0, y: 480 } }])).action.status, 'completed');
    assert.deepEqual(['cv-a', 'cv-b'].map(f.parentOf), ['group-a', 'group-b']);
    const added = await f.propose([], [{ type: 'addNode', node: { id: 'score-b', title: 'Score', description: 'Clear answers.', kind: 'topic', parentId: 'group-b', x: 0, y: 960 } }, { type: 'addConnection', connection: { id: 'scored', source: 'profile-b', target: 'score-b', label: 'scored' } }]);
    assert.equal(added.action.status, 'completed', 'a new block and its link land');
    for (const operation of [{ type: 'updateNode', id: 'profile-a', patch: { description: 'Rewritten.' } }, { type: 'updateNode', id: 'cv-a', patch: { title: 'Renamed', x: 24 } }, { type: 'removeNode', id: 'cv-b' }, { type: 'removeConnection', id: 'scored' }] satisfies Mutation[]) {
      const { action } = await f.propose([], [operation]);
      assert.equal(action.status, 'pending', JSON.stringify(operation));
    }
    // A change that edits waits whole, the moves in it too.
    const mixed = await f.propose([], [into('cv-a', 'group-b'), { type: 'updateNode', id: 'profile-b', patch: { title: 'Renamed' } }]);
    assert.equal(mixed.action.status, 'pending');
    assert.equal(f.parentOf('cv-a'), 'group-a');
  } finally { await f.close(); }
});

test('Ask every time, a block set to ask and a stopped project keep every change waiting', async () => {
  const f = fixture();
  try {
    f.mode('ask');
    assert.equal((await f.propose([], [into('cv-a', 'group-a')])).action.status, 'pending');
    assert.equal((await f.propose([], [{ type: 'addNode', node: { id: 'note', title: 'Note', description: '', kind: 'topic', x: 0, y: 1440 } }])).action.status, 'pending');
    // With full access, a group set to Ask every time still has its say over blocks moved in or out and blocks added to it.
    f.mode('full');
    f.authority.override(f.project.id, 'group-b', 'ask');
    assert.equal((await f.propose([], [into('cv-b', 'group-b')])).action.status, 'pending');
    assert.equal((await f.propose([], [{ type: 'updateNode', id: 'profile-b', patch: { parentId: null, x: 0, y: 1920 } }])).action.status, 'pending');
    assert.equal((await f.propose([], [{ type: 'removeNode', id: 'group-b' }])).action.status, 'pending');
    assert.equal((await f.propose([], [into('cv-a', 'group-a')])).action.status, 'completed', 'the rest of the canvas follows the project');
    f.authority.override(f.project.id, 'group-b', null);
    // A block inside a group set to ask keeps the group from being removed unasked.
    f.authority.override(f.project.id, 'profile-b', 'ask');
    assert.equal((await f.propose([], [{ type: 'removeNode', id: 'group-b' }])).action.status, 'pending');
    f.authority.setStopped(f.project.id, true);
    const proposal = f.execution.assistantProposal(f.project.id, 'Move a CV', [into('cv-b', 'group-b')]);
    assert.equal(proposal.status, 'pending');
  } finally { await f.close(); }
});

test('A Browser block waits in Approve for me and opens at once with full access', async () => {
  const f = fixture();
  try {
    const browser = (id: string): Mutation[] => [{ type: 'addNode', node: { id, title: 'Browser: look at a page', description: 'Starts at example.org', kind: 'topic', blockType: 'note', label: 'browser', x: 0, y: 1440 } }];
    f.mode('review');
    assert.equal(f.execution.assistantProposal(f.project.id, 'Open a browser', browser('browser-a'), false, {}, true).status, 'pending');
    assert.equal(f.execution.assistantProposal(f.project.id, 'Add a note', browser('note-a')).status, 'accepted', 'the same block without a browser is a plain addition');
    f.mode('full');
    assert.equal(f.execution.assistantProposal(f.project.id, 'Open a browser', browser('browser-b'), false, {}, true).status, 'accepted');
  } finally { await f.close(); }
});

test('A change that only moves, resizes or regroups a block arranges it; anything else edits it', () => {
  const canvas: Canvas = { nodes: [{ id: 'cv', title: 'CV', description: 'PDF', kind: 'topic', x: 0, y: 0 }], connections: [{ id: 'link', source: 'cv', target: 'cv', label: 'self' }] };
  const update = (patch: Extract<Mutation, { type: 'updateNode' }>['patch']): Mutation => ({ type: 'updateNode', id: 'cv', patch });
  assert.equal(canvasChange(update({ x: 24, y: 48, width: 480, height: null, parentId: 'group' }), canvas), 'arrange');
  assert.equal(canvasChange(update({ parentId: null, title: 'CV', description: 'PDF', kind: 'topic' }), canvas), 'arrange', 'unchanged fields change nothing');
  assert.equal(canvasChange(update({ title: 'Candidate CV', x: 24 }), canvas), 'edit');
  assert.equal(canvasChange(update({ label: 'task' }), canvas), 'edit');
  assert.equal(canvasChange({ type: 'addNode', node: { id: 'new', title: 'New', description: '', x: 0, y: 0 } }, canvas), 'add');
  assert.equal(canvasChange({ type: 'addConnection', connection: { id: 'more', source: 'cv', target: 'cv', label: 'again' } }, canvas), 'add');
  assert.equal(canvasChange({ type: 'removeConnection', id: 'link' }, canvas), 'remove');
  assert.equal(canvasChange({ type: 'removeNode', id: 'cv' }, canvas), 'remove');
});

test('A new block goes into an unselected group under the approval mode, and a block that is not there is named', async () => {
  const f = fixture();
  try {
    const { action } = await f.propose(['group-b'], [{ type: 'addNode', node: { id: 'score-a', title: 'Score', description: 'Strong writer.', kind: 'topic', parentId: 'group-a', x: 0, y: 480 } }]);
    assert.equal(action.status, 'completed', 'with full access an addition is accepted at once');
    assert.equal(f.store.getProject(f.project.id).canvas.nodes.find(node => node.id === 'score-a')?.parentId, 'group-a');
    await assert.rejects(f.propose([], [into('cv-a', 'group-c')]), /There is no block group-c on this canvas\. Call ros_read_canvas/u);
    await assert.rejects(f.propose([], [into('cv-c', 'group-a')]), /There is no block cv-c on this canvas/u);
    await assert.rejects(f.propose([], [{ type: 'removeNode', id: 'gone' }]), /There is no block gone on this canvas/u);
  } finally { await f.close(); }
});

test('Removing a group with blocks inside waits for the person in Approve for me, whatever is selected', async () => {
  const f = fixture();
  try {
    f.mode('review');
    const { action } = await f.propose(['cv-a'], [{ type: 'removeNode', id: 'group-b' }]);
    assert.equal(f.proposal(action.proposalId).status, 'pending');
    assert(f.store.getProject(f.project.id).canvas.nodes.some(node => node.id === 'profile-b'));
  } finally { await f.close(); }
});

test('Selected evidence still bounds reuse: a block outside the selection is refused there', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.agent(['group-a']).call('ros_propose_reuse', { artifactId: 'any', targetNodeId: 'group-b', reason: 'Use it here.' }), /outside the explicit captured block selection/u);
  } finally { await f.close(); }
});

test('A group opens when it first appears or is proposed; a Set aside group stays folded', () => {
  const group = (id: string, title = 'Candidate', description = '') => ({ id, title, description, kind: 'group' as const, x: 0, y: 0 });
  const aside = group('aside', SET_ASIDE.title, `${SET_ASIDE.description}\n\n- **A result:** Off topic.`);
  const canvas: Canvas = { nodes: [group('known'), group('new'), aside, { id: 'note', title: 'Note', description: '', kind: 'topic', x: 0, y: 0 }], connections: [] };
  assert.deepEqual(arrivedGroups(new Set(['known']), canvas), ['new']);
  // A group someone named Set aside with an overview of their own is an ordinary group.
  assert.deepEqual(arrivedGroups(new Set(['known', 'new']), { ...canvas, nodes: [...canvas.nodes, group('mine', SET_ASIDE.title, 'Things for later')] }), ['mine']);
  assert.deepEqual(proposedGroups([{ type: 'addNode', node: group('proposed') }, { type: 'addNode', node: aside }, { type: 'addNode', node: { id: 'cv', title: 'CV', description: '', kind: 'topic', x: 0, y: 0 } }, { type: 'updateNode', id: 'known', patch: { width: 760 } }]), ['proposed']);
});
