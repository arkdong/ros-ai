import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { NebiusSandboxBackend, NEBIUS_SANDBOX_IMAGE } from '../src/server/nebius-sandbox.js';
import type { RemoteExecutionState } from '../src/server/sandbox.js';

// Transport fixtures only: no account/network/resource calls are made. Local
// worker execution below uses fixed, authored examples, never model-written code.
const API = 'https://api.tokenfactory.nebius.com/sandboxes/v1';
const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const input = { code: 'metric("Mean", 2)', csv: 'value\n1\n3\n', parameters: { scale: 2 } };
const capture = { ok: true, outputs: [{ kind: 'metric', title: 'Mean', content: '{"value":2}', mediaType: 'application/json' }], stdout: 'Fixture only\n', stderr: '', runtime: 'Python 3.12 fixture; not remotely verified', error: null };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const created = (body: unknown = { uuid: ID, image: NEBIUS_SANDBOX_IMAGE }, location = `/v1/operations/${ID}`) => json(body, 201, { Location: location });
const terminalOperation = (body: unknown = capture) => ({ uuid: ID, kind: 'instance', status: 'SUCCESS', image_uuid: NEBIUS_SANDBOX_IMAGE, metadata: { result: {
  state: { exit_code: 0, signal: null, timed_out: false }, stdout: { value: Buffer.from(JSON.stringify(body)).toString('base64'), encoding: 'base64', truncated: false },
  stderr: { value: '', encoding: 'ascii', truncated: false }, resources: { cost: .125 },
} } });
type Call = { url: string; init: RequestInit };
function backend(handler: (call: Call, index: number) => Response | Promise<Response>, options: { completionTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (url, init = {}) => { const call = { url: String(url), init }; calls.push(call); return handler(call, calls.length - 1); };
  const service = new NebiusSandboxBackend({ apiKey: 'fixture-secret-key', projectId: 'fixture-project', fetch: fetcher, pollIntervalMs: 1, requestTimeoutMs: 100, completionTimeoutMs: 500, ...options });
  return { service, calls };
}
function trustedWorker(code: string, csv = input.csv) {
  const worker = readFileSync(new URL('../src/server/sandbox/nebius_worker.py', import.meta.url), 'utf8');
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', worker], { input: JSON.stringify({ code, csv, parameters: input.parameters }), encoding: 'utf8', timeout: 3000, maxBuffer: 600_000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.error, undefined);
  assert.ok(Buffer.byteLength(result.stdout) <= 500_000);
  return { process: result, result: JSON.parse(result.stdout) };
}

test('configuration is read-only; missing credentials fail closed before any fetch', () => {
  let calls = 0;
  const service = new NebiusSandboxBackend({ apiKey: '', projectId: '', fetch: async () => { calls++; throw new Error('Must not fetch'); } });
  assert.equal(service.capabilities().available, false);
  assert.equal(service.capabilities().maxMemoryMb, null);
  assert.throws(() => service.start(input), /not configured/);
  assert.equal(calls, 0);
  const configured = backend(() => { throw new Error('Must not probe'); });
  assert.equal(configured.service.capabilities().available, true);
  assert.deepEqual(configured.service.capabilities().libraries, {});
  assert.match(configured.service.capabilities().dataContract!, /rows.*dictionaries/);
  assert.equal(configured.calls.length, 0);
  assert.throws(() => configured.service.start({ ...input, code: '🌧'.repeat(10_000) }), /UTF-8 bytes/);
  assert.throws(() => configured.service.start({ ...input, csv: 'x'.repeat(500_001) }), /500 KB/);
});

test('live Nebius no-signal sentinel is successful while a positive terminating signal fails', async () => {
  for (const signal of [-1, 0, 9]) {
    const operation = terminalOperation();
    const state: { exit_code: number; signal: number | null; timed_out: boolean } = operation.metadata.result.state;
    state.signal = signal;
    const fixture = backend((_call, index) => index === 0 ? created() : json(operation));
    const result = await fixture.service.start(input).done;
    assert.equal(result.status, signal > 0 ? 'failed' : 'completed');
    assert.equal(result.signal, signal > 0 ? String(signal) : null);
  }
});

test('one fixed-origin submission captures only explicit inputs and decodes a validated result', async () => {
  const states: RemoteExecutionState[] = [];
  const f = backend((call, index) => {
    if (index === 0) {
      assert.equal(states[0].phase, 'submitting', 'Durable marker precedes the only POST');
      assert.equal(call.url, `${API}/instances`); assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'manual');
      const headers = new Headers(call.init.headers);
      assert.equal(headers.get('Authorization'), 'Bearer fixture-secret-key'); assert.equal(headers.get('Project'), 'fixture-project');
      const body = JSON.parse(String(call.init.body));
      assert.equal(body.image, NEBIUS_SANDBOX_IMAGE); assert.equal(body.command, '/usr/local/bin/python3'); assert.equal(body.shell, false);
      assert.equal(body.uid, 65534); assert.equal(body.gid, 65534); assert.equal(body.cwd, '/tmp'); assert.equal(body.timeout, 30);
      assert.deepEqual(body.networking, { enabled: false }); assert.deepEqual(body.resources_limits, { max_layer_bytes: 67108864 });
      assert.equal(body.disposable, true); assert.equal(body.preserve_env, false); assert.equal(body.truncate_output_at, 500_000);
      assert.equal(body.files, undefined); assert.equal(body.stdin.encoding, 'base64'); assert.equal(body.stdin.close, true);
      assert.deepEqual(JSON.parse(Buffer.from(body.stdin.value, 'base64').toString('utf8')), { code: input.code, csv: input.csv, parameters: input.parameters });
      assert.equal(JSON.stringify(body).includes('fixture-secret-key'), false);
      assert.deepEqual(Object.keys(body.env).sort(), ['HOME', 'LANG', 'PATH']);
      return created();
    }
    assert.equal(call.url, `${API}/operations/${ID}`);
    assert.equal(states.some(state => state.phase === 'submitted' && state.operationId === ID), true);
    return index === 1 ? json({ uuid: ID, kind: 'instance', status: 'EXECUTING', metadata: { result: {} } }) : json(terminalOperation());
  });
  const result = await f.service.start({ ...input, onProgress: state => states.push(state) }).done;
  assert.equal(result.status, 'completed', result.error); assert.equal(result.stdout, capture.stdout);
  assert.deepEqual(result.outputs, capture.outputs); assert.equal(result.remote?.phase, 'terminal');
  assert.equal(result.remote?.rawCost, .125); assert.equal(result.remote?.costUnit, 'unknown');
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('trusted worker helpers produce captured records, escaped SVG, CSV, scalar and prior outputs on failure', async () => {
  const sample = trustedWorker('values = [float(row["value"]) for row in rows]\nmetric("Mean", sum(values) / len(values))\ntable("Rows", [{"value": value} for value in values])\nplot("<script> & label", values, ["one<", "two&"])\nexport_csv("Export", [{"value": value} for value in values])\nprint("Rows", len(rows))\nconclusion("A fixed trusted fixture")');
  assert.equal(sample.process.status, 0); assert.equal(sample.result.ok, true);
  assert.equal(sample.result.outputs.length, 5); assert.match(sample.result.stdout, /Rows 2/);
  assert.match(sample.result.outputs.find((output: { kind: string }) => output.kind === 'plot').content, /&lt;script&gt; &amp; label/);
  const f = backend((_call, index) => index ? json(terminalOperation(sample.result)) : created());
  assert.equal((await f.service.start(input).done).status, 'completed', 'Real helper SVG must pass the untrusted-output validator');
  const failed = trustedWorker('metric("Before error", 4)\nraise ValueError("Authored fixture failure")');
  assert.equal(failed.process.status, 1); assert.equal(failed.result.outputs.length, 1); assert.match(failed.result.error, /Authored fixture failure/);
  const overflow = trustedWorker('metric("Before limit", 4)\nprint("🌧" * 30000)');
  assert.equal(overflow.result.ok, false); assert.match(overflow.result.error, /50 KB/); assert.equal(overflow.result.outputs.length, 1);
  const rows = trustedWorker('metric("Unexpected", 1)', 'value\n' + '1\n'.repeat(10001));
  assert.match(rows.result.error, /10,000 rows/);
});

test('storage failure before submission prevents the POST; failure after operation capture cancels it', async () => {
  const before = backend(() => { throw new Error('Unexpected provider request'); });
  const blocked = await before.service.start({ ...input, onProgress: () => { throw new Error('Storage unavailable'); } }).done;
  assert.equal(blocked.status, 'failed'); assert.equal(before.calls.length, 0); assert.equal(blocked.remote?.phase, 'terminal');
  const after = backend(call => call.init.method === 'POST' ? created() : call.init.method === 'DELETE' ? new Response(null, { status: 202 }) : json({ uuid: ID, kind: 'instance', status: 'CANCELLED' }));
  const stopped = await after.service.start({ ...input, onProgress: state => { if (state.operationId) throw new Error('Cursor write failed'); } }).done;
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.remote?.cancellationConfirmed, true);
  assert.equal(after.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(after.calls.filter(call => call.init.method === 'DELETE').length, 1);
});

test('immediate stop never submits; in-flight stop waits for its operation ID then confirms cancellation', async () => {
  const before = backend(() => { throw new Error('Must not submit'); });
  const early = before.service.start(input); early.cancel('Fixture cancelled before submission');
  assert.equal((await early.done).status, 'cancelled'); assert.equal(before.calls.length, 0);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let polls = 0;
  const during = backend(async call => {
    if (call.init.method === 'POST') { await pending; return created(); }
    if (call.init.method === 'DELETE') return new Response(null, { status: 202 });
    polls++; return json({ uuid: ID, kind: 'instance', status: polls === 1 ? 'EXECUTING' : 'CANCELLED' });
  });
  const attempt = during.service.start(input); await delay(0); attempt.cancel('Fixture stops while POST is pending'); release();
  const result = await attempt.done;
  assert.equal(result.status, 'cancelled'); assert.equal(result.remote?.cancellationConfirmed, true); assert.equal(polls, 2);
  assert.deepEqual(during.calls.map(call => call.init.method), ['POST', 'DELETE', 'GET', 'GET']);
});

test('transport ambiguity, untrusted redirects, and malformed spawn bodies never repeat submission', async t => {
  for (const scenario of ['timeout', 'transport', 'cross-origin', 'invalid-id', 'malformed-json'] as const) await t.test(scenario, async () => {
    const f = backend(call => {
      if (call.init.method === 'POST') {
        if (scenario === 'timeout') return new Promise<Response>(() => {});
        if (scenario === 'transport') throw new Error('secret HTTP detail fixture-secret-key');
        if (scenario === 'cross-origin') return created(undefined, `https://attacker.example/v1/operations/${ID}`);
        if (scenario === 'invalid-id') return created(undefined, '/v1/operations/not-a-uuid');
        return new Response('broken JSON', { status: 201, headers: { Location: `/v1/operations/${ID}` } });
      }
      if (call.init.method === 'DELETE') return new Response(null, { status: 202 });
      return json({ uuid: ID, kind: 'instance', status: 'CANCELLED' });
    }, { requestTimeoutMs: 10 });
    const result = await f.service.start(input).done;
    assert.equal(result.status, 'failed'); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
    assert.equal(f.calls.every(call => call.url.startsWith(API)), true);
    assert.equal(JSON.stringify(result).includes('fixture-secret-key'), false);
    if (scenario === 'malformed-json') assert.equal(result.remote?.cancellationConfirmed, true, 'Valid Location is saved before parsing an untrusted response body');
    else assert.equal(result.remote?.phase, 'uncertain');
  });
});

test('stop during an in-flight status fetch cannot become a completed local result', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let polls = 0;
  const f = backend(async call => {
    if (call.init.method === 'POST') return created();
    if (call.init.method === 'DELETE') return new Response(null, { status: 202 });
    polls++;
    if (polls === 1) await pending;
    return json(terminalOperation());
  });
  const attempt = f.service.start(input);
  for (let i = 0; i < 30 && polls === 0; i++) await delay(1);
  assert.equal(polls, 1); attempt.cancel('Fixture cancelled while status was in flight'); release();
  const result = await attempt.done;
  assert.equal(result.status, 'cancelled'); assert.equal(result.remote?.cancellationConfirmed, true);
  assert.deepEqual(result.outputs, []);
});

test('terminal output validates identity, truncation, encoding, size, bundle shape and inert plots', async t => {
  const malformed: Record<string, () => unknown> = {
    identity: () => ({ ...terminalOperation(), uuid: OTHER }),
    image: () => ({ ...terminalOperation(), image_uuid: OTHER }),
    truncated: () => { const value = terminalOperation(); value.metadata.result.stdout.truncated = true; return value; },
    base64: () => { const value = terminalOperation(); value.metadata.result.stdout.value = '!!!!'; return value; },
    'output count': () => terminalOperation({ ...capture, outputs: Array(21).fill(capture.outputs[0]) }),
    'active SVG': () => terminalOperation({ ...capture, outputs: [{ kind: 'plot', title: 'Unsafe', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', mediaType: 'image/svg+xml' }] }),
    'SVG URL': () => terminalOperation({ ...capture, outputs: [{ kind: 'plot', title: 'Unsafe', content: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://attacker.example)"/></svg>', mediaType: 'image/svg+xml' }] }),
    'SVG escaped URL': () => terminalOperation({ ...capture, outputs: [{ kind: 'plot', title: 'Unsafe', content: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u\\72l(https://attacker.example)"/></svg>', mediaType: 'image/svg+xml' }] }),
    'unbalanced SVG': () => terminalOperation({ ...capture, outputs: [{ kind: 'plot', title: 'Invalid', content: '<svg xmlns="http://www.w3.org/2000/svg"><text>unclosed</svg>', mediaType: 'image/svg+xml' }] }),
    'metric data': () => terminalOperation({ ...capture, outputs: [{ ...capture.outputs[0], content: '{"value":{"not":"scalar"}}' }] }),
    'mismatched kind': () => terminalOperation({ ...capture, outputs: [{ ...capture.outputs[0], mediaType: 'text/plain' }] }),
    'invalid worker JSON': () => { const value = terminalOperation(); value.metadata.result.stdout.value = Buffer.from('not json').toString('base64'); return value; },
  };
  for (const [name, body] of Object.entries(malformed)) await t.test(name, async () => {
    const f = backend(call => call.init.method === 'POST' ? created() : call.init.method === 'DELETE' ? new Response(null, { status: 202 }) : json(body()), { completionTimeoutMs: 50 });
    const result = await f.service.start(input).done;
    assert.equal(result.status, 'failed'); assert.deepEqual(result.outputs, []); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  });
  const large = backend(call => call.init.method === 'POST' ? created() : call.init.method === 'DELETE' ? new Response(null, { status: 202 }) : new Response('x'.repeat(2_500_001)));
  assert.match((await large.service.start(input).done).error!, /bounded size/);
});

test('provider success still requires successful Python exit and preserves a validated failed capture', async () => {
  const failedCapture = { ...capture, ok: false, error: 'ValueError: fixture Python failure', stderr: 'Fixture traceback' };
  const operation = terminalOperation(failedCapture); operation.metadata.result.state.exit_code = 1;
  const f = backend((_call, index) => index ? json(operation) : created());
  const result = await f.service.start(input).done;
  assert.equal(result.status, 'failed'); assert.match(result.error!, /fixture Python failure/); assert.deepEqual(result.outputs, capture.outputs); assert.equal(result.exitCode, 1);
  const original = terminalOperation();
  const noCost = { ...original, metadata: { result: { ...original.metadata.result, resources: {} } } };
  const missing = backend((_call, index) => index ? json(noCost) : created());
  assert.equal((await missing.service.start(input).done).remote?.rawCost, undefined);
});

test('completion timeout and restart reconciliation cancel known operations without another POST', async () => {
  const deadline = backend(call => call.init.method === 'POST' ? created() : call.init.method === 'DELETE' ? new Response(null, { status: 202 }) : json({ uuid: ID, kind: 'instance', status: 'EXECUTING' }), { completionTimeoutMs: 50 });
  const exceeded = await deadline.service.start(input).done;
  assert.equal(exceeded.status, 'failed'); assert.equal(exceeded.remote?.phase, 'uncertain'); assert.equal(exceeded.remote?.cancellationConfirmed, false);
  assert.equal(deadline.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(deadline.calls.filter(call => call.init.method === 'DELETE').length, 1);
  const states: RemoteExecutionState[] = [];
  const recovery = backend(call => call.init.method === 'DELETE' ? new Response(null, { status: 202 }) : json({ uuid: ID, kind: 'instance', status: 'CANCELLED' }));
  const reconciled = await recovery.service.reconcile(ID, state => states.push(state));
  assert.equal(reconciled.phase, 'terminal'); assert.equal(reconciled.cancellationConfirmed, true);
  assert.deepEqual(recovery.calls.map(call => call.init.method), ['DELETE', 'GET']); assert.equal(states[0].phase, 'cancelling');
  await assert.rejects(recovery.service.reconcile('../../instances'));
  const unknown = backend(() => { throw new Error('Connection unavailable'); });
  const uncertain = await unknown.service.reconcile(ID);
  assert.equal(uncertain.phase, 'uncertain'); assert.equal(uncertain.cancellationConfirmed, false);
});
