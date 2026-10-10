import { Fragment, type ReactNode } from 'react';
import { ArrowUpRight, FileText } from 'lucide-react';
import type { Artifact } from '../shared/types';
import { artifactTable } from '../shared/data-view';
import { resolveReportArtifact, svgImageUrl } from '../shared/reports';

export function safeUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

// One left-to-right scan for the inline Markdown a model or researcher writes.
// Earlier alternatives win at the same position, so code and links come first.
const INLINE = new RegExp([
  /(?<code>`[^`\n]+`)/,
  /(?<link>!?\[(?<label>[^\]\n]*)\]\((?<href>[^)\s]+)\))/,
  /(?<strong>\*\*(?=\S)(?<strongText>[^\n]*?\S)\*\*)/,
  /(?<under>(?<!\w)__(?=\S)(?<underText>[^\n]*?\S)__(?!\w))/,
  /(?<em>(?<![\w*])\*(?=[^\s*])(?<emText>[^*\n]*?[^\s*])\*(?![\w*]))/,
  /(?<emUnder>(?<![\w_])_(?=[^\s_])(?<emUnderText>[^_\n]*?[^\s_])_(?![\w_]))/,
  /(?<strike>~~(?=\S)(?<strikeText>[^\n]*?\S)~~)/,
  /(?<cite>\[(?<ref>[^\]\n]+)\])/,
  /(?<url>https?:\/\/[^\s<>"'`)\]]*[^\s<>"'`)\].,;:!?])/,
].map(part => part.source).join('|'), 'gu');
/** A bare address reads as its site and path; the link keeps the full address. */
const shortUrl = (url: string) => { const text = url.replace(/^https?:\/\/(www\.)?/u, '').replace(/\/$/u, ''); return text.length > 48 ? `${text.slice(0, 47)}…` : text; };

function inline(value: string, sources: Artifact[], scope: string, onArtifact?: (artifact:Artifact)=>void): ReactNode[] {
  const output: ReactNode[] = []; let at = 0;
  for (const match of value.matchAll(INLINE)) {
    const groups = match.groups!, index = match.index!, key = `${index}-${match[0]}`;
    const nested = (text: string) => inline(text, sources, scope, onArtifact);
    if (index > at) output.push(value.slice(at, index));
    if (groups.code) output.push(<code key={key}>{groups.code.slice(1, -1)}</code>);
    else if (groups.link) {
      const label = groups.label, figure = groups.link.startsWith('!');
      const artifact = resolveReportArtifact(groups.href,sources);
      if (artifact && figure) {
        let table: ReturnType<typeof artifactTable> | undefined;
        if (['table','dataset'].includes(artifact.kind)) { try { table=artifactTable(artifact.content,artifact.kind==='dataset'||artifact.mediaType==='text/csv'); } catch { /* Keep exact saved text accessible through evidence. */ } }
        output.push(<figure key={key} className="report-inline-artifact">{artifact.kind==='plot' ? <button className="report-figure-open" aria-label={`Open exact figure ${artifact.title}`} disabled={!onArtifact} onClick={()=>onArtifact?.(artifact)}><img src={svgImageUrl(artifact)} alt={label || artifact.title} style={{maxWidth:`${Number(artifact.metadata?.presentationWidth)||100}%`}}/></button> : table ? <div className="data-table-wrap"><table className="data-table"><thead><tr>{table.columns.map((column,i)=><th key={i}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div> : <pre>{artifact.content}</pre>}<figcaption>{label || String(artifact.metadata?.caption ?? artifact.title)} · <button className="text-button" disabled={!onArtifact} onClick={()=>onArtifact?.(artifact)}>Open exact evidence</button><small>Version {artifact.hash.slice(0,12)}</small></figcaption></figure>);
      } else if (artifact) output.push(<button key={key} className="text-button citation" title={`Exact saved version ${artifact.hash}`} onClick={()=>onArtifact?.(artifact)}>{label || artifact.title}</button>);
      else {
        const url = safeUrl(groups.href);
        output.push(url && !figure ? <a key={key} href={url} target="_blank" rel="noreferrer">{nested(label)}</a> : figure ? <span key={key} className="unsupported-citation">Figure reference unavailable: {label} · select a captured figure to insert it.</span> : <Fragment key={key}>{nested(label)}</Fragment>);
      }
    } else if (groups.strong) output.push(<strong key={key}>{nested(groups.strongText)}</strong>);
    else if (groups.under) output.push(<strong key={key}>{nested(groups.underText)}</strong>);
    else if (groups.em) output.push(<em key={key}>{nested(groups.emText)}</em>);
    else if (groups.emUnder) output.push(<em key={key}>{nested(groups.emUnderText)}</em>);
    else if (groups.strike) output.push(<del key={key}>{nested(groups.strikeText)}</del>);
    else if (groups.cite) {
      const reference = groups.ref;
      const source = sources.find(s => s.sourceId === reference || s.id === reference) ?? sources[/^\d+$/.test(reference) ? Number(reference) - 1 : -1];
      output.push(source ? <a key={key} className="citation" href={`#evidence-${scope}-${source.id}`} title={`Captured evidence: ${source.title}`} onClick={event => { event.preventDefault(); const element = document.getElementById(`evidence-${scope}-${source.id}`); if (element instanceof HTMLDetailsElement) { element.open = true; element.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }}>{reference}</a> : /^[SI]\d+$/i.test(reference) ? <span key={key} className="unsupported-citation" title="No captured support was found for this citation">{match[0]} · unsupported</span> : <span key={key}>{match[0]}</span>);
    } else {
      const url = safeUrl(groups.url);
      output.push(url ? <a key={key} href={url} target="_blank" rel="noreferrer" title={url}>{shortUrl(groups.url)}</a> : groups.url);
    }
    at = index + match[0].length;
  }
  if (at < value.length) output.push(value.slice(at));
  return output;
}

/** Safe inline wording for compact form labels and questions. */
export function InlineText({ text }: { text: string }) {
  return <>{inline(text, [], '')}</>;
}

type MarkdownList = { type: 'list'; ordered: boolean; items: { text: string; value?: number; children: MarkdownList[] }[] };
type MarkdownBlock = { type: 'heading'; level: number; text: string } | MarkdownList | { type: 'table'; header: string[]; rows: string[][] } | { type: 'quote' | 'code' | 'paragraph'; text: string } | { type: 'rule' };
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/u;
const ITEM = /^(\s*)(?:([-*+•])|(\d{1,4})[.)])\s+(.*)$/u;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u;
const cells = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());

/** Line-based Markdown: a heading, list, table, quote or code fence starts its own block even without a blank line before it. */
function markdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n'), blocks: MarkdownBlock[] = [];
  const table = (index: number) => lines[index].includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1]) && lines[index + 1].includes('-');
  // As in CommonMark, only a bullet or a list starting at 1 interrupts a paragraph.
  const starts = (index: number) => { const item = RULE.test(lines[index]) ? null : ITEM.exec(lines[index]); return HEADING.test(lines[index]) || RULE.test(lines[index]) || FENCE.test(lines[index]) || QUOTE.test(lines[index]) || table(index) || Boolean(item && (item[2] || item[3] === '1')); };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line), heading = HEADING.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ type: 'code', text: body.join('\n') }); i++;
    } else if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); i++; }
    else if (RULE.test(line)) { blocks.push({ type: 'rule' }); i++; }
    else if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !starts(i)); i++) body.push(QUOTE.exec(lines[i])?.[1] ?? lines[i]);
      blocks.push({ type: 'quote', text: body.join('\n') });
    } else if (table(i)) {
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
      blocks.push({ type: 'table', header: cells(line), rows });
    } else if (ITEM.test(line)) {
      const entries: { indent: number; ordered: boolean; value?: number; text: string }[] = [];
      for (; i < lines.length; i++) {
        const item = RULE.test(lines[i]) ? null : ITEM.exec(lines[i]);
        if (item) { entries.push({ indent: item[1].replace(/\t/gu, '    ').length, ordered: Boolean(item[3]), value: item[3] ? Number(item[3]) : undefined, text: item[4] }); continue; }
        if (!lines[i].trim()) {
          // A blank line keeps the list going when another item or an indented line follows.
          let next = i + 1; while (next < lines.length && !lines[next].trim()) next++;
          if (next < lines.length && ((ITEM.test(lines[next]) && !RULE.test(lines[next])) || /^\s{2,}\S/u.test(lines[next]))) { i = next - 1; continue; }
          break;
        }
        if (starts(i)) break;
        entries.at(-1)!.text += `\n${lines[i].trim()}`;
      }
      const root: MarkdownList = { type: 'list', ordered: entries[0].ordered, items: [] }, stack = [{ indent: entries[0].indent, list: root }];
      for (const entry of entries) {
        while (stack.length > 1 && entry.indent < stack.at(-1)!.indent) stack.pop();
        let level = stack.at(-1)!;
        if (entry.indent >= level.indent + 2 && level.list.items.length) {
          const child: MarkdownList = { type: 'list', ordered: entry.ordered, items: [] };
          level.list.items.at(-1)!.children.push(child); level = { indent: entry.indent, list: child }; stack.push(level);
        }
        level.list.items.push({ text: entry.text, value: entry.value, children: [] });
      }
      blocks.push(root);
    } else {
      const body = [line];
      for (i++; i < lines.length && lines[i].trim() && !starts(i); i++) body.push(lines[i]);
      blocks.push({ type: 'paragraph', text: body.join('\n') });
    }
  }
  return blocks;
}

function MarkdownBlocks({ blocks, render }: { blocks: MarkdownBlock[]; render: (text: string) => ReactNode[] }) {
  const lines = (text: string) => text.split('\n').flatMap((line, index) => index ? [<br key={`br-${index}`}/>, ...render(line)] : render(line));
  const list = (value: MarkdownList, key: number | string): ReactNode => {
    const numbers = value.items.map(item => item.value ?? 0);
    // Keep the numbers a writer chose (for example cited sources 1, 3, 4); "1. 1. 1." still counts up.
    const exact = value.ordered && numbers.every((n, i) => !i || n > numbers[i - 1]) && numbers.some((n, i) => i > 0 && n !== numbers[i - 1] + 1);
    const references = !value.ordered && value.items.every(item => /^\[\d+\]\s/u.test(item.text));
    const items = value.items.map((item, index) => <li key={index} value={exact ? item.value : undefined}>{lines(item.text)}{item.children.map((child, childIndex) => list(child, childIndex))}</li>);
    return value.ordered ? <ol key={key} start={numbers[0] > 1 && !exact ? numbers[0] : undefined}>{items}</ol> : <ul key={key} className={references ? 'md-references' : undefined}>{items}</ul>;
  };
  return <>{blocks.map((block, i) => block.type === 'heading' ? <h4 key={i} className={`md-h${Math.min(block.level, 4)}`}>{render(block.text)}</h4>
    : block.type === 'list' ? list(block, i)
    : block.type === 'table' ? <div key={i} className="data-table-wrap"><table className="data-table"><thead><tr>{block.header.map((cell,j)=><th key={j}>{render(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row,j)=><tr key={j}>{row.map((cell,k)=><td key={k}>{render(cell)}</td>)}</tr>)}</tbody></table></div>
    : block.type === 'quote' ? <blockquote key={i}>{lines(block.text)}</blockquote>
    : block.type === 'code' ? <pre key={i} className="md-code"><code>{block.text}</code></pre>
    : block.type === 'rule' ? <hr key={i}/>
    : block.text.includes('![') ? <div key={i} className="report-paragraph">{render(block.text)}</div> : <p key={i}>{render(block.text)}</p>)}</>;
}

/** Text-only rendering: provider content is never inserted as HTML. */
export function RichText({ text, sources = [], scope = '', onArtifact }: { text: string; sources?: Artifact[]; scope?: string; onArtifact?:(artifact:Artifact)=>void }) {
  return <div className="rich-text"><MarkdownBlocks blocks={markdownBlocks(text)} render={value => inline(value, sources, scope, onArtifact)}/></div>;
}

/** Drop a marker left open by a cut, rather than show it. */
const balance = (text: string, marker: string) => { const parts = text.split(marker); return parts.length % 2 ? text : `${parts.slice(0, -1).join(marker)}${parts.at(-1)}`; };
/** A card-sized excerpt: whole lines while they fit, so emphasis and links stay intact; the card clips the rest. */
export function MarkdownPreview({ text, limit = 420 }: { text: string; limit?: number }) {
  const kept: string[] = []; let used = 0;
  for (const line of text.trim().split('\n')) {
    if (used + line.length <= limit) { kept.push(line); used += line.length + 1; continue; }
    const room = limit - used;
    if (room > 60) {
      let part = line.slice(0, room).replace(/\s+\S*$/u, '');
      const open = part.lastIndexOf('[');
      if (open > part.lastIndexOf(']')) part = part.slice(0, open);
      for (const marker of ['**', '__', '~~', '`', '*']) part = balance(part, marker);
      kept.push(`${part.trimEnd()}…`);
    }
    break;
  }
  return <div className="rich-text markdown-preview"><MarkdownBlocks blocks={markdownBlocks(kept.join('\n'))} render={value => inline(value, [], '')}/></div>;
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
