import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StoreError } from './store.js';
import type { AppConnectionStatus, TokenPluginId } from '../shared/plugins.js';

/** How ros.ai reaches an app's own tools:
 * sign-in: its hosted MCP server, after the person approves ros.ai in the browser. ros.ai registers itself
 *   with the app's sign-in (dynamic registration and PKCE, as Claude and Claude Code do); nothing to create or paste.
 * token: its hosted MCP server, with the token saved for the app on the Plugins page.
 * desktop: the MCP server the app's own desktop program runs on this computer; `start` says how to turn it on.
 * built-in: ros.ai's own tools for the app's web API, for apps whose hosted server admits only apps it lists (with
 *   the token saved on the Plugins page) or that ros.ai already reaches (Google Drive, through its sign-in).
 * `reads` names tools that only read, for servers that do not mark them; any other tool waits for the person's
 * approval before it runs. */
type AppEntry = { name: string; reads: readonly string[] } & ({ auth: 'sign-in'; url: string } | { auth: 'token'; url: string; token: TokenPluginId } | { auth: 'desktop'; url: string; start: string } | { auth: 'built-in'; token?: TokenPluginId });
export const appCatalogue = {
  notion: { name: 'Notion', auth: 'sign-in', url: 'https://mcp.notion.com/mcp', reads: ['notion-search', 'notion-fetch', 'notion-query-data-sources', 'notion-query-database-view', 'notion-get-comments', 'notion-get-users', 'notion-get-self', 'notion-get-teams', 'notion-get-file-download-urls', 'notion-list-page-backlinks'] },
  linear: { name: 'Linear', auth: 'sign-in', url: 'https://mcp.linear.app/mcp', reads: ['list_comments', 'list_cycles', 'get_document', 'list_documents', 'get_issue', 'get_issue_git_branch_name', 'list_issues', 'list_my_issues', 'list_issue_statuses', 'get_issue_status', 'list_issue_labels', 'list_projects', 'get_project', 'list_project_labels', 'list_teams', 'get_team', 'list_users', 'get_user', 'search_documentation'] },
  sentry: { name: 'Sentry', auth: 'sign-in', url: 'https://mcp.sentry.dev/mcp', reads: ['whoami', 'find_organizations', 'find_teams', 'find_projects', 'find_releases', 'find_dsns', 'get_issue_details', 'get_trace_details', 'get_event_attachment', 'search_events', 'search_issues', 'search_docs', 'get_doc'] },
  // GitHub's hosted server takes no dynamic registration, so it uses the token from GitHub's Plugins card; it marks its own read tools.
  github: { name: 'GitHub', auth: 'token', token: 'github', url: 'https://api.githubcopilot.com/mcp/', reads: [] },
  // Figma's hosted server admits only clients on Figma's list; its desktop app serves the same design tools on this computer.
  figma: { name: 'Figma', auth: 'desktop', url: 'http://127.0.0.1:3845/mcp', start: 'Open the Figma desktop app, open a design file, switch to Dev Mode and turn on the desktop MCP server in the inspect panel.', reads: ['get_design_context', 'get_variable_defs', 'get_code_connect_map', 'get_screenshot', 'get_metadata', 'get_figjam', 'create_design_system_rules', 'get_code', 'get_image', 'whoami'] },
  // Slack's hosted server admits only apps Slack approves, so ros.ai reads and posts with the bot token from Slack's Plugins card (slack.ts).
  slack: { name: 'Slack', auth: 'built-in', token: 'slack', reads: ['list_channels', 'read_channel', 'read_thread'] },
  // Google Sheets and Docs through the Google Drive sign-in, which only reads (google-workspace.ts).
  'google-drive': { name: 'Google Drive', auth: 'built-in', reads: ['search_files', 'read_doc', 'read_sheet'] },
  // Papers from OpenAlex and arXiv, as turned on in Plugins, and the Zotero library whose key is saved there (papers.ts).
  papers: { name: 'Papers', auth: 'built-in', reads: ['search_papers', 'read_paper'] },
} as const satisfies Record<string, AppEntry>;
export type AppId = keyof typeof appCatalogue;
const appIds = Object.keys(appCatalogue) as AppId[];
const appIdSchema = z.enum(appIds as [AppId, ...AppId[]]);
const entry = (id: AppId): AppEntry => appCatalogue[id];

const CALLBACK = '/api/apps/callback', COOKIE = 'ros-ai-app-sign-in', SIGN_IN_TTL = 10 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sameDigest = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const label = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : '';

/** `ROS_APP_<ID>_URL` points an app at another server, but only https or this computer (for stand-ins). */
export function appUrl(id: AppId) {
  const app = entry(id);
  if (app.auth === 'built-in') throw new StoreError(`${app.name} has no MCP server address.`);
  const override = process.env[`ROS_APP_${id.toUpperCase()}_URL`]?.trim();
  if (!override) return app.url;
  const url = new URL(override);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error(`ROS_APP_${id.toUpperCase()}_URL must be https or on this computer.`);
  return url.href;
}

type Saved = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirectUri?: string; connectedAt?: string; account?: string };
/** nonceHash: the cookie the browser that started the sign-in holds, or null for the Mac app, whose sign-in finishes in the
 * system browser. window: the sign-in opened in a window of its own, so its callback page tells ros.ai and closes. */
type Pending = { app: AppId; nonceHash: string | null; redirectUri: string; verifier?: string; expiresAt: number; window?: boolean };
/** proposes: the tool adds blocks to the canvas, which ros.ai proposes under the project's approval mode, instead of a
 * change in the app that always waits for the person (Papers' add_paper). */
export type AppTool = { name: string; description: string; inputSchema: Record<string, unknown>; reads: boolean; proposes?: boolean };
export type AppStatus = AppConnectionStatus & { id: AppId };
/** An app whose tools ros.ai provides itself (Slack, Google Drive, Papers), shaped like an MCP server's; connected once
 * its token is saved, its sign-in is done or, for Papers, a source is on. */
export type BuiltInApp = { connected(): boolean; tools(): AppTool[]; call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> };
type Options = { token?: (id: TokenPluginId) => string | undefined; builtIn?: Partial<Record<AppId, BuiltInApp>> };

/** Sign-ins for hosted app servers and the desktop apps turned on, in one owner-only file in the data folder.
 * Apps reached with a Plugins token read it from there when they connect. The browser only learns whether an
 * app is connected; tokens never leave the server. */
export class RemoteApps {
  private readonly file: string;
  private saved: Partial<Record<AppId, Saved>> = {};
  private readonly pending = new Map<string, Pending>();
  /** key: a digest of the token a token app connected with, so a replaced token connects again. */
  private readonly clients = new Map<AppId, { client: Client; tools: AppTool[]; key?: string }>();
  constructor(dataDir: string, private readonly options: Options = {}) {
    this.file = join(dataDir, 'app-connections.json');
    if (!existsSync(this.file)) return;
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 200_000 || (info.mode & 0o077) !== 0) throw new Error('invalid');
      const value = JSON.parse(readFileSync(fd, 'utf8')) as { version?: number; apps?: Partial<Record<AppId, Saved>> };
      if (value.version !== 1 || typeof value.apps !== 'object' || !value.apps) throw new Error('invalid');
      this.saved = Object.fromEntries(Object.entries(value.apps).filter(([id]) => appIds.includes(id as AppId)));
    } catch { throw new Error(`Could not read ${this.file}. Make sure it is valid and readable only by its owner, or delete it to sign in to your apps again.`); }
    finally { closeSync(fd); }
  }
  private save(id: AppId, change: Saved | undefined) {
    const apps = { ...this.saved };
    if (change) apps[id] = change; else delete apps[id];
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, apps }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new StoreError('Could not save the app sign-in.', 500);
    }
    this.saved = apps;
  }
  /** What the SDK needs to sign in and to send the app's token. `flow` is set only while a browser sign-in runs. */
  private provider(id: AppId, redirectUri: string, flow?: { state: string; pending: Pending; open: (url: URL) => void }): OAuthClientProvider {
    const apps = this;
    return {
      get redirectUrl() { return redirectUri; },
      get clientMetadata() { return { client_name: 'ros.ai', client_uri: 'https://github.com/arkdong/ros-ai', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
      state: () => flow?.state ?? randomBytes(32).toString('base64url'),
      // A registration made for another address (ros.ai on another port) is not reused.
      clientInformation: () => apps.saved[id]?.redirectUri === redirectUri ? apps.saved[id]?.client : undefined,
      saveClientInformation: client => apps.save(id, { ...apps.saved[id], client, redirectUri, tokens: apps.saved[id]?.redirectUri === redirectUri ? apps.saved[id]?.tokens : undefined }),
      tokens: () => apps.saved[id]?.tokens,
      saveTokens: tokens => apps.save(id, { ...apps.saved[id], tokens, connectedAt: apps.saved[id]?.connectedAt ?? new Date().toISOString() }),
      redirectToAuthorization: url => { if (!flow) throw new StoreError(`${appCatalogue[id].name} needs you to sign in again. Open Plugins and connect it.`, 409); flow.open(url); },
      saveCodeVerifier: verifier => { if (flow) flow.pending.verifier = verifier; },
      codeVerifier: () => { if (!flow?.pending.verifier) throw new StoreError('This sign-in has no verifier. Start it again.'); return flow.pending.verifier; },
      invalidateCredentials: scope => {
        const current = apps.saved[id];
        if (!current) return;
        if (scope === 'all') apps.save(id, undefined);
        else if (scope === 'client') apps.save(id, { ...current, client: undefined, tokens: undefined });
        else if (scope === 'tokens') apps.save(id, { ...current, tokens: undefined });
      },
    };
  }
  private token(id: AppId) { const app = entry(id); return (app.auth === 'token' || app.auth === 'built-in') && app.token ? this.options.token?.(app.token) || undefined : undefined; }
  status(id: AppId): AppStatus {
    const app = entry(id), saved = this.saved[id];
    const connected = app.auth === 'sign-in' ? Boolean(saved?.tokens?.access_token) : app.auth === 'desktop' ? Boolean(saved?.connectedAt) : app.auth === 'built-in' ? this.options.builtIn?.[id]?.connected() === true : Boolean(this.token(id));
    return { id, name: app.name, connected, connectedAt: app.auth === 'sign-in' || app.auth === 'desktop' ? saved?.connectedAt ?? null : null, account: saved?.account ?? null };
  }
  statuses() { return appIds.map(id => this.status(id)); }
  connected() { return appIds.filter(id => this.status(id).connected); }
  /** Starts the app's sign-in: ros.ai registers itself if needed and returns the address to open. window: it opens in a
   * window of its own. bound (the default): only the browser holding the returned nonce, as a cookie, can finish it. */
  async begin(id: AppId, redirectUri: string, options: { window?: boolean; bound?: boolean } = {}) {
    if (entry(id).auth !== 'sign-in') throw new StoreError(`${appCatalogue[id].name} does not connect with a sign-in.`);
    for (const [state, item] of this.pending) if (item.expiresAt < Date.now()) this.pending.delete(state);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const pending: Pending = { app: id, nonceHash: options.bound === false ? null : digest(nonce), redirectUri, expiresAt: Date.now() + SIGN_IN_TTL, ...(options.window ? { window: true } : {}) };
    let opened: URL | undefined;
    let result: Awaited<ReturnType<typeof auth>>;
    try { result = await auth(this.provider(id, redirectUri, { state, pending, open: url => { opened = url; } }), { serverUrl: appUrl(id) }); }
    catch (error) { throw new StoreError(`Could not start the ${appCatalogue[id].name} sign-in: ${error instanceof StoreError ? error.message : label(error instanceof Error ? error.message : String(error)) || 'the app did not answer.'}`, 502); }
    if (result === 'AUTHORIZED' || !opened) { this.clients.delete(id); return { alreadyConnected: true as const }; }
    this.pending.set(state, pending);
    return { url: opened.href, nonce };
  }
  /** The sign-in a callback belongs to, before it finishes: which app, and whether it opened in its own window. */
  waiting(state: unknown) { const pending = typeof state === 'string' ? this.pending.get(state) : undefined; return pending && pending.expiresAt >= Date.now() ? { app: pending.app, window: pending.window === true } : undefined; }
  /** The app sent the browser back with a code: exchange it for tokens and remember them. */
  async finish(query: unknown, nonce: string) {
    const { state, code, error } = z.object({ state: z.string().max(400), code: z.string().max(4000).optional(), error: z.string().max(200).optional() }).passthrough().parse(query);
    const pending = this.pending.get(state);
    if (!pending || pending.expiresAt < Date.now() || (pending.nonceHash !== null && (!nonce || !sameDigest(pending.nonceHash, digest(nonce))))) throw new StoreError('This sign-in expired or was started in another browser. Start it again from Plugins.');
    this.pending.delete(state);
    const name = appCatalogue[pending.app].name;
    if (error || !code) throw new StoreError(error === 'access_denied' ? `${name} sign-in was cancelled.` : `${name} did not complete the sign-in.`);
    try { await auth(this.provider(pending.app, pending.redirectUri, { state, pending, open: () => { throw new StoreError(`${name} asked to sign in again.`); } }), { serverUrl: appUrl(pending.app), authorizationCode: code }); }
    catch (failure) { throw new StoreError(`${name} refused the sign-in: ${failure instanceof StoreError ? failure.message : label(failure instanceof Error ? failure.message : String(failure))}`, 502); }
    this.save(pending.app, { ...this.saved[pending.app], connectedAt: new Date().toISOString() });
    this.clients.delete(pending.app);
    // Name the account when the app says who signed in, so the Plugins page can show it.
    const tools = await this.tools(pending.app).catch(() => []);
    if (pending.app === 'notion' && tools.some(tool => tool.name === 'notion-get-self')) {
      const self = await this.call('notion', 'notion-get-self', {}).catch(() => null);
      const account = label(self?.text.match(/"(?:name|workspace_name)"\s*:\s*"([^"]+)"/)?.[1]);
      if (account) this.save('notion', { ...this.saved.notion, account });
    }
    return pending.app;
  }
  /** Turns on an app's desktop server: ros.ai connects once to check that it answers and lists its tools. */
  async connectDesktop(id: AppId) {
    if (entry(id).auth !== 'desktop') throw new StoreError(`${appCatalogue[id].name} has no desktop server.`);
    this.drop(id);
    await this.open(id, true);
    this.save(id, { connectedAt: new Date().toISOString() });
    return this.status(id);
  }
  disconnect(id: AppId) {
    const app = entry(id);
    if (app.auth === 'token' || (app.auth === 'built-in' && app.token)) throw new StoreError(`${app.name} uses the token on its Plugins card. Remove the token there to disconnect it.`);
    if (app.auth === 'built-in') throw new StoreError(`${app.name} is connected on its Plugins card. Disconnect it there.`);
    this.drop(id);
    this.save(id, undefined);
    return this.status(id);
  }
  private drop(id: AppId) {
    const cached = this.clients.get(id); this.clients.delete(id);
    void cached?.client.close().catch(() => undefined);
  }
  /** probe: connect although the app is not turned on yet, to turn on a desktop server. */
  private async open(id: AppId, probe = false) {
    const app = entry(id), token = this.token(id), key = token ? digest(token) : undefined;
    const cached = this.clients.get(id);
    if (cached && cached.key === key) return cached;
    if (cached) this.drop(id);
    if (app.auth === 'built-in') throw new StoreError(`${app.name} has no MCP server.`);
    if (!probe && !this.status(id).connected) throw new StoreError(app.auth === 'token' ? `${app.name} is not connected. Save its token on the Plugins page.` : `${app.name} is not connected. Open Plugins and connect it.`, 409);
    const url = new URL(appUrl(id));
    const transport = app.auth === 'sign-in' ? new StreamableHTTPClientTransport(url, { authProvider: this.provider(id, this.saved[id]?.redirectUri ?? appRedirectUri(undefined)) })
      : new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
    const client = new Client({ name: 'ros.ai', version: '1' });
    try { await client.connect(transport); }
    catch (error) {
      if (error instanceof StoreError) throw error;
      const reason = label(error instanceof Error ? error.message : String(error)), status = (error as { code?: unknown }).code;
      if (app.auth === 'desktop') throw new StoreError(`${app.name}’s desktop app is not answering at ${url.host}. ${app.start}`, 502);
      if (app.auth === 'token' && (status === 401 || status === 403)) throw new StoreError(`${app.name} did not accept the token saved on its Plugins card. Replace it there.`, 502);
      throw new StoreError(`Could not reach ${app.name}: ${reason}`, 502);
    }
    const reads = new Set<string>(app.reads);
    const listed = (await client.listTools()).tools;
    const opened = { client, key, tools: listed.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as Record<string, unknown>, reads: tool.annotations?.readOnlyHint === true || reads.has(tool.name) })) };
    this.clients.set(id, opened);
    return opened;
  }
  /** The app ros.ai provides itself, once its token is saved; undefined for apps with an MCP server. */
  private builtIn(id: AppId) {
    const app = entry(id);
    if (app.auth !== 'built-in') return undefined;
    const provided = this.options.builtIn?.[id];
    if (!provided) throw new StoreError(`${app.name} is not available here.`, 503);
    if (!this.status(id).connected) throw new StoreError(`${app.name} is not connected. ${app.token ? 'Save its token on the Plugins page.' : 'Connect it on the Plugins page.'}`, 409);
    return provided;
  }
  async tools(id: AppId): Promise<AppTool[]> {
    const provided = this.builtIn(id);
    if (provided) { const reads = new Set<string>(entry(id).reads); return provided.tools().map(tool => ({ ...tool, reads: tool.reads && reads.has(tool.name) })); }
    return (await this.open(id)).tools;
  }
  /** Runs one of the app's tools and returns its text. Callers decide first whether it needs approval. */
  async call(id: AppId, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const provided = this.builtIn(id);
    if (provided) {
      if (!provided.tools().some(tool => tool.name === name)) throw new StoreError(`${appCatalogue[id].name} has no tool called ${label(name)}.`);
      return provided.call(name, args, signal);
    }
    let opened = await this.open(id);
    if (!opened.tools.some(tool => tool.name === name)) throw new StoreError(`${appCatalogue[id].name} has no tool called ${label(name)}.`);
    const run = () => opened.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 });
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(); }
    catch (error) {
      if (signal?.aborted || error instanceof StoreError) throw error;
      // A dropped session: connect once more, then give up.
      this.drop(id); opened = await this.open(id);
      try { result = await run(); } catch (again) { throw new StoreError(`${appCatalogue[id].name}: ${label(again instanceof Error ? again.message : String(again))}`, 502); }
    }
    const content = Array.isArray(result.content) ? result.content as { type: string; text?: string }[] : [];
    const text = content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
    return { text, isError: result.isError === true };
  }
}

/** The address an app sends the browser back to: this ros.ai's own (loopback) address, registered by ros.ai itself. */
export const appRedirectUri = (host: string | undefined) => `http://${/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host ?? '') ? host : '127.0.0.1:4310'}${CALLBACK}`;
const cookie = (res: Response, value: string, maxAge: number) => res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', path: CALLBACK, maxAge, secure: false });
const nonceOf = (req: Request) => { const item = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`)); const value = item?.slice(COOKIE.length + 1) ?? ''; return /^[\w-]{43}$/u.test(value) ? value : ''; };
const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
/** Where a sign-in window ends: it tells the open ros.ai window over a BroadcastChannel and, once connected, closes itself. */
function signInPage(id: AppId, error?: string) {
  const name = appCatalogue[id].name, heading = error ? `Couldn’t connect ${name}` : `${name} connected`;
  const lines = error ? [error, 'Close this window and try again in ros.ai.'] : ['You can close this window.'];
  const message = JSON.stringify(error ? { failed: id, error } : { connected: id }).replace(/</gu, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)} · ros.ai</title>`
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#171717;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:360px;padding:24px;text-align:center}h1{margin:0 0 6px;font-size:18px;font-weight:600}p{margin:0;color:#4a4a4a}</style></head>'
    + `<body><main><h1>${escapeHtml(heading)}</h1>${lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</main>`
    + `<script>try{new BroadcastChannel('ros-ai-plugins').postMessage(${message})}catch{}${error ? '' : 'setTimeout(()=>window.close(),800)'}</script></body></html>`;
}

export function attachAppRoutes(app: Express, apps: RemoteApps) {
  app.get('/api/apps', (_req, res) => res.json({ apps: apps.statuses() }));
  // window: the sign-in opens in a window of its own (a suggestion in the conversation), so the page and its draft stay put.
  app.post('/api/apps/:id/connect', async (req, res) => {
    const id = appIdSchema.parse(req.params.id);
    const { window } = z.object({ window: z.boolean().optional() }).strict().parse(req.body ?? {});
    if (entry(id).auth === 'desktop') return res.json({ connected: true, app: await apps.connectDesktop(id) });
    // The Mac app (ros.ai/<version> in its user agent) opens the sign-in in the system browser, which never holds the app
    // window's cookie. Its state is still a single-use 256-bit secret only this server and the app's sign-in page see, and
    // only ros.ai's own page can start a sign-in (app.ts refuses cross-site and non-JSON requests).
    const desktop = / ros\.ai\/\S+$/u.test(req.headers['user-agent'] ?? '');
    const started = await apps.begin(id, appRedirectUri(req.headers.host), { window, bound: !desktop });
    if ('alreadyConnected' in started) return res.json({ connected: true, app: apps.status(id) });
    if (!desktop) cookie(res, started.nonce, SIGN_IN_TTL);
    res.json({ authorizationUrl: started.url });
  });
  app.get(CALLBACK, async (req, res) => {
    const waiting = apps.waiting(req.query.state);
    try {
      const id = await apps.finish(req.query, nonceOf(req)); cookie(res, '', 0);
      if (waiting?.window) res.type('html').send(signInPage(id)); else res.redirect(303, `/?app=${id}`);
    } catch (error) {
      cookie(res, '', 0);
      const message = error instanceof Error ? error.message : 'The sign-in failed.';
      if (waiting?.window) res.status(400).type('html').send(signInPage(waiting.app, message));
      else res.status(400).type('text/plain').send(`${message}\n\nClose this tab and try again from Plugins in ros.ai.`);
    }
  });
  app.delete('/api/apps/:id', (req, res) => res.json(apps.disconnect(appIdSchema.parse(req.params.id))));
  // Read-only tools for ros.ai's own scripts on this computer (the eval runner); writes go through an agent and Accept.
  app.post('/api/apps/:id/read', async (req, res) => {
    const id = appIdSchema.parse(req.params.id);
    const { tool, arguments: args } = z.object({ tool: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).default({}) }).strict().parse(req.body);
    if (!(await apps.tools(id)).find(item => item.name === tool)?.reads) throw new StoreError('Only tools that read can run here.', 403);
    res.json(await apps.call(id, tool, args));
  });
}
