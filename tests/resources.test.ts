import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnections } from '../src/server/connections.js';
import { Store } from '../src/server/store.js';
import { createApp, apiErrorHandler } from '../src/server/app.js';
import { groupResources } from '../src/shared/resource-groups.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-resources-'));
  let store = new Store(directory);
  const project = store.createProject('Resources fixture');
  store.mutate(project.id, ['a', 'b'].map(id => ({ type: 'addNode' as const, node: { id, title: id, description: '', x: 0, y: 0 } })), 'Fixture notes');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, project, get store() { return store; }, get resources() { return new LocalConnections(store); }, reopen() { store.close(); store = new Store(directory); } };
}
const contents = '\uFEFFname,value\r\n"Amsterdam, west",12\r\n';

test('resource groups retain each exact version and never merge equal names or unrelated copies', t => {
  const f = fixture(t);
  const original = f.resources.addResource(f.project.id, { mode: 'copy', name: 'Observations', fileName: 'data.csv', content: contents });
  f.resources.useResource(f.project.id, original.id, 'a');
  f.resources.useResource(f.project.id, original.id, 'b');
  f.resources.addResource(f.project.id, { mode: 'copy', name: 'Observations', fileName: 'data.csv', content: contents });
  const values = f.resources.resources(f.project.id), groups = groupResources(values);
  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.id === `copy:${original.id}`)?.versions.length, 3);
  assert.equal(new Set(groups.flatMap(group => group.versions.map(value => value.id))).size, values.length);
});

test('a preparation connection does not interrupt active service runs', t => {
  const f = fixture(t), artifact = f.resources.useResource(f.project.id, f.resources.addResource(f.project.id, { mode: 'copy', name: 'Data', fileName: 'data.csv', content: contents }).id, 'a');
  const runId = 'active-preparation-test';
  f.store.createRun({ ...f.store.getRun(artifact.runId), id: runId, status: 'running', endedAt: undefined, artifactIds: [] });
  const preparation = new Store(f.directory, { recoverInterrupted: false });
  try { assert.equal(preparation.getRun(runId).status, 'running'); }
  finally { preparation.close(); }
  assert.equal(f.store.getRun(runId).status, 'running');
});

test('exact experiment recaptures group by recorded source while excerpts remain distinct', t => {
  const f = fixture(t), original = f.resources.useResource(f.project.id, f.resources.addResource(f.project.id, { mode: 'copy', name: 'Data', fileName: 'data.csv', content: contents }).id, 'a');
  const run = f.store.createRun({ ...f.store.getRun(original.runId), id: 'recapture-test', status: 'running', endedAt: undefined, artifactIds: [] });
  for (const content of [contents, 'name,value\nAmsterdam,3\n']) f.store.addArtifact({ projectId: f.project.id, nodeId: 'a', runId: run.id, kind: 'dataset', title: 'Captured input', content, mediaType: 'text/csv', metadata: { sourceArtifactId: original.id } });
  const groups = groupResources(f.resources.resources(f.project.id));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.versions.length).sort(), [1, 3]);
});

test('upload copies stay project-local, preserve exact bytes through restart, and do not start work', t => {
  const f = fixture(t), before = f.store.detail(f.project.id);
  const copy = f.resources.addResource(f.project.id, { mode: 'copy', name: 'Measurements', fileName: 'measurements.csv', content: contents });
  assert.equal(copy.storage, 'copied'); assert.equal(copy.bytes, Buffer.byteLength(contents));
  assert.equal(copy.hash, createHash('sha256').update(contents).digest('hex'));
  assert.equal(Object.hasOwn(copy, 'content'), false);
  assert.equal(Object.hasOwn(copy, 'path'), false);
  assert.deepEqual(f.store.detail(f.project.id), before, 'Adding a resource does not change canvas, history, inputs, runs or budgets');
  assert.equal(f.resources.previewResource(f.project.id, copy.id).content, contents);
  f.reopen();
  assert.equal(f.resources.previewResource(f.project.id, copy.id).content, contents);
  const captured = f.resources.useResource(f.project.id, copy.id, 'a');
  assert.equal(captured.content, contents); assert.equal(captured.hash, copy.hash);
  assert.equal(captured.metadata?.resourceId, copy.id);
  assert.equal(captured.metadata?.origin, 'browser-upload');
  assert.equal(f.store.getRun(captured.runId).configuration.kind, 'file-import');
  assert.equal(f.store.getRun(captured.runId).status, 'completed');
  assert.equal(f.store.detail(f.project.id).inputs[0].artifactId, captured.id);
  assert.deepEqual(f.store.listUsage(), []);
  assert.equal(f.resources.resources(f.project.id).length, 2, 'Project copy and captured input version are distinguished');
});

test('links preview current selected files while imports retain immutable versions and permissions', t => {
  const f = fixture(t), path = join(f.directory, 'linked.csv');
  writeFileSync(path, contents);
  const link = f.resources.addResource(f.project.id, { mode: 'link', name: 'Linked observations', path });
  assert.equal(link.storage, 'linked'); assert.equal(f.resources.list(f.project.id)[0].writable, false);
  assert.equal(f.resources.previewResource(f.project.id, link.id).content, contents);
  const captured = f.resources.useResource(f.project.id, link.id, 'a');
  assert.equal(captured.metadata?.connectionId, link.id);
  assert.equal(readFileSync(path, 'utf8'), contents);
  writeFileSync(path, 'value\n99\n');
  assert.equal(f.resources.previewResource(f.project.id, link.id).content, 'value\n99\n');
  assert.equal(f.resources.previewResource(f.project.id, captured.id).content, contents);
  const before = f.store.detail(f.project.id);
  const reused = f.resources.useResource(f.project.id, captured.id, 'b');
  assert.equal(reused.id, captured.id);
  assert.equal(f.store.listRuns(f.project.id).length, before.runs.length, 'Reusing saved data never executes or recaptures');
  assert.equal(f.store.listArtifacts(f.project.id).length, before.artifacts.length);
  assert.equal(f.store.detail(f.project.id).inputs.find(input => input.nodeId === 'b')?.excerpt, contents);
  const other = join(f.directory, 'other.csv'); writeFileSync(other, 'value\n7\n');
  renameSync(path, `${path}.old`); symlinkSync(other, path);
  assert.throws(() => f.resources.previewResource(f.project.id, link.id), /replaced or redirected/);
  assert.equal(f.resources.previewResource(f.project.id, captured.id).content, contents);
});

test('resource upload enforces byte/type limits and project isolation without orphaned imports', t => {
  const f = fixture(t), other = f.store.createProject('Other project');
  const copy = f.resources.addResource(f.project.id, { mode: 'copy', name: 'Exact', fileName: 'data.csv', content: contents });
  const invalid = [
    { fileName: 'program.py', content: contents }, { fileName: 'data.csv', content: '' },
    { fileName: 'data.csv', content: 'a\0b' }, { fileName: 'data.csv', content: 'é'.repeat(250001) },
  ];
  for (const body of invalid) assert.throws(() => f.resources.addResource(f.project.id, { mode: 'copy', name: 'Invalid', ...body }));
  assert.equal(f.resources.resources(f.project.id).length, 1);
  assert.throws(() => f.resources.previewResource(other.id, copy.id), /not found/);
  assert.throws(() => f.resources.useResource(other.id, copy.id, 'a'), /not found/);
  assert.throws(() => f.resources.useResource(f.project.id, copy.id, 'missing'), /Node not found/);
  assert.equal(f.store.listRuns(f.project.id).length, 0);
  assert.equal(f.store.listArtifacts(f.project.id).length, 0);
  assert.deepEqual(f.resources.resources(other.id), []);
});

test('linked CSV reads reject invalid UTF-8 before preview or capture without changing source bytes', t => {
  const f = fixture(t), path = join(f.directory, 'invalid-encoding.csv');
  const bytes = Buffer.from([0x76, 0x0a, 0xc3, 0x28, 0x0a]);
  writeFileSync(path, bytes);
  const link = f.resources.addResource(f.project.id, { mode: 'link', name: 'Invalid encoding', path });
  assert.throws(() => f.resources.previewResource(f.project.id, link.id), /not valid UTF-8/);
  assert.throws(() => f.resources.useResource(f.project.id, link.id, 'a'), /not valid UTF-8/);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(f.store.listRuns(f.project.id).length, 0);
  assert.equal(f.store.listArtifacts(f.project.id).length, 0);
  assert.equal(f.store.detail(f.project.id).inputs.length, 0);
  writeFileSync(path, contents);
  const captured = f.resources.useResource(f.project.id, link.id, 'a');
  assert.equal(captured.content, contents, 'UTF-8 BOM and CRLF remain byte-exact');
  assert.equal(captured.hash, createHash('sha256').update(readFileSync(path)).digest('hex'));
});

test('resource HTTP endpoints expose metadata, preview and explicit use with validation', async t => {
  const f = fixture(t), unavailable = (): never => { throw new Error('Provider requests are unavailable in this resource test.'); };
  const app = createApp(f.store, { chat: async () => unavailable(), startRun: unavailable, cancelRun: unavailable, retryRun: unavailable, connectionStatuses: () => [] });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/projects/${f.project.id}/resources`;
  const send = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await send(base, { mode: 'copy', name: 'HTTP copy', fileName: 'sample.csv', content: contents });
    assert.equal(response.status, 201); const resource = await response.json();
    const list = await (await fetch(base)).json(); assert.equal(list.length, 1); assert.equal(list[0].content, undefined);
    assert.equal((await (await fetch(`${base}/${resource.id}`)).json()).content, contents);
    const capture = await send(`${base}/${resource.id}/use`, { nodeId: 'a' }); assert.equal(capture.status, 201);
    assert.equal((await capture.json()).content, contents);
    assert.equal((await send(base, { mode: 'copy', name: 'Invalid', fileName: 'a.csv', content: contents, arbitraryPath: '/tmp' })).status, 400);
    assert.equal((await fetch(base, { headers: { Origin: 'https://example.com' } })).status, 403);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
