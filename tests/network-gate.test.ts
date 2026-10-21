import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

import { NetworkGate, type NetworkEvent } from '../src/server/network-gate.js';
import type { Store } from '../src/server/store.js';

function memoryStore(): Store {
  const records = new Map<string, unknown>();
  return { globalRecord: (namespace: string, id: string) => records.get(`global:${namespace}:${id}`), saveGlobalRecord: (namespace: string, id: string, value: unknown) => { records.set(`global:${namespace}:${id}`, value); return value; },
    record: (namespace: string, id: string) => records.get(`${namespace}:${id}`), saveRecord: (namespace: string, id: string, _project: string, value: unknown) => { records.set(`${namespace}:${id}`, value); return value; } } as unknown as Store;
}
/** Sends CONNECT through the proxy and returns its status line. */
const connectStatus = (port: number, target: string) => new Promise<string>(resolve => {
  const req = request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
  req.on('connect', (res, socket) => { socket.destroy(); resolve(`${res.statusCode} ${res.statusMessage}`); });
  req.on('error', error => resolve(error.message));
  req.end();
});

test('a new site waits for the person; Always is remembered for the project, Deny for the session', async () => {
  const gate = new NetworkGate(memoryStore()), asked: string[] = [];
  gate.subscribe((event: NetworkEvent) => { if (event.type === 'request') { asked.push(event.request.host); gate.answer(event.request.id, event.request.host === 'no.invalid' ? 'deny' : 'always'); } });
  const proxy = await gate.open('p1', 'A notebook');
  try {
    assert.match(await connectStatus(proxy.port, 'no.invalid:443'), /^403 no\.invalid is not allowed/u);
    assert.match(await connectStatus(proxy.port, 'no.invalid:443'), /^403/u);
    assert.deepEqual(asked, ['no.invalid']);
    assert.match(await connectStatus(proxy.port, '127.0.0.1:4310'), /^403 127\.0\.0\.1 is on this computer/u);
    assert.match(await connectStatus(proxy.port, 'localhost:4310'), /^403 localhost is on this computer/u);
    assert.deepEqual(asked, ['no.invalid']);
    await connectStatus(proxy.port, 'example.invalid:443');
    assert.deepEqual(gate.sites('p1'), ['example.invalid']);
  } finally { proxy.close(); }
});

test('Full network lets every site through without asking', async () => {
  const gate = new NetworkGate(memoryStore()); let asked = 0;
  gate.subscribe(event => { if (event.type === 'request') asked++; });
  gate.setMode('full');
  const proxy = await gate.open(null, 'A Code block');
  try { assert.doesNotMatch(await connectStatus(proxy.port, 'anything.invalid:443'), /not allowed/u); assert.equal(asked, 0); }
  finally { proxy.close(); }
});
