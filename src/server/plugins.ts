import { constants, existsSync, fstatSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { StoreError } from './store.js';
import { notionBase } from './notion.js';
import type { PluginStatus, TokenPluginId } from '../shared/plugins.js';

const ids = ['zotero', 'slack', 'notion', 'github'] as const satisfies readonly TokenPluginId[];
const idSchema = z.enum(ids);
const tokenSchema = z.string().trim().min(8).max(4096).refine(value => !/\s|[\x00-\x1f\x7f]/.test(value), 'Enter a single token without spaces.');
const savedSchema = z.object({ version: z.literal(1), tokens: z.object({ zotero: tokenSchema.optional(), slack: tokenSchema.optional(), notion: tokenSchema.optional(), github: tokenSchema.optional() }).strict() }).strict();
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
  constructor(dataDir: string, private readonly fetcher: typeof fetch = fetch) {
    this.file = join(dataDir, 'plugin-tokens.json');
    if (!existsSync(this.file)) return;
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 40000 || (info.mode & 0o077) !== 0) throw new Error('Invalid private plugin file.');
      this.tokens = savedSchema.parse(JSON.parse(readFileSync(fd, 'utf8'))).tokens;
    } catch { throw new Error('Could not read private plugin tokens. Ensure the file is valid and readable only by its owner.'); }
    finally { closeSync(fd); }
  }
  private persist(tokens: Partial<Record<TokenPluginId, string>>) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, tokens }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new StoreError('Could not save the plugin token.', 500);
    }
    this.tokens = tokens;
  }
  status(id: TokenPluginId): PluginStatus {
    return { id, configured: Boolean(this.token(id)), ...(this.checks.get(id) ?? { checkedAt: null, verified: null, checkMessage: null }) };
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
    const tokens = { ...this.tokens }; delete tokens[id];
    this.persist(tokens); this.checks.delete(id);
    return this.status(id);
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

export function attachPluginRoutes(app: Express, plugins: PluginTokens) {
  app.get('/api/plugins', (_req, res) => res.json({ plugins: plugins.statuses() }));
  app.put('/api/plugins/:id', (req, res) => res.json(plugins.save(idSchema.parse(req.params.id), req.body)));
  app.delete('/api/plugins/:id', (req, res) => res.json(plugins.disconnect(idSchema.parse(req.params.id))));
  app.post('/api/plugins/:id/check', async (req, res) => res.json(await plugins.check(idSchema.parse(req.params.id))));
}
