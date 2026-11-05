import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { Authority } from '../src/server/authority.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { ClaudeAgentService } from '../src/server/claude-agent.js';
import type { AgentEvent } from '../src/shared/agent-runtime.js';

// The real Claude Code, from the Agent SDK ros.ai bundles, against a stand-in for Anthropic's API on this computer.
type Answer = 'answer' | 'credit' | 'expensive';

test('Claude Code’s error results are settled and explained, and a thread whose session is gone starts a new one', { timeout: 240_000 }, async t => {
  const answers: Answer[] = [];
  const api = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const answer = answers.shift() ?? 'answer';
      if (answer === 'credit') return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The notes agree.' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      // A reply this long costs far more than the turn's budget.
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: answer === 'expensive' ? 2_000_000 : 5 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>(done => api.listen(0, '127.0.0.1', done));
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const directory = mkdtempSync(join(tmpdir(), 'ros-claude-results-')), store = new Store(directory), execution = new ExecutionService(store, { includeSetupUsage: false });
  const claude = new ClaudeAgentService(store, execution, { authority: new Authority(store) } as unknown as ExperimentService, directory);
  t.after(async () => {
    await claude.shutdown(); await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true });
    await new Promise<void>(done => { api.closeAllConnections(); api.close(() => done()); });
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const project = store.createProject('Claude results');
  const turn = (message: string, events: AgentEvent[] = []) => claude.execute({ projectId: project.id, threadId: 'thread-1', turnId: randomUUID(), message, nodeIds: [], artifactIds: [], signal: new AbortController().signal, billing: 'api-key', onEvent: event => events.push(event) });
  const session = () => store.record<{ sessionId: string }>('claude-session', 'thread-1');
  const usage = () => store.listUsage().filter(row => row.provider === 'claude').at(-1)!;

  assert.equal((await turn('Do the notes agree?')).reply, 'The notes agree.');
  const first = session()!.sessionId;

  // Claude Code deletes old sessions: the thread starts a new one instead of failing every turn from now on.
  store.saveRecord('claude-session', 'thread-1', project.id, { ...session()!, sessionId: randomUUID() });
  const events: AgentEvent[] = [];
  assert.equal((await turn('And now?', events)).reply, 'The notes agree.');
  assert.ok(events.some(event => /no longer had this thread’s earlier session/u.test(event.message)));
  assert.notEqual(session()!.sessionId, first);

  // An API error: the person reads what Claude Code wrote, and the reservation is settled at what was spent.
  answers.push('credit');
  await assert.rejects(turn('Once more'), /Claude Code stopped with an error: .*credit balance is too low/iu);
  assert.equal(usage().status, 'settled');

  // The turn's budget: settled at the cost reported, and the session is kept so "continue" picks up the work.
  answers.push('expensive');
  await assert.rejects(turn('A long one'), /budget before finishing/u);
  assert.equal(usage().status, 'settled');
  assert.ok((usage().estimatedUsd ?? 0) > 1);
  const attempts = store.records<{ sessionId?: string; status: string }>('claude-attempt', project.id);
  assert.equal(session()!.sessionId, attempts.find(attempt => attempt.status === 'failed' && attempt.sessionId === session()!.sessionId)?.sessionId);
});
