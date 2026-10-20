import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexRateLimit, CodexRateLimits } from '../shared/budget-report.js';

const rateLimit = (value: unknown): CodexRateLimit | null => {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!item || typeof item.usedPercent !== 'number' || !Number.isFinite(item.usedPercent)) return null;
  const minutes = typeof item.windowDurationMins === 'number' && item.windowDurationMins > 0 ? item.windowDurationMins : null;
  const resets = typeof item.resetsAt === 'number' && item.resetsAt > 0 ? new Date(item.resetsAt * (item.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null;
  return { usedPercent: Math.min(100, Math.max(0, item.usedPercent)), windowMinutes: minutes, resetsAt: resets };
};
/** Codex reports how much of the ChatGPT plan's rolling windows has been used. */
function parseRateLimits(value: unknown): CodexRateLimits | null {
  const limits = value && typeof value === 'object' ? (value as { rateLimits?: Record<string, unknown> }).rateLimits : undefined;
  if (!limits) return null;
  const parsed = { primary: rateLimit(limits.primary), secondary: rateLimit(limits.secondary) };
  return parsed.primary || parsed.secondary ? parsed : null;
}
import { StoreError } from './store.js';

type Rpc = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type CodexProtocol = { appServer: boolean; dynamicTools: boolean; interrupt: boolean; restrictedReadAccess: boolean };
export const codexBinary = () => process.env.ROS_CODEX_BINARY || 'codex';
const disabledFeatures = ['shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode', 'code_mode_only', 'multi_agent', 'image_generation', 'hooks', 'workspace_dependencies', 'memories', 'skill_mcp_dependency_install'];

/** Process-only overrides; never edits the user's Codex config or auth store. */
export function codexProcessArgs(disabledMcp: string[] = []) {
  if (disabledMcp.some(key => !/^[A-Za-z0-9_-]+$/.test(key))) throw new StoreError('An inherited MCP server name cannot be safely disabled with this installed CLI. Embedded turns remain unavailable.', 503);
  const entries: [string, unknown][] = [
    ['model_provider', 'ros_ai_local'], ['approval_policy', 'never'], ['sandbox_mode', 'read-only'],
    ['web_search', 'disabled'], ['analytics.enabled', false], ['allow_login_shell', false],
    ['project_doc_max_bytes', 0],
    ['memories.generate_memories', false], ['memories.use_memories', false],
    ['model_providers.ros_ai_local.name', 'ros.ai native Codex authentication'],
    ['model_providers.ros_ai_local.requires_openai_auth', true], ['model_providers.ros_ai_local.wire_api', 'responses'],
    ['model_providers.ros_ai_local.request_max_retries', 0], ['model_providers.ros_ai_local.stream_max_retries', 0],
    ['model_providers.ros_ai_local.supports_websockets', false],
    ...disabledFeatures.map((key): [string, unknown] => [`features.${key}`, false]),
    ...disabledMcp.map((key): [string, unknown] => [`mcp_servers.${key}.enabled`, false]),
  ];
  return ['app-server', '--listen', 'stdio://', ...entries.flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
}
export function childEnvironment(): NodeJS.ProcessEnv {
  // Provider keys from the ros.ai server are not forwarded to the agent process.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function inspectCodexProtocol(): CodexProtocol {
  const directory = mkdtempSync(join(tmpdir(), 'ros-ai-codex-schema-'));
  try {
    const result = spawnSync(codexBinary(), ['app-server', 'generate-json-schema', '--experimental', '--out', directory], { encoding: 'utf8', timeout: 10000, maxBuffer: 20000, env: childEnvironment() });
    if (result.status !== 0) return { appServer: false, dynamicTools: false, interrupt: false, restrictedReadAccess: false };
    const thread = JSON.parse(readFileSync(join(directory, 'v2/ThreadStartParams.json'), 'utf8'));
    const turn = JSON.parse(readFileSync(join(directory, 'v2/TurnStartParams.json'), 'utf8'));
    const request = readFileSync(join(directory, 'ClientRequest.json'), 'utf8');
    const readonly = (turn.definitions?.SandboxPolicy?.oneOf as { properties?: { type?: { enum?: string[] }; access?: unknown } }[] | undefined)?.find(v => v.properties?.type?.enum?.includes('readOnly'));
    return { appServer: true, dynamicTools: Boolean(thread.properties?.dynamicTools), interrupt: request.includes('turn/interrupt'), restrictedReadAccess: Boolean(readonly?.properties?.access) && JSON.stringify(turn).includes('readableRoots') };
  } catch { return { appServer: false, dynamicTools: false, interrupt: false, restrictedReadAccess: false }; }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
export function readCliStatus() {
  const run = (file: string, args: string[]) => spawnSync(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 20000, env: childEnvironment() });
  const version = run(codexBinary(), ['--version']), login = version.status === 0 ? run(codexBinary(), ['login', 'status']) : null;
  const output = `${login?.stdout ?? ''}\n${login?.stderr ?? ''}`;
  return {
    installed: version.status === 0, version: version.status === 0 ? version.stdout.trim().slice(0, 100) : null,
    signedIn: login?.status === 0 && /logged in/i.test(output),
    authMethod: /using ChatGPT/i.test(output) ? 'chatgpt' as const : /API key/i.test(output) ? 'api-key' as const : null,
  };
}

/** Bounded newline JSON-RPC transport. No automatic replay of any request. */
export class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private pending = new Map<string | number, Pending>();
  private nextId = 1;
  private buffer = '';
  private closed = false;
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown> = async () => { throw new StoreError('This app-server request is not exposed by ros.ai.', 403); };
  onFailure: (error: Error) => void = () => {};
  constructor(cwd: string, disabledMcp: string[] = []) {
    this.process = spawn(codexBinary(), codexProcessArgs(disabledMcp), { cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Upstream diagnostics can contain local paths/account details. Never forward them.
    this.process.stderr.on('data', () => {});
    // A crashed child closes its pipe; an unhandled EPIPE would otherwise stop the whole server.
    this.process.stdin.on('error', () => this.fail(new StoreError('Codex app-server disconnected. The request outcome may be unknown; it will not be retried automatically.', 503)));
    this.process.on('error', () => this.fail(new StoreError('Codex app-server could not start. Check the installed CLI and local permissions.', 503)));
    this.process.on('exit', () => { if (!this.closed) this.fail(new StoreError('Codex app-server disconnected. The request outcome may be unknown; it will not be retried automatically.', 503)); });
  }
  private receive(chunk: string) {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4_000_000) { this.fail(new StoreError('Codex protocol output exceeded the local capture limit.', 503)); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Rpc;
      try { message = JSON.parse(line); } catch { this.fail(new StoreError('Codex returned an invalid protocol message. No automatic retry is permitted.', 503)); return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new StoreError(`Codex rejected the ${message.error.code ?? 'protocol'} request. Check protocol compatibility, authentication and permissions; no retry was sent.`, 503));
        else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        const requestId = message.id;
        void this.onRequest(requestId, message.method, message.params ?? {}).then(result => this.send({ id: requestId, result })).catch(() => this.send({ id: requestId, error: { code: -32601, message: 'Request unavailable under the ros.ai selection boundary.' } }));
      } else if (message.method) this.onNotification(message.method, message.params ?? {});
    }
  }
  private send(message: Rpc) { if (!this.closed && this.process.stdin.writable) this.process.stdin.write(`${JSON.stringify(message)}\n`); }
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    if (this.closed) return Promise.reject(new StoreError('Codex app-server is unavailable.', 503));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new StoreError(`Codex ${method} timed out. The outcome is uncertain and no retry was sent.`, 503)); }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'ros_ai_local', title: 'ros.ai local research workspace', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  async inspectConnection() {
    await this.initialize();
    const account = await this.request<{ account?: { type?: string } | null; requiresOpenaiAuth?: boolean }>('account/read', { refreshToken: false });
    const value = await this.request<{ config?: { features?: Record<string, unknown>; mcp_servers?: Record<string, { enabled?: boolean }>; model_provider?: string; model_providers?: Record<string, { requires_openai_auth?: boolean; request_max_retries?: number; stream_max_retries?: number }> } }>('config/read', { includeLayers: false });
    const config = value.config ?? {}, mcpNames = Object.entries(config.mcp_servers ?? {}).filter(([, v]) => v.enabled !== false).map(([key]) => key);
    const provider = config.model_providers?.ros_ai_local;
    // Managed/local layers may supersede overrides; inspect the effective config
    // rather than treating argv as proof of disabled upstream request replay.
    const noRetry = config.model_provider === 'ros_ai_local' && provider?.requires_openai_auth === true && provider.request_max_retries === 0 && provider.stream_max_retries === 0;
    const enforced = noRetry && disabledFeatures.every(key => config.features?.[key] === false);
    // Plan limits are best effort: older Codex versions do not answer this request.
    let rateLimits: CodexRateLimits | null = null;
    if (account.account) try { rateLimits = parseRateLimits(await this.request('account/rateLimits/read', {}, 5000)); } catch { rateLimits = null; }
    return { rateLimits, signedIn: Boolean(account.account), authMethod: account.account?.type === 'chatgpt' ? 'chatgpt' as const : account.account?.type === 'apiKey' ? 'api-key' as const : null, disabledMcp: mcpNames, toolRestrictionsConfigured: enforced };
  }
  private fail(error: Error) { if (this.closed) return; this.onFailure(error); this.close(error); }
  close(reason: Error = new StoreError('Codex connection closed; active outcomes are preserved.', 503)) {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear(); this.process.stdin.end(); this.process.kill('SIGTERM');
  }
}
