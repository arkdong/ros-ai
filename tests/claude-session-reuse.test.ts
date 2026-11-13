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
import { ClaudeAgentService, CONTINUE_MAX_TOKENS, RESUME_MAX_IDLE_MS, RESUME_MAX_TOKENS, staleSession } from '../src/server/claude-agent.js';
import type { AgentEvent } from '../src/shared/agent-runtime.js';

test('a thread’s Claude Code session is picked up only while its cache is warm and it is short', () => {
  const at = Date.parse('2026-11-13T12:00:00Z'), ago = (ms: number) => new Date(at - ms).toISOString();
  assert.equal(staleSession({ at: ago(10 * 60_000), tokens: 30_000, ended: true }, at), null);
  assert.equal(staleSession({ at: ago(RESUME_MAX_IDLE_MS + 1000), tokens: 30_000, ended: true }, at), 'idle');
  assert.equal(staleSession({ at: ago(60_000), tokens: RESUME_MAX_TOKENS + 1, ended: true }, at), 'long');
  // "continue" after a stopped turn needs what that turn read, so a longer session is still picked up.
  assert.equal(staleSession({ at: ago(60_000), tokens: RESUME_MAX_TOKENS + 1, ended: false }, at), null);
  assert.equal(staleSession({ at: ago(60_000), tokens: CONTINUE_MAX_TOKENS + 1, ended: false }, at), 'long');
  // A session saved before ros.ai measured it goes by time alone.
  assert.equal(staleSession({ at: ago(60_000) }, at), null);
});

// The real Claude Code, from the Agent SDK ros.ai bundles, against a stand-in for Anthropic's API on this computer.
test('after an hour, or once long, a thread starts a new Claude Code session that is told the conversation so far', { timeout: 240_000 }, async t => {
  /** The messages of each request of a turn's own loop. */
  const sent: string[] = [];
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { tools?: { name: string }[]; messages?: unknown };
      if (body.tools?.some(tool => tool.name.startsWith('mcp__ros__'))) sent.push(JSON.stringify(body.messages ?? []));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 1_000, output_tokens: 1 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The notes agree.' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>(done => api.listen(0, '127.0.0.1', done));
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const directory = mkdtempSync(join(tmpdir(), 'ros-claude-reuse-')), store = new Store(directory), execution = new ExecutionService(store, { includeSetupUsage: false });
  const claude = new ClaudeAgentService(store, execution, { authority: new Authority(store) } as unknown as ExperimentService, directory);
  t.after(async () => {
    await claude.shutdown(); await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true });
    await new Promise<void>(done => { api.closeAllConnections(); api.close(() => done()); });
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const project = store.createProject('Session reuse');
  type Saved = { sessionId: string; at: string; tokens?: number; ended?: boolean };
  const session = () => store.record<Saved>('claude-session', 'thread-1')!;
  const change = (patch: Partial<Saved>) => store.saveRecord('claude-session', 'thread-1', project.id, { ...session(), ...patch });
  // How many times a turn asked for the conversation in writing: only a new session asks.
  let told = 0;
  const turn = async (message: string) => {
    const events: AgentEvent[] = [], before = told;
    await claude.execute({ projectId: project.id, threadId: 'thread-1', turnId: randomUUID(), message, nodeIds: [], artifactIds: [], signal: new AbortController().signal, billing: 'api-key', earlier: () => { told++; return 'Earlier in this conversation: the researcher asked about the notes.'; }, onEvent: event => events.push(event) });
    return { events, said: sent.at(-1)!, told: told > before };
  };

  const first = await turn('Do the notes agree?');
  assert.equal(session().tokens, 25_011, 'the conversation’s length at its last request, as the request began');
  assert.equal(session().ended, true);
  const usage = first.events.find(event => event.type === 'usage')!;
  assert.match(usage.message, /1 request to Claude, the conversation at about 25k tokens\.$/u);

  // Soon after, the thread goes on in the same session, which holds the first message itself.
  const id = session().sessionId, soon = await turn('And the figures?');
  assert.ok(soon.said.includes('Do the notes agree?'));
  assert.equal(soon.told, false);
  assert.equal(session().sessionId, id);

  // More than an hour later the cache is gone: a new session, told the conversation in writing.
  change({ at: new Date(Date.now() - RESUME_MAX_IDLE_MS - 60_000).toISOString() });
  const later = await turn('What changed?');
  assert.ok(!later.said.includes('Do the notes agree?'));
  assert.ok(later.told && later.said.includes('Earlier in this conversation'));
  assert.ok(later.events.some(event => /More than an hour has passed/u.test(event.message)));
  assert.notEqual(session().sessionId, id);

  // A long session is left behind after a finished turn, but "continue" after a stopped one picks it up.
  const fresh = session().sessionId;
  change({ tokens: RESUME_MAX_TOKENS + 5_000, ended: false });
  const going = await turn('continue');
  assert.ok(!going.told && going.said.includes('What changed?'));
  assert.equal(session().sessionId, fresh);
  change({ tokens: RESUME_MAX_TOKENS + 5_000, ended: true });
  const long = await turn('Next question');
  assert.ok(long.told && !long.said.includes('What changed?'));
  assert.ok(long.events.some(event => /reached about 65k tokens, so it starts a new one/u.test(event.message)));
});
