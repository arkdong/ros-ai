import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

// Pi and Hermes Agent link to ros.ai through their own settings, like Claude Code and Codex. The scan reads a
// home folder made here, so HOME is set before the setup code loads. Set ROS_TEST_PI and ROS_TEST_HERMES to the
// agents' binaries (npm install -g @earendil-works/pi-coding-agent; pip install hermes-agent[mcp]) to link the
// real ones to a real ros.ai MCP endpoint and have each list ros.ai's tools: no model runs and nothing is billed.
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'ros-ai-agent-links-'));
process.env.HOME = home;
for (const key of ['HERMES_HOME', 'PI_CODING_AGENT_DIR', 'ROS_NODE_COMMAND', 'ROS_NO_DETECT']) delete process.env[key];
const { detectAgents, yamlServers } = await import('../src/server/setup-detect.js');
const { SetupLinks, linkCommand } = await import('../src/server/setup-links.js');
const { OutsideAgents, attachOutsideAgentRoutes, clientLabel } = await import('../src/server/outside-agents.js');
const { Store } = await import('../src/server/store.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

const piDir = join(home, '.pi', 'agent'), hermesDir = join(home, '.hermes');
const found = (id: string) => detectAgents().find(agent => agent.id === id)!;
const hermesConfig = `model:
  default: anthropic/claude-sonnet-4.6
  provider: openrouter
# Servers Hermes Agent connects to
mcp_servers:
  github:
    command: npx
    args:
    - -y
    - '@modelcontextprotocol/server-github'
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ghp_not_read
  "docs site":
    url: https://example.com/mcp
    enabled: false
toolsets:
- hermes-cli
`;

test('Pi and Hermes Agent are found from their own folders, reading only the names of their MCP servers', () => {
  assert.equal(found('pi').found, false);
  assert.equal(found('hermes').found, false);
  mkdirSync(join(piDir, 'sessions'), { recursive: true });
  writeFileSync(join(piDir, 'auth.json'), '{"anthropic":{"type":"oauth","access":"not-read"}}');
  writeFileSync(join(piDir, 'mcp.json'), JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_KEY: 'not-read' } } } }));
  mkdirSync(hermesDir, { recursive: true });
  writeFileSync(join(hermesDir, 'config.yaml'), hermesConfig);
  writeFileSync(join(hermesDir, 'auth.json'), '{"providers":{}}');
  const pi = found('pi'), hermes = found('hermes');
  assert.deepEqual([pi.found, pi.method, pi.target, pi.servers, pi.entry, pi.signedIn], [true, 'file', join(piDir, 'mcp.json'), ['context7'], false, true]);
  assert.deepEqual(pi.signals.slice(0, 2), ['used recently', 'signed in']);
  assert.deepEqual([hermes.found, hermes.method, hermes.target, hermes.servers, hermes.entry, hermes.sessionLabel], [true, 'cli', join(hermesDir, 'config.yaml'), ['github', 'docs site'], false, 'Hermes Agent']);
  assert.doesNotMatch(JSON.stringify(detectAgents()), /not-read|ghp_/u);
});

test('Hermes Agent\'s settings are read where its command line reads them: an active profile, or HERMES_HOME', () => {
  assert.equal(yamlServers(join(home, 'missing.yaml')), null);
  const file = join(home, 'empty.yaml');
  writeFileSync(file, 'mcp_servers: {}\nmodel:\n  default: x\n');
  assert.deepEqual(yamlServers(file), []);
  writeFileSync(file, 'mcp_servers:\n    ros-ai:\n        command: node\n        args: ["/b.mjs", "--client=hermes"]\n    \'quoted name\': {url: "https://x"}\n');
  assert.deepEqual(yamlServers(file), ['ros-ai', 'quoted name']);
  mkdirSync(join(hermesDir, 'profiles', 'coder'), { recursive: true });
  writeFileSync(join(hermesDir, 'profiles', 'coder', 'config.yaml'), 'mcp_servers:\n  ros-ai:\n    command: node\n');
  writeFileSync(join(hermesDir, 'active_profile'), 'coder\n');
  assert.deepEqual([found('hermes').target, found('hermes').entry], [join(hermesDir, 'profiles', 'coder', 'config.yaml'), true]);
  // A profile Hermes Agent cannot open is not followed; HERMES_HOME pointing at a profile wins.
  writeFileSync(join(hermesDir, 'active_profile'), 'gone\n');
  assert.equal(found('hermes').target, join(hermesDir, 'config.yaml'));
  process.env.HERMES_HOME = join(hermesDir, 'profiles', 'coder');
  try { assert.equal(found('hermes').target, join(hermesDir, 'profiles', 'coder', 'config.yaml')); } finally { delete process.env.HERMES_HOME; }
  rmSync(join(hermesDir, 'active_profile'));
});

test('Linking Pi adds one ros-ai entry that lists ros.ai\'s tools as Pi\'s own, and Undo removes only that entry', async () => {
  const links = new SetupLinks(mkdtempSync(join(home, 'data-'))), bridge = '/data/bin/ros-ai-mcp.mjs';
  assert.equal(linkCommand('pi', bridge), '"ros-ai": { "command": "node", "args": ["/data/bin/ros-ai-mcp.mjs"], "exposure": "direct" }');
  assert.equal(linkCommand('hermes', bridge), 'hermes mcp add ros-ai --command node --args "/data/bin/ros-ai-mcp.mjs" --client=hermes');
  const linked = await links.link(found('pi'), bridge);
  assert.equal(linked.ok, true, linked.message);
  const written = JSON.parse(readFileSync(join(piDir, 'mcp.json'), 'utf8'));
  assert.deepEqual(written.mcpServers['ros-ai'], { command: 'node', args: [bridge], exposure: 'direct' });
  assert.equal(written.mcpServers.context7.env.CONTEXT7_KEY, 'not-read');
  assert.ok(existsSync(join(piDir, 'mcp.json.ros-ai-backup')));
  assert.equal(found('pi').entry, true);
  const undone = await links.unlink(found('pi'));
  assert.equal(undone.ok, true, undone.message);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(piDir, 'mcp.json'), 'utf8')).mcpServers), ['context7']);
});

test('Sessions are named after the agent: Pi from its client\'s name, Hermes Agent from the name its link gives the bridge', () => {
  assert.equal(clientLabel({ name: 'pi', version: '1.4.0' }), 'Pi');
  assert.equal(clientLabel({ name: 'mcp', version: '0.1.0' }, 'hermes'), 'Hermes Agent');
  assert.equal(clientLabel({ name: 'mcp', version: '0.1.0' }), 'mcp');
  assert.equal(clientLabel({ name: 'claude-code' }, 'hermes'), 'Claude Code');
  assert.equal(clientLabel({ name: 'pipeline-runner' }), 'pipeline-runner');
  assert.equal(clientLabel({ name: 'mcp' }, 'something-else'), 'mcp');
});

/** ros.ai's MCP endpoint as the app serves it, with the bridge copied to the data folder. */
async function rosAi() {
  const dataDir = mkdtempSync(join(home, 'ros-data-')), store = new Store(dataDir);
  const outside = new OutsideAgents(store, {} as never, {} as never, {} as never, dataDir, root);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  attachOutsideAgentRoutes(app, outside);
  const server = await new Promise<ReturnType<typeof app.listen>>(done => { const listening = app.listen(0, '127.0.0.1', () => done(listening)); });
  outside.publish((server.address() as AddressInfo).port);
  return { dataDir, outside, close: () => new Promise(done => server.close(done)) };
}
/** Runs an agent's command line without blocking, so the endpoint in this process can answer it. */
const run = (binary: string, args: string[]) => new Promise<{ code: number | null; output: string }>(done => {
  execFile(binary, args, { cwd: home, timeout: 60_000, env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) } },
    (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, output: `${stdout}${stderr}` }));
});

test('The real Pi links to ros.ai and lists its tools', { skip: !process.env.ROS_TEST_PI && 'set ROS_TEST_PI to a pi binary' }, async () => {
  const ros = await rosAi();
  try {
    const linked = await new SetupLinks(ros.dataDir).link(found('pi'), ros.outside.bridge);
    assert.equal(linked.ok, true, linked.message);
    const listed = await run(process.env.ROS_TEST_PI!, ['mcp', 'list', '--json']);
    assert.equal(listed.code, 0, listed.output);
    assert.match(listed.output, /ros-ai/u);
    for (const tool of ['ros_read_canvas', 'ros_propose_canvas']) assert.match(listed.output, new RegExp(tool, 'u'));
    assert.equal(ros.outside.seen('Pi')?.label, 'Pi');
  } finally { await ros.close(); }
});

test('The real Hermes Agent links to ros.ai through its own command line, lists its tools, and unlinks', { skip: !process.env.ROS_TEST_HERMES && 'set ROS_TEST_HERMES to a hermes binary' }, async () => {
  const ros = await rosAi();
  process.env.ROS_HERMES_BINARY = process.env.ROS_TEST_HERMES;
  try {
    const links = new SetupLinks(ros.dataDir);
    const linked = await links.link(found('hermes'), ros.outside.bridge);
    assert.equal(linked.ok, true, `${linked.message} ${linked.command ?? ''}`);
    assert.deepEqual([found('hermes').entry, found('hermes').servers.sort()], [true, ['docs site', 'github']]);
    // Hermes Agent connected through the bridge before it saved, named by the link.
    assert.equal(ros.outside.seen('Hermes Agent')?.label, 'Hermes Agent');
    const tested = await run(process.env.ROS_TEST_HERMES!, ['mcp', 'test', 'ros-ai']);
    for (const tool of ['ros_read_canvas', 'ros_propose_canvas']) assert.match(tested.output, new RegExp(tool, 'u'), tested.output);
    // Linking again replaces the entry instead of being refused as a duplicate.
    assert.equal((await links.link(found('hermes'), ros.outside.bridge)).ok, true);
    const undone = await links.unlink(found('hermes'));
    assert.equal(undone.ok, true, undone.message);
    assert.deepEqual([found('hermes').entry, found('hermes').servers.sort()], [false, ['docs site', 'github']]);
  } finally { delete process.env.ROS_HERMES_BINARY; await ros.close(); }
});
