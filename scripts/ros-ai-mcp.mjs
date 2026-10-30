#!/usr/bin/env node
// Connects your own Claude Code, Codex or other MCP client to the ros.ai running on this computer.
//   claude mcp add --scope user ros-ai -- node "/path/to/ros-ai-mcp.mjs"
//   codex mcp add ros-ai -- node "/path/to/ros-ai-mcp.mjs"
// ros.ai copies this file into its data folder (bin/ros-ai-mcp.mjs) and links agents to that copy,
// so a link survives moving or updating the code. It speaks MCP over stdio and forwards each
// message to ros.ai on 127.0.0.1, with the token ros.ai wrote to its data folder. Your agent keeps
// its own sign-in; ros.ai never sees it.
// ros.ai also starts it for an agent it runs as ROS (Gemini CLI, Goose, OpenCode) when that agent has
// no HTTP MCP: ROS_AI_MCP_URL and ROS_AI_MCP_TOKEN then name that one turn's endpoint, and mcp.json is not read.
// An agent whose MCP client gives no name of its own is named by its link: --client=hermes (Hermes Agent).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The copy in ros.ai's data folder sits in <data>/bin; the checkout's copy sits in <repo>/scripts.
const installed = basename(here) === 'bin';
const root = installed ? null : resolve(here, '..');
// The same data folder the server picks in src/server/index.ts.
const appData = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'ros.ai')
  : process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ros.ai')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ros.ai');
// Where mcp.json may be, in order: an explicit folder, the folder this copy lives in, the checkout's
// own folder, then the usual app-data folder, so a copy left by a removed try-out still reaches ros.ai.
const candidates = [...new Set([process.env.ROS_DATA_DIR, installed ? dirname(here) : null, root && existsSync(resolve(root, '.ros-ai')) ? resolve(root, '.ros-ai') : null, appData].filter(Boolean).map(folder => resolve(folder)))];
const notRunning = `ros.ai is not running. Open the ros.ai app${root ? ` (or run "npm start" in ${root})` : ''}; get it at https://ros-ai.io. Its tools appear here a few seconds after it starts.`;
const client = process.argv.slice(2).map(arg => /^--client=([a-z0-9-]{1,40})$/iu.exec(arg)?.[1]).find(Boolean);
const turn = process.env.ROS_AI_MCP_URL && process.env.ROS_AI_MCP_TOKEN && /^http:\/\/127\.0\.0\.1:\d+\//u.test(process.env.ROS_AI_MCP_URL) ? { url: process.env.ROS_AI_MCP_URL, token: process.env.ROS_AI_MCP_TOKEN } : null;

let session;
// While ros.ai is off, the bridge still starts and answers for itself, so an agent that starts it at launch
// (the Claude app, Cursor) shows no failed server; it offers ros_status, and once ros.ai is up it connects
// and tells the agent its tools changed.
let offline = null, init;
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const STATUS_TOOL = { name: 'ros_status', title: 'Check ros.ai', description: 'Say whether ros.ai is running on this computer. Its other tools appear once it is.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
async function post(message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ros-cwd': encodeURIComponent(process.cwd()) };
  if (session) headers['mcp-session-id'] = session;
  if (client) headers['x-ros-client'] = client;
  let response;
  if (turn) {
    try { response = await fetch(turn.url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${turn.token}` }, body: JSON.stringify(message) }); } catch { throw new Error('ros.ai stopped during this turn.'); }
  } else for (const folder of candidates) {
    // Read on every call: a restarted ros.ai writes a new token.
    let connection;
    try { connection = JSON.parse(readFileSync(join(folder, 'mcp.json'), 'utf8')); } catch { continue; }
    try { response = await fetch(connection.url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${connection.token}` }, body: JSON.stringify(message) }); break; } catch { /* A stale file from a stopped copy; try the next folder. */ }
  }
  if (!response) throw Object.assign(new Error(notRunning), { notRunning: true });
  if (response.headers.get('mcp-session-id')) session = response.headers.get('mcp-session-id');
  return response;
}
async function forward(message) {
  const response = await post(message);
  if (response.status === 202) return;
  const text = await response.text();
  if (!response.ok && !text.startsWith('{')) throw new Error(`ros.ai answered ${response.status}.`);
  const answer = JSON.parse(text);
  // A refusal before ros.ai read the message carries no id; it answers this message.
  if (!response.ok && answer && answer.id === null && message.id !== undefined) answer.id = message.id;
  write(answer);
}
/** Answers a message while ros.ai is off. */
function standIn(message) {
  if (message.id === undefined || message.id === null) return;
  const answer = result => write({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'ping') answer({});
  else if (message.method === 'tools/list') answer({ tools: [STATUS_TOOL] });
  else if (message.method === 'tools/call') answer({ content: [{ type: 'text', text: notRunning }], isError: message.params?.name !== STATUS_TOOL.name });
  else if (message.method === 'resources/list') answer({ resources: [] });
  else if (message.method === 'prompts/list') answer({ prompts: [] });
  else write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: notRunning } });
}
/** Every few seconds while ros.ai is off: start a session with it as the agent did, then say the tools changed. */
function watchForRos() {
  if (offline.timer) return;
  offline.timer = setInterval(async () => {
    if (offline.trying) return;
    offline.trying = true;
    try {
      session = undefined;
      const response = await post({ ...offline.init, id: 'ros-ai-bridge-connect' });
      if (!response.ok) return;
      await response.text();
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined);
      clearInterval(offline.timer);
      offline = null;
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    } catch { /* Still off. */ } finally { if (offline) offline.trying = false; }
  }, 4000);
  offline.timer.unref?.();
}
async function handle(message) {
  if (offline) return standIn(message);
  if (message.method === 'initialize') init = message;
  try { await forward(message); } catch (error) {
    if (!error.notRunning || turn || !init) throw error;
    // ros.ai quit after the session started: answer for it and connect again when it is back.
    if (message.method !== 'initialize') { offline = { init }; watchForRos(); return standIn(message); }
    const requested = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18';
    offline = { init: message };
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: requested, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'ros-ai', title: 'ros.ai', version: '0.1.0' },
      instructions: notRunning } });
    watchForRos();
  }
}

let starting = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); return; }
  // Other messages wait for the session to start, so they learn whether ros.ai is on.
  const handled = message.method === 'initialize' ? handle(message) : starting.then(() => handle(message));
  if (message.method === 'initialize') starting = handled.catch(() => undefined);
  handled.catch(error => { if (message.id !== undefined && message.id !== null) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }); });
});
