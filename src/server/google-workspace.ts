import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { parseCsv, tableCsv } from '../shared/data-view.js';
import { cardWidth } from '../shared/card-size.js';
import { LAYOUT_GAP } from '../shared/layout.js';
import type { Artifact, CanvasNode, GoogleDoc, GoogleRead, GoogleSheet, GoogleView, Mutation, Run } from '../shared/types.js';
import { googleApiDisabled, GoogleApiError, type GoogleDriveConnection } from './google-drive.js';
import type { ProjectCache } from './project-cache.js';
import type { AppTool, BuiltInApp } from './remote-apps.js';
import { StoreError, type Store } from './store.js';

/** Google Sheets and Docs, read live through the Google Drive sign-in, which is read-only. A Sheet block shows one tab's
 * first rows and a Doc block the doc's text; ros.ai keeps only which file (and tab) a block shows, and the last read in
 * the project folder's cache. Agents search and read Drive through the same sign-in (GoogleDriveApp below). */

const SHEET = 'application/vnd.google-apps.spreadsheet', DOC = 'application/vnd.google-apps.document';
/** What a block shows; the block view scrolls through all of it. */
const ROWS = 200, COLUMNS = 50, CELL = 2_000, DOC_CHARACTERS = 200_000;
/** A read is reused for a minute unless the person asks for a fresh one; an unchanged file is not read again. */
const FRESH_MS = 60_000;
/** A tab copied into a Data block: as many rows and bytes as a Data block holds (as a SQL result). */
const COPY_ROWS = 200_000, COPY_BYTES = 5_000_000;
const fileIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/u);
type Meta = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string };
type Tab = { id: number; title: string; rows: number; columns: number };
const metaSchema = z.object({ id: fileIdSchema, name: z.string().max(1000), mimeType: z.string().max(200), modifiedTime: z.string().max(100).optional(), webViewLink: z.string().max(2000).optional() }).passthrough();
const kindOf = (mimeType: string) => mimeType === SHEET ? 'sheet' as const : mimeType === DOC ? 'doc' as const : null;
const linkOf = (meta: Meta) => meta.webViewLink?.startsWith('https://') ? meta.webViewLink : `https://docs.google.com/${meta.mimeType === SHEET ? 'spreadsheets' : 'document'}/d/${meta.id}/edit`;
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '').slice(0, max);
/** A tab's name as A1 notation wants it, and a column's letters. */
const tabRange = (title: string) => `'${title.replace(/'/gu, "''")}'`;
const letters = (index: number) => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };
const rangePath = (fileId: string, range: string) => `spreadsheets/${fileId}/values/${encodeURIComponent(range)}`;
/** The most cells in a row (a loop: a tab copied whole can have 200,000 rows, too many to spread into Math.max). */
const widest = (rows: unknown[][]) => rows.reduce<number>((most, row) => Math.max(most, Array.isArray(row) ? row.length : 0), 0);

/** A Google Docs, Sheets or Drive address, or a bare file ID: the file, its kind when the address says, and a sheet's tab (gid). */
export function googleLink(value: string): { fileId: string; kind?: 'sheet' | 'doc'; gid?: number } | null {
  const text = value.trim();
  if (/^[a-zA-Z0-9_-]{20,200}$/u.test(text)) return { fileId: text };
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || !['docs.google.com', 'drive.google.com'].includes(url.hostname)) return null;
  const path = /^\/(?:a\/[^/]+\/)?(spreadsheets|document|file)\/d\/([a-zA-Z0-9_-]{10,200})/u.exec(url.pathname);
  const id = path?.[2] ?? (url.pathname === '/open' ? url.searchParams.get('id') : null);
  if (!id || !fileIdSchema.safeParse(id).success) return null;
  const gid = Number((/gid=(\d+)/u.exec(url.hash) ?? /gid=(\d+)/u.exec(url.search))?.[1] ?? Number.NaN);
  return { fileId: id, ...(path?.[1] === 'spreadsheets' ? { kind: 'sheet' as const } : path?.[1] === 'document' ? { kind: 'doc' as const } : {}), ...(Number.isInteger(gid) ? { gid } : {}) };
}

/** A doc's Markdown without the images Google embeds in it as data (often megabytes); each image becomes a mark. */
export function docText(markdown: string) {
  return markdown
    .replace(/^\[[^\]\n]{1,80}\]:\s*<?data:image\/[^\s>]*>?[ \t]*$/gmu, '')
    .replace(/!\[([^\]\n]*)\]\((?:<)?data:image\/[^)\s>]*(?:>)?\)/gu, (_, alt: string) => alt ? `*(image: ${alt})*` : '*(image)*')
    .replace(/!\[([^\]\n]*)\]\[[^\]\n]{1,80}\]/gu, (_, alt: string) => alt ? `*(image: ${alt})*` : '*(image)*')
    .replace(/\n{3,}/gu, '\n\n').trim();
}

/** Rows as a table: the first row names the columns (a column without a name is called by its letters). */
function table(values: unknown[][], width: number) {
  const columns = Array.from({ length: width }, (_, index) => clean(values[0]?.[index], 200).trim() || letters(index));
  const rows = values.slice(1).map(row => Array.from({ length: width }, (_, index) => clean(row[index], CELL)));
  return { columns, rows };
}

export class GoogleWorkspace {
  private readonly reads = new Map<string, { at: number; read: GoogleRead }>();
  constructor(private readonly drive: GoogleDriveConnection, private readonly cache?: ProjectCache) {}
  get connected() { return this.drive.status().connected; }

  private async json<T>(api: 'drive' | 'sheets', path: string, query: Record<string, string | string[]>, signal?: AbortSignal, maximum = 4_000_000): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const item of [value].flat()) params.append(key, item);
    const data = await this.drive.read(api, path, params, maximum, signal);
    try { return JSON.parse(new TextDecoder().decode(data)) as T; } catch { throw new StoreError('Google returned an unreadable answer.', 502); }
  }
  async meta(fileId: string, signal?: AbortSignal): Promise<Meta> {
    return metaSchema.parse(await this.json('drive', `files/${fileIdSchema.parse(fileId)}`, { fields: 'id,name,mimeType,modifiedTime,webViewLink', supportsAllDrives: 'true' }, signal)) as Meta;
  }
  /** The file a link or ID names, checked to be the kind wanted. */
  async file(supplied: string, kind: 'sheet' | 'doc', signal?: AbortSignal) {
    const found = googleLink(supplied);
    if (!found) throw new StoreError('Give a Google Sheets or Docs link, or a file ID from search_files.');
    const meta = await this.meta(found.fileId, signal);
    if (kindOf(meta.mimeType) !== kind) throw new StoreError(`${clean(meta.name, 200)} is not a Google ${kind === 'sheet' ? 'Sheet' : 'Doc'}.`);
    return { meta, gid: found.gid };
  }
  /** A spreadsheet's tabs that hold cells (not charts). */
  async tabs(fileId: string, signal?: AbortSignal): Promise<Tab[]> {
    const body = await this.json<{ sheets?: { properties?: { sheetId?: number; title?: string; sheetType?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[] }>('sheets', `spreadsheets/${fileId}`, { fields: 'sheets.properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount))' }, signal);
    return (body.sheets ?? []).flatMap(({ properties: item }) => item && typeof item.title === 'string' && (item.sheetType ?? 'GRID') === 'GRID' ? [{ id: Number(item.sheetId ?? 0), title: clean(item.title, 200), rows: Number(item.gridProperties?.rowCount ?? 0), columns: Number(item.gridProperties?.columnCount ?? 0) }] : []);
  }
  /** One range of a tab, as Google shows the cells (or, raw, with numbers unformatted for analysis). */
  private async values(fileId: string, range: string, signal?: AbortSignal, raw = false, maximum = 4_000_000) {
    const body = await this.json<{ values?: unknown[][] }>('sheets', rangePath(fileId, range), { majorDimension: 'ROWS', valueRenderOption: raw ? 'UNFORMATTED_VALUE' : 'FORMATTED_VALUE', ...(raw ? { dateTimeRenderOption: 'FORMATTED_STRING' } : {}) }, signal, maximum);
    return Array.isArray(body.values) ? body.values.map(row => Array.isArray(row) ? row : []) : [];
  }
  /** A sheet's first tab through Drive's CSV export, for a Google Cloud project without the Sheets API turned on. */
  private async exported(fileId: string, signal?: AbortSignal) {
    const data = await this.drive.read('drive', `files/${fileId}/export`, new URLSearchParams({ mimeType: 'text/csv' }), 10_000_000, signal);
    return parseCsv(new TextDecoder().decode(data));
  }
  private async sheet(view: GoogleView, meta: Meta, signal?: AbortSignal): Promise<GoogleSheet> {
    const base = { kind: 'sheet' as const, title: clean(meta.name, 200), fileId: meta.id, link: linkOf(meta), ...(meta.modifiedTime ? { modifiedAt: meta.modifiedTime } : {}), fetchedAt: new Date().toISOString() };
    let tabs: Tab[];
    try { tabs = await this.tabs(meta.id, signal); }
    catch (error) {
      if (!googleApiDisabled(error)) throw error;
      const values = (await this.exported(meta.id, signal)).slice(0, ROWS + 2), width = Math.min(COLUMNS, widest(values));
      return { ...base, sheet: view.sheet ?? '', sheets: [], ...table(values.slice(0, ROWS + 1), width), truncated: values.length > ROWS + 1, notice: 'Showing the first tab. Turn on the Google Sheets API in the Google Cloud project behind ros.ai’s Google sign-in to choose another.' };
    }
    if (!tabs.length) throw new StoreError('This spreadsheet has no tab with cells.', 404);
    const chosen = tabs.find(item => item.title === view.sheet) ?? tabs[0];
    // A row more than shown says whether there are more; the first row names the columns.
    const values = await this.values(meta.id, `${tabRange(chosen.title)}!1:${ROWS + 2}`, signal), width = widest(values);
    return { ...base, sheet: chosen.title, sheets: tabs.map(item => item.title), ...table(values.slice(0, ROWS + 1), Math.min(COLUMNS, width)), truncated: values.length > ROWS + 1 || width > COLUMNS,
      ...(view.sheet && view.sheet !== chosen.title ? { notice: `The tab “${clean(view.sheet, 80)}” is gone; showing “${chosen.title}”.` } : {}) };
  }
  /** A doc's text as Markdown, or as plain text where Google does not export Markdown. */
  async docMarkdown(fileId: string, signal?: AbortSignal) {
    const read = (mimeType: string) => this.drive.read('drive', `files/${fileId}/export`, new URLSearchParams({ mimeType }), 10_000_000, signal);
    let data: Uint8Array;
    try { data = await read('text/markdown'); }
    catch (error) { if (!(error instanceof GoogleApiError) || error.status !== 400) throw error; data = await read('text/plain'); }
    return docText(new TextDecoder().decode(data));
  }
  private async doc(meta: Meta, signal?: AbortSignal): Promise<GoogleDoc> {
    const text = await this.docMarkdown(meta.id, signal);
    return { kind: 'doc', title: clean(meta.name, 200), fileId: meta.id, link: linkOf(meta), content: text.slice(0, DOC_CHARACTERS), truncated: text.length > DOC_CHARACTERS, ...(meta.modifiedTime ? { modifiedAt: meta.modifiedTime } : {}), fetchedAt: new Date().toISOString() };
  }

  /** What a block shows. With a project, the last read is also kept in its folder's cache, so a restart still shows it. */
  async read(view: GoogleView, refresh = false, projectId?: string, signal?: AbortSignal): Promise<GoogleRead> {
    const key = JSON.stringify([view.fileId, view.kind, view.sheet ?? '']);
    let cached = this.reads.get(key);
    if (!cached && projectId) {
      const saved = this.cache?.read<GoogleRead>(projectId, 'google', key);
      if (saved) this.reads.set(key, cached = { at: Date.parse(saved.fetchedAt) || 0, read: saved });
    }
    if (cached && !refresh && Date.now() - cached.at < FRESH_MS) return cached.read;
    try {
      const meta = await this.meta(view.fileId, signal);
      if (kindOf(meta.mimeType) !== view.kind) throw new StoreError(`${clean(meta.name, 200)} is no longer a Google ${view.kind === 'sheet' ? 'Sheet' : 'Doc'}.`, 409);
      // An unchanged file is not read again.
      const read: GoogleRead = cached && meta.modifiedTime && cached.read.modifiedAt === meta.modifiedTime && !cached.read.notice ? { ...cached.read, title: clean(meta.name, 200), fetchedAt: new Date().toISOString() }
        : view.kind === 'sheet' ? await this.sheet(view, meta, signal) : await this.doc(meta, signal);
      this.reads.set(key, { at: Date.now(), read });
      if (projectId) this.cache?.write(projectId, 'google', key, read);
      return read;
    } catch (error) {
      // Keep showing the last read rather than nothing, and say why it is not newer.
      if (!cached || signal?.aborted) throw error;
      return { ...cached.read, notice: `Google did not answer a new read (${error instanceof Error ? error.message : 'unknown error'}). Showing the earlier read.` };
    }
  }
  /** Checks a link before a person adds it as a block: which file and kind it is, the tab its gid names, and a first read. */
  async preview(link: string) {
    const found = googleLink(link);
    if (!found) throw new StoreError('Paste the link of a Google Sheet or Doc (docs.google.com/…).');
    const meta = await this.meta(found.fileId), kind = kindOf(meta.mimeType);
    if (!kind) throw new StoreError(`${clean(meta.name, 200)} is not a Google Sheet or Doc. Copy a CSV file into a project from the Google Drive card on the Plugins page.`);
    const sheet = kind === 'sheet' && found.gid !== undefined ? (await this.tabs(meta.id).catch(() => [] as Tab[])).find(item => item.id === found.gid)?.title : undefined;
    const view: GoogleView = { fileId: meta.id, kind, ...(sheet ? { sheet } : {}) };
    return { view, read: await this.read(view, true) };
  }

  /** Copies the tab a Sheet block shows into a new Data block beside it: every row (as many as a Data block holds),
   * with numbers unformatted, and where and when it came from. Undo removes the block; Google Drive is unchanged. */
  async copy(store: Store, projectId: string, nodeId: string): Promise<{ artifact: Artifact; nodeId: string }> {
    const from = store.getProject(projectId).canvas.nodes.find(node => node.id === nodeId);
    if (from?.google?.kind !== 'sheet') throw new StoreError('Only a Google Sheet block can be copied into a Data block.', 400);
    const meta = await this.meta(from.google.fileId);
    if (kindOf(meta.mimeType) !== 'sheet') throw new StoreError(`${clean(meta.name, 200)} is no longer a Google Sheet.`, 409);
    let tab = from.google.sheet ?? '', values: unknown[][];
    try {
      const tabs = await this.tabs(meta.id), chosen = tabs.find(item => item.title === tab) ?? tabs[0];
      if (!chosen) throw new StoreError('This spreadsheet has no tab with cells.', 404);
      tab = chosen.title;
      values = await this.values(meta.id, `${tabRange(tab)}!1:${COPY_ROWS + 1}`, undefined, true, 40_000_000);
    } catch (error) {
      if (!googleApiDisabled(error)) throw error;
      tab = ''; values = await this.exported(meta.id);
    }
    if (values.length > COPY_ROWS + 1) throw new StoreError(`The tab has more than ${COPY_ROWS.toLocaleString('en-US')} rows, more than a Data block holds.`);
    const data = table(values, Math.max(1, widest(values))), csv = tableCsv(data);
    if (Buffer.byteLength(csv, 'utf8') > COPY_BYTES) throw new StoreError('The tab is larger than 5 MB, the most a Data block holds.');
    const where = tab ? `${clean(meta.name, 160)} › ${tab}` : clean(meta.name, 160), link = linkOf(meta);
    return store.atomic(() => {
      const project = store.getProject(projectId), source = project.canvas.nodes.find(node => node.id === nodeId);
      if (!source) throw new StoreError('The Sheet block was removed from the canvas.', 409);
      const title = `${source.title}${tab && tab !== source.title ? ` › ${tab}` : ''} (copy)`.slice(0, 200), label = `Copy ${source.title} into a Data block`.slice(0, 200);
      const node: CanvasNode = { id: randomUUID(), title, description: '', kind: 'topic', blockType: 'dataset', x: source.x + cardWidth(source) + LAYOUT_GAP, y: source.y, ...(source.parentId ? { parentId: source.parentId } : {}) };
      const operations: Mutation[] = [{ type: 'addNode', node }, { type: 'addConnection', connection: { id: randomUUID(), source: source.id, target: node.id, label: 'copy' } }];
      store.mutate(projectId, operations, label);
      const added = store.getProject(projectId).canvas.nodes.find(item => item.id === node.id)!, at = new Date().toISOString();
      const run: Run = { id: randomUUID(), projectId, nodeId: node.id, request: `Copy ${where} from Google Sheets`, useSearch: false, status: 'running', createdAt: at, startedAt: at, projectRevision: project.revision,
        node: structuredClone(added), inputs: [], messages: [], provider: 'local', model: 'google-sheets', modelVersion: null, configuration: { kind: 'google-sheet-copy', fileId: meta.id, sheet: tab, link, modifiedTime: meta.modifiedTime ?? null },
        tools: [], events: [{ at, type: 'google-sheet-copy', message: `Copied from Google Sheets: ${where}${meta.modifiedTime ? `, as last edited ${meta.modifiedTime}` : ''}. No model ran.` }], artifactIds: [] };
      store.createRun(run);
      const artifact = store.addArtifact({ projectId, nodeId: node.id, runId: run.id, kind: 'dataset', title, content: csv, mediaType: 'text/csv', capture: 'generated', url: link,
        metadata: { origin: 'google-sheets', fileId: meta.id, sheet: tab, link, modifiedTime: meta.modifiedTime ?? null, rows: data.rows.length, columns: data.columns, contribution: 'user copy' } });
      store.updateRun(run.id, { status: 'completed', endedAt: new Date().toISOString(), artifactIds: [artifact.id] });
      store.mutate(projectId, [{ type: 'updateNode', id: node.id, patch: { artifactId: artifact.id } }], label);
      return { artifact, nodeId: node.id };
    });
  }

  /** Files in Drive by name or text: Google Sheets and Docs, newest first without a query. */
  async search(query: string, kind: 'sheet' | 'doc' | undefined, limit: number, page?: string, signal?: AbortSignal) {
    const types = kind ? [kind === 'sheet' ? SHEET : DOC] : [SHEET, DOC], escaped = query.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const q = `trashed = false and (${types.map(type => `mimeType = '${type}'`).join(' or ')})${query ? ` and (name contains '${escaped}' or fullText contains '${escaped}')` : ''}`;
    // Google sorts a text search by relevance and refuses another order for it.
    const body = await this.json<{ files?: unknown[]; nextPageToken?: string }>('drive', 'files', { q, pageSize: String(limit), spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))', ...(query ? {} : { orderBy: 'modifiedTime desc' }), ...(page ? { pageToken: page } : {}) }, signal);
    const files = (body.files ?? []).flatMap(value => {
      const file = metaSchema.extend({ owners: z.array(z.object({ displayName: z.string().max(200).optional() }).passthrough()).max(20).optional() }).safeParse(value);
      if (!file.success || !kindOf(file.data.mimeType)) return [];
      return [{ id: file.data.id, name: clean(file.data.name, 300), kind: kindOf(file.data.mimeType)!, modified: file.data.modifiedTime, owner: clean(file.data.owners?.[0]?.displayName, 120) || undefined, link: linkOf(file.data as Meta) }];
    });
    return { files, ...(body.nextPageToken ? { page: clean(body.nextPageToken, 2000) } : {}) };
  }

  /** A page of a tab for an agent: the column names, then `limit` rows from `offset`; or one A1 range exactly. */
  async readSheet(supplied: string, sheet: string | undefined, range: string | undefined, offset: number, limit: number, signal?: AbortSignal) {
    const { meta, gid } = await this.file(supplied, 'sheet', signal), base = { title: clean(meta.name, 200), link: linkOf(meta), modified: meta.modifiedTime };
    let tabs: Tab[];
    try { tabs = await this.tabs(meta.id, signal); }
    catch (error) {
      if (!googleApiDisabled(error)) throw error;
      const values = await this.exported(meta.id, signal), all = table(values, widest(values));
      return { ...base, sheet: 'first tab', ...all, rows: all.rows.slice(offset, offset + limit), offset, more: all.rows.length > offset + limit, note: 'Only the first tab can be read: the Google Sheets API is off in the Google Cloud project behind ros.ai’s Google sign-in.' };
    }
    const chosen = sheet ? tabs.find(item => item.title.toLowerCase() === sheet.trim().toLowerCase()) : tabs.find(item => item.id === gid) ?? tabs[0];
    if (!chosen) throw new StoreError(sheet ? `There is no tab called “${clean(sheet, 80)}”. Tabs: ${tabs.map(item => item.title).join(', ')}.` : 'This spreadsheet has no tab with cells.', 404);
    const listed = tabs.map(item => ({ title: item.title, rows: item.rows, columns: item.columns }));
    if (range) {
      const values = await this.values(meta.id, `${tabRange(chosen.title)}!${range}`, signal);
      return { ...base, sheet: chosen.title, tabs: listed, range, rows: values.slice(0, limit).map(row => row.map(value => clean(value, CELL))), more: values.length > limit };
    }
    const body = await this.json<{ valueRanges?: { values?: unknown[][] }[] }>('sheets', `spreadsheets/${meta.id}/values:batchGet`, { ranges: [`${tabRange(chosen.title)}!1:1`, `${tabRange(chosen.title)}!${offset + 2}:${offset + limit + 2}`], majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' }, signal);
    const header = body.valueRanges?.[0]?.values ?? [], rows = body.valueRanges?.[1]?.values ?? [];
    const shown = table([header[0] ?? [], ...rows.slice(0, limit)], widest([...header, ...rows]));
    return { ...base, sheet: chosen.title, tabs: listed, columns: shown.columns, rows: shown.rows, offset, more: rows.length > limit, ...(rows.length > limit ? { next: `offset ${offset + limit}` } : {}) };
  }
  /** A page of a doc's Markdown for an agent. */
  async readDoc(supplied: string, offset: number, length: number, signal?: AbortSignal) {
    const { meta } = await this.file(supplied, 'doc', signal), read = await this.read({ fileId: meta.id, kind: 'doc' }, false, undefined, signal) as GoogleDoc;
    return { title: read.title, link: read.link, modified: read.modifiedAt, offset, text: read.content.slice(offset, offset + length), totalCharacters: read.content.length, more: offset + length < read.content.length, ...(read.truncated ? { note: `Only the first ${DOC_CHARACTERS.toLocaleString('en-US')} characters of the doc can be read.` } : {}) };
  }
}

const driveSchemas = {
  search_files: z.object({ query: z.string().trim().max(200).default('').describe('Words in the file’s name or text; empty lists the newest'), kind: z.enum(['sheet', 'doc']).optional().describe('Only Google Sheets or only Google Docs'), limit: z.number().int().min(1).max(50).default(20), page: z.string().max(2000).optional().describe('page from the previous answer') }).strict(),
  read_doc: z.object({ file: z.string().trim().min(10).max(500).describe('A file ID from search_files, or a docs.google.com link'), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(50_000).default(20_000) }).strict(),
  read_sheet: z.object({ file: z.string().trim().min(10).max(500).describe('A file ID from search_files, or a docs.google.com link'), sheet: z.string().trim().min(1).max(200).optional().describe('The tab’s title; the first tab (or the link’s tab) without it'), range: z.string().trim().regex(/^[A-Za-z]{0,3}\d{0,7}(:[A-Za-z]{0,3}\d{0,7})?$/u, 'An A1 range such as B2:F50').max(30).optional().describe('An A1 range within the tab, read exactly; without it, the column names and then rows from offset'), offset: z.number().int().min(0).default(0).describe('Rows to skip below the column names'), limit: z.number().int().min(1).max(500).default(100) }).strict(),
};
type DriveTool = keyof typeof driveSchemas;
const driveDescriptions: Record<DriveTool, string> = {
  search_files: 'Find Google Sheets and Docs in the person’s Drive by words in their name or text, with each file’s ID, kind, owner, last edit and link.',
  read_doc: 'Read a Google Doc’s text as Markdown (images left out), a page at a time from offset.',
  read_sheet: 'Read a Google Sheet: its tabs, then one tab’s column names (its first row) and rows from offset, as Google shows the cells; or one A1 range exactly.',
};
const driveTools: AppTool[] = (Object.keys(driveSchemas) as DriveTool[]).map(name => ({ name, description: driveDescriptions[name], inputSchema: z.toJSONSchema(driveSchemas[name], { io: 'input' }) as Record<string, unknown>, reads: true }));

/** Google Drive's tools for agents, through the person's read-only Google sign-in: shaped like an app's MCP server. */
export class GoogleDriveApp implements BuiltInApp {
  constructor(private readonly workspace: GoogleWorkspace) {}
  connected() { return this.workspace.connected; }
  tools() { return driveTools; }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    try {
      const result = name === 'search_files' ? (value => this.workspace.search(value.query, value.kind, value.limit, value.page, signal))(driveSchemas.search_files.parse(args))
        : name === 'read_doc' ? (value => this.workspace.readDoc(value.file, value.offset, value.length, signal))(driveSchemas.read_doc.parse(args))
        : name === 'read_sheet' ? (value => this.workspace.readSheet(value.file, value.sheet, value.range, value.offset, value.limit, signal))(driveSchemas.read_sheet.parse(args))
        : Promise.reject(new StoreError(`Google Drive has no tool called ${clean(name, 60)}.`));
      return { text: JSON.stringify(await result, null, 1), isError: false };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof z.ZodError) return { text: `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ').slice(0, 500)}`, isError: true };
      if (error instanceof StoreError) return { text: error.message, isError: true };
      throw error;
    }
  }
}

export function attachGoogleRoutes(app: Express, store: Store, workspace: GoogleWorkspace) {
  const block = (projectId: string, nodeId: string) => {
    const node = store.getProject(projectId).canvas.nodes.find(item => item.id === nodeId);
    if (!node?.google) throw new StoreError('This block shows nothing from Google Drive.', 404);
    return node.google;
  };
  app.get('/api/projects/:id/nodes/:nodeId/google', async (req, res) => res.json(await workspace.read(block(String(req.params.id), String(req.params.nodeId)), req.query.refresh === '1', String(req.params.id))));
  app.post('/api/projects/:id/nodes/:nodeId/google/copy', async (req, res) => { z.object({}).strict().parse(req.body ?? {}); res.status(201).json(await workspace.copy(store, String(req.params.id), String(req.params.nodeId))); });
  // Checks a link before a person adds it as a block: the same read, without a block yet.
  app.post('/api/google/views/preview', async (req, res) => res.json(await workspace.preview(z.object({ url: z.string().trim().min(10).max(1000) }).strict().parse(req.body).url)));
}
