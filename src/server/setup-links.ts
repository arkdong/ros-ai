import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { childEnvironment } from './codex-app-server.js';
import { pretty, win, type Found } from './setup-detect.js';
import type { AgentId, LinkRecord, LinkResult } from '../shared/setup.js';

/** Links an agent to the ros.ai on this computer: one `ros-ai` entry in the agent's own settings,
 * written by the agent's command line where it has one, else merged into its settings file with a
 * one-time backup. Each link is recorded here so Undo removes exactly that entry. */

const quoted = (value: string) => `"${value}"`;
const word = (value: string) => /\s/u.test(value) ? quoted(value) : value;
/** The node an agent runs the bridge with. Inside the ros.ai app there may be no Node on this computer, so the app
 * hands over a small launcher (ROS_NODE_COMMAND) that runs its own Node; GUI apps see a short PATH, so Cursor gets a path. */
const nodeCommand = (id?: AgentId) => process.env.ROS_NODE_COMMAND || (id === 'cursor' ? process.execPath : 'node');
/** The process an agent starts for ros.ai. */
export function entryFor(id: AgentId, bridge: string) {
  return { command: nodeCommand(id), args: [bridge] };
}
/** The command a person would paste, or the settings entry they would add. */
export function linkCommand(id: AgentId, bridge: string) {
  const { command, args } = entryFor(id, bridge);
  switch (id) {
    case 'claude-code': return `claude mcp add --scope user ros-ai -- ${word(command)} ${quoted(bridge)}`;
    case 'codex': return `codex mcp add ros-ai -- ${word(command)} ${quoted(bridge)}`;
    default: return `"ros-ai": { "command": ${JSON.stringify(command)}, "args": [${args.map(item => JSON.stringify(item)).join(', ')}] }`;
  }
}
const cli = (id: 'claude-code' | 'codex', bridge: string) => id === 'claude-code'
  ? { add: ['mcp', 'add', '--scope', 'user', 'ros-ai', '--', nodeCommand(id), bridge], remove: ['mcp', 'remove', '--scope', 'user', 'ros-ai'], removeCommand: 'claude mcp remove --scope user ros-ai' }
  : { add: ['mcp', 'add', 'ros-ai', '--', nodeCommand(id), bridge], remove: ['mcp', 'remove', 'ros-ai'], removeCommand: 'codex mcp remove ros-ai' };

function run(binary: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise(settle => {
    const shell = win && /\.(cmd|bat)$/i.test(binary);
    const env = childEnvironment();
    // An npm-installed CLI is a node script, so the node that runs ros.ai is on its path too.
    env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
    const child = spawn(shell ? quoted(binary) : binary, shell ? args.map(quoted) : args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell, cwd: homedir() });
    let output = '';
    const collect = (chunk: Buffer) => { if (output.length < 4000) output += chunk.toString('utf8'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', error => { clearTimeout(timer); settle({ code: null, output: error.message }); });
    child.on('close', code => { clearTimeout(timer); settle({ code, output }); });
  });
}
const firstLine = (output: string) => output.split(/\r?\n/u).map(line => line.trim()).find(Boolean)?.slice(0, 160) ?? '';

function readSettings(target: string): Record<string, unknown> {
  if (!existsSync(target)) return {};
  const text = readFileSync(target, 'utf8');
  if (!text.trim()) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('it is not a JSON object');
  return value as Record<string, unknown>;
}
function writeSettings(target: string, value: Record<string, unknown>) {
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600, temporary = `${target}.ros-ai-tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, target);
}
const servers = (value: Record<string, unknown>) => value.mcpServers && typeof value.mcpServers === 'object' && !Array.isArray(value.mcpServers) ? value.mcpServers as Record<string, unknown> : {};

const ready: Record<AgentId, string> = {
  'claude-code': 'Ready in new Claude Code sessions. In an open session, type /mcp to reconnect.',
  codex: 'Ready in new Codex sessions.',
  cursor: 'Ready in Cursor, which picks up the new entry on its own.',
  'gemini-cli': 'Ready in new Gemini CLI sessions.',
};

export class SetupLinks {
  private readonly file: string;
  constructor(dataDir: string) { this.file = join(dataDir, 'links.json'); }
  records(): LinkRecord[] {
    try { const value = JSON.parse(readFileSync(this.file, 'utf8')) as { links?: unknown }; return Array.isArray(value.links) ? value.links as LinkRecord[] : []; } catch { return []; }
  }
  record(agent: AgentId) { return this.records().find(item => item.agent === agent) ?? null; }
  private save(links: LinkRecord[]) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ version: 1, links }, null, 2), { mode: 0o600 });
  }
  private forget(agent: AgentId) { this.save(this.records().filter(item => item.agent !== agent)); }

  async link(agent: Found, bridge: string): Promise<LinkResult> {
    const command = linkCommand(agent.id, bridge), at = new Date().toISOString();
    const keep = (link: LinkRecord) => { this.save([...this.records().filter(item => item.agent !== agent.id), link]); return link; };
    if (agent.method === 'cli') {
      const plan = cli(agent.id as 'claude-code' | 'codex', bridge);
      if (!agent.binary) return { agent: agent.id, ok: false, message: `${agent.label}'s command line is not on ros.ai's path. Paste this once in a terminal:`, command, link: null };
      // The agent refuses a second entry of the same name, so an older one goes first.
      if (agent.entry) await run(agent.binary, plan.remove);
      const result = await run(agent.binary, plan.add);
      if (result.code !== 0) return { agent: agent.id, ok: false, message: `${agent.label} did not accept the link${firstLine(result.output) ? ` (${firstLine(result.output)})` : ''}. Paste this once in a terminal:`, command, link: null };
      return { agent: agent.id, ok: true, message: ready[agent.id], link: keep({ agent: agent.id, method: 'cli', target: agent.target, bridge, writtenAt: at }) };
    }
    // A settings file is only written for an agent that is on this computer.
    if (!agent.found) return { agent: agent.id, ok: false, message: `${agent.label} was not found on this computer.`, link: null };
    try {
      const value = readSettings(agent.target);
      let backup: string | undefined;
      if (existsSync(agent.target)) { backup = `${agent.target}.ros-ai-backup`; if (!existsSync(backup)) copyFileSync(agent.target, backup); }
      value.mcpServers = { ...servers(value), 'ros-ai': entryFor(agent.id, bridge) };
      writeSettings(agent.target, value);
      return { agent: agent.id, ok: true, message: ready[agent.id], link: keep({ agent: agent.id, method: 'file', target: agent.target, bridge, writtenAt: at, ...(backup ? { backup } : {}) }) };
    } catch (error) {
      return { agent: agent.id, ok: false, message: `${agent.label}'s settings file (${pretty(agent.target)}) could not be changed: ${error instanceof Error ? error.message : 'unknown error'}. Add this entry yourself:`, command, link: null };
    }
  }

  async unlink(agent: Found): Promise<LinkResult> {
    this.forget(agent.id);
    if (agent.method === 'cli') {
      const plan = cli(agent.id as 'claude-code' | 'codex', '');
      if (!agent.entry) return { agent: agent.id, ok: true, message: `${agent.label} has no ros-ai entry any more.`, link: null };
      if (!agent.binary) return { agent: agent.id, ok: false, message: `${agent.label}'s command line is not on ros.ai's path. Paste this once in a terminal:`, command: plan.removeCommand, link: null };
      const result = await run(agent.binary, plan.remove);
      if (result.code !== 0) return { agent: agent.id, ok: false, message: `${agent.label} did not remove the entry${firstLine(result.output) ? ` (${firstLine(result.output)})` : ''}. Paste this once in a terminal:`, command: plan.removeCommand, link: null };
      return { agent: agent.id, ok: true, message: `Removed from ${agent.label}.`, link: null };
    }
    try {
      if (!existsSync(agent.target)) return { agent: agent.id, ok: true, message: `${agent.label} has no ros-ai entry any more.`, link: null };
      const value = readSettings(agent.target), current = servers(value);
      if (!('ros-ai' in current)) return { agent: agent.id, ok: true, message: `${agent.label} has no ros-ai entry any more.`, link: null };
      const { 'ros-ai': _removed, ...rest } = current;
      value.mcpServers = rest;
      writeSettings(agent.target, value);
      return { agent: agent.id, ok: true, message: `Removed from ${agent.label}.`, link: null };
    } catch (error) {
      return { agent: agent.id, ok: false, message: `${agent.label}'s settings file (${pretty(agent.target)}) could not be changed: ${error instanceof Error ? error.message : 'unknown error'}. Remove the ros-ai entry yourself.`, link: null };
    }
  }
}
