import type { NotionPage, NotionProperty } from '../shared/types.js';

/** A Notion page as ros.ai shows it, from the text Notion's hosted MCP returns for a page: the page's
 * properties (a JSON object), its content in Notion-flavored Markdown (CommonMark with Notion's own tags)
 * and the path above it. The content becomes the plain Markdown the canvas already renders. */

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
    .replace(/^(\s*)- \[( |x|X)\] /gmu, (_m, space, mark) => `${space}- ${mark.trim() ? '☑' : '☐'} `)
    .replace(/<\/?u>/gu, '').replace(/<span\s[^>]*>/gu, '').replace(/<\/span>/gu, '')
    .replace(/<br\s*\/?>/gu, '\n')
    .replace(/<(?:custom-block|external_object_instance|table-of-contents)\b[^>]*\/>/gu, '')
    .replace(/<external_object_instance\b[^>]*>[\s\S]*?<\/external_object_instance>/gu, '')
    .replace(/<meeting-notes-section-transcript\b[^>]*>[\s\S]*?<\/meeting-notes-section-transcript>/gu, '');
}

type Frame = { tag: string; marker: string; prefix: string; used: boolean; lines: number; list?: 'ul' | 'ol'; media?: string };
const MEDIA = ['image', 'pdf', 'file', 'audio', 'video', 'bookmark', 'embed'];
const HEADINGS: Record<string, string> = { h1: '# ', h2: '## ', h3: '### ', h4: '### ' };

/** The content of a page as plain Markdown: headings, lists, to-dos, quotes, callouts, tables and media
 * become their Markdown forms; columns, tabs and other containers only contribute what they hold. */
export function notionMarkdown(content: string, names: UserNames = () => undefined): string {
  const out: string[] = [], stack: Frame[] = [];
  let cell: string[] | null = null, row: string[] | null = null, tableRows = 0;
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  const emit = (line: string) => {
    const prefix = stack.map(frame => { const part = frame.used ? frame.prefix : frame.marker; frame.used = true; frame.lines++; return part; }).join('');
    out.push(`${prefix}${line}`.trimEnd());
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
  const BLOCK = ['h1', 'h2', 'h3', 'h4', 'p', 'toggle', 'quote', 'callout', 'li', 'todo', 'ul', 'ol', 'columns', 'column', 'tabs', 'tab', 'synced-block', 'synced-block-reference', 'meeting-notes', 'meeting-notes-section-notes', 'meeting-notes-section-summary', 'mail', 'table', ...MEDIA];
  for (const token of inline(content.replace(/\\</gu, '&lt;'), names).split(/(<\/?[a-zA-Z][\w-]*(?:\s[^<>]*?)?\/?>)/u)) {
    const tag = token.match(/^<(\/?)([a-zA-Z][\w-]*)(?:\s[^<>]*?)?(\/?)>$/u);
    if (!tag) {
      if (cell) { cell.push(unescape(token).replace(/\s+/gu, ' ').trim()); continue; }
      const lines = unescape(token).split('\n');
      // A blank line between top-level blocks is kept; inside a block its tags separate the children.
      for (const raw of lines) { const line = raw.trim(); if (line) emit(line); else if (!stack.length) blank(); }
      continue;
    }
    const [, closing, rawName, selfClosing] = tag, name = rawName.toLowerCase(), attrs = attributes(token);
    if (name === 'table' && !closing) { tableRows = 0; stack.push({ tag: name, marker: '', prefix: '', used: false, lines: 0 }); continue; }
    if (name === 'tr') { if (!closing) row = []; else if (row) { emit(`| ${row.join(' | ')} |`); if (tableRows++ === 0) emit(`| ${row.map(() => '---').join(' | ')} |`); row = null; } continue; }
    if (name === 'td' || name === 'th') { if (!closing) cell = []; else if (row && cell) { row.push(cell.join(' ').replace(/\|/gu, '\\|')); cell = null; } continue; }
    if (['colgroup', 'col', 'thead', 'tbody'].includes(name)) continue;
    if (selfClosing) { if (name === 'p') blank(); else if (MEDIA.includes(name)) { emit(`[${name}]${attrs.source || attrs.url ? `(${attrs.source || attrs.url})` : ''}`); } continue; }
    if (!closing) {
      if (!BLOCK.includes(name)) { stack.push({ tag: name, marker: '', prefix: '', used: false, lines: 0 }); continue; }
      stack.push({ ...open(name, attrs), used: false, lines: 0 });
      continue;
    }
    const index = stack.map(frame => frame.tag).lastIndexOf(name);
    if (index < 0) continue;
    const [frame] = stack.splice(index, stack.length - index);
    if (frame.media && !frame.lines) emit(frame.media);
    if (['h1', 'h2', 'h3', 'h4', 'p', 'toggle', 'quote', 'callout', 'li', 'todo', 'ul', 'ol', 'table', ...MEDIA].includes(frame.tag) && stack.length === 0) blank();
  }
  // Notion separates every block with a blank line; neighbouring list items read as one list without it.
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/^(\s*(?:- |1\. ).*)\n\n(?=\s*(?:- |1\. ))/gmu, '$1\n').trim().slice(0, CONTENT_CHARACTERS);
}

/** One property value as text, with the pages or addresses it points to. */
function property(name: string, raw: unknown, names: UserNames): NotionProperty {
  const links: { text: string; url: string }[] = [];
  const text = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' && /^\[.*\]$/su.test(value)) { try { return text(JSON.parse(value)); } catch { /* plain text */ } }
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
    if (value === '__YES__') return 'Yes';
    if (value === '__NO__') return 'No';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const item = String(value);
    if (/^https?:\/\//u.test(item)) { links.push({ text: /notion\.(so|site|com)\//u.test(item) ? 'page' : item.replace(/^https?:\/\//u, '').slice(0, 60), url: item }); return ''; }
    if (/^(rollupResult|file|collection):\/\//u.test(item)) return '';
    return notionMarkdown(item, names).replace(/\n+/gu, ' ').trim();
  };
  const value = text(raw).slice(0, VALUE_CHARACTERS);
  return { name, value: value || (links.length ? `${links.length} ${links.length === 1 ? 'page' : 'pages'}` : ''), ...(links.length ? { links } : {}) };
}

/** The properties in the order the database lists them (its SQLite schema), the title first, then any others. */
export function notionProperties(propertiesJson: string, schema: string, title: string, names: UserNames): NotionProperty[] {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(propertiesJson) as Record<string, unknown>; } catch { return []; }
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
  const dateText = (value: { start?: string; end?: string; datetime?: boolean }) => { const at = (iso?: string) => iso ? (value.datetime ? iso.replace('T', ' ').replace(/(:\d\d)(?::\d\d)?(\.\d+)?(Z|[+-]\d\d:\d\d)?$/u, '$1') : iso.slice(0, 10)) : ''; const start = at(value.start), end = at(value.end); return end ? `${start} – ${end}` : start; };
  const order = [...schema.matchAll(/^\s*"((?:[^"]|"")+)"\s+(?:TEXT|FLOAT|INTEGER|REAL)/gmu)].map(match => match[1].replace(/""/gu, '"').replace(/^date:(.+):(?:start|end|is_datetime)$/u, '$1'));
  const rank = (name: string) => { const index = order.indexOf(name); return index < 0 ? order.length : index; };
  const names$ = [...merged.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const titleKey = names$.find(name => typeof merged.get(name) === 'string' && merged.get(name) === title);
  return [...(titleKey ? [titleKey] : []), ...names$.filter(name => name !== titleKey)].map(name => {
    const value = merged.get(name);
    return value && typeof value === 'object' && !Array.isArray(value) && ('start' in value || 'end' in value || 'datetime' in value) ? { name, value: dateText(value as { start?: string; end?: string; datetime?: boolean }) } : property(name, value, names);
  });
}

/** Every user:// address a page's text names, so their names can be looked up before the page is shown. */
export const userIds = (text: string) => [...new Set([...text.matchAll(/user:\/\/([0-9a-f-]{36})/gu)].map(match => match[1]))];

/** The page from the fetch result's text. */
export function notionPage(fetched: { text?: unknown; title?: unknown; url?: unknown; page_last_edited_at?: unknown }, url: string, names: UserNames): NotionPage {
  const text = String(fetched.text ?? '');
  const title = String(fetched.title ?? '').trim() || 'Untitled';
  const properties = notionProperties(text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/u)?.[1] ?? '{}', text.match(/<sqlite-table>([\s\S]*?)<\/sqlite-table>/u)?.[1] ?? '', title, names);
  const content = notionMarkdown(text.match(/<content>([\s\S]*?)<\/content>/u)?.[1] ?? '', names);
  const path = text.match(/<ancestor-path>([\s\S]*?)<\/ancestor-path>/u)?.[1] ?? '';
  const source = path.match(/<parent-data-source\s[^>]*name="([^"]*)"/u), database = path.match(/<ancestor-\d+-database\s[^>]*url="([^"]*)"/u), page = path.match(/<(?:parent|ancestor-\d+)-page\s[^>]*url="([^"]*)"[^>]*title="([^"]*)"/u);
  const parent = source ? { title: unescape(source[1]) || 'Untitled database', link: database?.[1]?.startsWith('https://') ? database[1] : null, kind: 'database' as const }
    : page ? { title: unescape(page[2]) || 'Untitled page', link: page[1].startsWith('https://') ? page[1] : null, kind: 'page' as const } : undefined;
  const link = typeof fetched.url === 'string' && fetched.url.startsWith('https://') ? fetched.url : url.startsWith('https://') ? url : null;
  return { kind: 'page', title, url, link, properties, content, ...(parent ? { parent } : {}), ...(typeof fetched.page_last_edited_at === 'string' ? { editedAt: fetched.page_last_edited_at } : {}), fetchedAt: new Date().toISOString() };
}
