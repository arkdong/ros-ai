import type { NotionPage, NotionProperty, NotionPropertyType, NotionUnit } from '../shared/types.js';
import { parseLine } from '../shared/notion-inline.js';

/** A Notion page as ros.ai shows it, from the text Notion's hosted MCP returns for a page: the page's
 * properties (a JSON object), its content in Notion-flavored Markdown (CommonMark with Notion's own tags)
 * and the path above it. The content becomes the plain Markdown the canvas already renders, block by block,
 * each block keeping Notion's own text so an edit can replace exactly that block. */

type Attributes = Record<string, string>;
const CONTENT_CHARACTERS = 40_000, VALUE_CHARACTERS = 2000;
const attributes = (tag: string): Attributes => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/gu)].map(match => [match[1], unescape(match[2])]));
const unescape = (text: string) => text.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&');
/** Someone's name for a user:// address, or a quiet stand-in. */
export type UserNames = (id: string) => string | undefined;
const person = (names: UserNames, url: string) => names(url.replace(/^user:\/\//u, '')) ?? 'someone';
const date = (attrs: Attributes) => {
  const at = (day?: string, time?: string) => day ? `${day}${time ? ` ${time}` : ''}` : '';
  const start = at(attrs.start, attrs['start-time']), end = at(attrs.end, attrs['end-time']);
  return end ? `${start} – ${end}` : start;
};

/** Notion's inline tags as Markdown: emphasis, mentions, dates and links; colour and underline are dropped. */
function inline(text: string, names: UserNames): string {
  return text
    .replace(/<mention-user url="([^"]*)"[^>]*>(?:[\s\S]*?<\/mention-user>)?/gu, (_m, url) => `@${person(names, url)}`)
    .replace(/<mention(?:\s+[^>]*)?url="([^"]*)"[^>]*\/>/gu, (_m, url) => url)
    .replace(/<mention(?:\s+[^>]*)?url="([^"]*)"[^>]*>([\s\S]*?)<\/mention>/gu, (_m, url, label) => /^https?:\/\//u.test(url) ? `[${label.trim()}](${url})` : label.trim())
    .replace(/<date\s[^>]*\/>/gu, tag => date(attributes(tag)))
    .replace(/<link-preview\s[^>]*url="([^"]*)"[^>]*\/>/gu, (_m, url) => url)
    .replace(/<(page|database|folder)\s[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/gu, (_m, _kind, url, title) => `[${title.trim() || 'Untitled'}](${url})`)
    .replace(/<(page|database|folder)\s[^>]*>([\s\S]*?)<\/\1>/gu, (_m, _kind, title) => title.trim())
    .replace(/<equation(?:\s[^>]*)?>([\s\S]*?)<\/equation>/gu, (_m, body) => `$${body.trim()}$`)
    .replace(/<b>([\s\S]*?)<\/b>/gu, '**$1**').replace(/<i>([\s\S]*?)<\/i>/gu, '*$1*').replace(/<s>([\s\S]*?)<\/s>/gu, '~~$1~~')
    .replace(/<br\s*\/?>/gu, '\n')
    .replace(/<external_object_instance\b[^>]*>[\s\S]*?<\/external_object_instance>/gu, '')
    .replace(/<meeting-notes-section-transcript\b[^>]*>[\s\S]*?<\/meeting-notes-section-transcript>/gu, '')
    .replace(/^(\s*)- \[( |x|X)\] /gmu, (_m, space, mark) => `${space}- ${mark.trim() ? '☑' : '☐'} `)
    // Whatever tag is left (colour, underline, custom blocks) only decorates; its words stay.
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*?)?\/?>/gu, '');
}

type Frame = { tag: string; marker: string; prefix: string; used: boolean; lines: number; list?: 'ul' | 'ol'; media?: string; unit?: { from: number; raw: string[] } };
const MEDIA = ['image', 'pdf', 'file', 'audio', 'video', 'bookmark', 'embed'];
const HEADINGS: Record<string, string> = { h1: '# ', h2: '## ', h3: '### ', h4: '### ' };
/** Blocks a person edits as one piece of text; the outermost one on the stack owns the words inside it. */
const UNITS = ['h1', 'h2', 'h3', 'h4', 'p', 'toggle', 'quote', 'callout', 'li', 'todo'];
const BLOCK = [...UNITS, 'ul', 'ol', 'columns', 'column', 'tabs', 'tab', 'synced-block', 'synced-block-reference', 'meeting-notes', 'meeting-notes-section-notes', 'meeting-notes-section-summary', 'mail', 'table', 'tr', 'td', 'th', 'colgroup', 'col', 'thead', 'tbody', ...MEDIA];
const BLOCK_TAG = new RegExp(`(<\\/?(?:${BLOCK.join('|')})(?:\\s[^<>]*?)?\\/?>)`, 'u');

/** The content of a page as plain Markdown, block by block: headings, lists, to-dos, quotes, callouts, tables and
 * media become their Markdown forms; columns, tabs and other containers only contribute what they hold. */
export function notionUnits(content: string, names: UserNames = () => undefined): NotionUnit[] {
  const out: string[] = [], stack: Frame[] = [], units: NotionUnit[] = [];
  let cell: string[] | null = null, row: string[] | null = null, tableRows = 0, loose: { from: number } | null = null, pipes: number | null = null;
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  const emit = (line: string) => {
    const prefix = stack.map(frame => { const part = frame.used ? frame.prefix : frame.marker; frame.used = true; frame.lines++; return part; }).join('');
    out.push(`${prefix}${line}`.trimEnd());
  };
  const owner = () => stack.find(frame => frame.unit);
  /** Lines emitted since `from` as one unit; `source` is Notion's own text for it. */
  const close = (from: number, source?: string) => {
    const markdown = out.slice(from).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
    if (!markdown) return;
    // One block of words: a block with children, a table row, an equation or an embedded page stays read only.
    const editable = source !== undefined && source.trim().length > 0 && !/\n\s*\n/u.test(source.trim()) && !/^\s*(?:\||```|\$\$|(?:-{3,}|\*{3,})\s*$)/u.test(source) && !/<(?:table|columns|synced-block|database|page|image|pdf|file|audio|video|bookmark|embed|equation|callout|quote|toggle|ul|ol|li|todo|h[1-4]|p)\b/u.test(source);
    if (!editable) { units.push({ markdown }); return; }
    // What each mention, date or inline page reads as, for the editor to show in place of the tag.
    const atoms = parseLine(source!.trim()).runs.flatMap(run => 'atom' in run ? [run.atom] : []);
    const labels = Object.fromEntries(atoms.map(atom => [atom, unescape(inline(atom, names)).replace(/^\[([\s\S]*)\]\([^)]*\)$/u, '$1').trim() || atom.match(/>([^<]+)</u)?.[1] || '…']));
    units.push({ markdown, source: source!.trim(), ...(atoms.length ? { labels } : {}) });
  };
  const open = (tag: string, attrs: Attributes): Omit<Frame, 'used' | 'lines'> => {
    const parent = stack[stack.length - 1];
    if (HEADINGS[tag]) return { tag, marker: HEADINGS[tag], prefix: '' };
    if (tag === 'toggle') return { tag, marker: attrs.heading ? HEADINGS[attrs.heading] ?? '' : '', prefix: '' };
    if (tag === 'quote') return { tag, marker: '> ', prefix: '> ' };
    if (tag === 'callout') return { tag, marker: `> ${attrs.icon && !/^(attachment|notion-file-block|https?):/u.test(attrs.icon) ? `${attrs.icon} ` : ''}`, prefix: '> ' };
    if (tag === 'ul' || tag === 'ol') return { tag, marker: '', prefix: '', list: tag as 'ul' | 'ol' };
    if (tag === 'li') return { tag, marker: parent?.list === 'ol' ? '1. ' : '- ', prefix: '   ' };
    // The canvas renders plain lists; a box mark keeps a to-do readable without task-list support.
    if (tag === 'todo') return { tag, marker: attrs.checked === 'true' ? '- ☑ ' : '- ☐ ', prefix: '    ' };
    if (MEDIA.includes(tag)) { const media = `[${tag}]${attrs.source || attrs.url ? `(${attrs.source || attrs.url})` : ''}`; return { tag, marker: `${media} `, prefix: '', media }; }
    return { tag, marker: '', prefix: '' };
  };
  // A Markdown table written as pipe rows at the top level is one block, read only.
  const flush = () => { if (pipes !== null) { close(pipes); pipes = null; } };
  for (const token of content.replace(/\\</gu, '&lt;').split(BLOCK_TAG)) {
    const tag = token.match(/^<(\/?)([a-zA-Z][\w-]*)(?:\s[^<>]*?)?(\/?)>$/u);
    if (tag) flush();
    const unit = owner();
    if (unit && !tag) unit.unit!.raw.push(token);
    if (!tag) {
      if (cell) { cell.push(unescape(inline(token, names)).replace(/\s+/gu, ' ').trim()); continue; }
      const lines = unescape(inline(token, names)).split('\n'), raw = token.split('\n');
      // A blank line between top-level blocks is kept; inside a block its tags separate the children.
      lines.forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (line) {
          // Plain Markdown at the top level: each line is its own block in Notion (when a tag spanned lines, the words are read only).
          if (!stack.length && line.startsWith('|')) { if (pipes === null) pipes = out.length; emit(line); }
          else if (!stack.length) { flush(); const from = out.length; emit(line); close(from, lines.length === raw.length ? raw[index] : undefined); }
          else emit(line);
        } else if (!stack.length) { flush(); blank(); }
      });
      continue;
    }
    if (unit) unit.unit!.raw.push(token);
    const [, closing, rawName, selfClosing] = tag, name = rawName.toLowerCase(), attrs = attributes(token);
    if (name === 'table' && !closing) { tableRows = 0; loose = { from: out.length }; stack.push({ tag: name, marker: '', prefix: '', used: false, lines: 0 }); continue; }
    if (name === 'tr') { if (!closing) row = []; else if (row) { emit(`| ${row.join(' | ')} |`); if (tableRows++ === 0) emit(`| ${row.map(() => '---').join(' | ')} |`); row = null; } continue; }
    if (name === 'td' || name === 'th') { if (!closing) cell = []; else if (row && cell) { row.push(cell.join(' ').replace(/\|/gu, '\\|')); cell = null; } continue; }
    if (['colgroup', 'col', 'thead', 'tbody'].includes(name)) continue;
    if (selfClosing) { if (name === 'p') blank(); else if (MEDIA.includes(name)) { const from = out.length; emit(`[${name}]${attrs.source || attrs.url ? `(${attrs.source || attrs.url})` : ''}`); if (!stack.length) close(from); } continue; }
    if (!closing) {
      const frame: Frame = { ...open(name, attrs), used: false, lines: 0 };
      if (UNITS.includes(name) && !unit) frame.unit = { from: out.length, raw: [] };
      else if (MEDIA.includes(name) && !stack.length) loose = { from: out.length };
      stack.push(frame);
      continue;
    }
    const index = stack.map(frame => frame.tag).lastIndexOf(name);
    if (index < 0) continue;
    const [frame] = stack.splice(index, stack.length - index);
    if (frame.media && !frame.lines) emit(frame.media);
    if (frame.unit) { frame.unit.raw.pop(); close(frame.unit.from, frame.unit.raw.join('')); }
    else if (loose && (name === 'table' || MEDIA.includes(name)) && !stack.length) { close(loose.from); loose = null; }
    if (['h1', 'h2', 'h3', 'h4', 'p', 'toggle', 'quote', 'callout', 'li', 'todo', 'ul', 'ol', 'table', ...MEDIA].includes(frame.tag) && stack.length === 0) blank();
  }
  flush();
  return units;
}

/** The content of a page as one piece of plain Markdown. */
export function notionMarkdown(content: string, names: UserNames = () => undefined): string {
  const lines = notionUnits(content, names).map(unit => unit.markdown);
  // Notion separates every block with a blank line; neighbouring list items read as one list without it.
  return lines.join('\n\n').replace(/^(\s*(?:- |1\. ).*)\n\n(?=\s*(?:- |1\. ))/gmu, '$1\n').trim().slice(0, CONTENT_CHARACTERS);
}

type Column = { type: NotionPropertyType; options?: string[] };
/** What each column of the database holds, from the SQLite schema Notion sends with a page. */
export function notionSchema(schema: string): Map<string, Column> {
  const columns = new Map<string, Column>();
  for (const line of schema.split('\n')) {
    const match = line.match(/^\s*(?:"((?:[^"]|"")+)"|(\w+))\s+(TEXT|FLOAT|INTEGER|REAL)\b[^-]*(?:--\s*(.*))?$/u);
    if (!match) continue;
    const name = (match[1] ?? match[2]).replace(/""/gu, '"'), kind = match[3], comment = match[4] ?? '';
    if (name === 'url' || name === 'createdTime') continue;
    const dated = name.match(/^date:(.+):(start|end|is_datetime)$/u);
    if (dated) { if (!columns.has(dated[1])) columns.set(dated[1], { type: 'date' }); continue; }
    const options = (): string[] | undefined => { try { const list = JSON.parse(comment.match(/\[.*\]/u)?.[0] ?? ''); return Array.isArray(list) ? list.map(String) : undefined; } catch { return undefined; } };
    const type: NotionPropertyType = /zero or more of \[/u.test(comment) ? 'multi_select' : /one of \[/u.test(comment) ? 'select' : /__YES__/u.test(comment) ? 'checkbox'
      : /user IDs/u.test(comment) ? 'people' : /page URLs relating/u.test(comment) ? 'relation' : /\bfiles?\b/iu.test(comment) ? 'files'
      : /formula|rollup|automatically|computed|last edited|created/iu.test(comment) ? 'computed' : kind === 'FLOAT' || kind === 'INTEGER' || kind === 'REAL' ? 'number' : 'text';
    columns.set(name, { type, ...(type === 'select' || type === 'multi_select' ? { options: options() } : {}) });
  }
  return columns;
}

/** One property value as text, with the pages or addresses it points to. */
function property(name: string, raw: unknown, column: Column | undefined, names: UserNames): NotionProperty {
  const links: { text: string; url: string }[] = [];
  const values: string[] = [];
  const text = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' && /^\[.*\]$/su.test(value)) { try { return text(JSON.parse(value)); } catch { /* plain text */ } }
    if (Array.isArray(value)) { if (column?.type === 'multi_select') values.push(...value.map(String)); return value.map(text).filter(Boolean).join(', '); }
    if (value === '__YES__') return 'Yes';
    if (value === '__NO__') return 'No';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const item = String(value);
    if (/^https?:\/\//u.test(item)) { links.push({ text: /notion\.(so|site|com)\//u.test(item) ? 'page' : item.replace(/^https?:\/\//u, '').slice(0, 60), url: item }); return column?.type === 'text' ? item : ''; }
    if (/^(rollupResult|file|collection):\/\//u.test(item)) return '';
    return notionMarkdown(item, names).replace(/\n+/gu, ' ').trim();
  };
  const value = text(raw).slice(0, VALUE_CHARACTERS);
  const type = column?.type ?? (raw === '__YES__' || raw === '__NO__' ? 'checkbox' : typeof raw === 'number' ? 'number' : 'text');
  const editable = ['title', 'text', 'select', 'multi_select', 'checkbox', 'date', 'number'].includes(type);
  return { name, value: value || (links.length && type !== 'text' ? `${links.length} ${links.length === 1 ? 'page' : 'pages'}` : ''), type, editable, ...(column?.options ? { options: column.options } : {}), ...(type === 'multi_select' ? { values } : {}), ...(links.length ? { links } : {}) };
}

/** The properties in the order the database lists them (its SQLite schema), the title first, then any others. */
export function notionProperties(propertiesJson: string, schema: string, title: string, names: UserNames): { properties: NotionProperty[]; titleProperty?: string } {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(propertiesJson) as Record<string, unknown>; } catch { return { properties: [] }; }
  const columns = notionSchema(schema);
  const merged = new Map<string, unknown>();
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'url' || key === 'createdTime') continue;
    const dated = key.match(/^date:(.+):(start|end|is_datetime)$/u);
    if (!dated) { merged.set(key, value); continue; }
    const current = (merged.get(dated[1]) as { start?: string; end?: string; datetime?: boolean } | undefined) ?? {};
    if (dated[2] === 'start') current.start = typeof value === 'string' ? value : undefined;
    else if (dated[2] === 'end') current.end = typeof value === 'string' ? value : undefined;
    else current.datetime = value === 1 || value === true;
    merged.set(dated[1], current);
  }
  const part = (iso: string | undefined, datetime?: boolean) => iso ? (datetime ? iso.replace('T', ' ').replace(/(:\d\d)(?::\d\d)?(\.\d+)?(Z|[+-]\d\d:\d\d)?$/u, '$1') : iso.slice(0, 10)) : '';
  const order = [...columns.keys()];
  const rank = (name: string) => { const index = order.indexOf(name); return index < 0 ? order.length : index; };
  const sorted = [...merged.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const titleProperty = sorted.find(name => typeof merged.get(name) === 'string' && merged.get(name) === title && (columns.get(name)?.type ?? 'text') === 'text');
  const properties = [...(titleProperty ? [titleProperty] : []), ...sorted.filter(name => name !== titleProperty)].map(name => {
    const value = merged.get(name), column = columns.get(name);
    if (name === titleProperty) return { ...property(name, value, { type: 'title' }, names), type: 'title' as const, editable: true };
    if (column?.type === 'date' || (value && typeof value === 'object' && !Array.isArray(value) && ('start' in value || 'end' in value || 'datetime' in value))) {
      const parts = (value ?? {}) as { start?: string; end?: string; datetime?: boolean }, start = part(parts.start, parts.datetime), end = part(parts.end, parts.datetime);
      return { name, value: end ? `${start} – ${end}` : start, type: 'date' as const, editable: true, date: { start: parts.start?.slice(0, 10) ?? '', end: parts.end?.slice(0, 10) ?? '' } };
    }
    return property(name, value, column, names);
  });
  return { properties, ...(titleProperty ? { titleProperty } : {}) };
}

/** Every user:// address a page's text names, so their names can be looked up before the page is shown. */
export const userIds = (text: string) => [...new Set([...text.matchAll(/user:\/\/([0-9a-f-]{36})/gu)].map(match => match[1]))];

/** The page from the fetch result's text. */
export function notionPage(fetched: { text?: unknown; title?: unknown; url?: unknown; page_last_edited_at?: unknown; icon?: unknown }, url: string, names: UserNames): NotionPage {
  const text = String(fetched.text ?? '');
  const title = String(fetched.title ?? '').trim() || 'Untitled';
  const { properties, titleProperty } = notionProperties(text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/u)?.[1] ?? '{}', text.match(/<sqlite-table>([\s\S]*?)<\/sqlite-table>/u)?.[1] ?? '', title, names);
  const units = notionUnits(text.match(/<content>([\s\S]*?)<\/content>/u)?.[1] ?? '', names);
  const content = units.map(unit => unit.markdown).join('\n\n').replace(/^(\s*(?:- |1\. ).*)\n\n(?=\s*(?:- |1\. ))/gmu, '$1\n').trim().slice(0, CONTENT_CHARACTERS);
  const path = text.match(/<ancestor-path>([\s\S]*?)<\/ancestor-path>/u)?.[1] ?? '';
  const source = path.match(/<parent-data-source\s[^>]*name="([^"]*)"/u), database = path.match(/<ancestor-\d+-database\s[^>]*url="([^"]*)"/u), page = path.match(/<(?:parent|ancestor-\d+)-page\s[^>]*url="([^"]*)"[^>]*title="([^"]*)"/u);
  const parent = source ? { title: unescape(source[1]) || 'Untitled database', link: database?.[1]?.startsWith('https://') ? database[1] : null, kind: 'database' as const }
    : page ? { title: unescape(page[2]) || 'Untitled page', link: page[1].startsWith('https://') ? page[1] : null, kind: 'page' as const } : undefined;
  const link = typeof fetched.url === 'string' && fetched.url.startsWith('https://') ? fetched.url : url.startsWith('https://') ? url : null;
  // Only an emoji icon is shown; file icons are signed links that expire.
  const iconTag = text.match(/<page\s[^>]*icon="([^"]*)"/u)?.[1], icon = iconTag && !/^(attachment|notion-file-block|https?|icons\/):?/u.test(iconTag) && iconTag.length <= 8 ? iconTag : undefined;
  return { kind: 'page', title, ...(icon ? { icon } : {}), url, link, properties, ...(titleProperty ? { titleProperty } : {}), content, units, ...(parent ? { parent } : {}), ...(typeof fetched.page_last_edited_at === 'string' ? { editedAt: fetched.page_last_edited_at } : {}), fetchedAt: new Date().toISOString() };
}
