import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ProjectFolders } from '../src/server/project-folders.js';
import { pasteBlocks } from '../src/server/block-paste.js';
import type { CanvasNode } from '../src/shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'ros-paste-data-')), root = mkdtempSync(join(tmpdir(), 'ros-paste-folders-'));
  const store = new Store(data), folders = new ProjectFolders(store, { reserved: [data] });
  const from = store.createProject('From'), to = store.createProject('To');
  folders.attach(from.id, join(root, 'From')); folders.attach(to.id, join(root, 'To'));
  const path = folders.saveFile(from.id, 'chart.png', png).path;
  const block: CanvasNode = { id: 'chart', title: 'Chart', description: '', kind: 'topic', blockType: 'file', parentId: null, x: 0, y: 0, file: { path } };
  store.mutate(from.id, [{ type: 'addNode', node: block }], 'Add a file');
  const paste = (expectedRevision: number) => pasteBlocks({ store, folders }, to.id, {
    operations: [{ type: 'addNode', node: { ...block, id: 'copy', x: 480 } }], label: 'Paste 1 block', expectedRevision, from: from.id, sources: { copy: 'chart' }, artifacts: {},
  });
  const filesIn = (name: string) => { try { return readdirSync(join(root, name, 'files')).sort(); } catch { return []; } };
  return { store, folders, from, to, path, paste, filesIn, close() { folders.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}

test('a paste refused because the canvas moved on copies no file, however often it is tried', () => {
  const f = fixture();
  try {
    const stale = f.store.getProject(f.to.id).revision;
    f.store.mutate(f.to.id, [{ type: 'addNode', node: { id: 'other', title: 'Other', description: '', kind: 'topic', parentId: null, x: 0, y: 0 } }], 'Another window adds a block');
    for (let attempt = 0; attempt < 3; attempt++) assert.throws(() => f.paste(stale), /canvas has changed/u);
    assert.deepEqual(f.filesIn('To'), []);
    const pasted = f.paste(f.store.getProject(f.to.id).revision);
    assert.deepEqual(pasted.missing, []);
    assert.deepEqual(f.filesIn('To'), ['chart.png']);
  } finally { f.close(); }
});

test('a paste refused for another reason takes its copied file back', () => {
  const f = fixture();
  try {
    const revision = f.store.getProject(f.to.id).revision;
    // A block with this id is already on the canvas, so the paste itself is refused after the file was copied.
    f.store.mutate(f.to.id, [{ type: 'addNode', node: { id: 'copy', title: 'Taken', description: '', kind: 'topic', parentId: null, x: 0, y: 0 } }], 'Add a block');
    assert.throws(() => f.paste(revision + 1));
    assert.deepEqual(f.filesIn('To'), []);
  } finally { f.close(); }
});

test('a pasted File block whose file could not be copied arrives without a file, not with a namesake', () => {
  const f = fixture();
  try {
    // The target project has its own, unrelated chart.png; the source file is gone.
    f.folders.saveFile(f.to.id, 'chart.png', png);
    unlinkSync(join(f.folders.status(f.from.id).path!, f.path));
    const pasted = f.paste(f.store.getProject(f.to.id).revision);
    assert.deepEqual(pasted.missing, ['Chart']);
    const copy = pasted.project.canvas.nodes.find(node => node.id === 'copy')!;
    assert.equal(copy.file, undefined);
    assert.deepEqual(f.filesIn('To'), ['chart.png']);
  } finally { f.close(); }
});
