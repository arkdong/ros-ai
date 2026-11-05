import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { InferenceConnections } from '../src/server/inference-connections.js';
import { CloudAccount } from '../src/server/cloud-account.js';

const caps = { maxInputBytes: 64000, maxOutputTokens: 4096, timeoutMs: 30000, maxConcurrent: 4, maxResponseBytes: 256000 };
function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-allowance-')), store = new Store(join(dir, 'store')), inference = new InferenceConnections(store, join(dir, 'keys'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, inference };
}
/** Use as a connection's record keeps it: one admission per request, each with what it reserved. */
function used(store: Store, id: string, requests: number, unitsEach: number) {
  const state = store.globalRecord<{ admissions: unknown[] }>('inference-connection', id)!;
  const at = new Date().toISOString();
  store.saveGlobalRecord('inference-connection', id, { ...state, admissions: Array.from({ length: requests }, (_, index) => ({ usageId: `used-${index}`, reservedUnits: unitsEach, createdAt: at })) });
}

test('ros.ai’s own connections keep an allowance however much they have served, and a ceiling equal to the usage is not below it', t => {
  const { store, inference } = workspace(t);
  const cloud = inference.create({ name: 'ros.ai cloud', endpoint: 'https://cloud.example/v1', enabled: true, caps, models: [{ id: 'ros-deep', label: 'ROS', contextTokens: 32768, inputUsdPerMillion: 0.5, outputUsdPerMillion: 2 }] });
  // 407 deep requests at US$0.31 each: US$126.17, a total whose dollars do not convert back exactly.
  used(store, cloud.id, 407, 310_000_000);
  const status = inference.status(cloud.id);
  assert.equal(status.accountedUsd, 126.17);
  assert.equal(inference.saveAllowance(cloud.id, { requestCeiling: 10000, usdCeiling: status.accountedUsd, enabled: true, acknowledged: true }).usdCeiling, 126.17);
  // Past 10,000 requests and US$1,000, the allowance follows the usage instead of failing the sign-in.
  used(store, cloud.id, 10_001, 310_000_000);
  const kept = inference.keepAllowance(cloud.id, { requestCeiling: 10000, usdCeiling: 100 });
  assert.equal(kept.requestCeiling, 10_001);
  assert.equal(kept.usdCeiling, 3100.31);
  assert.equal(kept.allowanceEnabled, true);
});

test('signing in again works after heavy use, and after an earlier sign-in left its connection without the account', async t => {
  const { dir, store, inference } = workspace(t);
  const signedOut: string[] = [];
  const server = createServer((req, res) => {
    const send = (value: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/app/token') return send({ access_token: `token-${'x'.repeat(24)}` });
    if (req.url === '/v1/me') return send({ user: { email: 'person@example.com' } });
    if (req.url === '/v1/models') return send({ data: [{ id: 'ros', context_length: 32768, max_output_tokens: 4096, pricing: { input_usd_per_million: 0.1, output_usd_per_million: 0.4 } }] });
    if (req.url === '/api/auth/sign-out') { signedOut.push(String(req.headers.authorization)); return send({}); }
    res.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const account = new CloudAccount(url, join(dir, 'keys'), inference, 4310);
  const signIn = async () => {
    const waiting = await account.signIn();
    return account.callback({ state: new URL(waiting.verificationUrl!).searchParams.get('state'), code: 'one-time' });
  };
  // An earlier sign-in registered the connection and then failed before the account was saved; the connection has
  // served more than 10,000 requests.
  const left = inference.create({ name: 'ros.ai cloud', endpoint: `${url}/v1`, enabled: true, caps, models: [{ id: 'ros', label: 'ROS', contextTokens: 32768, inputUsdPerMillion: 0, outputUsdPerMillion: 0 }] });
  used(store, left.id, 10_001, 0);
  assert.deepEqual(await signIn(), { ok: true, message: 'You can close this tab and go back to ros.ai.' });
  assert.equal(account.connectionId(), left.id);
  assert.equal(inference.status(left.id).ready, true);
  // Sign out revokes the token the connection held, and signing in again works.
  await account.signOut();
  assert.equal(signedOut.length, 1);
  assert.equal(account.connectionId(), undefined);
  assert.equal((await signIn()).ok, true);
  assert.equal(inference.status(account.connectionId()!).ready, true);
});
