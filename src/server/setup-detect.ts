import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import type { AgentId, AppConnect, AppId, DetectedApp, DetectedModel, LinkMethod, LocalModel } from '../shared/setup.js';

/** What is installed on this computer, from existence, names and modification times.
 * Credential files are checked for existence and never opened. Agent settings are parsed for the
 * names of their MCP servers and the apps those servers reach; everything else in them is dropped.
 * Nothing leaves the computer. */

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

/** The apps an MCP server reaches: its name, the host of its address, its command, or a package or address named in its
 * arguments names the app (mcp.notion.com, @notionhq/notion-mcp-server, mcp-remote https://mcp.linear.app/sse, "notion").
 * Only the matching app ids are kept. */
const reachPatterns: Record<AppId, RegExp> = {
  notion: /notion/i, linear: /linear/i, sentry: /sentry/i, figma: /figma/i, slack: /slack/i, zotero: /zotero/i,
  github: /github/i, 'google-drive': /g(?:oogle)?[ _-]?drive/i, obsidian: /obsidian/i, dropbox: /dropbox/i,
};
const PACKAGE = /^@?[\w.-]+(?:\/[\w.-]+)?(?:@[\w.^~-]+)?$/u;
type Server = { url?: unknown; serverUrl?: unknown; httpUrl?: unknown; command?: unknown; args?: unknown };
/** An address's host; Figma's desktop app serves its MCP server on port 3845, whatever the entry is called. */
function host(address: string) {
  try {
    const url = new URL(address);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '3845' ? 'figma' : url.hostname;
  } catch { return null; }
}
function reachOf(name: string, server: Server | null): AppId[] {
  const words = [name];
  for (const address of [server?.url, server?.serverUrl, server?.httpUrl]) if (typeof address === 'string') words.push(host(address) ?? '');
  if (typeof server?.command === 'string') words.push(basename(server.command));
  if (Array.isArray(server?.args)) for (const arg of server.args) if (typeof arg === 'string') words.push(/^https?:\/\//iu.test(arg) ? host(arg) ?? '' : PACKAGE.test(arg) ? arg : '');
  return (Object.keys(reachPatterns) as AppId[]).filter(id => words.some(word => reachPatterns[id].test(word)));
}
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const reachIn = (tables: Record<string, unknown>[]) => [...new Set(tables.flatMap(table => Object.entries(table).flatMap(([name, server]) => reachOf(name, isRecord(server) ? server : null))))];

type Shape = { servers: string[]; keys: string[]; reach: AppId[] };
/** The top-level key names and the server names under mcpServers (VS Code: servers) of a JSON settings file, and the apps
 * those servers reach, Claude Code's per-project servers included. Values are never kept. */
function jsonShape(file: string, list = 'mcpServers'): Shape | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) return { servers: [], keys: [], reach: [] };
    const top = value[list], projects = value.projects;
    const table = isRecord(top) ? top : {};
    // Claude Code keeps the servers added for one project under projects.<folder>.mcpServers.
    const perProject = isRecord(projects) ? Object.values(projects).flatMap(project => isRecord(project) && isRecord(project[list]) ? [project[list] as Record<string, unknown>] : []) : [];
    return { servers: Object.keys(table), keys: Object.keys(value), reach: reachIn([table, ...perProject]) };
  } catch { return { servers: [], keys: [], reach: [] }; }
}
/** The names of the [mcp_servers.<name>] tables in a Codex config.toml, and the apps their url, command and args reach. */
function tomlShape(file: string): { servers: string[]; reach: AppId[] } | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const headers = [...text.matchAll(/^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))[ \t]*\]/gmu)];
  const servers: string[] = [], tables: Record<string, unknown>[] = [];
  headers.forEach((match, index) => {
    const name = match[1] ?? match[2] ?? match[3] ?? '';
    if (!name) return;
    servers.push(name);
    // The table's own lines, up to the next table of any kind.
    const body = text.slice(match.index + match[0].length, headers[index + 1]?.index ?? text.length).split(/^[ \t]*\[/mu)[0] ?? '';
    const value = (key: string) => new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*["']([^"'\\n]*)["']`, 'mu').exec(body)?.[1];
    const args = /^[ \t]*args[ \t]*=[ \t]*\[([^\]]*)\]/mu.exec(body)?.[1];
    tables.push({ [name]: { url: value('url'), command: value('command'), args: args ? [...args.matchAll(/["']([^"'\n]*)["']/gu)].map(item => item[1]) : [] } });
  });
  return { servers, reach: reachIn(tables) };
}
/** The names under the top-level mcp_servers: map of a Hermes Agent config.yaml, read line by line, and the apps their
 * url, command and list items reach. */
function yamlShape(file: string): { servers: string[]; reach: AppId[] } | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const servers: { name: string; url?: string; command?: string; args: string[] }[] = [];
  let inside = false, indent = -1;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const depth = line.length - line.trimStart().length;
    if (depth === 0) { inside = /^mcp_servers:\s*(#.*)?$/u.test(line); indent = -1; continue; }
    if (!inside) continue;
    if (indent < 0) indent = depth;
    const name = depth === indent ? /^\s*(?:"([^"]+)"|'([^']+)'|([^\s"'#:][^:#]*?))\s*:(?:\s|$)/u.exec(line) : null;
    if (name) { servers.push({ name: name[1] ?? name[2] ?? name[3]!, args: [] }); continue; }
    const current = depth > indent ? servers[servers.length - 1] : undefined;
    if (!current) continue;
    const pair = /^\s*(url|command)\s*:\s*["']?([^"'\s#]+)/u.exec(line), item = /^\s*-\s*["']?([^"'\s#]+)["']?\s*$/u.exec(line);
    if (pair) current[pair[1] as 'url' | 'command'] = pair[2];
    else if (item) current.args.push(item[1]!);
  }
  return { servers: servers.map(server => server.name), reach: reachIn(servers.map(({ name, ...server }) => ({ [name]: server }))) };
}
export const yamlServers = (file: string): string[] | null => yamlShape(file)?.servers ?? null;
/** The Hermes Agent home its command line uses: HERMES_HOME when it names a profile, else the sticky profile in
 * <root>/active_profile, else HERMES_HOME or the usual folder. */
function hermesHome() {
  const usual = win ? join(localAppData, 'hermes') : join(home, '.hermes'), set = process.env.HERMES_HOME?.trim();
  if (set && basename(dirname(set)) === 'profiles') return set;
  const below = set ? relative(usual, set) : '', root = set && (below.startsWith('..') || isAbsolute(below)) ? set : usual;
  let profile = '';
  try { profile = readFileSync(join(root, 'active_profile'), 'utf8').trim().toLowerCase(); } catch { /* none */ }
  return profile && profile !== 'default' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(profile) && isDir(join(root, 'profiles', profile)) ? join(root, 'profiles', profile) : set || usual;
}
const others = (servers: string[] | null | undefined) => (servers ?? []).filter(name => name !== 'ros-ai');

/** One agent as the scan found it; the link command, record and sessions are added by Setup. */
/** reach: the apps its MCP servers already reach, from their names and addresses. */
export type Found = { id: AgentId; label: string; sessionLabel: string; found: boolean; signals: string[]; signedIn: boolean | null; method: LinkMethod; binary: string | null; target: string; entry: boolean; servers: string[]; reach: AppId[]; note?: string };

export function detectAgents(): Found[] {
  const claudeHome = join(home, '.claude'), claudeConfig = join(home, '.claude.json');
  const claudeBinary = findBinary(process.env.ROS_CLAUDE_BINARY || 'claude'), claudeShape = jsonShape(claudeConfig);
  // Claude Code keeps its sign-in in the keychain on a Mac, so only a positive answer is known.
  const claudeSignedIn = exists(join(claudeHome, '.credentials.json')) || Boolean(claudeShape?.keys.includes('oauthAccount')) ? true : null;
  const codexHome = process.env.CODEX_HOME || join(home, '.codex'), codexConfig = join(codexHome, 'config.toml');
  const codexBinary = findBinary(process.env.ROS_CODEX_BINARY || 'codex'), codexShape = tomlShape(codexConfig), codexServers = codexShape?.servers ?? null, codexApp = app('Codex');
  const codexSignedIn = exists(join(codexHome, 'auth.json')) ? true : isDir(codexHome) ? false : null;
  const cursorDir = join(home, '.cursor'), cursorConfig = join(cursorDir, 'mcp.json'), cursorShape = jsonShape(cursorConfig);
  const cursorApp = app('Cursor') || (win && exists(join(localAppData, 'Programs', 'cursor'))) || (!mac && !win && isDir(join(home, '.config', 'Cursor')));
  const cursorBinary = findBinary('cursor');
  const geminiDir = join(home, '.gemini'), geminiConfig = join(geminiDir, 'settings.json'), geminiShape = jsonShape(geminiConfig), geminiBinary = findBinary('gemini');
  const piDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[\\/])/u, home) || join(home, '.pi', 'agent'), piConfig = join(piDir, 'mcp.json'), piShape = jsonShape(piConfig);
  const piSignedIn = exists(join(piDir, 'auth.json')), piBinary = findBinary('pi');
  // Only a Hermes Agent home counts: other programs are called hermes too.
  const hermesDir = hermesHome(), hermesConfig = join(hermesDir, 'config.yaml'), hermesShape = yamlShape(hermesConfig), hermesServers = hermesShape?.servers ?? null, hermesFound = Boolean(hermesServers) || isDir(hermesDir);
  const hermesBinary = hermesFound ? findBinary(process.env.ROS_HERMES_BINARY || 'hermes') : null, hermesSignedIn = exists(join(hermesDir, 'auth.json'));
  return [
    { id: 'claude-code', label: 'Claude Code', sessionLabel: 'Claude Code', method: 'cli', binary: claudeBinary, target: claudeConfig,
      found: Boolean(claudeBinary || claudeShape || isDir(claudeHome)), signedIn: claudeSignedIn,
      signals: signals({ 'used recently': recent(join(claudeHome, 'projects')) || recent(join(claudeHome, 'history.jsonl')), 'signed in': claudeSignedIn === true, 'command line': Boolean(claudeBinary) }),
      entry: Boolean(claudeShape?.servers.includes('ros-ai')), servers: others(claudeShape?.servers), reach: claudeShape?.reach ?? [] },
    { id: 'codex', label: 'Codex', sessionLabel: 'Codex', method: 'cli', binary: codexBinary, target: codexConfig,
      found: Boolean(codexBinary || codexServers || isDir(codexHome) || codexApp), signedIn: codexSignedIn,
      signals: signals({ 'used recently': recent(join(codexHome, 'sessions')) || recent(join(codexHome, 'history.jsonl')), 'signed in': codexSignedIn === true, app: codexApp, 'command line': Boolean(codexBinary) }),
      entry: Boolean(codexServers?.includes('ros-ai')), servers: others(codexServers), reach: codexShape?.reach ?? [], ...(codexApp ? { note: 'The Codex app reads the same settings.' } : {}) },
    { id: 'cursor', label: 'Cursor', sessionLabel: 'Cursor', method: 'file', binary: cursorBinary, target: cursorConfig,
      found: Boolean(cursorApp || cursorBinary || cursorShape || isDir(cursorDir)), signedIn: null,
      signals: signals({ app: cursorApp, 'command line': Boolean(cursorBinary), settings: cursorShape !== null }),
      entry: Boolean(cursorShape?.servers.includes('ros-ai')), servers: others(cursorShape?.servers), reach: cursorShape?.reach ?? [] },
    { id: 'gemini-cli', label: 'Gemini CLI', sessionLabel: 'Gemini CLI', method: 'file', binary: geminiBinary, target: geminiConfig,
      found: Boolean(geminiBinary || geminiShape || isDir(geminiDir)), signedIn: exists(join(geminiDir, 'oauth_creds.json')) ? true : null,
      signals: signals({ 'used recently': recent(join(geminiDir, 'tmp')), 'signed in': exists(join(geminiDir, 'oauth_creds.json')), 'command line': Boolean(geminiBinary) }),
      entry: Boolean(geminiShape?.servers.includes('ros-ai')), servers: others(geminiShape?.servers), reach: geminiShape?.reach ?? [] },
    { id: 'pi', label: 'Pi', sessionLabel: 'Pi', method: 'file', binary: piBinary, target: piConfig,
      found: Boolean(piShape || isDir(piDir)), signedIn: piSignedIn ? true : null,
      signals: signals({ 'used recently': recent(join(piDir, 'sessions')), 'signed in': piSignedIn, 'command line': Boolean(piBinary) }),
      entry: Boolean(piShape?.servers.includes('ros-ai')), servers: others(piShape?.servers), reach: piShape?.reach ?? [] },
    { id: 'hermes', label: 'Hermes Agent', sessionLabel: 'Hermes Agent', method: 'cli', binary: hermesBinary, target: hermesConfig,
      found: hermesFound, signedIn: hermesSignedIn ? true : null,
      signals: signals({ 'used recently': recent(join(hermesDir, 'state.db')) || recent(join(hermesDir, 'sessions')), 'signed in': hermesSignedIn, 'command line': Boolean(hermesBinary) }),
      entry: Boolean(hermesServers?.includes('ros-ai')), servers: others(hermesServers), reach: hermesShape?.reach ?? [] },
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

/** Where desktop apps keep their data: it changes while they run, so its dates say when the app was last used. */
const support = mac ? join(home, 'Library', 'Application Support') : win ? appData : join(home, '.config');
/** apps: macOS bundles; folders: install folders; data: folders or files whose dates say when it was last used;
 * commands: on the search path; files: settings checked for existence only. */
type AppSpec = { id: AppId; label: string; connect: AppConnect | null; apps: string[]; folders: string[]; data: string[]; commands?: string[]; files?: string[] };
const specs: AppSpec[] = [
  { id: 'notion', label: 'Notion', connect: 'sign-in', apps: ['Notion'], folders: win ? [join(localAppData, 'Programs', 'Notion')] : [], data: [join(support, 'Notion')] },
  { id: 'linear', label: 'Linear', connect: 'sign-in', apps: ['Linear'], folders: [], data: [join(support, 'Linear')] },
  // sentry-cli keeps its token in ~/.sentryclirc, which is only checked for existence.
  { id: 'sentry', label: 'Sentry', connect: 'sign-in', apps: [], folders: [], data: [], commands: ['sentry-cli'], files: [join(home, '.sentryclirc')] },
  { id: 'figma', label: 'Figma', connect: 'desktop', apps: ['Figma'], folders: win ? [join(localAppData, 'Figma')] : [], data: [join(support, 'Figma')] },
  { id: 'slack', label: 'Slack', connect: 'token', apps: ['Slack'], folders: win ? [join(localAppData, 'slack')] : mac ? [] : ['/snap/slack', '/usr/lib/slack'], data: [join(support, 'Slack')] },
  { id: 'zotero', label: 'Zotero', connect: 'token', apps: ['Zotero'], folders: [join(home, 'Zotero')], data: [join(home, 'Zotero', 'zotero.sqlite')] },
  { id: 'github', label: 'GitHub', connect: 'token', apps: ['GitHub Desktop'], folders: [], data: [join(support, 'GitHub Desktop')] },
  { id: 'google-drive', label: 'Google Drive', connect: 'setup', apps: ['Google Drive'], folders: [], data: [] },
  // Found, but nothing to connect yet: only named in the screen's "Found on this computer" menu.
  { id: 'obsidian', label: 'Obsidian', connect: null, apps: ['Obsidian'], folders: win ? [join(localAppData, 'Obsidian')] : [], data: [join(support, 'obsidian')] },
  { id: 'dropbox', label: 'Dropbox', connect: null, apps: ['Dropbox'], folders: [join(home, 'Dropbox'), ...(mac ? [join(home, 'Library', 'CloudStorage', 'Dropbox')] : [])], data: [] },
];

/** When a folder or file last changed, a folder's own entries included (names and dates only). */
export function lastChanged(paths: string[]) {
  const times: number[] = [];
  for (const path of paths) {
    const at = modifiedAt(path);
    if (at === null) continue;
    times.push(at);
    if (!isDir(path)) continue;
    let names: string[] = [];
    try { names = readdirSync(path).slice(0, 200); } catch { /* unreadable */ }
    for (const name of names) { const child = modifiedAt(join(path, name)); if (child !== null) times.push(child); }
  }
  return times.length ? Math.max(...times) : null;
}
const usedWithin = (at: number | null): DetectedApp['used'] => {
  const age = at === null ? Infinity : Date.now() - at;
  return age < DAY ? 'today' : age < 7 * DAY ? 'this week' : age < 30 * DAY ? 'this month' : null;
};
/** Other AI apps' MCP settings, read like the agents': which apps their servers already reach. */
function otherClients(): { label: string; reach: AppId[] }[] {
  return [
    { label: 'Claude Desktop', shape: jsonShape(join(support, 'Claude', 'claude_desktop_config.json')) },
    { label: 'VS Code', shape: jsonShape(join(support, 'Code', 'User', 'mcp.json'), 'servers') },
    { label: 'Windsurf', shape: jsonShape(join(home, '.codeium', 'windsurf', 'mcp_config.json')) },
  ].flatMap(({ label, shape }) => shape?.reach.length ? [{ label, reach: shape.reach }] : []);
}
/** Where Figma's desktop app serves its MCP server; ROS_APP_FIGMA_URL may point at a stand-in on this computer. */
function figmaServer() {
  try { const set = new URL(process.env.ROS_APP_FIGMA_URL ?? ''); if (['127.0.0.1', 'localhost', '[::1]'].includes(set.hostname)) return set.href; } catch { /* not set */ }
  return 'http://127.0.0.1:3845/mcp';
}
/** Whether something answers at a loopback address; ok: only a successful answer counts. */
const answers = (url: string, ok = false) => fetch(url, { signal: AbortSignal.timeout(400) })
  .then(response => { void response.body?.cancel().catch(() => undefined); return !ok || response.ok; }, () => false);

/** Every app ros.ai knows, with what shows it is on this computer: its bundle, folders or command, when it was last used,
 * whether it answers, and the agents and other AI apps whose MCP servers already reach it. Not yet filtered by what
 * is connected: appRows does that. */
export async function detectApps(agents: Found[]): Promise<DetectedApp[]> {
  const [zoteroOpen, figmaOn] = await Promise.all([answers('http://127.0.0.1:23119/connector/ping', true), answers(figmaServer())]);
  const driveFolder = mac && (() => { try { return readdirSync(join(home, 'Library', 'CloudStorage')).some(name => name.startsWith('GoogleDrive-')); } catch { return false; } })();
  const gh = Boolean(findBinary('gh')) && exists(join(home, '.config', 'gh', 'hosts.yml'));
  const clients = [...agents.filter(agent => agent.found).map(agent => ({ label: agent.label, reach: agent.reach })), ...otherClients()];
  return specs.map(spec => {
    const usedBy = clients.filter(client => client.reach.includes(spec.id)).map(client => client.label);
    const used = usedWithin(lastChanged(spec.data)), running = spec.id === 'zotero' ? zoteroOpen : spec.id === 'figma' && figmaOn;
    const found = signals({
      app: spec.apps.some(app) || spec.folders.some(isDir) || spec.data.some(exists) || (spec.commands ?? []).some(name => Boolean(findBinary(name))),
      open: spec.id === 'zotero' && zoteroOpen,
      'server on': spec.id === 'figma' && figmaOn,
      'synced folder': spec.id === 'google-drive' && driveFolder,
      'signed in on the command line': spec.id === 'github' && gh,
      'settings file': (spec.files ?? []).some(exists),
    });
    // Switched on at the start only where one click does it and the person clearly uses the app.
    const suggested = spec.connect === 'sign-in' ? used !== null || usedBy.length > 0 : spec.connect === 'desktop' && running;
    return { id: spec.id, label: spec.label, signals: found, usedBy, used, running, connected: false, connect: spec.connect, suggested };
  });
}
/** The apps the first-run screen lists: found here or reached by an agent, and the ones already connected, which are
 * never offered again. */
export function appRows(apps: DetectedApp[], connected: Set<AppId>): DetectedApp[] {
  return apps.map(item => connected.has(item.id) ? { ...item, connected: true, suggested: false } : item)
    .filter(item => item.signals.length || item.usedBy.length || (item.connected && item.connect));
}
