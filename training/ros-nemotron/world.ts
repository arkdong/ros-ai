/** The web the teacher researches in. Tavily would cost US$0.008 a search, so the teacher (thinking
 * off) writes the search results and pages instead, once per query, cached on disk so reruns and
 * evaluations see the same web. Pages contain their snippets word for word, so ros.ai's real quote
 * check still decides which findings stand. About one page in ten cannot be read, like on the web. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ask, path, readJson, writeJson, type ChatAdapter } from './lib.js';
import type { ExtractResponse, SearchAdapter, SearchResponse, SearchResult } from '../../src/server/providers.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const SEARCH = `You simulate a web search engine for a research-assistant training set. Given a query and the research topic, return JSON {"results":[{"title","url","published","content"}]} with exactly 3 results, as Tavily would.
- Realistic sources for the topic: statistics offices, ministries, universities, journals, news, NGOs, company pages, blogs. Plausible https URLs on real-looking domains.
- "content" is a 300-700 character excerpt in the page's own words, including concrete numbers, names and the publication year where a real page would have them. "published" is a date (YYYY-MM-DD) between 2015 and 2026.
- Vary quality: usually one result is weak, dated, off-topic or partly contradicts another. Never mention that this is simulated.`;
const PAGE = `You write the full text of a web page for a research-assistant training set, as Tavily's extract would return it (plain text, no HTML). Return JSON {"text": "..."}.
- 1,800-3,500 characters. It must contain the given excerpt word for word somewhere in the body, plus surrounding detail consistent with it: headings as plain lines, a date line, methods or caveats where a real page has them, and some navigation or boilerplate noise.
- Never mention that this is simulated.`;

export class SimulatedWeb implements SearchAdapter {
  readonly configured = true;
  constructor(private readonly writer: ChatAdapter | undefined, private readonly topic: string) {}
  async search(query: string): Promise<SearchResponse> {
    const file = path('world', 'search', `${hash(query.toLowerCase().trim())}.json`);
    if (!existsSync(file)) {
      if (!this.writer) throw new Error('This query is not in the saved web, and no world writer is configured.');
      const written = await ask<{ results: (Omit<SearchResult, 'locator'> & { published?: string })[] }>(this.writer, SEARCH, `Research topic: ${this.topic}\nQuery: ${query}`, 3000);
      writeJson(file, { query, topic: this.topic, results: written.results.slice(0, 3) });
    }
    const saved = readJson<{ results: (Omit<SearchResult, 'locator'> & { published?: string })[] }>(file);
    return { results: saved.results.map((result, index) => ({ title: result.title, url: result.url, content: result.published ? `${result.published} · ${result.content}` : result.content, locator: `Tavily search result ${index + 1}; content characters 0–${result.content.length}` })), credits: 1, requestId: `simulated-${hash(query)}` };
  }
  async extract(urls: string[]): Promise<ExtractResponse> {
    const pages: ExtractResponse['pages'] = [], failed: string[] = [];
    for (const url of urls) {
      const file = path('world', 'pages', `${hash(url)}.json`);
      if (!existsSync(file)) {
        const snippet = this.snippet(url);
        // Roughly one page in ten fails to load, decided by its address so reruns agree.
        if (!snippet || parseInt(hash(url).slice(0, 2), 16) < 26 || !this.writer) { failed.push(url); continue; }
        const written = await ask<{ text: string }>(this.writer, PAGE, `Research topic: ${this.topic}\nURL: ${url}\nTitle: ${snippet.title}\nExcerpt that must appear word for word: ${snippet.content}`, 3000);
        // A writer that paraphrased its excerpt would make honest quotes fail, so the excerpt is put back.
        writeJson(file, { url, text: written.text.includes(snippet.content) ? written.text : `${snippet.title}\n\n${snippet.content}\n\n${written.text}` });
      }
      const text = readJson<{ text: string }>(file).text;
      pages.push({ url, content: text, locator: `Tavily extract; page text characters 0–${text.length}` });
    }
    return { pages, failed, credits: Math.ceil(urls.length / 5), requestId: 'simulated-extract' };
  }
  private snippet(url: string) {
    // Search results are written before pages, so a page's excerpt is found in the saved results.
    return this.seen.get(url);
  }
  private readonly seen = new Map<string, { title: string; content: string }>();
  remember(response: SearchResponse) { for (const result of response.results) this.seen.set(result.url, { title: result.title, content: result.content.replace(/^\d{4}-\d{2}-\d{2} · /u, '') }); return response; }
}

/** The search adapter the rollout uses: remembers every result so pages can be written from it. */
export function web(writer: ChatAdapter | undefined, topic: string): SearchAdapter {
  const world = new SimulatedWeb(writer, topic);
  return { configured: true, search: async (query: string) => world.remember(await world.search(query)), extract: (urls: string[]) => world.extract(urls) } as SearchAdapter;
}
