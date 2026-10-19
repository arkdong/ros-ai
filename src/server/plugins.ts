import { constants, existsSync, fstatSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { StoreError } from './store.js';
import { notionBase } from './notion.js';
import type { PluginStatus, TokenPluginId } from '../shared/plugins.js';

const ids = ['zotero', 'slack', 'notion', 'github'] as const satisfies readonly TokenPluginId[];
const idSchema = z.enum(ids);
const tokenSchema = z.string().trim().min(8).max(4096).refine(value => !/\s|[\x00-\x1f\x7f]/.test(value), 'Enter a single token without spaces.');
const oauthSchema = z.object({ refreshToken: z.string().min(1).max(4096).optional(), workspace: z.string().max(200).optional(), connectedAt: z.string() }).strict();
const savedSchema = z.object({ version: z.literal(1), tokens: z.object({ zotero: tokenSchema.optional(), slack: tokenSchema.optional(), notion: tokenSchema.optional(), github: tokenSchema.optional() }).strict(), oauth: z.object({ notion: oauthSchema.optional() }).strict().optional() }).strict();
type OAuth = z.infer<typeof oauthSchema>;
const NOTION_CALLBACK = '/api/plugins/notion/callback', NOTION_COOKIE = 'ros-ai-notion-oauth', OAUTH_TTL = 10 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sameDigest = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
/** Notion's sign-in for a public (OAuth) connection: its client ID and secret come from the keys file or environment. */
const notionClient = () => { const id = process.env.NOTION_OAUTH_CLIENT_ID?.trim(), secret = process.env.NOTION_OAUTH_CLIENT_SECRET?.trim(); return id && secret ? { id, secret } : null; };
type Check = Pick<PluginStatus, 'checkedAt' | 'verified' | 'checkMessage'>;
/** Names from a provider are echoed back only as a short label. */
/** Tokens a local keys file or the shell may provide instead of the Plugins page. */
const environment: Partial<Record<TokenPluginId, string>> = { notion: 'NOTION_TOKEN' };
const label = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';

/** Plugin tokens stay in an owner-only file on this computer; the browser only learns whether one is saved and the last check. */
export class PluginTokens {
  private readonly file: string;
  private tokens: Partial<Record<TokenPluginId, string>> = {};
  private checks = new Map<TokenPluginId, Check>();
  private oauth: { notion?: OAuth } = {};
  private readonly pending = new Map<string, { nonceHash: string; redirectUri: string; expiresAt: number }>();
  constructor(dataDir: string, private readonly fetcher: typeof fetch = fetch) {
    this.file = join(dataDir, 'plugin-tokens.json');
    if (!existsSync(this.file)) return;
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 40000 || (info.mode & 0o077) !== 0) throw new Error('Invalid private plugin file.');
      const saved = savedSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
      this.tokens = saved.tokens; this.oauth = saved.oauth ?? {};
    } catch { throw new Error('Could not read private plugin tokens. Ensure the file is valid and readable only by its owner.'); }
    finally { closeSync(fd); }
  }
  private persist(tokens: Partial<Record<TokenPluginId, string>>, oauth = this.oauth) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, tokens, ...(Object.keys(oauth).length ? { oauth } : {}) }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new StoreError('Could not save the plugin token.', 500);
    }
    this.tokens = tokens; this.oauth = oauth;
  }
  status(id: TokenPluginId): PluginStatus {
    const signIn = id === 'notion' ? { signIn: { available: Boolean(notionClient()), ...(this.oauth.notion ? { workspace: this.oauth.notion.workspace ?? null } : {}) } } : {};
    return { id, configured: Boolean(this.token(id)), ...signIn, ...(this.checks.get(id) ?? { checkedAt: null, verified: null, checkMessage: null }) };
  }
  statuses() { return ids.map(id => this.status(id)); }
  /** For plugin features on the server; never sent to the browser. A saved token wins over the environment. */
  token(id: TokenPluginId) { const name = environment[id]; return this.tokens[id] ?? (name ? process.env[name]?.trim() || undefined : undefined); }
  save(id: TokenPluginId, supplied: unknown) {
    const { token } = z.object({ token: tokenSchema }).strict().parse(supplied);
    this.persist({ ...this.tokens, [id]: token });
    this.checks.delete(id);
    return this.status(id);
  }
  disconnect(id: TokenPluginId) {
    if (!this.tokens[id] && this.token(id)) throw new StoreError(`This token comes from ${environment[id]} in your keys file or environment. Remove it there and restart to disconnect.`);
    const tokens = { ...this.tokens }, oauth = { ...this.oauth }; delete tokens[id];
    if (id === 'notion') delete oauth.notion;
    this.persist(tokens, oauth); this.checks.delete(id);
    return this.status(id);
  }
  /** Starts Notion's sign-in. The state names this attempt; the cookie ties it to this browser. */
  beginNotion(redirectUri: string) {
    const client = notionClient();
    if (!client) throw new StoreError('Add NOTION_OAUTH_CLIENT_ID and NOTION_OAUTH_CLIENT_SECRET from your Notion OAuth connection to the keys file, then restart ros.ai.', 503);
    for (const [state, item] of this.pending) if (item.expiresAt < Date.now()) this.pending.delete(state);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    this.pending.set(state, { nonceHash: digest(nonce), redirectUri, expiresAt: Date.now() + OAUTH_TTL });
    const url = new URL(`${notionBase()}/v1/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: client.id, response_type: 'code', owner: 'user', redirect_uri: redirectUri, state }).toString();
    return { url: url.href, nonce };
  }
  /** Exchanges the code Notion sent back for the connection's token, saved like a pasted secret. */
  async finishNotion(query: unknown, nonce: string) {
    const { state, code, error } = z.object({ state: z.string().max(200), code: z.string().max(4000).optional(), error: z.string().max(200).optional() }).passthrough().parse(query);
    const item = this.pending.get(state), client = notionClient();
    if (!item || item.expiresAt < Date.now() || !nonce || !sameDigest(item.nonceHash, digest(nonce))) throw new StoreError('This Notion sign-in expired or was started in another browser. Start it again.');
    this.pending.delete(state);
    if (error || !code) throw new StoreError(error === 'access_denied' ? 'Notion sign-in was cancelled.' : 'Notion did not complete the sign-in.');
    if (!client) throw new StoreError('Notion sign-in is not set up.', 503);
    const result = await this.notionToken(client, { grant_type: 'authorization_code', code, redirect_uri: item.redirectUri });
    this.persist({ ...this.tokens, notion: result.token }, { ...this.oauth, notion: { refreshToken: result.refreshToken, workspace: result.workspace, connectedAt: new Date().toISOString() } });
    this.checks.set('notion', { checkedAt: new Date().toISOString(), verified: true, checkMessage: `Signed in to Notion${result.workspace ? ` (${result.workspace})` : ''}. Only the pages you chose there are visible.` });
  }
  /** A new access token from the saved refresh token, when Notion issued one; false when there is none or Notion refuses. */
  async refreshNotion(): Promise<boolean> {
    const client = notionClient(), refreshToken = this.oauth.notion?.refreshToken;
    if (!client || !refreshToken) return false;
    try {
      const result = await this.notionToken(client, { grant_type: 'refresh_token', refresh_token: refreshToken });
      this.persist({ ...this.tokens, notion: result.token }, { ...this.oauth, notion: { ...this.oauth.notion!, refreshToken: result.refreshToken ?? refreshToken } });
      return true;
    } catch { return false; }
  }
  private async notionToken(client: { id: string; secret: string }, body: Record<string, string>) {
    let response: globalThis.Response;
    try { response = await this.fetcher(`${notionBase()}/v1/oauth/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' }, body: JSON.stringify(body) }); }
    catch { throw new StoreError('Could not reach Notion to finish the sign-in.', 502); }
    const value = await response.json().catch(() => ({})) as { access_token?: unknown; refresh_token?: unknown; workspace_name?: unknown; error?: unknown };
    if (!response.ok || typeof value.access_token !== 'string') throw new StoreError(`Notion refused the sign-in${typeof value.error === 'string' ? ` (${label(value.error)})` : ''}. Check the client ID, secret and redirect URI.`);
    return { token: tokenSchema.parse(value.access_token), refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : undefined, workspace: label(value.workspace_name) || undefined };
  }
  /** One read-only identity request per check: it confirms the token without reading or changing any content. */
  async check(id: TokenPluginId) {
    const token = this.token(id);
    if (!token) throw new StoreError('Save a token first.');
    let verified = false, checkMessage = 'Could not reach the service. The token has not been checked.';
    try {
      const request = (url: string, init: RequestInit) => this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (id === 'zotero') {
        const response = await request('https://api.zotero.org/keys/current', { headers: { 'Zotero-API-Key': token, 'Zotero-API-Version': '3' } });
        const body = response.ok ? await response.json() as { username?: unknown } : null;
        verified = response.ok;
        checkMessage = response.ok ? `Zotero accepted the key${label(body?.username) ? ` for ${label(body?.username)}` : ''}.` : response.status === 403 || response.status === 404 ? 'Zotero rejected this key.' : `Zotero returned HTTP ${response.status}.`;
      } else if (id === 'slack') {
        const response = await request('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        const body = response.ok ? await response.json() as { ok?: boolean; team?: unknown } : null;
        verified = body?.ok === true;
        checkMessage = verified ? `Slack accepted the token${label(body?.team) ? ` for ${label(body?.team)}` : ''}.` : response.ok ? 'Slack rejected this token.' : `Slack returned HTTP ${response.status}.`;
      } else if (id === 'notion') {
        const response = await request(`${notionBase()}/v1/users/me`, { headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' } });
        verified = response.ok;
        checkMessage = response.ok ? 'Notion accepted the integration secret. Share pages with the integration to make them visible.' : response.status === 401 ? 'Notion rejected this secret.' : `Notion returned HTTP ${response.status}.`;
      } else {
        const response = await request('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ros.ai' } });
        const body = response.ok ? await response.json() as { login?: unknown } : null;
        verified = response.ok;
        checkMessage = response.ok ? `GitHub accepted the token${label(body?.login) ? ` for ${label(body?.login)}` : ''}.` : response.status === 401 ? 'GitHub rejected this token.' : `GitHub returned HTTP ${response.status}.`;
      }
    } catch { /* Keep a short message without provider details. */ }
    // A replacement saved during the check must not inherit this result.
    if (this.token(id) !== token) throw new StoreError('The token changed during this check. Check the current token again.');
    this.checks.set(id, { checkedAt: new Date().toISOString(), verified, checkMessage });
    return this.status(id);
  }
}

/** The address Notion sends the browser back to; register exactly this in the Notion OAuth connection. */
export function notionRedirectUri(host: string | undefined) {
  if (process.env.NOTION_OAUTH_REDIRECT_URI?.trim()) return process.env.NOTION_OAUTH_REDIRECT_URI.trim();
  return `http://localhost:${host?.match(/:(\d+)$/)?.[1] ?? '4310'}${NOTION_CALLBACK}`;
}
const notionCookie = (res: Response, value: string, maxAge: number) => res.cookie(NOTION_COOKIE, value, { httpOnly: true, sameSite: 'lax', path: NOTION_CALLBACK, maxAge, secure: false });
const notionNonce = (req: Request) => { const item = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${NOTION_COOKIE}=`)); const value = item?.slice(NOTION_COOKIE.length + 1) ?? ''; return /^[\w-]{43}$/u.test(value) ? value : ''; };

export function attachPluginRoutes(app: Express, plugins: PluginTokens) {
  app.get('/api/plugins/notion/sign-in', (req, res) => res.json({ redirectUri: notionRedirectUri(req.headers.host) }));
  app.post('/api/plugins/notion/sign-in', (req, res) => { const started = plugins.beginNotion(notionRedirectUri(req.headers.host)); notionCookie(res, started.nonce, OAUTH_TTL); res.json({ authorizationUrl: started.url }); });
  app.get(NOTION_CALLBACK, async (req, res) => {
    try { await plugins.finishNotion(req.query, notionNonce(req)); notionCookie(res, '', 0); res.redirect(303, '/?notion=connected'); }
    catch (error) { notionCookie(res, '', 0); res.status(400).type('text/plain').send(`${error instanceof Error ? error.message : 'Notion sign-in failed.'}\n\nClose this tab and try again from the Plugins page.`); }
  });
  app.get('/api/plugins', (_req, res) => res.json({ plugins: plugins.statuses() }));
  app.put('/api/plugins/:id', (req, res) => res.json(plugins.save(idSchema.parse(req.params.id), req.body)));
  app.delete('/api/plugins/:id', (req, res) => res.json(plugins.disconnect(idSchema.parse(req.params.id))));
  app.post('/api/plugins/:id/check', async (req, res) => res.json(await plugins.check(idSchema.parse(req.params.id))));
}
