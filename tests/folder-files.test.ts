import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ProjectFolders } from '../src/server/project-folders.js';
import type { CanvasNode } from '../src/shared/types.js';

test('a block file that cannot become a block stays in its folder when the folder is opened', () => {
  const data = mkdtempSync(join(tmpdir(), 'ros-open-data-')), root = mkdtempSync(join(tmpdir(), 'ros-open-folder-'));
  // No notebook service here, so the notebook cannot become a block: the same end as a notebook file that will not parse.
  const store = new Store(data), folders = new ProjectFolders(store, { reserved: [data] });
  try {
    mkdirSync(join(root, '.ros-ai'));
    writeFileSync(join(root, 'Notes.md'), 'Kept.');
    writeFileSync(join(root, 'Analysis.ipynb'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n');
    writeFileSync(join(root, '.ros-ai', 'project.json'), JSON.stringify({ app: 'ros.ai', format: 1, projectId: 'from-another-computer', title: 'Shared', connections: [], blocks: [
      { id: 'notes', title: 'Notes', kind: 'topic', blockType: 'note', parentId: null, x: 0, y: 0, file: 'Notes.md' },
      { id: 'analysis', title: 'Analysis', kind: 'activity', blockType: 'notebook', parentId: null, x: 400, y: 0, file: 'Analysis.ipynb' },
    ] }));
    const project = folders.openFolder(root);
    assert.deepEqual(store.getProject(project.id).canvas.nodes.map(node => node.id), ['notes']);
    assert.ok(existsSync(join(root, 'Analysis.ipynb')), 'The notebook is still where the person left it');
    assert.equal(existsSync(join(root, '.ros-ai', 'trash')), false, 'Nothing was moved to the folder’s trash');
    assert.ok(folders.status(project.id).unplaced.some(file => file.path === 'Analysis.ipynb'), 'It is listed as a file that is not on the canvas');
  } finally { folders.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('two Code blocks with one title keep their outputs in separate folders', async () => {
  const data = mkdtempSync(join(tmpdir(), 'ros-outputs-data-')), root = mkdtempSync(join(tmpdir(), 'ros-outputs-folder-'));
  const store = new Store(data), folders = new ProjectFolders(store, { reserved: [data] });
  const settle = () => new Promise(resolve => setTimeout(resolve, 250));
  try {
    const project = store.createProject('Outputs');
    folders.attach(project.id, root);
    const code = (id: string, x: number): CanvasNode => ({ id, title: 'Analysis', description: '', kind: 'activity', blockType: 'code', parentId: null, x, y: 0, code: { language: 'python', source: `print("${id}")`, parameters: {}, inputArtifactId: null } });
    store.mutate(project.id, [{ type: 'addNode', node: code('first', 0) }, { type: 'addNode', node: code('second', 480) }], 'Two Code blocks');
    await settle();
    for (const id of ['first', 'second']) {
      const at = new Date().toISOString(), node = store.getProject(project.id).canvas.nodes.find(item => item.id === id)!;
      const run = { id: `run-${id}`, projectId: project.id, nodeId: id, request: 'Run', useSearch: false, status: 'running' as const, createdAt: at, startedAt: at, projectRevision: store.getProject(project.id).revision,
        node, inputs: [], messages: [], provider: 'local', model: 'python', modelVersion: null, configuration: { kind: 'local-experiment' }, tools: [], events: [], artifactIds: [] };
      store.createRun(run);
      const figure = store.addArtifact({ projectId: project.id, nodeId: id, runId: run.id, kind: 'plot', title: 'Figure 1', content: `<svg xmlns="http://www.w3.org/2000/svg"><title>${id}</title></svg>`, mediaType: 'image/svg+xml', capture: 'full-content', metadata: { executionRole: 'output' } });
      store.updateRun(run.id, { status: 'completed', endedAt: at, artifactIds: [figure.id] });
      store.mutate(project.id, [{ type: 'updateNode', id, patch: { artifactId: figure.id } }], 'Ran');
    }
    await settle();
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    assert.deepEqual(readdirSync(join(root, 'outputs')).sort(), ['Analysis', 'Analysis 2']);
    assert.match(read('outputs/Analysis/Figure 1.svg'), /<title>first</u);
    assert.match(read('outputs/Analysis 2/Figure 1.svg'), /<title>second</u);
  } finally { folders.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('two videos of one name sent at once each get their own file', async () => {
  const data = mkdtempSync(join(tmpdir(), 'ros-video-data-')), root = mkdtempSync(join(tmpdir(), 'ros-video-folder-'));
  const store = new Store(data), folders = new ProjectFolders(store, { reserved: [data] });
  try {
    const project = store.createProject('Videos');
    folders.attach(project.id, root);
    const [first, second] = await Promise.all([folders.saveVideo(project.id, 'clip.mp4', Readable.from([Buffer.from('first')])), folders.saveVideo(project.id, 'clip.mp4', Readable.from([Buffer.from('second')]))]);
    assert.notEqual(first.path, second.path);
    assert.equal(readFileSync(join(root, first.path), 'utf8'), 'first');
    assert.equal(readFileSync(join(root, second.path), 'utf8'), 'second');
  } finally { folders.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('a PDF whose text cannot be read says so, and keeps saying so while the file stays as it is', async () => {
  const data = mkdtempSync(join(tmpdir(), 'ros-pdf-data-')), root = mkdtempSync(join(tmpdir(), 'ros-pdf-folder-'));
  const store = new Store(data), folders = new ProjectFolders(store, { reserved: [data] });
  const settle = () => new Promise(resolve => setTimeout(resolve, 400));
  try {
    const project = store.createProject('Papers');
    folders.attach(project.id, root);
    const path = folders.saveFile(project.id, 'broken.pdf', Buffer.from('%PDF-1.7\nnot really a PDF')).path;
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'paper', title: 'Broken', description: '', kind: 'topic', blockType: 'file', parentId: null, x: 0, y: 0, file: { path } } }], 'Add a PDF');
    await settle();
    const problem = () => folders.status(project.id).problems.find(item => item.path === path)?.message;
    assert.match(problem() ?? '', /could not be read as a PDF/);
    // Another change makes the folder pass run again, with the file as it was.
    store.mutate(project.id, [{ type: 'updateNode', id: 'paper', patch: { title: 'Still broken' } }], 'Rename');
    await settle();
    assert.match(problem() ?? '', /could not be read as a PDF/);
  } finally { folders.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('a removed project stays removed when opening its folder is refused', () => {
  const data = mkdtempSync(join(tmpdir(), 'ros-reopen-data-')), root = mkdtempSync(join(tmpdir(), 'ros-reopen-folder-'));
  const store = new Store(data), folders = new ProjectFolders(store, { reserved: [data] });
  try {
    const removed = store.createProject('Removed'), other = store.createProject('Other');
    folders.attach(removed.id, join(root, 'Removed')); folders.attach(other.id, join(root, 'Other'));
    folders.release(removed.id); store.trashProject(removed.id);
    // The kept folder was moved inside another project's folder, where ros.ai will not open it.
    renameSync(join(root, 'Removed'), join(root, 'Other', 'Removed'));
    assert.throws(() => folders.openFolder(join(root, 'Other', 'Removed')), /overlaps the folder/);
    assert.deepEqual(store.listProjects().map(project => project.id), [other.id]);
    assert.deepEqual(store.listTrashedProjects().map(project => project.id), [removed.id]);
  } finally { folders.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
