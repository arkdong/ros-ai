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
  // Full access: what may be accepted without asking is.
  new Authority(store).configure(project.id, { mode: 'full' });
  const experiments = { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService;
  const agent = (nodeIds: string[]) => new AgentWorkspaceTools(store, execution, experiments, { projectId: project.id, nodeIds, artifactIds: [] }, `turn-${Math.random()}`, 'claude');
  const propose = (nodeIds: string[], operations: Mutation[]) => agent(nodeIds).call('ros_propose_canvas', { summary: 'Put each CV in its group', rationale: 'The person asked.', operations }) as Promise<{ action: { proposalId: string; status: string } }>;
  const proposal = (id: string) => store.detail(project.id).proposals.find(item => item.id === id)!;
  return { store, project, propose, proposal, agent, async close() { await execution.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const into = (id: string, parentId: string): Mutation => ({ type: 'updateNode', id, patch: { parentId, x: 0, y: 480 } });

test('Ros moves blocks into any group on the canvas, whatever is selected, and the move waits for the person', async () => {
  const f = fixture();
  try {
    // Nothing selected, one other group selected, or the block's own group selected: each is the same proposal.
    for (const selected of [[], ['group-b'], ['group-a']]) {
      const { action } = await f.propose(selected, [into('cv-a', 'group-a'), into('cv-b', 'group-b')]);
      assert.equal(action.status, 'pending', `selected: ${selected.join(', ') || 'nothing'}`);
      assert.equal(f.proposal(action.proposalId).status, 'pending', 'a change to blocks already there is never accepted without the person, even with full access');
    }
    const { action } = await f.propose([], [into('cv-a', 'group-a'), into('cv-b', 'group-b')]);
    f.store.acceptProposal(f.project.id, action.proposalId);
    const nodes = f.store.getProject(f.project.id).canvas.nodes;
    assert.deepEqual(['cv-a', 'cv-b'].map(id => nodes.find(node => node.id === id)?.parentId), ['group-a', 'group-b']);
  } finally { await f.close(); }
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

test('Removing a group with blocks inside waits for the person, whatever is selected', async () => {
  const f = fixture();
  try {
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
