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
  return { store, project, agent, async close() { await execution.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const addReport = { summary: 'Add a report block', rationale: 'Nothing is selected.', operations: [{ type: 'addNode', node: { id: 'report-1', title: 'Report', description: '', kind: 'topic', blockType: 'report', x: 400, y: 0 } }] };
const report = { nodeId: 'report-1', title: 'What goes wrong', text: '# What goes wrong\n\nAgents lose context 【finding-1】 and nobody sees the whole picture 【7db6b2ae-1234-4abc-8def-1234567890ab】.', evidenceIds: [], rationale: 'From the finding.' };

test('Approve for me: the report block lands at once and the report proposed on it is accepted, even after the canvas moved on', async () => {
  const f = fixture('review');
  try {
    const added = await f.agent.call('ros_propose_canvas', addReport) as { committed: boolean };
    assert.equal(added.committed, true);
    const proposed = await f.agent.call('ros_propose_report', report) as { action: { reportProposalId: string } };
    // A block dragged after the proposal does not stand in the way of the Accept.
    f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'finding-1', patch: { x: 10, y: 10 } }], 'Move the finding');
    const decided = decideAgentReport(f.store, f.project.id, proposed.action.reportProposalId, 'accept');
    assert.equal(decided.status, 'accepted');
    const node = f.store.getProject(f.project.id).canvas.nodes.find(item => item.id === 'report-1');
    assert.equal(node?.artifactId, decided.resultArtifactId);
    const saved = f.store.getArtifact(decided.resultArtifactId!);
    assert.ok(saved.content.includes('Agents lose context (Agents lose context between vendors)'), saved.content);
    assert.ok(!saved.content.includes('【') && !saved.content.includes('7db6b2ae'), saved.content);
  } finally { await f.close(); }
});

test('Ask every time: the report cannot build on the block that still waits, and the tool says so', async () => {
  const f = fixture('ask');
  try {
    const added = await f.agent.call('ros_propose_canvas', addReport) as { committed: boolean };
    assert.equal(added.committed, false);
    await assert.rejects(f.agent.call('ros_propose_report', report), /waits for the person's Accept/u);
  } finally { await f.close(); }
});

test('a report accepted into a block that got its own report meanwhile is refused', async () => {
  const f = fixture('review');
  try {
    await f.agent.call('ros_propose_canvas', addReport);
    const proposed = await f.agent.call('ros_propose_report', report) as { action: { reportProposalId: string } };
    const other = await f.agent.call('ros_propose_report', { ...report, title: 'Another' }) as { action: { reportProposalId: string } };
    decideAgentReport(f.store, f.project.id, other.action.reportProposalId, 'accept');
    assert.throws(() => decideAgentReport(f.store, f.project.id, proposed.action.reportProposalId, 'accept'), /newer report version/u);
  } finally { await f.close(); }
});

test('citeByTitle names the blocks and drops ids that are no block', () => {
  const nodes = [{ id: 'a', title: 'Alpha' }, { id: 'main-findings-note', title: 'Main findings' }];
  assert.equal(citeByTitle('Seen 【a, main-findings-note】 and 【a】.', nodes), 'Seen (Alpha, Main findings) and (Alpha).');
  assert.equal(citeByTitle('Gone 【7db6b2ae-1234-4abc-8def-1234567890ab】, kept 【the CBS table】.', nodes), 'Gone, kept (the CBS table).');
});
