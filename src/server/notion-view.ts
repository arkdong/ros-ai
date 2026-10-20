import type { Express } from 'express';
import { z } from 'zod';
import type { NotionTable, NotionView } from '../shared/types.js';
import type { RemoteApps } from './remote-apps.js';
import type { ProjectCache } from './project-cache.js';
import { Store, StoreError } from './store.js';

/** A Notion database block reads its rows live through the person's Notion connection; ros.ai keeps
 * only where the database is and which rows to show, never a copy of the rows. */

/** A link a browser can open; data source addresses (collection://) are not. */
const view = (url: string) => url.startsWith('https://') ? url : null;
// Database queries are limited on Notion plans below Business, so a read is reused for ten minutes
// unless the person asks for a fresh one.
const ROWS = 200, FRESH_MS = 10 * 60_000, SOURCE_MS = 60 * 60_000;
type Json = Record<string, any>;

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
  private readonly sources = new Map<string, { at: number; title: string; source: string; link: string | null; titleColumn: string | null }>();
  private readonly tables = new Map<string, { at: number; table: NotionTable }>();
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

  /** The database's title and the data source its rows live in, from its link. */
  private async source(url: string) {
    const known = this.sources.get(url);
    if (known && Date.now() - known.at < SOURCE_MS) return known;
    const fetched = await this.call('notion-fetch', { id: url });
    const text = String(fetched.text ?? '');
    // The table the database's rows live in; other collection:// addresses in the text are relations.
    const source = text.match(/CREATE TABLE IF NOT EXISTS "(collection:\/\/[0-9a-f-]{36})"/u)?.[1] ?? text.match(/<data-source url="(collection:\/\/[0-9a-f-]{36})"/u)?.[1] ?? text.match(/collection:\/\/[0-9a-f-]{36}/u)?.[0];
    if (!source) throw new StoreError('That Notion link is not a database. Link the database itself or one of its views.', 400);
    const titleColumn = text.match(/"name":"([^"]+)","type":"title"/u)?.[1] ?? null;
    const entry = { at: Date.now(), title: String(fetched.title ?? 'Notion database'), source, titleColumn, link: typeof fetched.url === 'string' && fetched.url.startsWith('https://') ? fetched.url : view(url) };
    this.sources.set(url, entry);
    return entry;
  }

  /** With a project, the last read is also kept in its folder's cache, so a restart still shows it. */
  async read(view: NotionView, refresh = false, projectId?: string): Promise<NotionTable> {
    const key = JSON.stringify(view);
    let cached = this.tables.get(key);
    if (!cached && projectId) {
      const saved = this.cache?.read<NotionTable>(projectId, 'notion', key);
      if (saved) this.tables.set(key, cached = { at: Date.parse(saved.fetchedAt) || 0, table: saved });
    }
    if (cached && !refresh && Date.now() - cached.at < FRESH_MS) return cached.table;
    try {
      const table = await this.fresh(view, key);
      if (projectId) this.cache?.write(projectId, 'notion', key, table);
      return table;
    } catch (error) {
      // Keep showing the last read rather than nothing, and say why it is not newer.
      if (!cached) throw error;
      return { ...cached.table, notice: `Notion did not answer a new read (${error instanceof Error ? error.message.replace(/^Notion: /u, '') : 'unknown error'}). Showing the earlier read.` };
    }
  }

  private async fresh(view: NotionView, key: string): Promise<NotionTable> {
    const { title, source, link, titleColumn } = await this.source(view.url);
    const columns = view.columns?.length ? view.columns.map(name => `"${name.replace(/"/gu, '""')}"`).join(', ') : '*';
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
    const rows = raw.slice(0, ROWS).map(row => Object.fromEntries([...names.map(name => [name, cell(row[name])]), ['url', typeof row.url === 'string' ? row.url : '']]));
    const table: NotionTable = { title, url: view.url, link, columns: names, rows, truncated: raw.length > ROWS || result.has_more === true, fetchedAt: new Date().toISOString() };
    this.tables.set(key, { at: Date.now(), table });
    return table;
  }
}

export function attachNotionViewRoutes(app: Express, store: Store, views: NotionViews) {
  app.get('/api/projects/:id/nodes/:nodeId/notion', async (req, res) => {
    const node = store.getProject(String(req.params.id)).canvas.nodes.find(item => item.id === req.params.nodeId);
    if (!node?.notion) throw new StoreError('This block shows no Notion database.', 404);
    res.json(await views.read(node.notion, req.query.refresh === '1', String(req.params.id)));
  });
  // Checks a link before a person adds it as a block: the same read, without a block yet.
  app.post('/api/notion/views/preview', async (req, res) => {
    const view = z.object({ url: z.string().trim().url().max(500), filter: z.string().trim().max(1000).optional(), columns: z.array(z.string().trim().min(1).max(100)).max(30).optional() }).strict().parse(req.body);
    res.json(await views.read(view));
  });
}
