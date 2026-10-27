#!/usr/bin/env node
// A stand-in for Gemini CLI, Goose or OpenCode speaking ACP on stdio, for tests/acp-agents.test.ts. No model runs:
// each prompt follows a fixed script that uses ros.ai's MCP tools, asks to read files and to run its own tool,
// and writes everything it saw (arguments, environment, answers) to its report file. ros.ai passes an agent
// only its own environment, so the test sets this script up through fake-acp.json beside the copy it runs.
// Like Gemini CLI it connects to the MCP server while it opens a session; LAZY waits for the first prompt.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const config = (() => { try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fake-acp.json'), 'utf8')); } catch { return {}; } })();

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log(`fake-agent ${config.VERSION || '1.0.0'}`); process.exit(0); }
if (argv.includes('--help')) { console.log(config.HELP ?? 'Options:\n  --acp\n  --admin-policy\n  --allowed-mcp-server-names\n  --extensions\n  --approval-mode'); process.exit(0); }

const report = { argv, cwd: process.cwd(), env: process.env, requests: [], mcp: [], files: [], permissions: [], modes: [], cancelled: false, prompts: [] };
const save = () => { if (config.REPORT) writeFileSync(config.REPORT, JSON.stringify(report, null, 2)); };
save();

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let nextId = 1;
/** A request to the client (ros.ai), answered on stdin. */
const ask = (method, params) => new Promise(resolve => { const id = `agent-${nextId++}`; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const update = (sessionId, value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** ros.ai's MCP server for this session, over HTTP or through the stdio bridge it named. */
function mcpClient(server) {
  if (server.type === 'http') {
    const headers = Object.fromEntries(server.headers.map(item => [item.name, item.value]));
    let id = 1;
    return { call: async (method, params) => { const response = await fetch(server.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) }); return { status: response.status, body: await response.json() }; }, close() {} };
  }
  const child = spawn(server.command, server.args, { env: { ...Object.fromEntries(server.env.map(item => [item.name, item.value])), PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map(); let id = 1;
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id); });
  return { call: (method, params) => new Promise(resolve => { const current = id++; waiting.set(current, body => resolve({ status: 200, body })); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`); }), close: () => child.kill() };
}

const sessions = new Map();
let cancel = null;
// Started the way ros.ai starts Gemini CLI (gemini --acp), it reports tool calls the way Gemini CLI does.
const asGemini = argv.includes('--acp');
/** Connects once per session: initialize, then list the tools. */
async function connect(session) {
  const server = session.mcpServers[0];
  if (!server || session.client) return session.client;
  const client = session.client = mcpClient(server);
  report.mcp.push({ transport: server.type === 'http' ? 'http' : 'stdio', name: server.name });
  report.mcp.push({ initialize: (await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } })).body });
  const listed = (await client.call('tools/list', {})).body;
  report.mcp.push({ tools: listed.result?.tools?.map(tool => tool.name) ?? listed }); save();
  return client;
}
const modes = (config.MODES || 'default').split(',');
// CONFIG_OPTIONS names modes and model the way OpenCode does (session config options); STUCK ignores a mode change.
const configOptions = mode => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake/fake-model-1', options: [{ value: 'fake/fake-model-1', name: 'Fake model' }] }, { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: mode, options: modes.map(value => ({ value, name: value })) }];
async function prompt(params) {
  const session = sessions.get(params.sessionId);
  report.prompts.push(params.prompt.map(item => item.text).join('\n')); save();
  const scenario = config.SCENARIO || 'turn';
  if (scenario === 'slow') {
    say(params.sessionId, 'Thinking for a long time.');
    return new Promise(resolve => { cancel = () => { report.cancelled = true; save(); resolve({ stopReason: 'cancelled' }); }; });
  }
  say(params.sessionId, 'I will read the map first.');
  const files = JSON.parse(config.FILES || '[]');
  if (files[0]) update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'read_file__fake_1', status: 'completed', title: 'question.md', kind: 'read', locations: [{ path: files[0] }] });
  const client = await connect(session);
  if (client) {
    if (asGemini) update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'mcp_rosai_ros_read_canvas__fake_2', status: 'in_progress', title: '{}', kind: 'other' });
    if (config.GOOSE === '1') {
      // Goose announces a tool call, then asks permission for it by title.
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'goose-1', title: 'rosai: ros read canvas', status: 'pending', _meta: { goose: { toolCall: { toolName: 'rosai__ros_read_canvas' } } } });
      report.permissions.push({ tool: 'rosai__ros_read_canvas', answer: await ask('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'goose-1', title: 'rosai: ros read canvas', kind: 'other' }, options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }] }) });
      // A look-alike title for a different tool is not ros.ai's.
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'goose-2', title: 'rosai: ros read canvas', status: 'pending', _meta: { goose: { toolCall: { toolName: 'developer__shell' } } } });
      report.permissions.push({ tool: 'developer__shell', answer: await ask('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'goose-2', title: 'rosai: ros read canvas', kind: 'execute' }, options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }] }) });
    }
    const read = (await client.call('tools/call', { name: 'ros_read_canvas', arguments: {} })).body;
    report.mcp.push({ call: 'ros_read_canvas', result: read.result?.content?.[0]?.text ?? read });
    const unknown = (await client.call('tools/call', { name: 'run_shell_command', arguments: { command: 'id' } })).body;
    report.mcp.push({ call: 'run_shell_command', result: unknown.result });
  }
  for (const path of files) {
    const answer = await ask('fs/read_text_file', { sessionId: params.sessionId, path, line: 1, limit: 2 });
    report.files.push({ path, ...answer }); save();
  }
  report.permissions.push({ tool: 'shell', answer: await ask('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'own-1', title: 'Shell: rm -rf build', kind: 'execute' }, options: [{ optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'proceed_always', name: 'Always', kind: 'allow_always' }, { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }] }) });
  report.permissions.push({ tool: 'write', answer: await ask('fs/write_text_file', { sessionId: params.sessionId, path: `${session.cwd}/x.txt`, content: 'x' }) });
  save();
  update(params.sessionId, { sessionUpdate: 'usage_update', used: 1234, size: 100000 });
  say(params.sessionId, 'The map has blocks to work with.');
  return { stopReason: 'end_turn', usage: { totalTokens: 1234, inputTokens: 1200, outputTokens: 34 } };
}

async function handle(message) {
  const { method, params } = message;
  report.requests.push(method); save();
  if (method === 'initialize') return { protocolVersion: Number(config.PROTOCOL || 1), agentCapabilities: { loadSession: config.LOAD === '1', mcpCapabilities: { http: config.HTTP !== '0', sse: false }, promptCapabilities: {} }, agentInfo: { name: 'fake-agent', title: 'Fake agent', version: '1.0.0' }, authMethods: [] };
  if (method === 'session/new' || method === 'session/load') {
    if (config.SCENARIO === 'auth-error') throw Object.assign(new Error('Authentication required'), { code: -32000 });
    const sessionId = method === 'session/load' ? params.sessionId : `session-${sessions.size + 1}`;
    sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers });
    report.session = { method, cwd: params.cwd, mcpServers: params.mcpServers.map(server => ({ ...server, headers: server.headers?.map(item => ({ name: item.name, value: item.name === 'Authorization' ? item.value.replace(/[a-f0-9]{64}/u, '<token>') : item.value })), env: server.env?.map(item => ({ name: item.name, value: item.name === 'ROS_AI_MCP_TOKEN' ? '<token>' : item.value })) })) }; save();
    if (config.LAZY !== '1') await connect(sessions.get(sessionId));
    const mode = sessions.get(sessionId).mode = config.MODE || modes[0];
    if (config.CONFIG_OPTIONS === '1') return { sessionId, configOptions: configOptions(mode) };
    return { sessionId, modes: { currentModeId: mode, availableModes: modes.map(id => ({ id, name: id })) }, models: { currentModelId: 'fake-model-1', availableModels: [{ modelId: 'fake-model-1', name: 'Fake model' }] } };
  }
  if (method === 'session/set_config_option') {
    report.modes.push(params.value); save();
    const session = sessions.get(params.sessionId);
    if (config.STUCK !== '1') session.mode = params.value;
    return { configOptions: configOptions(session.mode) };
  }
  if (method === 'session/set_mode') { report.modes.push(params.modeId); save(); update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId }); return {}; }
  if (method === 'session/prompt') return prompt(params);
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method && message.id === undefined) { report.requests.push(message.method); if (message.method === 'session/cancel') cancel?.(); save(); return; }
  if (!message.method) { pending.get(message.id)?.(message.error ? { error: message.error } : message.result); pending.delete(message.id); return; }
  void handle(message).then(result => send({ jsonrpc: '2.0', id: message.id, result }), error => send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } }));
});
process.stdin.on('end', () => { for (const session of sessions.values()) session.client?.close(); process.exit(0); });
