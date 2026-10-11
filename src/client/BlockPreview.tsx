import { svgImageUrl } from '../shared/reports';
import type { Artifact } from '../shared/types';
import { textPreview } from '../shared/presentation';
import { parseCsv } from './Experiment';
import { MarkdownPreview } from './Content';

/** A single compact preview; complete versions open in the reading surface. */
export function BlockPreview({artifact, compact=false}: {artifact:Artifact; compact?:boolean}) {
  if (artifact.kind === 'plot') return <img className={`block-figure-preview ${compact?'compact':''}`} src={svgImageUrl(artifact)} alt={artifact.title}/>;
  let parsed:unknown;
  try { parsed=JSON.parse(artifact.content); } catch { /* Original text remains available. */ }
  if (artifact.kind === 'metric' && parsed && typeof parsed === 'object' && 'value' in parsed) return <strong className="block-metric-preview">{String(parsed.value)}</strong>;
  if (artifact.kind === 'dataset' || artifact.kind === 'table') {
    let rows:unknown[][] = artifact.kind==='dataset' || artifact.mediaType==='text/csv' ? parseCsv(artifact.content) : [];
    if (Array.isArray(parsed) && parsed.length && parsed[0] && typeof parsed[0]==='object' && !Array.isArray(parsed[0])) { const columns=Object.keys(parsed[0]); rows=[columns,...parsed.map(row=>columns.map(column=>(row as Record<string,unknown>)[column]))]; }
    if (Array.isArray(parsed) && Array.isArray(parsed[0])) rows=parsed;
    return <div className="block-table-preview"><table><thead><tr>{rows[0]?.slice(0,4).map((cell,index)=><th key={index}>{String(cell)}</th>)}</tr></thead><tbody>{rows.slice(1,compact?2:4).map((row,index)=><tr key={index}>{row.slice(0,4).map((cell,column)=><td key={column}>{String(cell??'')}</td>)}</tr>)}</tbody></table><small>{Math.max(0,rows.length-1)} rows · {rows[0]?.length??0} columns · open full data</small></div>;
  }
  if (artifact.kind==='code') return <pre className="block-code-preview">{artifact.content.split('\n').slice(0,compact?2:5).join('\n')}</pre>;
  // Reports and results are Markdown, so headings and lists read as such on the card.
  if (artifact.mediaType==='text/markdown') return <MarkdownPreview text={artifact.content} limit={compact?100:220}/>;
  return <p className="block-text-preview">{textPreview(artifact.content,compact?100:220).text}</p>;
}
