/** A shared canvas: the clean copy ros.ai builds when someone shares a project, and what a canvas file carries.
 * It has its own shape instead of the project's, so only what is written here can ever travel. A new field on a
 * block stays home until someone adds it to this shape on purpose. */

export const SHARE_KIND = 'ros-canvas';
export const SHARE_VERSION = 1;
/** The most the pictures and PDFs in one canvas file add up to. */
export const SHARE_FILE_BYTES = 50_000_000;
/** The most rows a shared table keeps. */
export const SHARE_TABLE_ROWS = 2_000;
/** The most characters a shared text keeps. */
export const SHARE_TEXT = 100_000;

export type ShareBox = { x: number; y: number; width: number; height: number };

/** What a block shows. */
export type ShareFace =
  | { type: 'text'; markdown: string }
  | { type: 'code'; language: string; source: string }
  | { type: 'table'; columns: string[]; rows: string[][]; total: number }
  | { type: 'picture'; file?: string; src?: string; width?: number; height?: number }
  | { type: 'pdf'; file: string }
  | { type: 'numbers'; values: { label: string; value: string; note?: string }[] }
  | { type: 'pins'; pins: { name: string; lat: number; lng: number; note?: string }[] }
  | { type: 'app'; source: string }
  | { type: 'post'; title?: string; text: string; author: string; community?: string; url: string; counts: Record<string, number> }
  | { type: 'group'; note: string }
  | { type: 'left'; note: string }
  | { type: 'empty' };

export type ShareNode = {
  id: string; title: string; kindName: string; label?: string; parentId?: string;
  /** Where it sits, as it was shown when shared. Blocks inside a closed Group have none. */
  box?: ShareBox;
  /** A Group shown open, as a frame around its blocks. */
  open?: boolean;
  face: ShareFace;
  /** For a live block (Notion, Google, Metrics): where it was read from, and when, without any account or address. */
  snapshot?: { from: string; at?: string };
  /** For an Agent block, with Agent details switched on. */
  agent?: { runtime: string; model?: string };
};
export type ShareLink = { id: string; source: string; target: string; label: string };
export type ShareFile = { name: string; mediaType: string; size: number; width?: number; height?: number };
export type ShareMessage = { role: 'user' | 'assistant'; text: string; at: string };

export type ShareCopy = {
  kind: typeof SHARE_KIND; version: typeof SHARE_VERSION;
  title: string; sharedAt: string;
  nodes: ShareNode[]; links: ShareLink[];
  files: Record<string, ShareFile>;
  conversation?: ShareMessage[];
};
/** A canvas file's data: the copy and its files as base64. */
export type ShareBundle = ShareCopy & { data: Record<string, string> };

/** What the person chose in the Share sheet. */
export type ShareChoices = {
  /** Blocks and Groups to leave out; a Group takes everything inside it. */
  leaveOut: string[];
  files: boolean;
  live: boolean;
  conversation: boolean;
  agentDetails: boolean;
  /** Finds to show again, by id. Keys can never be shown. */
  reveal: string[];
  /** Where each block is shown now, so the copy looks like the canvas does. */
  layout?: Record<string, ShareBox>;
  /** Groups shown open now. */
  open?: string[];
};
export const DEFAULT_SHARE_CHOICES: ShareChoices = { leaveOut: [], files: true, live: true, conversation: false, agentDetails: false, reveal: [] };

export type FindKind = 'email' | 'phone' | 'key' | 'path' | 'address';
/** Something personal found inside the copy's text. `shown` is a safe way to name it in the sheet. */
export type ShareFind = { id: string; kind: FindKind; shown: string; count: number; blocks: string[]; revealed: boolean };
export type SharePreview = { copy: ShareCopy; finds: ShareFind[]; bytes: number; counts: { blocks: number; total: number; files: number; live: number; messages: number; agents: number } };

export const FIND_NAMES: Record<FindKind, [one: string, many: string]> = {
  email: ['email address', 'email addresses'], phone: ['phone number', 'phone numbers'], key: ['key or password', 'keys or passwords'],
  path: ['home folder path', 'home folder paths'], address: ['private network address', 'private network addresses'],
};
const PLACEHOLDER: Record<FindKind, string> = { email: '[email]', phone: '[phone]', key: '[key]', path: '~', address: '[address]' };

type Pattern = { kind: FindKind; pattern: RegExp; group?: string };
// Keys first: a key can look like other things, and the first pattern to claim text wins.
const PATTERNS: Pattern[] = [
  { kind: 'key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu },
  { kind: 'key', pattern: /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9-]{16,}|re_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gu },
  // A value given to something named like a key: api_key = "…", TOKEN: …, password=…
  { kind: 'key', pattern: /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?(?<value>[^\s"',;()[\]{}]{8,})/giu, group: 'value' },
  { kind: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gu },
  { kind: 'path', pattern: /(?:\/Users\/|\/home\/)[^/\s'"`)\]]+|[A-Za-z]:\\Users\\[^\\\s'"`)\]]+/gu },
  { kind: 'address', pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/gu },
  // Needs a + or separators between groups, so plain numbers in a table, dates and versions are left alone.
  { kind: 'phone', pattern: /(?<![\w.+-])(?:\+\d[\d ().-]{6,}\d|\(?\d{2,5}\)?[ .-]\d{2,5}(?:[ .-]\d{2,5}){1,3})(?![\w-]|\.\d)/gu },
];

export type Match = { kind: FindKind; start: number; end: number; text: string };
const digits = (text: string) => text.replace(/\D/gu, '').length;
const isDate = (text: string) => /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/u.test(text.trim());

/** Everything personal in one text, in order, without overlaps. */
export function scanText(text: string): Match[] {
  const found: Match[] = [];
  const taken = (start: number, end: number) => found.some(match => start < match.end && end > match.start);
  for (const { kind, pattern, group } of PATTERNS) {
    for (const hit of text.matchAll(pattern)) {
      const value = group ? hit.groups?.[group] : hit[0];
      if (!value || hit.index === undefined) continue;
      const start = group ? hit.index + hit[0].lastIndexOf(value) : hit.index, end = start + value.length;
      if (kind === 'phone' && (!value.trim().startsWith('+') && digits(value) < 9 || digits(value) > 15 || isDate(value))) continue;
      // A name in code (API_KEY, settings.token) is not a secret; a value with letters and digits, or a long one, is.
      if (kind === 'key' && group && (/^(?:\$\{|process\.env|os\.environ|<)/u.test(value) || !(/\d/u.test(value) && /[a-z]/iu.test(value) || value.length >= 24) || /^[A-Za-z_][\w.]*$/u.test(value) && !/\d/u.test(value))) continue;
      if (!taken(start, end)) found.push({ kind, start, end, text: value });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A find's id: the same text found in several blocks is one find. */
export function findId(kind: FindKind, text: string) {
  let hash = 2166136261;
  for (const char of `${kind}\n${text}`) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619) >>> 0; }
  return `${kind}-${hash.toString(36)}`;
}
/** How the sheet names a find without showing a key. */
export function shownFind(kind: FindKind, text: string) {
  if (kind === 'key') return `${text.slice(0, 4)}…${text.length > 12 ? text.slice(-2) : ''}`;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Collects finds over the copy's texts and hides those not shown again. */
export class Redactor {
  private readonly finds = new Map<string, ShareFind>();
  constructor(private readonly reveal: ReadonlySet<string>) {}
  clean(text: string, block?: string): string {
    if (!text) return text;
    const matches = scanText(text);
    if (!matches.length) return text;
    let output = '', at = 0;
    for (const match of matches) {
      const id = findId(match.kind, match.text), revealed = match.kind !== 'key' && this.reveal.has(id);
      const find = this.finds.get(id) ?? { id, kind: match.kind, shown: shownFind(match.kind, match.text), count: 0, blocks: [], revealed };
      find.count++; if (block && !find.blocks.includes(block)) find.blocks.push(block);
      this.finds.set(id, find);
      output += text.slice(at, match.start) + (revealed ? match.text : PLACEHOLDER[match.kind]); at = match.end;
    }
    return output + text.slice(at);
  }
  list(): ShareFind[] {
    const order: FindKind[] = ['key', 'email', 'phone', 'path', 'address'];
    return [...this.finds.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.count - a.count);
  }
}

/** A file name for the canvas file, from the project's title. */
export function shareFileName(title: string) {
  const base = title.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80) || 'Canvas';
  return `${base}.ros.html`;
}

/** Reads a canvas file's data back, checking its shape. Only data is read; the file's own script is never run. */
export function readShareBundle(value: unknown): ShareBundle | null {
  if (!value || typeof value !== 'object') return null;
  const bundle = value as Partial<ShareBundle>;
  return bundle.kind === SHARE_KIND && bundle.version === SHARE_VERSION && typeof bundle.title === 'string' && Array.isArray(bundle.nodes) && Array.isArray(bundle.links)
    && bundle.files && typeof bundle.files === 'object' && bundle.data && typeof bundle.data === 'object' ? bundle as ShareBundle : null;
}
