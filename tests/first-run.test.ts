import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

// The first-run screen's scan reads a home folder made here, so HOME is set before the setup code loads. Apps keep their
// data in ~/.config on Linux, where this runs; a stand-in answers for Figma's desktop server.
const home = mkdtempSync(join(tmpdir(), 'ros-ai-first-run-'));
process.env.HOME = home;
for (const key of ['HERMES_HOME', 'PI_CODING_AGENT_DIR', 'CODEX_HOME', 'ROS_NODE_COMMAND', 'ROS_NO_DETECT', 'NOTION_TOKEN', 'ZOTERO_API_KEY']) delete process.env[key];
const bin = join(home, 'bin');
mkdirSync(bin);
for (const name of ['gh', 'sentry-cli']) { writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, name), 0o755); }
process.env.PATH = [bin, process.env.PATH].join(delimiter);
const figma = createServer((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }).end('{}'); });
await new Promise<void>(done => figma.listen(0, '127.0.0.1', done));
process.env.ROS_APP_FIGMA_URL = `http://127.0.0.1:${(figma.address() as AddressInfo).port}/mcp`;
const { appRows, detectAgents, detectApps } = await import('../src/server/setup-detect.js');
const { SetupLinks } = await import('../src/server/setup-links.js');
const { Setup } = await import('../src/server/setup.js');
const { PluginTokens } = await import('../src/server/plugins.js');
test.after(() => { figma.close(); rmSync(home, { recursive: true, force: true }); });

const DAY = 86_400_000;
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const folder = (path: string, daysAgo = 0) => { mkdirSync(path, { recursive: true }); const at = new Date(Date.now() - daysAgo * DAY); utimesSync(path, at, at); };
const config = join(home, '.config');

// Claude Code reaches Notion by address and Linear through mcp-remote in one project; Codex reaches Figma's desktop
// server and Sentry's package; Claude Desktop reaches Slack and VS Code GitHub. Every secret here must stay unread.
write(join(home, '.claude.json'), JSON.stringify({
  oauthAccount: { emailAddress: 'secret-account@example.com' },
  mcpServers: { docs: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer secret-notion' } } },
  projects: { '/work/app': { mcpServers: { tracker: { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse'] } } } },
}));
write(join(home, '.codex', 'config.toml'), [
  '[mcp_servers.design]', 'url = "http://127.0.0.1:3845/mcp"', '',
  '[mcp_servers.errors]', 'command = "npx"', 'args = ["-y", "@sentry/mcp-server@latest"]', 'env = { SENTRY_ACCESS_TOKEN = "secret-sentry" }', '',
].join('\n'));
write(join(config, 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { team: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: 'xoxb-secret' } } } }));
write(join(config, 'Code', 'User', 'mcp.json'), JSON.stringify({ servers: { code: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } }));
// The apps' own folders, with the dates their last use left; sentry-cli and gh are signed in (files never opened).
folder(join(config, 'Notion'));
folder(join(config, 'Linear'), 3);
folder(join(config, 'Slack'), 20);
folder(join(config, 'Figma'), 90);
folder(join(config, 'obsidian'), 1);
write(join(home, 'Zotero', 'zotero.sqlite'), '');
utimesSync(join(home, 'Zotero', 'zotero.sqlite'), new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY));
write(join(home, '.sentryclirc'), '[auth]\ntoken=secret-sentry-cli\n');
write(join(config, 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: secret-gh\n');

test('the scan finds apps from their folders, when they were last used and which agents already reach them, and reads no secret', async () => {
  const agents = detectAgents();
  assert.deepEqual(agents.find(agent => agent.id === 'claude-code')!.reach, ['notion', 'linear']);
  assert.deepEqual(agents.find(agent => agent.id === 'codex')!.reach, ['figma', 'sentry']);
  const apps = await detectApps(agents), app = (id: string) => apps.find(item => item.id === id)!;
  const row = (id: string) => { const item = app(id); return [item.signals, item.used, item.usedBy, item.connect, item.suggested]; };
  assert.deepEqual(row('notion'), [['app'], 'today', ['Claude Code'], 'sign-in', true]);
  assert.deepEqual(row('linear'), [['app'], 'this week', ['Claude Code'], 'sign-in', true]);
  assert.deepEqual(row('sentry'), [['app', 'settings file'], null, ['Codex'], 'sign-in', true]);
  assert.deepEqual(row('figma'), [['app', 'server on'], null, ['Codex'], 'desktop', true]);
  assert.equal(app('figma').running, true);
  // Apps that take a token are never switched on, however recently they were used.
  assert.deepEqual(row('slack'), [['app'], 'this month', ['Claude Desktop'], 'token', false]);
  assert.deepEqual(row('zotero'), [['app'], null, [], 'token', false]);
  assert.deepEqual(row('github'), [['signed in on the command line'], null, ['VS Code'], 'token', false]);
  assert.deepEqual(row('obsidian'), [['app'], 'this week', [], null, false]);
  assert.doesNotMatch(JSON.stringify({ agents, apps }), /secret/u);

  // The screen lists what was found; an app already connected shows as connected and is not offered again.
  const rows = appRows(apps, new Set(['notion']));
  assert.deepEqual(rows.map(item => item.id), ['notion', 'linear', 'sentry', 'figma', 'slack', 'zotero', 'github', 'obsidian']);
  assert.deepEqual([rows[0].connected, rows[0].suggested], [true, false]);
});

test('a Figma desktop server that does not answer is found but not switched on', async () => {
  const saved = process.env.ROS_APP_FIGMA_URL;
  process.env.ROS_APP_FIGMA_URL = 'http://127.0.0.1:9/mcp';
  try {
    const figmaRow = (await detectApps(detectAgents())).find(item => item.id === 'figma')!;
    assert.deepEqual([figmaRow.signals, figmaRow.running, figmaRow.suggested], [['app'], false, false]);
  } finally { process.env.ROS_APP_FIGMA_URL = saved; }
});

test('Reset onboarding undoes only what this ros.ai recorded and shows the first-run screen again', async () => {
  const dataDir = join(home, 'data'), bridge = join(dataDir, 'bin', 'ros-ai-mcp.mjs');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Cursor is on this computer with a server of its own; ros.ai links it and records the link.
  const cursorConfig = join(home, '.cursor', 'mcp.json');
  write(cursorConfig, JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }));
  const linked = await new SetupLinks(dataDir).link(detectAgents().find(agent => agent.id === 'cursor')!, bridge);
  assert.equal(linked.ok, true);
  const plugins = new PluginTokens(dataDir);
  plugins.save('slack', { token: 'xoxb-secret-token-1' });
  const disconnected: string[] = [];
  let signedOut = false;
  const setup = new Setup({
    dataDir, plugins,
    outside: { bridge, seen: () => undefined } as never,
    inference: { statuses: () => [] } as never,
    credentials: { statuses: () => [] } as never,
    cloud: { status: async () => ({ available: true, state: 'signed-in' }), signedIn: true, signOut: async () => { signedOut = true; return { available: true, state: 'signed-out' }; } } as never,
    apps: { statuses: () => [{ id: 'notion', name: 'Notion', connected: true }, { id: 'github', name: 'GitHub', connected: true }, { id: 'linear', name: 'Linear', connected: false }], disconnect: (id: string) => { disconnected.push(id); } } as never,
    readiness: () => ({ notion: 'ready', slack: 'ready' }),
  });
  const before = await setup.status(true);
  assert.equal(before.show, true);
  assert.deepEqual(before.apps.filter(item => item.connected).map(item => item.id), ['notion', 'slack']);
  assert.equal(before.agents.find(agent => agent.id === 'cursor')!.entry, true);
  assert.equal('reach' in before.agents[0]!, false, 'what agents reach stays on the server');
  assert.match(before.lookedAt.join(' '), /names and addresses of their servers/u);
  setup.seen(true);
  assert.equal((await setup.status()).show, false);

  // GitHub connects with a Plugins token, so it goes with the tokens, not with the sign-ins.
  assert.deepEqual(setup.resetPlan(), { links: ['Cursor'], apps: ['Notion'], tokens: ['Slack'], cloud: true });
  const reset = await setup.reset({ links: true, apps: true, tokens: true, cloud: true });
  assert.deepEqual(reset, { done: ['Removed from Cursor.', 'Disconnected Notion.', 'Forgot the Slack token.', 'Signed out of hosted Ros.'], failed: [] });
  assert.deepEqual(JSON.parse(readFileSync(cursorConfig, 'utf8')), { mcpServers: { mine: { command: 'mine' } } });
  assert.deepEqual(new SetupLinks(dataDir).records(), []);
  assert.deepEqual([disconnected, plugins.saved(), signedOut], [['notion'], [], true]);
  const after = await setup.status();
  assert.deepEqual([after.seenAt, after.show], [null, true]);

  // A reset with nothing chosen only brings the screen back, and a copy that recorded no link removes none.
  write(cursorConfig, JSON.stringify({ mcpServers: { 'ros-ai': { command: 'node', args: ['/elsewhere/ros-ai-mcp.mjs'] } } }));
  setup.seen(true);
  assert.deepEqual(await setup.reset({ links: true }), { done: [], failed: [] });
  assert.equal(existsSync(cursorConfig) && JSON.parse(readFileSync(cursorConfig, 'utf8')).mcpServers['ros-ai'].args[0], '/elsewhere/ros-ai-mcp.mjs');
  assert.equal((await setup.status()).seenAt, null);
});
