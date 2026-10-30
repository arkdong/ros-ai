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
import { followScript } from './sign-in-window.js';
import type { AppAccountStatus, AppConnectionStatus, TokenPluginId } from '../shared/plugins.js';

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
  // GitHub's hosted server takes no dynamic registration, so it uses the GitHub CLI's sign-in or the token from GitHub's
  // Plugins card; it marks its own read tools.
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

const CALLBACK = '/api/apps/callback', COOKIE = 'ros-ai-app-sign-in', SIGN_IN_TTL = 10 * 60_000, NOTICE_MS = 2 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sameDigest = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const label = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : '';
/** Apps a person can sign in to more than once, one workspace each time (Notion's sign-in page asks which). */
const SEVERAL: ReadonlySet<AppId> = new Set<AppId>(['notion']);
/** An account's short name, for its address in ros.ai and agents' name for it: "Lisbon & Co" → lisbon-co. */
const slug = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').slice(0, 24).replace(/^-+|-+$/gu, '');
const unused = (base: string, taken: ReadonlySet<string>) => { let name = base; for (let n = 2; taken.has(name); n++) name = `${base}-${n}`; return name; };

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

/** key, name, workspace, user and email: kept for an app with several accounts. key is the account's name in ros.ai (in
 * its address and on the blocks that read with it) and name one the person gave it; workspace and user say who signed
 * in where, so signing in to the same workspace again renews the account instead of adding it twice. */
type Saved = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirectUri?: string; connectedAt?: string; account?: string; key?: string; name?: string; workspace?: string; user?: string; email?: string };
/** An app's accounts after its first. The first stays in app-connections.json, where every version of ros.ai reads it,
 * so an earlier version still finds one; the others live in app-accounts.json, which earlier versions never read or
 * rewrite. default: the account agents call by the app's own id and blocks try first. */
type More = { default?: string; accounts: Saved[] };
/** first: the account kept in app-connections.json. */
type Account = { key: string; saved: Saved; first: boolean };
/** nonceHash: the cookie the browser that started the sign-in holds, or null for the Mac app, whose sign-in finishes in the
 * system browser. window: the sign-in opened in a window of its own, so its callback page tells ros.ai and closes; keep:
 * that window stays open, because Connect your tools opens the next sign-in in it. slot: the client and tokens the
 * sign-in ends with, kept here until it finishes, so a sign-in that is cancelled or refused changes no account. account:
 * the account it signs in to again; without it, the sign-in may add one. */
type Pending = { app: AppId; nonceHash: string | null; redirectUri: string; verifier?: string; expiresAt: number; window?: boolean; keep?: boolean; slot: Saved; account?: string };
/** Who a sign-in is: the workspace's name and id, and the person's id and email. */
type Identity = { name: string; workspace?: string; user?: string; email?: string };
/** proposes: the tool adds blocks to the canvas, which ros.ai proposes under the project's approval mode, instead of a
 * change in the app that always waits for the person (Papers' add_paper). */
export type AppTool = { name: string; description: string; inputSchema: Record<string, unknown>; reads: boolean; proposes?: boolean };
export type AppStatus = AppConnectionStatus & { id: AppId };
/** How agents name a connected app (see agentApps), the account it reaches, and what the tool text calls it. */
export type AgentApp = { name: string; app: AppId; account?: string; label: string };
/** An app whose tools ros.ai provides itself (Slack, Google Drive, Papers), shaped like an MCP server's; connected once
 * its token is saved, its sign-in is done or, for Papers, a source is on. */
export type BuiltInApp = { connected(): boolean; tools(): AppTool[]; call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> };
type Options = { token?: (id: TokenPluginId) => string | undefined; builtIn?: Partial<Record<AppId, BuiltInApp>> };
type Connection = { client: Client; tools: AppTool[]; key?: string; ref: string };

const signedIn = (saved: Saved | undefined) => Boolean(saved?.tokens?.access_token);
const metadata = (redirectUri: string) => ({ client_name: 'ros.ai', client_uri: 'https://github.com/arkdong/ros-ai', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
const textOf = (result: Record<string, unknown>) => (Array.isArray(result.content) ? result.content as { type: string; text?: string }[] : []).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
/** Who a Notion sign-in is, from notion-get-self: {"workspace":{"id","name"},"user":{"id","name","email"}}. */
function identityOf(text: string): Identity | undefined {
  let value: { workspace?: { id?: unknown; name?: unknown }; user?: { id?: unknown; email?: unknown } } | undefined;
  try { value = JSON.parse(text); } catch { value = undefined; }
  const id = (item: unknown) => typeof item === 'string' && /^[\w-]{1,64}$/u.test(item) ? item : undefined;
  const name = label(value?.workspace?.name) || label(text.match(/"(?:name|workspace_name)"\s*:\s*"([^"]+)"/u)?.[1]), workspace = id(value?.workspace?.id), user = id(value?.user?.id), email = label(value?.user?.email);
  return name || workspace ? { name, ...(workspace ? { workspace } : {}), ...(user ? { user } : {}), ...(email ? { email } : {}) } : undefined;
}
/** A file in the data folder that only its owner may read, or undefined before it exists. */
function readPrivate(file: string, valid: (value: { version?: number; apps?: unknown }) => boolean) {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 200_000 || (info.mode & 0o077) !== 0) throw new Error('invalid');
    const value = JSON.parse(readFileSync(fd, 'utf8')) as { version?: number; apps?: Record<string, unknown> };
    if (!valid(value) || typeof value.apps !== 'object' || !value.apps) throw new Error('invalid');
    return value.apps;
  } finally { closeSync(fd); }
}

/** Sign-ins for hosted app servers and the desktop apps turned on, in owner-only files in the data folder. Apps reached
 * with a Plugins token read it from there when they connect. An app in SEVERAL keeps a sign-in for each workspace the
 * person adds. The browser only learns whether an app or account is connected; tokens never leave the server. */
export class RemoteApps {
  private readonly file: string;
  private readonly moreFile: string;
  private saved: Partial<Record<AppId, Saved>> = {};
  private more: Partial<Record<AppId, More>> = {};
  private readonly pending = new Map<string, Pending>();
  /** By app, or by app and account for an app with several. key: a digest of the token a token app connected with, so a
   * replaced token connects again. */
  private readonly clients = new Map<string, Connection>();
  /** What the last sign-in of an app did, when it did more than connect (it renewed an account). */
  private readonly notices = new Map<AppId, { text: string; at: number }>();
  /** Accounts asked who they are since ros.ai started, so each is asked once. */
  private readonly asked = new Set<string>();
  constructor(dataDir: string, private readonly options: Options = {}) {
    this.file = join(dataDir, 'app-connections.json');
    this.moreFile = join(dataDir, 'app-accounts.json');
    const read = (file: string) => { try { return readPrivate(file, value => value.version === 1); } catch { throw new Error(`Could not read ${file}. Make sure it is valid and readable only by its owner, or delete it to sign in to your apps again.`); } };
    const apps = read(this.file) as Partial<Record<AppId, Saved>> | undefined, more = read(this.moreFile) as Partial<Record<AppId, More>> | undefined;
    if (apps) this.saved = Object.fromEntries(Object.entries(apps).filter(([id]) => appIds.includes(id as AppId)));
    if (more) this.more = Object.fromEntries(Object.entries(more).filter(([id, value]) => SEVERAL.has(id as AppId) && Array.isArray(value?.accounts)).map(([id, value]) => [id, { ...(typeof value!.default === 'string' ? { default: value!.default } : {}), accounts: value!.accounts.filter(item => typeof item?.key === 'string') }]));
  }
  private write(file: string, apps: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, apps }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new StoreError('Could not save the app sign-in.', 500);
    }
  }
  private save(id: AppId, change: Saved | undefined) {
    const apps = { ...this.saved };
    if (change) apps[id] = change; else delete apps[id];
    this.write(this.file, apps);
    this.saved = apps;
  }
  private saveMore(id: AppId, change: More | undefined) {
    const more = { ...this.more };
    if (change && (change.accounts.length || change.default)) more[id] = change; else delete more[id];
    this.write(this.moreFile, more);
    this.more = more;
  }
  /** An app's accounts, the default first, then in the order they were added. The first one's key is its workspace's
   * slug until it is written down (see add). */
  private accounts(id: AppId): Account[] {
    const first = this.saved[id], more = SEVERAL.has(id) ? this.more[id] : undefined;
    const list: Account[] = first ? [{ key: SEVERAL.has(id) ? first.key ?? (slug(first.account ?? '') || id) : id, saved: first, first: true }] : [];
    for (const saved of more?.accounts ?? []) list.push({ key: saved.key!, saved, first: false });
    const chosen = list.findIndex(item => item.key === more?.default);
    if (chosen > 0) list.unshift(...list.splice(chosen, 1));
    return list;
  }
  /** One account by its key; an app with one sign-in has only the one. */
  private account(id: AppId, key: string) { const accounts = this.accounts(id); return SEVERAL.has(id) ? accounts.find(item => item.key === key) : accounts[0]; }
  /** The account a call goes to: the one named, or the default while it is signed in, otherwise the next that is. */
  private pick(id: AppId, key?: string) {
    const accounts = this.accounts(id);
    return key !== undefined && SEVERAL.has(id) ? accounts.find(item => item.key === key) : accounts.find(item => signedIn(item.saved)) ?? accounts[0];
  }
  /** Changes one account where it is kept; undefined forgets it. */
  private put(id: AppId, key: string, change: Partial<Saved> | undefined) {
    const account = this.account(id, key);
    if (!account) return;
    if (account.first) { this.save(id, change ? { ...account.saved, ...(SEVERAL.has(id) ? { key: account.key } : {}), ...change } : undefined); return; }
    const more = this.more[id]!;
    this.saveMore(id, { ...more, ...(change || more.default !== key ? {} : { default: undefined }), accounts: change ? more.accounts.map(item => item.key === key ? { ...item, ...change } : item) : more.accounts.filter(item => item.key !== key) });
  }
  /** A new account: the first is kept where every version of ros.ai reads it, the others in app-accounts.json. */
  private add(id: AppId, saved: Saved) {
    const accounts = this.accounts(id), key = unused(slug(saved.account ?? '') || 'workspace', new Set(accounts.map(item => item.key)));
    const first = accounts.find(item => item.first);
    if (!first) { this.save(id, { ...saved, key }); return key; }
    // The first account's key is written down before another can take a name like it.
    if (!first.saved.key) this.save(id, { ...first.saved, key: first.key });
    const more = this.more[id] ?? { accounts: [] };
    this.saveMore(id, { ...more, accounts: [...more.accounts, { ...saved, key }] });
    return key;
  }
  private shown(id: AppId, saved: Saved) { return saved.name || saved.account || `${appCatalogue[id].name} workspace`; }
  /** What the app is to the person: account's name when it has several, its own name otherwise. */
  private named(id: AppId, account: Account) { return this.accounts(id).length > 1 ? `${appCatalogue[id].name} · ${this.shown(id, account.saved)}` : appCatalogue[id].name; }
  /** What the SDK needs to send an account's token, and to keep the token fresh. */
  private provider(id: AppId, key: string, redirectUri: string): OAuthClientProvider {
    const apps = this, current = () => apps.account(id, key)?.saved;
    return {
      get redirectUrl() { return redirectUri; },
      get clientMetadata() { return metadata(redirectUri); },
      state: () => randomBytes(32).toString('base64url'),
      // A registration made for another address (ros.ai on another port) is not reused.
      clientInformation: () => current()?.redirectUri === redirectUri ? current()?.client : undefined,
      saveClientInformation: client => apps.put(id, key, { client, redirectUri, tokens: current()?.redirectUri === redirectUri ? current()?.tokens : undefined }),
      tokens: () => current()?.tokens,
      saveTokens: tokens => apps.put(id, key, { tokens, connectedAt: current()?.connectedAt ?? new Date().toISOString() }),
      redirectToAuthorization: () => { const account = apps.account(id, key); throw new StoreError(account && apps.accounts(id).length > 1 ? `${apps.named(id, account)} needs you to sign in again. Open Plugins › ${appCatalogue[id].name} and sign in again.` : `${appCatalogue[id].name} needs you to sign in again. Open Plugins and connect it.`, 409); },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => { throw new StoreError('This sign-in has no verifier. Start it again.'); },
      invalidateCredentials: scope => {
        if (!current()) return;
        // An account of an app with several keeps its name and workspace, so the Plugins page offers to sign in again.
        if (scope === 'all' && !SEVERAL.has(id)) apps.put(id, key, undefined);
        else if (scope === 'all' || scope === 'client') apps.put(id, key, { client: undefined, tokens: undefined });
        else if (scope === 'tokens') apps.put(id, key, { tokens: undefined });
      },
    };
  }
  /** The same for a sign-in in the browser, on the pending sign-in's own slot until it finishes. */
  private signIn(id: AppId, pending: Pending, state: string, open?: (url: URL) => void): OAuthClientProvider {
    const slot = pending.slot;
    return {
      get redirectUrl() { return pending.redirectUri; },
      get clientMetadata() { return metadata(pending.redirectUri); },
      state: () => state,
      clientInformation: () => slot.client,
      saveClientInformation: client => { slot.client = client; },
      tokens: () => slot.tokens,
      saveTokens: tokens => { slot.tokens = tokens; },
      redirectToAuthorization: url => { if (!open) throw new StoreError(`${appCatalogue[id].name} asked to sign in again.`); open(url); },
      saveCodeVerifier: verifier => { pending.verifier = verifier; },
      codeVerifier: () => { if (!pending.verifier) throw new StoreError('This sign-in has no verifier. Start it again.'); return pending.verifier; },
      invalidateCredentials: scope => { if (scope === 'all' || scope === 'client') { slot.client = undefined; slot.tokens = undefined; } else if (scope === 'tokens') slot.tokens = undefined; },
    };
  }
  private token(id: AppId) { const app = entry(id); return (app.auth === 'token' || app.auth === 'built-in') && app.token ? this.options.token?.(app.token) || undefined : undefined; }
  status(id: AppId): AppStatus {
    const app = entry(id), notice = this.notices.get(id);
    if (app.auth === 'sign-in') {
      const accounts = this.accounts(id), first = accounts[0];
      return { id, name: app.name, connected: accounts.some(item => signedIn(item.saved)), connectedAt: first?.saved.connectedAt ?? null, account: first ? first.saved.name ?? first.saved.account ?? null : null,
        ...(SEVERAL.has(id) ? { accounts: accounts.map((item, index): AppAccountStatus => ({ key: item.key, name: this.shown(id, item.saved), email: item.saved.email ?? null, connected: signedIn(item.saved), connectedAt: item.saved.connectedAt ?? null, default: index === 0 })) } : {}),
        ...(notice && Date.now() - notice.at < NOTICE_MS ? { notice: notice.text } : {}) };
    }
    const saved = this.saved[id];
    const connected = app.auth === 'desktop' ? Boolean(saved?.connectedAt) : app.auth === 'built-in' ? this.options.builtIn?.[id]?.connected() === true : Boolean(this.token(id));
    return { id, name: app.name, connected, connectedAt: app.auth === 'desktop' ? saved?.connectedAt ?? null : null, account: saved?.account ?? null };
  }
  statuses() { return appIds.map(id => this.status(id)); }
  connected() { return appIds.filter(id => this.status(id).connected); }
  /** An app's accounts that can be used now, the default first, by key and the name the person sees. */
  accountsOf(id: AppId) { return this.accounts(id).filter(item => signedIn(item.saved)).map(item => ({ key: item.key, name: this.shown(id, item.saved) })); }
  /** How agents name the connected apps: by the app's id, and for an app with several accounts signed in, one name for
   * each: the default keeps the app's id, so with one account agents see what they always saw, and each other is the
   * app's id and the account's name (notion-personal). */
  agentApps(): AgentApp[] {
    return this.connected().flatMap((id): AgentApp[] => {
      const live = SEVERAL.has(id) ? this.accounts(id).filter(item => signedIn(item.saved)) : [];
      if (live.length < 2) return [{ name: id, app: id, ...(live[0] ? { account: live[0].key } : {}), label: appCatalogue[id].name }];
      const taken = new Set<string>();
      return live.map((item, index) => {
        const name = unused(index ? `${id}-${slug(this.shown(id, item.saved)) || item.key}` : id, taken);
        taken.add(name);
        return { name, app: id, account: item.key, label: `${appCatalogue[id].name} · ${this.shown(id, item.saved)}` };
      });
    });
  }
  /** The app and account an agent named: by agentApps' names, or an account by its key (notion-<key>). */
  agentApp(supplied: string): AgentApp | undefined {
    const wanted = supplied.trim().toLowerCase(), apps = this.agentApps();
    return apps.find(item => item.name === wanted) ?? apps.find(item => item.account !== undefined && SEVERAL.has(item.app) && wanted === `${item.app}-${item.account}`);
  }
  /** Starts a sign-in in the browser and returns the address to open. window: it opens in a window of its own. bound (the
   * default): only the browser holding the returned nonce, as a cookie, can finish it. account: sign in to that account
   * again; add: sign in to another workspace of an app with several accounts. Otherwise a signed-in app stays as it is. */
  async begin(id: AppId, redirectUri: string, options: { window?: boolean; keep?: boolean; bound?: boolean; add?: boolean; account?: string } = {}) {
    const app = entry(id);
    if (app.auth !== 'sign-in') throw new StoreError(`${app.name} does not connect with a sign-in.`);
    const accounts = this.accounts(id);
    let target: Account | undefined;
    if (options.account !== undefined && SEVERAL.has(id)) {
      target = accounts.find(item => item.key === options.account);
      if (!target) throw new StoreError(`No ${app.name} account called ${label(options.account)}. Open Plugins › ${app.name} to see your accounts.`, 404);
    } else if (!(options.add && SEVERAL.has(id))) {
      target = accounts[0];
      if (target && signedIn(target.saved)) return { alreadyConnected: true as const };
    }
    for (const [state, item] of this.pending) if (item.expiresAt < Date.now()) this.pending.delete(state);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    // Another account registers ros.ai afresh, so no two accounts share a registration; signing in again reuses its own.
    const slot: Saved = target?.saved.client && target.saved.redirectUri === redirectUri ? { client: target.saved.client, redirectUri } : { redirectUri };
    const pending: Pending = { app: id, nonceHash: options.bound === false ? null : digest(nonce), redirectUri, expiresAt: Date.now() + SIGN_IN_TTL, slot, ...(target && SEVERAL.has(id) ? { account: target.key } : {}), ...(options.window ? { window: true } : {}), ...(options.window && options.keep ? { keep: true } : {}) };
    let opened: URL | undefined;
    try { await auth(this.signIn(id, pending, state, url => { opened = url; }), { serverUrl: appUrl(id) }); }
    catch (error) { throw new StoreError(`Could not start the ${app.name} sign-in: ${error instanceof StoreError ? error.message : label(error instanceof Error ? error.message : String(error)) || 'the app did not answer.'}`, 502); }
    if (!opened) throw new StoreError(`Could not start the ${app.name} sign-in: it did not send a sign-in page.`, 502);
    this.pending.set(state, pending);
    return { url: opened.href, nonce };
  }
  /** The sign-in a callback belongs to, before it finishes: which app, whether it opened in its own window, and whether
   * that window stays open for the next sign-in. */
  waiting(state: unknown) { const pending = typeof state === 'string' ? this.pending.get(state) : undefined; return pending && pending.expiresAt >= Date.now() ? { app: pending.app, window: pending.window === true, keep: pending.keep === true } : undefined; }
  /** What the app's last sign-in did besides connecting, for a short while after it. */
  notice(id: AppId) { const notice = this.notices.get(id); return notice && Date.now() - notice.at < NOTICE_MS ? notice.text : undefined; }
  /** The app sent the browser back with a code: exchange it for tokens and remember them. */
  async finish(query: unknown, nonce: string) {
    const { state, code, error } = z.object({ state: z.string().max(400), code: z.string().max(4000).optional(), error: z.string().max(200).optional() }).passthrough().parse(query);
    const pending = this.pending.get(state);
    if (!pending || pending.expiresAt < Date.now() || (pending.nonceHash !== null && (!nonce || !sameDigest(pending.nonceHash, digest(nonce))))) throw new StoreError('This sign-in expired or was started in another browser. Start it again from Plugins.');
    this.pending.delete(state);
    const id = pending.app, name = appCatalogue[id].name;
    if (error || !code) throw new StoreError(error === 'access_denied' ? `${name} sign-in was cancelled.` : `${name} did not complete the sign-in.`);
    try { await auth(this.signIn(id, pending, state, () => { throw new StoreError(`${name} asked to sign in again.`); }), { serverUrl: appUrl(id), authorizationCode: code }); }
    catch (failure) { throw new StoreError(`${name} refused the sign-in: ${failure instanceof StoreError ? failure.message : label(failure instanceof Error ? failure.message : String(failure))}`, 502); }
    const signIn: Saved = { client: pending.slot.client, redirectUri: pending.slot.redirectUri, tokens: pending.slot.tokens, connectedAt: new Date().toISOString() };
    this.notices.delete(id);
    if (!SEVERAL.has(id)) { this.save(id, { ...this.saved[id], ...signIn }); this.forget(id); return id; }
    await this.place(id, pending, state, signIn);
    return id;
  }
  /** Where a finished sign-in to an app with several accounts goes: the account it signed in to again, the account of
   * the same workspace and person (renewed), or a new account. Notion names who signed in where (notion-get-self). */
  private async place(id: AppId, pending: Pending, state: string, signIn: Saved) {
    const name = appCatalogue[id].name, who = await this.identify(id, pending, state);
    const known: Partial<Saved> = who ? { ...(who.name ? { account: who.name } : {}), ...(who.workspace ? { workspace: who.workspace } : {}), ...(who.user ? { user: who.user } : {}), ...(who.email ? { email: who.email } : {}) } : {};
    // Accounts signed in before ros.ai kept who they are say it now, so the same workspace is recognised.
    for (const item of this.accounts(id)) if (!item.saved.workspace && signedIn(item.saved) && item.key !== pending.account) await this.ask(id, item.key);
    const accounts = this.accounts(id);
    const same = who?.workspace ? accounts.find(item => item.saved.workspace === who.workspace && (!who.user || !item.saved.user || item.saved.user === who.user)) : undefined;
    const target = pending.account === undefined ? undefined : accounts.find(item => item.key === pending.account);
    const renew = (account: Account, text?: string) => { this.put(id, account.key, { ...signIn, ...known }); this.forget(id, account.key); if (text) this.notices.set(id, { text, at: Date.now() }); };
    if (target) {
      // Signed in to the account it was for, or to an account ros.ai cannot tell apart from it.
      if (!who?.workspace || same?.key === target.key || (!target.saved.workspace && !same)) return renew(target);
      if (target.saved.workspace) throw new StoreError(`${name} signed in to ${who.name || 'another workspace'}, not ${this.shown(id, target.saved)}, so nothing changed. Sign in again and pick ${this.shown(id, target.saved)} in ${name}${same ? '' : `, or add ${who.name || 'that workspace'} with Add account`}.`, 409);
    }
    if (same) return renew(same, `${this.shown(id, same.saved)} was connected already, so ros.ai renewed its sign-in.${target ? ` ${this.shown(id, target.saved)} still needs you to sign in again.` : ''}`);
    this.add(id, { ...signIn, ...known });
  }
  /** Who a sign-in is, asked once over a connection of its own before it is kept. */
  private async identify(id: AppId, pending: Pending, state: string): Promise<Identity | undefined> {
    const client = new Client({ name: 'ros.ai', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(appUrl(id)), { authProvider: this.signIn(id, pending, state) }));
      if (!(await client.listTools()).tools.some(tool => tool.name === 'notion-get-self')) return undefined;
      return identityOf(textOf(await client.callTool({ name: 'notion-get-self', arguments: {} }, undefined, { timeout: 30_000 })));
    } catch { return undefined; }
    finally { void client.close().catch(() => undefined); }
  }
  /** Asks an account kept before ros.ai noted who signed in for its workspace, person and email, and notes them. */
  private async ask(id: AppId, key: string) {
    if (this.asked.has(`${id}/${key}`)) return;
    this.asked.add(`${id}/${key}`);
    try {
      if (!(await this.tools(id, key)).some(tool => tool.name === 'notion-get-self')) return;
      const who = identityOf((await this.call(id, 'notion-get-self', {}, undefined, key)).text), account = this.account(id, key);
      if (who && account) this.put(id, key, { ...(who.workspace ? { workspace: who.workspace } : {}), ...(who.user ? { user: who.user } : {}), ...(who.email ? { email: who.email } : {}), ...(account.saved.account || !who.name ? {} : { account: who.name }) });
    } catch { /* asked again after a restart */ }
  }
  /** Notes who each signed-in account is where ros.ai does not know yet, so the Plugins page can show their emails. */
  async learn() { for (const id of SEVERAL) for (const item of this.accounts(id)) if (!item.saved.workspace && signedIn(item.saved)) await this.ask(id, item.key); }
  /** Turns on an app's desktop server: ros.ai connects once to check that it answers and lists its tools. */
  async connectDesktop(id: AppId) {
    if (entry(id).auth !== 'desktop') throw new StoreError(`${appCatalogue[id].name} has no desktop server.`);
    this.forget(id);
    await this.open(id, true);
    this.save(id, { connectedAt: new Date().toISOString() });
    return this.status(id);
  }
  /** Forgets an app's sign-in, or with an account (an app with several), that one account. */
  disconnect(id: AppId, key?: string) {
    const app = entry(id);
    if (app.auth === 'token' || (app.auth === 'built-in' && app.token)) throw new StoreError(`${app.name} uses the token on its Plugins card. Remove the token there to disconnect it.`);
    if (app.auth === 'built-in') throw new StoreError(`${app.name} is connected on its Plugins card. Disconnect it there.`);
    if (key !== undefined && SEVERAL.has(id)) {
      if (!this.account(id, key)) throw new StoreError(`No ${app.name} account called ${label(key)}.`, 404);
      this.forget(id, key);
      this.put(id, key, undefined);
      if (this.more[id]?.default === key) this.saveMore(id, { ...this.more[id]!, default: undefined });
      return this.status(id);
    }
    this.forget(id);
    this.save(id, undefined);
    if (this.more[id]) this.saveMore(id, undefined);
    return this.status(id);
  }
  /** An account of an app with several: make it the default (agents' `notion`, which blocks try first), or name it
   * (an empty name shows the workspace's own name again). */
  update(id: AppId, key: string, change: { default?: boolean; name?: string }) {
    const app = entry(id);
    if (!SEVERAL.has(id)) throw new StoreError(`${app.name} keeps one sign-in.`);
    if (!this.account(id, key)) throw new StoreError(`No ${app.name} account called ${label(key)}.`, 404);
    if (change.name !== undefined) this.put(id, key, { name: label(change.name).trim() || undefined });
    if (change.default) this.saveMore(id, { ...(this.more[id] ?? { accounts: [] }), default: key });
    return this.status(id);
  }
  /** Closes connections of an app, or of one of its accounts. */
  private forget(id: AppId, key?: string) {
    for (const [ref, cached] of this.clients) if (key === undefined ? ref === id || ref.startsWith(`${id}/`) : ref === `${id}/${key}`) { this.clients.delete(ref); void cached.client.close().catch(() => undefined); }
  }
  /** probe: connect although the app is not turned on yet, to turn on a desktop server. account: which of an app's
   * accounts, left out for the default. */
  private async open(id: AppId, probe = false, key?: string): Promise<Connection> {
    const app = entry(id), token = this.token(id), tokenKey = token ? digest(token) : undefined;
    const account = app.auth === 'sign-in' ? this.pick(id, key) : undefined;
    if (key !== undefined && app.auth === 'sign-in' && SEVERAL.has(id) && !account) throw new StoreError(`No ${app.name} account called ${label(key)}. Open Plugins › ${app.name} to see your accounts.`, 404);
    const ref = account && SEVERAL.has(id) ? `${id}/${account.key}` : id;
    const cached = this.clients.get(ref);
    if (cached && cached.key === tokenKey) return cached;
    if (cached) { this.clients.delete(ref); void cached.client.close().catch(() => undefined); }
    if (app.auth === 'built-in') throw new StoreError(`${app.name} has no MCP server.`);
    if (!probe && !(account ? signedIn(account.saved) : this.status(id).connected)) throw new StoreError(app.auth === 'token' ? `${app.name} is not connected. Connect it on the Plugins page.` : account && this.accounts(id).length > 1 ? `${this.named(id, account)} needs you to sign in again. Open Plugins › ${app.name} and sign in again.` : `${app.name} is not connected. Open Plugins and connect it.`, 409);
    const url = new URL(appUrl(id));
    const transport = app.auth === 'sign-in' ? new StreamableHTTPClientTransport(url, { authProvider: this.provider(id, account!.key, account!.saved.redirectUri ?? appRedirectUri(undefined)) })
      : new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
    const client = new Client({ name: 'ros.ai', version: '1' });
    try { await client.connect(transport); }
    catch (error) {
      if (error instanceof StoreError) throw error;
      const reason = label(error instanceof Error ? error.message : String(error)), status = (error as { code?: unknown }).code;
      if (app.auth === 'desktop') throw new StoreError(`${app.name}’s desktop app is not answering at ${url.host}. ${app.start}`, 502);
      if (app.auth === 'token' && (status === 401 || status === 403)) throw new StoreError(`${app.name} did not accept the sign-in or token on its Plugins card. Connect it again there.`, 502);
      throw new StoreError(`Could not reach ${app.name}: ${reason}`, 502);
    }
    const reads = new Set<string>(app.reads);
    const listed = (await client.listTools()).tools;
    const opened: Connection = { client, key: tokenKey, ref, tools: listed.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as Record<string, unknown>, reads: tool.annotations?.readOnlyHint === true || reads.has(tool.name) })) };
    this.clients.set(ref, opened);
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
  /** account: which of an app's accounts, left out for the default. */
  async tools(id: AppId, account?: string): Promise<AppTool[]> {
    const provided = this.builtIn(id);
    if (provided) { const reads = new Set<string>(entry(id).reads); return provided.tools().map(tool => ({ ...tool, reads: tool.reads && reads.has(tool.name) })); }
    return (await this.open(id, false, account)).tools;
  }
  /** Runs one of the app's tools and returns its text. Callers decide first whether it needs approval. account: which
   * of an app's accounts, left out for the default. */
  async call(id: AppId, name: string, args: Record<string, unknown>, signal?: AbortSignal, account?: string) {
    const provided = this.builtIn(id);
    if (provided) {
      if (!provided.tools().some(tool => tool.name === name)) throw new StoreError(`${appCatalogue[id].name} has no tool called ${label(name)}.`);
      return provided.call(name, args, signal);
    }
    let opened = await this.open(id, false, account);
    if (!opened.tools.some(tool => tool.name === name)) throw new StoreError(`${appCatalogue[id].name} has no tool called ${label(name)}.`);
    const run = () => opened.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 });
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(); }
    catch (error) {
      if (signal?.aborted || error instanceof StoreError) throw error;
      // A dropped session: connect once more, then give up.
      if (this.clients.get(opened.ref) === opened) { this.clients.delete(opened.ref); void opened.client.close().catch(() => undefined); }
      opened = await this.open(id, false, account);
      try { result = await run(); } catch (again) { throw new StoreError(`${appCatalogue[id].name}: ${label(again instanceof Error ? again.message : String(again))}`, 502); }
    }
    return { text: textOf(result), isError: result.isError === true };
  }
}

/** The address an app sends the browser back to: this ros.ai's own (loopback) address, registered by ros.ai itself. */
export const appRedirectUri = (host: string | undefined) => `http://${/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host ?? '') ? host : '127.0.0.1:4310'}${CALLBACK}`;
const cookie = (res: Response, value: string, maxAge: number) => res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', path: CALLBACK, maxAge, secure: false });
const nonceOf = (req: Request) => { const item = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`)); const value = item?.slice(COOKIE.length + 1) ?? ''; return /^[\w-]{43}$/u.test(value) ? value : ''; };
const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
/** Where a sign-in window ends: it tells the open ros.ai window over a BroadcastChannel and, once connected, closes itself.
 * note: what the sign-in did besides connecting (it renewed an account), kept open long enough to read. keep: the window
 * stays, and goes where Connect your tools tells it next (followScript). */
function signInPage(id: AppId, error?: string, note?: string, keep = false) {
  const name = appCatalogue[id].name, heading = error ? `Couldn’t connect ${name}` : `${name} connected`;
  const lines = error ? [error, keep ? 'ros.ai shows what to do next.' : 'Close this window and try again in ros.ai.'] : [...(note ? [note] : []), keep ? 'ros.ai goes on by itself.' : 'You can close this window.'];
  const message = JSON.stringify(error ? { failed: id, error } : { connected: id }).replace(/</gu, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)} · ros.ai</title>`
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#171717;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:360px;padding:24px;text-align:center}h1{margin:0 0 6px;font-size:18px;font-weight:600}p{margin:0;color:#4a4a4a}</style></head>'
    + `<body><main><h1>${escapeHtml(heading)}</h1>${lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</main>`
    + `<script>try{new BroadcastChannel('ros-ai-plugins').postMessage(${message})}catch{}${error || keep ? '' : `setTimeout(()=>window.close(),${note ? 4000 : 800})`}</script>${keep ? followScript : ''}</body></html>`;
}
const accountKey = z.string().regex(/^[a-z0-9-]{1,40}$/u);

export function attachAppRoutes(app: Express, apps: RemoteApps) {
  // Accounts kept before ros.ai noted who signed in learn it in the background, for the next time the page asks.
  app.get('/api/apps', (_req, res) => { void apps.learn().catch(() => undefined); res.json({ apps: apps.statuses() }); });
  // window: the sign-in opens in a window of its own (a suggestion in the conversation), so the page and its draft stay put;
  // keep: that window stays open after it, for Connect your tools' next sign-in. add: sign in to another workspace
  // (Notion); account: sign in to that account again.
  app.post('/api/apps/:id/connect', async (req, res) => {
    const id = appIdSchema.parse(req.params.id);
    const { window, keep, add, account } = z.object({ window: z.boolean().optional(), keep: z.boolean().optional(), add: z.boolean().optional(), account: accountKey.optional() }).strict().parse(req.body ?? {});
    if (entry(id).auth === 'desktop') return res.json({ connected: true, app: await apps.connectDesktop(id) });
    // The Mac app (ros.ai/<version> in its user agent) opens the sign-in in the system browser, which never holds the app
    // window's cookie. Its state is still a single-use 256-bit secret only this server and the app's sign-in page see, and
    // only ros.ai's own page can start a sign-in (app.ts refuses cross-site and non-JSON requests).
    const desktop = / ros\.ai\/\S+$/u.test(req.headers['user-agent'] ?? '');
    const started = await apps.begin(id, appRedirectUri(req.headers.host), { window, keep, bound: !desktop, add, account });
    if ('alreadyConnected' in started) return res.json({ connected: true, app: apps.status(id) });
    if (!desktop) cookie(res, started.nonce, SIGN_IN_TTL);
    res.json({ authorizationUrl: started.url });
  });
  app.get(CALLBACK, async (req, res) => {
    const waiting = apps.waiting(req.query.state);
    try {
      const id = await apps.finish(req.query, nonceOf(req)); cookie(res, '', 0);
      if (waiting?.window) res.type('html').send(signInPage(id, undefined, apps.notice(id), waiting.keep)); else res.redirect(303, `/?app=${id}`);
    } catch (error) {
      cookie(res, '', 0);
      const message = error instanceof Error ? error.message : 'The sign-in failed.';
      if (waiting?.window) res.status(400).type('html').send(signInPage(waiting.app, message, undefined, waiting.keep));
      else res.status(400).type('text/plain').send(`${message}\n\nClose this tab and try again from Plugins in ros.ai.`);
    }
  });
  app.delete('/api/apps/:id', (req, res) => res.json(apps.disconnect(appIdSchema.parse(req.params.id))));
  // One account of an app with several: disconnect it, make it the default, or name it.
  app.delete('/api/apps/:id/accounts/:account', (req, res) => res.json(apps.disconnect(appIdSchema.parse(req.params.id), accountKey.parse(req.params.account))));
  app.patch('/api/apps/:id/accounts/:account', (req, res) => {
    const change = z.object({ default: z.literal(true).optional(), name: z.string().max(120).optional() }).strict().refine(value => value.default || value.name !== undefined, 'Say what to change').parse(req.body ?? {});
    res.json(apps.update(appIdSchema.parse(req.params.id), accountKey.parse(req.params.account), change));
  });
  // Read-only tools for ros.ai's own scripts on this computer (the eval runner); writes go through an agent and Accept.
  app.post('/api/apps/:id/read', async (req, res) => {
    const id = appIdSchema.parse(req.params.id);
    const { tool, arguments: args, account } = z.object({ tool: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).default({}), account: accountKey.optional() }).strict().parse(req.body);
    if (!(await apps.tools(id, account)).find(item => item.name === tool)?.reads) throw new StoreError('Only tools that read can run here.', 403);
    res.json(await apps.call(id, tool, args, undefined, account));
  });
}
