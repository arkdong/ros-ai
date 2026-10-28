import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { mutationSchema, proposalMutationSchema, Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { attachAppRoutes, RemoteApps } from '../src/server/remote-apps.js';
import { NotionViews } from '../src/server/notion-view.js';
import type { NotionTable } from '../src/shared/types.js';

// A stand-in for Notion's hosted MCP server with OAuth as Notion runs it: dynamic registration, PKCE, and a consent page
// that shares one workspace, so each token reads only that workspace. The test names the workspace the person picks.

type Workspace = { workspace: { id: string; name: string }; user: { type: 'person'; id: string; name: string; email: string }; pages: { id: string; title: string }[]; databases: { id: string; title: string; source: string; rows: { id: string; Name: string }[] }[] };
const WORKSPACES: Record<string, Workspace> = {
  aiso: { workspace: { id: '86a12206-9fec-81e4-8516-0003643bd5d6', name: 'AISO' }, user: { type: 'person', id: '366d872b-594c-815a-821f-0002420be9e8', name: 'Adam', email: 'adam@aiso.example' },
    pages: [{ id: '2a0b22069fec8000bbbb000000000001', title: 'Research agenda' }],
    databases: [{ id: '1f0a22069fec8000aaaa000000000001', title: 'Recruitment', source: 'collection://1f0a2206-9fec-8000-aaaa-0000000000c1', rows: [{ id: '3f0122069fec813999fbe0bd1235f178', Name: 'Megan Li' }] }] },
  personal: { workspace: { id: '5c1e9a40-1d2b-4c11-9e1f-7a2b3c4d5e6f', name: 'Personal' }, user: { type: 'person', id: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', name: 'Adam', email: 'adam@example.com' },
    pages: [{ id: '6f2e9a401d2b4c119e1f000000000001', title: 'Lisbon in November' }], databases: [] },
};
const link = (title: string, id: string) => `https://www.notion.so/${title.replace(/\W+/gu, '-')}-${id}`;
const body = (req: IncomingMessage) => new Promise<string>(done => { let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => done(text)); });
const json = (res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
type Call = { tool: string; workspace: string; args: Record<string, unknown> };

async function notion() {
  const clients = new Map<string, string[]>(), codes = new Map<string, { challenge: string; redirect: string; client: string; workspace: string }>(), tokens = new Map<string, string>();
  const calls: Call[] = [], seen = { registered: 0 };
  let base = '';
  const found = (space: Workspace, id: string) => {
    const hex = (id.match(/([0-9a-f]{32})$/iu)?.[1] ?? id.replace(/-/gu, '').match(/[0-9a-f]{32}/iu)?.[0] ?? id).toLowerCase();
    for (const db of space.databases) {
      if (db.id === hex || db.source === id) return { title: db.title, text: `<database><data-source url="${db.source}"><sqlite-table>CREATE TABLE "${db.source}" ("Name" TEXT, url TEXT)</sqlite-table></data-source></database>`, type: 'database', url: link(db.title, db.id) };
      const row = db.rows.find(item => item.id === hex);
      if (row) return { title: row.Name, text: `<page url="${link(row.Name, row.id)}">\n<properties>\n${JSON.stringify({ Name: row.Name })}\n</properties>\n<content>\nFrom ${space.workspace.name}\n</content>\n</page>`, type: 'page', url: link(row.Name, row.id) };
    }
    const page = space.pages.find(item => item.id === hex);
    return page && { title: page.title, text: `<page url="${link(page.title, page.id)}">\n<properties>\n${JSON.stringify({ title: page.title })}\n</properties>\n<content>\nFrom ${space.workspace.name}\n</content>\n</page>`, type: 'page', url: link(page.title, page.id) };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'), text = await body(req);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(res, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { const metadata = JSON.parse(text) as { redirect_uris: string[] }, id = `client-${++seen.registered}`; clients.set(id, metadata.redirect_uris); return json(res, { ...metadata, client_id: id }, 201); }
    if (url.pathname === '/authorize') {
      const client = url.searchParams.get('client_id') ?? '', redirect = url.searchParams.get('redirect_uri') ?? '', state = url.searchParams.get('state') ?? '';
      if (!clients.get(client)?.includes(redirect)) return void res.writeHead(400).end('unknown client');
      // The workspace the person picks on Notion's consent page.
      const workspace = url.searchParams.get('workspace') ?? 'aiso', code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect, client, workspace });
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(state)}` }); return void res.end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(text), grant = codes.get(form.get('code') ?? '');
      if (!grant || grant.client !== form.get('client_id') || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return json(res, { error: 'invalid_grant' }, 400);
      codes.delete(form.get('code')!);
      const token = `ntn-${grant.workspace}-${randomBytes(4).toString('hex')}`; tokens.set(token, grant.workspace);
      return json(res, { access_token: token, token_type: 'bearer', expires_in: 3600 });
    }
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();
    const workspace = tokens.get(/^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1] ?? '');
    if (!workspace) return json(res, { error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    const message = JSON.parse(text) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
    if (message.id === undefined) return void res.writeHead(202).end();
    const reply = (result: unknown) => json(res, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'notion', version: '1' } });
    if (message.method === 'tools/list') return reply({ tools: ['notion-get-self', 'notion-search', 'notion-fetch', 'notion-query-data-sources', 'notion-get-users', 'notion-create-pages'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })) });
    const space = WORKSPACES[workspace], tool = message.params!.name!, args = message.params!.arguments ?? {};
    calls.push({ tool, workspace, args });
    const text_ = (value: unknown, isError = false) => reply({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });
    if (tool === 'notion-get-self') return text_({ workspace: space.workspace, user: space.user });
    if (tool === 'notion-fetch') {
      const item = found(space, String(args.id));
      // Notion's own words when a link lives in another workspace.
      return item ? text_({ metadata: { type: item.type }, title: item.title, url: item.url, text: item.text }) : text_({ name: 'APIResponseError', code: 'object_not_found', message: `Could not find page with ID: ${String(args.id).slice(-32)}. Check that you have access and that you're authenticated to the correct workspace.` }, true);
    }
    if (tool === 'notion-query-data-sources') {
      const db = space.databases.find(item => item.source === (args.data as { data_source_urls: string[] }).data_source_urls[0]);
      return db ? text_({ results: db.rows.map(row => ({ Name: row.Name, url: link(row.Name, row.id) })) }) : text_({ message: 'Could not find data source.' }, true);
    }
    return text_({ ran: tool, in: space.workspace.name });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls, seen, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}

const REDIRECT = 'http://127.0.0.1:4310/api/apps/callback';
/** Signs in the way the Plugins page does: start, approve on Notion's page with a workspace, come back with the code. */
async function signIn(apps: RemoteApps, workspace: string, options: { add?: boolean; account?: string } = {}) {
  const started = await apps.begin('notion', REDIRECT, options);
  if ('alreadyConnected' in started) return 'already';
  const url = new URL(started.url); url.searchParams.set('workspace', workspace);
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
  return apps.finish({ state: back.searchParams.get('state'), code: back.searchParams.get('code') }, started.nonce);
}
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-notion-accounts', 'model', 'Test model');
const saved = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as { apps: Record<string, any> };
async function fixture() {
  const server = await notion(), dir = mkdtempSync(join(tmpdir(), 'ros-notion-accounts-'));
  process.env.ROS_APP_NOTION_URL = `${server.base}/mcp`;
  const store = new Store(join(dir, 'store')), apps = new RemoteApps(dir);
  return { server, dir, store, apps, close: async () => { AgentWorkspaceTools.apps = undefined; delete process.env.ROS_APP_NOTION_URL; store.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Each Notion sign-in adds the workspace picked on Notion’s page; the same workspace again renews it', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.apps.status('notion').accounts, [], 'Notion lists its accounts, none yet');
    assert.equal(await signIn(f.apps, 'aiso'), 'notion');
    assert.equal(await signIn(f.apps, 'personal'), 'already', 'Connect on a connected Notion changes nothing');
    assert.equal(await signIn(f.apps, 'personal', { add: true }), 'notion');
    const status = f.apps.status('notion');
    assert.equal(status.connected, true);
    assert.equal(status.account, 'AISO');
    assert.deepEqual(status.accounts!.map(({ key, name, email, connected, default: first }) => ({ key, name, email, connected, default: first })), [
      { key: 'aiso', name: 'AISO', email: 'adam@aiso.example', connected: true, default: true },
      { key: 'personal', name: 'Personal', email: 'adam@example.com', connected: true, default: false }]);
    assert.equal(f.server.seen.registered, 2, 'each account registers ros.ai on its own, so no sign-in replaces another');
    // The first account stays where every version of ros.ai reads it; the others are in a file of their own.
    assert.equal(saved(f.dir, 'app-connections.json').apps.notion.account, 'AISO');
    assert.deepEqual(saved(f.dir, 'app-accounts.json').apps.notion.accounts.map((item: { key: string }) => item.key), ['personal']);

    // Signing in to AISO again, even with Add account, renews it instead of adding it twice.
    assert.equal(await signIn(f.apps, 'aiso', { add: true }), 'notion');
    assert.equal(f.apps.status('notion').accounts!.length, 2);
    assert.equal(f.apps.status('notion').notice, 'AISO was connected already, so ros.ai renewed its sign-in.');
    // Signing in again to one account but picking another workspace changes nothing, and says what to do.
    await assert.rejects(signIn(f.apps, 'aiso', { account: 'personal' }), /Notion signed in to AISO, not Personal, so nothing changed\. Sign in again and pick Personal in Notion\./u);
    assert.equal(await signIn(f.apps, 'personal', { account: 'personal' }), 'notion');
    await assert.rejects(f.apps.begin('notion', REDIRECT, { account: 'nowhere' }), /No Notion account called nowhere/u);

    // Each account reads its own workspace.
    assert.match((await f.apps.call('notion', 'notion-search', {}, undefined, 'personal')).text, /"in":"Personal"/u);
    assert.match((await f.apps.call('notion', 'notion-search', {})).text, /"in":"AISO"/u, 'without an account, the default');

    // Renamed, made the default and disconnected one at a time; it all survives a restart.
    f.apps.update('notion', 'personal', { name: 'Home' });
    f.apps.update('notion', 'personal', { default: true });
    let again = new RemoteApps(f.dir);
    assert.deepEqual(again.status('notion').accounts!.map(item => [item.key, item.name, item.default]), [['personal', 'Home', true], ['aiso', 'AISO', false]]);
    assert.match((await again.call('notion', 'notion-search', {})).text, /"in":"Personal"/u);
    assert.equal(again.disconnect('notion', 'personal').accounts!.length, 1);
    again = new RemoteApps(f.dir);
    assert.deepEqual(again.status('notion').accounts!.map(item => [item.key, item.default]), [['aiso', true]]);
    assert.equal(again.disconnect('notion').connected, false);
    assert.deepEqual(new RemoteApps(f.dir).status('notion').accounts, []);
  } finally { await f.close(); }
});

test('Agents see each Notion account as its own app, and with one account the tools read as they always did', async () => {
  const f = await fixture();
  try {
    await signIn(f.apps, 'aiso');
    const project = f.store.createProject('Accounts');
    AgentWorkspaceTools.apps = f.apps;
    const single = toolkit(f.store, project.id).definitions.find(item => item.name === 'ros_app_tools')!.description;
    assert.match(single, /connected: notion \(Notion\)\. Name one tool/u);
    assert.doesNotMatch(single, /Each Notion account/u);

    await signIn(f.apps, 'personal', { add: true });
    assert.deepEqual(f.apps.agentApps(), [{ name: 'notion', app: 'notion', account: 'aiso', label: 'Notion · AISO' }, { name: 'notion-personal', app: 'notion', account: 'personal', label: 'Notion · Personal' }]);
    const agent = toolkit(f.store, project.id), listing = agent.definitions.find(item => item.name === 'ros_app_tools')!.description;
    assert.match(listing, /connected: notion \(Notion · AISO\), notion-personal \(Notion · Personal\)\./u);
    assert.match(listing, /Each Notion account is its own app/u);
    const read = await agent.call('ros_app_call', { app: 'notion-personal', tool: 'notion-search', arguments: { query: 'Lisbon' }, summary: 'Find the trip', rationale: 'The person asked about Lisbon.' }) as { app: string; text: string };
    assert.equal(read.app, 'notion-personal');
    assert.deepEqual(f.server.calls.filter(call => call.tool === 'notion-search').map(call => call.workspace), ['personal']);
    // A write waits for the person, named by the account it goes to.
    const write = agent.call('ros_app_call', { app: 'notion-personal', tool: 'notion-create-pages', arguments: { pages: [] }, summary: 'Save the plan', rationale: 'The person asked to keep it.' });
    for (let i = 0; i < 100 && !agent.actions.some(item => item.proposalId); i++) await new Promise(done => setTimeout(done, 20));
    assert.match(agent.actions[0].title, /^Write to Notion · Personal: Save the plan/u);
    f.store.dismissProposal(project.id, agent.actions[0].proposalId!);
    assert.equal((await write as { status: string }).status, 'dismissed');
    assert(!f.server.calls.some(call => call.tool === 'notion-create-pages'), 'nothing was written');
    await assert.rejects(agent.call('ros_app_tools', { app: 'notion-work' }), /No connected app called notion-work\. Connected: notion, notion-personal\./u);

    // A renamed account gets the new name, and its old address still reaches it.
    f.apps.update('notion', 'personal', { name: 'Home' });
    assert.equal(f.apps.agentApps()[1].name, 'notion-home');
    assert.equal(f.apps.agentApp('notion-personal')?.account, 'personal');
  } finally { await f.close(); }
});

test('A Notion block reads with the account that can open its link, remembers it, and keeps the one the person chooses', async () => {
  const f = await fixture();
  try {
    await signIn(f.apps, 'aiso');
    const views = new NotionViews(f.apps), lisbon = link('Lisbon in November', '6f2e9a401d2b4c119e1f000000000001');
    const fetched = () => f.server.calls.filter(call => call.tool === 'notion-fetch').map(call => call.workspace);
    // One account: the read is what it always was, without an account on it.
    const alone = await views.read({ url: link('Research agenda', '2a0b22069fec8000bbbb000000000001'), kind: 'page' });
    assert.equal(alone.account, undefined);

    await signIn(f.apps, 'personal', { add: true });
    f.server.calls.length = 0;
    const trip = await views.read({ url: lisbon, kind: 'page' });
    assert.deepEqual(trip.account, { key: 'personal', name: 'Personal' });
    assert.deepEqual(fetched(), ['aiso', 'personal'], 'the default first, then the others');
    f.server.calls.length = 0;
    await views.read({ url: lisbon, kind: 'page' }, true);
    assert.deepEqual(fetched(), ['personal'], 'the account that opened it last goes first');

    // A database's rows read with its account first.
    const table = await views.read({ url: link('Recruitment', '1f0a22069fec8000aaaa000000000001') });
    assert.equal(table.kind, 'database');
    assert.equal(table.account?.key, 'aiso');
    f.server.calls.length = 0;
    const row = await views.read({ url: (table as NotionTable).rows[0].url, kind: 'page' });
    assert.equal(row.account?.key, 'aiso');
    assert.deepEqual(fetched(), ['aiso']);

    // The account the person chose goes first, and the next one still opens what it cannot.
    f.server.calls.length = 0;
    assert.equal((await views.read({ url: lisbon, kind: 'page', account: 'personal' })).account?.key, 'personal');
    assert.deepEqual(fetched(), ['personal']);
    f.server.calls.length = 0;
    assert.equal((await views.read({ url: link('Research agenda', '2a0b22069fec8000bbbb000000000001'), kind: 'page', account: 'personal' })).account?.key, 'aiso');
    assert.deepEqual(fetched(), ['personal', 'aiso']);
    await assert.rejects(views.read({ url: link('Elsewhere', 'ffff22069fec8000bbbb000000000001'), kind: 'page' }), /None of your Notion accounts can open this link: ros\.ai tried AISO and Personal\. Add the account it is in on the Plugins page\./u);
  } finally { await f.close(); }
});

test('A sign-in kept by an earlier version becomes the first account, and an earlier version still finds it', async () => {
  const f = await fixture();
  try {
    await signIn(f.apps, 'aiso');
    // What an earlier version kept: the sign-in and the workspace's name, nothing about who signed in.
    const earlier = saved(f.dir, 'app-connections.json');
    const { key: _key, workspace: _workspace, user: _user, email: _email, ...kept } = earlier.apps.notion;
    writeFileSync(join(f.dir, 'app-connections.json'), JSON.stringify({ version: 1, apps: { notion: kept } }), { mode: 0o600 });
    const apps = new RemoteApps(f.dir);
    assert.deepEqual(apps.status('notion').accounts!.map(item => [item.key, item.name, item.email]), [['aiso', 'AISO', null]]);
    await apps.learn();
    assert.equal(apps.status('notion').accounts![0].email, 'adam@aiso.example', 'it learns who signed in');
    // AISO again is recognised as the same account, and another workspace is added beside it.
    await signIn(apps, 'aiso', { add: true });
    await signIn(apps, 'personal', { add: true });
    assert.deepEqual(apps.status('notion').accounts!.map(item => item.key), ['aiso', 'personal']);
    const first = saved(f.dir, 'app-connections.json').apps.notion;
    assert.equal(first.account, 'AISO');
    assert(first.tokens.access_token.startsWith('ntn-aiso-'), 'app-connections.json keeps the first sign-in, as earlier versions read it');
  } finally { await f.close(); }
});

test('The Plugins page names, defaults and disconnects one account; the block keeps the account its person chose', async () => {
  const f = await fixture();
  const app = express(); app.use(express.json()); attachAppRoutes(app, f.apps);
  const local = await new Promise<import('node:http').Server>(done => { const server = app.listen(0, '127.0.0.1', () => done(server)); });
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}/api/apps/notion`;
  const send = (path: string, method: string, value?: unknown) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  try {
    await signIn(f.apps, 'aiso'); await signIn(f.apps, 'personal', { add: true });
    assert.equal((await send('/accounts/personal', 'PATCH', { name: 'Home', default: true })).status, 200);
    assert.deepEqual(f.apps.status('notion').accounts!.map(item => [item.name, item.default]), [['Home', true], ['AISO', false]]);
    assert.equal((await send('/accounts/personal', 'PATCH', { colour: 'red' })).status >= 400, true);
    assert.equal((await send('/accounts/personal', 'DELETE')).status, 200);
    assert.deepEqual(f.apps.status('notion').accounts!.map(item => item.key), ['aiso']);

    // Only the person chooses a block's account; an agent that changes the block's filter keeps it.
    const project = f.store.createProject('Blocks'), url = link('Recruitment', '1f0a22069fec8000aaaa000000000001');
    assert.throws(() => proposalMutationSchema.parse({ type: 'addNode', node: { id: 'n1', title: 'R', description: '', x: 0, y: 0, blockType: 'notion', notion: { url, account: 'aiso' } } }));
    const added = { type: 'addNode' as const, node: { id: 'n1', title: 'Recruitment', description: '', x: 0, y: 0, blockType: 'notion' as const, notion: { url, account: 'aiso' } } };
    assert(mutationSchema.safeParse(added).success);
    f.store.mutate(project.id, [added], 'Add');
    const proposal = f.store.createProposal(project.id, f.store.getProject(project.id).revision, 'Narrow it', [{ type: 'updateNode', id: 'n1', patch: { notion: { url, filter: '"Name" LIKE \'M%\'' } } }]);
    f.store.acceptProposal(project.id, proposal.id);
    assert.deepEqual(f.store.getProject(project.id).canvas.nodes.find(item => item.id === 'n1')?.notion, { url, filter: '"Name" LIKE \'M%\'', account: 'aiso' });
  } finally { local.close(); await f.close(); }
});
