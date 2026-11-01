import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { ExperimentService } from '../src/server/experiments.js';
import { AssistantService } from '../src/server/assistant.js';
import { SandboxBudget } from '../src/server/sandbox-budget.js';
import { TurnFileService, lineEdits, unifiedPatch } from '../src/server/turn-files.js';
import type { ModelAdapter, ModelRequest, ModelResponse, SearchAdapter } from '../src/server/providers.js';
import type { ExecutionBackend, SandboxCapabilities } from '../src/server/sandbox.js';
import type { AgentExecuteRequest, AgentRuntime } from '../src/shared/agent-runtime.js';

// Offline doubles: no model, search, agent or execution runtime is called.
const response = (content: unknown): ModelResponse => ({ content: JSON.stringify(content), model: 'offline-fixture', modelVersion: null, usage: { inputTokens: 20, outputTokens: 30 }, metadata: { offlineFixture: true } });
const reply = (text: string) => ({ reply: text, question: null, references: [], memory: [], tools: [] });
type Answer = unknown | (() => unknown | Promise<unknown>);
const caps: SandboxCapabilities = { available: true, backend: 'docker-python', policy: 'offline-fixture', runtime: 'offline fixture', workerHash: 'fixture-worker', imageId: 'fixture-image', libraries: {}, enforcement: ['No actual execution'], limitations: ['Offline fixture only'], timeoutMs: 30000, maxMemoryMb: 512, maxOutputBytes: 1000000 };

function fixture(answers: Answer[] = [], agentReplies: (() => Promise<string>)[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-pix-fixture-')), store = new Store(join(dir, 'data')), project = store.createProject('PiX ideas fixture');
  const requests: ModelRequest[] = [], agentRequests: AgentExecuteRequest[] = [];
  const model: ModelAdapter = {
    provider: 'nebius', model: 'offline-fixture', configured: true,
    async prepare() { return { id: this.model, contextTokens: 100000, inputUsdPerToken: 0.0000001, outputUsdPerToken: 0.0000003, capabilities: { structuredOutput: false, toolCalling: false, cancellation: 'abort-request', modelVersion: false }, metadata: {} }; },
    async complete(request, signal) {
      requests.push(structuredClone(request));
      const answer = answers.shift();
      if (answer === undefined) throw new Error('Offline fixture exhausted.');
      const value = typeof answer === 'function' ? await (answer as () => unknown)() : answer;
      if (signal.aborted) throw new Error('aborted');
      return response(value);
    },
  } as ModelAdapter;
  const search: SearchAdapter = { configured: false, async search() { throw new Error('No search in this fixture.'); } } as unknown as SearchAdapter;
  const runtime: ExecutionBackend = { capabilities: () => structuredClone(caps), start() { throw new Error('No execution.'); } };
  const agent: AgentRuntime = {
    async status() { return { available: true } as never; },
    async execute(request) { agentRequests.push(request); const next = agentReplies.shift(); const text = next ? await next() : 'AGENT_REPLY'; if (request.signal.aborted) throw new Error('Codex was stopped.'); return { reply: text, sessionId: 's', actions: [], requestId: 'r' }; },
    async shutdown() {},
  };
  const execution = new ExecutionService(store, { model, search, limits: { nebius: 5, tavily: 10 }, includeSetupUsage: false });
  const experiments = new ExperimentService(store, { sandbox: runtime, nebiusSandbox: runtime, sandboxBudget: new SandboxBudget(store, {}) });
  experiments.authority.configure(project.id, { mode: 'ask' });
  const assistant = new AssistantService(store, execution, experiments, agent);
  return { dir, store, project, assistant, requests, agentRequests, async close() { await assistant.shutdown(); await execution.shutdown(); await experiments.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } throw new Error('Fixture timed out.'); }
const settled = (f: ReturnType<typeof fixture>) => until(() => { const state = f.assistant.state(f.project.id); return !state.turns.some(turn => turn.status === 'running') && !state.queued.some(item => !item.paused); });
const gate = () => { let open!: (value: unknown) => void; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };

test('line edits and unified patches', () => {
  const edits = lineEdits(['a', 'b', 'c', 'd', 'e'], ['a', 'B', 'c', 'e', 'f'])!;
  assert.deepEqual(edits.filter(edit => edit.op !== ' ').map(edit => edit.op + edit.line), ['-b', '+B', '-d', '+f']);
  const patch = unifiedPatch('x.txt', 'modified', edits);
  assert.match(patch, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n@@ -1,5 \+1,5 @@/);
  assert.deepEqual(lineEdits([], ['one'])!.map(edit => edit.op), ['+']);
  assert.match(unifiedPatch('n.md', 'added', lineEdits([], ['one'])!), /@@ -0,0 \+1,1 @@\n\+one/);
});

test('a turn records the files that changed in the project folder, with diffs', async () => {
  const f = fixture();
  try {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ros-pix-folder-'))), info = statSync(root);
    f.store.saveRecord('project-folder', f.project.id, f.project.id, { path: root, device: info.dev, inode: info.ino });
    writeFileSync(join(root, 'notes.md'), 'one\ntwo\nthree\n'); writeFileSync(join(root, 'old.txt'), 'gone soon\n');
    writeFileSync(join(root, 'same.txt'), 'unchanged\n'); writeFileSync(join(root, 'picture.bin'), Buffer.from([0, 1, 2]));
    const files = new TurnFileService(f.store);
    await files.begin(f.project.id, 'turn-1');
    writeFileSync(join(root, 'notes.md'), 'one\nTWO\nthree\nfour\n'); unlinkSync(join(root, 'old.txt'));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'new.py'), 'print(1)\n'); writeFileSync(join(root, 'picture.bin'), Buffer.from([0, 9, 2]));
    mkdirSync(join(root, '.ros-ai')); writeFileSync(join(root, '.ros-ai', 'cache.json'), '{}');
    mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'x.js'), '1');
    const result = (await files.finish('turn-1'))!;
    assert.deepEqual(result.changed.map(file => [file.path, file.status, file.added, file.removed, Boolean(file.binary)]), [
      ['notes.md', 'modified', 2, 1, false], ['old.txt', 'deleted', 0, 1, false], ['picture.bin', 'modified', 0, 0, true], ['src/new.py', 'added', 1, 0, false],
    ]);
    assert.match(files.diff(f.project.id, 'turn-1', 'notes.md').patch, /-two\n\+TWO\n three\n\+four/);
    assert.throws(() => files.diff(f.project.id, 'turn-1', 'picture.bin'), /No saved diff/);
    assert.throws(() => files.reveal(f.project.id, 'turn-1', '../outside.txt', result.changed), /did not change that file/);
    assert.equal(files.has('turn-1'), false);
    rmSync(root, { recursive: true, force: true });
  } finally { await f.close(); }
});

test('a message sent while its thread works waits, then goes on its own', async () => {
  const first = gate();
  const f = fixture([() => first.promise, reply('SECOND_ANSWER')]);
  try {
    const one = f.assistant.start(f.project.id, { message: 'First question' });
    await until(() => f.requests.length === 1);
    const waiting = f.assistant.start(f.project.id, { message: 'Second question', threadId: one.threadId });
    assert.equal(waiting.threadId, one.threadId);
    assert.deepEqual(waiting.queued.map(item => [item.message, item.threadId]), [['Second question', one.threadId]]);
    first.open(reply('FIRST_ANSWER'));
    await settled(f);
    const turns = f.assistant.state(f.project.id).turns.filter(turn => turn.threadId === one.threadId);
    assert.deepEqual(turns.map(turn => [turn.userMessage, turn.status, turn.reply]), [['First question', 'completed', 'FIRST_ANSWER'], ['Second question', 'completed', 'SECOND_ANSWER']]);
    // The second turn read the first answer as its own thread's history.
    assert.match(JSON.stringify(f.requests[1].messages), /FIRST_ANSWER/);
    assert.equal(f.assistant.state(f.project.id).queued.length, 0);
  } finally { await f.close(); }
});

test('Send now stops the working turn and sends the waiting message next', async () => {
  const first = gate();
  const f = fixture([() => first.promise, reply('LATER_ANSWER'), reply('NOW_ANSWER')]);
  try {
    const one = f.assistant.start(f.project.id, { message: 'Long question' });
    await until(() => f.requests.length === 1);
    f.assistant.start(f.project.id, { message: 'Later', threadId: one.threadId });
    const now = f.assistant.start(f.project.id, { message: 'Do this instead', threadId: one.threadId, when: 'now' });
    // "now" goes ahead of the older waiting message.
    assert.deepEqual(now.queued.map(item => item.message), ['Do this instead', 'Later']);
    first.open(reply('TOO_LATE'));
    await settled(f);
    const turns = f.assistant.state(f.project.id).turns.filter(turn => turn.threadId === one.threadId);
    assert.deepEqual(turns.map(turn => [turn.userMessage, turn.status]), [['Long question', 'cancelled'], ['Do this instead', 'completed'], ['Later', 'completed']]);
    assert.match(turns[0].error!, /send your next message/);
  } finally { await f.close(); }
});

test('Stop leaves waiting messages for the person; Send now sends one', async () => {
  const first = gate();
  const f = fixture([() => first.promise, reply('AFTER_STOP')]);
  try {
    const one = f.assistant.start(f.project.id, { message: 'Question' });
    await until(() => f.requests.length === 1);
    const waiting = f.assistant.start(f.project.id, { message: 'Next', threadId: one.threadId });
    f.assistant.cancel(f.project.id, one.activeTurnId!);
    first.open(reply('IGNORED'));
    await until(() => !f.assistant.state(f.project.id).turns.some(turn => turn.status === 'running'));
    await delay(30);
    assert.equal(f.assistant.state(f.project.id).queued[0].paused, true);
    assert.equal(f.requests.length, 1);
    f.assistant.sendQueuedNow(f.project.id, waiting.queued[0].id);
    await settled(f);
    assert.equal(f.assistant.state(f.project.id).turns.at(-1)!.reply, 'AFTER_STOP');
  } finally { await f.close(); }
});

test('Branch from here copies the conversation up to a turn into a new thread', async () => {
  const f = fixture([reply('ANSWER_ONE'), reply('ANSWER_TWO'), reply('BRANCH_ANSWER')]);
  try {
    const one = f.assistant.start(f.project.id, { message: 'Question one' });
    await settled(f);
    f.assistant.start(f.project.id, { message: 'Question two', threadId: one.threadId });
    await settled(f);
    const original = f.assistant.state(f.project.id).turns.filter(turn => turn.threadId === one.threadId);
    const branched = f.assistant.branch(f.project.id, original[0].id);
    assert.ok(branched.threadId && branched.threadId !== one.threadId);
    const thread = branched.threads.find(item => item.id === branched.threadId)!;
    assert.deepEqual(thread.branchedFrom, { threadId: one.threadId, turnId: original[0].id, title: 'Question one' });
    const copies = branched.turns.filter(turn => turn.threadId === branched.threadId);
    assert.deepEqual(copies.map(turn => [turn.userMessage, turn.reply, turn.copiedFrom, turn.actions.length]), [['Question one', 'ANSWER_ONE', original[0].id, 0]]);
    // The original thread is unchanged.
    assert.equal(branched.turns.filter(turn => turn.threadId === one.threadId).length, 2);
    f.assistant.start(f.project.id, { message: 'Go another way', threadId: branched.threadId });
    await settled(f);
    const history = JSON.stringify(f.requests[2].messages);
    assert.match(history, /ANSWER_ONE/); assert.doesNotMatch(history, /ANSWER_TWO|Question two/);
  } finally { await f.close(); }
});

test('an agent in a branch gets the earlier conversation written out once', async () => {
  const f = fixture([reply('MODEL_ANSWER')]);
  try {
    const one = f.assistant.start(f.project.id, { message: 'Ask the model first' });
    await settled(f);
    const branched = f.assistant.branch(f.project.id, f.assistant.state(f.project.id).turns[0].id);
    f.assistant.setBackend(f.project.id, { backend: 'codex' });
    f.assistant.start(f.project.id, { message: 'Now ask Codex', threadId: branched.threadId });
    await settled(f);
    assert.match(f.agentRequests[0].preferences ?? '', /Earlier in this conversation[\s\S]*Ask the model first[\s\S]*MODEL_ANSWER/);
    assert.equal(f.agentRequests[0].message, 'Now ask Codex');
    f.assistant.start(f.project.id, { message: 'And again', threadId: branched.threadId });
    await settled(f);
    // The agent's own session holds the conversation now.
    assert.doesNotMatch(f.agentRequests[1].preferences ?? '', /Earlier in this conversation/);
    assert.ok(one.threadId);
  } finally { await f.close(); }
});
