import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { extname, join, sep } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { DuckDBConnection } from '@duckdb/node-api';
import { artifactTable, tableCsv } from '../shared/data-view.js';
import { cardWidth } from '../shared/card-size.js';
import { LAYOUT_GAP } from '../shared/layout.js';
import { SQL_ROWS_SHOWN, type SqlFormat, type SqlResult, type SqlTable, type SqlTables } from '../shared/sql.js';
import type { Artifact, CanvasNode, Mutation, Run } from '../shared/types.js';
import { projectFolderRoot, type ProjectFolders } from './project-folders.js';
import { StoreError, type Store } from './store.js';

// A query may run for 30 seconds. A saved result is at most 5 MB of CSV, the most a Data block reads from the folder.
const QUERY_MS = 30_000, SAVE_BYTES = 5_000_000, SAVE_ROWS = 200_000, MAX_RUNNING = 2, MAX_BLOCKS = 100, MAX_FILES = 200, MAX_LISTED = 5000, HEADER_BYTES = 65_536;
const FORMATS: Record<string, SqlFormat> = { '.csv': 'csv', '.tsv': 'csv', '.parquet': 'parquet', '.xlsx': 'excel' };
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__', 'venv', 'site-packages']);
// Words DuckDB reserves; a table named after one would need quotes in every query.
const RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'default', 'deferrable', 'desc', 'describe', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect', 'into', 'lateral', 'leading', 'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'pivot', 'placing', 'primary', 'qualify', 'references', 'returning', 'select', 'show', 'some', 'summarize', 'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'unpivot', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with']);
const ONE_SELECT = 'Run one SELECT query. SQL here only reads your data; it cannot change files, tables or settings.';
const PIVOT = 'PIVOT is not supported here. Use GROUP BY with FILTER instead, for example: SELECT region, sum(amount) FILTER (WHERE year = 2024) AS y2024 FROM sales GROUP BY region';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const querySchema = z.string().trim().min(1, 'Write a query first.').max(20_000);
const now = () => new Date().toISOString();

type Source = SqlTable & { artifact?: Artifact; absolute?: string; bytes?: number; modified?: string };
type Opened = { connection: DuckDBConnection; version: string; columns: Map<string, string[]>; close: () => void };

const quoted = (name: string) => `"${name.replace(/"/gu, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/gu, "''")}'`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A name SQL can use without quotes: "Survey responses 2024" is survey_responses_2024. */
function tableName(title: string, taken: Set<string>, format?: SqlFormat): string {
  let base = title.normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 60) || 'data';
  if (/^[0-9]/u.test(base)) base = `t_${base}`;
  if (RESERVED.has(base)) base = `${base}_table`;
  let name = base;
  if (taken.has(name) && format) name = `${base}_${format}`;
  for (let index = 2; taken.has(name); index++) name = `${base}_${index}`;
  taken.add(name);
  return name;
}
/** The CSV, Parquet and Excel files in a project folder, skipping hidden and package folders and never following links. */
function dataFiles(root: string): { path: string; absolute: string; format: SqlFormat }[] {
  const found: { path: string; absolute: string; format: SqlFormat }[] = [];
  let visited = 0;
  const walk = (folder: string, rel: string, level: number) => {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (visited++ >= MAX_LISTED || found.length >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name, format = FORMATS[extname(entry.name).toLowerCase()];
      if (entry.isDirectory()) { if (level < 4 && !SKIPPED_FOLDERS.has(entry.name)) walk(join(folder, entry.name), child, level + 1); }
      else if (entry.isFile() && format) found.push({ path: child, absolute: join(folder, entry.name), format });
    }
  };
  walk(root, '', 0);
  return found;
}
/** Whether a query names a table, quoted or not. */
const mentions = (sql: string, name: string) => new RegExp(`(^|[^a-z0-9_])"?${name}"?($|[^a-z0-9_])`, 'iu').test(sql);
const cell = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);

/**
 * Runs DuckDB in this process, one in-memory database per query, holding the tables the query names. A Data block's
 * saved version is copied in as a table; the folder's data files are views DuckDB reads in place. Before the query runs, DuckDB is shut off from every
 * file outside the project folder, from extensions and from its own settings, and the query must be a single SELECT.
 */
export class SqlService {
  private running = 0;
  /** `queryMs` shortens how long a query may run, for tests. */
  constructor(private readonly store: Store, private readonly options: { folders?: Pick<ProjectFolders, 'status'>; extensionDirectory?: string; queryMs?: number } = {}) {}

  /** The tables a query can use, with their columns. */
  async tables(projectId: string): Promise<SqlTables> {
    const sources = this.sources(projectId);
    return this.withDatabase(projectId, sources, false, true, async opened => ({
      tables: sources.map(source => ({ name: source.name, title: source.title, source: source.source, format: source.format, ...(source.nodeId ? { nodeId: source.nodeId } : {}), ...(source.path ? { path: source.path } : {}), columns: opened.columns.get(source.name) ?? null })),
      folder: Boolean(projectFolderRoot(this.store, projectId)),
    }));
  }

  /** The first rows of a query's result. */
  async query(projectId: string, supplied: unknown): Promise<SqlResult> {
    const { sql } = z.object({ sql: querySchema }).strict().parse(supplied);
    const sources = this.sources(projectId).filter(source => mentions(sql, source.name));
    return this.withDatabase(projectId, sources, this.needsExcel(sql, sources), false, opened => this.read(opened.connection, sql, SQL_ROWS_SHOWN, sources));
  }

  /**
   * Saves a query's whole result as a new Data block beside the block it ran from, linked from the blocks it read.
   * A Data block that holds no data yet is filled instead.
   */
  async save(projectId: string, supplied: unknown): Promise<{ artifact: Artifact; nodeId: string }> {
    const body = z.object({ sql: querySchema, title: z.string().trim().min(1).max(200).optional(), nodeId: id }).strict().parse(supplied);
    if (!this.store.getProject(projectId).canvas.nodes.some(node => node.id === body.nodeId)) throw new StoreError('The block this query ran from was removed from the canvas.', 409);
    const used = this.sources(projectId).filter(source => mentions(body.sql, source.name));
    const { result, version } = await this.withDatabase(projectId, used, this.needsExcel(body.sql, used), false, async opened => ({ result: await this.read(opened.connection, body.sql, SAVE_ROWS, used), version: opened.version }));
    if (result.truncated) throw new StoreError(`The result has more than ${SAVE_ROWS.toLocaleString('en-US')} rows, more than a Data block holds. Narrow it with WHERE, GROUP BY or LIMIT.`);
    const csv = tableCsv({ columns: result.columns, rows: result.rows });
    if (Buffer.byteLength(csv, 'utf8') > SAVE_BYTES) throw new StoreError('The result is larger than 5 MB, the most a Data block holds. Narrow it with WHERE, GROUP BY or LIMIT.');
    const tables = used.map(source => source.artifact ? { name: source.name, nodeId: source.nodeId, artifactId: source.artifact.id, hash: source.artifact.hash } : { name: source.name, path: source.path, format: source.format, bytes: source.bytes, modified: source.modified });
    return this.store.atomic(() => {
      const project = this.store.getProject(projectId), from = project.canvas.nodes.find(node => node.id === body.nodeId);
      if (!from) throw new StoreError('The block this query ran from was removed from the canvas.', 409);
      // A block read by the query must still hold the version the query read.
      for (const source of used) if (source.artifact && project.canvas.nodes.find(node => node.id === source.nodeId)?.artifactId !== source.artifact.id) throw new StoreError(`${source.title} changed while the query ran. Run it again.`, 409);
      const fill = from.blockType === 'dataset' && !from.artifactId, title = fill ? from.title : body.title ?? `${from.title} (SQL)`.slice(0, 200), label = `Save query result: ${title}`.slice(0, 200);
      const node: CanvasNode = fill ? from : { id: randomUUID(), title, description: '', kind: 'topic', blockType: 'dataset', x: from.x + cardWidth(from) + LAYOUT_GAP, y: from.y, ...(from.parentId ? { parentId: from.parentId } : {}) };
      const linked = [...new Set(used.flatMap(source => source.nodeId ? [source.nodeId] : []))];
      const links = (fill ? linked : linked.length ? linked : [from.id]).filter(source => !project.canvas.connections.some(item => item.source === source && item.target === node.id));
      const operations: Mutation[] = [...(fill ? [] : [{ type: 'addNode' as const, node }]), ...links.map(source => ({ type: 'addConnection' as const, connection: { id: randomUUID(), source, target: node.id, label: 'SQL' } }))];
      if (operations.length) this.store.mutate(projectId, operations, label);
      const added = this.store.getProject(projectId).canvas.nodes.find(item => item.id === node.id)!;
      const inputs = used.flatMap(source => source.artifact ? [{ ...this.store.addInput(projectId, node.id, source.artifact.id), artifact: source.artifact }] : []);
      const at = now(), engine = `DuckDB ${version}`;
      const run: Run = { id: randomUUID(), projectId, nodeId: node.id, request: body.sql, useSearch: false, status: 'running', createdAt: at, startedAt: at, projectRevision: project.revision,
        node: structuredClone(added), inputs, messages: [], provider: 'local', model: `duckdb-${version.replace(/^v/u, '')}`, modelVersion: null, configuration: { kind: 'sql-query', query: body.sql, tables },
        tools: [], events: [{ at, type: 'sql-query', message: `${engine} ran the query on this computer. No model ran.` }], artifactIds: [] };
      this.store.createRun(run);
      const artifact = this.store.addArtifact({ projectId, nodeId: node.id, runId: run.id, kind: 'dataset', title, content: csv, mediaType: 'text/csv', capture: 'generated',
        metadata: { origin: 'sql', engine, query: body.sql, tables, rows: result.rows.length, columns: result.columns, contribution: 'user query' } });
      this.store.updateRun(run.id, { status: 'completed', endedAt: now(), artifactIds: [artifact.id] });
      this.store.mutate(projectId, [{ type: 'updateNode', id: node.id, patch: { artifactId: artifact.id } }], label);
      return { artifact, nodeId: node.id };
    });
  }

  /** Every Data block of the project, then the folder's data files that are not blocks, each with a table name. */
  private sources(projectId: string): Source[] {
    const project = this.store.getProject(projectId), taken = new Set<string>(), found: Source[] = [];
    for (const node of project.canvas.nodes) {
      if (node.blockType !== 'dataset' || !node.artifactId || found.length >= MAX_BLOCKS) continue;
      let artifact: Artifact;
      try { artifact = this.store.getArtifact(node.artifactId); } catch { continue; }
      if (artifact.projectId !== projectId || !['dataset', 'table'].includes(artifact.kind)) continue;
      found.push({ name: tableName(node.title, taken), title: node.title, source: 'block', format: 'csv', nodeId: node.id, columns: null, artifact });
    }
    const root = projectFolderRoot(this.store, projectId);
    if (!root) return found;
    const blocks = new Set((this.options.folders?.status(projectId).files ?? []).map(file => file.path.toLowerCase()));
    for (const file of dataFiles(root)) {
      if (blocks.has(file.path.toLowerCase())) continue;
      let info;
      try { info = statSync(file.absolute); } catch { continue; }
      const stem = file.path.split('/').pop()!.replace(/\.[^.]+$/u, '');
      found.push({ name: tableName(stem, taken, file.format), title: file.path, source: 'file', format: file.format, path: file.path, columns: null, absolute: file.absolute, bytes: info.size, modified: info.mtime.toISOString() });
    }
    return found;
  }
  private needsExcel(sql: string, sources: Source[]): boolean {
    return /read_xlsx/iu.test(sql) || sources.some(source => source.format === 'excel' && mentions(sql, source.name));
  }

  /** Opens a fresh in-memory DuckDB holding the sources, locks it down, runs `work` and closes it again. */
  private async withDatabase<T>(projectId: string, sources: Source[], excel: boolean, schemaOnly: boolean, work: (opened: Opened) => Promise<T>): Promise<T> {
    if (this.running >= MAX_RUNNING) throw new StoreError('Two queries are already running. Wait for one to finish.', 429);
    this.running++;
    let opened: Opened | undefined;
    try {
      opened = await this.open(sources, excel, schemaOnly, projectFolderRoot(this.store, projectId));
      return await work(opened);
    } finally {
      opened?.close();
      this.running--;
    }
  }
  /** With `schemaOnly`, a block's first rows stand in for it: enough for its columns, and quick for a project with many blocks. */
  private async open(sources: Source[], excel: boolean, schemaOnly: boolean, root: string | null): Promise<Opened> {
    let duckdb: typeof import('@duckdb/node-api');
    try { duckdb = await import('@duckdb/node-api'); }
    catch { throw new StoreError('DuckDB is not installed. Run npm ci in the ros-ai folder, then restart ros.ai.', 501); }
    // No spilling to disk; a query that needs more than 1 GB of memory stops with an error instead.
    const instance = await duckdb.DuckDBInstance.create(':memory:', { threads: String(Math.max(1, Math.floor(availableParallelism() / 2))), memory_limit: '1GB', temp_directory: '',
      autoinstall_known_extensions: 'false', autoload_known_extensions: 'false', ...(this.options.extensionDirectory ? { extension_directory: this.options.extensionDirectory } : {}) });
    const connection = await instance.connect(), staging = mkdtempSync(join(tmpdir(), 'ros-ai-sql-')), columns = new Map<string, string[]>();
    const close = () => { try { connection.closeSync(); } catch { /* already closed */ } try { instance.closeSync(); } catch { /* already closed */ } rmSync(staging, { recursive: true, force: true }); };
    try {
      const version = String((await connection.runAndReadAll('SELECT version()')).getRowsJson()[0][0]);
      // DuckDB's Excel reader is an extension it downloads once from duckdb.org, only when a query reads an Excel file.
      let excelReady = false, excelProblem = '';
      if (excel || sources.some(source => source.format === 'excel')) {
        try { if (excel) await connection.run('INSTALL excel'); await connection.run('LOAD excel'); excelReady = true; }
        catch (error) { excelProblem = message(error).split('\n')[0]; }
      }
      if (excel && !excelReady) throw new StoreError(`Reading Excel files needs DuckDB's Excel reader, which ros.ai downloads once from duckdb.org. It could not be downloaded: ${excelProblem}`, 502);
      for (const [index, source] of sources.entries()) {
        try {
          if (source.artifact) {
            // A block's saved version is copied in, so the query reads exactly what the canvas shows.
            const file = join(staging, `${index}.csv`), artifact = source.artifact;
            let csv = artifact.kind === 'dataset' || artifact.mediaType === 'text/csv' ? artifact.content : tableCsv(artifactTable(artifact.content, false));
            if (schemaOnly && csv.length > HEADER_BYTES) csv = csv.slice(0, csv.lastIndexOf('\n', HEADER_BYTES) + 1 || HEADER_BYTES);
            writeFileSync(file, csv, { mode: 0o600 });
            const read = (types: string) => `CREATE ${schemaOnly ? 'VIEW' : 'TABLE'} ${quoted(source.name)} AS FROM read_csv(${literal(file)}, header = true, delim = ',', quote = '"', escape = '"', sample_size = -1${types})`;
            try { await connection.run(read('')); } catch { await connection.run(read(', all_varchar = true')); }
          } else if (source.format !== 'excel' || excelReady) {
            const reader = source.format === 'parquet' ? 'read_parquet' : source.format === 'excel' ? 'read_xlsx' : 'read_csv';
            await connection.run(`CREATE VIEW ${quoted(source.name)} AS FROM ${reader}(${literal(source.absolute!)})`);
          } else continue;
          columns.set(source.name, (await connection.runAndReadAll(`DESCRIBE ${quoted(source.name)}`)).getRowsJson().map(row => String(row[0])));
        } catch { /* A file DuckDB cannot read stays out of the query; the others still work. */ }
      }
      rmSync(staging, { recursive: true, force: true });
      // Files in the project folder can also be read by their full path, for example a glob of many CSV files.
      await connection.run(`SET allowed_directories = [${root ? literal(root.endsWith(sep) ? root : `${root}${sep}`) : ''}]`);
      await connection.run('SET enable_external_access = false');
      await connection.run('SET lock_configuration = true');
      return { connection, version, columns, close };
    } catch (error) { close(); throw error; }
  }

  /** Checks the query is one SELECT without running anything, then reads up to `limit` rows of it. */
  private async read(connection: DuckDBConnection, sql: string, limit: number, sources: Source[]): Promise<SqlResult> {
    const parsed = JSON.parse(String((await connection.runAndReadAll('SELECT json_serialize_sql($1::VARCHAR)', [sql])).getRowsJson()[0][0])) as { error: boolean; error_type?: string; error_message?: string; statements?: unknown[] };
    if (parsed.error) throw new StoreError(parsed.error_type === 'parser' ? `DuckDB could not read this query: ${parsed.error_message}` : /\b(un)?pivot\b/iu.test(sql) ? PIVOT : ONE_SELECT);
    if (parsed.statements?.length !== 1) throw new StoreError(ONE_SELECT);
    const limitMs = this.options.queryMs ?? QUERY_MS, started = Date.now(), timer = setTimeout(() => connection.interrupt(), limitMs);
    try {
      const reader = await connection.runAndReadUntil(sql, limit + 1), rows = reader.getRowsJson();
      return { columns: reader.columnNames(), types: reader.columnTypes().map(type => type.toString()), rows: rows.slice(0, limit).map(row => row.map(cell)), truncated: rows.length > limit || !reader.done, ms: Date.now() - started };
    } catch (error) {
      const text = message(error);
      if (/interrupt/iu.test(text)) throw new StoreError(`The query ran for ${Math.round(limitMs / 1000)} seconds and was stopped. Narrow it, or add a LIMIT.`, 408);
      const excel = sources.find(source => source.format === 'excel' && mentions(sql, source.name));
      if (excel && /does not exist/iu.test(text)) throw new StoreError(`DuckDB could not read ${excel.path}. Check that it is an Excel workbook and not open in Excel with unsaved changes.`);
      throw new StoreError(text.slice(0, 1500));
    } finally { clearTimeout(timer); }
  }
}

export function attachSqlRoutes(app: Express, sql: SqlService) {
  app.get('/api/projects/:id/sql/tables', async (req, res) => res.json(await sql.tables(id.parse(req.params.id))));
  app.post('/api/projects/:id/sql/query', async (req, res) => res.json(await sql.query(id.parse(req.params.id), req.body)));
  app.post('/api/projects/:id/sql/save', async (req, res) => res.status(201).json(await sql.save(id.parse(req.params.id), req.body)));
}
