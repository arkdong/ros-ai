import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ProjectFolders, projectFolderRoot } from '../src/server/project-folders.js';

type Saved = { projectId: string; path: string; device: number; inode: number };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-folder-reconnect-')), data = join(dir, 'store');
  let store = new Store(data), folders = new ProjectFolders(store, { reserved: [data] });
  const project = store.createProject('Thesis'), folder = join(dir, 'Thesis');
  folders.attach(project.id, folder);
  return {
    dir, folder, project,
    get store() { return store; }, get folders() { return folders; },
    saved: () => store.record<Saved>('project-folder', project.id)!,
    /** A new session of ros.ai: the server stops and starts again on the same data. */
    restart() { folders.shutdown(); store.close(); store = new Store(data); folders = new ProjectFolders(store, { reserved: [data] }); folders.start(); },
    close() { folders.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a project folder stays connected after a restart that gives its disk a new device number', () => {
  const f = fixture();
  try {
    // macOS numbers disks as it mounts them, so the number saved last session can differ from today's.
    const saved = f.saved();
    f.store.saveRecord('project-folder', f.project.id, f.project.id, { ...saved, device: saved.device + 1 });
    f.restart();
    assert.equal(projectFolderRoot(f.store, f.project.id), f.folder);
    assert.equal(f.folders.status(f.project.id).available, true);
    assert.equal(f.saved().device, statSync(f.folder).dev, 'the folder is remembered as it is now');
  } finally { f.close(); }
});

test('a project folder that a sync app or backup put back as a new copy reconnects by itself', async () => {
  const f = fixture();
  try {
    f.folders.shutdown();
    // Same place, same files, new inode: what iCloud Drive, Dropbox or a Time Machine restore can leave.
    const copy = join(f.dir, 'copy');
    cpSync(f.folder, copy, { recursive: true }); rmSync(f.folder, { recursive: true }); renameSync(copy, f.folder);
    assert.notEqual(statSync(f.folder).ino, f.saved().inode);
    f.restart();
    assert.equal(projectFolderRoot(f.store, f.project.id), f.folder);
    for (let tries = 0; tries < 100 && f.folders.status(f.project.id).checkedAt === undefined; tries++) await new Promise(done => setTimeout(done, 20));
    const status = f.folders.status(f.project.id);
    assert.equal(status.available, true, status.reason);
    assert.equal(f.saved().inode, statSync(f.folder).ino);
  } finally { f.close(); }
});

test('a different folder put in the project folder’s place still asks to reconnect', async () => {
  const f = fixture();
  try {
    f.folders.shutdown();
    const other = join(f.dir, 'other'); mkdirSync(other); rmSync(f.folder, { recursive: true }); renameSync(other, f.folder);
    f.restart();
    assert.equal(projectFolderRoot(f.store, f.project.id), null);
    for (let tries = 0; tries < 100 && f.folders.status(f.project.id).checkedAt === undefined; tries++) await new Promise(done => setTimeout(done, 20));
    const status = f.folders.status(f.project.id);
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /moved or replaced/u);
  } finally { f.close(); }
});

test('a folder another copy of ros.ai took over is left alone instead of the two overwriting each other', async () => {
  const f = fixture();
  try {
    // The installed app and a copy run from code keep separate projects, and both were pointed at this folder.
    const manifest = join(f.folder, '.ros-ai', 'project.json'), theirs = { ...JSON.parse(readFileSync(manifest, 'utf8')), projectId: 'other-copy-project', title: 'Rec' };
    writeFileSync(manifest, `${JSON.stringify(theirs, null, 2)}\n`);
    f.restart();
    assert.equal(projectFolderRoot(f.store, f.project.id), null);
    f.store.mutate(f.project.id, [{ type: 'addNode', node: { id: 'note-1', title: 'New note', description: 'Written here', kind: 'topic', x: 0, y: 0 } }], 'Add a note', f.store.getProject(f.project.id).revision);
    for (let tries = 0; tries < 100 && f.folders.status(f.project.id).available !== false; tries++) await new Promise(done => setTimeout(done, 20));
    const status = f.folders.status(f.project.id);
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /“Rec” in another copy of ros\.ai/u);
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).projectId, 'other-copy-project', 'the other copy’s project.json is not overwritten');
  } finally { f.close(); }
});
