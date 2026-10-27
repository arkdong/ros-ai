#!/usr/bin/env node
// Connects your own Claude Code, Codex or other MCP client to the ros.ai running on this computer.
//   claude mcp add --scope user ros-ai -- node "/path/to/ros-ai-mcp.mjs"
//   codex mcp add ros-ai -- node "/path/to/ros-ai-mcp.mjs"
// ros.ai copies this file into its data folder (bin/ros-ai-mcp.mjs) and links agents to that copy,
// so a link survives moving or updating the code. It speaks MCP over stdio and forwards each
// message to ros.ai on 127.0.0.1, with the token ros.ai wrote to its data folder. Your agent keeps
// its own sign-in; ros.ai never sees it.
// ros.ai also starts it for an agent it runs as Ros (Gemini CLI, Goose, OpenCode) when that agent has
// no HTTP MCP: ROS_AI_MCP_URL and ROS_AI_MCP_TOKEN then name that one turn's endpoint, and mcp.json is not read.
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
const notRunning = `ros.ai is not running. Start it${root ? ` with "npm start" in ${root}` : ''}, then reconnect (in Claude Code: /mcp).`;
const turn = process.env.ROS_AI_MCP_URL && process.env.ROS_AI_MCP_TOKEN && /^http:\/\/127\.0\.0\.1:\d+\//u.test(process.env.ROS_AI_MCP_URL) ? { url: process.env.ROS_AI_MCP_URL, token: process.env.ROS_AI_MCP_TOKEN } : null;

let session;
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
async function forward(message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ros-cwd': encodeURIComponent(process.cwd()) };
  if (session) headers['mcp-session-id'] = session;
  let response;
  if (turn) {
    try { response = await fetch(turn.url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${turn.token}` }, body: JSON.stringify(message) }); } catch { throw new Error('ros.ai stopped during this turn.'); }
  } else for (const folder of candidates) {
    // Read on every call: a restarted ros.ai writes a new token.
    let connection;
    try { connection = JSON.parse(readFileSync(join(folder, 'mcp.json'), 'utf8')); } catch { continue; }
    try { response = await fetch(connection.url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${connection.token}` }, body: JSON.stringify(message) }); break; } catch { /* A stale file from a stopped copy; try the next folder. */ }
  }
  if (!response) throw new Error(notRunning);
  if (response.headers.get('mcp-session-id')) session = response.headers.get('mcp-session-id');
  if (response.status === 202) return;
  const text = await response.text();
  if (!response.ok && !text.startsWith('{')) throw new Error(`ros.ai answered ${response.status}.`);
  const answer = JSON.parse(text);
  // A refusal before ros.ai read the message carries no id; it answers this message.
  if (!response.ok && answer && answer.id === null && message.id !== undefined) answer.id = message.id;
  write(answer);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); return; }
  forward(message).catch(error => { if (message.id !== undefined && message.id !== null) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }); });
});
