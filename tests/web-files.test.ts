import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { ProjectFolders } from '../src/server/project-folders.js';
import { WebFileFetcher, pagePicture, sniff } from '../src/server/web-files.js';

// A stand-in web: a restaurant page whose main picture is a JPEG on a CDN, a WebP photo behind a redirect, an SVG,
// and a page with no picture.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const PAGE = '<!doctype html><html><head><title>Tozi</title><meta content="/img/dining-room.jpg?w=1200&amp;q=80" property="og:image"><meta name="twitter:image" content="https://cdn.example.com/other.jpg"></head><body>Menu</body></html>';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-web-files-'));
  const store = new Store(join(dir, 'store'));
  const folders = new ProjectFolders(store, { reserved: [join(dir, 'store')] });
  const fetched: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = String(input); fetched.push(url);
    if (url === 'https://tozi.example.com/') return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url === 'https://tozi.example.com/img/dining-room.jpg?w=1200&q=80') return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url === 'https://guide.example.com/negroni') return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/negroni.webp' } });
    if (url === 'https://cdn.example.com/negroni.webp') return new Response(WEBP, { status: 200, headers: { 'content-type': 'image/webp' } });
    if (url === 'https://guide.example.com/to-the-router') return new Response(null, { status: 302, headers: { location: 'http://router.local/admin.png' } });
    if (url === 'https://cdn.example.com/logo.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    if (url === 'https://plain.example.com/') return new Response('<html><head><title>No picture</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const lookup = async (host: string) => [{ address: host.endsWith('.local') ? '192.168.1.1' : '93.184.216.34' }];
  return { dir, store, folders, fetched, web: new WebFileFetcher({ fetcher, lookup }), close: () => { folders.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-web-files', 'claude');

test('A web page\'s main picture and the kinds of file a File block shows are recognised', () => {
  assert.equal(pagePicture(PAGE, new URL('https://tozi.example.com/')), 'https://tozi.example.com/img/dining-room.jpg?w=1200&q=80');
  assert.equal(pagePicture('<link href="//cdn.example.com/a.png" rel="image_src">', new URL('https://x.example.com/p')), 'https://cdn.example.com/a.png');
  assert.equal(pagePicture('<meta property="og:image" content="javascript:alert(1)">', new URL('https://x.example.com/')), undefined);
  assert.deepEqual([sniff(JPEG)?.extension, sniff(WEBP)?.extension, sniff(Buffer.from('GIF89a......'))?.extension, sniff(Buffer.from('<svg'))], ['.jpg', '.webp', '.gif', undefined]);
});

test('Agents give File blocks web addresses: ros.ai downloads the pictures into the folder and proposes the blocks in their group', async () => {
  const f = fixture();
  AgentWorkspaceTools.folders = f.folders; AgentWorkspaceTools.webFiles = f.web;
  try {
    const project = f.store.createProject('Dinner night');
    f.folders.attach(project.id, join(f.dir, 'Dinner night'));
    f.folders.shutdown();
    const agent = toolkit(f.store, project.id);
    assert.match(agent.definitions.find(tool => tool.name === 'ros_propose_canvas')!.description, /public web address/u);
    const result = await agent.call('ros_propose_canvas', { summary: 'One group per restaurant with photos', rationale: 'The person asked for photos of each restaurant.', operations: [
      { type: 'addNode', node: { id: 'tozi', title: 'TOZI', description: '', kind: 'group', x: 0, y: 0 } },
      { type: 'addNode', node: { id: 'room', title: 'TOZI dining room', description: 'The dining room.', kind: 'topic', blockType: 'file', file: { path: 'https://tozi.example.com/' }, parentId: 'tozi', x: 0, y: 0 } },
      { type: 'addNode', node: { id: 'negroni', title: 'TOZI Negroni', description: '', kind: 'topic', blockType: 'file', file: { path: 'https://guide.example.com/negroni' }, parentId: 'tozi', x: 0, y: 240 } },
      { type: 'addNode', node: { id: 'router', title: 'Sneaky', description: '', kind: 'topic', blockType: 'file', file: { path: 'https://guide.example.com/to-the-router' }, parentId: 'tozi', x: 0, y: 480 } },
      { type: 'addNode', node: { id: 'logo', title: 'Logo', description: '', kind: 'topic', blockType: 'file', file: { path: 'https://cdn.example.com/logo.svg' }, parentId: 'tozi', x: 0, y: 720 } },
      { type: 'addConnection', connection: { id: 'room-logo', source: 'room', target: 'logo', label: 'same place' } },
    ] }) as { action: { proposalId: string }; committed: boolean; downloaded: { id: string; file: string; from: string }[]; notSaved: { id: string; problem: string }[]; instruction: string };
    assert.equal(result.committed, false);
    assert.deepEqual(result.downloaded.map(item => [item.id, item.file]), [['room', 'files/TOZI dining room.jpg'], ['negroni', 'files/TOZI Negroni.webp']]);
    assert.deepEqual(readFileSync(join(f.dir, 'Dinner night', 'files', 'TOZI Negroni.webp')), WEBP);
    // The router address is never fetched: the redirect into the local network stops the download.
    assert(!f.fetched.some(url => url.includes('router.local')));
    assert.deepEqual(result.notSaved.map(item => item.id), ['router', 'logo']);
    assert.match(result.notSaved[0].problem, /not on the public internet/u);
    assert.match(result.notSaved[1].problem, /SVG/u);
    assert.match(result.instruction, /could not be downloaded/u);

    f.store.acceptProposal(project.id, result.action.proposalId);
    const nodes = f.store.getProject(project.id).canvas.nodes, room = nodes.find(n => n.id === 'room')!;
    assert.deepEqual(nodes.map(n => n.id).sort(), ['negroni', 'room', 'tozi']);
    assert.deepEqual([room.blockType, room.file, room.parentId], ['file', { path: 'files/TOZI dining room.jpg' }, 'tozi']);
    assert.match(room.description, /^The dining room\.\n\nJPEG image downloaded \d{4}-\d{2}-\d{2}\. Source: https:\/\/tozi\.example\.com\/ \(its main picture, https:\/\/tozi\.example\.com\/img\/dining-room\.jpg\?w=1200&q=80\)$/u);
    assert.equal(f.store.getProject(project.id).canvas.connections.length, 0);

    // A page without a picture, alone in a change, proposes nothing.
    const none = await toolkit(f.store, project.id).call('ros_propose_canvas', { summary: 'Photo', rationale: 'Asked.', operations: [{ type: 'addNode', node: { id: 'plain', title: 'Plain', description: '', kind: 'topic', blockType: 'file', file: { path: 'https://plain.example.com/' }, x: 0, y: 0 } }] }) as { committed: boolean; notSaved: { problem: string }[]; action?: unknown };
    assert.equal(none.action, undefined);
    assert.match(none.notSaved[0].problem, /names no main picture/u);

    // Without a project folder there is nowhere to save, and nothing is fetched.
    const bare = f.store.createProject('No folder'), before = f.fetched.length;
    await assert.rejects(toolkit(f.store, bare.id).call('ros_propose_canvas', { summary: 'Photo', rationale: 'Asked.', operations: [{ type: 'addNode', node: { id: 'p', title: 'P', description: '', kind: 'topic', blockType: 'file', file: { path: 'https://cdn.example.com/negroni.webp' }, x: 0, y: 0 } }] }), /has no folder/u);
    assert.equal(f.fetched.length, before);
  } finally { AgentWorkspaceTools.folders = undefined; AgentWorkspaceTools.webFiles = undefined; f.close(); }
});
