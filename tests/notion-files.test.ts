import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import type { RemoteApps } from '../src/server/remote-apps.js';
import { ProjectFolders } from '../src/server/project-folders.js';
import { NotionFileSaver, notionFileHost, signedUrls } from '../src/server/notion-files.js';

// A stand-in for Notion's hosted MCP server and its file storage: one applicant page with a CV in a Files column,
// a portfolio image in its content and an outside link.
const CV_URL = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file-1/Jane-Doe-CV.pdf?X-Amz-Expires=300&X-Amz-Signature=abc#notion_record=block.page';
const DOCX_URL = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file-2/Letter.docx?X-Amz-Signature=abc';
const IMAGE_REF = 'notion-file-block://11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000?space_id=abc&name=portfolio.png';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.4\n% stand-in CV\n%%EOF\n');
const page = (properties: Record<string, unknown>) => JSON.stringify({ metadata: { type: 'page' }, title: 'Jane Doe', url: 'https://app.notion.com/p/3f0122069fec813999fbe0bd1235f178?pvs=204',
  text: `<page url="https://app.notion.com/p/3f0122069fec813999fbe0bd1235f178">\n<properties>\n${JSON.stringify(properties)}\n</properties>\n<content>\n<image source="${IMAGE_REF}"></image>\n</content>\n</page>` });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-notion-files-'));
  const store = new Store(join(dir, 'store'));
  const folders = new ProjectFolders(store, { reserved: [join(dir, 'store')] });
  const calls: { tool: string; args: Record<string, unknown> }[] = [], fetched: string[] = [];
  let properties: Record<string, unknown> = { Name: 'Jane Doe', CV: [CV_URL], Letter: [DOCX_URL], Portfolio: 'https://example.com', Empty: [], Elsewhere: ['https://evil.example/cv.pdf'] };
  const apps = {
    connected: () => ['notion'],
    agentApps: () => [{ name: 'notion', app: 'notion', label: 'Notion' }],
    agentApp: (name: string) => name === 'notion' ? { name: 'notion', app: 'notion', label: 'Notion' } : undefined,
    tools: async () => [{ name: 'notion-fetch', description: 'Fetch', inputSchema: {}, reads: true }, { name: 'notion-update-page', description: 'Update', inputSchema: {}, reads: false }],
    call: async (_id: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (tool === 'notion-fetch') return { text: page(properties), isError: false };
      if (tool === 'notion-get-file-download-urls') return { text: JSON.stringify({ files: (args.references as string[]).map(reference => ({ reference, url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file-3/portfolio.png?X-Amz-Signature=def' })), unresolved: [] }), isError: false };
      return { text: 'unexpected', isError: true };
    },
  } as unknown as RemoteApps;
  const fetcher = (async (input: string | URL) => {
    const url = String(input); fetched.push(url);
    if (url.includes('Jane-Doe-CV.pdf')) return new Response(PDF, { status: 200 });
    if (url.includes('portfolio.png')) return new Response(PNG, { status: 200 });
    if (url.includes('Letter.docx')) return new Response(Buffer.from('PK\x03\x04 docx'), { status: 200 });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const saver = new NotionFileSaver(apps, { fetcher, lookup: async () => [{ address: '52.92.1.1' }] });
  return { dir, store, folders, apps, saver, calls, fetched, setProperties: (next: Record<string, unknown>) => { properties = next; }, close: () => { folders.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const toolkit = (store: Store, projectId: string, nodeIds: string[] = []) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds, artifactIds: [] }, 'turn-notion-files', 'claude');

test('Only Notion’s own file storage is fetched', () => {
  assert(notionFileHost(new URL(CV_URL)));
  assert(notionFileHost(new URL('https://s3.us-west-2.amazonaws.com/secure.notion-static.com/x/cv.pdf')));
  assert(notionFileHost(new URL('https://file.notion.so/f/x/cv.pdf')));
  assert(!notionFileHost(new URL('https://s3.us-west-2.amazonaws.com/someone-else/cv.pdf')));
  assert(!notionFileHost(new URL('http://prod-files-secure.s3.us-west-2.amazonaws.com/x.pdf')));
  assert(!notionFileHost(new URL('https://notion.so.evil.example/x.pdf')));
  assert.deepEqual([...signedUrls({ files: [{ reference: 'notion-file-block://a', url: 'https://x/a' }] }, ['notion-file-block://a'])], [['notion-file-block://a', 'https://x/a']]);
  assert.deepEqual([...signedUrls({ 'notion-file-block://a': 'https://x/a' }, ['notion-file-block://a'])], [['notion-file-block://a', 'https://x/a']]);
});

test('Agents save a CV from a Notion Files column into the project folder as a File block, read only in Notion', async () => {
  const f = fixture();
  AgentWorkspaceTools.apps = f.apps; AgentWorkspaceTools.notionFiles = f.saver; AgentWorkspaceTools.folders = f.folders;
  try {
    const project = f.store.createProject('Recruitment');
    f.folders.attach(project.id, join(f.dir, 'Recruitment'));
    f.folders.shutdown();
    const group = f.store.mutate(project.id, [{ type: 'addNode', node: { id: 'jane', title: 'Jane Doe', description: '', kind: 'group', x: 0, y: 0 } }, { type: 'addNode', node: { id: 'row', title: 'Jane in Notion', description: '', kind: 'topic', blockType: 'note', parentId: 'jane', x: 0, y: 0 } }], 'Candidate group');
    assert(group);
    const agent = toolkit(f.store, project.id, ['jane']);
    assert.match(agent.definitions.find(tool => tool.name === 'ros_app_call')!.description, /call ros-save-file/u);
    const listing = await agent.call('ros_app_tools', { app: 'notion' }) as { tools: { name: string; summary: string; approval: string }[] };
    assert.deepEqual(listing.tools.at(-1), { name: 'ros-save-file', summary: listing.tools.at(-1)!.summary, approval: 'adds blocks under the project approval mode' });

    const saved = await agent.call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: 'https://app.notion.com/p/3f0122069fec813999fbe0bd1235f178', property: 'CV', parentId: 'jane' }, summary: 'Save Jane’s CV', rationale: 'To read it for the assessment.' }) as { action: { proposalId: string }; committed: boolean; saved: { id: string; file: string }[]; instruction: string };
    assert.equal(saved.committed, false);
    assert.match(saved.instruction, /wait for the person to accept/u);
    assert.deepEqual(saved.saved.map(item => item.file), ['files/Jane Doe - Jane-Doe-CV.pdf']);
    assert.deepEqual(readFileSync(join(f.dir, 'Recruitment', 'files', 'Jane Doe - Jane-Doe-CV.pdf')), PDF);
    // Only Notion's read tool ran; nothing was written there.
    assert.deepEqual(f.calls.map(call => call.tool), ['notion-fetch']);
    f.store.acceptProposal(project.id, saved.action.proposalId);
    const node = f.store.getProject(project.id).canvas.nodes.find(item => item.id === saved.saved[0].id)!;
    assert.deepEqual([node.blockType, node.file, node.parentId], ['file', { path: 'files/Jane Doe - Jane-Doe-CV.pdf' }, 'jane']);
    assert.match(node.description, /^PDF saved from Notion: CV on \[Jane Doe\]\(https:\/\/app\.notion\.com\/p\/3f0122069fec813999fbe0bd1235f178\), file Jane-Doe-CV\.pdf\./u);

    // The same CV is not saved twice.
    const again = await toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'CV' }, summary: 'Save it again', rationale: 'Because.' }) as { saved: unknown[]; existing: { id: string }[] };
    assert.deepEqual([again.saved, again.existing.map(item => item.id)], [[], [node.id]]);
    assert.equal(readdirSync(join(f.dir, 'Recruitment', 'files')).length, 1);

    // A file in the page's content, by its reference: Notion gives a fresh link for it.
    const image = await toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', references: [IMAGE_REF] }, summary: 'Save the portfolio', rationale: 'Because.' }) as { saved: { file: string }[] };
    assert.deepEqual(image.saved.map(item => item.file), ['files/Jane Doe - portfolio.png']);
    assert.deepEqual(f.calls.at(-1), { tool: 'notion-get-file-download-urls', args: { references: [IMAGE_REF] } });

    // What cannot be saved says why, and nothing is fetched from outside Notion's storage.
    const docx = await toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'Letter' }, summary: 'Save the letter', rationale: 'Because.' }) as { saved: unknown[]; problems: string[] };
    assert.match(docx.problems[0], /Letter\.docx is not a PDF, PNG or JPEG/u);
    const outside = await toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'Elsewhere' }, summary: 'Save it', rationale: 'Because.' }) as { problems: string[] };
    assert.match(outside.problems[0], /evil\.example is not Notion's file storage/u);
    assert(!f.fetched.some(url => url.includes('evil.example')));
    const empty = await toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'Empty' }, summary: 'Save it', rationale: 'Because.' }) as { problems: string[] };
    assert.match(empty.problems[0], /Empty is empty on Jane Doe/u);
    await assert.rejects(toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'Resume' }, summary: 'Save it', rationale: 'Because.' }), /has no column called Resume\. Its columns with files: CV, Letter/u);
    await assert.rejects(toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'CV', parentId: 'elsewhere' }, summary: 'Save it', rationale: 'Because.' }), /There is no block elsewhere on this canvas/u);
    // Any group on the canvas can take the file, selected or not; a block that is not a group cannot.
    await assert.rejects(toolkit(f.store, project.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'CV', parentId: 'row' }, summary: 'Save it', rationale: 'Because.' }), /parentId must be a group/u);

    // Without a project folder there is nowhere to save it.
    const bare = f.store.createProject('No folder');
    await assert.rejects(toolkit(f.store, bare.id).call('ros_app_call', { app: 'notion', tool: 'ros-save-file', arguments: { page: '3f0122069fec813999fbe0bd1235f178', property: 'CV' }, summary: 'Save it', rationale: 'Because.' }), /has no folder/u);
  } finally { AgentWorkspaceTools.apps = undefined; AgentWorkspaceTools.notionFiles = undefined; AgentWorkspaceTools.folders = undefined; f.close(); }
});
