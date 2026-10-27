import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AgentId, AppId, DetectedApp, DetectedModel, LinkMethod, LocalModel } from '../shared/setup.js';

/** What is installed on this computer, from existence, names and modification times.
 * Credential files are checked for existence and never opened. Agent settings are parsed for the
 * names of their MCP servers and everything else in them is dropped. Nothing leaves the computer. */

export const win = process.platform === 'win32', mac = process.platform === 'darwin';
const DAY = 86_400_000;
const home = homedir();
const appData = win ? process.env.APPDATA || join(home, 'AppData', 'Roaming') : '';
const localAppData = win ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local') : '';

export const exists = (path: string) => { try { return existsSync(path); } catch { return false; } };
const isDir = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const modifiedAt = (path: string) => { try { return statSync(path).mtimeMs; } catch { return null; } };
const recent = (path: string, days = 7) => { const at = modifiedAt(path); return at !== null && Date.now() - at < days * DAY; };
/** A path for people: the home folder as ~. */
export const pretty = (path: string) => path.startsWith(home) ? `~${path.slice(home.length)}` : path;
const signals = (facts: Record<string, boolean>) => Object.entries(facts).filter(([, on]) => on).map(([name]) => name);
/** A macOS app bundle in either Applications folder. */
const app = (name: string) => mac && (exists(`/Applications/${name}.app`) || exists(join(home, 'Applications', `${name}.app`)));

function nvmBins() { const root = join(home, '.nvm', 'versions', 'node'); try { return readdirSync(root).map(version => join(root, version, 'bin')); } catch { return []; } }
/** PATH plus the folders installers use, because an app opened from the Finder or a shortcut sees a short PATH. */
function searchDirs() {
  const extra = win ? [join(appData, 'npm'), join(localAppData, 'Programs', 'cursor', 'resources', 'app', 'bin')]
    : ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), join(home, '.codex', 'bin'), join(home, '.claude', 'local'), join(home, '.opencode', 'bin'), join(home, '.cargo', 'bin'), ...nvmBins()];
  return [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extra])];
}
/** The first runnable file of this name on the search path, or an explicit path when it exists. */
export function findBinary(name: string): string | null {
  if (/[\\/]/.test(name)) return exists(name) && !isDir(name) ? name : null;
  const files = win ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of searchDirs()) for (const file of files) {
    const path = join(dir, file);
    try { accessSync(path, win ? constants.F_OK : constants.X_OK); if (!isDir(path)) return path; } catch { /* not here */ }
  }
  return null;
}

type Shape = { servers: string[]; keys: string[] };
/** The top-level key names and the names under mcpServers of a JSON settings file. Values are never kept. */
function jsonShape(file: string): Shape | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { servers: [], keys: [] };
    const servers = (value as { mcpServers?: unknown }).mcpServers;
    return { servers: servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [], keys: Object.keys(value) };
  } catch { return { servers: [], keys: [] }; }
}
/** The names of the [mcp_servers.<name>] tables in a Codex config.toml. */
function tomlServers(file: string): string[] | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  return [...text.matchAll(/^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))[ \t]*\]/gmu)].map(match => match[1] ?? match[2] ?? match[3] ?? '').filter(Boolean);
}
const others = (servers: string[] | null | undefined) => (servers ?? []).filter(name => name !== 'ros-ai');

/** One agent as the scan found it; the link command, record and sessions are added by Setup. */
export type Found = { id: AgentId; label: string; sessionLabel: string; found: boolean; signals: string[]; signedIn: boolean | null; method: LinkMethod; binary: string | null; target: string; entry: boolean; servers: string[]; note?: string };

export function detectAgents(): Found[] {
  const claudeHome = join(home, '.claude'), claudeConfig = join(home, '.claude.json');
  const claudeBinary = findBinary(process.env.ROS_CLAUDE_BINARY || 'claude'), claudeShape = jsonShape(claudeConfig);
  // Claude Code keeps its sign-in in the keychain on a Mac, so only a positive answer is known.
  const claudeSignedIn = exists(join(claudeHome, '.credentials.json')) || Boolean(claudeShape?.keys.includes('oauthAccount')) ? true : null;
  const codexHome = process.env.CODEX_HOME || join(home, '.codex'), codexConfig = join(codexHome, 'config.toml');
  const codexBinary = findBinary(process.env.ROS_CODEX_BINARY || 'codex'), codexServers = tomlServers(codexConfig), codexApp = app('Codex');
  const codexSignedIn = exists(join(codexHome, 'auth.json')) ? true : isDir(codexHome) ? false : null;
  const cursorDir = join(home, '.cursor'), cursorConfig = join(cursorDir, 'mcp.json'), cursorShape = jsonShape(cursorConfig);
  const cursorApp = app('Cursor') || (win && exists(join(localAppData, 'Programs', 'cursor'))) || (!mac && !win && isDir(join(home, '.config', 'Cursor')));
  const cursorBinary = findBinary('cursor');
  const geminiDir = join(home, '.gemini'), geminiConfig = join(geminiDir, 'settings.json'), geminiShape = jsonShape(geminiConfig), geminiBinary = findBinary('gemini');
  return [
    { id: 'claude-code', label: 'Claude Code', sessionLabel: 'Claude Code', method: 'cli', binary: claudeBinary, target: claudeConfig,
      found: Boolean(claudeBinary || claudeShape || isDir(claudeHome)), signedIn: claudeSignedIn,
      signals: signals({ 'used recently': recent(join(claudeHome, 'projects')) || recent(join(claudeHome, 'history.jsonl')), 'signed in': claudeSignedIn === true, 'command line': Boolean(claudeBinary) }),
      entry: Boolean(claudeShape?.servers.includes('ros-ai')), servers: others(claudeShape?.servers) },
    { id: 'codex', label: 'Codex', sessionLabel: 'Codex', method: 'cli', binary: codexBinary, target: codexConfig,
      found: Boolean(codexBinary || codexServers || isDir(codexHome) || codexApp), signedIn: codexSignedIn,
      signals: signals({ 'used recently': recent(join(codexHome, 'sessions')) || recent(join(codexHome, 'history.jsonl')), 'signed in': codexSignedIn === true, app: codexApp, 'command line': Boolean(codexBinary) }),
      entry: Boolean(codexServers?.includes('ros-ai')), servers: others(codexServers), ...(codexApp ? { note: 'The Codex app reads the same settings.' } : {}) },
    { id: 'cursor', label: 'Cursor', sessionLabel: 'Cursor', method: 'file', binary: cursorBinary, target: cursorConfig,
      found: Boolean(cursorApp || cursorBinary || cursorShape || isDir(cursorDir)), signedIn: null,
      signals: signals({ app: cursorApp, 'command line': Boolean(cursorBinary), settings: cursorShape !== null }),
      entry: Boolean(cursorShape?.servers.includes('ros-ai')), servers: others(cursorShape?.servers) },
    { id: 'gemini-cli', label: 'Gemini CLI', sessionLabel: 'Gemini CLI', method: 'file', binary: geminiBinary, target: geminiConfig,
      found: Boolean(geminiBinary || geminiShape || isDir(geminiDir)), signedIn: exists(join(geminiDir, 'oauth_creds.json')) ? true : null,
      signals: signals({ 'used recently': recent(join(geminiDir, 'tmp')), 'signed in': exists(join(geminiDir, 'oauth_creds.json')), 'command line': Boolean(geminiBinary) }),
      entry: Boolean(geminiShape?.servers.includes('ros-ai')), servers: others(geminiShape?.servers) },
  ];
}

async function probe(url: string, ms = 500, body?: unknown): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
const items = (value: unknown, list: string): Record<string, unknown>[] | null => {
  const found = value && typeof value === 'object' ? (value as Record<string, unknown>)[list] : undefined;
  return Array.isArray(found) ? found.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : null;
};
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
/** A local server's address from a setting, when it names this computer; its usual port otherwise. Ollama reads
 * OLLAMA_HOST itself (127.0.0.1:11435, :11435 or 0.0.0.0); LM Studio's port, when changed, comes from ROS_LMSTUDIO_URL. */
function localBase(setting: string | undefined, port: number) {
  const value = setting?.trim();
  if (value) try {
    const url = new URL(/^[a-z]+:\/\//iu.test(value) ? value : `http://${value.startsWith(':') ? `127.0.0.1${value}` : value}`);
    if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(url.hostname)) return `http://127.0.0.1:${url.port || port}`;
  } catch { /* not an address */ }
  return `http://127.0.0.1:${port}`;
}
const ollamaBase = () => localBase(process.env.OLLAMA_HOST, 11434), lmStudioBase = () => localBase(process.env.ROS_LMSTUDIO_URL, 1234);

/** Ollama's own facts about each model: whether it calls tools or only embeds, the context it was trained for, and
 * the context Ollama gives it: set on the model itself, or else Ollama's default, which a model loaded now without
 * its own setting shows. (ros.ai's requests carry no context setting, so they get that default.) */
async function ollamaModels(base: string, tags: Record<string, unknown>[]): Promise<LocalModel[]> {
  const listed = tags.filter(item => typeof item.name === 'string').slice(0, 32);
  const [shows, ps] = await Promise.all([Promise.all(listed.map(item => probe(`${base}/api/show`, 1500, { model: item.name }))), probe(`${base}/api/ps`, 800)]);
  const loaded = new Map((items(ps, 'models') ?? []).map(item => [String(item.name ?? item.model), count(item.context_length)]));
  const models = listed.map((item, index) => {
    const show = shows[index] && typeof shows[index] === 'object' ? shows[index] as Record<string, unknown> : {};
    const capabilities = Array.isArray(show.capabilities) ? show.capabilities.filter((name): name is string => typeof name === 'string') : null;
    const info = show.model_info && typeof show.model_info === 'object' ? show.model_info as Record<string, unknown> : {};
    const maxContext = count(Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1]);
    const own = typeof show.parameters === 'string' ? count(Number(/^\s*num_ctx\s+(\d+)/mu.exec(show.parameters)?.[1])) : null;
    return { id: String(item.name), own, maxContext, bytes: count(item.size),
      tools: capabilities ? capabilities.includes('tools') : null, embedding: Boolean(capabilities?.includes('embedding') && !capabilities.includes('completion')) };
  });
  // A loaded model's context below what it was trained for is Ollama's default exactly; one at it is a lower bound.
  const readings = models.filter(model => model.own === null && loaded.get(model.id)).map(model => ({ context: loaded.get(model.id)!, capped: model.maxContext !== null && loaded.get(model.id)! >= model.maxContext }));
  const exact = readings.filter(reading => !reading.capped).map(reading => reading.context);
  const usual = exact.length ? Math.min(...exact) : readings.length ? Math.max(...readings.map(reading => reading.context)) : null;
  return models.map(({ own, ...model }) => ({ ...model, context: own ?? (usual !== null && model.maxContext !== null ? Math.min(usual, model.maxContext) : usual) }));
}
/** LM Studio's model list: its type, the context it was trained for, the context it is loaded with, and whether it
 * was trained for tool use. LM Studio formats tools for other models itself, so those stay unknown, not refused. */
function lmStudioModels(value: unknown): LocalModel[] | null {
  const list = items(value, 'data');
  return list && list.filter(item => typeof item.id === 'string').map(item => {
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
    return { id: String(item.id), context: count(item.loaded_context_length), maxContext: count(item.max_context_length), bytes: null,
      tools: capabilities.includes('tool_use') ? true : null, embedding: item.type === 'embeddings' };
  });
}
/** Local model servers: an installed app or command, and whether a server answers on its usual port. */
export async function detectModels(): Promise<Omit<DetectedModel, 'connectionId'>[]> {
  const ollamaAt = ollamaBase(), lmStudioAt = lmStudioBase();
  const [tags, lmDetailed, lmPlain] = await Promise.all([probe(`${ollamaAt}/api/tags`), probe(`${lmStudioAt}/api/v0/models`), probe(`${lmStudioAt}/v1/models`)]);
  const ollamaTags = items(tags, 'models'), ollama = ollamaTags ? await ollamaModels(ollamaAt, ollamaTags) : null;
  const lmStudio = lmStudioModels(lmDetailed) ?? (items(lmPlain, 'data')?.filter(item => typeof item.id === 'string').map(item => ({ id: String(item.id), context: null, maxContext: null, tools: null, embedding: /embed/i.test(String(item.id)), bytes: null })) ?? null);
  return [
    { id: 'ollama', label: 'Ollama', endpoint: `${ollamaAt}/v1`, running: ollama !== null, models: ollama?.map(model => model.id) ?? [], details: ollama ?? [],
      found: ollama !== null || app('Ollama') || Boolean(findBinary('ollama')) || isDir(join(home, '.ollama')) },
    { id: 'lm-studio', label: 'LM Studio', endpoint: `${lmStudioAt}/v1`, running: lmStudio !== null, models: lmStudio?.map(model => model.id) ?? [], details: lmStudio ?? [],
      found: lmStudio !== null || app('LM Studio') || Boolean(findBinary('lms')) || isDir(join(home, '.lmstudio')) || isDir(join(home, '.cache', 'lm-studio')) },
  ];
}
/** Loads one model in Ollama, as using it would, and reads the context Ollama gave it: its default for models
 * without their own setting. Only when the person connects Ollama, never while scanning. */
export async function ollamaDefaultContext(model: string): Promise<number | null> {
  const base = ollamaBase();
  if (!await probe(`${base}/api/generate`, 120_000, { model, stream: false })) return null;
  const ps = items(await probe(`${base}/api/ps`, 2000), 'models') ?? [];
  return count(ps.find(item => item.name === model || item.model === model)?.context_length);
}

/** Whether a Docker engine answers on one of the usual sockets. */
function dockerAnswers(): Promise<boolean> {
  const sockets = win ? [] : ['/var/run/docker.sock', join(home, '.docker', 'run', 'docker.sock'), join(home, '.colima', 'default', 'docker.sock'), join(home, '.orbstack', 'run', 'docker.sock')].filter(exists);
  return Promise.all(sockets.map(socketPath => new Promise<boolean>(settle => {
    const call = request({ socketPath, path: '/_ping', method: 'GET', timeout: 400 }, response => { response.resume(); settle(response.statusCode === 200); });
    call.on('timeout', () => { call.destroy(); settle(false); });
    call.on('error', () => settle(false));
    call.end();
  }))).then(answers => answers.some(Boolean));
}
export async function detectDocker() {
  return { found: Boolean(findBinary('docker') || app('Docker') || app('OrbStack')), running: await dockerAnswers() };
}

type AppSpec = { id: AppId; label: string; apps: string[]; folders: string[]; pattern: RegExp };
const specs: AppSpec[] = [
  { id: 'notion', label: 'Notion', apps: ['Notion'], folders: win ? [join(localAppData, 'Programs', 'Notion')] : [], pattern: /notion/i },
  { id: 'slack', label: 'Slack', apps: ['Slack'], folders: win ? [join(localAppData, 'slack')] : mac ? [] : [join(home, '.config', 'Slack'), '/snap/slack', '/usr/lib/slack'], pattern: /slack/i },
  { id: 'zotero', label: 'Zotero', apps: ['Zotero'], folders: [join(home, 'Zotero')], pattern: /zotero/i },
  { id: 'github', label: 'GitHub', apps: ['GitHub Desktop'], folders: [], pattern: /github/i },
  { id: 'obsidian', label: 'Obsidian', apps: ['Obsidian'], folders: win ? [join(localAppData, 'Obsidian')] : mac ? [] : [join(home, '.config', 'obsidian')], pattern: /obsidian/i },
  { id: 'linear', label: 'Linear', apps: ['Linear'], folders: [], pattern: /linear/i },
  { id: 'figma', label: 'Figma', apps: ['Figma'], folders: win ? [join(localAppData, 'Figma')] : [], pattern: /figma/i },
  { id: 'google-drive', label: 'Google Drive', apps: ['Google Drive'], folders: [], pattern: /g(oogle)?[ _-]?drive/i },
  { id: 'dropbox', label: 'Dropbox', apps: ['Dropbox'], folders: [join(home, 'Dropbox'), ...(mac ? [join(home, 'Library', 'CloudStorage', 'Dropbox')] : [])], pattern: /dropbox/i },
];
/** Apps on this computer, by their bundles and folders, plus the ones the person's agents already talk to. */
export async function detectApps(agents: Found[], connected: Set<string>): Promise<DetectedApp[]> {
  const [zoteroRunning, driveFolder] = await Promise.all([
    fetch('http://127.0.0.1:23119/connector/ping', { signal: AbortSignal.timeout(400) }).then(response => response.ok, () => false),
    Promise.resolve(mac && (() => { try { return readdirSync(join(home, 'Library', 'CloudStorage')).some(name => name.startsWith('GoogleDrive-')); } catch { return false; } })()),
  ]);
  const gh = Boolean(findBinary('gh')) && exists(join(home, '.config', 'gh', 'hosts.yml'));
  return specs.map(spec => {
    const usedBy = agents.filter(agent => agent.found && agent.servers.some(name => spec.pattern.test(name))).map(agent => agent.label);
    const found = signals({
      app: spec.apps.some(app) || spec.folders.some(isDir),
      running: spec.id === 'zotero' && zoteroRunning,
      'synced folder': spec.id === 'google-drive' && driveFolder,
      'signed in on the command line': spec.id === 'github' && gh,
    });
    return { id: spec.id, label: spec.label, signals: found, usedBy, connected: connected.has(spec.id) };
  }).filter(item => item.signals.length || item.usedBy.length || item.connected);
}
