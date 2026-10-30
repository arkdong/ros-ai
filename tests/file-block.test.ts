import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, apiErrorHandler } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { ProjectFolders } from '../src/server/project-folders.js';
import type { ProjectFolderStatus } from '../src/shared/project-folders.js';
import type { ProjectDetail } from '../src/shared/types.js';

/** A one-page PDF with a text layer, written by hand so the test needs no PDF library. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => { const at = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'ros-file-data-')), folder = join(mkdtempSync(join(tmpdir(), 'ros-file-folder-')), 'Paper project');
  const store = new Store(data);
  const unavailable = (): never => { throw new Error('Provider credentials unavailable in this test.'); };
  const app = createApp(store, { chat: async () => unavailable(), startRun: unavailable, cancelRun: unavailable, retryRun: unavailable, connectionStatuses: () => [] }, undefined, undefined, undefined, { projectFolders: { reserved: [data] }, notebooks: { owner: 'file-block-test' } });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => { const response = await fetch(`${base}${path}`, init); const value = await response.json(); if (!response.ok) throw new Error(`${response.status} ${value.error}`); return value as T; };
  const post = <T>(path: string, body: unknown) => json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const until = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, what: string): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt++) { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out waiting for ${what}.`);
  };
  return { store, base, folder, json, post, until, folders: app.locals.projectFolders as ProjectFolders,
    async close() { (app.locals.projectFolders as ProjectFolders).shutdown(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); rmSync(data, { recursive: true, force: true }); rmSync(join(folder, '..'), { recursive: true, force: true }); } };
}

test('A PDF or image in the project folder becomes a File block that the server serves and whose text agents can read', async () => {
  const f = await fixture();
  try {
    const project = await f.post<{ id: string; revision: number }>('/api/projects', { title: 'File blocks' });
    mkdirSync(f.folder, { recursive: true });
    writeFileSync(join(f.folder, 'paper.pdf'), pdf('Hello file block'));
    mkdirSync(join(f.folder, 'figures'), { recursive: true });
    writeFileSync(join(f.folder, 'figures', 'plot.png'), png);
    await f.post(`/api/projects/${project.id}/folder`, { path: f.folder });
    // The folder lists both as files that can be added, with their kinds.
    const status = await f.until(() => f.json<ProjectFolderStatus>(`/api/projects/${project.id}/folder`), value => value.unplaced.length === 2, 'the folder listing');
    assert.deepEqual(status.unplaced.map(file => [file.path, file.kind]).sort(), [['figures/plot.png', 'image'], ['paper.pdf', 'pdf']]);

    // Adding the PDF makes a File block; its text is read into a saved version with the page count.
    const { nodeId } = await f.post<{ nodeId: string }>(`/api/projects/${project.id}/folder/add`, { path: 'paper.pdf' });
    const detail = await f.until(() => f.json<ProjectDetail>(`/api/projects/${project.id}`), value => value.artifacts.some(artifact => artifact.nodeId === nodeId && artifact.kind === 'source'), 'the PDF text');
    const node = detail.project.canvas.nodes.find(item => item.id === nodeId)!;
    assert.equal(node.blockType, 'file'); assert.deepEqual(node.file, { path: 'paper.pdf' }); assert.equal(node.title, 'paper');
    const text = detail.artifacts.find(artifact => artifact.id === node.artifactId)!;
    assert.equal(text.title, 'Text of paper.pdf'); assert.match(text.content, /Hello file block/u); assert.equal(text.metadata?.pages, 1);
    // The file itself is served from the folder with its type and size; the listing now shows its size and version.
    const served = await fetch(`${f.base}/api/projects/${project.id}/nodes/${nodeId}/file`);
    assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await served.arrayBuffer()).length, pdf('Hello file block').length);
    const listed = await f.until(() => f.json<ProjectFolderStatus>(`/api/projects/${project.id}/folder`), value => value.files.some(file => file.nodeId === nodeId && file.version), 'the file version');
    const entry = listed.files.find(file => file.nodeId === nodeId)!;
    assert.equal(entry.kind, 'file'); assert.equal(entry.bytes, pdf('Hello file block').length); assert.equal(entry.image, undefined, 'a PDF has no pixel size');
    assert.equal(listed.unplaced.length, 1);

    // A dropped image is saved into files/ and shown by a block an edit adds with just its path, as an agent's proposal would.
    const saved = await f.json<{ path: string }>(`/api/projects/${project.id}/folder/files?name=${encodeURIComponent('My plot.png')}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    assert.equal(saved.path, 'files/My plot.png');
    const current = await f.json<ProjectDetail>(`/api/projects/${project.id}`);
    await f.post(`/api/projects/${project.id}/mutations`, { label: 'Add a dropped image', expectedRevision: current.project.revision, operations: [{ type: 'addNode', node: { id: 'dropped', title: 'My plot', description: '', x: 0, y: 480, kind: 'topic', blockType: 'file', file: { path: saved.path } } }] });
    const adopted = await f.until(() => f.json<ProjectFolderStatus>(`/api/projects/${project.id}/folder`), value => value.files.some(file => file.nodeId === 'dropped' && file.bytes), 'the dropped image to be recorded');
    assert.equal(adopted.files.find(file => file.nodeId === 'dropped')!.path, 'files/My plot.png');
    // The listing carries the picture's pixel size, so its card has the picture's shape before the picture loads.
    assert.deepEqual(adopted.files.find(file => file.nodeId === 'dropped')!.image, { width: 1, height: 1 });
    const image = await fetch(`${f.base}/api/projects/${project.id}/nodes/dropped/file`);
    assert.equal(image.headers.get('content-type'), 'image/png'); assert.equal(Buffer.from(await image.arrayBuffer()).length, png.length);
    // Agents may only show files that are in the folder and not on the canvas yet.
    assert.throws(() => f.folders.placeable(project.id, 'paper.pdf'), /already a block/u);
    assert.throws(() => f.folders.placeable(project.id, 'missing.pdf'), /not in the project folder/u);
    assert.throws(() => f.folders.placeable(project.id, 'notes/readme.md'), /not a PDF/u);
    assert.doesNotThrow(() => f.folders.placeable(project.id, 'figures/plot.png'));

    // A path that leaves the folder is refused, and the block's file is never written by ros.ai.
    const latest = await f.json<ProjectDetail>(`/api/projects/${project.id}`);
    await f.post(`/api/projects/${project.id}/mutations`, { label: 'Bad path', expectedRevision: latest.project.revision, operations: [{ type: 'addNode', node: { id: 'escape', title: 'Escape', description: '', x: 0, y: 960, kind: 'topic', blockType: 'file', file: { path: '../outside.pdf' } } }] });
    assert.notEqual((await fetch(`${f.base}/api/projects/${project.id}/nodes/escape/file`)).status, 200);
    await f.until(() => f.json<ProjectFolderStatus>(`/api/projects/${project.id}/folder`), value => value.problems.some(problem => problem.path === '../outside.pdf'), 'the bad path to be reported');
    assert.equal(Buffer.compare(pdf('Hello file block'), (await import('node:fs')).readFileSync(join(f.folder, 'paper.pdf'))), 0);
  } finally { await f.close(); }
});
