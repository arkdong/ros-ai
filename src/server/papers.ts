import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Express } from 'express';
import { z } from 'zod';
import { FILE_BYTES } from '../shared/files.js';
import { DOI, PAPER_ID, PAPER_SOURCES, paperSourceName, type PaperSearch, type PaperSummary, type PapersStatus } from '../shared/papers.js';
import type { CanvasNode, PaperRef, PaperSource } from '../shared/types.js';
import { privateAddress } from './private-address.js';
import type { ProjectFolders } from './project-folders.js';
import type { AppTool, BuiltInApp } from './remote-apps.js';
import { StoreError, type Store } from './store.js';

/** Papers from three places: OpenAlex (an open index of scholarly works, with links to their open-access PDFs), arXiv
 * (preprints, each with its PDF) and the person's own Zotero library (with the PDFs Zotero stores). The person searches
 * them from Add block › Paper. Agents search them once OpenAlex or arXiv is turned on in Plugins, or Zotero's key is
 * saved there (PapersApp below). A paper becomes a File block with its open PDF, saved into the project folder so
 * agents read its text through the File block, or a Text block with the reference and abstract. */

const USER_AGENT = 'ros.ai (https://github.com/arkdong/ros-ai)';
const BASES = { openalex: 'https://api.openalex.org', arxiv: 'https://export.arxiv.org/api/query', arxivPdf: 'https://arxiv.org/pdf/', zotero: 'https://api.zotero.org' };
/** arXiv asks API clients for one request at a time, at least three seconds apart; its PDFs wait their turn too. */
const ARXIV_SPACING = 3_000;
const API_BYTES = 8_000_000, TIMEOUT = 20_000, PDF_TIMEOUT = 90_000;
/** A search is reused for ten minutes (OpenAlex counts each one against a daily allowance), a library search for one. */
const SEARCH_TTL = 10 * 60_000, LIBRARY_TTL = 60_000, PAPER_TTL = 60 * 60_000, KEPT = 500;
const ABSTRACT = 5_000, AUTHORS = 100, TEXT = 20_000;
const OPENALEX_FIELDS = 'id,doi,display_name,publication_year,publication_date,type,cited_by_count,authorships,primary_location,best_oa_location,locations,abstract_inverted_index';
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are', 'with', 'by', 'from', 'at', 'as', 'be', 'we', 'our', 'you', 'your', 'all', 'it', 'its', 'this', 'that', 'via', 'into']);

/** A paper as ros.ai keeps it while it is shown or added: pdfs are open PDF addresses, best first; zoteroFile is the
 * key of the PDF attachment Zotero stores for it. */
export type Paper = PaperSummary & { date: string | null; kind: string | null; pdfs: string[]; zoteroFile: string | null };
type Options = { fetcher?: typeof fetch; lookup?: (host: string) => Promise<{ address: string }[]>; bases?: Partial<typeof BASES>; spacing?: number };
type Keys = { openalex: () => string | undefined; zotero: () => string | undefined };
type Settings = { openalex: boolean; arxiv: boolean };
export type SearchOptions = { limit: number; yearFrom?: number; yearTo?: number; openOnly?: boolean; sort?: 'relevance' | 'newest' | 'most_cited' };

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '').trim().slice(0, max) : '';
const oneLine = (value: unknown, max: number) => clean(typeof value === 'string' ? value.replace(/\s+/gu, ' ') : value, max);
const yearOf = (value: unknown) => { const year = Number(/\b(1[5-9]\d\d|20\d\d|2100)\b/u.exec(String(value ?? ''))?.[1]); return Number.isInteger(year) ? year : null; };
/** A web address, only http(s): links come from records anyone can edit upstream. */
const webLink = (value: unknown) => { try { const url = new URL(clean(value, 2000)); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; } };
/** A DOI from a bare DOI, a doi.org link or "doi:…", without its prefix. */
export function doiOf(value: unknown): string | null {
  const text = clean(value, 400).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, '');
  return DOI.test(text) ? text : null;
}
/** An arXiv ID from a bare ID, "arXiv:…" or an arxiv.org address: 1706.03762v7 or hep-th/9901001. */
export function arxivIdOf(value: unknown): string | null {
  const text = clean(value, 400).replace(/^arxiv:\s*/iu, '').replace(/^https?:\/\/(?:export\.|www\.)?arxiv\.org\/(?:abs|pdf)\//iu, '').replace(/\.pdf$/iu, '');
  return PAPER_ID.test(`arxiv:${text}`) ? text : null;
}
const withoutVersion = (id: string) => id.replace(/v\d+$/u, '');

/** The abstract OpenAlex keeps as an index of words and their places. */
function invertedAbstract(index: unknown): string | null {
  if (!index || typeof index !== 'object') return null;
  const words: string[] = [];
  for (const [word, places] of Object.entries(index)) if (Array.isArray(places)) for (const place of places) if (Number.isInteger(place) && place >= 0 && place < 20_000) words[place] = word;
  return oneLine(words.filter(Boolean).join(' '), ABSTRACT) || null;
}

type Location = { is_oa?: unknown; pdf_url?: unknown; landing_page_url?: unknown; source?: { display_name?: unknown } | null };
function openalexPaper(value: unknown): Paper | null {
  const work = value as { id?: unknown; doi?: unknown; display_name?: unknown; publication_year?: unknown; publication_date?: unknown; type?: unknown; cited_by_count?: unknown; authorships?: unknown; primary_location?: Location | null; best_oa_location?: Location | null; locations?: unknown; abstract_inverted_index?: unknown };
  const id = /^https:\/\/openalex\.org\/(W\d{1,15})$/u.exec(clean(work?.id, 100))?.[1], title = oneLine(work?.display_name, 1000);
  if (!id || !title) return null;
  const authors = (Array.isArray(work.authorships) ? work.authorships : []).slice(0, AUTHORS).flatMap(item => { const name = oneLine((item as { author?: { display_name?: unknown } })?.author?.display_name ?? (item as { raw_author_name?: unknown })?.raw_author_name, 200); return name ? [name] : []; });
  const doi = doiOf(work.doi), locations = [work.best_oa_location, ...(Array.isArray(work.locations) ? work.locations as Location[] : [])];
  // The best open copy first, then any other open copy with a PDF; three at most, since each may fail.
  const pdfs = [...new Set(locations.flatMap(location => location && location.is_oa === true ? [webLink(location.pdf_url)].filter((link): link is string => Boolean(link)) : []))].slice(0, 3);
  const cited = Number(work.cited_by_count);
  return { id: `openalex:${id}`, source: 'openalex', title, authors, year: Number.isInteger(work.publication_year) ? work.publication_year as number : yearOf(work.publication_date), date: clean(work.publication_date, 20) || null,
    venue: oneLine(work.primary_location?.source?.display_name, 300) || null, doi, link: doi ? `https://doi.org/${doi}` : webLink(work.primary_location?.landing_page_url) ?? `https://openalex.org/${id}`,
    abstract: invertedAbstract(work.abstract_inverted_index), pdf: pdfs.length > 0, citedBy: Number.isInteger(cited) && cited >= 0 ? cited : null, kind: oneLine(work.type, 60) || null, pdfs, zoteroFile: null };
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const codePoint = (code: number) => code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
const xmlText = (value: string) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1').replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/giu, (_, decimal?: string, hex?: string, name?: string) => decimal ? codePoint(Number(decimal)) : hex ? codePoint(parseInt(hex, 16)) : XML_ENTITIES[name!.toLowerCase()]);
/** The text of an element's first appearance, whatever its namespace prefix (arxiv:doi, opensearch:totalResults). */
const element = (xml: string, name: string) => { const found = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'u').exec(xml); return found ? xmlText(found[1]) : null; };
const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/gu)].map(([, name, value]) => [name, xmlText(value)]));

/** arXiv answers in Atom; this reads the few elements a paper needs, without an XML library. */
export function arxivPapers(xml: string, pdfBase = BASES.arxivPdf): { papers: Paper[]; total: number | null } {
  const papers: Paper[] = [];
  for (const [, entry] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gu)) {
    const address = element(entry, 'id') ?? '';
    if (/\/api\/errors/u.test(address)) throw new StoreError(`arXiv did not accept the search: ${oneLine(element(entry, 'summary'), 300) || 'it gave no reason'}.`);
    const id = arxivIdOf(address), title = oneLine(element(entry, 'title'), 1000);
    if (!id || !title) continue;
    const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gu)].slice(0, AUTHORS).flatMap(([, author]) => { const name = oneLine(element(author, 'name'), 200); return name ? [name] : []; });
    const published = clean(element(entry, 'published'), 40), category = attributes(/<(?:[\w-]+:)?primary_category\b[^>]*>/u.exec(entry)?.[0] ?? '').term;
    const journal = oneLine(element(entry, 'journal_ref'), 300), doi = doiOf(element(entry, 'doi')) ?? `10.48550/arXiv.${withoutVersion(id)}`;
    papers.push({ id: `arxiv:${id}`, source: 'arxiv', title, authors, year: yearOf(published), date: published.slice(0, 10) || null, venue: journal || `arXiv${category ? ` (${oneLine(category, 40)})` : ''}`, doi,
      link: `https://arxiv.org/abs/${id}`, abstract: oneLine(element(entry, 'summary'), ABSTRACT) || null, pdf: true, citedBy: null, kind: journal ? 'article' : 'preprint', pdfs: [`${pdfBase}${id}`], zoteroFile: null });
  }
  const total = Number(element(xml, 'totalResults'));
  return { papers, total: Number.isInteger(total) ? total : null };
}

type ZoteroItem = { key?: unknown; data?: Record<string, unknown>; meta?: { parsedDate?: unknown }; links?: { attachment?: { href?: unknown; attachmentType?: unknown }; alternate?: { href?: unknown } } };
/** An item of the person's Zotero library; its PDF is the attachment Zotero names as best, when Zotero stores it. */
function zoteroPaper(value: unknown): Paper | null {
  const item = value as ZoteroItem, data = item?.data ?? {}, key = clean(item?.key, 20);
  if (!/^[A-Z0-9]{8}$/u.test(key) || ['attachment', 'note', 'annotation'].includes(String(data.itemType))) return null;
  const title = oneLine(data.title ?? data.caseName ?? data.subject, 1000);
  if (!title) return null;
  const creators = (Array.isArray(data.creators) ? data.creators : []) as { creatorType?: unknown; name?: unknown; firstName?: unknown; lastName?: unknown }[];
  const named = creators.filter(creator => creator.creatorType === 'author').length ? creators.filter(creator => creator.creatorType === 'author') : creators;
  const authors = named.slice(0, AUTHORS).flatMap(creator => { const name = oneLine(creator.name ?? [creator.firstName, creator.lastName].filter(part => typeof part === 'string' && part.trim()).join(' '), 200); return name ? [name] : []; });
  const doi = doiOf(data.DOI) ?? doiOf(/^DOI:\s*(\S+)\s*$/imu.exec(clean(data.extra, 5000))?.[1]);
  const venue = ['publicationTitle', 'proceedingsTitle', 'conferenceName', 'bookTitle', 'websiteTitle', 'repository', 'publisher', 'university', 'institution'].map(field => oneLine(data[field], 300)).find(Boolean) || null;
  const attachment = item.links?.attachment, file = attachment?.attachmentType === 'application/pdf' ? /\/items\/([A-Z0-9]{8})$/u.exec(clean(attachment.href, 500))?.[1] ?? null : null;
  return { id: `zotero:${key}`, source: 'zotero', title, authors, year: yearOf(item.meta?.parsedDate) ?? yearOf(data.date), date: clean(item.meta?.parsedDate, 20) || null, venue, doi,
    link: webLink(data.url) ?? (doi ? `https://doi.org/${doi}` : webLink(item.links?.alternate?.href) ?? 'https://www.zotero.org/'), abstract: oneLine(data.abstractNote, ABSTRACT) || null,
    pdf: Boolean(file), citedBy: null, kind: oneLine(data.itemType, 60) || null, pdfs: [], zoteroFile: file };
}

/** Reads a response's body up to a size, without trusting its declared length. */
export async function readLimited(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (declared > maximum) { await response.body?.cancel().catch(() => undefined); throw new TooLarge(); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  for (let size = 0; ;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > maximum) { await reader.cancel().catch(() => undefined); throw new TooLarge(); }
    chunks.push(Buffer.from(value));
  }
}
class TooLarge extends Error { constructor() { super('larger than ros.ai reads'); } }

export class Papers {
  private readonly fetcher: typeof fetch;
  private readonly lookup: (host: string) => Promise<{ address: string }[]>;
  private readonly bases: typeof BASES;
  private readonly spacing: number;
  /** Hosts ros.ai calls by name (its own settings), so their addresses are not checked like a PDF link's. */
  private readonly fixed: Set<string>;
  private readonly searches = new Map<string, { at: number; result: PaperSearch }>();
  private readonly kept = new Map<string, { at: number; paper: Paper }>();
  private arxivQueue: Promise<unknown> = Promise.resolve();
  private arxivNext = 0;
  private zoteroUser: { digest: string; userID: number; username: string } | null = null;
  private zoteroWait = 0;
  constructor(private readonly store: Store, private readonly keys: Keys, options: Options = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.lookup = options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true }));
    this.bases = { ...BASES, ...options.bases };
    this.spacing = options.spacing ?? ARXIV_SPACING;
    this.fixed = new Set(Object.values(this.bases).map(base => new URL(base).hostname));
  }

  private settings(): Settings { const saved = this.store.globalRecord<Partial<Settings>>('papers', 'agents'); return { openalex: saved?.openalex === true, arxiv: saved?.arxiv === true }; }
  /** Sources the person searches from Add block › Paper: OpenAlex and arXiv are public; Zotero needs its key. */
  personSources(): PaperSource[] { return ['openalex', 'arxiv', ...(this.keys.zotero() ? ['zotero' as const] : [])]; }
  /** Sources every agent uses: what the person turned on in Plugins, and Zotero once its key is saved. */
  agentSources(): PaperSource[] { const on = this.settings(); return PAPER_SOURCES.map(item => item.id).filter(id => id === 'zotero' ? Boolean(this.keys.zotero()) : on[id]); }
  status(): PapersStatus {
    const on = this.settings(), zotero = Boolean(this.keys.zotero());
    return { sources: PAPER_SOURCES.map(({ id, name }) => ({ id, name, available: id !== 'zotero' || zotero, agents: id === 'zotero' ? zotero : on[id], key: id === 'openalex' ? Boolean(this.keys.openalex()) : id === 'zotero' && zotero, account: id === 'zotero' && zotero && this.zoteroUser ? this.zoteroUser.username : null })) };
  }
  setAgents(source: 'openalex' | 'arxiv', on: boolean): PapersStatus {
    this.store.saveGlobalRecord('papers', 'agents', { ...this.settings(), [source]: on });
    return this.status();
  }

  private remember(paper: Paper) {
    this.kept.delete(paper.id);
    this.kept.set(paper.id, { at: Date.now(), paper });
    for (const [id] of this.kept) { if (this.kept.size <= KEPT) break; this.kept.delete(id); }
    return paper;
  }
  private known(id: string) { const kept = this.kept.get(id); return kept && Date.now() - kept.at < PAPER_TTL ? kept.paper : undefined; }

  private request(url: string, headers: Record<string, string>, signal?: AbortSignal, redirect: RequestRedirect = 'error', timeout = TIMEOUT) {
    const limit = AbortSignal.timeout(timeout);
    return this.fetcher(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, redirect, signal: signal ? AbortSignal.any([signal, limit]) : limit });
  }
  /** Why a source refused, in words the person can act on. */
  private refusal(source: PaperSource, response: Response, single = false): StoreError {
    const status = response.status, wait = Number(response.headers.get('retry-after'));
    if (source === 'zotero') {
      if (status === 403) return new StoreError('Zotero did not accept the key on its Plugins card, or the key cannot read your library. Replace it there.', 502);
      if (status === 404) return new StoreError(single ? 'That item is not in your Zotero library.' : 'Zotero could not find your library.', 404);
      if (status === 429 || status === 503) { this.zoteroWait = Date.now() + (wait > 0 ? wait : 30) * 1000; return new StoreError(`Zotero asks ros.ai to wait ${wait > 0 ? `${Math.ceil(wait)} seconds` : 'a moment'}; try again then.`, 503); }
    } else if (source === 'openalex') {
      if (status === 429) return new StoreError(this.keys.openalex() ? 'Your OpenAlex key’s daily allowance is used up. It starts again at midnight UTC.' : 'OpenAlex’s free daily allowance without a key is used up. Add a free OpenAlex key on the Plugins page, or try again after midnight UTC.', 429);
      if (status === 401 && this.keys.openalex()) return new StoreError('OpenAlex did not accept the key on its Plugins card. Replace or remove it there.', 502);
      if (status === 403) return new StoreError(`OpenAlex refused the request: too many at once${this.keys.openalex() ? ', or the key on its Plugins card is not accepted' : ''}. Try again in a minute.`, 503);
      if (status === 404 && single) return new StoreError('OpenAlex has no paper with that ID or DOI.', 404);
    } else if (status === 429 || status === 503) return new StoreError('arXiv asks ros.ai to slow down. Try again in a minute.', 503);
    return new StoreError(`${paperSourceName(source)} answered with HTTP ${status}.`, 502);
  }
  private async json(source: PaperSource, url: string, headers: Record<string, string>, signal?: AbortSignal, single = false): Promise<{ body: unknown; response: Response }> {
    let response: Response;
    try { response = await this.request(url, { Accept: 'application/json', ...headers }, signal); }
    catch (error) { if (signal?.aborted) throw error; throw new StoreError(`Could not reach ${paperSourceName(source)}. Check the connection and try again.`, 502); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw this.refusal(source, response, single); }
    try { return { body: JSON.parse(new TextDecoder().decode(await readLimited(response, API_BYTES))), response }; }
    catch (error) { if (signal?.aborted) throw error; throw new StoreError(`${paperSourceName(source)} returned an unreadable answer.`, 502); }
  }
  /** One arXiv request at a time, `spacing` apart, as arXiv asks of every client. */
  private arxivTurn<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const turn = this.arxivQueue.then(async () => {
      const wait = this.arxivNext - Date.now();
      if (wait > 0) await sleep(wait, undefined, signal ? { signal } : undefined);
      try { return await work(); } finally { this.arxivNext = Date.now() + this.spacing; }
    });
    this.arxivQueue = turn.catch(() => undefined);
    return turn;
  }
  private async arxiv(params: URLSearchParams, signal?: AbortSignal) {
    return this.arxivTurn(async () => {
      let response: Response;
      try { response = await this.request(`${this.bases.arxiv}?${params}`, { Accept: 'application/atom+xml' }, signal); }
      catch (error) { if (signal?.aborted) throw error; throw new StoreError('Could not reach arXiv. Check the connection and try again.', 502); }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw this.refusal('arxiv', response); }
      return arxivPapers(new TextDecoder().decode(await readLimited(response, API_BYTES)), this.bases.arxivPdf);
    }, signal);
  }
  private zoteroKey() { const key = this.keys.zotero(); if (!key) throw new StoreError('Zotero is not connected. Save a Zotero API key on the Plugins page.', 409); return key; }
  private zoteroHeaders(key: string) { return { 'Zotero-API-Key': key, 'Zotero-API-Version': '3' }; }
  /** Whose library the key reads: asked once per key. */
  private async zoteroLibrary(signal?: AbortSignal) {
    if (Date.now() < this.zoteroWait) throw new StoreError(`Zotero asked ros.ai to wait; try again in ${Math.ceil((this.zoteroWait - Date.now()) / 1000)} seconds.`, 503);
    const key = this.zoteroKey(), digest = createHash('sha256').update(key).digest('hex');
    if (this.zoteroUser?.digest !== digest) {
      const { body } = await this.json('zotero', `${this.bases.zotero}/keys/current`, this.zoteroHeaders(key), signal);
      const found = body as { userID?: unknown; username?: unknown; access?: { user?: { library?: unknown } } };
      if (!Number.isInteger(found.userID)) throw new StoreError('Zotero did not say whose library this key reads.', 502);
      if (found.access?.user?.library !== true) throw new StoreError('This Zotero key cannot read your library. Create one with “Allow library access” on.', 403);
      this.zoteroUser = { digest, userID: found.userID as number, username: oneLine(found.username, 80) };
    }
    return { key, base: `${this.bases.zotero}/users/${this.zoteroUser.userID}` };
  }

  /** Papers matching words in one source, best first. A DOI or an arXiv ID finds that one paper. */
  async search(source: PaperSource, query: string, options: SearchOptions, allowed: PaperSource[], signal?: AbortSignal): Promise<PaperSearch> {
    if (!allowed.includes(source)) throw this.blocked(source);
    const words = oneLine(query, 300);
    if (!words && source !== 'zotero') return { papers: [], total: 0 };
    const id = `${source}\n${words}\n${JSON.stringify(options)}`, cached = this.searches.get(id);
    if (cached && Date.now() - cached.at < (source === 'zotero' ? LIBRARY_TTL : SEARCH_TTL)) return cached.result;
    const found = source === 'openalex' ? await this.searchOpenAlex(words, options, signal) : source === 'arxiv' ? await this.searchArxiv(words, options, signal) : await this.searchZotero(words, options, signal);
    for (const paper of found.papers) this.remember(paper);
    const result: PaperSearch = { papers: found.papers.map(({ date: _date, kind: _kind, pdfs: _pdfs, zoteroFile: _file, ...summary }) => summary), total: found.total, ...(found.note ? { note: found.note } : {}) };
    this.searches.set(id, { at: Date.now(), result });
    for (const [key] of this.searches) { if (this.searches.size <= 100) break; this.searches.delete(key); }
    return result;
  }
  private async searchOpenAlex(words: string, options: SearchOptions, signal?: AbortSignal): Promise<{ papers: Paper[]; total: number | null; note?: string }> {
    const single = doiOf(words) ? `doi:${doiOf(words)}` : arxivIdOf(words) ? `doi:10.48550/arXiv.${withoutVersion(arxivIdOf(words)!)}` : /^(?:https:\/\/openalex\.org\/)?(W\d{1,15})$/iu.exec(words)?.[1]?.toUpperCase();
    if (single) { try { return { papers: [await this.openalexWork(single, signal)], total: 1 }; } catch (error) { if (error instanceof StoreError && error.status === 404) return { papers: [], total: 0 }; throw error; } }
    const filters = [...(options.yearFrom ? [`from_publication_date:${options.yearFrom}-01-01`] : []), ...(options.yearTo ? [`to_publication_date:${options.yearTo}-12-31`] : []), ...(options.openOnly ? ['open_access.is_oa:true'] : [])];
    const params = new URLSearchParams({ search: words, 'per-page': String(options.limit), select: OPENALEX_FIELDS });
    if (filters.length) params.set('filter', filters.join(','));
    if (options.sort === 'newest') params.set('sort', 'publication_date:desc'); else if (options.sort === 'most_cited') params.set('sort', 'cited_by_count:desc');
    const key = this.keys.openalex();
    if (key) params.set('api_key', key);
    const { body } = await this.json('openalex', `${this.bases.openalex}/works?${params}`, {}, signal);
    const page = body as { results?: unknown[]; meta?: { count?: unknown } };
    return { papers: (Array.isArray(page.results) ? page.results : []).flatMap(item => openalexPaper(item) ?? []), total: Number.isInteger(page.meta?.count) ? page.meta!.count as number : null };
  }
  private async openalexWork(id: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ select: OPENALEX_FIELDS }), key = this.keys.openalex();
    if (key) params.set('api_key', key);
    // OpenAlex names a DOI as doi:10.7717/peerj.4375, with its slash; anything else that could end the path is escaped.
    const { body } = await this.json('openalex', `${this.bases.openalex}/works/${id.startsWith('doi:') ? `doi:${encodeURIComponent(id.slice(4)).replace(/%2F/giu, '/')}` : id}?${params}`, {}, signal, true);
    const paper = openalexPaper(body);
    if (!paper) throw new StoreError('OpenAlex returned a paper ros.ai could not read.', 502);
    return this.remember(paper);
  }
  private async searchArxiv(words: string, options: SearchOptions, signal?: AbortSignal): Promise<{ papers: Paper[]; total: number | null; note?: string }> {
    const id = arxivIdOf(words) ?? (doiOf(words)?.toLowerCase().startsWith('10.48550/arxiv.') ? arxivIdOf(doiOf(words)!.slice('10.48550/arxiv.'.length)) : null);
    if (id) return this.arxiv(new URLSearchParams({ id_list: id, max_results: '1' }), signal);
    // arXiv's own syntax (ti:, au:, abs:, cat:, AND/OR) is passed on; plain words must all appear.
    const fielded = /\b(?:ti|au|abs|co|jr|cat|rn|id|all|submittedDate):|\b(?:AND|OR|ANDNOT)\b/u.test(words);
    const terms = words.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.filter(term => !STOP_WORDS.has(term)).slice(0, 12) ?? [];
    let query = fielded ? words : terms.map(term => `all:${term.replace(/['"]/gu, '')}`).join(' AND ');
    if (!query) return { papers: [], total: 0 };
    if (options.yearFrom || options.yearTo) query = `(${query}) AND submittedDate:[${options.yearFrom ?? 1991}01010000 TO ${options.yearTo ?? new Date().getUTCFullYear()}12312359]`;
    const found = await this.arxiv(new URLSearchParams({ search_query: query, start: '0', max_results: String(options.limit), sortBy: options.sort === 'newest' ? 'submittedDate' : 'relevance', sortOrder: 'descending' }), signal);
    return { ...found, ...(options.sort === 'most_cited' ? { note: 'arXiv cannot sort by citations, so these are sorted by relevance. OpenAlex can.' } : {}) };
  }
  private async arxivPaper(id: string, signal?: AbortSignal) {
    const paper = (await this.arxiv(new URLSearchParams({ id_list: id, max_results: '1' }), signal)).papers[0];
    if (!paper) throw new StoreError(`arXiv has no paper ${id}.`, 404);
    return this.remember(paper);
  }
  private async searchZotero(words: string, options: SearchOptions, signal?: AbortSignal): Promise<{ papers: Paper[]; total: number | null; note?: string }> {
    const { key, base } = await this.zoteroLibrary(signal), years = options.yearFrom || options.yearTo;
    // Zotero matches words in titles, creators and years, newest change first (no words lists the library); years and
    // open copies are filtered here.
    const params = new URLSearchParams({ ...(words ? { q: words, qmode: 'titleCreatorYear' } : {}), itemType: '-attachment || note', limit: String(years || options.openOnly ? 100 : options.limit), format: 'json', include: 'data', ...(options.sort === 'newest' ? { sort: 'date', direction: 'desc' } : {}) });
    const { body, response } = await this.json('zotero', `${base}/items/top?${params}`, this.zoteroHeaders(key), signal);
    const papers = (Array.isArray(body) ? body : []).flatMap(item => zoteroPaper(item) ?? []).filter(paper => (!options.yearFrom || (paper.year ?? 0) >= options.yearFrom) && (!options.yearTo || (paper.year ?? 9999) <= options.yearTo) && (!options.openOnly || paper.pdf));
    const total = Number(response.headers.get('total-results'));
    return { papers: papers.slice(0, options.limit), total: years || options.openOnly ? papers.length : Number.isInteger(total) ? total : null, ...(options.sort === 'most_cited' ? { note: 'Zotero cannot sort by citations, so these are your most recently changed matches.' } : {}) };
  }
  private async zoteroItem(key: string, signal?: AbortSignal) {
    const { key: apiKey, base } = await this.zoteroLibrary(signal);
    const { body } = await this.json('zotero', `${base}/items/${key}?${new URLSearchParams({ format: 'json', include: 'data' })}`, this.zoteroHeaders(apiKey), signal, true);
    const paper = zoteroPaper(body);
    if (!paper) throw new StoreError('That Zotero item is a note or a file, not a reference.', 404);
    return this.remember(paper);
  }
  private blocked(source: PaperSource) {
    return new StoreError(source === 'zotero' ? 'Zotero is not connected. Save a Zotero API key on the Plugins page.' : `${paperSourceName(source)} is off for agents. The person turns it on on the Plugins page.`, 409);
  }

  /** One paper by its ID from a search, a DOI or an arXiv ID, from the sources allowed here. */
  async paper(input: string, allowed: PaperSource[], signal?: AbortSignal): Promise<Paper> {
    const value = oneLine(input, 400), kept = this.known(value);
    if (kept && allowed.includes(kept.source)) return kept;
    if (PAPER_ID.test(value)) {
      const [source, id] = [value.slice(0, value.indexOf(':')) as PaperSource, value.slice(value.indexOf(':') + 1)];
      if (!allowed.includes(source)) throw this.blocked(source);
      return source === 'openalex' ? this.openalexWork(id, signal) : source === 'arxiv' ? this.arxivPaper(id, signal) : this.zoteroItem(id, signal);
    }
    const doi = doiOf(value), arxiv = arxivIdOf(value) ?? (doi?.toLowerCase().startsWith('10.48550/arxiv.') ? arxivIdOf(doi.slice('10.48550/arxiv.'.length)) : null);
    if (arxiv && allowed.includes('arxiv')) return this.arxivPaper(arxiv, signal);
    if ((doi || arxiv) && allowed.includes('openalex')) return this.openalexWork(`doi:${doi ?? `10.48550/arXiv.${withoutVersion(arxiv!)}`}`, signal);
    const work = /^(?:https:\/\/openalex\.org\/)?(W\d{1,15})$/iu.exec(value)?.[1];
    if (work && allowed.includes('openalex')) return this.openalexWork(work.toUpperCase(), signal);
    if (doi || arxiv || work) throw new StoreError(`Looking a paper up by ${doi ? 'DOI' : arxiv ? 'arXiv ID' : 'OpenAlex ID'} needs ${arxiv ? 'arXiv or ' : ''}OpenAlex, which is off for agents. The person turns it on on the Plugins page.`, 409);
    throw new StoreError('Name a paper by the id search_papers gave (openalex:W…, arxiv:…, zotero:…), a DOI or an arXiv ID.');
  }

  /** The paper's open PDF: the one Zotero stores, else the open copies OpenAlex or arXiv know, best first. `place` names
   * where it came from; `problem` says why none could be saved. */
  async pdf(paper: Paper, allowed: PaperSource[], signal?: AbortSignal): Promise<{ bytes: Buffer; place: string } | { problem: string }> {
    let problem = 'No open PDF is known for this paper.', candidates = paper.pdfs;
    if (paper.source === 'zotero') {
      if (paper.zoteroFile) {
        try { return { bytes: await this.zoteroFile(paper.zoteroFile, signal), place: 'your Zotero library' }; }
        catch (error) { if (signal?.aborted) throw error; problem = `Zotero’s copy could not be saved: ${error instanceof Error ? error.message : String(error)}`; }
      }
      // A reference with a DOI may have an open copy that OpenAlex knows.
      if (paper.doi && allowed.includes('openalex')) candidates = await this.openalexWork(`doi:${paper.doi}`, signal).then(found => found.pdfs, () => []);
    }
    for (const url of candidates) {
      try { return { bytes: await this.download(url, signal), place: new URL(url).hostname }; }
      catch (error) { if (signal?.aborted) throw error; problem = `The open copy at ${new URL(url).hostname} could not be saved as a PDF${error instanceof TooLarge ? ': it is larger than 50 MB, the most a File block shows' : ''}.`; }
    }
    return { problem };
  }
  /** Fetches a PDF, following redirects by hand so each address is checked, and only when it really is a PDF. */
  private async download(href: string, signal?: AbortSignal, hops = 5): Promise<Buffer> {
    let current = href;
    for (let hop = 0; hop <= hops; hop++) {
      const url = await this.publicUrl(current), arxiv = /(^|\.)arxiv\.org$/u.test(url.hostname) || url.href.startsWith(this.bases.arxivPdf);
      const fetchOnce = () => this.request(url.href, { Accept: 'application/pdf,*/*;q=0.5' }, signal, 'manual', PDF_TIMEOUT);
      const response = arxiv ? await this.arxivTurn(fetchOnce, signal) : await fetchOnce();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new Error('a redirect without an address');
        current = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`HTTP ${response.status}`); }
      const bytes = await readLimited(response, FILE_BYTES), start = bytes.indexOf('%PDF-');
      if (start < 0 || start > 1024) throw new Error('not a PDF');
      return bytes;
    }
    throw new Error('too many redirects');
  }
  private async publicUrl(href: string): Promise<URL> {
    const url = new URL(href);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new Error('not a web address');
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    if (this.fixed.has(host)) return url;
    const addresses = isIP(host) ? [host] : (await this.lookup(host).catch(() => [])).map(item => item.address);
    if (!addresses.length || addresses.some(privateAddress)) throw new Error('not on the public internet');
    return url;
  }
  /** The PDF Zotero stores for an attachment: Zotero answers with a short-lived address that needs no key. */
  private async zoteroFile(attachment: string, signal?: AbortSignal): Promise<Buffer> {
    const { key, base } = await this.zoteroLibrary(signal), from = `${base}/items/${attachment}/file`;
    const response = await this.request(from, this.zoteroHeaders(key), signal, 'manual', PDF_TIMEOUT);
    if (response.headers.get('zotero-file-compressed')?.toLowerCase() === 'yes') { await response.body?.cancel().catch(() => undefined); throw new Error('Zotero keeps it compressed'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) throw new Error('Zotero gave no address');
      return this.download(new URL(location, from).href, signal);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw response.status === 404 ? new Error('Zotero does not store this file (it may sync through WebDAV)') : this.refusal('zotero', response, true); }
    const bytes = await readLimited(response, FILE_BYTES);
    if (bytes.indexOf('%PDF-') < 0 || bytes.indexOf('%PDF-') > 1024) throw new Error('not a PDF');
    return bytes;
  }
}

/** The reference as a citation: every author's full name (the first nineteen and the last of a longer list), year,
 * title, venue and the DOI or the paper's page. */
export function citation(paper: Pick<Paper, 'authors' | 'year' | 'title' | 'venue' | 'doi' | 'link'>): string {
  const authors = paper.authors.length > 20 ? `${paper.authors.slice(0, 19).join(', ')}, … ${paper.authors.at(-1)}` : paper.authors.join(', ');
  return [`${authors || 'Unknown authors'} (${paper.year ?? 'n.d.'}).`, /[.?!]$/u.test(paper.title) ? paper.title : `${paper.title}.`, paper.venue ? `*${paper.venue.replace(/\*/gu, '')}*.` : null, paper.doi ? `https://doi.org/${paper.doi}` : paper.link].filter(Boolean).join(' ');
}
/** A paper block's text: the citation, the abstract and where the paper (and its PDF) came from. */
export function paperText(paper: Paper, place: string | null, note?: string | null): string {
  const found = [`Found in ${paperSourceName(paper.source)}`, paper.citedBy !== null ? `cited by ${paper.citedBy.toLocaleString('en-US')}` : null, place ? `PDF saved from ${place} on ${new Date().toISOString().slice(0, 10)}` : null].filter(Boolean).join(' · ');
  return [citation(paper), paper.abstract ? `**Abstract.** ${paper.abstract}` : null, `${found}.`, note || null].filter(Boolean).join('\n\n').slice(0, TEXT);
}
/** A readable file name: first author's family name, year and title, as reference managers name PDFs. */
const fileName = (paper: Paper) => `${[paper.authors[0]?.split(/\s+/u).at(-1), paper.year, paper.title].filter(Boolean).join(' ').slice(0, 90)}.pdf`;
export const paperRef = (paper: Paper): PaperRef => ({ source: paper.source, id: paper.id, ...(paper.doi ? { doi: paper.doi } : {}), link: paper.link });

/** The block for a paper, not placed yet: a File block when its open PDF could be saved into the project folder,
 * otherwise a Text block with the reference. `existing` is the block already showing this paper. */
export async function paperBlock(papers: Papers, store: Store, folders: ProjectFolders | undefined, projectId: string, input: string, allowed: PaperSource[], signal?: AbortSignal): Promise<{ node: CanvasNode; note: string | null; existing?: undefined } | { existing: CanvasNode; node?: undefined; note?: undefined }> {
  const paper = await papers.paper(input, allowed, signal);
  const existing = store.getProject(projectId).canvas.nodes.find(node => node.paper && (node.paper.id === paper.id || (paper.doi && node.paper.doi?.toLowerCase() === paper.doi.toLowerCase())));
  if (existing) return { existing };
  const base = { id: randomUUID(), title: paper.title.slice(0, 200), kind: 'topic' as const, paper: paperRef(paper), x: 0, y: 0 };
  if (!paper.pdf && !(paper.source === 'zotero' && paper.doi)) return { node: { ...base, blockType: 'note', description: paperText(paper, null) }, note: null };
  const folder = folders?.status(projectId);
  if (!folders || !folder?.attached || folder.available === false) {
    const note = !folder?.attached ? 'The open PDF was not saved: this project has no folder. Choose one (the folder chip above the canvas) and add the paper again to keep its PDF.' : 'The open PDF was not saved: the project folder cannot be reached.';
    return { node: { ...base, blockType: 'note', description: paperText(paper, null, paper.pdf ? note : null) }, note: paper.pdf ? note : null };
  }
  const got = await papers.pdf(paper, allowed, signal);
  if ('problem' in got) return { node: { ...base, blockType: 'note', description: paperText(paper, null, paper.pdf ? got.problem : null) }, note: paper.pdf ? got.problem : null };
  const { path } = folders.saveFile(projectId, fileName(paper), got.bytes);
  return { node: { ...base, blockType: 'file', file: { path }, description: paperText(paper, got.place) }, note: null };
}

const sourceSchema = z.enum(['openalex', 'arxiv', 'zotero']);
const searchSchemaFor = (sources: [PaperSource, ...PaperSource[]]) => z.object({
  query: z.string().trim().max(300).default('').describe('Words to find in titles, abstracts and authors; a DOI or an arXiv ID finds that paper. arXiv also takes its own syntax, such as ti:transformer AND au:vaswani. Empty lists the newest items, in Zotero only.'),
  source: z.enum(sources).default(sources[0]).describe(`Where to search: ${sources.map(source => source === 'openalex' ? 'openalex (most published research, with citation counts and open copies)' : source === 'arxiv' ? 'arxiv (preprints in physics, maths, computer science and more; always with a PDF)' : 'zotero (the person’s own library)').join('; ')}`),
  limit: z.number().int().min(1).max(25).default(10),
  year_from: z.number().int().min(1500).max(2100).optional(),
  year_to: z.number().int().min(1500).max(2100).optional(),
  open_only: z.boolean().default(false).describe('Only papers with an open PDF'),
  sort: z.enum(['relevance', 'newest', 'most_cited']).default('relevance').describe('most_cited works in OpenAlex only'),
}).strict();
const readSchema = z.object({ id: z.string().trim().min(3).max(300).describe('An id from search_papers (openalex:W…, arxiv:…, zotero:…), a DOI or an arXiv ID') }).strict();
export const addPaperSchema = readSchema;

/** Papers' tools for agents, shaped like an app's MCP server: search and read run straight away; add_paper adds a block,
 * which ros.ai proposes under the project's approval mode (agent-tools.ts), so this app never runs it itself. */
export class PapersApp implements BuiltInApp {
  constructor(private readonly papers: Papers) {}
  connected() { return this.papers.agentSources().length > 0; }
  tools(): AppTool[] {
    const sources = this.papers.agentSources(), names = sources.map(paperSourceName).join(', ') || 'no source yet';
    if (!sources.length) return [];
    return [
      { name: 'search_papers', description: `Search scholarly papers in ${names}: each with its id, title, authors, year, venue, DOI, whether an open PDF exists, citation count (OpenAlex) and the start of its abstract.`, inputSchema: z.toJSONSchema(searchSchemaFor(sources as [PaperSource, ...PaperSource[]]), { io: 'input' }) as Record<string, unknown>, reads: true },
      { name: 'read_paper', description: 'One paper in full: its citation, every author, abstract, DOI, page and open PDF address.', inputSchema: z.toJSONSchema(readSchema, { io: 'input' }) as Record<string, unknown>, reads: true },
      { name: 'add_paper', description: 'Put a paper on the canvas. With an open PDF and a project folder, ros.ai saves the PDF into files/ and adds a File block; ros.ai then reads its text into the block, which ros_read_canvas lists as a "Text of" version. Otherwise a Text block with the citation and abstract. It is proposed like ros_propose_canvas, under the project\'s approval mode.', inputSchema: z.toJSONSchema(readSchema, { io: 'input' }) as Record<string, unknown>, reads: false, proposes: true },
    ];
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    try {
      const sources = this.papers.agentSources();
      if (name === 'search_papers') {
        if (!sources.length) throw new StoreError('No paper source is on for agents.', 409);
        const value = searchSchemaFor(sources as [PaperSource, ...PaperSource[]]).parse(args);
        const found = await this.papers.search(value.source, value.query, { limit: value.limit, yearFrom: value.year_from, yearTo: value.year_to, openOnly: value.open_only, sort: value.sort }, sources, signal);
        const papers = found.papers.map(paper => ({ id: paper.id, title: paper.title, authors: paper.authors.length > 6 ? [...paper.authors.slice(0, 5), `and ${paper.authors.length - 5} more`] : paper.authors, year: paper.year, venue: paper.venue, doi: paper.doi, openPdf: paper.pdf, ...(paper.citedBy !== null ? { citedBy: paper.citedBy } : {}), abstract: paper.abstract ? `${paper.abstract.slice(0, 300)}${paper.abstract.length > 300 ? '…' : ''}` : null }));
        return { text: JSON.stringify({ source: value.source, total: found.total, papers, ...(found.note ? { note: found.note } : {}), next: papers.length ? 'read_paper for one paper in full; add_paper to put it on the canvas.' : 'Try other words or another source.' }, null, 1), isError: false };
      }
      if (name === 'read_paper') {
        const paper = await this.papers.paper(readSchema.parse(args).id, sources, signal);
        return { text: JSON.stringify({ id: paper.id, citation: citation(paper), title: paper.title, authors: paper.authors, year: paper.year, date: paper.date, venue: paper.venue, kind: paper.kind, doi: paper.doi, link: paper.link, abstract: paper.abstract, openPdf: paper.pdfs[0] ?? (paper.zoteroFile ? 'stored in Zotero' : null), ...(paper.citedBy !== null ? { citedBy: paper.citedBy } : {}) }, null, 1), isError: false };
      }
      if (name === 'add_paper') throw new StoreError('add_paper adds a block, so it runs from an agent turn in a project.');
      throw new StoreError(`Papers has no tool called ${oneLine(name, 60)}.`);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof z.ZodError) return { text: `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ').slice(0, 500)}`, isError: true };
      if (error instanceof StoreError) return { text: error.message, isError: true };
      throw error;
    }
  }
}

export function attachPaperRoutes(app: Express, store: Store, papers: Papers, folders?: ProjectFolders) {
  const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u), coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
  app.get('/api/papers', (_req, res) => res.json(papers.status()));
  app.put('/api/papers/:source', (req, res) => res.json(papers.setAgents(z.enum(['openalex', 'arxiv']).parse(req.params.source), z.object({ agents: z.boolean() }).strict().parse(req.body).agents)));
  app.get('/api/papers/search', async (req, res) => {
    const value = z.object({ source: sourceSchema, q: z.string().max(300).default(''), limit: z.coerce.number().int().min(1).max(25).default(20) }).strict().parse(req.query);
    res.json(await papers.search(value.source, value.q, { limit: value.limit }, papers.personSources()));
  });
  // The person adds a paper from Add block › Paper: its PDF is saved first, then the block is added in one change.
  app.post('/api/projects/:id/papers', async (req, res) => {
    const projectId = identifier.parse(req.params.id), body = z.object({ paper: z.string().trim().min(3).max(300), parentId: identifier.nullable().optional(), x: coordinate, y: coordinate }).strict().parse(req.body);
    const stopped = new AbortController();
    res.on('close', () => { if (!res.writableEnded) stopped.abort(); });
    const made = await paperBlock(papers, store, folders, projectId, body.paper, papers.personSources(), stopped.signal);
    if (made.existing) return res.json({ nodeId: made.existing.id, existing: true });
    store.mutate(projectId, [{ type: 'addNode', node: { ...made.node, x: body.x, y: body.y, ...(body.parentId ? { parentId: body.parentId } : {}) } }], `Add paper: ${made.node.title}`.slice(0, 200));
    res.status(201).json({ nodeId: made.node.id, pdf: Boolean(made.node.file), ...(made.note ? { note: made.note } : {}) });
  });
}
