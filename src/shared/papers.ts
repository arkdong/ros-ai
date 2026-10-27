import type { PaperSource } from './types.js';

/** Papers from OpenAlex, arXiv and the person's Zotero library: what a search shows and the sources' names. */
export const PAPER_SOURCES: { id: PaperSource; name: string }[] = [{ id: 'openalex', name: 'OpenAlex' }, { id: 'arxiv', name: 'arXiv' }, { id: 'zotero', name: 'Zotero' }];
export const paperSourceName = (source: PaperSource) => PAPER_SOURCES.find(item => item.id === source)!.name;

/** A paper's ID in its source: openalex:W2741809807, arxiv:1706.03762v7 (or an old-style arxiv:hep-th/9901001), zotero:ABCD2345. */
export const PAPER_ID = /^(?:openalex:W\d{1,15}|arxiv:(?:\d{4}\.\d{4,5}|[a-z-]{2,20}(?:\.[A-Z]{2})?\/\d{7})(?:v\d{1,3})?|zotero:[A-Z0-9]{8})$/u;
export const DOI = /^10\.\d{4,9}\/\S{1,280}$/u;

/** One paper in a search: pdf says whether an open PDF is known, which becomes a File block. citedBy comes from OpenAlex. */
export type PaperSummary = { id: string; source: PaperSource; title: string; authors: string[]; year: number | null; venue: string | null; doi: string | null; link: string; abstract: string | null; pdf: boolean; citedBy: number | null };
export type PaperSearch = { papers: PaperSummary[]; total: number | null; note?: string };

/** Which sources the person can search from Add block › Paper (OpenAlex and arXiv always; Zotero once its key is saved)
 * and which every agent may use (turned on in Plugins; Zotero with its key). */
export type PaperSourceStatus = { id: PaperSource; name: string; available: boolean; agents: boolean; key: boolean; account: string | null };
export type PapersStatus = { sources: PaperSourceStatus[] };
