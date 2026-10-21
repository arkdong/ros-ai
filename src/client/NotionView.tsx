import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, LoaderCircle, Rows3, RotateCw } from 'lucide-react';
import type { NotionPage, NotionRead, NotionTable, NotionView } from '../shared/types';
import { MAX_ROW_BLOCKS } from '../shared/notion-rows';
import { api } from './api';
import { MarkdownPreview, RichText } from './Content';
import './notion-view.css';

const PREVIEW_PROPERTIES = 4;
/** When it was read: the time today, with the date on another day (a read kept across restarts). */
const clock = (at: string) => { const date = new Date(at), time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`; };
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** What one block per row did, for the line the footer shows afterwards. */
export type RowBlocksOutcome = { added: number; skipped: number; beyond: number };

/** A Notion database or page read live through the person's Notion connection; nothing of it is saved in ros.ai.
 * `onRows` turns a database's rows into page blocks; without it the footer offers no such action. */
export function NotionBlock({ projectId, nodeId, view, full = false, onRows }: { projectId: string; nodeId: string; view: NotionView; full?: boolean; onRows?: (table: NotionTable) => Promise<RowBlocksOutcome | null> }) {
  const [read, setRead] = useState<NotionRead | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [asking, setAsking] = useState(false);
  const key = JSON.stringify(view);
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setRead(await api<NotionRead>(`/api/projects/${projectId}/nodes/${nodeId}/notion${refresh ? '?refresh=1' : ''}`, { signal: AbortSignal.timeout(60_000) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, nodeId, key]);
  useEffect(() => { void load(); }, [load]);
  const page = read?.kind === 'page' ? read : null, table = read && read.kind !== 'page' ? read : null;
  return <div className={`notion-block${full ? ' full' : ''}${page ? ' page' : ''}`}>
    {/* One box of fixed height in a card, whatever the state, so the card is measured once at its full size. */}
    <div className="notion-block-scroll nowheel">{error ? <p className="notion-block-error">{error}</p>
      : !read ? <p className="notion-block-loading"><LoaderCircle size={13} className="spin"/> Reading from Notion…</p>
      : page ? <PageBody page={page} full={full}/> : <TableBody table={table!}/>}</div>
    {read?.notice && <p className="notion-block-notice">{read.notice}</p>}
    <footer>
      {page ? <PageFooter page={page} full={full}/> : <TableFooter table={table} onRows={onRows} asking={asking} setAsking={setAsking}/>}
      {!asking && <button className="icon-button" aria-label="Read again from Notion" title="Read again from Notion (otherwise a read is reused for 10 minutes)" disabled={loading} onClick={event => { stop(event); void load(true); }}>{loading ? <LoaderCircle size={13} className="spin"/> : <RotateCw size={13}/>}</button>}
      {!asking && read?.link && <a className="notion-block-open" href={read.link} target="_blank" rel="noreferrer" onClick={stop}>Open in Notion <ArrowUpRight size={12}/></a>}
    </footer>
  </div>;
}

function TableBody({ table }: { table: NotionTable }) {
  const columns = table.columns;
  return <><table>
    <thead><tr>{columns.map(name => <th key={name} title={name}>{name}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, index) => <tr key={row.url || index}>{columns.map((name, column) => <td key={name} title={row[name]}>{column === 0 && row.url ? <a href={row.url} target="_blank" rel="noreferrer" onClick={stop}>{row[name] || 'Untitled'}</a> : row[name]}</td>)}</tr>)}</tbody>
  </table>{!table.rows.length && <p className="notion-block-empty">No rows match.</p>}</>;
}

function TableFooter({ table, onRows, asking, setAsking }: { table: NotionTable | null; onRows?: (table: NotionTable) => Promise<RowBlocksOutcome | null>; asking: boolean; setAsking: (value: boolean) => void }) {
  const [busy, setBusy] = useState(false), [done, setDone] = useState('');
  if (!table) return <span>Live from Notion</span>;
  const count = Math.min(MAX_ROW_BLOCKS, table.rows.length);
  if (asking) return <>
    <span title="Each block shows its page live and is linked to this database. Rows already on the canvas are skipped.">{table.rows.length > MAX_ROW_BLOCKS ? `First ${MAX_ROW_BLOCKS} of ${table.rows.length} rows; narrow the filter for the rest.` : `Add one block per row?`}</span>
    <button className="small secondary notion-block-action" disabled={busy} onClick={event => { stop(event); setAsking(false); }}>Cancel</button>
    <button className="small primary notion-block-action" disabled={busy} onClick={async event => { stop(event); setBusy(true); try { const outcome = await onRows!(table); if (outcome) setDone(outcome.added ? `Added ${outcome.added} block${outcome.added === 1 ? '' : 's'}${outcome.skipped ? ` · ${outcome.skipped} already on the canvas` : ''}` : outcome.skipped ? 'Every row is on the canvas already' : 'No rows to add'); } finally { setBusy(false); setAsking(false); } }}>{busy ? <LoaderCircle size={12} className="spin"/> : null}Add {count}</button>
  </>;
  return <>
    <span>{done || `${table.rows.length}${table.truncated ? '+' : ''} row${table.rows.length === 1 ? '' : 's'} · read ${clock(table.fetchedAt)}`}</span>
    {onRows && table.rows.length > 0 && <button className="icon-button" aria-label="One block per row" title="One block per row: a page block for each row, linked to this database" onClick={event => { stop(event); setDone(''); setAsking(true); }}><Rows3 size={13}/></button>}
  </>;
}

function PageBody({ page, full }: { page: NotionPage; full: boolean }) {
  // The title is the block's title already; the card keeps to the first filled fields, the block view shows every field.
  const fields = page.properties.filter(property => property.value !== page.title || property.links?.length);
  const properties = full ? fields : fields.filter(property => property.value).slice(0, PREVIEW_PROPERTIES);
  return <>
    {properties.length > 0 && <dl className="notion-page-properties">{properties.map(property => <div key={property.name}><dt title={property.name}>{property.name}</dt><dd title={property.value}>{property.links?.length ? property.links.map((link, index) => <a key={index} href={link.url} target="_blank" rel="noreferrer" onClick={stop}>{link.text}<ArrowUpRight size={10}/></a>) : property.value || <span className="notion-page-blank">—</span>}</dd></div>)}</dl>}
    {page.content ? <div className="notion-page-content">{full ? <RichText text={page.content}/> : <MarkdownPreview text={page.content} limit={360}/>}</div> : !properties.length ? <p className="notion-block-empty">An empty page.</p> : null}
  </>;
}

function PageFooter({ page, full }: { page: NotionPage; full: boolean }) {
  const where = page.parent ? (full && page.parent.link ? <a href={page.parent.link} target="_blank" rel="noreferrer" onClick={stop}>{page.parent.title}</a> : page.parent.title) : null;
  return <span>{where}{where ? ' · ' : ''}read {clock(page.fetchedAt)}</span>;
}
