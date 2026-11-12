import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExperimentService } from '../src/server/experiments.js';
import type { AgentEvent } from '../src/shared/agent-runtime.js';

// The real Claude Code, from the Agent SDK ros.ai bundles, against a stand-in for Anthropic's API on this computer, in
// a turn that has only twenty seconds. The stand-in is a model that never stops looking things up, as a high effort
// level makes one. The limit is read when the agent's code loads, so it is set before that.
process.env.ROS_AGENT_TURN_SECONDS = '20';
const { Store } = await import('../src/server/store.js');
const { ExecutionService } = await import('../src/server/execution.js');
const { Authority } = await import('../src/server/authority.js');
const { ClaudeAgentService } = await import('../src/server/claude-agent.js');

test('a Claude Code turn that runs out of time shows its thinking, is told at half time and near the end, loses its last lookups, and is kept for "continue"', { timeout: 180_000 }, async t => {
  /** What Claude Code sent with each request of the turn's own loop, and whether the model has been told to stop. */
  const sent: string[] = [];
  let finish = false;
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}') as { tools?: { name: string }[]; messages?: unknown };
      // Claude Code also asks small questions of its own (a title, say); the turn's loop is the one with ros.ai's tools.
      const main = Boolean(body.tools?.some(tool => tool.name.startsWith('mcp__ros__'))), said = JSON.stringify(body.messages ?? []), step = main ? sent.push(said) - 1 : -1;
      let open = true; res.on('close', () => { open = false; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object) => { if (open) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
      const block = (index: number, start: object, delta: object) => { send('content_block_start', { index, content_block: start }); send('content_block_delta', { index, delta }); send('content_block_stop', { index }); };
      send('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      if (!main || finish) {
        block(0, { type: 'text', text: '' }, { type: 'text_delta', text: main ? 'The halls are compared.' : 'ok' });
        send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      } else {
        // The first step thinks slowly, at first without showing it; the others take under half a second.
        send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 400 } });
        if (step === 0) await delay(1300);
        send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: `Step ${step}: still reading the sources. ` } });
        await delay(step === 0 ? 1300 : 350);
        send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'stand-in' } });
        send('content_block_stop', { index: 0 });
        block(1, { type: 'text', text: '' }, { type: 'text_delta', text: `Step ${step}.` });
        // Told that little time is left, it asks for one more lookup anyway. Reading pages before any search reaches no network.
        const late = said.includes('[ros.ai] This turn has about');
        block(2, { type: 'tool_use', id: `toolu_${step}`, name: late ? 'mcp__ros__ros_read_pages' : 'mcp__ros__ros_read_canvas', input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify(late ? { pages: [{ resultNodeId: 'direction-1', n: 1 }] } : {}) });
        send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
      }
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise<void>(done => api.listen(0, '127.0.0.1', done));
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const directory = mkdtempSync(join(tmpdir(), 'ros-claude-clock-')), store = new Store(directory), execution = new ExecutionService(store, { includeSetupUsage: false });
  const claude = new ClaudeAgentService(store, execution, { authority: new Authority(store) } as unknown as ExperimentService, directory);
  t.after(async () => {
    await claude.shutdown(); await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true });
    await new Promise<void>(done => { api.closeAllConnections(); api.close(() => done()); });
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const project = store.createProject('Halls'), events: AgentEvent[] = [];
  const turn = (message: string) => claude.execute({ projectId: project.id, threadId: 'thread-1', turnId: randomUUID(), message, nodeIds: [], artifactIds: [], signal: new AbortController().signal, billing: 'api-key', onEvent: event => events.push(event) });
  const session = () => store.record<{ sessionId: string; state: string }>('claude-session', 'thread-1')!;
  const shown = (pattern: RegExp, type?: AgentEvent['type']) => events.filter(event => (!type || event.type === type) && pattern.test(event.message)).length;

  const started = Date.now();
  await assert.rejects(turn('Compare the halls.'), /Claude Code reached this turn’s limit of 1 minute and was stopped\. What it did so far is kept: send "continue" to carry on\./u);
  assert.ok(Date.now() - started >= 19_000, 'the turn ran to its limit');

  // While it thought, the person saw the count of thinking that is not shown, then the thinking itself.
  assert.ok(shown(/^Thinking… [\d,]+ tokens so far$/u, 'status') > 0, 'the count of hidden thinking');
  assert.ok(shown(/^Thinking: Step 0: still reading the sources\.$/u, 'status') > 0, 'the thinking in its own words');
  // Between its steps Claude Code heard, once each, that half of the time was gone and that little was left.
  assert.equal(shown(/^Half of this turn’s time is used; ros\.ai told the agent/u), 1);
  assert.equal(shown(/^This turn has about 1 minute left; ros\.ai told the agent to finish\.$/u), 1);
  assert.ok(sent.some(said => said.includes('[ros.ai] Half of this turn\'s time is used')), 'the half-time note reached the model');
  assert.ok(sent.some(said => said.includes('[ros.ai] This turn has about')), 'the note near the end reached the model');
  // In its last seconds a new lookup was turned away, so what was left could go to writing.
  assert.ok(shown(/^This turn’s time is nearly up, so ros\.ai did not start this lookup\./u, 'tool') > 0, 'a late lookup was turned away');
  // Claude Code ended the request it was in, reported what the turn cost and kept its session.
  assert.equal(store.listUsage().filter(row => row.provider === 'claude').at(-1)!.status, 'settled');
  const kept = session();
  assert.equal(kept.state, 'ready');

  // "continue" goes on in that session, which still holds the first turn's steps.
  finish = true;
  const next = sent.length;
  assert.equal((await turn('continue')).reply, 'The halls are compared.');
  assert.equal(session().sessionId, kept.sessionId);
  assert.ok(sent[next]!.includes('Step 0.'), 'the session still holds the work so far');
});
