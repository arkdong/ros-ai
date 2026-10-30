import { constants, existsSync, fstatSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Express } from 'express';
import { z } from 'zod';
import { StoreError } from './store.js';
import { notionBase } from './notion.js';
import { slackApi } from './slack.js';
import { zoteroApp } from './papers.js';
import { ghBinary, githubCliFound } from './setup-detect.js';
import { zoteroAppProblem, type LocalPlugins, type PluginStatus, type PluginWay, type TokenPluginId } from '../shared/plugins.js';

const ids = ['zotero', 'slack', 'notion', 'github', 'openalex', 'umami', 'railway'] as const satisfies readonly TokenPluginId[];
const idSchema = z.enum(ids);
const tokenSchema = z.string().trim().min(8).max(4096).refine(value => !/\s|[\x00-\x1f\x7f]/.test(value), 'Enter a single token without spaces.');
const savedSchema = z.object({ version: z.literal(1), tokens: z.object({ zotero: tokenSchema.optional(), slack: tokenSchema.optional(), notion: tokenSchema.optional(), github: tokenSchema.optional(), openalex: tokenSchema.optional(), umami: tokenSchema.optional(), railway: tokenSchema.optional() }).strict() }).strict();
/** The plugins that connect through something on this computer, and how. */
const localWay: Partial<Record<TokenPluginId, PluginWay>> = { github: 'github-cli', zotero: 'zotero-app' };
const waysSchema = z.object({ version: z.literal(1), ways: z.object({ github: z.literal('github-cli').optional(), zotero: z.literal('zotero-app').optional() }).strict() }).strict();
type Ways = z.infer<typeof waysSchema>['ways'];
type Check = Pick<PluginStatus, 'checkedAt' | 'verified' | 'checkMessage'>;
/** Names from a provider are echoed back only as a short label. */
/** Tokens a local keys file or the shell may provide instead of the Plugins page. */
const environment: Partial<Record<TokenPluginId, string>> = { notion: 'NOTION_TOKEN', zotero: 'ZOTERO_API_KEY', openalex: 'OPENALEX_API_KEY', umami: 'UMAMI_API_KEY', railway: 'RAILWAY_TOKEN' };
const label = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';
/** The GitHub CLI's token is read again after this long, so a new `gh auth login` takes over. */
const CLI_FRESH = 15 * 60_000;
const run = promisify(execFile);
/** Umami Cloud's API and Railway's public GraphQL API, which the Metrics block reads too. */
export const UMAMI_API = 'https://api.umami.is/v1';
export const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

/** The GitHub CLI's sign-in for github.com, as `gh auth token` prints it. ros.ai keeps it in memory only. */
async function githubCliToken(): Promise<string> {
  const binary = ghBinary();
  if (!binary) throw new StoreError('The GitHub CLI is not installed on this computer. Install it and run gh auth login in Terminal, or use a token under More.', 409);
  let printed: string;
  try { printed = (await run(binary, ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } })).stdout; }
  catch { throw new StoreError('The GitHub CLI is not signed in to github.com. Run gh auth login in Terminal, then try again.', 409); }
  const token = printed.trim();
  if (!/^[\w-]{20,255}$/u.test(token)) throw new StoreError('The GitHub CLI gave no sign-in ros.ai can use. Run gh auth login in Terminal, then try again.', 409);
  return token;
}
/** A file in the data folder that only its owner may read, or undefined before it exists. */
function readPrivate(file: string, size: number) {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > size || (info.mode & 0o077) !== 0) throw new Error('invalid');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}

/** Plugin tokens stay in an owner-only file on this computer; the browser only learns whether one is saved and the last
 * check. A plugin may connect through something already on this computer instead (the GitHub CLI's sign-in, the Zotero
 * app), as Codex and Claude Code do: that choice is kept in plugin-ways.json, which earlier versions never read, and the
 * GitHub CLI's token only in memory. The latest choice wins: using the computer's way sets the token aside, saving a
 * token stops using it. */
export class PluginTokens {
  private readonly file: string;
  private readonly waysFile: string;
  private tokens: Partial<Record<TokenPluginId, string>> = {};
  private ways: Ways = {};
  private checks = new Map<TokenPluginId, Check>();
  private cli: { token: string; at: number } | null = null;
  private reading: Promise<string> | null = null;
  constructor(dataDir: string, private readonly fetcher: typeof fetch = fetch) {
    this.file = join(dataDir, 'plugin-tokens.json');
    this.waysFile = join(dataDir, 'plugin-ways.json');
    try { const saved = readPrivate(this.file, 40000); if (saved !== undefined) this.tokens = savedSchema.parse(saved).tokens; }
    catch { throw new Error('Could not read private plugin tokens. Ensure the file is valid and readable only by its owner.'); }
    try { const saved = readPrivate(this.waysFile, 4000); if (saved !== undefined) this.ways = waysSchema.parse(saved).ways; }
    catch { throw new Error(`Could not read ${this.waysFile}. Make sure it is valid and readable only by its owner, or delete it to connect GitHub and Zotero again.`); }
    if (this.ways.github) void this.readCli().catch(() => undefined);
  }
  private write(file: string, value: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new StoreError('Could not save the plugin connection.', 500);
    }
  }
  private persist(tokens: Partial<Record<TokenPluginId, string>>) { this.write(this.file, { version: 1, tokens }); this.tokens = tokens; }
  private persistWays(ways: Ways) { this.write(this.waysFile, { version: 1, ways }); this.ways = ways; if (!ways.github) this.cli = null; }
  private without(id: TokenPluginId) { const ways: Ways = { ...this.ways }; delete ways[id as keyof Ways]; return ways; }
  /** Reads the GitHub CLI's token again; one read at a time. */
  private readCli(): Promise<string> {
    this.reading ??= githubCliToken().then(token => { this.cli = { token, at: Date.now() }; return token; }, error => { this.cli = null; throw error; }).finally(() => { this.reading = null; });
    return this.reading;
  }
  /** How a plugin connects through this computer, when it does. */
  way(id: TokenPluginId): PluginWay | undefined { return this.ways[id as keyof Ways]; }
  status(id: TokenPluginId): PluginStatus {
    const via = this.way(id) ?? null;
    return { id, configured: via === 'zotero-app' || Boolean(this.token(id)), via, ...(this.checks.get(id) ?? { checkedAt: null, verified: null, checkMessage: null }) };
  }
  statuses() { return ids.map(id => this.status(id)); }
  /** The plugins with a token saved or a way chosen on this computer, which Disconnect can forget; environment tokens stay out. */
  saved() { return ids.filter(id => Boolean(this.tokens[id]) || Boolean(this.way(id))); }
  /** For plugin features on the server; never sent to the browser. The GitHub CLI's token while GitHub connects through
   * it (none for Zotero's app, which needs none), else a saved token, which wins over the environment. */
  token(id: TokenPluginId) {
    const way = this.way(id);
    if (way === 'github-cli') {
      if (!this.cli || Date.now() - this.cli.at > CLI_FRESH) void this.readCli().catch(() => undefined);
      return this.cli?.token;
    }
    if (way) return undefined;
    const name = environment[id];
    return this.tokens[id] ?? (name ? process.env[name]?.trim() || undefined : undefined);
  }
  save(id: TokenPluginId, supplied: unknown) {
    const { token } = z.object({ token: tokenSchema }).strict().parse(supplied);
    this.persist({ ...this.tokens, [id]: token });
    if (this.way(id)) this.persistWays(this.without(id));
    this.checks.delete(id);
    return this.status(id);
  }
  disconnect(id: TokenPluginId) {
    if (!this.way(id) && !this.tokens[id] && this.token(id)) throw new StoreError(`This token comes from ${environment[id]} in your keys file or environment. Remove it there and restart to disconnect.`);
    if (this.way(id)) this.persistWays(this.without(id));
    if (this.tokens[id]) { const tokens = { ...this.tokens }; delete tokens[id]; this.persist(tokens); }
    this.checks.delete(id);
    return this.status(id);
  }
  /** Connects a plugin through what is on this computer: the GitHub CLI's sign-in, which GitHub is asked about once, or
   * the Zotero app, once it lets other apps read the library. Nothing is copied or saved but the choice. */
  async useLocal(id: TokenPluginId) {
    const way = localWay[id];
    if (!way) throw new StoreError('This plugin connects with a sign-in or a token.', 400);
    if (way === 'zotero-app') {
      const state = await zoteroApp(this.fetcher);
      if (state !== 'ready') throw new StoreError(zoteroAppProblem(state), 409);
      this.persistWays({ ...this.ways, zotero: 'zotero-app' });
      this.checks.set(id, { checkedAt: new Date().toISOString(), verified: true, checkMessage: 'Zotero lets ros.ai read your library.' });
      return this.status(id);
    }
    // Offline, the choice is kept unchecked; a sign-in GitHub refuses is not.
    const { reached, ...check } = await this.ask('github', await this.readCli(), true);
    if (reached && !check.verified) throw new StoreError(check.checkMessage ?? 'GitHub did not accept the GitHub CLI’s sign-in.', 409);
    this.persistWays({ ...this.ways, github: 'github-cli' });
    this.checks.set(id, reached ? check : { checkedAt: check.checkedAt, verified: null, checkMessage: 'Connected through the GitHub CLI. GitHub could not be reached to check its sign-in.' });
    return this.status(id);
  }
  /** One read-only identity request: it confirms the token without reading or changing any content. cli: the token is
   * the GitHub CLI's. reached: the service answered. */
  private async ask(id: TokenPluginId, token: string, cli = false): Promise<Check & { reached: boolean }> {
    let verified = false, reached = false, checkMessage = 'Could not reach the service. The token has not been checked.';
    try {
      const request = (url: string, init: RequestInit) => this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }).then(response => { reached = true; return response; });
      if (id === 'zotero') {
        const response = await request('https://api.zotero.org/keys/current', { headers: { 'Zotero-API-Key': token, 'Zotero-API-Version': '3' } });
        const body = response.ok ? await response.json() as { username?: unknown } : null;
        verified = response.ok;
        checkMessage = response.ok ? `Zotero accepted the key${label(body?.username) ? ` for ${label(body?.username)}` : ''}.` : response.status === 403 || response.status === 404 ? 'Zotero rejected this key.' : `Zotero returned HTTP ${response.status}.`;
      } else if (id === 'slack') {
        const response = await request(`${slackApi()}/auth.test`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        const body = response.ok ? await response.json() as { ok?: boolean; team?: unknown } : null;
        verified = body?.ok === true;
        checkMessage = verified ? `Slack accepted the token${label(body?.team) ? ` for ${label(body?.team)}` : ''}.` : response.ok ? 'Slack rejected this token.' : `Slack returned HTTP ${response.status}.`;
      } else if (id === 'openalex') {
        // OpenAlex's own page for a key's daily allowance; it needs a key it accepts.
        const response = await request(`https://api.openalex.org/rate-limit?${new URLSearchParams({ api_key: token })}`, { headers: { 'User-Agent': 'ros.ai (https://github.com/arkdong/ros-ai)' } });
        verified = response.ok;
        checkMessage = response.ok ? 'OpenAlex accepted the key.' : response.status === 401 || response.status === 403 ? 'OpenAlex rejected this key.' : `OpenAlex returned HTTP ${response.status}.`;
      } else if (id === 'umami') {
        const response = await request(`${UMAMI_API}/me`, { headers: { 'x-umami-api-key': token, Accept: 'application/json' } });
        const body = response.ok ? await response.json() as { user?: { username?: unknown } } : null;
        verified = response.ok;
        checkMessage = response.ok ? `Umami accepted the key${label(body?.user?.username) ? ` for ${label(body?.user?.username)}` : ''}.` : response.status === 401 || response.status === 403 ? 'Umami rejected this key.' : `Umami returned HTTP ${response.status}.`;
      } else if (id === 'railway') {
        const response = await request(RAILWAY_API, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ me { name email } }' }) });
        const body = response.ok ? await response.json() as { data?: { me?: { name?: unknown; email?: unknown } }; errors?: unknown[] } : null;
        verified = Boolean(body?.data?.me);
        checkMessage = verified ? `Railway accepted the token${label(body?.data?.me?.name ?? body?.data?.me?.email) ? ` for ${label(body?.data?.me?.name ?? body?.data?.me?.email)}` : ''}.` : response.ok ? 'Railway did not accept this as an account token. Create one with No workspace chosen.' : `Railway returned HTTP ${response.status}.`;
      } else if (id === 'notion') {
        const response = await request(`${notionBase()}/v1/users/me`, { headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' } });
        verified = response.ok;
        checkMessage = response.ok ? 'Notion accepted the integration secret. Share pages with the integration to make them visible.' : response.status === 401 ? 'Notion rejected this secret.' : `Notion returned HTTP ${response.status}.`;
      } else {
        if (cli) checkMessage = 'Could not reach GitHub, so the GitHub CLI’s sign-in has not been checked.';
        const response = await request('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ros.ai' } });
        const body = response.ok ? await response.json() as { login?: unknown } : null, login = label(body?.login);
        verified = response.ok;
        checkMessage = cli ? response.ok ? `Connected through the GitHub CLI${login ? ` as ${login}` : ''}.` : response.status === 401 ? 'GitHub did not accept the GitHub CLI’s sign-in. Run gh auth login in Terminal, then try again.' : `GitHub returned HTTP ${response.status}.`
          : response.ok ? `GitHub accepted the token${login ? ` for ${login}` : ''}.` : response.status === 401 ? 'GitHub rejected this token.' : `GitHub returned HTTP ${response.status}.`;
      }
    } catch { /* Keep a short message without provider details. */ }
    return { checkedAt: new Date().toISOString(), verified, checkMessage, reached };
  }
  async check(id: TokenPluginId) {
    const way = this.way(id);
    if (way === 'zotero-app') {
      const state = await zoteroApp(this.fetcher);
      this.checks.set(id, { checkedAt: new Date().toISOString(), verified: state === 'ready', checkMessage: state === 'ready' ? 'Zotero lets ros.ai read your library.' : zoteroAppProblem(state) });
      return this.status(id);
    }
    if (way === 'github-cli') {
      let token: string;
      try { token = await this.readCli(); }
      catch (error) { this.checks.set(id, { checkedAt: new Date().toISOString(), verified: false, checkMessage: error instanceof Error ? error.message : 'The GitHub CLI’s sign-in could not be read.' }); return this.status(id); }
      const { reached: _reached, ...check } = await this.ask(id, token, true);
      this.checks.set(id, check);
      return this.status(id);
    }
    const token = this.token(id);
    if (!token) throw new StoreError('Save a token first.');
    const { reached: _reached, ...check } = await this.ask(id, token);
    // A replacement saved during the check must not inherit this result.
    if (this.token(id) !== token) throw new StoreError('The token changed during this check. Check the current token again.');
    this.checks.set(id, check);
    return this.status(id);
  }
}
/** What on this computer can connect a plugin with nothing to paste. */
export async function localPlugins(fetcher: typeof fetch = fetch): Promise<LocalPlugins> {
  return { github: githubCliFound(), zotero: await zoteroApp(fetcher) };
}

export function attachPluginRoutes(app: Express, plugins: PluginTokens) {
  app.get('/api/plugins', (_req, res) => res.json({ plugins: plugins.statuses() }));
  app.get('/api/plugins/local', async (_req, res) => res.json(await localPlugins()));
  app.put('/api/plugins/:id', (req, res) => res.json(plugins.save(idSchema.parse(req.params.id), req.body)));
  app.delete('/api/plugins/:id', (req, res) => res.json(plugins.disconnect(idSchema.parse(req.params.id))));
  app.post('/api/plugins/:id/check', async (req, res) => res.json(await plugins.check(idSchema.parse(req.params.id))));
  app.post('/api/plugins/:id/local', async (req, res) => res.json(await plugins.useLocal(idSchema.parse(req.params.id))));
}
