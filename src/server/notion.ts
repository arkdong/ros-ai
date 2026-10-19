import { StoreError } from './store.js';

/** Notion's public REST API with the integration secret from the Plugins page.
 * Only pages and databases the person shared with that integration are visible. */
const VERSION = '2022-06-28';
const MAX_TEXT = 1900, MAX_BLOCKS = 100, CONTENT_CHARACTERS = 12_000;

export type NotionValue = string | number | boolean | string[] | null;
export type NotionWrite =
  | { type: 'create_page'; parentId: string; title: string; properties: Record<string, NotionValue>; content?: string }
  | { type: 'update_page'; pageId: string; properties: Record<string, NotionValue> }
  | { type: 'append'; pageId: string; content: string }
  | { type: 'comment'; pageId: string; text: string };
/** A write checked against Notion before the person is asked: the exact request that runs on approval. */
export type PreparedNotionWrite = { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown>; target: { id: string; title: string; url?: string; kind: 'page' | 'database' }; preview: string };

type Json = Record<string, any>;
const text = (items: unknown) => Array.isArray(items) ? items.map(item => typeof item?.plain_text === 'string' ? item.plain_text : '').join('') : '';
const rich = (content: string) => chunks(content).map(part => ({ type: 'text', text: { content: part } }));
function chunks(content: string) {
  const parts: string[] = [];
  for (let at = 0; at < content.length; at += MAX_TEXT) parts.push(content.slice(at, at + MAX_TEXT));
  return parts.length ? parts : [''];
}

/** A page or database ID from an ID or any Notion link (the last 32 hex characters). */
export function notionId(value: string): string {
  const hex = value.replace(/-/g, '').match(/[0-9a-f]{32}(?![0-9a-f])/gi)?.at(-1);
  if (!hex) throw new StoreError('Give a Notion page or database ID or link.');
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One property as plain text; file links are left out because Notion signs them for an hour. */
function propertyText(value: Json): string | number | boolean | string[] | null {
  switch (value?.type) {
    case 'title': case 'rich_text': return text(value[value.type]);
    case 'number': return value.number ?? null;
    case 'select': case 'status': return value[value.type]?.name ?? null;
    case 'multi_select': return (value.multi_select ?? []).map((item: Json) => item.name);
    case 'date': return value.date ? `${value.date.start}${value.date.end ? ` to ${value.date.end}` : ''}` : null;
    case 'checkbox': return Boolean(value.checkbox);
    case 'url': case 'email': case 'phone_number': return value[value.type] ?? null;
    case 'people': return (value.people ?? []).map((person: Json) => person.name ?? person.id);
    case 'files': return (value.files ?? []).map((file: Json) => file.name ?? 'file');
    case 'relation': return (value.relation ?? []).map((item: Json) => item.id);
    case 'created_time': case 'last_edited_time': return value[value.type] ?? null;
    case 'created_by': case 'last_edited_by': return value[value.type]?.name ?? value[value.type]?.id ?? null;
    case 'formula': { const f = value.formula ?? {}; return f[f.type] ?? null; }
    case 'rollup': { const r = value.rollup ?? {}; return r.type === 'array' ? (r.array ?? []).map((item: Json) => String(propertyText(item) ?? '')) : r[r.type] ?? null; }
    case 'unique_id': return value.unique_id ? `${value.unique_id.prefix ? `${value.unique_id.prefix}-` : ''}${value.unique_id.number}` : null;
    default: return null;
  }
}
const properties = (page: Json) => Object.fromEntries(Object.entries(page.properties ?? {}).map(([name, value]) => [name, propertyText(value as Json)]));
const pageTitle = (page: Json) => { const title = Object.values(page.properties ?? {}).find((value: any) => value?.type === 'title') as Json | undefined; return title ? text(title.title) : ''; };
const databaseTitle = (database: Json) => text(database.title);

/** One block as a line of Markdown-like text; nested content is named, not followed. */
function blockLine(block: Json): string {
  const body = (key: string) => text(block[key]?.rich_text);
  const nested = block.has_children && !['child_page', 'child_database'].includes(block.type) ? ` (nested content: read ${block.id})` : '';
  switch (block.type) {
    case 'paragraph': return body('paragraph') + nested;
    case 'heading_1': return `# ${body('heading_1')}${nested}`;
    case 'heading_2': return `## ${body('heading_2')}${nested}`;
    case 'heading_3': return `### ${body('heading_3')}${nested}`;
    case 'bulleted_list_item': return `- ${body('bulleted_list_item')}${nested}`;
    case 'numbered_list_item': return `1. ${body('numbered_list_item')}${nested}`;
    case 'to_do': return `- [${block.to_do?.checked ? 'x' : ' '}] ${body('to_do')}${nested}`;
    case 'quote': return `> ${body('quote')}${nested}`;
    case 'callout': return `> ${body('callout')}${nested}`;
    case 'toggle': return `${body('toggle')}${nested}`;
    case 'code': return `\`\`\`\n${body('code')}\n\`\`\``;
    case 'divider': return '---';
    case 'child_page': return `[page] ${block.child_page?.title ?? ''} (${block.id})`;
    case 'child_database': return `[database] ${block.child_database?.title ?? ''} (${block.id})`;
    case 'column_list': case 'column': case 'synced_block': return nested ? `[${block.type}]${nested}` : '';
    default: return `[${block.type}]${nested}`;
  }
}

/** Markdown-like text as Notion blocks: headings, bullets, numbered items, to-dos, quotes and paragraphs. */
export function textBlocks(content: string): Json[] {
  const blocks: Json[] = [];
  const add = (type: string, line: string, extra: Json = {}) => blocks.push({ object: 'block', type, [type]: { rich_text: rich(line), ...extra } });
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^(#{1,3})\s+(.*)$/))) add(`heading_${match[1].length}`, match[2]);
    else if ((match = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) add('to_do', match[2], { checked: match[1].toLowerCase() === 'x' });
    else if ((match = line.match(/^\s*[-*]\s+(.*)$/))) add('bulleted_list_item', match[1]);
    else if ((match = line.match(/^\s*\d+[.)]\s+(.*)$/))) add('numbered_list_item', match[1]);
    else if ((match = line.match(/^>\s?(.*)$/))) add('quote', match[1]);
    else add('paragraph', line);
  }
  if (blocks.length > MAX_BLOCKS) throw new StoreError(`Notion takes at most ${MAX_BLOCKS} blocks in one write; shorten the content.`);
  return blocks;
}

/** A simple value in the shape Notion wants for this property type. */
function propertyValue(name: string, type: string, value: NotionValue): Json {
  const fail = (): never => { throw new StoreError(`Notion property "${name}" (${type}) cannot take ${JSON.stringify(value)?.slice(0, 60)}.`); };
  const one = Array.isArray(value) ? value.join(', ') : value;
  switch (type) {
    case 'title': return { title: one === null ? [] : rich(String(one)) };
    case 'rich_text': return { rich_text: one === null ? [] : rich(String(one)) };
    case 'number': return { number: value === null ? null : typeof value === 'number' ? value : Number.isFinite(Number(value)) && String(value).trim() ? Number(value) : fail() };
    case 'select': return { select: one === null || one === '' ? null : { name: String(one).slice(0, 100) } };
    case 'status': return { status: one === null || one === '' ? null : { name: String(one).slice(0, 100) } };
    case 'multi_select': return { multi_select: (Array.isArray(value) ? value : value === null ? [] : String(value).split(',').map(item => item.trim()).filter(Boolean)).map(item => ({ name: String(item).slice(0, 100) })) };
    case 'checkbox': return { checkbox: typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : fail() };
    case 'date': return { date: one === null || one === '' ? null : /^\d{4}-\d{2}-\d{2}/.test(String(one)) ? { start: String(one) } : fail() };
    case 'url': case 'email': case 'phone_number': return { [type]: one === null || one === '' ? null : String(one) };
    default: return fail();
  }
}

export class NotionApi {
  constructor(private readonly token: () => string | undefined, private readonly fetcher: typeof fetch = fetch, private readonly base = notionBase()) {}
  get configured() { return Boolean(this.token()); }
  private async call<T = Json>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = this.token();
    if (!token) throw new StoreError('Notion is not connected. Save the integration secret on the Plugins page.', 409);
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new StoreError('Could not reach Notion.', 502); }
    const payload = await response.json().catch(() => ({})) as Json;
    if (!response.ok) {
      const message = typeof payload.message === 'string' ? payload.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : `HTTP ${response.status}`;
      const hint = response.status === 404 ? ' Share the page with the ros.ai integration in Notion (••• → Connections) if it should be visible.' : '';
      throw new StoreError(`Notion: ${message}${hint}`, response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : response.status === 429 ? 429 : 400);
    }
    return payload as T;
  }
  async search(query: string, kind: 'page' | 'database' | undefined, limit: number, signal?: AbortSignal) {
    const result = await this.call('POST', '/v1/search', { ...(query ? { query } : {}), ...(kind ? { filter: { property: 'object', value: kind } } : {}), page_size: limit }, signal);
    return { results: (result.results ?? []).map((item: Json) => ({ id: item.id, kind: item.object, title: item.object === 'database' ? databaseTitle(item) : pageTitle(item), url: item.url, lastEdited: item.last_edited_time })), more: Boolean(result.has_more) };
  }
  private async database(id: string, signal?: AbortSignal) {
    const database = await this.call('GET', `/v1/databases/${id}`, undefined, signal);
    return { database, schema: Object.fromEntries(Object.entries(database.properties ?? {}).map(([name, value]: [string, any]) => [name, value.type as string])) as Record<string, string> };
  }
  /** A page with its properties and top-level content, or a database with its columns. */
  async read(target: string, cursor: string | undefined, signal?: AbortSignal) {
    const id = notionId(target);
    let page: Json;
    try { page = await this.call('GET', `/v1/pages/${id}`, undefined, signal); }
    catch (error) {
      if (!(error instanceof StoreError) || (error.status !== 404 && error.status !== 400)) throw error;
      const { database } = await this.database(id, signal);
      return { kind: 'database', id: database.id, title: databaseTitle(database), url: database.url, description: text(database.description), columns: Object.entries(database.properties ?? {}).map(([name, value]: [string, any]) => ({ name, type: value.type, ...(value[value.type]?.options ? { options: value[value.type].options.map((option: Json) => option.name) } : {}) })), instruction: 'Query its rows with ros_notion_query.' };
    }
    const lines: string[] = [];
    let next: string | undefined = cursor, length = 0;
    do {
      const children = await this.call('GET', `/v1/blocks/${id}/children?page_size=100${next ? `&start_cursor=${encodeURIComponent(next)}` : ''}`, undefined, signal);
      for (const block of children.results ?? []) { const line = blockLine(block); if (line) { lines.push(line); length += line.length + 1; } }
      next = children.has_more ? children.next_cursor : undefined;
    } while (next && length < CONTENT_CHARACTERS);
    const content = lines.join('\n');
    return { kind: 'page', id: page.id, title: pageTitle(page), url: page.url, parent: page.parent, properties: properties(page), content: content.slice(0, CONTENT_CHARACTERS), ...(next || content.length > CONTENT_CHARACTERS ? { nextCursor: next ?? null, note: 'Content continues; pass nextCursor to read further.' } : {}) };
  }
  async query(target: string, filter: Json | undefined, sorts: Json[] | undefined, limit: number, cursor: string | undefined, signal?: AbortSignal) {
    const id = notionId(target);
    const result = await this.call('POST', `/v1/databases/${id}/query`, { page_size: limit, ...(filter ? { filter } : {}), ...(sorts?.length ? { sorts } : {}), ...(cursor ? { start_cursor: cursor } : {}) }, signal);
    return { rows: (result.results ?? []).map((page: Json) => ({ id: page.id, url: page.url, title: pageTitle(page), properties: properties(page) })), nextCursor: result.has_more ? result.next_cursor : null };
  }
  /** Resolves the target and property types now, so a bad write fails before anyone is asked to approve it. */
  async prepare(write: NotionWrite, signal?: AbortSignal): Promise<PreparedNotionWrite> {
    const typedProperties = (schema: Record<string, string>, supplied: Record<string, NotionValue>) => Object.fromEntries(Object.entries(supplied).map(([name, value]) => {
      const type = schema[name];
      if (!type) throw new StoreError(`Notion has no property "${name}" here. Known: ${Object.keys(schema).join(', ').slice(0, 300)}.`);
      return [name, propertyValue(name, type, value)];
    }));
    const shown = (values: Record<string, NotionValue>) => Object.entries(values).map(([name, value]) => `- ${name}: ${Array.isArray(value) ? value.join(', ') : value === null ? '(cleared)' : String(value)}`).join('\n');
    if (write.type === 'create_page') {
      const parent = notionId(write.parentId);
      let schema: Record<string, string> | null = null, target: PreparedNotionWrite['target'];
      try { const found = await this.database(parent, signal); schema = found.schema; target = { id: found.database.id, title: databaseTitle(found.database), url: found.database.url, kind: 'database' }; }
      catch (error) {
        if (!(error instanceof StoreError) || (error.status !== 404 && error.status !== 400)) throw error;
        const page = await this.call('GET', `/v1/pages/${parent}`, undefined, signal);
        target = { id: page.id, title: pageTitle(page), url: page.url, kind: 'page' };
      }
      let props: Json;
      if (schema) {
        const titleName = Object.keys(schema).find(name => schema![name] === 'title')!;
        props = typedProperties(schema, { ...write.properties, [titleName]: write.title });
      } else {
        if (Object.keys(write.properties).length) throw new StoreError('A page inside another page takes only a title and content; properties need a database parent.');
        props = { title: { title: rich(write.title) } };
      }
      const children = write.content ? textBlocks(write.content) : [];
      return { method: 'POST', path: '/v1/pages', body: { parent: schema ? { database_id: parent } : { page_id: parent }, properties: props, ...(children.length ? { children } : {}) }, target, preview: `Create "${write.title}" in ${target.kind} "${target.title}".${Object.keys(write.properties).length ? `\n${shown(write.properties)}` : ''}${write.content ? `\n\n${write.content.slice(0, 4000)}` : ''}` };
    }
    const pageId = notionId(write.pageId);
    const page = await this.call('GET', `/v1/pages/${pageId}`, undefined, signal);
    const target = { id: page.id, title: pageTitle(page), url: page.url, kind: 'page' as const };
    if (write.type === 'update_page') {
      const schema = Object.fromEntries(Object.entries(page.properties ?? {}).map(([name, value]: [string, any]) => [name, value.type as string]));
      return { method: 'PATCH', path: `/v1/pages/${pageId}`, body: { properties: typedProperties(schema, write.properties) }, target, preview: `Change these properties of "${target.title}":\n${shown(write.properties)}` };
    }
    if (write.type === 'append') return { method: 'PATCH', path: `/v1/blocks/${pageId}/children`, body: { children: textBlocks(write.content) }, target, preview: `Add to the end of "${target.title}":\n\n${write.content.slice(0, 4000)}` };
    return { method: 'POST', path: '/v1/comments', body: { parent: { page_id: pageId }, rich_text: rich(write.text) }, target, preview: `Comment on "${target.title}":\n\n${write.text}` };
  }
  async apply(prepared: PreparedNotionWrite, signal?: AbortSignal) {
    const result = await this.call(prepared.method, prepared.path, prepared.body, signal);
    return { id: (result.id as string | undefined) ?? prepared.target.id, url: (result.url as string | undefined) ?? prepared.target.url };
  }
}

/** Notion's API; a stand-in on this computer only, for checks without a real workspace. */
function notionBase() {
  const value = process.env.ROS_NOTION_API_BASE?.replace(/\/+$/u, '');
  if (!value) return 'https://api.notion.com';
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(value)) throw new Error('ROS_NOTION_API_BASE may only point at a stand-in on this computer (http://127.0.0.1:<port>).');
  return value;
}
