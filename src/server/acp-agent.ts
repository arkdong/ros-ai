import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import type { ExecutionService } from './execution.js';
import type { ExperimentService } from './experiments.js';
import { AgentWorkspaceTools } from './agent-tools.js';
import { CLAUDE_CODE_INSTRUCTIONS, selectionText } from './agent-prompt.js';
import { projectFolderRoot } from './project-folders.js';
import { findBinary, pretty } from './setup-detect.js';
import { agentStep, type AgentEvent, type AgentExecuteRequest, type AgentResult } from '../shared/agent-runtime.js';
import { ACP_AGENTS, ACP_AGENT_IDS, isAcpAgent, type AcpAgentId, type AcpAgentStatus } from '../shared/acp-agents.js';

/** Gemini CLI, Goose and OpenCode as ROS, through the Agent Client Protocol: ros.ai starts the agent for
 * one turn, gives it ros.ai's tools over a per-turn MCP endpoint, and refuses everything else it asks
 * for. Each agent keeps its own sign-in and model; ros.ai never sees either.
 *
 * Each agent is also locked down in its own terms before it starts, because an agent can run some
 * tools without asking its client: Gemini CLI gets an admin policy that denies every tool but ros.ai's
 * and reading the folder, and works from a folder of ros.ai's own; OpenCode gets a ros-ai agent whose
 * permissions do the same, without the project's own config; Goose runs in approve mode, where every
 * tool asks first and ros.ai allows only its own. */

const now = () => new Date().toISOString();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
/** The MCP server name the agents see: no underscore (Gemini CLI's policy rules split names on it), and
 * unlike the ros-ai server the person may have linked to their own agent. */
const SERVER = 'rosai';
const PROTOCOL = 1, MAX_TOOL_CALLS = 30, MAX_SECONDS = 900, START_MS = 90_000, CHECK_MS = 45_000, REPLY_CHARACTERS = 120_000, READ_BYTES = 4_000_000;
const MCP_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const COMMAND: Record<AcpAgentId, string> = { gemini: 'gemini', goose: 'goose', opencode: 'opencode' };
/** The session mode a turn must run in, where the agent's own boundary depends on one. */
const REQUIRED_MODE: Partial<Record<AcpAgentId, string>> = { opencode: 'ros-ai', goose: 'approve' };
const READ_ONLY_TOOLS = new Set(['ros_read_canvas', 'ros_read_selected', 'ros_use_skill', 'ros_notion_search', 'ros_notion_read', 'ros_notion_query', 'ros_app_tools', 'ros_app_guide', 'ros_check_app']);

/** Claude Code's instructions, with its folder line in words that fit the agent: Gemini CLI and OpenCode keep
 * their own read tools; Goose has none it may use, so it reads blocks through ros.ai. */
export const CLAUDE_CODE_READ = 'Read them with Read, Glob and Grep.';
export function acpInstructions(id: AcpAgentId) {
  const read = id === 'goose' ? 'Your own tools are off while you work in ros.ai, reading files included: read blocks with ros_read_canvas and ros_read_selected.' : 'Read them with your own read, list and search tools; your other tools are off while you work in ros.ai.';
  return `${CLAUDE_CODE_INSTRUCTIONS.replace(CLAUDE_CODE_READ, read)}
- ros.ai's tools may carry a prefix in your tool list (for example mcp_rosai_ros_read_canvas, rosai_ros_read_canvas or rosai__ros_read_canvas); they are the ros_* tools named here.`;
}
const MCP_INSTRUCTIONS = 'ros.ai is the researcher\'s workspace. These tools read its map and propose changes; every change follows the researcher\'s permission choice in ros.ai.';
/** The one tool a check offers: listing it shows the agent reaches ros.ai's tools. */
const CHECK_TOOL = { name: 'ros_check', description: 'ros.ai checking that it can reach you. It does nothing.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
const GEMINI_MCP_HINT = 'Check that your Gemini CLI settings, or your organisation’s, do not turn MCP servers off.';

/** Gemini CLI loads this as an admin policy (--admin-policy), which outranks the person's own rules and
 * every approval mode. Tools a rule denies outright are left out of the model's tool list. Every rule
 * needs a toolName (Gemini CLI skips the whole file when one rule fails its schema), and ros.ai's tools
 * are named in full, without mcpName: Gemini CLI checks an MCP tool call under the server name
 * "mcp_rosai", which a rule for the server "rosai" never matches. */
function geminiPolicy(tools: string[]) {
  return `# Written by ros.ai for the Gemini CLI turns it runs (gemini --acp --admin-policy <this file>).
# Every tool is off except ros.ai's own (the ${SERVER} MCP server) and reading the project folder.
[[rule]]
toolName = "*"
decision = "deny"
priority = 900
denyMessage = "This tool is off while Gemini CLI works in ros.ai. Use the ros.ai tools; changes go through ros.ai's proposals."

[[rule]]
toolName = ["read_file", "read_many_files", "list_directory", "glob", "grep_search", "search_file_content"]
decision = "allow"
priority = 950

# Secrets kept in .env files are not read (read_many_files leaves them out already).
[[rule]]
toolName = ["read_file", "read_many_files", "grep_search", "search_file_content"]
argsPattern = '[/\\\\"]\\.env'
decision = "deny"
priority = 960
denyMessage = "ros.ai does not let agents read .env files."
${tools.length ? `
[[rule]]
toolName = [${tools.map(name => JSON.stringify(`mcp_${SERVER}_${name}`)).join(', ')}]
decision = "allow"
priority = 999
` : ''}`;
}
/** Where an organisation keeps Gemini CLI's own admin policies; supplemental ones are ignored when it has any. */
const GEMINI_SYSTEM_POLICIES = process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/policies' : process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\policies' : '/etc/gemini-cli/policies';

/** OpenCode merges this over the person's config (OPENCODE_CONFIG_CONTENT). Its default agent allows every
 * tool without asking, so turns use a ros-ai agent instead: an agent's own rules come last and win. */
function openCodeConfig(tools: string[]) {
  return {
    $schema: 'https://opencode.ai/config.json', default_agent: 'ros-ai', share: 'disabled', autoupdate: false,
    // A plan can wait minutes for the person's approval; OpenCode's MCP calls time out after a minute otherwise.
    experimental: { mcp_timeout: 600_000 },
    agent: { 'ros-ai': { mode: 'primary', description: 'Works in ros.ai through ros.ai’s tools only.', permission: {
      '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' }, glob: 'allow', grep: 'allow', list: 'allow', external_directory: 'deny',
      ...Object.fromEntries(tools.map(name => [`${SERVER}_${name}`, 'allow'])),
    } } },
  };
}

/** Goose runs a tool the person marked "always allow" without asking, even in approve mode. */
function gooseConfigDir() {
  const root = process.env.GOOSE_PATH_ROOT;
  if (root && isAbsolute(root)) return join(root, 'config');
  return process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Block', 'goose', 'config') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'goose');
}
/** The tools listed under user › always_allow in Goose's permission.yaml, or null when the file cannot be read as Goose writes it. */
export function gooseAlwaysAllowed(yaml: string): string[] | null {
  const lines = yaml.split(/\r?\n/u), found: string[] = [];
  let section = '', list = false, listIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length, body = line.trim();
    if (indent === 0) { section = body.replace(/:.*$/u, ''); list = false; if (!/^[\w-]+:\s*$/u.test(body)) { if (section === 'user') return null; } continue; }
    if (section !== 'user') continue;
    // Anything nested inside the list other than its items is not how Goose writes it.
    if (list && indent > listIndent && !body.startsWith('- ')) return null;
    const key = /^([\w-]+):\s*(.*)$/u.exec(body);
    if (key && !body.startsWith('- ')) {
      list = key[1] === 'always_allow'; listIndent = indent;
      if (list && key[2]) {
        const inline = /^\[(.*)\]$/u.exec(key[2]);
        if (!inline) return null;
        found.push(...inline[1].split(',').map(item => item.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean));
        list = false;
      }
      continue;
    }
    if (list && body.startsWith('- ') && indent >= listIndent) { found.push(body.slice(2).trim().replace(/^['"]|['"]$/gu, '')); continue; }
    if (list) return null;
  }
  return found;
}

const BASE_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
const AGENT_ENV: Record<AcpAgentId, { prefixes: string[]; drop: string[] }> = {
  gemini: { prefixes: ['GEMINI_', 'GOOGLE_', 'CLOUDSDK_', 'NO_BROWSER'], drop: [] },
  opencode: { prefixes: ['OPENCODE_'], drop: ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'] },
  goose: { prefixes: ['GOOSE_'], drop: ['GOOSE_MODE'] },
};
/** The agent gets the ordinary environment and its own settings; ros.ai's saved provider keys stay out,
 * so an agent never bills a key the person gave to ros.ai. The agent's folder and ros.ai's Node come
 * first on PATH, because npm installs these agents as Node scripts. */
function childEnvironment(id: AcpAgentId, binary: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}, { prefixes, drop } = AGENT_ENV[id];
  for (const key of BASE_ENV) if (process.env[key]) env[key] = process.env[key];
  for (const [key, value] of Object.entries(process.env)) if (value && prefixes.some(prefix => key.startsWith(prefix)) && !drop.includes(key)) env[key] = value;
  env.PATH = [...new Set([dirname(binary), dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)])].join(delimiter);
  return env;
}
function inside(root: string, target: string) {
  let real = resolve(root, target);
  try { real = realpathSync(real); } catch { /* A missing file is checked as written. */ }
  let base = root;
  try { base = realpathSync(root); } catch { /* checked as written */ }
  const rel = relative(base, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
type Pending = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

/** One agent process speaking ACP: newline-delimited JSON-RPC 2.0 on its stdin and stdout. No request is ever retried. */
class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, Pending>();
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private stderr = '';
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = async method => { throw new RpcError(-32601, `ros.ai does not offer ${method}.`); };
  onExit: (error: Error) => void = () => {};
  constructor(private readonly label: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    // Its own process group, so stopping it also stops the servers and helpers it started.
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-6000); });
    this.child.stdin.on('error', () => this.fail(new StoreError(`${label} closed its connection.${this.hint()}`, 503)));
    this.child.on('error', () => this.fail(new StoreError(`${label} could not start. Check that it runs in a terminal.`, 503)));
    this.child.on('exit', code => { if (!this.closed) this.fail(new StoreError(`${label} stopped${code ? ` (exit code ${code})` : ''}.${this.hint()}`, 503)); });
  }
  /** The agent's own last error line, which usually says what to fix (a sign-in, a setting). */
  hint() {
    const line = this.stderr.replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u).map(item => item.trim()).filter(item => item && !/^at /u.test(item)).reverse().find(item => /error|auth|sign|login|key|config|not found|denied|invalid|unknown/iu.test(item));
    return line ? ` It said: “${line.length > 240 ? `${line.slice(0, 240)}…` : line}”` : '';
  }
  private receive(chunk: string) {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000) { this.fail(new StoreError(`${this.label} sent more than ros.ai reads in one message.`, 503)); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Rpc;
      // Some agents log to stdout before they start; only JSON-RPC lines count.
      try { message = JSON.parse(line) as Rpc; } catch { continue; }
      if (!message || typeof message !== 'object') continue;
      if (message.id !== undefined && message.id !== null && !message.method) {
        const pending = this.pending.get(message.id); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new RpcError(message.error.code ?? -32603, text(message.error.message) || `${this.label} refused ${pending.method}.`));
        else pending.resolve(message.result);
      } else if (message.method && message.id !== undefined && message.id !== null) {
        const id = message.id;
        void this.onRequest(message.method, object(message.params)).then(result => this.send({ jsonrpc: '2.0', id, result: result ?? null }), (error: unknown) => this.send({ jsonrpc: '2.0', id, error: { code: error instanceof RpcError ? error.code : -32603, message: error instanceof Error ? error.message : 'ros.ai could not answer this.' } }));
      } else if (message.method) this.onNotification(message.method, object(message.params));
    }
  }
  private send(message: Rpc) { if (!this.closed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  /** timeoutMs 0 waits until the agent answers or the connection closes. */
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new StoreError(`${this.label} is not running.`, 503));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new StoreError(`${this.label} did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.${this.hint()}`, 503)); }, timeoutMs) : undefined;
      this.pending.set(id, { method, resolve: value => resolve(object(value) as T), reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string, params: Record<string, unknown>) { this.send({ jsonrpc: '2.0', method, params }); }
  private fail(error: Error) { if (this.closed) return; this.close(error); this.onExit(error); }
  close(reason: Error = new StoreError(`${this.label} was stopped.`, 503)) {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const kill = (signal: NodeJS.Signals) => { try { if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch { /* already gone */ } };
    kill('SIGTERM');
    setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) kill('SIGKILL'); }, 3000).unref();
  }
}

type Session = { agent: AcpAgentId; sessionId: string; cwd: string; folder?: string | null; state: 'ready' | 'uncertain'; at: string };
type Attempt = { id: string; projectId: string; assistantTurnId: string; agent: AcpAgentId; at: string; status: 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain'; version: string | null; sessionId?: string; mcp?: 'http' | 'stdio'; request: unknown; events: AgentEvent[]; reply: string; stopReason?: string; usage?: unknown; error?: string };
type Check = { at: string; ok: boolean; detail: string; version: string | null };
type Found = { binary: string | null; version: string | null; blocker: string | null };
/** A turn's MCP endpoint: its tools, and whether the agent has listed them yet. */
type Turn = { tools: unknown[]; listed: boolean; call: (name: string, args: unknown) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> };
type McpServer = { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] } | { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
type Opened = { connection: AcpConnection; sessionId: string; resumed: boolean; mcp: 'http' | 'stdio' | null; mode: string | null; model: string | null; agentInfo: Record<string, unknown> };

export class AcpAgentService {
  private readonly active = new Map<string, { stop: () => void; done: Promise<unknown> }>();
  private readonly turns = new Map<string, Turn>();
  private readonly found = new Map<AcpAgentId, Found & { at: number; key: string }>();
  private readonly probing = new Map<AcpAgentId, Promise<Found>>();
  private port = 0;
  private closed = false;
  constructor(private readonly store: Store, private readonly execution: ExecutionService, private readonly experiments: ExperimentService, private readonly options: { dataDir: string; root: string; binaries?: Partial<Record<AcpAgentId, string>> }) {
    for (const project of store.listProjects()) for (const attempt of store.records<Attempt>('acp-attempt', project.id)) if (attempt.status === 'running') {
      store.saveRecord('acp-attempt', attempt.id, project.id, { ...attempt, status: 'uncertain', error: `ros.ai stopped while ${ACP_AGENTS[attempt.agent].label} was working. Nothing was repeated.` });
      const session = store.record<Session>('acp-session', project.id);
      if (session) store.saveRecord('acp-session', project.id, project.id, { ...session, state: 'uncertain' });
    }
  }
  /** The port ros.ai listens on, for the per-turn MCP endpoint the agents call back. */
  listen(port: number) { this.port = port; }

  private binary(id: AcpAgentId) {
    const named = this.options.binaries?.[id] ?? process.env[`ROS_${id.toUpperCase()}_BINARY`];
    return findBinary(named || COMMAND[id]);
  }
  private key(binary: string | null) {
    try { return binary ? `${binary}:${statSync(binary).mtimeMs}` : ''; } catch { return binary ?? ''; }
  }
  /** What was last found on this computer, without waiting: a stale answer starts a new look in the background,
   * and null means there is none yet for this binary. Starting an agent takes seconds, so nothing here blocks ros.ai. */
  private cached(id: AcpAgentId): Found | null {
    const binary = this.binary(id), cached = this.found.get(id);
    if (!binary) return { binary: null, version: null, blocker: `${ACP_AGENTS[id].label} is not installed on this computer.` };
    if (!cached || cached.key !== this.key(binary) || Date.now() - cached.at >= 30_000) void this.probe(id).catch(() => undefined);
    return cached && cached.key === this.key(binary) ? cached : null;
  }
  /** Looks again: the agent's version, and whatever stops it from being locked down here. One look at a time. */
  private probe(id: AcpAgentId): Promise<Found> {
    const running = this.probing.get(id);
    if (running) return running;
    const look = (async () => {
      const binary = this.binary(id), key = this.key(binary);
      const value: Found = binary ? { binary, version: await this.version(id, binary), blocker: await this.preflight(id, binary) } : { binary: null, version: null, blocker: `${ACP_AGENTS[id].label} is not installed on this computer.` };
      this.found.set(id, { ...value, at: Date.now(), key });
      return value;
    })().finally(() => this.probing.delete(id));
    this.probing.set(id, look);
    return look;
  }
  private async version(id: AcpAgentId, binary: string) {
    const result = await briefly(binary, ['--version'], childEnvironment(id, binary), 15_000);
    const line = result.stdout.split(/\r?\n/u).map(item => item.trim()).find(Boolean) ?? '';
    return result.ok && line ? line.replace(/^(gemini|goose|opencode)\s+/iu, '').slice(0, 60) : null;
  }
  /** What stops this agent from being locked down here, found without starting a session. */
  private async preflight(id: AcpAgentId, binary: string): Promise<string | null> {
    if (id === 'gemini') {
      const help = await briefly(binary, ['--help'], childEnvironment(id, binary), 20_000);
      const missing = ['--acp', '--admin-policy', '--allowed-mcp-server-names', '--extensions'].filter(flag => !help.output.includes(flag));
      if (missing.length) return `This Gemini CLI is too old for ros.ai: it has no ${missing.join(', ')} option. Update it with ${ACP_AGENTS.gemini.install}.`;
      try { if (readdirSync(GEMINI_SYSTEM_POLICIES).some(file => file.endsWith('.toml'))) return `Your organisation sets Gemini CLI’s tool rules on this computer (${GEMINI_SYSTEM_POLICIES}), so ros.ai cannot limit it to ros.ai’s tools.`; } catch { /* no system policies */ }
    }
    if (id === 'goose') {
      const file = join(gooseConfigDir(), 'permission.yaml');
      if (existsSync(file)) {
        let allowed: string[] | null = null;
        try { allowed = gooseAlwaysAllowed(readFileSync(file, 'utf8')); } catch { allowed = null; }
        if (!allowed) return `ros.ai could not read Goose’s tool permissions (${pretty(file)}), so it cannot tell whether Goose would run a tool without asking.`;
        const others = allowed.filter(name => !name.startsWith(`${SERVER}__`));
        if (others.length) return `Goose is set to always allow ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}, and would run ${others.length === 1 ? 'it' : 'them'} without asking. ros.ai only runs Goose when every tool asks first: set ${others.length === 1 ? 'it' : 'them'} back to “Ask before” in goose configure › Goose settings › Tool permission.`;
      }
    }
    return null;
  }
  statuses(force = false): Promise<AcpAgentStatus[]> { return Promise.all(ACP_AGENT_IDS.map(id => this.status(id, force))); }
  async status(id: AcpAgentId, force = false): Promise<AcpAgentStatus> {
    return this.describe(id, (force ? null : this.cached(id)) ?? await this.probe(id));
  }
  private describe(id: AcpAgentId, found: Found): AcpAgentStatus {
    const checked = this.store.globalRecord<Check>('acp-agent-check', id), current = checked && checked.version === found.version ? checked : null;
    return { id, label: ACP_AGENTS[id].label, installed: Boolean(found.binary), path: found.binary ? pretty(found.binary) : null, version: found.version, checked: current ? { at: current.at, ok: current.ok, detail: current.detail } : null, blocker: found.blocker };
  }
  /** Cheap and local: no agent starts. Before ros.ai has looked at an installed agent it counts as available;
   * a turn waits for that look and stops if it finds a blocker. */
  readiness(projectId: string, id: AcpAgentId): { available: boolean; reason: string | null } {
    const found = this.cached(id), status = found ? this.describe(id, found) : null;
    if (status?.blocker) return { available: false, reason: `${status.blocker}${status.installed ? '' : ` Install it from Agents › ${status.label}.`}` };
    if (status?.checked && !status.checked.ok) return { available: false, reason: `${status.checked.detail} Then press Check under Agents › ${status.label}.` };
    if (this.experiments.authority.policy(projectId).stopped) return { available: false, reason: 'Project research is stopped. Resume deliberately before a new turn.' };
    return { available: true, reason: null };
  }

  /** One file per set of tools, named by its content, so turns in two projects never rewrite each other's. */
  private geminiPolicyFile(tools: string[]) {
    const policy = geminiPolicy(tools), folder = join(this.options.dataDir, 'acp');
    const file = join(folder, `gemini-policy-${createHash('sha256').update(policy).digest('hex').slice(0, 16)}.toml`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* written below */ }
    if (current !== policy) writeFileSync(file, policy, { mode: 0o600 });
    return file;
  }
  /** Gemini CLI works from a folder of ros.ai's own, with the project folder added to its workspace: opened in
   * the project folder, it would load that folder's .gemini settings (hooks, tool commands, MCP servers). It
   * starts MCP servers only in a folder it trusts, so it is told to trust this one. */
  private geminiWorkspace(cwd: string, folder: string | null) {
    mkdirSync(join(cwd, '.gemini'), { recursive: true, mode: 0o700 });
    writeFileSync(join(cwd, '.gemini', 'settings.json'), `${JSON.stringify({ context: { includeDirectories: folder ? [folder] : [], loadMemoryFromIncludeDirectories: true } }, null, 2)}\n`, { mode: 0o600 });
  }
  private launch(id: AcpAgentId, binary: string, tools: string[], cwd: string, folder: string | null) {
    const env = childEnvironment(id, binary);
    if (id === 'gemini') {
      this.geminiWorkspace(cwd, folder);
      env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
      return { args: ['--acp', '--admin-policy', this.geminiPolicyFile(tools), '--allowed-mcp-server-names', SERVER, '--extensions', 'none', '--approval-mode', 'default'], env };
    }
    if (id === 'opencode') {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeConfig(tools));
      // A project folder's own opencode.json and .opencode folder (agents, permissions, plugins) are not loaded; the person's global config is.
      env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
      return { args: ['acp'], env };
    }
    env.GOOSE_MODE = 'approve';
    return { args: ['acp'], env };
  }
  /** The checkout's own bridge, which always knows the per-turn endpoint (a copy in the data folder may be older). */
  private bridge() { return resolve(this.options.root, 'scripts/ros-ai-mcp.mjs'); }
  private server(token: string, http: boolean): McpServer {
    const url = `http://127.0.0.1:${this.port}/mcp/turn`;
    return http ? { type: 'http', name: SERVER, url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }
      // Agents without HTTP MCP start ros.ai's stdio bridge, pointed at this turn.
      : { name: SERVER, command: process.execPath, args: [this.bridge()], env: [{ name: 'ROS_AI_MCP_URL', value: url }, { name: 'ROS_AI_MCP_TOKEN', value: token }] };
  }

  /** Start the agent, agree on the protocol, and open (or reopen) a session in the mode its boundary needs. Sends no prompt. */
  private async open(id: AcpAgentId, binary: string, cwd: string, options: { tools: string[]; folder: string | null; token?: string; prior?: Session | null; onUpdate?: (params: Record<string, unknown>) => void; onRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown> }): Promise<Opened> {
    const label = ACP_AGENTS[id].label, { args, env } = this.launch(id, binary, options.tools, cwd, options.folder);
    const connection = new AcpConnection(label, binary, args, { cwd, env });
    let replaying = false, mode: string | null = null;
    connection.onNotification = (method, params) => {
      if (method !== 'session/update') return;
      const update = object(params.update);
      if (update.sessionUpdate === 'current_mode_update') mode = text(update.currentModeId) || mode;
      if (update.sessionUpdate === 'config_option_update') mode = text(configOption(update, 'mode')?.currentValue) || mode;
      if (!replaying) options.onUpdate?.(params);
    };
    connection.onRequest = async (method, params) => {
      if (options.onRequest) return options.onRequest(method, params);
      if (method === 'session/request_permission') return refuse(params);
      throw new RpcError(-32601, `ros.ai does not offer ${method}.`);
    };
    try {
      const initialized = await connection.request('initialize', { protocolVersion: PROTOCOL, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false }, clientInfo: { name: 'ros-ai', title: 'ros.ai', version: '0.1.0' } }, START_MS);
      if (initialized.protocolVersion !== PROTOCOL) throw new StoreError(`${label} speaks ACP version ${String(initialized.protocolVersion)}; ros.ai speaks version ${PROTOCOL}. Update ${label}.`, 503);
      const capabilities = object(initialized.agentCapabilities), http = object(capabilities.mcpCapabilities).http === true;
      const servers = options.token ? [this.server(options.token, http)] : [];
      let sessionId = '', resumed = false, result: Record<string, unknown> = {};
      const prior = options.prior;
      if (prior && prior.agent === id && prior.cwd === cwd && (prior.folder ?? null) === options.folder && prior.state === 'ready') {
        const sessionCapabilities = object(capabilities.sessionCapabilities);
        try {
          if (sessionCapabilities.resume) { result = await connection.request('session/resume', { sessionId: prior.sessionId, cwd, mcpServers: servers }, START_MS); sessionId = prior.sessionId; resumed = true; }
          else if (capabilities.loadSession === true) { replaying = true; result = await connection.request('session/load', { sessionId: prior.sessionId, cwd, mcpServers: servers }, START_MS); sessionId = prior.sessionId; resumed = true; }
        } catch { sessionId = ''; resumed = false; } finally { replaying = false; }
      }
      if (!sessionId) {
        try { result = await connection.request('session/new', { cwd, mcpServers: servers }, START_MS); }
        catch (error) {
          if (error instanceof RpcError) throw new StoreError(/auth|sign|login|key|credential/iu.test(error.message) || error.code === -32000 ? `${label} is not signed in: ${error.message} ${ACP_AGENTS[id].signIn}` : `${label} could not open a session: ${error.message}`, 503);
          throw error;
        }
        sessionId = text(result.sessionId);
        if (!sessionId) throw new StoreError(`${label} opened a session without an ID.`, 503);
      }
      // An agent names its modes in session config options (OpenCode) or in the older modes field (Gemini CLI, Goose).
      const modeOption = configOption(result, 'mode'), modes = object(result.modes);
      const available = modeOption ? choices(modeOption) : Array.isArray(modes.availableModes) ? modes.availableModes.map(item => text(object(item).id)) : [];
      mode = text(modeOption?.currentValue) || text(modes.currentModeId) || mode;
      const setMode = async (value: string) => {
        if (!modeOption) { await connection.request('session/set_mode', { sessionId, modeId: value }, START_MS); return value; }
        const answer = await connection.request('session/set_config_option', { sessionId, configId: text(modeOption.id), value }, START_MS);
        return text(configOption(answer, 'mode')?.currentValue) || value;
      };
      const required = REQUIRED_MODE[id];
      if (required && mode !== required) {
        if (!available.includes(required)) throw new StoreError(id === 'opencode' ? 'OpenCode did not load ros.ai’s ros-ai agent, so ros.ai stopped before sending anything. Update OpenCode.' : `${label} has no ${required} mode, where every tool asks first, so ros.ai stopped before sending anything. Update ${label}.`, 503);
        mode = await setMode(required);
        if (mode !== required) throw new StoreError(`${label} stayed in its ${mode} mode instead of ${required}, so ros.ai stopped before sending anything.`, 503);
      } else if (id === 'gemini' && mode && mode !== 'default' && available.includes('default')) {
        // The admin policy holds in every mode; the default mode is also the one Gemini CLI asks most in.
        try { mode = await setMode('default'); } catch { /* the policy still applies */ }
      }
      // Gemini CLI and OpenCode name the model a session uses (an unstable part of ACP, so it may be missing).
      const model = (text(object(result.models).currentModelId) || text(configOption(result, 'model')?.currentValue)).slice(0, 120) || null;
      return { connection, sessionId, resumed, mcp: servers.length ? http ? 'http' : 'stdio' : null, mode, model, agentInfo: object(initialized.agentInfo) };
    } catch (error) { connection.close(); throw error; }
  }

  /** Start the agent and open a session without a prompt: no model runs. Saves what it found. */
  async check(id: AcpAgentId): Promise<AcpAgentStatus> {
    if (this.closed) throw new StoreError('ros.ai is stopping.', 503);
    const found = await this.probe(id), label = ACP_AGENTS[id].label;
    if (!found.binary) return this.describe(id, found);
    let value: Check;
    if (found.blocker) value = { at: now(), ok: false, detail: found.blocker, version: found.version };
    else {
      const cwd = join(this.options.dataDir, 'acp', 'check');
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const token = this.port ? randomBytes(32).toString('hex') : undefined;
      const turn: Turn = { tools: [CHECK_TOOL], listed: false, call: async () => ({ content: [{ type: 'text', text: 'This was only a check; nothing ran.' }], isError: true }) };
      if (token) this.turns.set(token, turn);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const opening = this.open(id, found.binary, cwd, { tools: [], folder: null, token });
      try {
        const opened = await Promise.race([opening, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StoreError(`${label} took longer than ${CHECK_MS / 1000} seconds to start.`, 503)), CHECK_MS); })]);
        opened.connection.close();
        // Gemini CLI connects to its MCP servers while it opens a session; the others may wait for the first prompt.
        if (id === 'gemini' && token && !turn.listed) throw new StoreError(`Gemini CLI started but did not connect to ros.ai’s tools. ${GEMINI_MCP_HINT}`, 503);
        const name = text(opened.agentInfo.title) || text(opened.agentInfo.name) || label, version = text(opened.agentInfo.version);
        value = { at: now(), ok: true, detail: `${name}${version ? ` ${version}` : ''} started and opened a session${opened.model ? ` with ${opened.model}` : ''}${opened.mode ? ` in its ${opened.mode} mode` : ''}.${turn.listed ? ' It reached ros.ai’s tools.' : ''} No prompt was sent.`, version: found.version };
      } catch (error) {
        // A session that opens after the time limit is closed straight away.
        void opening.then(late => late.connection.close(), () => undefined);
        value = { at: now(), ok: false, detail: error instanceof Error ? error.message : `${label} could not start.`, version: found.version };
      } finally { clearTimeout(timer); if (token) this.turns.delete(token); }
    }
    this.store.saveGlobalRecord('acp-agent-check', id, value);
    return this.describe(id, found);
  }

  async execute(request: AgentExecuteRequest & { agent: AcpAgentId }): Promise<AgentResult & { model: string | null }> {
    const id = request.agent, label = ACP_AGENTS[id].label;
    if (this.closed) throw new StoreError('ros.ai is stopping.', 503);
    const found = this.cached(id) ?? await this.probe(id);
    if (this.active.has(request.projectId)) throw new StoreError('An agent is already working in this project.', 409);
    if (!this.port) throw new StoreError('ros.ai has not finished starting. Try again in a moment.', 503);
    const ready = this.readiness(request.projectId, id);
    if (!ready.available) throw new StoreError(ready.reason!, 503);
    const message = z.string().trim().min(1).max(12000).parse(request.message);
    const binary = found.binary!;
    const toolkit = new AgentWorkspaceTools(this.store, this.execution, this.experiments, request, request.turnId, id, label);
    const names = toolkit.definitions.map(item => item.name);
    const root = projectFolderRoot(this.store, request.projectId);
    // Gemini CLI always works from a folder of ros.ai's own (see geminiWorkspace); the others in the project folder.
    const cwd = id !== 'gemini' && root ? root : join(this.options.dataDir, 'acp', id === 'gemini' ? 'gemini' : 'work', request.projectId);
    if (cwd !== root) mkdirSync(cwd, { recursive: true, mode: 0o700 });

    const attemptId = randomUUID(), token = randomBytes(32).toString('hex');
    let attempt: Attempt = { id: attemptId, projectId: request.projectId, assistantTurnId: request.turnId, agent: id, at: now(), status: 'running', version: found.version, request: { cwd, folder: root, tools: names, maxSeconds: MAX_SECONDS, maxToolCalls: MAX_TOOL_CALLS, automaticRetry: false }, events: [], reply: '' };
    const save = () => this.store.saveRecord('acp-attempt', attemptId, request.projectId, attempt);
    const event = (value: AgentEvent) => { if (attempt.events.length < 300) { attempt.events.push(value); save(); } request.onEvent(value); };
    save();

    let toolCalls = 0, stopped = false, timedOut = false, refused = '', thoughtMark = 0, segment = 0;
    const stopTools = new AbortController();
    toolkit.signal = AbortSignal.any([request.signal, stopTools.signal]);
    // What the agent wrote since its last tool call is shown as the reason for the next one.
    const thought = () => { const value = attempt.reply.slice(thoughtMark).trim(); thoughtMark = attempt.reply.length; if (value) event({ at: now(), type: 'thought', message: value.length > 600 ? `…${value.slice(-600)}` : value }); };
    const reply = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) });
    const turn: Turn = {
      tools: toolkit.definitions.map(({ name, description, inputSchema }) => { const { $schema: _schema, ...schema } = inputSchema as Record<string, unknown>; return { name, description, inputSchema: schema, annotations: { readOnlyHint: READ_ONLY_TOOLS.has(name) } }; }),
      listed: false,
      call: async (name, args) => {
        if (stopped) return reply('The turn has stopped. No tool effect was applied.', true);
        if (!names.includes(name)) return reply(`ros.ai has no tool named ${name}.`, true);
        if (++toolCalls > MAX_TOOL_CALLS) return reply(`This turn reached its limit of ${MAX_TOOL_CALLS} ros.ai tool calls. No effect was applied; finish your answer.`, true);
        const call = toolCalls;
        thought(); segment = attempt.reply.length;
        event({ at: now(), type: 'tool', message: `${label} requested ${name}.`, data: { name, arguments: args }, step: agentStep(call, name, args) });
        try { const result = await toolkit.call(name, args); event({ at: now(), type: 'tool', message: `${name} returned a validated result.`, data: result, step: agentStep(call, name, args, { value: result }) }); return reply(JSON.stringify(result)); }
        catch (error) { const value = error instanceof StoreError ? error.message : error instanceof z.ZodError ? `The arguments did not pass ros.ai's checks; nothing was changed. ${z.prettifyError(error).slice(0, 1500)}` : 'Tool arguments failed ros.ai validation. No effect was applied.'; event({ at: now(), type: 'tool', message: value, step: agentStep(call, name, args, { failed: true }) }); return reply(value, true); }
      },
    };
    this.turns.set(token, turn);

    // Tool calls the agent started, by ID: Goose names the exact tool in each one, which its permission requests then point to.
    const started = new Map<string, string>();
    const onUpdate = (params: Record<string, unknown>) => {
      if (opened && text(params.sessionId) !== opened.sessionId) return;
      const update = object(params.update), kind = text(update.sessionUpdate);
      if (kind === 'agent_message_chunk') {
        const content = object(update.content), delta = content.type === 'text' ? text(content.text) : '';
        if (!delta) return;
        if (attempt.reply.length + delta.length > REPLY_CHARACTERS) { refused = `${label}’s answer exceeded the local capture limit.`; stop(); return; }
        attempt.reply += delta; event({ at: now(), type: 'delta', message: delta });
      } else if (kind === 'tool_call') {
        // Text before a tool call is its reason, not the answer. The call to ros.ai's endpoint can overtake this
        // update, which comes on the agent's own channel in order with its text, so both mark where the answer starts.
        thought(); segment = attempt.reply.length;
        // Goose names the tool in _meta; Gemini CLI starts each call's ID with it ("mcp_rosai_ros_read_canvas__…").
        const callId = text(update.toolCallId), title = text(update.title);
        const meta = text(object(object(object(update._meta).goose).toolCall).toolName) || (id === 'gemini' ? callId.split('__')[0]! : '');
        if (callId) started.set(callId, meta || title);
        if (!rosTool(id, meta, title, names)) event({ at: now(), type: 'progress', message: ownTool(label, update, root), data: { title, kind: update.kind } });
      } else if (kind === 'usage_update') attempt.usage = { used: update.used, size: update.size, cost: update.cost };
    };
    const onRequest = async (method: string, params: Record<string, unknown>) => {
      if (method === 'session/request_permission') {
        const call = object(params.toolCall), callId = text(call.toolCallId), title = text(call.title);
        const allow = id === 'goose' && !stopped && rosTool(id, started.get(callId) ?? '', title, names);
        if (!allow) event({ at: now(), type: 'approval', message: `Refused ${label}’s request to use ${title || 'one of its own tools'}: only ros.ai’s tools run here.`, data: { title, kind: call.kind } });
        return allow ? choose(params, ['allow_once', 'allow_always']) : refuse(params);
      }
      if (method === 'fs/read_text_file') return readFile(root, params);
      if (method === 'fs/write_text_file') throw new RpcError(-32000, 'ros.ai does not let agents write files. Propose changes with the ros.ai tools.');
      if (method.startsWith('terminal/')) throw new RpcError(-32000, 'ros.ai does not let agents run commands.');
      throw new RpcError(-32601, `ros.ai does not offer ${method}.`);
    };

    let opened: Opened | null = null, sent = false, settle: 'completed' | 'failed' | 'interrupted' | 'uncertain' = 'failed', cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return; stopped = true; stopTools.abort();
      if (!opened) return;
      opened.connection.notify('session/cancel', { sessionId: opened.sessionId });
      // An agent that does not end the prompt after a cancel is stopped.
      cancelTimer = setTimeout(() => opened?.connection.close(new StoreError(`${label} did not stop when asked and was closed.`, 503)), 5000);
    };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, MAX_SECONDS * 1000);
    request.signal.addEventListener('abort', stop, { once: true });
    let finish: () => void = () => {};
    this.active.set(request.projectId, { stop, done: new Promise<void>(resolve => { finish = resolve; }) });
    try {
      const prior = this.store.record<Session>('acp-session', request.projectId);
      opened = await this.open(id, binary, cwd, { tools: names, folder: root, token, prior, onUpdate, onRequest });
      const connection = opened.connection;
      attempt = { ...attempt, sessionId: opened.sessionId, mcp: opened.mcp ?? undefined, request: { ...object(attempt.request), resumed: opened.resumed, mode: opened.mode, model: opened.model, agentInfo: opened.agentInfo } }; save();
      // Gemini CLI connects to its MCP servers while it opens a session; without ros.ai's tools a turn could only talk.
      if (id === 'gemini' && !turn.listed) throw new StoreError(`Gemini CLI did not connect to ros.ai’s tools, so ros.ai stopped before sending anything. ${GEMINI_MCP_HINT}`, 503);
      event({ at: now(), type: 'progress', message: `${label} ${opened.resumed ? 'continued this project’s conversation' : 'opened a session'}${opened.model ? ` with ${opened.model}` : ''}. Only ros.ai’s tools${id === 'goose' ? '' : ' and reading the project folder'} are on.` });
      this.store.saveRecord('acp-session', request.projectId, request.projectId, { agent: id, sessionId: opened.sessionId, cwd, folder: root, state: 'uncertain', at: now() } satisfies Session);
      if (stopped) throw new StoreError(`${label} was stopped before the prompt was sent.`, 409);
      const place = !root ? 'This project has no folder on disk, so no files are available; use the selected material and the ros.ai tools.' : id === 'gemini' ? `The project folder is in your workspace: ${root}\nUse full paths to read its files.` : `The project folder is your working directory: ${root}`;
      const prompt = `${opened.resumed ? 'ros.ai’s instructions from the start of this conversation still apply.' : acpInstructions(id)}\n\n${place}\n\n${selectionText(toolkit.preview())}\n\n${request.preferences ? `${request.preferences}\n\n` : ''}Researcher's message:\n${message}`;
      attempt.request = { ...object(attempt.request), prompt }; save();
      const exited = new Promise<never>((_, reject) => { connection.onExit = reject; });
      sent = true;
      const result = await Promise.race([connection.request<{ stopReason?: string; usage?: unknown }>('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: prompt }] }, 0), exited]);
      attempt.stopReason = text(result.stopReason); if (result.usage) attempt.usage = result.usage;
      const usage = object(attempt.usage), tokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : typeof usage.used === 'number' ? usage.used : null;
      if (tokens !== null) event({ at: now(), type: 'usage', message: `${label} reported ${tokens.toLocaleString('en-US')} tokens for this turn; its provider bills them to your own account.`, data: attempt.usage });
      if (refused) throw new StoreError(refused, 503);
      if (timedOut) throw new StoreError(`${label} reached the ${MAX_SECONDS / 60}-minute limit for one turn and was stopped.`, 503);
      if (stopped || attempt.stopReason === 'cancelled') { settle = 'interrupted'; throw new StoreError(`${label} was stopped.`, 409); }
      if (attempt.stopReason === 'refusal') throw new StoreError(`${label} refused this request.`, 503);
      if (attempt.stopReason === 'max_turn_requests') throw new StoreError(`${label} reached its own step limit before finishing.`, 503);
      // The answer is what the agent wrote after its last tool call; earlier text was its reasons for those calls.
      const answer = (attempt.reply.slice(segment).trim() || attempt.reply.trim());
      if (!answer) throw new StoreError(`${label} finished without a readable answer.`, 503);
      attempt = { ...attempt, status: 'completed', reply: attempt.reply }; save(); settle = 'completed';
      this.store.saveRecord('acp-session', request.projectId, request.projectId, { agent: id, sessionId: opened.sessionId, cwd, folder: root, state: 'ready', at: now() } satisfies Session);
      return { reply: answer, sessionId: opened.sessionId, actions: toolkit.actions, requestId: attemptId, model: opened.model };
    } catch (error) {
      // Until the prompt is sent the agent has done nothing; after, it may have.
      if (settle !== 'interrupted') settle = sent ? 'uncertain' : 'failed';
      const detail = error instanceof StoreError ? error.message : error instanceof RpcError ? `${label} reported an error: ${error.message}` : `${label} failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}. Nothing was repeated.`;
      attempt = { ...attempt, status: stopped && !refused && !timedOut ? 'interrupted' : settle, error: detail }; save();
      throw new StoreError(detail, error instanceof StoreError ? error.status : 503);
    } finally {
      clearTimeout(deadline); clearTimeout(cancelTimer); request.signal.removeEventListener('abort', stop);
      this.turns.delete(token); opened?.connection.close(); this.active.delete(request.projectId); finish(); void toolkit.close();
    }
  }

  /** ros.ai's tools for the turn whose token the agent sends: Streamable HTTP with JSON answers, no stream. */
  async handleMcp(req: Request, res: Response) {
    const token = /^Bearer ([a-f0-9]{64})$/u.exec(req.headers.authorization ?? '')?.[1];
    const turn = token ? this.turns.get(token) : undefined;
    if (!turn) return void res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This ros.ai turn has ended.' } });
    const messages: Rpc[] = Array.isArray(req.body) ? req.body : [req.body];
    const replies: unknown[] = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object' || typeof message.method !== 'string') { if (message && typeof message === 'object' && 'id' in message && !('method' in message)) continue; replies.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } }); continue; }
      if (message.id === undefined || message.id === null) continue; // Notifications need no answer.
      const params = object(message.params), answer = (result: unknown) => replies.push({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') { const requested = text(params.protocolVersion); answer({ protocolVersion: MCP_PROTOCOLS.includes(requested) ? requested : MCP_PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ros-ai', title: 'ros.ai', version: '0.1.0' }, instructions: MCP_INSTRUCTIONS }); }
      else if (message.method === 'ping') answer({});
      else if (message.method === 'tools/list') { turn.listed = true; answer({ tools: turn.tools }); }
      else if (message.method === 'tools/call') answer(await turn.call(text(params.name), params.arguments ?? {}));
      else replies.push({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `ros.ai does not support ${message.method}.` } });
    }
    if (!replies.length) return void res.status(202).end();
    res.json(Array.isArray(req.body) ? replies : replies[0]);
  }

  async shutdown() { this.closed = true; for (const value of this.active.values()) value.stop(); await Promise.allSettled([...this.active.values()].map(value => value.done)); }
}

/** A ros.ai tool, as the agent names it: OpenCode "rosai_ros_read_canvas", Goose "rosai__ros_read_canvas"
 * (or the title "rosai: ros read canvas"), Gemini CLI a title naming the tool. Used to tell ros.ai's
 * tools apart from the agent's own in its updates, and for Goose to answer its permission requests. */
function rosTool(id: AcpAgentId, name: string, title: string, tools: string[]) {
  if (id === 'goose') {
    if (name.includes('__')) return name.startsWith(`${SERVER}__`) && tools.includes(name.slice(SERVER.length + 2));
    const match = /^rosai: ([a-z ]+)$/u.exec(title.split(' · ')[0] ?? '');
    return Boolean(match && tools.includes(match[1].replace(/ /gu, '_')));
  }
  const value = name || title;
  return tools.some(tool => value === tool || value === `${SERVER}_${tool}` || value.startsWith(`${tool} (`) || value.includes(`mcp_${SERVER}_${tool}`));
}
/** Runs an agent's binary for a moment (--version, --help) without blocking ros.ai. */
function briefly(binary: string, args: string[], env: NodeJS.ProcessEnv, timeout: number) {
  return new Promise<{ ok: boolean; stdout: string; output: string }>(done => execFile(binary, args, { encoding: 'utf8', timeout, maxBuffer: 2_000_000, env }, (error, stdout, stderr) => done({ ok: !error, stdout: `${stdout ?? ''}`, output: `${stdout ?? ''}${stderr ?? ''}` })));
}
/** A session config option by its category ("mode", "model"), as session/new and set_config_option name them. */
function configOption(result: Record<string, unknown>, category: string) {
  const options = Array.isArray(result.configOptions) ? result.configOptions.map(object) : [];
  return options.find(item => item.category === category) ?? options.find(item => item.id === category);
}
/** The values a select option offers, groups flattened. */
function choices(option: Record<string, unknown>) {
  const list = Array.isArray(option.options) ? option.options.map(object) : [];
  return list.flatMap(item => Array.isArray(item.options) ? item.options.map(object) : [item]).map(item => text(item.value)).filter(Boolean);
}
/** One of the agent's own tool calls, as a step: reads and searches by the path in the project folder they touched. */
function ownTool(label: string, update: Record<string, unknown>, root: string | null) {
  const title = text(update.title), location = text(object(Array.isArray(update.locations) ? update.locations[0] : null).path);
  const where = location && root && inside(root, location) ? relative(root, location) || 'the project folder' : title;
  if (update.kind === 'read') return `${label} read ${where || 'a file'}.`;
  if (update.kind === 'search') return `${label} searched ${where || 'the project folder'}.`;
  return `${label} asked to use ${title || 'one of its own tools'}.`;
}
function choose(params: Record<string, unknown>, kinds: string[]) {
  const options = Array.isArray(params.options) ? params.options.map(object) : [];
  for (const kind of kinds) { const option = options.find(item => item.kind === kind && text(item.optionId)); if (option) return { outcome: { outcome: 'selected', optionId: text(option.optionId) } }; }
  return null;
}
/** Every permission request outside ros.ai's tools is refused once; the agent hears no and goes on. */
function refuse(params: Record<string, unknown>) { return choose(params, ['reject_once', 'reject_always']) ?? { outcome: { outcome: 'cancelled' } }; }
/** The agent reads files in the project folder through ros.ai, which checks each path (and where a link leads). */
function readFile(root: string | null, params: Record<string, unknown>) {
  const path = text(params.path);
  if (!root || !isAbsolute(path) || !inside(root, path)) throw new RpcError(-32000, 'Only files inside this project folder can be read.');
  let real: string;
  try { real = realpathSync(path); } catch { throw new RpcError(-32002, `Resource not found: ${path}`); }
  const info = statSync(real);
  if (!info.isFile()) throw new RpcError(-32000, 'That is not a file.');
  if (info.size > READ_BYTES) throw new RpcError(-32000, `The file is larger than ${READ_BYTES / 1_000_000} MB; read part of it with a search instead.`);
  let content = readFileSync(real, 'utf8');
  const line = Number(params.line), limit = Number(params.limit);
  if ((Number.isInteger(line) && line > 1) || (Number.isInteger(limit) && limit > 0)) {
    const start = Number.isInteger(line) && line > 0 ? line - 1 : 0, lines = content.split('\n');
    content = lines.slice(start, Number.isInteger(limit) && limit > 0 ? start + limit : undefined).join('\n');
  }
  return { content };
}

export function attachAcpAgentRoutes(app: Express, service: AcpAgentService) {
  const agent = (value: unknown) => { if (!isAcpAgent(value)) throw new StoreError('Unknown agent.', 404); return value; };
  app.get('/api/agents/acp', async (req, res) => res.json({ agents: await service.statuses(req.query.refresh === '1') }));
  app.post('/api/agents/acp/:agent/check', async (req, res) => res.json(await service.check(agent(req.params.agent))));
  app.post('/mcp/turn', (req, res) => service.handleMcp(req, res));
  // No server-to-client stream is offered; a turn's endpoint ends with the turn.
  app.get('/mcp/turn', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp/turn', (_req, res) => res.status(204).end());
}
