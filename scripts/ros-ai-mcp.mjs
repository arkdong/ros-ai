#!/usr/bin/env node
// Connects your own Claude Code, Codex or other MCP client to the ros.ai running on this computer.
//   claude mcp add --scope user ros-ai -- node /path/to/ros-ai/scripts/ros-ai-mcp.mjs
//   codex mcp add ros-ai -- node /path/to/ros-ai/scripts/ros-ai-mcp.mjs
// It speaks MCP over stdio and forwards each message to ros.ai on 127.0.0.1, with the token
// ros.ai wrote to its data folder. Your agent keeps its own sign-in; ros.ai never sees it.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The same data folder the server picks in src/server/index.ts.
const appData = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'ros.ai')
  : process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ros.ai')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ros.ai');
const dataDir = resolve(process.env.ROS_DATA_DIR || (existsSync(resolve(root, '.ros-ai')) ? resolve(root, '.ros-ai') : appData));
const notRunning = `ros.ai is not running. Start it with "npm start" in ${root}, then reconnect (in Claude Code: /mcp).`;

let session;
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
async function forward(message) {
  let connection;
  // Read on every call: a restarted ros.ai writes a new token.
  try { connection = JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')); } catch { throw new Error(notRunning); }
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${connection.token}`, 'x-ros-cwd': encodeURIComponent(process.cwd()) };
  if (session) headers['mcp-session-id'] = session;
  let response;
  try { response = await fetch(connection.url, { method: 'POST', headers, body: JSON.stringify(message) }); } catch { throw new Error(notRunning); }
  if (response.headers.get('mcp-session-id')) session = response.headers.get('mcp-session-id');
  if (response.status === 202) return;
  const text = await response.text();
  if (!response.ok && !text.startsWith('{')) throw new Error(`ros.ai answered ${response.status}.`);
  write(JSON.parse(text));
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); return; }
  forward(message).catch(error => { if (message.id !== undefined && message.id !== null) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }); });
});
