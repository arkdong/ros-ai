import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import express from 'express';
import { attachAppRoutes, RemoteApps } from '../src/server/remote-apps.js';
import { followScript } from '../src/server/sign-in-window.js';
import { SlackApp } from '../src/server/slack.js';
import type { TokenPluginId } from '../src/shared/plugins.js';

// Stand-ins for the apps' own servers: an MCP server behind OAuth with dynamic registration and PKCE (Linear),
// one that takes a token (GitHub), a desktop server without sign-in (Figma), and Slack's Web API.

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
type Call = { name: string; arguments: Record<string, unknown>; bearer?: string };
const body = (req: IncomingMessage) => new Promise<string>(done => { let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => done(text)); });
async function listen(handle: (req: IncomingMessage, res: ServerResponse, url: URL, text: string) => void | Promise<void>) {
  const server = createServer(async (req, res) => { try { await handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), await body(req)); } catch (error) { res.writeHead(500).end(String(error)); } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
const json = (res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };

/** A minimal MCP server over Streamable HTTP with JSON answers. allow decides who may call it. */
function mcp(tools: Tool[], calls: Call[], allow: (bearer: string | undefined) => boolean, unauthorized: (res: ServerResponse) => void) {
  return (req: IncomingMessage, res: ServerResponse, text: string) => {
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1];
    if (!allow(bearer)) return unauthorized(res);
    if (req.method !== 'POST') return void res.writeHead(405).end();
    const message = JSON.parse(text) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
    if (message.id === undefined) return void res.writeHead(202).end();
    const reply = (result: unknown) => json(res, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '1' } });
    if (message.method === 'tools/list') return reply({ tools });
    if (message.method === 'tools/call') {
      calls.push({ name: message.params!.name!, arguments: message.params!.arguments ?? {}, bearer });
      return reply({ content: [{ type: 'text', text: `${message.params!.name} ran with ${JSON.stringify(message.params!.arguments ?? {})}` }] });
    }
    reply({});
  };
}

const LINEAR_TOOLS: Tool[] = [
  { name: 'list_issues', description: 'List issues\nwith filters', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'get_team', description: 'Get a team', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
];

/** Linear's stand-in: protected-resource and server metadata, registration, an authorization page that approves at once, a token endpoint that checks PKCE. */
async function signInServer(calls: Call[]) {
  const clients = new Map<string, string[]>(), codes = new Map<string, { challenge: string; redirect: string; client: string }>(), tokens = new Set<string>();
  const seen = { registered: 0, authorized: 0, resource: '' };
  let base = '';
  const serve = mcp(LINEAR_TOOLS, calls, bearer => Boolean(bearer && tokens.has(bearer)), res => json(res, { error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }));
  const server = await listen(async (req, res, url, text) => {
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') return json(res, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(res, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') {
      const metadata = JSON.parse(text) as { redirect_uris: string[]; client_name?: string };
      const id = `client-${++seen.registered}`; clients.set(id, metadata.redirect_uris);
      return json(res, { ...metadata, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
    }
    if (url.pathname === '/authorize') {
      const client = url.searchParams.get('client_id') ?? '', redirect = url.searchParams.get('redirect_uri') ?? '';
      if (!clients.get(client)?.includes(redirect) || url.searchParams.get('code_challenge_method') !== 'S256') return void res.writeHead(400).end('bad request');
      seen.authorized++; seen.resource = url.searchParams.get('resource') ?? '';
      const code = randomBytes(8).toString('hex'); codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect, client });
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}` }); return void res.end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(text), grant = codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (!grant || grant.redirect !== form.get('redirect_uri') || grant.client !== form.get('client_id') || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(res, { error: 'invalid_grant' }, 400);
      codes.delete(form.get('code')!);
      const token = `linear-${randomBytes(6).toString('hex')}`; tokens.add(token);
      return json(res, { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-1' });
    }
    if (url.pathname === '/mcp') return serve(req, res, text);
    res.writeHead(404).end();
  });
  base = server.base;
  return { ...server, seen };
}

function fixture(tokens: Partial<Record<TokenPluginId, string>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-apps-'));
  const store = new Store(join(dir, 'store'));
  const apps = new RemoteApps(dir, { token: id => tokens[id], builtIn: { slack: new SlackApp(() => tokens.slack) } });
  return { dir, store, apps, tokens, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-apps', 'model', 'Test model');
/** Accepts the proposal a write is waiting on, once it appears. */
async function accept(store: Store, projectId: string, tools: AgentWorkspaceTools) {
  for (let i = 0; i < 100 && !tools.actions.some(item => item.proposalId); i++) await delay(20);
  const action = tools.actions.find(item => item.proposalId)!;
  store.acceptProposal(projectId, action.proposalId!);
  return action;
}

test('Linear signs in once in the browser, with ros.ai registering itself and PKCE, and its tools then work for every agent', async () => {
  const calls: Call[] = [], linear = await signInServer(calls), f = fixture();
  process.env.ROS_APP_LINEAR_URL = `${linear.base}/mcp`;
  try {
    assert.equal(f.apps.status('linear').connected, false);
    const started = await f.apps.begin('linear', 'http://127.0.0.1:4310/api/apps/callback');
    assert(started.url && started.nonce, 'the sign-in starts');
    // The person approves on Linear's page, which sends the browser back to ros.ai with a code.
    const approved = await fetch(started.url, { redirect: 'manual' });
    assert.equal(approved.status, 302);
    const back = new URL(approved.headers.get('location')!);
    assert.equal(back.origin + back.pathname, 'http://127.0.0.1:4310/api/apps/callback');
    assert.equal(linear.seen.registered, 1);
    assert.equal(linear.seen.resource, `${linear.base}/mcp`);
    // Another browser (no matching nonce) cannot finish it.
    await assert.rejects(f.apps.finish({ state: back.searchParams.get('state'), code: back.searchParams.get('code') }, 'x'.repeat(43)), /expired or was started in another browser/u);
    assert.deepEqual(f.apps.waiting(back.searchParams.get('state')), { app: 'linear', window: false, keep: false });
    assert.equal(await f.apps.finish({ state: back.searchParams.get('state'), code: back.searchParams.get('code') }, started.nonce), 'linear');
    assert.equal(f.apps.waiting(back.searchParams.get('state')), undefined, 'a state finishes once');
    assert.equal(f.apps.status('linear').connected, true);
    assert.deepEqual(f.apps.connected(), ['linear']);
    const tools = await f.apps.tools('linear');
    assert.deepEqual(tools.map(tool => [tool.name, tool.reads]), [['list_issues', true], ['get_team', true], ['create_issue', false]]);

    const project = f.store.createProject('Apps');
    AgentWorkspaceTools.apps = f.apps;
    const agent = toolkit(f.store, project.id);
    const listing = agent.definitions.find(item => item.name === 'ros_app_tools')!;
    assert.match(listing.description, /connected: linear \(Linear\)\./u);
    const read = await agent.call('ros_app_call', { app: 'linear', tool: 'list_issues', arguments: { query: 'bug' }, summary: 'Find bugs', rationale: 'The question is about open bugs.' }) as { text: string; note: string };
    assert.equal(read.text, 'list_issues ran with {"query":"bug"}');
    assert.match(read.note, /untrusted/u);
    assert.equal(calls.length, 1);
    // Creating an issue waits on the canvas until the person accepts it, then runs.
    const pending = agent.call('ros_app_call', { app: 'linear', tool: 'create_issue', arguments: { title: 'Fix the export' }, summary: 'Open an issue for the export bug', rationale: 'The person asked to track it.' });
    await delay(150);
    assert.equal(calls.length, 1);
    const action = await accept(f.store, project.id, agent);
    assert.match(action.title, /Write to Linear: Open an issue/u);
    const written = await pending as { status: string };
    assert.equal(written.status, 'written');
    assert.deepEqual(calls[1], { name: 'create_issue', arguments: { title: 'Fix the export' }, bearer: calls[0].bearer });

    // The sign-in survives a restart; disconnecting forgets it.
    const again = new RemoteApps(f.dir, {});
    assert.equal(again.status('linear').connected, true);
    assert.equal(again.disconnect('linear').connected, false);
    assert.equal(new RemoteApps(f.dir, {}).status('linear').connected, false);
  } finally { AgentWorkspaceTools.apps = undefined; delete process.env.ROS_APP_LINEAR_URL; await linear.close(); f.close(); }
});

test('a sign-in from a suggestion opens in its own window, whose page tells ros.ai; one from the Mac app finishes in the system browser', async () => {
  const calls: Call[] = [], linear = await signInServer(calls), f = fixture();
  process.env.ROS_APP_LINEAR_URL = `${linear.base}/mcp`;
  const app = express(); app.use(express.json()); attachAppRoutes(app, f.apps);
  const local = await new Promise<import('node:http').Server>(done => { const server = app.listen(0, '127.0.0.1', () => done(server)); });
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  const connect = (agent: string) => fetch(`${base}/api/apps/linear/connect`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': agent }, body: JSON.stringify({ window: true }) });
  const approve = async (url: string) => (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
  try {
    // From a browser: the cookie binds the sign-in to it, so a callback without it gets a page saying so, and no connection.
    const browser = await connect('Mozilla/5.0 Chrome/140');
    assert.match(browser.headers.get('set-cookie') ?? '', /ros-ai-app-sign-in=/u);
    const refused = await fetch(await approve((await browser.json() as { authorizationUrl: string }).authorizationUrl));
    assert.equal(refused.status, 400);
    const refusal = await refused.text();
    assert.match(refusal, /Couldn’t connect Linear/u);
    assert.match(refusal, /postMessage\(\{"failed":"linear","error":"This sign-in expired or was started in another browser/u);
    assert.equal(f.apps.status('linear').connected, false);
    // From the Mac app: no cookie (the system browser would not have it), and the system browser finishes the sign-in.
    const desktop = await connect('Mozilla/5.0 (Macintosh) Electron/38 ros.ai/0.1.0');
    assert.equal(desktop.headers.get('set-cookie'), null);
    const back = await fetch(await approve((await desktop.json() as { authorizationUrl: string }).authorizationUrl));
    assert.equal(back.status, 200);
    assert.match(back.headers.get('content-type') ?? '', /text\/html/u);
    const page = await back.text();
    assert.match(page, /<h1>Linear connected<\/h1><p>You can close this window\.<\/p>/u);
    assert.match(page, /new BroadcastChannel\('ros-ai-plugins'\)\.postMessage\(\{"connected":"linear"\}\)/u);
    assert.equal(f.apps.status('linear').connected, true);
  } finally { delete process.env.ROS_APP_LINEAR_URL; local.close(); await linear.close(); f.close(); }
});

test('a sign-in from Connect your tools keeps its window, whose page goes where ros.ai tells it next', async () => {
  const calls: Call[] = [], linear = await signInServer(calls), f = fixture();
  process.env.ROS_APP_LINEAR_URL = `${linear.base}/mcp`;
  const app = express(); app.use(express.json()); attachAppRoutes(app, f.apps);
  const local = await new Promise<import('node:http').Server>(done => { const server = app.listen(0, '127.0.0.1', () => done(server)); });
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  try {
    const started = await fetch(`${base}/api/apps/linear/connect`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/140' }, body: JSON.stringify({ window: true, keep: true }) });
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0];
    const back = (await fetch((await started.json() as { authorizationUrl: string }).authorizationUrl, { redirect: 'manual' })).headers.get('location')!;
    assert.deepEqual(f.apps.waiting(new URL(back).searchParams.get('state')), { app: 'linear', window: true, keep: true });
    const page = await (await fetch(back, { headers: { cookie } })).text();
    assert.match(page, /<h1>Linear connected<\/h1><p>ros\.ai goes on by itself\.<\/p>/u);
    assert.match(page, /postMessage\(\{"connected":"linear"\}\)/u);
    assert.doesNotMatch(page, /window\.close\(\),800/u, 'the window stays for the next sign-in');
    assert.ok(page.includes(followScript), 'the page listens for where to go next');
    assert.equal(f.apps.status('linear').connected, true);
  } finally { delete process.env.ROS_APP_LINEAR_URL; local.close(); await linear.close(); f.close(); }
});

test('GitHub uses its hosted MCP server with the token from its Plugins card, connects again when the token changes, and says when it is refused', async () => {
  const calls: Call[] = [], seen: string[] = [];
  const github = await listen((req, res, _url, text) => {
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1];
    if (bearer && req.method === 'POST' && text.includes('"initialize"')) seen.push(bearer);
    return mcp([{ name: 'get_me', description: 'Who am I', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'create_issue', description: 'Open an issue', inputSchema: { type: 'object' } }], calls, value => value === 'ghp_first' || value === 'ghp_second', res => json(res, { message: 'Bad credentials' }, 401))(req, res, text);
  });
  const f = fixture();
  process.env.ROS_APP_GITHUB_URL = `${github.base}/mcp/`;
  try {
    assert.equal(f.apps.status('github').connected, false);
    await assert.rejects(f.apps.tools('github'), /Save its token on the Plugins page/u);
    f.tokens.github = 'ghp_first';
    assert.equal(f.apps.status('github').connected, true);
    assert.deepEqual((await f.apps.tools('github')).map(tool => [tool.name, tool.reads]), [['get_me', true], ['create_issue', false]]);
    assert.equal((await f.apps.call('github', 'get_me', {})).text, 'get_me ran with {}');
    f.tokens.github = 'ghp_second';
    await f.apps.call('github', 'get_me', {});
    assert.deepEqual(seen, ['ghp_first', 'ghp_second']);
    assert.deepEqual(calls.map(call => call.bearer), ['ghp_first', 'ghp_second']);
    f.tokens.github = 'ghp_wrong';
    await assert.rejects(f.apps.tools('github'), /GitHub did not accept the token saved on its Plugins card/u);
    assert.throws(() => f.apps.disconnect('github'), /Remove the token there/u);
  } finally { delete process.env.ROS_APP_GITHUB_URL; await github.close(); f.close(); }
});

test('Figma connects to its desktop app’s server without a sign-in, and says how to turn it on when it is not running', async () => {
  const calls: Call[] = [];
  const figma = await listen((req, res, _url, text) => mcp([{ name: 'get_design_context', description: 'Design context for a node', inputSchema: { type: 'object' } }, { name: 'add_code_connect_map', description: 'Map a component', inputSchema: { type: 'object' } }], calls, () => true, () => undefined)(req, res, text));
  const f = fixture();
  process.env.ROS_APP_FIGMA_URL = `${figma.base}/mcp`;
  try {
    assert.equal(f.apps.status('figma').connected, false);
    await assert.rejects(f.apps.tools('figma'), /Open Plugins and connect it/u);
    const status = await f.apps.connectDesktop('figma');
    assert.equal(status.connected, true);
    assert(status.connectedAt);
    assert.deepEqual((await f.apps.tools('figma')).map(tool => [tool.name, tool.reads]), [['get_design_context', true], ['add_code_connect_map', false]]);
    assert.equal((await f.apps.call('figma', 'get_design_context', { nodeId: '1:2' })).text, 'get_design_context ran with {"nodeId":"1:2"}');
    await figma.close();
    await assert.rejects(f.apps.connectDesktop('figma'), /Figma’s desktop app is not answering at 127\.0\.0\.1:\d+\. Open the Figma desktop app, open a design file, switch to Dev Mode/u);
    assert.equal(f.apps.status('figma').connected, true, 'a failed reconnect keeps the earlier choice');
    assert.equal(f.apps.disconnect('figma').connected, false);
    await assert.rejects(f.apps.begin('figma', 'http://127.0.0.1:4310/api/apps/callback'), /does not connect with a sign-in/u);
  } finally { delete process.env.ROS_APP_FIGMA_URL; await figma.close().catch(() => undefined); f.close(); }
});

test('Slack reads channels and threads through the Slack app’s bot token, names authors and links messages, and posts only after the person accepts', async () => {
  const requests: { method: string; params: Record<string, unknown>; bearer?: string }[] = [];
  let usersScope = true;
  const channels = [{ id: 'C0123ABCD', name: 'research', is_private: false, is_member: true, num_members: 4, topic: { value: 'Papers and findings' } }, { id: 'C0999ZZZZ', name: 'random', is_member: false, num_members: 30 }];
  const slack = await listen((req, res, url, text) => {
    const method = url.pathname.replace('/api/', ''), bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1];
    const params: Record<string, unknown> = req.method === 'POST' && text ? JSON.parse(text) : Object.fromEntries(url.searchParams);
    requests.push({ method, params, bearer });
    if (bearer !== 'xoxb-test') return json(res, { ok: false, error: 'invalid_auth' });
    if (method === 'auth.test') return json(res, { ok: true, url: 'https://ros-lab.slack.com/', team: 'ros lab' });
    if (method === 'conversations.list') return json(res, { ok: true, channels, response_metadata: { next_cursor: '' } });
    if (method === 'conversations.history') return params.channel === 'C0999ZZZZ' ? json(res, { ok: false, error: 'not_in_channel' }) : json(res, { ok: true, messages: [{ ts: '1730000100.000200', user: 'U1', text: 'The second paper replicates it.', reply_count: 2, thread_ts: '1730000100.000200' }, { ts: '1730000000.000100', bot_id: 'B1', username: 'feeds', text: 'New arXiv listing' }], has_more: false });
    if (method === 'conversations.replies') return json(res, { ok: true, messages: [{ ts: '1730000100.000200', user: 'U1', text: 'The second paper replicates it.' }, { ts: '1730000200.000300', user: 'U2', text: 'Which sample size?' }] });
    if (method === 'users.info') return usersScope ? json(res, { ok: true, user: { name: String(params.user).toLowerCase(), profile: { display_name: params.user === 'U1' ? 'Mira' : 'Joost' } } }) : json(res, { ok: false, error: 'missing_scope', needed: 'users:read' });
    if (method === 'chat.postMessage') return json(res, { ok: true, channel: params.channel, ts: '1730000300.000400' });
    json(res, { ok: false, error: 'unknown_method' });
  });
  const f = fixture();
  process.env.ROS_SLACK_API_URL = `${slack.base}/api`;
  try {
    assert.equal(f.apps.status('slack').connected, false);
    await assert.rejects(f.apps.tools('slack'), /Save its token on the Plugins page/u);
    f.tokens.slack = 'xoxb-test';
    assert.deepEqual((await f.apps.tools('slack')).map(tool => [tool.name, tool.reads]), [['list_channels', true], ['read_channel', true], ['read_thread', true], ['post_message', false]]);
    const listed = JSON.parse((await f.apps.call('slack', 'list_channels', { query: 'res' })).text) as { channels: { name: string; member: boolean; about?: string }[] };
    assert.deepEqual(listed.channels, [{ id: 'C0123ABCD', name: '#research', private: false, member: true, members: 4, about: 'Papers and findings' }]);
    const read = JSON.parse((await f.apps.call('slack', 'read_channel', { channel: '#research', limit: 10 })).text) as { channel: { id: string }; messages: { author: string; link: string; replies?: number; thread_ts?: string; at: string }[] };
    assert.equal(read.channel.id, 'C0123ABCD');
    assert.deepEqual(read.messages.map(item => item.author), ['Mira', 'feeds']);
    assert.equal(read.messages[0].link, 'https://ros-lab.slack.com/archives/C0123ABCD/p1730000100000200');
    assert.equal(read.messages[0].replies, 2);
    assert.equal(read.messages[0].at, '2024-10-27T03:35:00.000Z');
    assert.equal(requests.find(item => item.method === 'conversations.history')!.params.limit, '10');
    const notMember = await f.apps.call('slack', 'read_channel', { channel: 'random' });
    assert.equal(notMember.isError, true);
    assert.match(notMember.text, /not in that channel\. Someone in it can invite the app with \/invite/u);
    assert.match((await f.apps.call('slack', 'read_channel', { channel: '#nowhere' })).text, /no channel called #nowhere/u);
    assert.match((await f.apps.call('slack', 'read_channel', { channel: '#research', limit: 500 })).text, /^Invalid arguments: limit/u);
    // Without users:read the authors stay IDs, and ros.ai stops asking.
    const other = fixture({ slack: 'xoxb-test' });
    usersScope = false;
    const thread = JSON.parse((await other.apps.call('slack', 'read_thread', { channel: 'C0123ABCD', ts: '1730000100.000200' })).text) as { messages: { author: string }[] };
    assert.deepEqual(thread.messages.map(item => item.author), ['U1', 'U2']);
    assert.equal(requests.filter(item => item.method === 'users.info' && item.params.user === 'U2').length, 0);
    other.close();
    usersScope = true;

    // Posting goes through an agent's write, which waits for the person.
    const project = f.store.createProject('Slack');
    AgentWorkspaceTools.apps = f.apps;
    const agent = toolkit(f.store, project.id);
    assert.match(agent.definitions.find(item => item.name === 'ros_app_call')!.description, /\(slack \(Slack\)\)/u);
    const pending = agent.call('ros_app_call', { app: 'slack', tool: 'post_message', arguments: { channel: '#research', text: 'Summary: the effect replicates in two samples.' }, summary: 'Share the summary', rationale: 'The person asked to tell the team.' });
    await delay(150);
    assert(!requests.some(item => item.method === 'chat.postMessage'));
    const action = await accept(f.store, project.id, agent);
    assert.match(action.title, /Write to Slack: Share the summary/u);
    const written = await pending as { status: string; result: { text: string } };
    assert.equal(written.status, 'written');
    assert.deepEqual(requests.find(item => item.method === 'chat.postMessage')!.params, { channel: 'C0123ABCD', text: 'Summary: the effect replicates in two samples.', unfurl_links: false });
    assert.match(written.result.text, /"link": "https:\/\/ros-lab\.slack\.com\/archives\/C0123ABCD\/p1730000300000400"/u);
    f.tokens.slack = 'xoxb-revoked';
    assert.match((await f.apps.call('slack', 'list_channels', {})).text, /did not accept the bot token/u);
  } finally { AgentWorkspaceTools.apps = undefined; delete process.env.ROS_SLACK_API_URL; await slack.close(); f.close(); }
});

test('Agents get no app tools until an app is connected, and the tool text lists every connected app', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject('None');
    AgentWorkspaceTools.apps = f.apps;
    assert(!toolkit(f.store, project.id).definitions.some(item => item.name.startsWith('ros_app_')));
    f.tokens.github = 'ghp_first'; f.tokens.slack = 'xoxb-test';
    const definition = toolkit(f.store, project.id).definitions.find(item => item.name === 'ros_app_tools')!;
    assert.match(definition.description, /connected: github \(GitHub\), slack \(Slack\)\./u);
    await assert.rejects(toolkit(f.store, project.id).call('ros_app_tools', { app: 'linear' }), /No connected app called linear\. Connected: github, slack\./u);
  } finally { AgentWorkspaceTools.apps = undefined; f.close(); }
});
