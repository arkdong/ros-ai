import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { RemoteApps } from '../src/server/remote-apps.js';
import { GOOGLE_DRIVE_SCOPE, GoogleDriveConnection } from '../src/server/google-drive.js';
import { attachGoogleRoutes, docText, GoogleDriveApp, googleLink, GoogleWorkspace } from '../src/server/google-workspace.js';
import { ProjectCache } from '../src/server/project-cache.js';
import { ProjectFolders } from '../src/server/project-folders.js';
import { apiErrorHandler } from '../src/server/app.js';
import { outputFreshness } from '../src/shared/output-provenance.js';
import type { GoogleDoc, GoogleSheet } from '../src/shared/types.js';

// A stand-in for Google's Drive and Sheets APIs, reached through a Google Drive sign-in saved as ros.ai saves it.

const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', DOC = '1aZbYcXdWeVfUgThSiRjQkPlOmNnMoLpKqJrIsHtGuFv';
const CLIENT = 'ros-test.apps.googleusercontent.com';
type Tab = { id: number; title: string; shown: string[][]; raw?: unknown[][] };
const files: Record<string, { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink: string }> = {
  [SHEET]: { id: SHEET, name: 'Field budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-20T10:00:00.000Z', webViewLink: `https://docs.google.com/spreadsheets/d/${SHEET}/edit` },
  [DOC]: { id: DOC, name: 'Interview notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-21T09:00:00.000Z', webViewLink: `https://docs.google.com/document/d/${DOC}/edit` },
};
const budget: Tab = { id: 0, title: 'Budget', shown: [['Item', 'Cost', ''], ['Flights', '€1,200.00'], ['Hotel', '€640.50', 'booked, paid']], raw: [['Item', 'Cost', ''], ['Flights', 1200], ['Hotel', 640.5, 'booked, paid']] };
const plan: Tab = { id: 815, title: 'Team\'s plan', shown: [['Week', 'Who'], ...Array.from({ length: 250 }, (_, index) => [`W${index + 1}`, index % 2 ? 'Ada' : 'Lin'])] };
const DOC_MARKDOWN = '# Interview notes\n\nThe team met **twice**.\n\n![Chart of answers](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA)\n\n![][image1]\n\n\n\n- Ada: yes\n\n[image1]: <data:image/png;base64,AAAAAAAAAAAAAAAA>';

/** Columns as A1 letters name them. */
const column = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** Google leaves out the empty cells that end a row. */
const trimmed = (rows: unknown[][]) => rows.map(row => { const copy = [...row]; while (copy.length && (copy.at(-1) === '' || copy.at(-1) === undefined)) copy.pop(); return copy; });
function google(options: { sheetsOff?: boolean; markdown?: boolean } = {}) {
  const requests: { url: URL; method: string; auth: string }[] = [], tabs = [budget, plan];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const range = (tab: Tab, a1: string, raw: boolean) => {
    const [, c1 = '', r1 = '', c2 = '', r2 = ''] = /^([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/u.exec(a1) ?? [];
    const rows = (raw && tab.raw ? tab.raw : tab.shown).slice(r1 ? Number(r1) - 1 : 0, r2 ? Number(r2) : undefined);
    return trimmed(rows.map(row => row.slice(c1 ? column(c1) : 0, c2 ? column(c2) + 1 : undefined)));
  };
  const tabOf = (text: string) => { const [, title, a1] = /^'((?:[^']|'')+)'!(.+)$/u.exec(text)!; return { tab: tabs.find(item => item.title === title.replaceAll('\'\'', '\''))!, a1 }; };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), auth = new Headers(init?.headers).get('authorization') ?? '';
    requests.push({ url, method: init?.method ?? 'GET', auth });
    if (url.hostname === 'sheets.googleapis.com') {
      if (options.sheetsOff) return json({ error: { code: 403, message: 'Google Sheets API has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }, 403);
      const path = url.pathname.replace('/v4/spreadsheets/', '');
      if (path === SHEET) return json({ sheets: [...tabs.map(tab => ({ properties: { sheetId: tab.id, title: tab.title, sheetType: 'GRID', gridProperties: { rowCount: tab.shown.length, columnCount: 26 } } })), { properties: { sheetId: 9, title: 'Chart', sheetType: 'OBJECT' } }] });
      if (path === `${SHEET}/values:batchGet`) return json({ valueRanges: url.searchParams.getAll('ranges').map(text => { const { tab, a1 } = tabOf(text); return { values: range(tab, a1, false) }; }) });
      const { tab, a1 } = tabOf(decodeURIComponent(path.slice(`${SHEET}/values/`.length)));
      return json({ majorDimension: 'ROWS', values: range(tab, a1, url.searchParams.get('valueRenderOption') === 'UNFORMATTED_VALUE') });
    }
    const path = url.pathname.replace('/drive/v3/', '');
    if (path === 'files') return json({ files: [...Object.values(files), { id: '1CsvCsvCsvCsvCsvCsvCsv', name: 'raw.csv', mimeType: 'text/csv' }] });
    if (path === `files/${SHEET}/export`) return new Response(`${budget.shown.map(row => row.map(cell => /[",]/u.test(cell) ? `"${cell}"` : cell).join(',')).join('\n')}\n`);
    if (path === `files/${DOC}/export`) return url.searchParams.get('mimeType') === 'text/markdown' && options.markdown === false
      ? json({ error: { code: 400, message: 'Export only supports these formats', errors: [{ reason: 'badRequest' }] } }, 400)
      : new Response(url.searchParams.get('mimeType') === 'text/markdown' ? DOC_MARKDOWN : 'Interview notes\n\nThe team met twice.');
    const file = files[path.replace('files/', '')];
    return file ? json(file) : json({ error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } }, 404);
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

/** ros.ai with a Google Drive sign-in already saved (as an owner-only file), and a project with a folder for the cache. */
function fixture(options: { connected?: boolean; sheetsOff?: boolean; markdown?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-google-')), api = google(options);
  if (options.connected !== false) {
    mkdirSync(join(dir, 'connections'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'connections', 'google-drive.json'), JSON.stringify({ clientId: CLIENT, accessToken: 'ya29.test-access', refreshToken: 'refresh-test', expiresAt: Date.now() + 3_600_000, scope: GOOGLE_DRIVE_SCOPE, connectedAt: new Date().toISOString() }), { mode: 0o600 });
  }
  const store = new Store(join(dir, 'store')), cache = new ProjectCache(store);
  const drive = new GoogleDriveConnection({ dataDir: dir, clientId: CLIENT, clientSecret: 'secret', fetch: api.fetch });
  const workspace = new GoogleWorkspace(drive, cache), apps = new RemoteApps(dir, { builtIn: { 'google-drive': new GoogleDriveApp(workspace) } });
  return { dir, store, cache, drive, workspace, apps, ...api, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
/** Agent tools whose proposals wait for the person, as in the default permission mode. */
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-google', 'model', 'Test model');
const sheetNode = (id: string, sheet?: string) => ({ id, title: 'Field budget', description: '', x: 0, y: 0, blockType: 'google' as const, google: { fileId: SHEET, kind: 'sheet' as const, ...(sheet ? { sheet } : {}) } });

test('Google links and bare file IDs name the file, its kind and the tab a sheet link points at', () => {
  assert.deepEqual(googleLink(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=815`), { fileId: SHEET, kind: 'sheet', gid: 815 });
  assert.deepEqual(googleLink(`https://docs.google.com/spreadsheets/d/${SHEET}/edit?gid=0#gid=0`), { fileId: SHEET, kind: 'sheet', gid: 0 });
  assert.deepEqual(googleLink(`https://docs.google.com/a/lab.example/document/d/${DOC}/edit?usp=sharing`), { fileId: DOC, kind: 'doc' });
  assert.deepEqual(googleLink(`https://drive.google.com/file/d/${DOC}/view`), { fileId: DOC });
  assert.deepEqual(googleLink(`https://drive.google.com/open?id=${DOC}`), { fileId: DOC });
  assert.deepEqual(googleLink(` ${SHEET} `), { fileId: SHEET });
  for (const wrong of [`http://docs.google.com/spreadsheets/d/${SHEET}/edit`, `https://docs.google.com.evil.example/spreadsheets/d/${SHEET}`, 'https://docs.google.com/spreadsheets/d/short/edit', 'not a link', `https://docs.google.com/spreadsheets/d/${SHEET.slice(0, 8)}!x/edit`]) assert.equal(googleLink(wrong), null, wrong);
  // Images Google embeds as data become marks, so a doc's text stays small.
  assert.equal(docText(DOC_MARKDOWN), '# Interview notes\n\nThe team met **twice**.\n\n*(image: Chart of answers)*\n\n*(image)*\n\n- Ada: yes');
});

test('A Sheet block shows a tab’s first rows under its first row’s names, reads only with the sign-in, and is cached in the project folder', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject('Budget'), folders = new ProjectFolders(f.store, { reserved: [join(f.dir, 'store')] });
    folders.attach(project.id, join(f.dir, 'Budget folder'));
    folders.shutdown();
    // The link's gid picks the tab; the read is checked before the block exists.
    const { view, read } = await f.workspace.preview(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=815`) as { view: object; read: GoogleSheet };
    assert.deepEqual(view, { fileId: SHEET, kind: 'sheet', sheet: 'Team\'s plan' });
    assert.equal(read.title, 'Field budget');
    assert.deepEqual(read.sheets, ['Budget', 'Team\'s plan']);
    assert.deepEqual(read.columns, ['Week', 'Who']);
    assert.equal(read.rows.length, 200);
    assert.equal(read.truncated, true);
    assert.deepEqual(read.rows[0], ['W1', 'Lin']);
    // The first tab: an unnamed column is called by its letter, and short rows are filled in.
    const first = await f.workspace.read({ fileId: SHEET, kind: 'sheet' }, true, project.id) as GoogleSheet;
    assert.deepEqual(first.columns, ['Item', 'Cost', 'C']);
    assert.deepEqual(first.rows, [['Flights', '€1,200.00', ''], ['Hotel', '€640.50', 'booked, paid']]);
    assert.equal(first.truncated, false);
    assert.equal(first.link, `https://docs.google.com/spreadsheets/d/${SHEET}/edit`);
    // Every request is a GET to Google's APIs with the saved access token.
    assert(f.requests.length > 0);
    for (const request of f.requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.auth, 'Bearer ya29.test-access');
      assert(['www.googleapis.com', 'sheets.googleapis.com'].includes(request.url.hostname), request.url.href);
    }

    // Within a minute the read is reused; asked again, an unchanged file is not read again.
    const count = f.requests.length;
    await f.workspace.read({ fileId: SHEET, kind: 'sheet' }, false, project.id);
    assert.equal(f.requests.length, count);
    await f.workspace.read({ fileId: SHEET, kind: 'sheet' }, true, project.id);
    assert.deepEqual(f.requests.slice(count).map(request => request.url.pathname), [`/drive/v3/files/${SHEET}`]);
    // After a restart the project folder's cache still has it, even while Google cannot be reached.
    const offline = new GoogleWorkspace(new GoogleDriveConnection({ dataDir: f.dir, clientId: CLIENT, clientSecret: 'secret', fetch: (async () => { throw new Error('offline'); }) as typeof fetch }), f.cache);
    const kept = await offline.read({ fileId: SHEET, kind: 'sheet' }, true, project.id) as GoogleSheet;
    assert.deepEqual(kept.rows, first.rows);
    assert.match(kept.notice!, /^Google did not answer a new read \(Google could not be reached/u);
    // A tab that was renamed falls back to the first, and says so.
    const gone = await f.workspace.read({ fileId: SHEET, kind: 'sheet', sheet: 'Old tab' }, true) as GoogleSheet;
    assert.equal(gone.sheet, 'Budget');
    assert.equal(gone.notice, 'The tab “Old tab” is gone; showing “Budget”.');
    // A doc's ID is not a sheet.
    await assert.rejects(f.workspace.read({ fileId: DOC, kind: 'sheet' }, true), /Interview notes is no longer a Google Sheet/u);
  } finally { f.close(); }
});

test('Without the Sheets API, a Sheet block shows the first tab through Drive’s CSV export and says how to choose others', async () => {
  const f = fixture({ sheetsOff: true });
  try {
    const read = await f.workspace.read({ fileId: SHEET, kind: 'sheet', sheet: 'Team\'s plan' }, true) as GoogleSheet;
    assert.deepEqual(read.columns, ['Item', 'Cost', 'C']);
    assert.deepEqual(read.rows[1], ['Hotel', '€640.50', 'booked, paid']);
    assert.deepEqual(read.sheets, []);
    assert.match(read.notice!, /Turn on the Google Sheets API/u);
    const agent = JSON.parse((await new GoogleDriveApp(f.workspace).call('read_sheet', { file: SHEET })).text) as { sheet: string; note: string };
    assert.equal(agent.sheet, 'first tab');
    assert.match(agent.note, /Google Sheets API is off/u);
  } finally { f.close(); }
});

test('A Doc block shows the doc’s text as Markdown without its images, or as plain text where Google exports no Markdown', async () => {
  const f = fixture();
  try {
    const read = await f.workspace.read({ fileId: DOC, kind: 'doc' }, true) as GoogleDoc;
    assert.equal(read.content, docText(DOC_MARKDOWN));
    assert.equal(read.modifiedAt, '2026-10-21T09:00:00.000Z');
    assert.equal(f.requests.find(request => request.url.pathname.endsWith('/export'))!.url.searchParams.get('mimeType'), 'text/markdown');
  } finally { f.close(); }
  const plain = fixture({ markdown: false });
  try {
    const read = await plain.workspace.read({ fileId: DOC, kind: 'doc' }, true) as GoogleDoc;
    assert.equal(read.content, 'Interview notes\n\nThe team met twice.');
  } finally { plain.close(); }
});

test('Copying a Sheet block’s tab makes a Data block beside it with every row, numbers unformatted, and where it came from', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject('Copy');
    f.store.mutate(project.id, [{ type: 'addNode', node: sheetNode('sheet-block') }], 'Add Google Sheet');
    const { nodeId, artifact } = await f.workspace.copy(f.store, project.id, 'sheet-block');
    assert.equal(artifact.content, 'Item,Cost,C\nFlights,1200,\nHotel,640.5,"booked, paid"\n');
    assert.equal(artifact.kind, 'dataset');
    assert.equal(artifact.metadata?.origin, 'google-sheets');
    assert.equal(artifact.url, `https://docs.google.com/spreadsheets/d/${SHEET}/edit`);
    const detail = f.store.detail(project.id), node = detail.project.canvas.nodes.find(item => item.id === nodeId)!;
    assert.equal(node.blockType, 'dataset');
    assert.equal(node.artifactId, artifact.id);
    assert.equal(node.title, 'Field budget › Budget (copy)');
    assert(detail.project.canvas.connections.some(item => item.source === 'sheet-block' && item.target === nodeId && item.label === 'copy'));
    const run = detail.runs.find(item => item.id === artifact.runId)!;
    assert.equal(run.status, 'completed');
    assert.match(run.events[0].message, /^Copied from Google Sheets: Field budget › Budget, as last edited 2026-10-20T10:00:00\.000Z\. No model ran\.$/u);
    assert.equal(outputFreshness(artifact, detail).state, 'unverifiable');
    // Only a Sheet block can be copied; Google Drive is not changed by any of this.
    f.store.mutate(project.id, [{ type: 'addNode', node: { id: 'doc-block', title: 'Notes', description: '', x: 0, y: 400, blockType: 'google', google: { fileId: DOC, kind: 'doc' } } }], 'Add Google Doc');
    await assert.rejects(f.workspace.copy(f.store, project.id, 'doc-block'), /Only a Google Sheet block can be copied/u);
    assert(f.requests.every(request => request.method === 'GET'));
  } finally { f.close(); }
});

test('With Google Drive connected every agent can find and read Sheets and Docs, and propose live Google blocks; without it the tools are as before', async () => {
  const off = fixture({ connected: false });
  try {
    const project = off.store.createProject('Off');
    AgentWorkspaceTools.apps = off.apps; AgentWorkspaceTools.google = off.workspace;
    const agent = toolkit(off.store, project.id);
    assert(!agent.definitions.some(item => item.name.startsWith('ros_app_')));
    assert(!JSON.stringify(agent.definitions.find(item => item.name === 'ros_propose_canvas')!.inputSchema).includes('"google"'));
    await assert.rejects(agent.call('ros_propose_canvas', { summary: 'Show the budget', rationale: 'The person asked.', operations: [{ type: 'addNode', node: sheetNode('b1') }] }), /Google Drive is not connected/u);
  } finally { AgentWorkspaceTools.apps = undefined; AgentWorkspaceTools.google = undefined; off.close(); }

  const f = fixture();
  try {
    const project = f.store.createProject('On');
    AgentWorkspaceTools.apps = f.apps; AgentWorkspaceTools.google = f.workspace;
    const agent = toolkit(f.store, project.id);
    assert.match(agent.definitions.find(item => item.name === 'ros_app_tools')!.description, /google-drive \(Google Drive\)/u);
    assert.match(agent.definitions.find(item => item.name === 'ros_app_call')!.description, /blockType "google" and google \{fileId from search_files/u);
    assert(JSON.stringify(agent.definitions.find(item => item.name === 'ros_propose_canvas')!.inputSchema).includes('"google"'));
    const listing = await agent.call('ros_app_tools', { app: 'google-drive' }) as { tools: { name: string }[] };
    assert.deepEqual(listing.tools.map(tool => tool.name), ['search_files', 'read_doc', 'read_sheet']);

    // Reads run straight away: a search lists only Sheets and Docs, and a text search keeps Google's order.
    const found = await agent.call('ros_app_call', { app: 'google-drive', tool: 'search_files', arguments: { query: 'budget' }, summary: 'Find the budget', rationale: 'The question is about costs.' }) as { text: string };
    assert.deepEqual((JSON.parse(found.text) as { files: { id: string; kind: string }[] }).files.map(file => [file.id, file.kind]), [[SHEET, 'sheet'], [DOC, 'doc']]);
    const search = f.requests.find(request => request.url.pathname === '/drive/v3/files')!.url;
    assert.match(search.searchParams.get('q')!, /fullText contains 'budget'/u);
    assert.equal(search.searchParams.get('orderBy'), null);
    const rows = await agent.call('ros_app_call', { app: 'google-drive', tool: 'read_sheet', arguments: { file: SHEET, sheet: 'team\'s plan', offset: 198, limit: 5 }, summary: 'Read the plan', rationale: 'It lists who does what.' }) as { text: string };
    const page = JSON.parse(rows.text) as { sheet: string; columns: string[]; rows: string[][]; more: boolean; tabs: { title: string }[] };
    assert.equal(page.sheet, 'Team\'s plan');
    assert.deepEqual(page.columns, ['Week', 'Who']);
    assert.deepEqual(page.rows, [['W199', 'Lin'], ['W200', 'Ada'], ['W201', 'Lin'], ['W202', 'Ada'], ['W203', 'Lin']]);
    assert.equal(page.more, true);
    const cells = JSON.parse((await agent.call('ros_app_call', { app: 'google-drive', tool: 'read_sheet', arguments: { file: `https://docs.google.com/spreadsheets/d/${SHEET}/edit`, range: 'B2:C3' }, summary: 'Read the costs', rationale: 'Only the costs matter.' }) as { text: string }).text) as { rows: string[][] };
    assert.deepEqual(cells.rows, [['€1,200.00'], ['€640.50', 'booked, paid']]);
    const doc = JSON.parse((await agent.call('ros_app_call', { app: 'google-drive', tool: 'read_doc', arguments: { file: DOC, length: 20 }, summary: 'Read the notes', rationale: 'They hold the answers.' }) as { text: string }).text) as { text: string; more: boolean };
    assert.deepEqual([doc.text, doc.more], ['# Interview notes\n\nT', true]);
    const wrong = await agent.call('ros_app_call', { app: 'google-drive', tool: 'read_doc', arguments: { file: SHEET }, summary: 'Read it', rationale: 'Because.' }) as { text: string; isError?: boolean };
    assert.match(wrong.text, /Field budget is not a Google Doc/u);

    // A proposed Google block reads live once accepted, and reading the canvas shows its rows.
    const proposed = await agent.call('ros_propose_canvas', { summary: 'Show the budget', rationale: 'The person asked to see it.', operations: [{ type: 'addNode', node: sheetNode('b1') }] }) as { action: { proposalId?: string } };
    if (proposed.action.proposalId) f.store.acceptProposal(project.id, proposed.action.proposalId);
    assert.deepEqual(f.store.getProject(project.id).canvas.nodes.find(node => node.id === 'b1')!.google, { fileId: SHEET, kind: 'sheet' });
    const read = await agent.call('ros_read_canvas', { nodeIds: ['b1'] }) as { blocks: { sheet: { columns: string[]; rows: string[][]; tab: string } }[] };
    assert.deepEqual(read.blocks[0].sheet.columns, ['Item', 'Cost', 'C']);
    assert.equal(read.blocks[0].sheet.tab, 'Budget');
    // A Google block must say which file it shows.
    await assert.rejects(toolkit(f.store, project.id).call('ros_propose_canvas', { summary: 'Show something', rationale: 'Because.', operations: [{ type: 'addNode', node: { id: 'b2', title: 'Sheet', description: '', x: 0, y: 0, blockType: 'google' } }] }), /needs blockType "google" and google \{fileId, kind\}/u);
  } finally { AgentWorkspaceTools.apps = undefined; AgentWorkspaceTools.google = undefined; f.close(); }
});

test('The block routes read a block’s file, check a pasted link, and copy a tab, refusing links that are not Google Sheets or Docs', async () => {
  const f = fixture();
  const app = express();
  app.use(express.json());
  attachGoogleRoutes(app, f.store, f.workspace);
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, body?: unknown) => { const response = await fetch(`${base}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
  try {
    const project = f.store.createProject('Routes');
    f.store.mutate(project.id, [{ type: 'addNode', node: sheetNode('sheet-block', 'Budget') }, { type: 'addNode', node: { id: 'text', title: 'Text', description: '', x: 0, y: 300 } }], 'Add blocks');
    const read = await call(`/api/projects/${project.id}/nodes/sheet-block/google`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.columns, ['Item', 'Cost', 'C']);
    assert.equal((await call(`/api/projects/${project.id}/nodes/text/google`)).status, 404);
    const preview = await call('/api/google/views/preview', { url: `https://docs.google.com/document/d/${DOC}/edit` });
    assert.deepEqual(preview.body.view, { fileId: DOC, kind: 'doc' });
    const refused = await call('/api/google/views/preview', { url: 'https://example.com/spreadsheets/d/whatever' });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /Paste the link of a Google Sheet or Doc/u);
    const copied = await call(`/api/projects/${project.id}/nodes/sheet-block/google/copy`, {});
    assert.equal(copied.status, 201);
    assert(f.store.getProject(project.id).canvas.nodes.some(node => node.id === copied.body.nodeId && node.blockType === 'dataset'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});
