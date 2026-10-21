import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, LoaderCircle, RotateCw } from 'lucide-react';
import type { NotionTable, NotionView } from '../shared/types';
import { api } from './api';
import './notion-view.css';

/** When the rows were read: the time today, with the date on another day (a read kept across restarts). */
const clock = (at: string) => { const date = new Date(at), time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`; };

/** A Notion database read live through the person's Notion connection; nothing of it is saved in ros.ai. */
export function NotionDatabase({ projectId, nodeId, view, full = false }: { projectId: string; nodeId: string; view: NotionView; full?: boolean }) {
  const [table, setTable] = useState<NotionTable | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const key = JSON.stringify(view);
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setTable(await api<NotionTable>(`/api/projects/${projectId}/nodes/${nodeId}/notion${refresh ? '?refresh=1' : ''}`, { signal: AbortSignal.timeout(60_000) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, nodeId, key]);
  useEffect(() => { void load(); }, [load]);
  const columns = table?.columns ?? [];
  return <div className={`notion-database${full ? ' full' : ''}`}>
    {/* One box of fixed height in a card, whatever the state, so the card is measured once at its full size. */}
    <div className="notion-database-scroll nowheel">{error ? <p className="notion-database-error">{error}</p>
      : !table ? <p className="notion-database-loading"><LoaderCircle size={13} className="spin"/> Reading from Notion…</p>
      : <><table>
        <thead><tr>{columns.map(name => <th key={name} title={name}>{name}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={row.url || index}>{columns.map((name, column) => <td key={name} title={row[name]}>{column === 0 && row.url ? <a href={row.url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{row[name] || 'Untitled'}</a> : row[name]}</td>)}</tr>)}</tbody>
      </table>{!table.rows.length && <p className="notion-database-empty">No rows match.</p>}</>}</div>
    {table?.notice && <p className="notion-database-notice">{table.notice}</p>}
    <footer>
      <span>{table ? `${table.rows.length}${table.truncated ? '+' : ''} row${table.rows.length === 1 ? '' : 's'} · read ${clock(table.fetchedAt)}` : 'Live from Notion'}</span>
      <button className="icon-button" aria-label="Read again from Notion" title="Read again from Notion (otherwise a read is reused for 10 minutes)" disabled={loading} onClick={event => { event.stopPropagation(); void load(true); }}>{loading ? <LoaderCircle size={13} className="spin"/> : <RotateCw size={13}/>}</button>
      {table?.link && <a className="notion-database-open" href={table.link} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>Open in Notion <ArrowUpRight size={12}/></a>}
    </footer>
  </div>;
}
