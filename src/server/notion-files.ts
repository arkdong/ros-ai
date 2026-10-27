import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { FILE_BYTES } from '../shared/files.js';
import { readLimited } from './papers.js';
import { privateAddress } from './private-address.js';
import type { AppTool, RemoteApps } from './remote-apps.js';
import { StoreError } from './store.js';

/** Files people uploaded to Notion (a CV in a database's Files column, a PDF or image in a page), saved into the
 * project folder so a File block can show them and ros.ai can read their text. Notion only hands out signed links
 * that expire within minutes, which agents cannot fetch themselves: ros.ai reads the page through the person's
 * Notion connection (read only), asks Notion for fresh links and downloads them here, only from Notion's own file
 * storage. Nothing is written to Notion. */

/** The tool ros.ai adds to the Notion app; Notion's own tools start with notion-, so the name never clashes. */
export const NOTION_SAVE_TOOL = 'ros-save-file';
const MAX_FILES = 5, TIMEOUT = 90_000;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
export const notionSaveSchema = z.object({
  page: z.string().trim().min(32).max(400).describe('The Notion page the file is on: its link or ID (for a database row, the row\'s page)'),
  property: z.string().trim().min(1).max(200).optional().describe('A Files column of that page, such as "CV": every file in it is saved'),
  references: z.array(z.string().trim().startsWith('notion-file-block://').max(2000)).min(1).max(MAX_FILES).optional().describe('Or files in the page\'s content: their notion-file-block:// references, exactly as notion-fetch shows them'),
  parentId: id.optional().describe('A group to put the File blocks in, such as the candidate\'s group, including one you proposed earlier in this turn that still waits for the person; left out, they go beside you'),
}).strict().refine(value => Boolean(value.property) !== Boolean(value.references), 'Give either property (a Files column) or references (files in the page\'s content), not both.');
export type NotionSaveInput = z.infer<typeof notionSaveSchema>;

export const notionSaveTool = (): AppTool => ({
  name: NOTION_SAVE_TOOL,
  description: 'ros.ai\'s own tool: save files uploaded to a Notion page (a Files column such as a CV, or a PDF or image block in its content) into the project folder\'s files/ and add each as a File block, proposed under the project\'s approval mode. ros.ai then reads a PDF\'s text into its block. Use it whenever you need a Notion file\'s contents: Notion\'s download links expire in minutes and you cannot fetch them yourself. Saves PDF, PNG and JPEG files. Reads Notion only; nothing changes there.',
  inputSchema: z.toJSONSchema(notionSaveSchema, { io: 'input' }) as Record<string, unknown>,
  reads: false, proposes: true,
});

/** Notion keeps uploads in its own S3 buckets and serves some through its own domains; nothing else is fetched. */
export function notionFileHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return /^prod-files-secure\.s3\.[a-z0-9-]+\.amazonaws\.com$/u.test(host)
    || (/^s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/u.test(host) && url.pathname.startsWith('/secure.notion-static.com/'))
    || /(^|\.)(notion\.so|notion\.com|notion-static\.com|notionusercontent\.com)$/u.test(host);
}

type Kind = { extension: '.pdf' | '.png' | '.jpg'; label: string };
function sniff(bytes: Buffer): Kind | undefined {
  const pdf = bytes.subarray(0, 1024).indexOf('%PDF-');
  if (pdf >= 0) return { extension: '.pdf', label: 'PDF' };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: '.png', label: 'PNG image' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: '.jpg', label: 'JPEG image' };
  return undefined;
}
/** The file's own name: the last part of Notion's storage path, or the name in a notion-file-block:// reference. */
function nameOf(href: string, reference?: string): string {
  const fromReference = reference ? new URL(reference.replace(/^notion-file-block:/u, 'https:')).searchParams.get('name') : null;
  if (fromReference) return fromReference.slice(0, 160);
  try { return decodeURIComponent(new URL(href).pathname.split('/').filter(Boolean).at(-1) ?? 'file').slice(0, 160); } catch { return 'file'; }
}
const stem = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/iu, '');
const clean = (text: string, max = 300) => text.replace(/[\x00-\x1f\x7f]/gu, ' ').trim().slice(0, max);

export type NotionFile = { name: string; fileName: string; bytes: Buffer; label: string };
export type NotionFiles = { title: string; link: string; property: string | null; files: NotionFile[]; problems: string[] };
type Json = Record<string, unknown>;
type Options = { fetcher?: typeof fetch; lookup?: (host: string) => Promise<{ address: string }[]>; isAllowed?: (url: URL) => boolean };

export class NotionFileSaver {
  private readonly fetcher: typeof fetch;
  private readonly lookup: (host: string) => Promise<{ address: string }[]>;
  private readonly isAllowed: (url: URL) => boolean;
  constructor(private readonly apps: Pick<RemoteApps, 'connected' | 'call'>, options: Options = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.lookup = options.lookup ?? (host => dnsLookup(host, { all: true }));
    this.isAllowed = options.isAllowed ?? notionFileHost;
  }
  offered() { return this.apps.connected().includes('notion'); }
  private async call(tool: string, args: Json, signal?: AbortSignal): Promise<Json> {
    const result = await this.apps.call('notion', tool, args, signal);
    if (result.isError) throw new StoreError(`Notion: ${clean(result.text.replace(/\\+/gu, '').match(/"message":\s*"(.+?)"\s*[,}]/u)?.[1] ?? result.text)}`, 502);
    try { return JSON.parse(result.text) as Json; } catch { return { text: result.text }; }
  }
  /** Reads the page, finds the files the input names, gets fresh links for them and downloads each. */
  async files(input: NotionSaveInput, signal?: AbortSignal): Promise<NotionFiles> {
    const fetched = await this.call('notion-fetch', { id: input.page }, signal);
    const text = String(fetched.text ?? '');
    if (!/<page\s/u.test(text) && fetched.metadata && (fetched.metadata as Json).type !== 'page') throw new StoreError('That Notion link is not a page. Give the page (or database row) the file is on.');
    const title = clean(String(fetched.title ?? ''), 120) || 'Notion page';
    const link = typeof fetched.url === 'string' && fetched.url.startsWith('https://') ? fetched.url.replace(/\?pvs=\d+$/u, '') : input.page;
    const problems: string[] = [], wanted: { href?: string; reference?: string }[] = [];
    if (input.property) {
      let properties: Json = {};
      try { properties = JSON.parse(text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/u)?.[1] ?? '{}') as Json; } catch { /* none */ }
      const value = properties[input.property];
      const fileColumns = Object.entries(properties).filter(([, item]) => Array.isArray(item) && item.some(entry => typeof entry === 'string' && /^(https:\/\/[^/]*amazonaws\.com\/|notion-file-block:\/\/)/u.test(entry))).map(([key]) => key);
      if (value === undefined) throw new StoreError(`${title} has no column called ${clean(input.property, 80)}.${fileColumns.length ? ` Its columns with files: ${fileColumns.join(', ')}.` : ''}`, 404);
      const entries = (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (!entries.length) return { title, link, property: input.property, files: [], problems: [`${clean(input.property, 80)} is empty on ${title}: no file was uploaded there.`] };
      for (const entry of entries.slice(0, MAX_FILES)) {
        if (entry.startsWith('notion-file-block://')) wanted.push({ reference: entry });
        else if (/^https:\/\//u.test(entry)) wanted.push({ href: entry });
        else problems.push(`${clean(entry, 80)} is not a file uploaded to Notion.`);
      }
      if (entries.length > MAX_FILES) problems.push(`Only the first ${MAX_FILES} files of ${clean(input.property, 80)} were saved.`);
    } else for (const reference of input.references ?? []) {
      if (!text.includes(reference)) problems.push(`${clean(reference, 120)} is not on ${title}; copy references exactly from notion-fetch.`);
      else wanted.push({ reference });
    }
    const references = wanted.flatMap(item => item.reference ? [item.reference] : []);
    if (references.length) {
      const signed = await this.call('notion-get-file-download-urls', { references }, signal);
      const found = signedUrls(signed, references);
      for (const item of wanted) if (item.reference) {
        const href = found.get(item.reference);
        if (href) item.href = href; else problems.push(`Notion gave no download link for ${nameOf('https://x/file', item.reference)}.`);
      }
    }
    const files: NotionFile[] = [];
    for (const item of wanted) {
      if (!item.href) continue;
      const name = nameOf(item.href, item.reference);
      try {
        const bytes = await this.download(item.href, signal), kind = sniff(bytes);
        if (!kind) { problems.push(`${name} is not a PDF, PNG or JPEG, so ros.ai cannot show it in a File block. Open it in Notion.`); continue; }
        files.push({ name, fileName: `${title} - ${stem(name)}${kind.extension}`, bytes, label: kind.label });
      } catch (error) {
        if (signal?.aborted) throw error;
        problems.push(`${name} could not be downloaded from Notion: ${error instanceof Error ? clean(error.message, 200) : 'it did not answer'}.`);
      }
    }
    return { title, link, property: input.property ?? null, files, problems };
  }
  /** Fetches a file from Notion's storage, following redirects by hand so every hop is checked. */
  private async download(href: string, signal?: AbortSignal, hops = 5): Promise<Buffer> {
    let current = href;
    for (let hop = 0; hop <= hops; hop++) {
      const url = new URL(current);
      if (!this.isAllowed(url)) throw new Error(`${url.hostname} is not Notion's file storage`);
      const host = url.hostname.replace(/^\[|\]$/gu, '');
      const addresses = isIP(host) ? [host] : (await this.lookup(host).catch(() => [])).map(item => item.address);
      if (!addresses.length || addresses.some(privateAddress)) throw new Error('not on the public internet');
      const response = await this.fetcher(url.href, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new Error('a redirect without an address');
        current = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(response.status === 403 ? 'the link expired or was refused (HTTP 403)' : `HTTP ${response.status}`); }
      try { return await readLimited(response, FILE_BYTES); }
      catch (error) { throw error instanceof Error && /larger/u.test(error.message) ? new Error(`it is larger than ${FILE_BYTES / 1_000_000} MB, the most a File block shows`) : error; }
    }
    throw new Error('too many redirects');
  }
}

/** The signed link Notion returned for each reference. Its answer lists resolved files with their reference and URL;
 * any https address next to a reference counts, so a small change in its shape does not break saving. */
export function signedUrls(answer: Json, references: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (value: unknown, key?: string) => {
    if (Array.isArray(value)) { value.forEach(item => visit(item)); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Json, strings = Object.values(object).filter((item): item is string => typeof item === 'string');
    const reference = strings.find(item => references.includes(item)) ?? (key && references.includes(key) ? key : undefined);
    const href = strings.find(item => /^https:\/\//u.test(item));
    if (reference && href && !found.has(reference)) found.set(reference, href);
    for (const [name, item] of Object.entries(object)) {
      if (typeof item === 'string' && references.includes(name) && /^https:\/\//u.test(item) && !found.has(name)) found.set(name, item);
      else if (item && typeof item === 'object') visit(item, name);
    }
  };
  visit(answer);
  // A plain-text answer: each reference followed by its link.
  if (!found.size && typeof answer.text === 'string') for (const reference of references) {
    const at = answer.text.indexOf(reference), href = at >= 0 ? answer.text.slice(at + reference.length).match(/https:\/\/[^\s"'<>)]+/u)?.[0] : undefined;
    if (href) found.set(reference, href);
  }
  return found;
}
