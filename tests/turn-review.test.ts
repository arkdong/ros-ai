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
  const agent = new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId: project.id, nodeIds: [], artifactIds: [] }, 'turn-review', 'claude');
  return { store, project, agent, close: () => { AgentWorkspaceTools.apps = undefined; AgentWorkspaceTools.notionFiles = undefined; AgentWorkspaceTools.folders = undefined; folders.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const layout = { summary: 'Lay out the applicants', rationale: 'One group per candidate.', operations: [
  { type: 'addNode', node: { id: 'jane', title: 'Jane Doe', description: '', kind: 'group', x: 0, y: 0 } },
  { type: 'addNode', node: { id: 'profile', title: 'Profile and answers', description: 'Q1…', kind: 'topic', blockType: 'note', parentId: 'jane', x: 0, y: 0 } }] };

test('A turn’s changes wait as one, and a CV goes inside a group proposed earlier in the turn', async () => {
  const f = fixture();
  try {
    const first = await f.agent.call('ros_propose_canvas', layout) as { action: { id: string; proposalId: string } };
    const saved = await f.agent.call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: 'https://app.notion.com/p/3f0122069fec813999fbe0bd1235f178', property: 'CV', parentId: 'jane' }, summary: 'Save Jane’s CV', rationale: 'To read it.' }) as { action: { id: string; proposalId: string }; committed: boolean };
    assert.equal(saved.committed, false);
    assert.equal(saved.action.proposalId, first.action.proposalId);
    assert.equal(saved.action.id, first.action.id);
    assert.equal(f.agent.actions.length, 1);
    const proposals = f.store.detail(f.project.id).proposals;
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].summary, /^Lay out the applicants\n[\s\S]*\nAlso: Save Jane’s CV$/u);
    const cv = proposals[0].operations.find(op => op.type === 'addNode' && op.node.blockType === 'file');
    assert(cv?.type === 'addNode' && cv.node.parentId === 'jane');

    f.store.acceptProposal(f.project.id, proposals[0].id);
    const nodes = f.store.getProject(f.project.id).canvas.nodes;
    assert.equal(nodes.find(node => node.blockType === 'file')?.parentId, 'jane');
    assert.equal(nodes.find(node => node.id === 'profile')?.parentId, 'jane');

    // Once the person decided, the next change in the turn starts a new one and may build on the accepted blocks.
    const next = await f.agent.call('ros_propose_canvas', { summary: 'Add a note', rationale: 'Later.', operations: [{ type: 'addNode', node: { id: 'later', title: 'Shortlist', description: '', kind: 'topic', blockType: 'note', parentId: 'jane', x: 0, y: 400 } }] }) as { action: { proposalId: string } };
    assert.notEqual(next.action.proposalId, first.action.proposalId);
  } finally { f.close(); }
});

test('Unticked blocks are left out of a change before it is accepted, with what is inside them', async () => {
  const f = fixture();
  try {
    await f.agent.call('ros_propose_canvas', layout);
    await f.agent.call('ros_propose_canvas', { summary: 'Add the questions', rationale: 'Context.', operations: [{ type: 'addNode', node: { id: 'questions', title: 'Your three questions', description: 'Q1 Q2 Q3', kind: 'topic', blockType: 'note', x: 600, y: 0 } }] });
    const [proposal] = f.store.detail(f.project.id).proposals;
    const narrowed = f.store.narrowProposal(f.project.id, proposal.id, ['jane']);
    assert.deepEqual(narrowed.operations.flatMap(op => op.type === 'addNode' ? [op.node.id] : []), ['questions']);
    f.store.acceptProposal(f.project.id, proposal.id);
    assert.deepEqual(f.store.getProject(f.project.id).canvas.nodes.map(node => node.id), ['questions']);

    await f.agent.call('ros_propose_canvas', { ...layout, operations: [{ type: 'addNode', node: { id: 'solo', title: 'Solo', description: '', kind: 'topic', blockType: 'note', x: 0, y: 600 } }] });
    const last = f.store.detail(f.project.id).proposals.at(-1)!;
    assert.equal(f.store.narrowProposal(f.project.id, last.id, ['solo']).status, 'dismissed');
  } finally { f.close(); }
});
