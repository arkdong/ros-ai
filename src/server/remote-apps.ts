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
import type { AppConnectionStatus } from '../shared/plugins.js';

/** Apps that run their own hosted MCP server. ros.ai connects to it the way Claude and Claude Code do:
 * it registers itself with the app's sign-in, the person approves in the browser, and the app's own tools
 * become available to ros.ai's agents. Nothing to create or paste. `reads` names tools that only read,
 * for servers that do not mark them; any other tool waits for the person's approval before it runs. */
export const appCatalogue = {
  notion: { name: 'Notion', url: 'https://mcp.notion.com/mcp', reads: ['notion-search', 'notion-fetch', 'notion-query-data-sources', 'notion-query-database-view', 'notion-get-comments', 'notion-get-users', 'notion-get-self', 'notion-get-teams', 'notion-get-file-download-urls', 'notion-list-page-backlinks'] },
} as const satisfies Record<string, { name: string; url: string; reads: readonly string[] }>;
export type AppId = keyof typeof appCatalogue;
const appIds = Object.keys(appCatalogue) as AppId[];
const appIdSchema = z.enum(appIds as [AppId, ...AppId[]]);

const CALLBACK = '/api/apps/callback', COOKIE = 'ros-ai-app-sign-in', SIGN_IN_TTL = 10 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sameDigest = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const label = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : '';

/** `ROS_APP_<ID>_URL` points an app at another server, but only https or this computer (for stand-ins). */
export function appUrl(id: AppId) {
  const override = process.env[`ROS_APP_${id.toUpperCase()}_URL`]?.trim();
  if (!override) return appCatalogue[id].url;
  const url = new URL(override);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error(`ROS_APP_${id.toUpperCase()}_URL must be https or on this computer.`);
  return url.href;
}

type Saved = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirectUri?: string; connectedAt?: string; account?: string };
type Pending = { app: AppId; nonceHash: string; redirectUri: string; verifier?: string; expiresAt: number; popup?: boolean };
export type AppTool = { name: string; description: string; inputSchema: Record<string, unknown>; reads: boolean };
export type AppStatus = AppConnectionStatus & { id: AppId };

/** Sign-ins and tokens for hosted app servers, in one owner-only file in the data folder. The browser
 * only learns whether an app is connected; tokens never leave the server. */
export class RemoteApps {
  private readonly file: string;
  private saved: Partial<Record<AppId, Saved>> = {};
  private readonly pending = new Map<string, Pending>();
  private readonly clients = new Map<AppId, { client: Client; tools: AppTool[] }>();
  constructor(dataDir: string) {
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
      redirectToAuthorization: url => { if (!flow) throw new StoreError(`${appCatalogue[id].name} needs you to sign in again. Open Apps and connect it.`, 409); flow.open(url); },
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
  status(id: AppId): AppStatus {
    const saved = this.saved[id];
    return { id, name: appCatalogue[id].name, connected: Boolean(saved?.tokens?.access_token), connectedAt: saved?.connectedAt ?? null, account: saved?.account ?? null };
  }
  statuses() { return appIds.map(id => this.status(id)); }
  connected() { return appIds.filter(id => this.status(id).connected); }
  /** Starts the app's sign-in: ros.ai registers itself if needed and returns the address to open. A `popup`
   * sign-in was opened in its own tab (the setup screen), so the callback shows a closing note instead of the app. */
  async begin(id: AppId, redirectUri: string, popup = false) {
    for (const [state, item] of this.pending) if (item.expiresAt < Date.now()) this.pending.delete(state);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const pending: Pending = { app: id, nonceHash: digest(nonce), redirectUri, expiresAt: Date.now() + SIGN_IN_TTL, popup };
    let opened: URL | undefined;
    let result: Awaited<ReturnType<typeof auth>>;
    try { result = await auth(this.provider(id, redirectUri, { state, pending, open: url => { opened = url; } }), { serverUrl: appUrl(id) }); }
    catch (error) { throw new StoreError(`Could not start the ${appCatalogue[id].name} sign-in: ${error instanceof StoreError ? error.message : label(error instanceof Error ? error.message : String(error)) || 'the app did not answer.'}`, 502); }
    if (result === 'AUTHORIZED' || !opened) { this.clients.delete(id); return { alreadyConnected: true as const }; }
    this.pending.set(state, pending);
    return { url: opened.href, nonce };
  }
  /** The app sent the browser back with a code: exchange it for tokens and remember them. */
  async finish(query: unknown, nonce: string) {
    const { state, code, error } = z.object({ state: z.string().max(400), code: z.string().max(4000).optional(), error: z.string().max(200).optional() }).passthrough().parse(query);
    const pending = this.pending.get(state);
    if (!pending || pending.expiresAt < Date.now() || !nonce || !sameDigest(pending.nonceHash, digest(nonce))) throw new StoreError('This sign-in expired or was started in another browser. Start it again from Apps.');
    this.pending.delete(state);
    const name = appCatalogue[pending.app].name;
    if (error || !code) throw new StoreError(error === 'access_denied' ? `${name} sign-in was cancelled.` : `${name} did not complete the sign-in.`);
    try { await auth(this.provider(pending.app, pending.redirectUri, { state, pending, open: () => { throw new StoreError(`${name} asked to sign in again.`); } }), { serverUrl: appUrl(pending.app), authorizationCode: code }); }
    catch (failure) { throw new StoreError(`${name} refused the sign-in: ${failure instanceof StoreError ? failure.message : label(failure instanceof Error ? failure.message : String(failure))}`, 502); }
    this.save(pending.app, { ...this.saved[pending.app], connectedAt: new Date().toISOString() });
    this.clients.delete(pending.app);
    // Name the account when the app says who signed in, so the Apps page can show it.
    const tools = await this.tools(pending.app).catch(() => []);
    if (pending.app === 'notion' && tools.some(tool => tool.name === 'notion-get-self')) {
      const self = await this.call('notion', 'notion-get-self', {}).catch(() => null);
      const account = label(self?.text.match(/"(?:name|workspace_name)"\s*:\s*"([^"]+)"/)?.[1]);
      if (account) this.save('notion', { ...this.saved.notion, account });
    }
    return { app: pending.app, popup: Boolean(pending.popup) };
  }
  disconnect(id: AppId) {
    const entry = this.clients.get(id); this.clients.delete(id);
    void entry?.client.close().catch(() => undefined);
    this.save(id, undefined);
    return this.status(id);
  }
  private async open(id: AppId) {
    const cached = this.clients.get(id);
    if (cached) return cached;
    if (!this.status(id).connected) throw new StoreError(`${appCatalogue[id].name} is not connected. Open Apps and connect it.`, 409);
    const redirectUri = this.saved[id]?.redirectUri ?? appRedirectUri(undefined);
    const client = new Client({ name: 'ros.ai', version: '1' });
    try { await client.connect(new StreamableHTTPClientTransport(new URL(appUrl(id)), { authProvider: this.provider(id, redirectUri) })); }
    catch (error) { throw new StoreError(error instanceof StoreError ? error.message : `Could not reach ${appCatalogue[id].name}: ${label(error instanceof Error ? error.message : String(error))}`, 502); }
    const reads = new Set<string>(appCatalogue[id].reads);
    const listed = (await client.listTools()).tools;
    const entry = { client, tools: listed.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as Record<string, unknown>, reads: tool.annotations?.readOnlyHint === true || reads.has(tool.name) })) };
    this.clients.set(id, entry);
    return entry;
  }
  async tools(id: AppId) { return (await this.open(id)).tools; }
  /** Runs one of the app's tools and returns its text. Callers decide first whether it needs approval. */
  async call(id: AppId, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    let entry = await this.open(id);
    if (!entry.tools.some(tool => tool.name === name)) throw new StoreError(`${appCatalogue[id].name} has no tool called ${label(name)}.`);
    const run = () => entry.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 });
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(); }
    catch (error) {
      if (signal?.aborted || error instanceof StoreError) throw error;
      // A dropped session: connect once more, then give up.
      this.clients.delete(id); entry = await this.open(id);
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
/** The tab a sign-in opened from the setup screen: nothing to do there once the app has answered. */
const closePage = (name: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${name} connected</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;color:#1d1d1b;background:#f6f6f4}p{margin:0;padding:24px;text-align:center}</style></head><body><p><strong>${name} is connected to ros.ai.</strong><br>You can close this tab and go back to ros.ai.</p><script>setTimeout(function(){window.close()},900)</script></body></html>`;
const nonceOf = (req: Request) => { const item = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`)); const value = item?.slice(COOKIE.length + 1) ?? ''; return /^[\w-]{43}$/u.test(value) ? value : ''; };

export function attachAppRoutes(app: Express, apps: RemoteApps) {
  app.get('/api/apps', (_req, res) => res.json({ apps: apps.statuses() }));
  app.post('/api/apps/:id/connect', async (req, res) => {
    const id = appIdSchema.parse(req.params.id), { popup } = z.object({ popup: z.boolean().optional() }).strict().parse(req.body ?? {});
    const started = await apps.begin(id, appRedirectUri(req.headers.host), popup === true);
    if ('alreadyConnected' in started) return res.json({ connected: true, app: apps.status(id) });
    cookie(res, started.nonce, SIGN_IN_TTL);
    res.json({ authorizationUrl: started.url });
  });
  app.get(CALLBACK, async (req, res) => {
    try { const { app: id, popup } = await apps.finish(req.query, nonceOf(req)); cookie(res, '', 0); if (popup) { res.type('html').send(closePage(appCatalogue[id].name)); return; } res.redirect(303, `/?app=${id}`); }
    catch (error) { cookie(res, '', 0); res.status(400).type('text/plain').send(`${error instanceof Error ? error.message : 'The sign-in failed.'}\n\nClose this tab and try again from Apps in ros.ai.`); }
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
