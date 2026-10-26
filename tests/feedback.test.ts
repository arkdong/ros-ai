import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { feedbackTitle, publicIssueUrl } from '../src/shared/feedback.js';
import { attachFeedbackRoutes } from '../src/server/feedback.js';
import { CloudAccount } from '../src/server/cloud-account.js';
import type { InferenceConnections } from '../src/server/inference-connections.js';
import { apiErrorHandler } from '../src/server/app.js';

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('a public issue link fills in the form for its kind and never carries an email address', () => {
  assert.equal(feedbackTitle('problem', '  Send does nothing after I sign in\nI expected an answer.'), 'Problem: Send does nothing after I sign in');
  assert.equal(feedbackTitle('idea', `Let me ${'drop a PDF '.repeat(10)}`), 'Idea: Let me drop a PDF drop a PDF drop a PDF drop a PDF drop a PDF drop a PDF…');
  assert.equal(feedbackTitle('question', `Why ${'x'.repeat(80)}`), `Question: Why ${'x'.repeat(68)}…`);
  const url = new URL(publicIssueUrl({ kind: 'question', message: 'Can two people share one canvas?', details: 'ros.ai 0.1.0 · Linux 6.8 x64' }));
  assert.equal(url.origin + url.pathname, 'https://github.com/arkdong/ros-ai/issues/new');
  assert.deepEqual(Object.fromEntries(url.searchParams), { template: 'question.yml', title: 'Question: Can two people share one canvas?', message: 'Can two people share one canvas?', details: 'ros.ai 0.1.0 · Linux 6.8 x64' });
  const long = new URL(publicIssueUrl({ kind: 'problem', message: 'x'.repeat(4000), email: 'me@example.com' } as never));
  assert.equal(long.searchParams.get('message')?.length, 3001);
  assert.equal(long.searchParams.has('email'), false);
});

test('the local feedback route reads only this computer, then passes a note on to ros.ai cloud', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-feedback-'));
  const received: { authorization?: string; body: unknown }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { id: 'note', email: 'me@example.com' } };
  const fakeCloud = express().use(express.json()).post('/v1/feedback', (req, res) => { received.push({ authorization: req.headers.authorization, body: req.body }); res.status(answer.status).json(answer.body); });
  const cloudServer = await listen(fakeCloud);
  const app = express().use(express.json());
  attachFeedbackRoutes(app, new CloudAccount(cloudServer.base, dir, {} as InferenceConnections, 4310));
  app.use(apiErrorHandler);
  const local = await listen(app);
  const send = (body: unknown) => fetch(`${local.base}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const signedOut = await (await fetch(`${local.base}/api/feedback`)).json();
    assert.equal(signedOut.cloud, true);
    assert.equal(signedOut.email, undefined);
    assert.match(signedOut.details, /^ros\.ai \S+.* · Node \d+/u);
    assert.equal(received.length, 0, 'opening the card calls nothing outside this computer');

    writeFileSync(join(dir, 'cloud-account.json'), JSON.stringify({ token: 'session-token-0123456789', email: 'me@example.com', connectionId: 'cloud' }));
    assert.equal((await (await fetch(`${local.base}/api/feedback`)).json()).email, 'me@example.com');
    const response = await send({ kind: 'idea', message: '  Drop a PDF on Ros  ', details: 'ros.ai 0.1.0 · Chrome 141' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { email: 'me@example.com' });
    assert.deepEqual(received.at(-1), { authorization: 'Bearer session-token-0123456789', body: { kind: 'idea', message: 'Drop a PDF on Ros', details: 'ros.ai 0.1.0 · Chrome 141', email: 'me@example.com' } });

    assert.equal((await send({ kind: 'bug', message: 'Hi' })).status, 400);
    assert.equal((await send({ kind: 'idea', message: 'Hi', email: 'not an address' })).status, 400);
    assert.equal(received.length, 1, 'refused notes are not passed on');

    answer = { status: 429, body: { error: { message: 'Too many notes from this address in the last hour.' } } };
    const limited = await send({ kind: 'problem', message: 'Again' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'Too many notes from this address in the last hour.');
  } finally {
    await local.close(); await cloudServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with ros.ai cloud off the card offers GitHub only', async () => {
  const app = express().use(express.json());
  attachFeedbackRoutes(app, new CloudAccount(undefined, tmpdir(), {} as InferenceConnections, 4310));
  app.use(apiErrorHandler);
  const local = await listen(app);
  try {
    assert.equal((await (await fetch(`${local.base}/api/feedback`)).json()).cloud, false);
    const response = await fetch(`${local.base}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'idea', message: 'Hi' }) });
    assert.equal(response.status, 404);
  } finally { await local.close(); }
});
