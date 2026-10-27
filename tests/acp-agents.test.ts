import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { Authority } from '../src/server/authority.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import type { SearchAdapter } from '../src/server/providers.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AssistantService } from '../src/server/assistant.js';
import { AcpAgentService, CLAUDE_CODE_READ, acpInstructions, attachAcpAgentRoutes, gooseAlwaysAllowed } from '../src/server/acp-agent.js';
import { CLAUDE_CODE_INSTRUCTIONS } from '../src/server/agent-prompt.js';
import type { AgentEvent } from '../src/shared/agent-runtime.js';
import type { AcpAgentId } from '../src/shared/acp-agents.js';

const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'tests', 'fixtures', 'fake-acp-agent.mjs');
type Report = { argv: string[]; cwd: string; env: Record<string, string>; requests: string[]; mcp: Record<string, unknown>[]; files: { path: string; content?: string; error?: { message: string } }[]; permissions: { tool: string; answer: { outcome?: { outcome: string; optionId?: string }; error?: { message: string } } }[]; modes: string[]; cancelled: boolean; prompts: string[]; session?: { cwd: string; mcpServers: Record<string, unknown>[] } };

/** A project with a folder, a fake agent binary per name, and ros.ai's per-turn MCP endpoint on a loopback port. */
async function workspace(options: { env?: Record<string, string>; fake?: Record<string, string> } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ros-acp-'))), data = join(base, 'data'), folder = join(base, 'project'), bin = join(base, 'bin');
  for (const dir of [data, folder, bin, join(folder, 'notes')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(folder, 'notes', 'question.md'), 'line one\nline two\nline three\n');
  writeFileSync(join(base, 'secret.txt'), 'outside the folder\n');
  symlinkSync(join(base, 'secret.txt'), join(folder, 'linked.txt'));
  const binaries = Object.fromEntries((['gemini', 'goose', 'opencode'] as AcpAgentId[]).map(id => { const file = join(bin, id); copyFileSync(fixture, file); chmodSync(file, 0o755); return [id, file]; })) as Record<AcpAgentId, string>;
  const store = new Store(data), execution = new ExecutionService(store, { includeSetupUsage: false });
  let stopped = false;
  const experiments = { authority: { policy: () => ({ stopped, mode: 'review' }) } } as unknown as ExperimentService;
  const project = store.createProject('ACP agents'), info = statSync(folder);
  store.saveRecord('project-folder', project.id, project.id, { projectId: project.id, path: folder, device: info.dev, inode: info.ino, attachedAt: new Date().toISOString(), files: {}, outputs: {} });
  store.mutate(project.id, [{ type: 'addNode', node: { id: 'question', title: 'Question', description: 'What is known?', x: 0, y: 0, kind: 'topic' } }], 'Add question');
  const service = new AcpAgentService(store, execution, experiments, { dataDir: data, root, binaries });
  const app = express(); app.use(express.json()); attachAcpAgentRoutes(app, service);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  service.listen((server.address() as AddressInfo).port);
  const reportFile = join(base, 'report.json');
  const saved: Record<string, string | undefined> = {};
  const set = (values: Record<string, string>) => { for (const [key, value] of Object.entries(values)) { if (!(key in saved)) saved[key] = process.env[key]; process.env[key] = value; } };
  set({ XDG_CONFIG_HOME: join(base, 'config'), ...options.env });
  // The fake agent's own script, which it reads on every start.
  let script: Record<string, string> = {};
  const fake = (values: Record<string, string>) => { script = { ...script, ...values }; writeFileSync(join(bin, 'fake-acp.json'), JSON.stringify(script)); };
  fake({ REPORT: reportFile, ...options.fake });
  return {
    base, folder, data, store, execution, service, project, set, fake, stop: (value: boolean) => { stopped = value; },
    report: () => JSON.parse(readFileSync(reportFile, 'utf8')) as Report,
    run: (agent: AcpAgentId, message = 'What is on the map?', signal = new AbortController().signal) => { const events: AgentEvent[] = []; return { events, done: service.execute({ agent, projectId: project.id, nodeIds: ['question'], artifactIds: [], turnId: `turn-${Math.random()}`, message, signal, onEvent: event => events.push(event) }) }; },
    async close() { await service.shutdown(); await execution.shutdown(); await new Promise(done => server.close(done)); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(base, { recursive: true, force: true }); },
  };
}

test('The instructions name each agent\'s own read tools, from the unchanged Claude Code text', () => {
  assert(CLAUDE_CODE_INSTRUCTIONS.includes(CLAUDE_CODE_READ), 'the folder line the agents replace is still in the frozen prompt');
  assert.match(acpInstructions('gemini'), /Read them with your own read, list and search tools; your other tools are off/u);
  assert.match(acpInstructions('goose'), /reading files included: read blocks with ros_read_canvas and ros_read_selected/u);
  for (const id of ['gemini', 'goose', 'opencode'] as const) assert(!acpInstructions(id).includes(CLAUDE_CODE_READ));
});

test('Goose\'s always-allowed tools are read from its permission.yaml, and anything unexpected counts as unreadable', () => {
  assert.deepEqual(gooseAlwaysAllowed('user:\n  always_allow:\n  - developer__shell\n  - rosai__ros_read_canvas\n  ask_before: []\n  never_allow: []\nsmart_approve:\n  always_allow:\n  - other__tool\n'), ['developer__shell', 'rosai__ros_read_canvas']);
  assert.deepEqual(gooseAlwaysAllowed('user:\n  always_allow: []\n  ask_before:\n  - developer__shell\n'), []);
  assert.deepEqual(gooseAlwaysAllowed('user:\n  always_allow: [developer__shell, "memory__remember"]\n'), ['developer__shell', 'memory__remember']);
  assert.deepEqual(gooseAlwaysAllowed(''), []);
  assert.equal(gooseAlwaysAllowed('user: {always_allow: [developer__shell]}\n'), null);
  assert.equal(gooseAlwaysAllowed('user:\n  always_allow:\n    developer__shell: true\n'), null);
});

test('A Gemini CLI turn runs locked down from ros.ai\'s own folder, with only ros.ai\'s tools, reads checked by ros.ai, and its own tools refused', async () => {
  const f = await workspace({ env: { GEMINI_API_KEY: 'gemini-own-key', OPENAI_API_KEY: 'sk-ros-ai-saved', NEBIUS_API_KEY: 'ros-ai-saved' } });
  try {
    f.fake({ FILES: JSON.stringify([join(f.folder, 'notes', 'question.md'), join(f.folder, 'linked.txt'), join(f.folder, '..', 'secret.txt'), join(f.base, 'secret.txt'), 'notes/question.md']) });
    const { events, done } = f.run('gemini');
    const result = await done, report = f.report();
    assert.equal(result.reply, 'The map has blocks to work with.', 'the answer is what the agent wrote after its last ros.ai tool call');
    assert.equal(result.model, 'fake-model-1');
    // Launched with the admin policy, ros.ai's MCP server only, and no extensions.
    const policy = report.argv[report.argv.indexOf('--admin-policy') + 1]!;
    assert.deepEqual(report.argv.filter(arg => arg !== policy), ['--acp', '--admin-policy', '--allowed-mcp-server-names', 'rosai', '--extensions', 'none', '--approval-mode', 'default']);
    assert.match(policy, /gemini-policy-[0-9a-f]{16}\.toml$/u);
    const toml = readFileSync(policy, 'utf8');
    assert.match(toml, /toolName = "\*"\ndecision = "deny"\npriority = 900/u);
    // ros.ai's tools by their full names, which Gemini CLI matches however it names the server.
    assert.match(toml, /toolName = \["mcp_rosai_ros_read_canvas", "mcp_rosai_ros_read_selected", "mcp_rosai_ros_propose_canvas"[^\]]*\]\ndecision = "allow"\npriority = 999/u);
    assert(!toml.includes('mcpName'));
    assert.match(toml, /argsPattern = '\[\/\\\\"\]\\\.env'\ndecision = "deny"\npriority = 960/u);
    assert.equal(statSync(policy).mode & 0o777, 0o600);
    // It works from ros.ai's own folder, trusted so it starts ros.ai's MCP server, with the project folder in its workspace.
    const own = join(f.data, 'acp', 'gemini', f.project.id);
    assert.equal(report.cwd, own); assert.equal(report.session!.cwd, own);
    assert.deepEqual(JSON.parse(readFileSync(join(own, '.gemini', 'settings.json'), 'utf8')), { context: { includeDirectories: [f.folder], loadMemoryFromIncludeDirectories: true } });
    assert.equal(report.env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
    // The agent's own sign-in comes along; keys saved in ros.ai do not.
    assert.equal(report.env.GEMINI_API_KEY, 'gemini-own-key');
    assert.equal(report.env.OPENAI_API_KEY, undefined); assert.equal(report.env.NEBIUS_API_KEY, undefined);
    // ros.ai's tools over this turn's own HTTP endpoint.
    assert.deepEqual(report.session!.mcpServers, [{ type: 'http', name: 'rosai', url: `http://127.0.0.1:${(f.service as unknown as { port: number }).port}/mcp/turn`, headers: [{ name: 'Authorization', value: 'Bearer <token>' }] }]);
    const tools = (report.mcp.find(item => 'tools' in item)!.tools as string[]);
    assert(tools.includes('ros_read_canvas') && tools.includes('ros_propose_canvas'));
    assert.match(String(report.mcp.find(item => item.call === 'ros_read_canvas')!.result), /"title":"Question"/u);
    assert.deepEqual(report.mcp.find(item => item.call === 'run_shell_command')!.result, { content: [{ type: 'text', text: 'ros.ai has no tool named run_shell_command.' }], isError: true });
    // Reads: inside the folder by its real path only, line and limit honoured.
    assert.deepEqual(report.files.map(file => file.content ?? file.error!.message), ['line one\nline two', 'Only files inside this project folder can be read.', 'Only files inside this project folder can be read.', 'Only files inside this project folder can be read.', 'Only files inside this project folder can be read.']);
    // Its own tool and file writes are refused; reject_once is chosen from Gemini CLI's own options.
    assert.deepEqual(report.permissions.find(item => item.tool === 'shell')!.answer, { outcome: { outcome: 'selected', optionId: 'cancel' } });
    assert.match(report.permissions.find(item => item.tool === 'write')!.answer.error!.message, /does not let agents write files/u);
    assert(events.some(event => event.type === 'approval' && /Refused Gemini CLI’s request to use Shell: rm -rf build/u.test(event.message)));
    assert(events.some(event => event.type === 'tool' && event.message === 'Gemini CLI requested ros_read_canvas.'));
    // Its own reads show as steps by their place in the folder; its calls to ros.ai's tools are not shown twice.
    assert(events.some(event => event.type === 'progress' && event.message === 'Gemini CLI read notes/question.md.'));
    assert(!events.some(event => event.type === 'progress' && /asked to use/u.test(event.message)));
    assert(events.some(event => event.type === 'thought' && event.message === 'I will read the map first.'), 'the text before a tool call is its reason');
    assert(events.some(event => event.type === 'usage' && /1,234 tokens/u.test(event.message)));
    assert(events.some(event => event.type === 'progress' && /opened a session with fake-model-1\. Only ros\.ai’s tools and reading the project folder are on\./u.test(event.message)));
    assert.match(report.prompts[0]!, /Read them with your own read, list and search tools/u);
    assert(report.prompts[0]!.includes(`The project folder is in your workspace: ${f.folder}\nUse full paths to read its files.`));
    assert.match(report.prompts[0]!, /Researcher's message:\nWhat is on the map\?$/u);
    // Saved: the attempt, and a session the next turn can continue.
    const attempt = f.store.records<{ status: string; mcp: string; agent: string }>('acp-attempt', f.project.id)[0]!;
    assert.deepEqual([attempt.status, attempt.mcp, attempt.agent], ['completed', 'http', 'gemini']);
    assert.equal(f.store.record<{ state: string }>('acp-session', f.project.id)!.state, 'ready');
  } finally { await f.close(); }
});

test('An agent that answers again after a turn ended reaches nothing: the turn\'s endpoint is gone', async () => {
  const f = await workspace();
  try {
    await f.run('gemini').done;
    const port = (f.service as unknown as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp/turn`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(64)}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(response.status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp/turn`)).status, 405);
  } finally { await f.close(); }
});

test('OpenCode runs as a locked ros-ai agent without the project\'s own config, through the stdio bridge when it has no HTTP MCP', async () => {
  const f = await workspace({ fake: { HTTP: '0', MODES: 'build,plan,ros-ai', CONFIG_OPTIONS: '1' }, env: { OPENCODE_CONFIG_CONTENT: '{"agent":{"build":{"permission":{"*":"allow"}}}}', OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_DISABLE_PROJECT_CONFIG: '0', OPENCODE_SERVER_PASSWORD: 'own' } });
  try {
    const { events, done } = f.run('opencode');
    const result = await done, report = f.report();
    assert.equal(result.reply, 'The map has blocks to work with.');
    assert.deepEqual(report.argv, ['acp']);
    const config = JSON.parse(report.env.OPENCODE_CONFIG_CONTENT!);
    assert.equal(config.default_agent, 'ros-ai');
    const permission = config.agent['ros-ai'].permission;
    assert.equal(Object.keys(permission)[0], '*'); assert.equal(permission['*'], 'deny');
    assert.deepEqual([permission.read['*'], permission.read['*.env'], permission.external_directory, permission.rosai_ros_read_canvas, permission.bash], ['allow', 'deny', 'deny', 'allow', undefined]);
    assert.equal(report.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    assert.equal(report.env.OPENCODE_PERMISSION, undefined, 'the person\'s permission override is not passed on');
    assert.equal(report.env.OPENCODE_SERVER_PASSWORD, 'own');
    assert.deepEqual(report.modes, ['ros-ai'], 'the turn switched to the locked agent before the prompt, through its session config option');
    assert.equal(result.model, 'fake/fake-model-1');
    assert.equal(report.mcp[0]!.transport, 'stdio');
    const bridge = report.session!.mcpServers[0] as { command: string; args: string[]; env: { name: string; value: string }[] };
    assert.equal(bridge.command, process.execPath); assert.deepEqual(bridge.args, [join(root, 'scripts', 'ros-ai-mcp.mjs')]);
    assert.deepEqual(bridge.env.map(item => item.name), ['ROS_AI_MCP_URL', 'ROS_AI_MCP_TOKEN']);
    assert.match(String(report.mcp.find(item => item.call === 'ros_read_canvas')!.result), /"title":"Question"/u, 'the bridge reached this turn\'s tools');
    assert(events.some(event => event.type === 'tool' && event.message === 'OpenCode requested ros_read_canvas.'));
  } finally { await f.close(); }
});

test('OpenCode without ros.ai\'s ros-ai agent stops before any prompt is sent', async () => {
  const f = await workspace({ fake: { MODES: 'build,plan' } });
  try {
    await assert.rejects(f.run('opencode').done, /OpenCode did not load ros\.ai’s ros-ai agent, so ros\.ai stopped before sending anything/u);
    assert.deepEqual(f.report().prompts, []);
    assert.equal(f.store.records<{ status: string }>('acp-attempt', f.project.id)[0]!.status, 'failed');
    // An agent that does not take the switch gets no prompt either.
    f.fake({ MODES: 'build,ros-ai', CONFIG_OPTIONS: '1', STUCK: '1' });
    await assert.rejects(f.run('opencode').done, /OpenCode stayed in its build mode instead of ros-ai, so ros\.ai stopped before sending anything/u);
    assert.deepEqual(f.report().prompts, []);
  } finally { await f.close(); }
});

test('Goose runs in approve mode: ros.ai allows its own tools by exact name, refuses look-alikes, and will not run Goose with always-allowed tools', async () => {
  const f = await workspace({ fake: { GOOSE: '1', MODES: 'auto,approve,smart_approve,chat' }, env: { GOOSE_MODE: 'auto', GOOSE_PROVIDER: 'ollama' } });
  try {
    const { events, done } = f.run('goose');
    await done;
    const report = f.report();
    assert.equal(report.env.GOOSE_MODE, 'approve'); assert.equal(report.env.GOOSE_PROVIDER, 'ollama');
    assert.deepEqual(report.modes, ['approve']);
    assert.deepEqual(report.permissions.find(item => item.tool === 'rosai__ros_read_canvas')!.answer, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
    assert.deepEqual(report.permissions.find(item => item.tool === 'developer__shell')!.answer, { outcome: { outcome: 'selected', optionId: 'reject_once' } });
    assert(events.some(event => event.type === 'progress' && /Only ros\.ai’s tools are on\./u.test(event.message)));
    assert.match(report.prompts[0]!, /reading files included/u);
    // Tools set to "Always allow" in Goose would run without asking: ros.ai says so and does not start it.
    mkdirSync(join(f.base, 'config', 'goose'), { recursive: true });
    writeFileSync(join(f.base, 'config', 'goose', 'permission.yaml'), 'user:\n  always_allow:\n  - developer__shell\n  - rosai__ros_read_canvas\n  ask_before: []\n');
    const status = (await f.service.statuses(true)).find(item => item.id === 'goose')!;
    assert.match(status.blocker!, /Goose is set to always allow developer__shell, and would run it without asking/u);
    assert.equal(f.service.readiness(f.project.id, 'goose').available, false);
    await assert.rejects(f.run('goose').done, /always allow developer__shell/u);
  } finally { await f.close(); }
});

test('Stopping a turn cancels the agent and keeps the attempt as interrupted; a check opens a session without a prompt', async () => {
  const f = await workspace({ fake: { SCENARIO: 'slow' } });
  try {
    const controller = new AbortController(), { events, done } = f.run('gemini', 'Take your time.', controller.signal);
    while (!events.some(event => event.type === 'delta')) await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(done, /Gemini CLI was stopped\./u);
    assert.equal(f.report().cancelled, true);
    assert.equal(f.store.records<{ status: string }>('acp-attempt', f.project.id)[0]!.status, 'interrupted');
    // A check starts the agent and opens a session, and sends no prompt.
    f.fake({ SCENARIO: 'turn' });
    const checked = await f.service.check('gemini');
    assert.equal(checked.checked!.ok, true);
    assert.match(checked.checked!.detail, /^Fake agent 1\.0\.0 started and opened a session with fake-model-1 in its default mode\. It reached ros\.ai’s tools\. No prompt was sent\.$/u);
    assert(!f.report().requests.includes('session/prompt'));
    // A sign-in error says what to do, in the agent's own terms.
    f.fake({ SCENARIO: 'auth-error' });
    const failed = await f.service.check('gemini');
    assert.equal(failed.checked!.ok, false);
    assert.match(failed.checked!.detail, /^Gemini CLI is not signed in: Authentication required Run gemini once in a terminal/u);
    assert.match(f.service.readiness(f.project.id, 'gemini').reason!, /Then press Check under Agents › Gemini CLI\./u);
  } finally { await f.close(); }
});

test('A Gemini CLI that does not reach ros.ai\'s tools while it opens a session gets no prompt, and its check says so', async () => {
  const f = await workspace({ fake: { LAZY: '1', MODES: 'build,plan,ros-ai' } });
  try {
    await assert.rejects(f.run('gemini').done, /^StoreError: Gemini CLI did not connect to ros\.ai’s tools, so ros\.ai stopped before sending anything\. Check that your Gemini CLI settings/u);
    assert.deepEqual(f.report().prompts, []);
    assert.equal(f.store.records<{ status: string }>('acp-attempt', f.project.id)[0]!.status, 'failed');
    const checked = await f.service.check('gemini');
    assert.equal(checked.checked!.ok, false);
    assert.match(checked.checked!.detail, /^Gemini CLI started but did not connect to ros\.ai’s tools\./u);
    // OpenCode may connect at its first prompt, so its check does not need the tools.
    const opencode = await f.service.check('opencode');
    assert.equal(opencode.checked!.ok, true);
    assert.match(opencode.checked!.detail, /opened a session with fake-model-1 in its ros-ai mode\. No prompt was sent\.$/u);
  } finally { await f.close(); }
});

test('An old Gemini CLI, a missing agent and a stopped project each block a turn before anything starts', async () => {
  const f = await workspace({ fake: { HELP: 'Options:\n  --experimental-acp' } });
  try {
    // ros.ai looks at an agent in the background; a turn asked for before that look waits for it and stops on what it finds.
    assert.equal(f.service.readiness(f.project.id, 'gemini').available, true);
    await assert.rejects(f.run('gemini').done, /This Gemini CLI is too old for ros\.ai/u);
    assert(!existsSync(join(f.base, 'report.json')), 'it never started a session');
    assert.match(f.service.readiness(f.project.id, 'gemini').reason!, /This Gemini CLI is too old for ros\.ai: it has no --acp, --admin-policy, --allowed-mcp-server-names, --extensions option/u);
    const missing = new AcpAgentService(f.store, f.execution, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { dataDir: f.data, root, binaries: { goose: join(f.base, 'no-such-goose') } });
    assert.deepEqual(await missing.status('goose'), { id: 'goose', label: 'Goose', installed: false, path: null, version: null, checked: null, blocker: 'Goose is not installed on this computer.' });
    assert.match(missing.readiness(f.project.id, 'goose').reason!, /not installed on this computer\. Install it from Agents › Goose\./u);
    f.stop(true);
    assert.match(f.service.readiness(f.project.id, 'opencode').reason!, /Project research is stopped/u);
  } finally { await f.close(); }
});

test('Ros runs as an ACP agent from the assistant: the turn names the agent and its model, and the block says who made it', async () => {
  const f = await workspace();
  const assistant = new AssistantService(f.store, f.execution, { authority: { policy: () => ({ stopped: false, mode: 'review' }) } } as unknown as ExperimentService, undefined, undefined, undefined, undefined, undefined, f.service);
  try {
    assert.equal(assistant.setBackend(f.project.id, { backend: 'opencode' }).backend, 'opencode');
    assert.equal(assistant.setBackend(f.project.id, { backend: 'gemini' }).modelAvailable, true);
    assert.throws(() => assistant.setBackend(f.project.id, { backend: 'cursor' }));
    const started = assistant.start(f.project.id, { message: 'What is on the map?' });
    const turnId = started.activeTurnId!;
    assert.equal(started.turns.find(turn => turn.id === turnId)!.source, 'acp-agent');
    let turn = assistant.state(f.project.id).turns.find(item => item.id === turnId)!;
    for (let tries = 0; turn.status === 'running' && tries < 200; tries++) { await new Promise(resolve => setTimeout(resolve, 25)); turn = assistant.state(f.project.id).turns.find(item => item.id === turnId)!; }
    assert.equal(turn.status, 'completed', turn.error);
    assert.equal(turn.reply, 'The map has blocks to work with.');
    assert.deepEqual([turn.model, turn.destination, turn.location], ['Gemini CLI · fake-model-1', 'the provider Gemini CLI is signed in to', 'external']);
    assert.equal(turn.events[0]!.message, 'Starting Gemini CLI on this computer with its own sign-in.');
  } finally { await assistant.shutdown(); await f.close(); }
});

test('A web search plan from an ACP agent adds its Agent block under that agent\'s name', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-acp-plan-')), store = new Store(directory);
  const search: SearchAdapter = { configured: true, async search(query) { return { results: [{ title: 'A page', url: `https://example.org/${encodeURIComponent(query)}`, content: 'A passage.', locator: 'Search result 1' }], credits: 1, requestId: null }; } };
  const execution = new ExecutionService(store, { search, includeSetupUsage: false });
  try {
    const project = store.createProject('ACP search plan');
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'question', title: 'Question', description: 'What is known?', x: 0, y: 0, kind: 'topic' } }], 'Add question');
    const authority = new Authority(store);
    authority.configure(project.id, { mode: 'full' });
    const tools = new AgentWorkspaceTools(store, execution, { authority } as unknown as ExperimentService, { projectId: project.id, nodeIds: ['question'], artifactIds: [] }, 'turn-gemini', 'gemini', 'Gemini CLI');
    const plan = await tools.call('ros_fan_out_search', { goal: 'What is known?', rationale: 'To find out.', directions: [{ title: 'Basics', why: 'Start there', queries: ['what is known'] }] }) as { status: string };
    assert.equal(plan.status, 'accepted');
    assert.deepEqual(store.getProject(project.id).canvas.nodes.find(node => node.blockType === 'agent')?.agent, { runtime: 'gemini', turnId: 'turn-gemini' });
  } finally {
    await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('A web search plan starts without asking about cost, even under Ask every time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-plan-ask-')), store = new Store(directory);
  const searched: string[] = [];
  const search: SearchAdapter = { configured: true, async search(query) { searched.push(query); return { results: [{ title: 'A page', url: 'https://example.org/a', content: 'A passage.', locator: 'Search result 1' }], credits: 1, requestId: null }; } };
  const execution = new ExecutionService(store, { search, includeSetupUsage: false });
  try {
    const project = store.createProject('Plan under ask');
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'question', title: 'Question', description: 'What is known?', x: 0, y: 0, kind: 'topic' } }], 'Add question');
    const authority = new Authority(store);
    authority.configure(project.id, { mode: 'ask' });
    const tools = new AgentWorkspaceTools(store, execution, { authority } as unknown as ExperimentService, { projectId: project.id, nodeIds: ['question'], artifactIds: [] }, 'turn-ask', 'model', 'Test model');
    const plan = await tools.call('ros_fan_out_search', { goal: 'What is known?', rationale: 'To find out.', directions: [{ title: 'Basics', why: 'Start there', queries: ['what is known'] }] }) as { status: string };
    assert.equal(plan.status, 'accepted');
    assert.deepEqual(searched, ['what is known']);
    const proposal = store.detail(project.id).proposals.at(-1)!;
    assert.equal(proposal.status, 'accepted');
    assert.doesNotMatch(proposal.summary, /US\$/u);
  } finally {
    await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
