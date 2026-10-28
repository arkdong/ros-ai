import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, LoaderCircle, Rows3, RotateCw } from 'lucide-react';
import type { NotionAccount, NotionPage, NotionRead, NotionTable, NotionView } from '../shared/types';
import type { AppConnectionStatus } from '../shared/plugins';
import { MAX_ROW_BLOCKS } from '../shared/notion-rows';
import { api } from './api';
import { NotionPageEditor, NotionText } from './NotionPage';
import { AccountTile } from './PluginsPage';
import { clock, stop } from './live-block';
import './live-block.css';
import './notion-view.css';

/** What one block per row did, for the line the footer shows afterwards. */
export type RowBlocksOutcome = { added: number; skipped: number; beyond: number };

/** A Notion database or page read live through the person's Notion connection; nothing of it is saved in ros.ai.
 * `onRows` turns a database's rows into page blocks; without it the footer offers no such action. With several Notion
 * accounts the footer names the one that read it, and in the block view `onAccount` reads it with another. */
export function NotionBlock({ projectId, nodeId, view, full = false, readOnly = false, onRows, onTitle, onAccount }: { projectId: string; nodeId: string; view: NotionView; full?: boolean; readOnly?: boolean; onRows?: (table: NotionTable) => Promise<RowBlocksOutcome | null>; onTitle?: (title: string) => void; onAccount?: (account: string) => void }) {
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
  const chip = Boolean(read?.account && full && onAccount && !readOnly), who = chip ? undefined : read?.account?.name;
  return <div className={`live-block notion-block${full ? ' full' : ''}${page ? ' document' : ''}`}>
    {/* One box of fixed height in a card, whatever the state, so the card is measured once at its full size. */}
    <div className="live-block-scroll nowheel">{error ? <p className="live-block-error">{error}</p>
      : !read ? <p className="live-block-loading"><LoaderCircle size={13} className="spin"/> Reading from Notion…</p>
      : page ? (full ? <NotionPageEditor page={page} projectId={projectId} nodeId={nodeId} readOnly={readOnly} onSaved={setRead} onTitle={onTitle}/> : <PageBody page={page}/>) : <TableBody table={table!}/>}</div>
    {read?.notice && <p className="live-block-notice">{read.notice}</p>}
    <footer>
      {chip && !asking && <ReadWith account={read!.account!} chosen={view.account} kind={page ? 'page' : 'database'} onAccount={onAccount!}/>}
      {page ? <PageFooter page={page} full={full} who={who}/> : <TableFooter table={table} who={who} onRows={onRows} asking={asking} setAsking={setAsking}/>}
      {!asking && <button className="icon-button" aria-label="Read again from Notion" title="Read again from Notion (otherwise a read is reused for 10 minutes)" disabled={loading} onClick={event => { stop(event); void load(true); }}>{loading ? <LoaderCircle size={13} className="spin"/> : <RotateCw size={13}/>}</button>}
      {!asking && read?.link && <a className="live-block-open" href={read.link} target="_blank" rel="noreferrer" onClick={stop}>Open in Notion <ArrowUpRight size={12}/></a>}
    </footer>
  </div>;
}

function TableBody({ table }: { table: NotionTable }) {
  const columns = table.columns;
  return <><table>
    <thead><tr>{columns.map(name => <th key={name} title={name}>{name}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, index) => <tr key={row.url || index}>{columns.map((name, column) => <td key={name} title={row[name]}>{column === 0 && row.url ? <a href={row.url} target="_blank" rel="noreferrer" onClick={stop}>{row[name] || 'Untitled'}</a> : row[name]}</td>)}</tr>)}</tbody>
  </table>{!table.rows.length && <p className="live-block-empty">No rows match.</p>}</>;
}

/** The Notion account that read a block, ahead of the footer's line, while the person has several. */
const Who = ({ who }: { who?: string }) => who ? <><strong>{who}</strong> · </> : null;

function TableFooter({ table, who, onRows, asking, setAsking }: { table: NotionTable | null; who?: string; onRows?: (table: NotionTable) => Promise<RowBlocksOutcome | null>; asking: boolean; setAsking: (value: boolean) => void }) {
  const [busy, setBusy] = useState(false), [done, setDone] = useState('');
  if (!table) return <span>Live from Notion</span>;
  const count = Math.min(MAX_ROW_BLOCKS, table.rows.length);
  if (asking) return <>
    <span title="Each block shows its page live and is linked to this database. Rows already on the canvas are skipped.">{table.rows.length > MAX_ROW_BLOCKS ? `First ${MAX_ROW_BLOCKS} of ${table.rows.length} rows; narrow the filter for the rest.` : `Add one block per row?`}</span>
    <button className="small secondary live-block-action" disabled={busy} onClick={event => { stop(event); setAsking(false); }}>Cancel</button>
    <button className="small primary live-block-action" disabled={busy} onClick={async event => { stop(event); setBusy(true); try { const outcome = await onRows!(table); if (outcome) setDone(outcome.added ? `Added ${outcome.added} block${outcome.added === 1 ? '' : 's'}${outcome.skipped ? ` · ${outcome.skipped} already on the canvas` : ''}` : outcome.skipped ? 'Every row is on the canvas already' : 'No rows to add'); } finally { setBusy(false); setAsking(false); } }}>{busy ? <LoaderCircle size={12} className="spin"/> : null}Add {count}</button>
  </>;
  return <>
    <span><Who who={who}/>{done || `${table.rows.length}${table.truncated ? '+' : ''} row${table.rows.length === 1 ? '' : 's'} · read ${clock(table.fetchedAt)}`}</span>
    {onRows && table.rows.length > 0 && <button className="icon-button" aria-label="One block per row" title="One block per row: a page block for each row, linked to this database" onClick={event => { stop(event); setDone(''); setAsking(true); }}><Rows3 size={13}/></button>}
  </>;
}

/** The card: the first filled fields and a few lines of text; the title is the block's title already. */
function PageBody({ page }: { page: NotionPage }) {
  // The card scrolls through every filled field and the whole text, as the block view shows them.
  const properties = page.properties.filter(property => property.type !== 'title' && property.value);
  return <>
    {properties.length > 0 && <dl className="notion-page-properties">{properties.map(property => <div key={property.name}><dt title={property.name}>{property.name}</dt><dd title={property.value}>{property.links?.length ? property.links.map((link, index) => <a key={index} href={link.url} target="_blank" rel="noreferrer" onClick={stop}>{link.text}<ArrowUpRight size={10}/></a>) : property.value}</dd></div>)}</dl>}
    {page.units.length ? <div className="live-block-text"><NotionText page={page}/></div> : !properties.length ? <p className="live-block-empty">An empty page.</p> : null}
  </>;
}

function PageFooter({ page, full, who }: { page: NotionPage; full: boolean; who?: string }) {
  const where = page.parent ? (full && page.parent.link ? <a href={page.parent.link} target="_blank" rel="noreferrer" onClick={stop}>{page.parent.title}</a> : page.parent.title) : null;
  return <span><Who who={who}/>{where}{where ? ' · ' : ''}{full && page.editedAt ? `edited ${clock(page.editedAt)} · ` : ''}read {clock(page.fetchedAt)}</span>;
}

/** In the block view, with several Notion accounts: the account that reads the block, and a menu to read it with
 * another. chosen: the account the person picked for it, if any; otherwise ros.ai found the one that opens it. */
function ReadWith({ account, chosen, kind, onAccount }: { account: NotionAccount; chosen?: string; kind: 'page' | 'database'; onAccount: (account: string) => void }) {
  const [open, setOpen] = useState(false), [accounts, setAccounts] = useState<NotionAccount[]>([account]);
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // The accounts signed in now, the default first, as Plugins › Notion lists them.
    void api<{ apps: AppConnectionStatus[] }>('/api/apps').then(value => { const live = (value.apps.find(item => item.id === 'notion')?.accounts ?? []).filter(item => item.connected); if (live.length) setAccounts(live.map(({ key, name }) => ({ key, name }))); }).catch(() => undefined);
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); };
  }, [open]);
  return <div className="notion-read-with">
    <button ref={trigger} type="button" className="notion-account-chip" aria-haspopup="menu" aria-expanded={open} aria-label={`Read with ${account.name}`} onClick={event => { stop(event); setOpen(value => !value); }}><AccountTile name={account.name} small/>{account.name}<ChevronDown size={12}/></button>
    {open && <div ref={menuRef} className="ros-model-menu notion-account-menu" role="menu" aria-label="Read with">
      <p>Read this {kind} with</p>
      {accounts.map(item => <button key={item.key} type="button" role="menuitemradio" aria-checked={item.key === account.key} onClick={event => { stop(event); setOpen(false); if (item.key !== chosen) onAccount(item.key); }}><AccountTile name={item.name} small/><span className="ros-menu-label">{item.name}</span>{item.key === account.key && <><small>{chosen === item.key ? 'Chosen' : 'Found it here'}</small><Check size={14}/></>}</button>)}
      <p className="notion-account-note">Change it when two accounts can open the same {kind}.</p>
    </div>}
  </div>;
}
