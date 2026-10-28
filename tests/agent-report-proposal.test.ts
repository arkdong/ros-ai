import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { Authority } from '../src/server/authority.js';
import { AgentWorkspaceTools, citeByTitle, decideAgentReport } from '../src/server/agent-tools.js';
import type { ApprovalMode } from '../src/shared/research.js';

// Nothing selected, one Finding on the canvas: the "write a short report" turn of the hackathon video.
function fixture(mode: ApprovalMode) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-agent-report-'));
  const store = new Store(join(dir, 'store')), execution = new ExecutionService(store, { includeSetupUsage: false });
  const project = store.createProject('Agents');
  store.mutate(project.id, [{ type: 'addNode', node: { id: 'finding-1', title: 'Agents lose context between vendors', description: '', kind: 'topic', blockType: 'note', x: 0, y: 0 } }], 'A finding');
  new Authority(store).configure(project.id, { mode });
  const experiments = { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService;
  const agent = new AgentWorkspaceTools(store, execution, experiments, { projectId: project.id, nodeIds: [], artifactIds: [] }, 'turn-report', 'model');
  const nodes = () => store.getProject(project.id).canvas.nodes;
  const propose = (report: Record<string, unknown>) => agent.call('ros_propose_report', report) as Promise<{ action: { nodeId: string; reportProposalId: string; status: string }; committed: boolean }>;
  return { store, project, agent, nodes, propose, async close() { await execution.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const report = { title: 'What goes wrong', text: '# What goes wrong\n\nAgents lose context 【finding-1】 and nobody sees the whole picture 【7db6b2ae-1234-4abc-8def-1234567890ab】.', evidenceIds: [], rationale: 'From the finding.' };

test('Approve for me, nothing selected: ros.ai adds the report block at once, and the report is accepted even after the canvas moved on', async () => {
  const f = fixture('review');
  try {
    const proposed = await f.propose(report);
    const block = f.nodes().find(node => node.id === proposed.action.nodeId);
    assert.equal(block?.blockType, 'report');
    assert.equal(block?.title, 'What goes wrong');
    assert.ok(block!.x > 0, 'placed clear of the finding');
    assert.equal(proposed.action.status, 'pending');
    // A block dragged after the proposal does not stand in the way of the Accept.
    f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'finding-1', patch: { x: 10, y: 10 } }], 'Move the finding');
    const decided = decideAgentReport(f.store, f.project.id, proposed.action.reportProposalId, 'accept');
    assert.equal(decided.status, 'accepted');
    assert.equal(f.nodes().find(node => node.id === proposed.action.nodeId)?.artifactId, decided.resultArtifactId);
    const saved = f.store.getArtifact(decided.resultArtifactId!);
    assert.ok(saved.content.includes('Agents lose context (Agents lose context between vendors)'), saved.content);
    assert.ok(!saved.content.includes('【') && !saved.content.includes('7db6b2ae'), saved.content);
  } finally { await f.close(); }
});

test('an id that names no block gets a report block too', async () => {
  const f = fixture('full');
  try {
    const proposed = await f.propose({ ...report, nodeId: 'report-that-does-not-exist' });
    assert.notEqual(proposed.action.nodeId, 'report-that-does-not-exist');
    assert.equal(f.nodes().find(node => node.id === proposed.action.nodeId)?.blockType, 'report');
    assert.equal(decideAgentReport(f.store, f.project.id, proposed.action.reportProposalId, 'accept').status, 'accepted');
  } finally { await f.close(); }
});

test('Ask every time: the report block waits, the report says so on Accept, and lands once the block is accepted', async () => {
  const f = fixture('ask');
  try {
    const proposed = await f.propose(report);
    assert.equal(f.nodes().some(node => node.id === proposed.action.nodeId), false, 'the block waits');
    assert.throws(() => decideAgentReport(f.store, f.project.id, proposed.action.reportProposalId, 'accept'), /accept the change that adds it first/u);
    const waiting = f.store.detail(f.project.id).proposals.find(item => item.status === 'pending')!;
    f.store.acceptProposal(f.project.id, waiting.id);
    assert.equal(decideAgentReport(f.store, f.project.id, proposed.action.reportProposalId, 'accept').status, 'accepted');
    assert.ok(f.nodes().find(node => node.id === proposed.action.nodeId)?.artifactId);
  } finally { await f.close(); }
});

test('Ask every time: a report on a block this turn added by hand still waits for that block', async () => {
  const f = fixture('ask');
  try {
    const added = await f.agent.call('ros_propose_canvas', { summary: 'Add a report block', rationale: 'Nothing is selected.', operations: [{ type: 'addNode', node: { id: 'report-1', title: 'Report', description: '', kind: 'topic', blockType: 'report', x: 400, y: 0 } }] }) as { committed: boolean };
    assert.equal(added.committed, false);
    await assert.rejects(f.propose({ ...report, nodeId: 'report-1' }), /waits for the person's Accept/u);
  } finally { await f.close(); }
});

test('a report accepted into a block that got its own report meanwhile is refused', async () => {
  const f = fixture('review');
  try {
    const first = await f.propose(report);
    const other = await f.propose({ ...report, title: 'Another', nodeId: first.action.nodeId });
    assert.equal(other.action.nodeId, first.action.nodeId);
    decideAgentReport(f.store, f.project.id, other.action.reportProposalId, 'accept');
    assert.throws(() => decideAgentReport(f.store, f.project.id, first.action.reportProposalId, 'accept'), /newer report version/u);
  } finally { await f.close(); }
});

test('citeByTitle names the blocks and drops ids that are no block, in reports and in answers', () => {
  const nodes = [{ id: 'a', title: 'Alpha' }, { id: 'main-findings-note', title: 'Main findings' }];
  assert.equal(citeByTitle('Seen 【a, main-findings-note】 and 【a】.', nodes), 'Seen (Alpha, Main findings) and (Alpha).');
  assert.equal(citeByTitle('Gone 【7db6b2ae-1234-4abc-8def-1234567890ab】, kept 【the CBS table】.', nodes), 'Gone, kept (the CBS table).');
});
