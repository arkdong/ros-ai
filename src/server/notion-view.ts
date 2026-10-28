import type { Express } from 'express';
import { z } from 'zod';
import type { NotionAccount, NotionPage, NotionSave, NotionRead, NotionTable, NotionView } from '../shared/types.js';
import type { RemoteApps } from './remote-apps.js';
import type { ProjectCache } from './project-cache.js';
import { notionPage, userIds } from './notion-page.js';
import { Store, StoreError } from './store.js';

/** A Notion block reads live through the person's Notion connection: a database block its rows, a page
 * block its properties and content. ros.ai keeps only where the database or page is (and which rows to
 * show), never a copy of what Notion holds. With several Notion accounts (one workspace each), a block reads
 * with the account that can open its link: the one the person chose for it, else the one that opened it last,
 * else the default and then the others. */

/** A link a browser can open; data source addresses (collection://) are not. */
const view = (url: string) => url.startsWith('https://') ? url : null;
// Database queries are limited on Notion plans below Business, so a read is reused for ten minutes
// unless the person asks for a fresh one.
const ROWS = 200, FRESH_MS = 10 * 60_000, SOURCE_MS = 60 * 60_000, NAMES_MS = 24 * 60 * 60_000, MAX_NAME_LOOKUPS = 12;
const VALUE_MAX = 20_000;
/** The rows a database block turns into page blocks in one go. */
export const MAX_ROW_BLOCKS = 50;
type Json = Record<string, any>;
type Source = { at: number; title: string; source: string; link: string | null; titleColumn: string | null };
/** Notion's answer when an account cannot open a link ("Could not find page with ID: …. Check that you have access and
 * that you're authenticated to the correct workspace."), and an account that needs signing in again: another of the
 * person's accounts may open it. Other errors, such as a filter naming a column the database lacks, are the block's own. */
const elsewhere = (error: unknown) => error instanceof StoreError && (error.status === 409 || /could not find (?:the )?(?:page|database|data source|block|object)|object_not_found|correct workspace|not shared with|(?:do|does|don't|doesn't) (?:not )?have access/iu.test(error.message));
const together = (items: string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** A cell as plain text: Notion's SQL returns lists as JSON text and checkboxes as markers. */
function cell(value: unknown): string {
  if (typeof value === 'string' && /^\[.*\]$/su.test(value)) { try { return cell(JSON.parse(value)); } catch { /* plain text */ } }
  if (Array.isArray(value)) return value.map(cell).filter(Boolean).join(', ');
  if (value === '__YES__') return 'Yes';
  if (value === '__NO__' || value === null || value === undefined) return '';
  const text = String(value);
  // File and relation references are Notion-internal ids, not readable values.
  return /^(rollupResult|file|collection):\/\//u.test(text) || /^[0-9a-f]{8}-[0-9a-f]{4}-/u.test(text) ? '' : text.replace(/<br>/gu, ' ');
}

export class NotionViews {
  /** Data sources by account and link. */
  private readonly sources = new Map<string, Source>();
  private readonly reads = new Map<string, { at: number; read: NotionRead }>();
  /** People's names by account and user. */
  private readonly names = new Map<string, { at: number; name: string | null }>();
  /** The account that opened each link last. */
  private readonly opened = new Map<string, string>();
  constructor(private readonly apps: RemoteApps, private readonly cache?: ProjectCache) {}

  /** account: which of the person's Notion accounts, left out for the default. */
  private async call(tool: string, args: Json, account?: string): Promise<Json> {
    if (!this.apps.connected().includes('notion')) throw new StoreError('Connect Notion on the Plugins page to show this database.', 409);
    const result = await this.apps.call('notion', tool, args, undefined, account);
    if (result.isError) {
      // Notion nests its JSON error in text; keep only the sentence a person can act on.
      const message = result.text.replace(/\\+/gu, '').match(/"message":\s*"(.+?)"\s*[,}]/u)?.[1] ?? result.text.slice(0, 300);
      throw new StoreError(`Notion: ${message}`, 502);
    }
    try { return JSON.parse(result.text) as Json; } catch { return { text: result.text }; }
  }

  /** Reads with each of the person's Notion accounts in turn until one opens the link: first the block's own (`lead`),
   * then the one that opened it last, the default and the others. With one account it reads as it always has. */
  private async across<T>(url: string, lead: string | undefined, run: (account?: string) => Promise<T>): Promise<{ value: T; account?: NotionAccount }> {
    const accounts = this.apps.accountsOf('notion');
    // One account: the read is stamped with it, so a read kept from then is named once another account is added.
    if (accounts.length < 2) return { value: await run(), ...(accounts[0] ? { account: accounts[0] } : {}) };
    const first = lead ?? this.opened.get(url), tried: string[] = [];
    for (const account of [...accounts.filter(item => item.key === first), ...accounts.filter(item => item.key !== first)]) {
      try { const value = await run(account.key); this.remember(url, account.key); return { value, account }; }
      catch (error) { if (!elsewhere(error)) throw error; tried.push(account.name); }
    }
    const out = (this.apps.status('notion').accounts ?? []).filter(item => !item.connected).map(item => item.name);
    throw new StoreError(`None of your Notion accounts can open this link: ros.ai tried ${together(tried)}.${out.length ? ` ${together(out)} ${out.length === 1 ? 'needs' : 'need'} you to sign in again on the Plugins page.` : ' Add the account it is in on the Plugins page.'}`, 404);
  }
  private remember(url: string, account: string) { if (this.opened.size >= 5_000) this.opened.clear(); this.opened.set(url, account); }
  /** A read as the block shows it: the account that read it under the name it has now, while the person has several. */
  private shown(read: NotionRead): NotionRead {
    if (!read.account) return read;
    const accounts = this.apps.accountsOf('notion'), account = accounts.find(item => item.key === read.account!.key);
    if (account && accounts.length > 1) return { ...read, account };
    const { account: _gone, ...rest } = read;
    return rest as NotionRead;
  }

  /** What a link points to: a page (its fresh fetch, to show at once) or a database (its data source, kept an hour). */
  private async classify(url: string, account?: string): Promise<{ kind: 'page'; fetched: Json } | { kind: 'database'; source: Source }> {
    const at = `${account ?? ''}\n${url}`, known = this.sources.get(at);
    if (known && Date.now() - known.at < SOURCE_MS) return { kind: 'database', source: known };
    const fetched = await this.call('notion-fetch', { id: url }, account);
    const text = String(fetched.text ?? ''), type = String(fetched.metadata?.type ?? '');
    if (type === 'page' || (!type && /^[^<]*<page\s/u.test(text))) return { kind: 'page', fetched };
    // The table the database's rows live in; other collection:// addresses in the text are relations.
    const source = text.match(/<data-source url="(collection:\/\/[0-9a-f-]{36})"/u)?.[1] ?? text.match(/CREATE TABLE IF NOT EXISTS "(collection:\/\/[0-9a-f-]{36})"/u)?.[1] ?? text.match(/collection:\/\/[0-9a-f-]{36}/u)?.[0];
    if (!source) throw new StoreError('That Notion link is not a page or a database. Link a page, a database or one of its views.', 400);
    const titleColumn = text.match(/"name":"([^"]+)","type":"title"/u)?.[1] ?? null;
    const entry: Source = { at: Date.now(), title: String(fetched.title ?? 'Notion database'), source, titleColumn, link: typeof fetched.url === 'string' && fetched.url.startsWith('https://') ? fetched.url : view(url) };
    this.sources.set(at, entry);
    return { kind: 'database', source: entry };
  }

  /** People's names for the user addresses a page names, looked up once a day; unknown ones stay unnamed. */
  private async userNames(text: string, account?: string): Promise<(id: string) => string | undefined> {
    const at = (id: string) => `${account ?? ''}\n${id}`;
    const wanted = userIds(text).filter(id => { const known = this.names.get(at(id)); return !known || Date.now() - known.at > NAMES_MS; }).slice(0, MAX_NAME_LOOKUPS);
    await Promise.all(wanted.map(async id => {
      try { const result = await this.call('notion-get-users', { user_id: id }, account); const name = (Array.isArray(result.results) ? result.results : []).find((user: Json) => user?.id === id)?.name; this.names.set(at(id), { at: Date.now(), name: typeof name === 'string' && name.trim() ? name.trim() : null }); }
      catch { this.names.set(at(id), { at: Date.now(), name: null }); }
    }));
    return id => this.names.get(at(id))?.name ?? undefined;
  }

  /** With a project, the last read is also kept in its folder's cache, so a restart still shows it. */
  async read(view: NotionView, refresh = false, projectId?: string): Promise<NotionRead> {
    const key = JSON.stringify(view);
    let cached = this.reads.get(key);
    if (!cached && projectId) {
      const saved = this.cache?.read<NotionRead>(projectId, 'notion', key);
      if (saved) this.reads.set(key, cached = { at: Date.parse(saved.fetchedAt) || 0, read: saved });
    }
    if (cached && !refresh && Date.now() - cached.at < FRESH_MS) return this.shown(cached.read);
    try {
      const read = await this.fresh(view, cached?.read.account?.key);
      this.reads.set(key, { at: Date.now(), read });
      if (projectId) this.cache?.write(projectId, 'notion', key, read);
      return this.shown(read);
    } catch (error) {
      // Keep showing the last read rather than nothing, and say why it is not newer.
      if (!cached) throw error;
      return this.shown({ ...cached.read, notice: `Notion did not answer a new read (${error instanceof Error ? error.message.replace(/^Notion: /u, '') : 'unknown error'}). Showing the earlier read.` });
    }
  }

  /** hint: the account that read the block last time. */
  private async fresh(view: NotionView, hint?: string): Promise<NotionRead> {
    const { value, account } = await this.across(view.url, view.account ?? hint, async (key): Promise<NotionRead> => {
      if (view.kind === 'page') return this.page(view.url, await this.call('notion-fetch', { id: view.url }, key), key);
      const found = await this.classify(view.url, key);
      if (found.kind === 'page') {
        if (view.kind === 'database') throw new StoreError('That Notion link is a page, not a database.', 400);
        return this.page(view.url, found.fetched, key);
      }
      return this.table(view, found.source, key);
    });
    // A database's rows live in its workspace, so the blocks made from them read with the same account first.
    if (account && value.kind === 'database') for (const row of value.rows) if (row.url) this.remember(row.url, account.key);
    return account ? { ...value, account } : value;
  }

  private async page(url: string, fetched: Json, account?: string): Promise<NotionPage> {
    if (String(fetched.metadata?.type ?? 'page') !== 'page') throw new StoreError('That Notion link is not a page.', 400);
    return notionPage(fetched, url, await this.userNames(String(fetched.text ?? ''), account));
  }

  private async table(view: NotionView, { title, source, link, titleColumn }: Source, account?: string): Promise<NotionTable> {
    const quote = (name: string) => `"${name.replace(/"/gu, '""')}"`;
    // The title column always comes along, so each row can become a page block with its own title.
    const extra = view.columns?.length && titleColumn && !view.columns.includes(titleColumn) ? [titleColumn] : [];
    const columns = view.columns?.length ? [...view.columns, ...extra].map(quote).join(', ') : '*';
    const filter = view.filter?.replace(/;/gu, ' ').trim();
    const query = `SELECT ${columns}${view.columns?.length ? ', url' : ''} FROM "${source}"${filter ? ` WHERE ${filter}` : ''} LIMIT ${ROWS + 1}`;
    const result = await this.call('notion-query-data-sources', { data: { mode: 'sql', data_source_urls: [source], query, params: [] } }, account);
    const raw = (Array.isArray(result.results) ? result.results : []) as Json[];
    // Without chosen columns: the title first, then short, mostly filled values; links, contact
    // details and long text such as answers last. The card shows the first few.
    const rank = (name: string) => {
      if (name === titleColumn) return -1;
      const values = raw.map(row => cell(row[name])), filled = values.filter(Boolean);
      const fill = values.length ? filled.length / values.length : 0;
      const awkward = filled.some(value => value.length > 80 || /^https?:\/\/|@/u.test(value)) || /^date:.*:(end|is_datetime)$/u.test(name);
      return (awkward ? 2 : 0) + (1 - fill);
    };
    const names = view.columns?.length ? view.columns : [...new Set(raw.flatMap(row => Object.keys(row)))]
      .filter(name => !['url', 'id', 'createdTime'].includes(name))
      .map(name => ({ name, rank: rank(name) })).sort((a, b) => a.rank - b.rank).map(item => item.name);
    const rows = raw.slice(0, ROWS).map(row => Object.fromEntries([...[...names, ...extra].map(name => [name, cell(row[name])]), ['url', typeof row.url === 'string' ? row.url : '']]));
    return { kind: 'database', title, url: view.url, link, columns: names, titleColumn, rows, truncated: raw.length > ROWS || result.has_more === true, fetchedAt: new Date().toISOString() };
  }
  /** The changes a person saves to a page, sent to Notion in one go (text, then fields) with the account that read it,
   * then the page read again so the block shows what Notion holds. Nothing is written until the person presses Save. */
  async save(view: NotionView, changes: NotionSave, projectId?: string): Promise<NotionPage> {
    const current = await this.read(view, false, projectId);
    if (current.kind !== 'page') throw new StoreError('Only a page block can be edited here.', 400);
    const page = current, tasks: Json[] = [], account = current.account?.key;
    const text = (changes.text ?? []).filter(change => change.old !== change.new);
    const gone = text.find(change => !page.units.some(unit => unit.source === change.old));
    if (gone) throw new StoreError('Some of that text changed in Notion since it was read. Read the page again, then edit it.', 409);
    if (text.length) {
      const result = await this.call('notion-update-page', { page_id: view.url, command: 'update_content', content_updates: text.map(change => ({ old_str: change.old, new_str: change.new })), allow_async: false }, account);
      const warnings = Array.isArray(result.warnings) ? result.warnings.map(String).join(' ') : typeof result.warnings === 'string' ? result.warnings : '';
      if (/no match|not found|did not match|0 match/iu.test(warnings)) throw new StoreError('Notion could not find some of that text any more. Read the page again, then edit it.', 409);
      tasks.push(result);
    }
    if (changes.append?.trim()) tasks.push(await this.call('notion-update-page', { page_id: view.url, command: 'insert_content', content: changes.append.trim(), position: { type: 'end' }, allow_async: false }, account));
    const properties: Json = {};
    if (changes.title !== undefined) properties[page.titleProperty ? key(page.titleProperty) : 'title'] = changes.title.trim() || 'Untitled';
    for (const change of changes.properties ?? []) {
      const property = page.properties.find(item => item.name === change.name);
      if (!property?.editable || property.type === 'title') throw new StoreError(`${change.name} is set in Notion itself.`, 400);
      const value = change.value;
      const empty = value === null || value === '' || (Array.isArray(value) && !value.length);
      if (property.type === 'number' && !empty && !Number.isFinite(Number(value))) throw new StoreError(`${change.name} takes a number.`, 400);
      if (property.type === 'date') Object.assign(properties, { [`date:${change.name}:start`]: empty ? null : String(value).slice(0, 10), [`date:${change.name}:end`]: change.end ? String(change.end).slice(0, 10) : null, [`date:${change.name}:is_datetime`]: 0 });
      else properties[key(change.name)] = property.type === 'checkbox' ? (value === true || value === 'true' || value === 'Yes' ? '__YES__' : '__NO__')
        : empty ? null : property.type === 'number' ? Number(value) : property.type === 'multi_select' ? (Array.isArray(value) ? value : [String(value)]).map(String)
        : Array.isArray(value) ? value.join(', ') : String(value);
    }
    if (Object.keys(properties).length) tasks.push(await this.call('notion-update-page', { page_id: view.url, command: 'update_properties', properties, allow_async: false }, account));
    for (const result of tasks) if (result.async_task) await this.settle(result.async_task, account);
    return (await this.read(view, true, projectId)) as NotionPage;
  }

  /** Waits for a change Notion queued, so the read that follows shows it. */
  private async settle(task: Json, account?: string) {
    const id = typeof task === 'string' ? task : task?.id ?? task?.task_id;
    if (!id) return;
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await this.call('notion-get-async-task', { task_id: id }, account).catch(() => null);
      const status = String(state?.status ?? state?.state ?? '');
      if (/succeeded|completed|done/iu.test(status)) return;
      if (/failed|error/iu.test(status)) throw new StoreError(`Notion did not save the change: ${String(state?.error ?? state?.message ?? status).slice(0, 200)}`, 502);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

/** A property name as Notion's update wants it: "id" and "url" need a prefix. */
const key = (name: string) => /^(id|url)$/iu.test(name) ? `userDefined:${name}` : name;

export function attachNotionViewRoutes(app: Express, store: Store, views: NotionViews) {
  app.get('/api/projects/:id/nodes/:nodeId/notion', async (req, res) => {
    const node = store.getProject(String(req.params.id)).canvas.nodes.find(item => item.id === req.params.nodeId);
    if (!node?.notion) throw new StoreError('This block shows nothing from Notion.', 404);
    res.json(await views.read(node.notion, req.query.refresh === '1', String(req.params.id)));
  });
  // A person's saved changes to a page block: the title, fields, lines of text and text added at the end.
  app.post('/api/projects/:id/nodes/:nodeId/notion/save', async (req, res) => {
    const node = store.getProject(String(req.params.id)).canvas.nodes.find(item => item.id === req.params.nodeId);
    if (!node?.notion) throw new StoreError('This block shows nothing from Notion.', 404);
    const changes = z.object({
      title: z.string().max(2000).optional(),
      properties: z.array(z.object({ name: z.string().min(1).max(200), value: z.union([z.string().max(VALUE_MAX), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(100), z.null()]), end: z.string().max(40).nullable().optional() }).strict()).max(100).optional(),
      text: z.array(z.object({ old: z.string().min(1).max(VALUE_MAX), new: z.string().max(VALUE_MAX) }).strict()).max(500).optional(),
      append: z.string().max(VALUE_MAX).optional(),
    }).strict().parse(req.body);
    res.json(await views.save(node.notion, changes, String(req.params.id)));
  });
  // Checks a link before a person adds it as a block: the same read, without a block yet.
  app.post('/api/notion/views/preview', async (req, res) => {
    const view = z.object({ url: z.string().trim().url().max(500), filter: z.string().trim().max(1000).optional(), columns: z.array(z.string().trim().min(1).max(100)).max(30).optional(), kind: z.enum(['database', 'page']).optional(), account: z.string().regex(/^[a-z0-9-]{1,40}$/u).optional() }).strict().parse(req.body);
    res.json(await views.read(view));
  });
}
