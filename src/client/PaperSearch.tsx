import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import type { PaperSearch as Found, PaperSourceStatus, PaperSummary, PapersStatus } from '../shared/papers';
import { PAPER_SOURCES } from '../shared/papers';
import type { PaperSource } from '../shared/types';
import { api } from './api';
import { BrandLogo } from './brand-logos';
import './paper-search.css';

const byline = (paper: PaperSummary) => [paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(', ')} et al.` : paper.authors.join(', '), paper.year, paper.venue].filter(Boolean).join(' · ');
const publicSources = PAPER_SOURCES.filter(item => item.id !== 'zotero').map(item => ({ ...item, available: true, agents: false, key: false, account: null }));

/** Add block › Paper: one field for words, a DOI or an arXiv ID, the source as tabs, and the papers found to pick one
 * from. Zotero shows once its key is saved, and lists the newest of the library before any words are typed. */
export function PaperSearch({ chosen, onChoose, disabled }: { chosen: PaperSummary | null; onChoose: (paper: PaperSummary | null) => void; disabled: boolean }) {
  const [sources, setSources] = useState<PaperSourceStatus[]>(publicSources), [source, setSource] = useState<PaperSource>('openalex');
  const [query, setQuery] = useState(''), [found, setFound] = useState<Found | null>(null), [searching, setSearching] = useState(false), [error, setError] = useState('');
  const latest = useRef(0);
  useEffect(() => { void api<PapersStatus>('/api/papers').then(status => setSources(status.sources.filter(item => item.available)), () => undefined); }, []);
  const name = sources.find(item => item.id === source)?.name ?? 'papers';
  const search = async (from: PaperSource, words: string) => {
    const request = ++latest.current;
    onChoose(null); setError('');
    if (!words.trim() && from !== 'zotero') { setFound(null); setSearching(false); return; }
    setSearching(true);
    try { const result = await api<Found>(`/api/papers/search?${new URLSearchParams({ source: from, q: words.trim() })}`, { signal: AbortSignal.timeout(60_000) }); if (request === latest.current) setFound(result); }
    catch (reason) { if (request === latest.current) { setFound(null); setError(reason instanceof Error ? reason.message : String(reason)); } }
    finally { if (request === latest.current) setSearching(false); }
  };
  return <div className="paper-search">
    <label className="field-label" htmlFor="paper-query">Find a paper</label>
    <div className="paper-search-field">
      {/* Enter searches here; it must not add the block the form adds. */}
      <input id="paper-query" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(source, query); } }} placeholder="Words, a DOI or an arXiv ID" maxLength={300} disabled={disabled} autoFocus/>
      <button type="button" className="secondary small" disabled={disabled || searching || (!query.trim() && source !== 'zotero')} onClick={() => void search(source, query)}><Search size={13}/> Search</button>
    </div>
    <nav className="paper-sources" aria-label="Search in">{sources.map(item => <button key={item.id} type="button" aria-pressed={item.id === source} disabled={disabled} onClick={() => { if (item.id === source) return; setSource(item.id); void search(item.id, query); }}><BrandLogo id={item.id} size={14}/>{item.name}</button>)}</nav>
    <div className="paper-results" role="group" aria-label="Papers" aria-busy={searching}>
      {searching ? <p className="paper-results-note"><LoaderCircle size={13} className="spin"/> Searching {name}…</p>
        : error ? <p className="inline-error" role="alert">{error}</p>
        : found && !found.papers.length ? <p className="paper-results-note">No papers match.</p>
        : found?.papers.map(paper => <button key={paper.id} type="button" className="paper-result" aria-pressed={chosen?.id === paper.id} disabled={disabled} onClick={() => onChoose(chosen?.id === paper.id ? null : paper)}>
          <strong>{paper.title}</strong>
          <small>{byline(paper)}</small>
          {chosen?.id === paper.id && paper.abstract && <span className="paper-abstract">{paper.abstract}</span>}
          {paper.pdf && <span className="paper-pdf" title="An open PDF is known: it becomes a File block">PDF</span>}
        </button>)}
      {!searching && found?.note && <p className="paper-results-note">{found.note}</p>}
    </div>
  </div>;
}
