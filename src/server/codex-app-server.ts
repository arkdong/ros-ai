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
export type CodexProtocol = { appServer: boolean; dynamicTools: boolean; interrupt: boolean; restrictedReadAccess: boolean; permissionProfiles: boolean };
const noProtocol: CodexProtocol = { appServer: false, dynamicTools: false, interrupt: false, restrictedReadAccess: false, permissionProfiles: false };
/** How Codex is kept to reading only its session folder: older CLIs take restricted read roots with each turn,
 * newer ones (which dropped those) a named permission profile set when the process starts. */
export type CodexIsolation = 'read-roots' | 'profile';
export const codexIsolation = (protocol: CodexProtocol): CodexIsolation | null => protocol.restrictedReadAccess ? 'read-roots' : protocol.permissionProfiles ? 'profile' : null;
/** ros.ai's own permission profile: read the session folder and the platform's minimal files, no network. */
export const PERMISSION_PROFILE = 'ros_ai';
/** Codex on the person's OpenAI API key instead of their ChatGPT plan. The key reaches only this process, under a
 * CODEX_HOME of its own, so the person's Codex sign-in, settings and history are never in reach. */
export type CodexApiKey = { key: string; home: string; baseUrl: string; model: string };
export const API_KEY_ENV = 'OPENAI_API_KEY';
export const codexProvider = (api: boolean) => api ? 'ros_ai_api' : 'ros_ai_local';
export type CodexProcessOptions = { disabledMcp?: string[]; isolation?: CodexIsolation | null; api?: CodexApiKey | null };
export const codexBinary = () => process.env.ROS_CODEX_BINARY || 'codex';
const disabledFeatures = ['shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode', 'code_mode_only', 'multi_agent', 'image_generation', 'hooks', 'workspace_dependencies', 'memories', 'skill_mcp_dependency_install'];
// -c values are TOML; a permission profile's folders are an inline table.
const toml = (value: unknown): string => value && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}` : JSON.stringify(value);
const profileFolders = (cwd: string) => ({ ':minimal': 'read', [cwd]: 'read' });

/** Process-only overrides; never edits the user's Codex config or auth store. */
export function codexProcessArgs(cwd: string, { disabledMcp = [], isolation = 'read-roots', api = null }: CodexProcessOptions = {}) {
  if (disabledMcp.some(key => !/^[A-Za-z0-9_-]+$/.test(key))) throw new StoreError('An inherited MCP server name cannot be safely disabled with this installed CLI. Embedded turns remain unavailable.', 503);
  const provider = codexProvider(Boolean(api));
  const entries: [string, unknown][] = [
    ['model_provider', provider], ['approval_policy', 'never'],
    // Newer Codex confines a thread with ros.ai's permission profile; read-only stays as the fallback either way,
    // in place of whatever sandbox_mode the person's own config sets.
    ['sandbox_mode', 'read-only'],
    ...(isolation === 'profile' ? [['default_permissions', PERMISSION_PROFILE], [`permissions.${PERMISSION_PROFILE}.filesystem`, profileFolders(cwd)], [`permissions.${PERMISSION_PROFILE}.network.enabled`, false]] as [string, unknown][] : []),
    ['web_search', 'live'], ['analytics.enabled', false], ['allow_login_shell', false],
    ['project_doc_max_bytes', 0],
    ['memories.generate_memories', false], ['memories.use_memories', false],
    [`model_providers.${provider}.name`, api ? 'OpenAI API key from ros.ai' : 'ros.ai native Codex authentication'],
    [`model_providers.${provider}.requires_openai_auth`, !api], [`model_providers.${provider}.wire_api`, 'responses'],
    ...(api ? [[`model_providers.${provider}.base_url`, api.baseUrl], [`model_providers.${provider}.env_key`, API_KEY_ENV], ['model', api.model]] as [string, unknown][] : []),
    [`model_providers.${provider}.request_max_retries`, 0], [`model_providers.${provider}.stream_max_retries`, 0],
    [`model_providers.${provider}.supports_websockets`, false],
    ...disabledFeatures.map((key): [string, unknown] => [`features.${key}`, false]),
    ...disabledMcp.map((key): [string, unknown] => [`mcp_servers.${key}.enabled`, false]),
  ];
  return ['app-server', '--listen', 'stdio://', ...entries.flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])];
}
export function childEnvironment(api: CodexApiKey | null = null): NodeJS.ProcessEnv {
  // Provider keys from the ros.ai server are not forwarded to the agent process, except the OpenAI key when Codex runs on it.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
  if (api) { env.CODEX_HOME = api.home; if (api.key) env[API_KEY_ENV] = api.key; }
  return env;
}
export function inspectCodexProtocol(): CodexProtocol {
  const directory = mkdtempSync(join(tmpdir(), 'ros-ai-codex-schema-'));
  try {
    const result = spawnSync(codexBinary(), ['app-server', 'generate-json-schema', '--experimental', '--out', directory], { encoding: 'utf8', timeout: 10000, maxBuffer: 20000, env: childEnvironment() });
    if (result.status !== 0) return noProtocol;
    const thread = JSON.parse(readFileSync(join(directory, 'v2/ThreadStartParams.json'), 'utf8'));
    const resume = JSON.parse(readFileSync(join(directory, 'v2/ThreadResumeParams.json'), 'utf8'));
    const turn = JSON.parse(readFileSync(join(directory, 'v2/TurnStartParams.json'), 'utf8'));
    const request = readFileSync(join(directory, 'ClientRequest.json'), 'utf8');
    const readonly = (turn.definitions?.SandboxPolicy?.oneOf as { properties?: { type?: { enum?: string[] }; access?: unknown } }[] | undefined)?.find(v => v.properties?.type?.enum?.includes('readOnly'));
    return { appServer: true, dynamicTools: Boolean(thread.properties?.dynamicTools), interrupt: request.includes('turn/interrupt'), restrictedReadAccess: Boolean(readonly?.properties?.access) && JSON.stringify(turn).includes('readableRoots'),
      permissionProfiles: [thread, resume, turn].every(params => Boolean(params.properties?.permissions)) };
  } catch { return noProtocol; }
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
  constructor(private readonly cwd: string, private readonly options: CodexProcessOptions = {}) {
    this.process = spawn(codexBinary(), codexProcessArgs(cwd, options), { cwd, env: childEnvironment(options.api), stdio: ['pipe', 'pipe', 'pipe'] });
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
    const value = await this.request<{ config?: { features?: Record<string, unknown>; mcp_servers?: Record<string, { enabled?: boolean }>; model_provider?: string; model_providers?: Record<string, { requires_openai_auth?: boolean; request_max_retries?: number; stream_max_retries?: number; env_key?: string | null; base_url?: string | null }>; default_permissions?: string | null; sandbox_mode?: string | null; permissions?: Record<string, { filesystem?: Record<string, unknown> | null; network?: { enabled?: boolean | null } | null }> } }>('config/read', { includeLayers: false });
    const config = value.config ?? {}, mcpNames = Object.entries(config.mcp_servers ?? {}).filter(([, v]) => v.enabled !== false).map(([key]) => key);
    const api = this.options.api ?? null, name = codexProvider(Boolean(api)), provider = config.model_providers?.[name];
    // Managed/local layers may supersede overrides; inspect the effective config
    // rather than treating argv as proof of disabled upstream request replay.
    const noRetry = config.model_provider === name && provider?.requires_openai_auth === !api && provider.request_max_retries === 0 && provider.stream_max_retries === 0;
    // On an API key, requests go only to the address ros.ai set, with only the key it passed.
    const billed = !api || (provider?.env_key === API_KEY_ENV && provider.base_url === api.baseUrl);
    const enforced = noRetry && billed && this.isolated(config) && disabledFeatures.every(key => config.features?.[key] === false);
    // Plan limits are best effort: older Codex versions do not answer this request.
    let rateLimits: CodexRateLimits | null = null;
    if (account.account) try { rateLimits = parseRateLimits(await this.request('account/rateLimits/read', {}, 5000)); } catch { rateLimits = null; }
    return { rateLimits, signedIn: Boolean(account.account), authMethod: account.account?.type === 'chatgpt' ? 'chatgpt' as const : account.account?.type === 'apiKey' ? 'api-key' as const : null, disabledMcp: mcpNames, toolRestrictionsConfigured: enforced };
  }
  /** Under a permission profile, the effective one must be ros.ai's: the session folder and the minimal platform files to read, and no network. */
  private isolated(config: { default_permissions?: string | null; sandbox_mode?: string | null; permissions?: Record<string, { filesystem?: Record<string, unknown> | null; network?: { enabled?: boolean | null } | null }> }) {
    if (this.options.isolation !== 'profile') return true;
    const profile = config.permissions?.[PERMISSION_PROFILE], folders = Object.entries(profile?.filesystem ?? {}).filter(([, access]) => access !== null);
    const expected = Object.entries(profileFolders(this.cwd));
    return config.default_permissions === PERMISSION_PROFILE && (config.sandbox_mode ?? 'read-only') === 'read-only' && profile?.network?.enabled === false
      && folders.length === expected.length && expected.every(([path, access]) => folders.some(([key, value]) => key === path && value === access));
  }
  private fail(error: Error) { if (this.closed) return; this.onFailure(error); this.close(error); }
  close(reason: Error = new StoreError('Codex connection closed; active outcomes are preserved.', 503)) {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear(); this.process.stdin.end(); this.process.kill('SIGTERM');
  }
}
