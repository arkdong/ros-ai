import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { ProjectFolders } from '../src/server/project-folders.js';

test('opening a folder never writes the board over the person’s own .canvas file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-folder-board-'));
  const store = new Store(join(dir, 'store')), folders = new ProjectFolders(store, { reserved: [join(dir, 'store')] });
  try {
    // An Obsidian vault named Research that already has a board called Research.canvas.
    const vault = join(dir, 'Research'), own = `${JSON.stringify({ nodes: [{ id: '6f1c2a9b0d3e4f57', type: 'text', text: 'My own board', x: 0, y: 0, width: 250, height: 60 }], edges: [] })}\n`;
    mkdirSync(vault); writeFileSync(join(vault, 'Research.canvas'), own);
    const project = folders.openFolder(vault);
    assert.equal(project.title, 'Research');
    assert.equal(readFileSync(join(vault, 'Research.canvas'), 'utf8'), own, 'the person’s board is left as it was');
    const board = join(vault, 'Research (ros.ai).canvas');
    assert.ok(existsSync(board), 'ros.ai keeps its board under a name of its own');
    // Later changes go to ros.ai's own board, never to the person's.
    store.mutate(project.id, [{ type: 'addNode', node: { id: 'note-1', title: 'A new note', description: 'Written in ros.ai', kind: 'topic', x: 0, y: 0 } }], 'Add a note', store.getProject(project.id).revision);
    for (let tries = 0; tries < 100 && !readFileSync(board, 'utf8').includes('note-1'); tries++) await delay(20);
    assert.match(readFileSync(board, 'utf8'), /note-1/);
    assert.equal(readFileSync(join(vault, 'Research.canvas'), 'utf8'), own);
  } finally {
    folders.shutdown(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
