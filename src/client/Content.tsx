import { Fragment, type ReactNode } from 'react';
import { ArrowUpRight, FileText } from 'lucide-react';
import type { Artifact } from '../shared/types';

export function safeUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

function inline(value: string, sources: Artifact[], scope: string): ReactNode[] {
  const pattern = /(\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]\n]+)\])/g;
  const output: ReactNode[] = []; let at = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > at) output.push(value.slice(at, match.index));
    const key = `${match.index}-${match[0]}`;
    if (match[2]) {
      const url = safeUrl(match[3]);
      output.push(url ? <a key={key} href={url} target="_blank" rel="noreferrer">{match[2]}</a> : <Fragment key={key}>{match[2]}</Fragment>);
    } else if (match[4]) output.push(<strong key={key}>{match[4]}</strong>);
    else if (match[5]) output.push(<code key={key}>{match[5]}</code>);
    else {
      const reference = match[6];
      const source = sources.find(s => s.sourceId === reference || s.id === reference) ?? sources[/^\d+$/.test(reference) ? Number(reference) - 1 : -1];
      output.push(source ? <a key={key} className="citation" href={`#evidence-${scope}-${source.id}`} title={`Captured evidence: ${source.title}`} onClick={event => { event.preventDefault(); const element = document.getElementById(`evidence-${scope}-${source.id}`); if (element instanceof HTMLDetailsElement) { element.open = true; element.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }}>{reference}</a> : /^[SI]\d+$/i.test(reference) ? <span key={key} className="unsupported-citation" title="No captured support was found for this citation">{match[0]} · unsupported</span> : <span key={key}>{match[0]}</span>);
    }
    at = match.index + match[0].length;
  }
  if (at < value.length) output.push(value.slice(at));
  return output;
}

/** Text-only rendering: provider content is never inserted as HTML. */
export function RichText({ text, sources = [], scope = '' }: { text: string; sources?: Artifact[]; scope?: string }) {
  return <div className="rich-text">{text.split(/\n\s*\n/).map((paragraph, i) => {
    if (/^#{1,4} /.test(paragraph)) return <h4 key={i}>{inline(paragraph.replace(/^#{1,4} /, ''), sources, scope)}</h4>;
    if (/^[-*] /m.test(paragraph) && paragraph.split('\n').every(line => /^[-*] /.test(line))) return <ul key={i}>{paragraph.split('\n').map((line, j) => <li key={j}>{inline(line.slice(2), sources, scope)}</li>)}</ul>;
    return <p key={i}>{inline(paragraph, sources, scope)}</p>;
  })}</div>;
}

export function Evidence({ sources, onAttach, scope = '' }: { sources: Artifact[]; onAttach?: (artifact: Artifact) => void; scope?: string }) {
  if (!sources.length) return <p className="subtle evidence-note">No captured external evidence. Check factual claims independently.</p>;
  return <div className="evidence-list">
    <div className="eyebrow"><FileText size={12} /> Captured evidence · {sources.length}</div>
    <p className="subtle evidence-note">Citations identify captured passages; they do not establish that a claim is correct.</p>
    {sources.map((source, index) => <details id={`evidence-${scope}-${source.id}`} className="evidence-item" key={source.id}>
      <summary><span className="source-number">{source.sourceId || index + 1}</span><span>{source.title}</span></summary>
      <div className="evidence-body">
        <span className="tag">{source.sourceId?.startsWith('I') ? 'Selected input · exact captured selection' : source.capture === 'full-content' ? 'Captured full content' : 'Search result snippet'}</span>
        {source.locator && <div className="subtle">{source.locator}</div>}
        <blockquote>{source.content}</blockquote>
        <div className="row between">{safeUrl(source.url) && <a href={safeUrl(source.url)} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={12} /></a>}{onAttach && <button className="text-button" onClick={() => onAttach(source)}>Use in another node</button>}</div>
      </div>
    </details>)}
  </div>;
}

export function time(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function date(value: string) {
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
