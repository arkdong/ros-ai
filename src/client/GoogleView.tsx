import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, CopyPlus, LoaderCircle, RotateCw } from 'lucide-react';
import type { GoogleDoc, GoogleRead, GoogleSheet, GoogleView } from '../shared/types';
import { api } from './api';
import { MarkdownPreview, RichText } from './Content';
import { clock, stop } from './live-block';
import './live-block.css';

/** A Google Sheet or Doc read live through the Google Drive sign-in; ros.ai keeps only which file (and tab) it shows.
 * `onCopy` copies the tab into a new Data block and `onSheet` shows another tab; without them the block offers neither. */
export function GoogleBlock({ projectId, nodeId, view, full = false, onCopy, onSheet }: { projectId: string; nodeId: string; view: GoogleView; full?: boolean; onCopy?: () => Promise<boolean>; onSheet?: (sheet: string) => void }) {
  const [read, setRead] = useState<GoogleRead | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false), [copied, setCopied] = useState(false);
  const key = JSON.stringify(view), app = view.kind === 'sheet' ? 'Google Sheets' : 'Google Docs';
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setRead(await api<GoogleRead>(`/api/projects/${projectId}/nodes/${nodeId}/google${refresh ? '?refresh=1' : ''}`, { signal: AbortSignal.timeout(60_000) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, nodeId, key]);
  useEffect(() => { void load(); }, [load]);
  const sheet = read?.kind === 'sheet' ? read : null, doc = read?.kind === 'doc' ? read : null;
  const tabs = full && onSheet && sheet && sheet.sheets.length > 1 ? sheet.sheets : null;
  const copy = async (event: { stopPropagation: () => void }) => { stop(event); setCopying(true); try { setCopied(await onCopy!()); } finally { setCopying(false); } };
  return <div className={`live-block google-block${full ? ' full' : ''}${view.kind === 'doc' ? ' document' : ''}`}>
    {/* One box of fixed height in a card, whatever the state, so the card is measured once at its full size. */}
    <div className="live-block-scroll nowheel">{error ? <p className="live-block-error">{error}</p>
      : !read ? <p className="live-block-loading"><LoaderCircle size={13} className="spin"/> Reading from {app}…</p>
      : sheet ? <SheetBody sheet={sheet}/> : <DocBody doc={doc!} full={full}/>}</div>
    {read?.notice && <p className="live-block-notice">{read.notice}</p>}
    {tabs && <nav className="live-block-tabs" aria-label="Tabs">{tabs.map(title => <button key={title} type="button" aria-pressed={title === sheet!.sheet} onClick={() => { if (title !== sheet!.sheet) onSheet!(title); }}>{title}</button>)}</nav>}
    <footer>
      <span>{copied ? 'Copied into a Data block' : sheet ? `${sheet.sheet && !tabs ? `${sheet.sheet} · ` : ''}${sheet.rows.length}${sheet.truncated ? '+' : ''} row${sheet.rows.length === 1 ? '' : 's'} · read ${clock(sheet.fetchedAt)}`
        : doc ? `${full && doc.modifiedAt ? `edited ${clock(doc.modifiedAt)} · ` : ''}read ${clock(doc.fetchedAt)}${doc.truncated ? ' · the first 200,000 characters' : ''}` : `Live from ${app}`}</span>
      {sheet && onCopy && (full
        ? <button className="small secondary live-block-action" disabled={copying} onClick={copy}>{copying ? <LoaderCircle size={12} className="spin"/> : <CopyPlus size={12}/>} Copy into a Data block</button>
        : <button className="icon-button" aria-label="Copy into a Data block" title="Copy into a Data block: every row of this tab, saved in the project for SQL and agents" disabled={copying} onClick={copy}>{copying ? <LoaderCircle size={13} className="spin"/> : <CopyPlus size={13}/>}</button>)}
      <button className="icon-button" aria-label={`Read again from ${app}`} title={`Read again from ${app} (otherwise a read is reused for a minute)`} disabled={loading} onClick={event => { stop(event); setCopied(false); void load(true); }}>{loading ? <LoaderCircle size={13} className="spin"/> : <RotateCw size={13}/>}</button>
      {read?.link && <a className="live-block-open" href={read.link} target="_blank" rel="noreferrer" onClick={stop}>Open in {app} <ArrowUpRight size={12}/></a>}
    </footer>
  </div>;
}

/** The tab's first rows under its first row's names, as Google Sheets shows the cells. */
function SheetBody({ sheet }: { sheet: GoogleSheet }) {
  if (!sheet.columns.length) return <p className="live-block-empty">This tab is empty.</p>;
  return <><table>
    <thead><tr>{sheet.columns.map((name, index) => <th key={index} title={name}>{name}</th>)}</tr></thead>
    <tbody>{sheet.rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column} title={value}>{value}</td>)}</tr>)}</tbody>
  </table>{!sheet.rows.length && <p className="live-block-empty">Only the column names; no rows below them.</p>}</>;
}

/** A card shows the doc's opening; the block view the whole text. */
function DocBody({ doc, full }: { doc: GoogleDoc; full: boolean }) {
  if (!doc.content) return <p className="live-block-empty">An empty doc.</p>;
  return <div className="live-block-text">{full ? <RichText text={doc.content}/> : <MarkdownPreview text={doc.content} limit={1_500}/>}</div>;
}
