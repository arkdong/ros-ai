import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApp, apiErrorHandler } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-http-'));
  const store = new Store(dir);
  const unavailable = (): never => { throw new Error('Provider credentials unavailable in this HTTP test.'); };
  const app = createApp(store, { chat: async () => unavailable(), startRun: unavailable, cancelRun: unavailable, retryRun: unavailable, connectionStatuses: () => [] });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  return { store, base, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); rmSync(dir, { recursive:true, force:true }); } };
}

test('a project created without a name is Untitled, numbered past existing ones', async () => {
  const f = await fixture();
  try {
    const create = async (body: object) => (await (await fetch(`${f.base}/api/projects`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json()).title;
    assert.equal(await create({ title:'' }), 'Untitled');
    assert.equal(await create({}), 'Untitled 2');
    assert.equal(await create({ title:'   ' }), 'Untitled 3');
    assert.equal(await create({ title:'Named' }), 'Named');
  } finally { await f.close(); }
});

test('HTTP API enforces local host/origin and validates direct edits without credentials', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/api/health`)).status, 200);
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      request(`${f.base}/api/projects`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await fetch(`${f.base}/api/projects`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const invalid = await fetch(`${f.base}/api/projects`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:'x'.repeat(161)}) });
    assert.equal(invalid.status, 400);
    const response = await fetch(`${f.base}/api/projects`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:'HTTP investigation'}) });
    assert.equal(response.status, 201);
    const project = await response.json();
    const mutation = await fetch(`${f.base}/api/projects/${project.id}/mutations`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({label:'Add thought',expectedRevision:project.revision,operations:[{type:'addNode',node:{id:'idea',title:'An idea',description:'',x:0,y:0}}]}) });
    assert.equal(mutation.status, 200);
    assert.equal((await mutation.json()).canvas.nodes[0].title, 'An idea');
    const stale = await fetch(`${f.base}/api/projects/${project.id}/mutations`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({label:'Stale',expectedRevision:project.revision,operations:[{type:'removeNode',id:'idea'}]}) });
    assert.equal(stale.status, 409);
    const bad = await fetch(`${f.base}/api/projects/${project.id}/mutations`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({label:'Invalid',operations:[{type:'shell',command:'echo should never run'}]}) });
    assert.equal(bad.status, 400);
    const detail = await (await fetch(`${f.base}/api/projects/${project.id}`)).json();
    assert.equal(detail.project.canvas.nodes.length, 1);
    assert.equal(detail.runs.length, 0);
  } finally { await f.close(); }
});
