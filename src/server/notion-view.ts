import type { Express } from 'express';
import { z } from 'zod';
import type { NotionPage, NotionRead, NotionTable, NotionView } from '../shared/types.js';
import type { RemoteApps } from './remote-apps.js';
import type { ProjectCache } from './project-cache.js';
import { notionPage, userIds } from './notion-page.js';
import { Store, StoreError } from './store.js';

/** A Notion block reads live through the person's Notion connection: a database block its rows, a page
 * block its properties and content. ros.ai keeps only where the database or page is (and which rows to
 * show), never a copy of what Notion holds. */

/** A link a browser can open; data source addresses (collection://) are not. */
const view = (url: string) => url.startsWith('https://') ? url : null;
// Database queries are limited on Notion plans below Business, so a read is reused for ten minutes
// unless the person asks for a fresh one.
const ROWS = 200, FRESH_MS = 10 * 60_000, SOURCE_MS = 60 * 60_000, NAMES_MS = 24 * 60 * 60_000, MAX_NAME_LOOKUPS = 12;
/** The rows a database block turns into page blocks in one go. */
export const MAX_ROW_BLOCKS = 50;
type Json = Record<string, any>;
type Source = { at: number; title: string; source: string; link: string | null; titleColumn: string | null };

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
  private readonly sources = new Map<string, Source>();
  private readonly reads = new Map<string, { at: number; read: NotionRead }>();
  private readonly names = new Map<string, { at: number; name: string | null }>();
  constructor(private readonly apps: RemoteApps, private readonly cache?: ProjectCache) {}

  private async call(tool: string, args: Json, signal?: AbortSignal): Promise<Json> {
    if (!this.apps.connected().includes('notion')) throw new StoreError('Connect Notion on the Apps page to show this database.', 409);
    const result = await this.apps.call('notion', tool, args, signal);
    if (result.isError) {
      // Notion nests its JSON error in text; keep only the sentence a person can act on.
      const message = result.text.replace(/\\+/gu, '').match(/"message":\s*"(.+?)"\s*[,}]/u)?.[1] ?? result.text.slice(0, 300);
      throw new StoreError(`Notion: ${message}`, 502);
    }
    try { return JSON.parse(result.text) as Json; } catch { return { text: result.text }; }
  }

  /** What a link points to: a page (its fresh fetch, to show at once) or a database (its data source, kept an hour). */
  private async classify(url: string): Promise<{ kind: 'page'; fetched: Json } | { kind: 'database'; source: Source }> {
    const known = this.sources.get(url);
    if (known && Date.now() - known.at < SOURCE_MS) return { kind: 'database', source: known };
    const fetched = await this.call('notion-fetch', { id: url });
    const text = String(fetched.text ?? ''), type = String(fetched.metadata?.type ?? '');
    if (type === 'page' || (!type && /^[^<]*<page\s/u.test(text))) return { kind: 'page', fetched };
    // The table the database's rows live in; other collection:// addresses in the text are relations.
    const source = text.match(/<data-source url="(collection:\/\/[0-9a-f-]{36})"/u)?.[1] ?? text.match(/CREATE TABLE IF NOT EXISTS "(collection:\/\/[0-9a-f-]{36})"/u)?.[1] ?? text.match(/collection:\/\/[0-9a-f-]{36}/u)?.[0];
    if (!source) throw new StoreError('That Notion link is not a page or a database. Link a page, a database or one of its views.', 400);
    const titleColumn = text.match(/"name":"([^"]+)","type":"title"/u)?.[1] ?? null;
    const entry: Source = { at: Date.now(), title: String(fetched.title ?? 'Notion database'), source, titleColumn, link: typeof fetched.url === 'string' && fetched.url.startsWith('https://') ? fetched.url : view(url) };
    this.sources.set(url, entry);
    return { kind: 'database', source: entry };
  }

  /** People's names for the user addresses a page names, looked up once a day; unknown ones stay unnamed. */
  private async userNames(text: string): Promise<(id: string) => string | undefined> {
    const wanted = userIds(text).filter(id => { const known = this.names.get(id); return !known || Date.now() - known.at > NAMES_MS; }).slice(0, MAX_NAME_LOOKUPS);
    await Promise.all(wanted.map(async id => {
      try { const result = await this.call('notion-get-users', { user_id: id }); const name = (Array.isArray(result.results) ? result.results : []).find((user: Json) => user?.id === id)?.name; this.names.set(id, { at: Date.now(), name: typeof name === 'string' && name.trim() ? name.trim() : null }); }
      catch { this.names.set(id, { at: Date.now(), name: null }); }
    }));
    return id => this.names.get(id)?.name ?? undefined;
  }

  /** With a project, the last read is also kept in its folder's cache, so a restart still shows it. */
  async read(view: NotionView, refresh = false, projectId?: string): Promise<NotionRead> {
    const key = JSON.stringify(view);
    let cached = this.reads.get(key);
    if (!cached && projectId) {
      const saved = this.cache?.read<NotionRead>(projectId, 'notion', key);
      if (saved) this.reads.set(key, cached = { at: Date.parse(saved.fetchedAt) || 0, read: saved });
    }
    if (cached && !refresh && Date.now() - cached.at < FRESH_MS) return cached.read;
    try {
      const read = await this.fresh(view);
      this.reads.set(key, { at: Date.now(), read });
      if (projectId) this.cache?.write(projectId, 'notion', key, read);
      return read;
    } catch (error) {
      // Keep showing the last read rather than nothing, and say why it is not newer.
      if (!cached) throw error;
      return { ...cached.read, notice: `Notion did not answer a new read (${error instanceof Error ? error.message.replace(/^Notion: /u, '') : 'unknown error'}). Showing the earlier read.` };
    }
  }

  private async fresh(view: NotionView): Promise<NotionRead> {
    if (view.kind === 'page') return this.page(view.url, await this.call('notion-fetch', { id: view.url }));
    const found = await this.classify(view.url);
    if (found.kind === 'page') {
      if (view.kind === 'database') throw new StoreError('That Notion link is a page, not a database.', 400);
      return this.page(view.url, found.fetched);
    }
    return this.table(view, found.source);
  }

  private async page(url: string, fetched: Json): Promise<NotionPage> {
    if (String(fetched.metadata?.type ?? 'page') !== 'page') throw new StoreError('That Notion link is not a page.', 400);
    return notionPage(fetched, url, await this.userNames(String(fetched.text ?? '')));
  }

  private async table(view: NotionView, { title, source, link, titleColumn }: Source): Promise<NotionTable> {
    const quote = (name: string) => `"${name.replace(/"/gu, '""')}"`;
    // The title column always comes along, so each row can become a page block with its own title.
    const extra = view.columns?.length && titleColumn && !view.columns.includes(titleColumn) ? [titleColumn] : [];
    const columns = view.columns?.length ? [...view.columns, ...extra].map(quote).join(', ') : '*';
    const filter = view.filter?.replace(/;/gu, ' ').trim();
    const query = `SELECT ${columns}${view.columns?.length ? ', url' : ''} FROM "${source}"${filter ? ` WHERE ${filter}` : ''} LIMIT ${ROWS + 1}`;
    const result = await this.call('notion-query-data-sources', { data: { mode: 'sql', data_source_urls: [source], query, params: [] } });
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
}

export function attachNotionViewRoutes(app: Express, store: Store, views: NotionViews) {
  app.get('/api/projects/:id/nodes/:nodeId/notion', async (req, res) => {
    const node = store.getProject(String(req.params.id)).canvas.nodes.find(item => item.id === req.params.nodeId);
    if (!node?.notion) throw new StoreError('This block shows nothing from Notion.', 404);
    res.json(await views.read(node.notion, req.query.refresh === '1', String(req.params.id)));
  });
  // Checks a link before a person adds it as a block: the same read, without a block yet.
  app.post('/api/notion/views/preview', async (req, res) => {
    const view = z.object({ url: z.string().trim().url().max(500), filter: z.string().trim().max(1000).optional(), columns: z.array(z.string().trim().min(1).max(100)).max(30).optional(), kind: z.enum(['database', 'page']).optional() }).strict().parse(req.body);
    res.json(await views.read(view));
  });
}
