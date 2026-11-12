import { svgImageUrl } from '../shared/reports';
import type { Artifact } from '../shared/types';
import { textPreview } from '../shared/presentation';
import { parseCsv } from './Experiment';
import { MarkdownPreview } from './Content';

/** How many rows of a table a card shows; the rest open in the reading surface. */
const TABLE_PREVIEW_ROWS = 6;
function tableRows(artifact: Artifact, parsed: unknown): unknown[][] {
  let rows:unknown[][] = artifact.kind==='dataset' || artifact.mediaType==='text/csv' ? parseCsv(artifact.content) : [];
  // Rows only when every row is one: a list with an empty row (None from Python) or a stray value shows as text.
  const records = Array.isArray(parsed) && parsed.length>0 && parsed.every(row=>row!==null && typeof row==='object' && !Array.isArray(row));
  if (records) { const list=parsed as Record<string,unknown>[], columns=Object.keys(list[0]); rows=[columns,...list.map(row=>columns.map(column=>row[column]))]; }
  else if (Array.isArray(parsed) && parsed.length>0 && parsed.every(row=>Array.isArray(row))) rows=parsed as unknown[][];
  return rows;
}
/** The facts a card's header line gives about a saved result: the size of a table. Empty for anything else. */
export function artifactFacts(artifact: Artifact): string {
  if (artifact.kind !== 'dataset' && artifact.kind !== 'table') return '';
  let parsed:unknown;
  try { parsed=JSON.parse(artifact.content); } catch { /* A CSV is read as text. */ }
  const rows = tableRows(artifact, parsed), count = Math.max(0, rows.length-1), columns = rows[0]?.length ?? 0;
  return rows.length ? `${count} row${count===1?'':'s'} · ${columns} column${columns===1?'':'s'}` : '';
}

/** A single compact preview; complete versions open in the reading surface. */
export function BlockPreview({artifact, compact=false}: {artifact:Artifact; compact?:boolean}) {
  if (artifact.kind === 'plot') return <img className={`block-figure-preview ${compact?'compact':''}`} src={svgImageUrl(artifact)} alt={artifact.title}/>;
  let parsed:unknown;
  try { parsed=JSON.parse(artifact.content); } catch { /* Original text remains available. */ }
  if (artifact.kind === 'metric' && parsed && typeof parsed === 'object' && 'value' in parsed) return <strong className="block-metric-preview">{String(parsed.value)}</strong>;
  if (artifact.kind === 'dataset' || artifact.kind === 'table') {
    const rows = tableRows(artifact, parsed);
    if (rows.length) return <div className="block-table-preview"><table><thead><tr>{rows[0]?.slice(0,4).map((cell,index)=><th key={index}>{String(cell)}</th>)}</tr></thead><tbody>{rows.slice(1,compact?2:TABLE_PREVIEW_ROWS+1).map((row,index)=><tr key={index}>{row.slice(0,4).map((cell,column)=><td key={column}>{String(cell??'')}</td>)}</tr>)}</tbody></table></div>;
  }
  if (artifact.kind==='code') return <pre className="block-code-preview">{artifact.content.split('\n').slice(0,compact?2:5).join('\n')}</pre>;
  // Reports and results are Markdown, so headings and lists read as such on the card.
  if (artifact.mediaType==='text/markdown') return <MarkdownPreview text={artifact.content} limit={compact?100:220}/>;
  return <p className="block-text-preview">{textPreview(artifact.content,compact?100:220).text}</p>;
}
