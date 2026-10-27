import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import type { RemoteApps } from '../src/server/remote-apps.js';
import { ProjectFolders } from '../src/server/project-folders.js';
import { NotionFileSaver } from '../src/server/notion-files.js';

// A stand-in for Notion's hosted MCP server: one applicant page with a CV in a Files column.
const CV_URL = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file-1/Jane-Doe-CV.pdf?X-Amz-Signature=abc';
const PDF = Buffer.from('%PDF-1.4\n% stand-in CV\n%%EOF\n');
const page = JSON.stringify({ metadata: { type: 'page' }, title: 'Jane Doe', url: 'https://app.notion.com/p/3f0122069fec813999fbe0bd1235f178',
  text: `<page url="https://app.notion.com/p/3f0122069fec813999fbe0bd1235f178">\n<properties>\n${JSON.stringify({ Name: 'Jane Doe', CV: [CV_URL] })}\n</properties>\n<content>\n</content>\n</page>` });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-turn-review-'));
  const store = new Store(join(dir, 'store'));
  const folders = new ProjectFolders(store, { reserved: [join(dir, 'store')] });
  const apps = {
    connected: () => ['notion'],
    tools: async () => [{ name: 'notion-fetch', description: 'Fetch', inputSchema: {}, reads: true }],
    call: async (_id: string, tool: string) => tool === 'notion-fetch' ? { text: page, isError: false } : { text: 'unexpected', isError: true },
  } as unknown as RemoteApps;
  const saver = new NotionFileSaver(apps, { fetcher: (async () => new Response(PDF, { status: 200 })) as typeof fetch, lookup: async () => [{ address: '52.92.1.1' }] });
  AgentWorkspaceTools.apps = apps; AgentWorkspaceTools.notionFiles = saver; AgentWorkspaceTools.folders = folders;
  const project = store.createProject('Recruitment');
  folders.attach(project.id, join(dir, 'Recruitment'));
  folders.shutdown();
  const agent = new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3], arranged?: boolean, links?: Parameters<Store['createProposal']>[5]) => store.createProposal(id, store.getProject(id).revision, summary, operations, arranged, links) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId: project.id, nodeIds: [], artifactIds: [] }, 'turn-review', 'claude');
  return { store, project, agent, close: () => { AgentWorkspaceTools.apps = undefined; AgentWorkspaceTools.notionFiles = undefined; AgentWorkspaceTools.folders = undefined; folders.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const layout = { summary: 'Lay out the applicants', rationale: 'One group per candidate.', operations: [
  { type: 'addNode', node: { id: 'jane', title: 'Jane Doe', description: '', kind: 'group', x: 0, y: 0 } },
  { type: 'addNode', node: { id: 'profile', title: 'Profile and answers', description: 'Q1…', kind: 'topic', blockType: 'note', parentId: 'jane', x: 0, y: 0 } }] };

test('A CV can go inside a group from another change of the turn that still waits, and is accepted after it', async () => {
  const f = fixture();
  try {
    const layoutResult = await f.agent.call('ros_propose_canvas', layout) as { action: { proposalId: string } };
    const saved = await f.agent.call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: 'https://app.notion.com/p/3f0122069fec813999fbe0bd1235f178', property: 'CV', parentId: 'jane' }, summary: 'Save Jane’s CV', rationale: 'To read it.' }) as { action: { proposalId: string }; committed: boolean };
    assert.equal(saved.committed, false);
    assert.notEqual(saved.action.proposalId, layoutResult.action.proposalId);
    assert.equal(f.agent.actions.length, 2);
    const cvProposal = f.store.detail(f.project.id).proposals.find(p => p.id === saved.action.proposalId)!;
    assert.deepEqual(cvProposal.after, [layoutResult.action.proposalId]);
    assert.equal(cvProposal.batch, 'turn-review');
    const cv = cvProposal.operations.find(op => op.type === 'addNode');
    assert(cv?.type === 'addNode' && cv.node.parentId === 'jane' && cv.node.blockType === 'file');

    const second = await f.agent.call('ros_propose_canvas', { summary: 'Add a portfolio note', rationale: 'Context.', operations: [{ type: 'addNode', node: { id: 'cv-2', title: 'Portfolio', description: '', kind: 'topic', blockType: 'note', parentId: 'jane', x: 0, y: 600 } }] }) as { action: { proposalId: string } };
    // The CV waits for its group.
    assert.throws(() => f.store.acceptProposal(f.project.id, cvProposal.id), /has to be accepted first/u);
    f.store.acceptProposal(f.project.id, layoutResult.action.proposalId);
    // Accepting the layout moved the canvas on; the CV change was moved with it, so it is still acceptable.
    const revision = f.store.getProject(f.project.id).revision;
    assert.equal(f.store.detail(f.project.id).proposals.find(p => p.id === cvProposal.id)!.baseRevision, revision);
    // A second change inside the group stays acceptable after the first is accepted too.
    f.store.acceptProposal(f.project.id, cvProposal.id);
    f.store.acceptProposal(f.project.id, second.action.proposalId);
    const nodes = f.store.getProject(f.project.id).canvas.nodes;
    assert.equal(nodes.find(node => node.blockType === 'file')?.parentId, 'jane');

    // Once accepted, later changes in the turn build on those blocks directly.
    const next = await f.agent.call('ros_propose_canvas', { summary: 'Add a note', rationale: 'Later.', operations: [{ type: 'addNode', node: { id: 'later', title: 'Shortlist', description: '', kind: 'topic', blockType: 'note', parentId: 'jane', x: 0, y: 400 } }] }) as { action: { proposalId: string } };
    assert.equal(f.store.detail(f.project.id).proposals.find(p => p.id === next.action.proposalId)!.after, undefined);
  } finally { f.close(); }
});

test('Dismissing a change dismisses the changes that build on it; other changes of the turn stay acceptable', async () => {
  const f = fixture();
  try {
    const layoutResult = await f.agent.call('ros_propose_canvas', layout) as { action: { proposalId: string } };
    const inside = await f.agent.call('ros_propose_canvas', { summary: 'Add a CV note', rationale: 'Context.', operations: [{ type: 'addNode', node: { id: 'cv-note', title: 'CV notes', description: '', kind: 'topic', blockType: 'note', parentId: 'jane', x: 0, y: 300 } }] }) as { action: { proposalId: string } };
    const questions = await f.agent.call('ros_propose_canvas', { summary: 'Add the questions', rationale: 'Context.', operations: [{ type: 'addNode', node: { id: 'questions', title: 'Your three questions', description: 'Q1 Q2 Q3', kind: 'topic', blockType: 'note', x: 600, y: 0 } }] }) as { action: { proposalId: string } };
    f.store.dismissProposal(f.project.id, layoutResult.action.proposalId);
    const status = (id: string) => f.store.proposalStatus(f.project.id, id);
    assert.equal(status(inside.action.proposalId), 'dismissed');
    assert.equal(status(questions.action.proposalId), 'pending');
    f.store.acceptProposal(f.project.id, questions.action.proposalId);
    assert.deepEqual(f.store.getProject(f.project.id).canvas.nodes.map(node => node.id), ['questions']);
  } finally { f.close(); }
});
