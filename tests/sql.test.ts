import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { Store, StoreError } from '../src/server/store.js';
import { SqlService } from '../src/server/sql.js';
import type { ProjectFolders } from '../src/server/project-folders.js';
import type { SqlResult } from '../src/shared/sql.js';

/** A project with two Data blocks, an empty Data block, and a folder holding CSV, Parquet and Excel files. */
async function fixture(t: test.TestContext, options: { queryMs?: number; extensionDirectory?: (base: string) => string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ros-sql-'))), root = join(base, 'project'), store = new Store(join(base, 'data'));
  t.after(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  for (const folder of ['nested', '.hidden', 'node_modules']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'orders.csv'), 'id,region\n1,North\n2,South\n3,North\n');
  writeFileSync(join(root, 'mirrored.csv'), 'shown,as,a block\n');
  writeFileSync(join(root, '.hidden', 'secret.csv'), 'secret\n1\n');
  writeFileSync(join(root, 'node_modules', 'package.csv'), 'x\n1\n');
  writeFileSync(join(root, 'budget.xlsx'), 'not a workbook');
  writeFileSync(join(base, 'outside.csv'), 'outside\n1\n');
  symlinkSync(join(base, 'outside.csv'), join(root, 'linked.csv'));
  // A Parquet file written by DuckDB itself.
  const writer = await (await DuckDBInstance.create(':memory:')).connect();
  await writer.run(`COPY (SELECT range::INTEGER AS id, 'event ' || range AS name FROM range(1, 4)) TO '${join(root, 'nested', 'events.parquet')}' (FORMAT parquet)`);
  writer.closeSync();

  const project = store.createProject('SQL fixture'), folder = statSync(root);
  store.saveRecord('project-folder', project.id, project.id, { projectId: project.id, path: root, device: folder.dev, inode: folder.ino, attachedAt: new Date().toISOString(), files: {}, outputs: {} });
  const block = (id: string, title: string, csv?: string) => {
    store.mutate(project.id, [{ type: 'addNode', node: { id, title, description: '', kind: 'topic', blockType: 'dataset', x: 0, y: id === 'sales' ? 0 : 400 } }], `Add ${title}`);
    if (csv === undefined) return;
    const at = new Date().toISOString(), now = store.getProject(project.id);
    const run = store.createRun({ id: randomUUID(), projectId: project.id, nodeId: id, request: 'Fixture data', useSearch: false, status: 'running', createdAt: at, projectRevision: now.revision, node: now.canvas.nodes.find(node => node.id === id)!,
      inputs: [], messages: [], provider: 'local', model: 'saved-fixture', modelVersion: null, configuration: { fixture: true }, tools: [], events: [], artifactIds: [] });
    const artifact = store.addArtifact({ projectId: project.id, nodeId: id, runId: run.id, kind: 'dataset', title, content: csv, mediaType: 'text/csv', capture: 'full-content' });
    store.updateRun(run.id, { status: 'completed', endedAt: at, artifactIds: [artifact.id] });
    store.mutate(project.id, [{ type: 'updateNode', id, patch: { artifactId: artifact.id } }], `Save ${title}`);
    return artifact;
  };
  const sales = block('sales', 'Sales 2024', 'id,amount,note\n1,10.5,"first, with a comma"\n2,4,\n3,7.25,"said ""hi"""\n')!;
  block('select', 'Select', 'a\n1\n');
  block('empty', 'Regional totals');
  // mirrored.csv is already a Data block of the folder, so it is listed once, as that block.
  const folders = { status: () => ({ files: [{ path: 'mirrored.csv' }] }) } as unknown as Pick<ProjectFolders, 'status'>;
  const sql = new SqlService(store, { folders, extensionDirectory: options.extensionDirectory?.(base) ?? join(base, 'extensions'), ...(options.queryMs ? { queryMs: options.queryMs } : {}) });
  return { base, root, store, project, sales, sql };
}
async function refused(work: Promise<unknown>, pattern: RegExp, status = 400) {
  await assert.rejects(work, (error: unknown) => {
    assert(error instanceof StoreError, String(error));
    assert.match(error.message, pattern);
    assert.equal(error.status, status);
    return true;
  });
}

test('every Data block and the folder’s CSV, Parquet and Excel files are tables a query can join', async t => {
  const { sql, project } = await fixture(t);
  const { tables, folder } = await sql.tables(project.id);
  assert.equal(folder, true);
  assert.deepEqual(tables.map(table => [table.name, table.source, table.format, table.columns]), [
    ['sales_2024', 'block', 'csv', ['id', 'amount', 'note']],
    // A reserved word gets a suffix, so it never needs quotes.
    ['select_table', 'block', 'csv', ['a']],
    // Excel's columns are unknown until DuckDB's Excel reader is on this computer; listing never downloads it.
    ['budget', 'file', 'excel', null],
    ['events', 'file', 'parquet', ['id', 'name']],
    ['orders', 'file', 'csv', ['id', 'region']],
  ]);
  assert.equal(tables[0].nodeId, 'sales');
  assert.equal(tables[3].path, 'nested/events.parquet');

  const joined = await sql.query(project.id, { sql: 'SELECT o.region, sum(s.amount) AS total, count(*) AS orders FROM sales_2024 s JOIN orders o USING (id) GROUP BY o.region ORDER BY o.region' });
  assert.deepEqual(joined.columns, ['region', 'total', 'orders']);
  assert.deepEqual(joined.rows, [['North', '17.75', '2'], ['South', '4', '1']]);
  assert.equal(joined.truncated, false);
  // A block is read exactly as saved: quoted commas and quotes survive, and an empty cell is empty.
  assert.deepEqual((await sql.query(project.id, { sql: 'FROM sales_2024 ORDER BY id' })).rows.map(row => row[2]), ['first, with a comma', '', 'said "hi"']);
  assert.deepEqual((await sql.query(project.id, { sql: 'SELECT name FROM events WHERE id > 1 ORDER BY id' })).rows, [['event 2'], ['event 3']]);
  // Up to 1,000 rows come back; the result says when there are more.
  const many = await sql.query(project.id, { sql: 'SELECT * FROM range(5000)' });
  assert.equal(many.rows.length, 1000);
  assert.equal(many.truncated, true);
});

test('SQL only reads: one SELECT, and no file outside the project folder', async t => {
  const { sql, project, root, base } = await fixture(t);
  const one = /Run one SELECT query/u;
  for (const statement of [`COPY (SELECT 1) TO '${root}/copied.csv'`, `EXPORT DATABASE '${root}/exported'`, `ATTACH '${root}/attached.duckdb'`, 'INSTALL httpfs', 'SET threads = 1', 'CREATE TABLE made AS SELECT 1', 'SELECT 1; SELECT 2', 'EXPLAIN SELECT 1'])
    await refused(sql.query(project.id, { sql: statement }), one);
  for (const left of ['copied.csv', 'exported', 'attached.duckdb']) assert.equal(existsSync(join(root, left)), false, `${left} was written`);
  await refused(sql.query(project.id, { sql: 'PIVOT orders ON region USING count(*)' }), /PIVOT is not supported here/u);
  await refused(sql.query(project.id, { sql: 'SELEKT 1' }), /DuckDB could not read this query/u);
  await assert.rejects(sql.query(project.id, { sql: '   ' }), /Write a query first/u);
  // Files inside the folder can be read by path, even ones no table stands for; anything outside it, through .. or a link, cannot.
  assert.deepEqual((await sql.query(project.id, { sql: `SELECT count(*) FROM read_parquet('${root}/nested/*.parquet')` })).rows, [['3']]);
  assert.deepEqual((await sql.query(project.id, { sql: `SELECT secret FROM read_csv('${root}/.hidden/secret.csv')` })).rows, [['1']]);
  for (const path of [`${base}/outside.csv`, `${root}/../outside.csv`, `${root}/linked.csv`, `${root}/nested/../../outside.csv`])
    await refused(sql.query(project.id, { sql: `SELECT * FROM read_csv('${path}')` }), /Permission Error/u);
  await refused(sql.query(project.id, { sql: "SELECT getenv('HOME')" }), /getenv does not exist/u);
  await refused(sql.query(project.id, { sql: "SELECT * FROM read_csv('/etc/passwd')" }), /Permission Error/u);
});

test('a long query stops at the time limit', async t => {
  const { sql, project } = await fixture(t, { queryMs: 300 });
  const started = Date.now();
  await refused(sql.query(project.id, { sql: 'SELECT sum(hash(a.range + b.range)) FROM range(100000000) a, range(100000) b' }), /was stopped/u, 408);
  assert(Date.now() - started < 10_000, 'the query was not interrupted');
  // The service is free again afterwards.
  assert.deepEqual((await sql.query(project.id, { sql: 'SELECT 42 AS answer' })).rows, [['42']]);
});

test('a saved result is a new Data block beside its block, or fills an empty one, with the query as provenance', async t => {
  const { sql, store, project, sales, root } = await fixture(t);
  const query = 'SELECT o.region, sum(s.amount) AS total FROM sales_2024 s JOIN orders o USING (id) GROUP BY o.region ORDER BY o.region';
  const saved = await sql.save(project.id, { sql: query, nodeId: 'sales' });
  let now = store.getProject(project.id);
  const added = now.canvas.nodes.find(node => node.id === saved.nodeId)!, from = now.canvas.nodes.find(node => node.id === 'sales')!;
  assert.equal(added.title, 'Sales 2024 (SQL)');
  assert.equal(added.blockType, 'dataset');
  assert.equal(added.artifactId, saved.artifact.id);
  assert.equal(added.y, from.y);
  assert(added.x > from.x);
  assert.deepEqual(now.canvas.connections.filter(item => item.target === added.id).map(item => [item.source, item.label]), [['sales', 'SQL']]);
  assert.equal(saved.artifact.content, 'region,total\nNorth,17.75\nSouth,4\n');
  assert.equal(saved.artifact.mediaType, 'text/csv');
  assert.equal(saved.artifact.metadata?.origin, 'sql');
  assert.equal(saved.artifact.metadata?.query, query);
  assert.deepEqual(saved.artifact.metadata?.tables, [
    { name: 'sales_2024', nodeId: 'sales', artifactId: sales.id, hash: sales.hash },
    { name: 'orders', path: 'orders.csv', format: 'csv', bytes: statSync(join(root, 'orders.csv')).size, modified: statSync(join(root, 'orders.csv')).mtime.toISOString() },
  ]);
  const run = store.getRun(saved.artifact.runId);
  assert.equal(run.provider, 'local');
  assert.match(run.model, /^duckdb-1\.\d+\.\d+$/u);
  assert.equal(run.status, 'completed');
  assert.equal(run.configuration.kind, 'sql-query');
  assert.deepEqual(run.inputs.map(input => input.artifact.id), [sales.id]);
  assert.match(run.events[0].message, /DuckDB v1\.\d+\.\d+ ran the query on this computer\. No model ran\./u);

  // An empty Data block is filled instead; a query of folder files alone links no blocks.
  const filled = await sql.save(project.id, { sql: 'SELECT region, count(*) AS orders FROM orders GROUP BY region ORDER BY region', nodeId: 'empty' });
  now = store.getProject(project.id);
  assert.equal(filled.nodeId, 'empty');
  assert.equal(now.canvas.nodes.find(node => node.id === 'empty')!.artifactId, filled.artifact.id);
  assert.equal(filled.artifact.title, 'Regional totals');
  assert.equal(filled.artifact.content, 'region,orders\nNorth,2\nSouth,1\n');
  assert.equal(now.canvas.connections.filter(item => item.target === 'empty').length, 0);
  // A saved block is a table for the next query.
  assert.deepEqual((await sql.query(project.id, { sql: 'SELECT sum(orders) FROM regional_totals' })).rows, [['3']]);

  // A result larger than a Data block holds is refused, and nothing is added.
  const blocks = now.canvas.nodes.length;
  await refused(sql.save(project.id, { sql: 'SELECT * FROM range(200001)', nodeId: 'sales' }), /more than 200,000 rows/u);
  await refused(sql.save(project.id, { sql: 'SELECT 1', nodeId: 'gone' }), /removed from the canvas/u, 409);
  assert.equal(store.getProject(project.id).canvas.nodes.length, blocks);
});

test('an Excel file needs DuckDB’s Excel reader, and without a folder only Data blocks are tables', async t => {
  // An extension folder that cannot be made stands in for a computer offline, so the test never downloads.
  const { sql, store, project } = await fixture(t, { extensionDirectory: base => { const file = join(base, 'not-a-folder'); writeFileSync(file, ''); return file; } });
  await refused(sql.query(project.id, { sql: 'SELECT * FROM budget' }), /Reading Excel files needs DuckDB's Excel reader, which ros\.ai downloads once from duckdb\.org\. It could not be downloaded: IO Error/u, 502);
  // Queries that do not read Excel work as before.
  const result: SqlResult = await sql.query(project.id, { sql: 'SELECT count(*) AS n FROM orders' });
  assert.deepEqual(result.rows, [['3']]);
  store.removeRecord('project-folder', project.id, project.id);
  const { tables, folder } = await sql.tables(project.id);
  assert.equal(folder, false);
  assert.deepEqual(tables.map(table => table.name), ['sales_2024', 'select_table']);
  await refused(sql.query(project.id, { sql: 'SELECT * FROM orders' }), /orders does not exist/u);
});
