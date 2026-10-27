import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, LoaderCircle, Play, X } from 'lucide-react';
import type { Artifact, CanvasNode } from '../shared/types';
import { SQL_ROWS_SHOWN, type SqlResult, type SqlTable, type SqlTables } from '../shared/sql';
import { api } from './api';
import { CodeEditor, modKey, type CodeEditorApi } from './code';
import { DataViewer } from './DataViewer';
import { useDraft } from './persistence';
import './sql-panel.css';

const text = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const send = <T,>(path: string, body: unknown, seconds: number) => api<T>(path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(seconds * 1000) });
function describe(table: SqlTable): string {
  const where = table.source === 'block' ? `Data block “${table.title}”` : table.path!;
  if (table.columns) return `${where} · ${table.columns.length === 1 ? '1 column' : `${table.columns.length} columns`}: ${table.columns.slice(0, 12).join(', ')}${table.columns.length > 12 ? ', …' : ''}`;
  return table.format === 'excel' ? `${where} · The first query that reads it downloads DuckDB’s Excel reader once.` : `${where} · DuckDB could not read it.`;
}

/**
 * SQL in a Data block: DuckDB on this computer reads the project's Data blocks and the CSV, Parquet and Excel files
 * in its folder. A result can be saved as a new Data block, or fill this block while it holds no data.
 */
export function SqlPanel({ projectId, node, revision, onSaved, onClose }: { projectId: string; node: CanvasNode; revision: number; onSaved: (artifact: Artifact, filled: boolean) => Promise<void>; onClose?: () => void }) {
  const [tables, setTables] = useState<SqlTables | null>(null), [unavailable, setUnavailable] = useState('');
  const [query, setQuery] = useDraft(`sql-query:${node.id}`);
  const [shown, setShown] = useState<{ sql: string; result: SqlResult; at: number } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState<'run' | 'save' | null>(null);
  const editor = useRef<CodeEditorApi | null>(null), prefilled = useRef(false);
  useEffect(() => {
    let live = true;
    api<SqlTables>(`/api/projects/${projectId}/sql/tables`, { signal: AbortSignal.timeout(60_000) }).then(value => {
      if (!live) return;
      setTables(value); setUnavailable('');
      // A first query reads this block's own table.
      const start = value.tables.find(table => table.nodeId === node.id) ?? value.tables[0];
      if (start && !prefilled.current) setQuery(current => current.trim() ? current : `SELECT *\nFROM ${start.name}\nLIMIT 100`);
      prefilled.current = true;
    }).catch(cause => { if (live) setUnavailable(text(cause)); });
    return () => { live = false; };
  }, [projectId, revision]);
  const schema = useMemo(() => tables ? Object.fromEntries(tables.tables.map(table => [table.name, table.columns ?? []])) : undefined, [tables]);
  const run = async () => {
    const sql = query.trim();
    if (!sql || busy) return;
    setBusy('run'); setError('');
    try { setShown({ sql, result: await send<SqlResult>(`/api/projects/${projectId}/sql/query`, { sql }, 60), at: Date.now() }); }
    catch (cause) { setShown(null); setError(text(cause)); }
    finally { setBusy(null); }
  };
  const fills = !node.artifactId, current = Boolean(shown && shown.sql === query.trim());
  const save = async () => {
    if (!shown || !current || busy) return;
    setBusy('save'); setError('');
    try { const saved = await send<{ artifact: Artifact; nodeId: string }>(`/api/projects/${projectId}/sql/save`, { sql: shown.sql, nodeId: node.id }, 120); await onSaved(saved.artifact, saved.nodeId === node.id); }
    catch (cause) { setError(text(cause)); }
    finally { setBusy(null); }
  };
  const result = shown?.result;
  return <div className="sql-panel" aria-label="SQL query">
    <div className="sql-toolbar">
      <button className="primary small" disabled={!query.trim() || Boolean(busy)} onClick={() => void run()} title={`Run (${modKey}Enter)`}>{busy === 'run' ? <LoaderCircle size={13} className="spin"/> : <Play size={13}/>} Run <kbd>{modKey}Enter</kbd></button>
      {result && <button className="secondary small" disabled={!current || Boolean(busy)} title={current ? undefined : 'Run the changed query first.'} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>} {fills ? 'Save to this block' : 'Save as Data block'}</button>}
      <span className="sql-time">{result && `${result.ms.toLocaleString()} ms · DuckDB`}</span>
      {onClose && <button className="text-button small" onClick={onClose}><X size={12}/> Close SQL</button>}
    </div>
    <CodeEditor apiRef={editor} ariaLabel="SQL query" language="sql" value={query} onChange={setQuery} sqlSchema={schema} onRun={() => void run()} autoFocus maxLength={20_000} placeholder="SELECT * FROM table_name"/>
    {tables && (tables.tables.length
      ? <div className="sql-tables" role="group" aria-label="Insert a table name"><span>Tables</span>{tables.tables.map(table => <button key={table.name} type="button" className="chip mono" title={describe(table)} onClick={() => editor.current?.insert(table.name)}>{table.name}</button>)}</div>
      : <p className="sql-note">No tables yet. Data blocks that hold data are tables{tables.folder ? ', and so are the CSV, Parquet and Excel files in the project folder' : ''}.</p>)}
    {unavailable && <p className="inline-error" role="alert">{unavailable}</p>}
    {error && <p className="inline-error sql-error" role="alert">{error}</p>}
    {shown && <>
      {shown.result.truncated && <p className="sql-note">The first {SQL_ROWS_SHOWN.toLocaleString()} rows are shown. Saving keeps every row.</p>}
      <DataViewer key={shown.at} data={{ columns: shown.result.columns, rows: shown.result.rows }} name={`${node.title} SQL`} compact/>
    </>}
  </div>;
}
