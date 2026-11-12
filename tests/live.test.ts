import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { LIVE_PATH, LiveChannel, type LiveChanged } from '../src/server/live.js';
import { Store } from '../src/server/store.js';
import type { CanvasNode } from '../src/shared/types.js';

const node = (id: string): CanvasNode => ({ id, title: id, description: '', x: 0, y: 0 });
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-live-'));
  const store = new Store(directory), live = new LiveChannel(store), server = createServer((_req, res) => res.end('page'));
  live.attach(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open: WebSocket[] = [];
  t.after(() => { for (const socket of open) socket.terminate(); live.shutdown(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  /** A page's connection, with what the server has sent it so far and a wait for the next message. */
  const page = async (origin: string | undefined = `http://${host}`) => {
    const socket = new WebSocket(`ws://${host}${LIVE_PATH}`, origin ? { origin } : {}), got: LiveChanged[] = [];
    open.push(socket);
    let told: (() => void) | undefined, read = 0;
    socket.on('message', data => { got.push(JSON.parse(String(data)) as LiveChanged); told?.(); });
    await new Promise<void>((done, refused) => { socket.once('open', done); socket.once('error', refused); });
    const next = async () => { while (got.length <= read) await new Promise<void>(done => { told = done; }); return got[read++]; };
    return { got, next, watch: (projectId: string) => socket.send(JSON.stringify({ type: 'watch', projectId })) };
  };
  return { store, host, page };
}

test('a page is told of every write to the project it shows, and of no other project', async t => {
  const { store, page } = await fixture(t);
  const shown = store.createProject('Shown'), other = store.createProject('Other');
  const window = await page();
  window.watch(shown.id);
  // The answer to a watch is the project's newest stamp, which a read of the project carries too.
  assert.deepEqual(await window.next(), { type: 'changed', projectId: shown.id, stamp: store.stamp(shown.id) });

  store.mutate(other.id, [{ type: 'addNode', node: node('elsewhere') }], 'Add a block');
  store.mutate(shown.id, [{ type: 'addNode', node: node('a') }], 'Add a block');
  const canvas = await window.next();
  assert.equal(canvas.projectId, shown.id);
  assert.equal(canvas.stamp, store.stamp(shown.id));
  assert.ok(canvas.stamp > window.got[0].stamp, 'a write moves the stamp on');

  // A burst of writes (an agent's turn) is told as one message that carries the newest stamp.
  for (const text of ['one', 'two', 'three']) store.addMessage(shown.id, null, 'user', text);
  store.saveRecord('assistant-turn', 'turn-1', shown.id, { id: 'turn-1', status: 'running' });
  assert.equal((await window.next()).stamp, store.stamp(shown.id));
  assert.equal(window.got.length, 3);
  assert.ok(window.got.every(message => message.projectId === shown.id));
});

test('a write that is undone, or that changes nothing, is not told', async t => {
  const { store } = await fixture(t);
  const project = store.createProject('Quiet');
  const stamps: number[] = [];
  store.onChange((_id, stamp) => stamps.push(stamp));
  store.saveRecord('highlight', 'h1', project.id, { text: 'kept' });
  assert.equal(stamps.length, 1);
  store.saveRecord('highlight', 'h1', project.id, { text: 'kept' });
  assert.equal(stamps.length, 1, 'saving a record as it already is');
  assert.throws(() => store.atomic(() => { store.addMessage(project.id, null, 'user', 'never sent'); throw new Error('undone'); }));
  assert.equal(stamps.length, 1, 'a write that was rolled back');
  store.atomic(() => { store.addMessage(project.id, null, 'user', 'first'); store.addMessage(project.id, null, 'user', 'second'); });
  assert.equal(stamps.length, 2, 'writes saved together are told once, after they are saved');
  assert.equal(store.stamp(project.id), stamps[1]);
});

test('only ros.ai\'s own page may open the live connection', async t => {
  const { page } = await fixture(t);
  await assert.rejects(page('https://example.com'), /403/);
  // A page always names its origin; a request without one is not ros.ai's page.
  await assert.rejects(page(''), /403/);
  await page();
});
