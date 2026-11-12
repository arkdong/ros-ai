import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { Authority } from '../src/server/authority.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AssistantService } from '../src/server/assistant.js';
import { AgentWorkspaceTools, toolFailure } from '../src/server/agent-tools.js';
import { statusLine, thinkingLine, turnClock } from '../src/server/agent-turn.js';
import { CODEX_SCHEMA_LIMIT, codexToolSchema } from '../src/server/codex-tool-schema.js';
import { codexOutside, codexWebStep } from '../src/server/codex-agent.js';
import type { AgentEvent, AgentExecuteRequest, AgentRuntime } from '../src/shared/agent-runtime.js';

// A long agent turn, as a high effort level makes it: what the person sees while it runs, what the agent hears about
// the time, and what Codex is given to work with.

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'ros-agent-turn-')), store = new Store(join(directory, 'store')), execution = new ExecutionService(store, { includeSetupUsage: false });
  const project = store.createProject('Badminton halls');
  store.mutate(project.id, [{ type: 'addNode', node: { id: 'note-1', title: 'Halls', description: 'Two halls', kind: 'topic', blockType: 'note', x: 0, y: 0 } }], 'A note');
  new Authority(store).configure(project.id, { mode: 'full' });
  const experiments = { authority: { policy: () => ({ stopped: false, mode: 'full' }) } } as unknown as ExperimentService;
  const tools = (agent: 'claude' | 'codex' = 'codex') => new AgentWorkspaceTools(store, execution, experiments, { projectId: project.id, nodeIds: [], artifactIds: [] }, `turn-${Math.random()}`, agent);
  return { store, execution, experiments, project, tools, async close() { await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test('a turn’s clock tells the agent once at half time and once near the end, and turns lookups away in the last minutes', () => {
  const after = (elapsed: number, seconds = 1800) => turnClock(seconds, Date.now() - elapsed * 1000);
  const early = after(60);
  assert.equal(early.note(), null);
  assert.equal(early.refusal('ros_fan_out_search'), null);

  const half = after(901);
  assert.match(half.note()!.tell, /^\[ros\.ai\] Half of this turn's time is used \(15 minutes of 30 minutes\)\. .*put what you have there now/u);
  assert.equal(half.note(), null, 'said once');

  // A turn first asked this late hears only that little is left.
  const late = after(1500), note = late.note()!;
  assert.match(note.tell, /This turn has about 5 minutes left\. Stop gathering/u);
  assert.match(note.shown, /about 5 minutes left; ros\.ai told the agent to finish/u);
  assert.equal(late.note(), null);
  assert.equal(late.refusal('ros_fan_out_search'), null, 'five minutes before the end a search still runs');

  // The last tenth of a turn, three minutes at most: no new lookup, but everything that writes still runs.
  const closing = after(1700);
  for (const lookup of ['ros_fan_out_search', 'ros_read_pages', 'ros_check_claims', 'ros_search_posts', 'ros_browser', 'WebSearch', 'WebFetch']) assert.match(closing.refusal(lookup)!, /time is nearly up.*Write what you have to the map/u, lookup);
  for (const writer of ['ros_propose_canvas', 'ros_write_findings', 'ros_propose_report', 'ros_read_canvas']) assert.equal(closing.refusal(writer), null, writer);
  assert.equal(after(535, 600).refusal('WebSearch'), null);
  assert.match(after(545, 600).refusal('WebSearch')!, /nearly up/u);
});

test('the status line says what is new at most once in its interval, and a model’s thinking becomes one line', async () => {
  const said: string[] = [], line = statusLine(event => { assert.equal(event.type, 'status'); said.push(event.message); }, 40);
  line.say('Thinking…');
  line.say('Thinking: first'); line.say('Thinking: second');
  assert.deepEqual(said, ['Thinking…'], 'the first words go out at once, the rest wait');
  await delay(80);
  assert.deepEqual(said, ['Thinking…', 'Thinking: second'], 'only the newest of what waited is said');
  await delay(60); line.say('Thinking: second');
  assert.equal(said.length, 2, 'the same words are not said twice');
  // A recorded step shows instead: what waited is dropped, and the same words may be said again after it.
  await delay(60); line.say('Writing…'); line.say('Preparing ros_propose_canvas…'); line.clear();
  await delay(80);
  assert.deepEqual(said.slice(2), ['Writing…']);
  line.say('Writing…');
  await delay(80);
  assert.deepEqual(said.slice(2), ['Writing…', 'Writing…']);

  // Codex's summaries carry a bold headline for each part; the newest is the line.
  assert.equal(thinkingLine('**Planning the lookup**\n\nI will read the canvas first.\n\n**Comparing the halls**\n\nSporthallen Zuid is'), 'Thinking: Comparing the halls');
  // Plain thinking gives its last finished sentence, or its first words while the first sentence is still coming.
  assert.equal(thinkingLine('The map holds one note. Now I am weigh'), 'Thinking: The map holds one note.');
  assert.equal(thinkingLine('Looking at the'), 'Thinking: Looking at the');
  assert.ok(thinkingLine(`${'A very long thought that goes on and on '.repeat(10)}.`).length <= 151);
  // Thinking that is not shown has only its running token count.
  assert.equal(thinkingLine(''), 'Thinking…');
  assert.equal(thinkingLine('', 40), 'Thinking…');
  assert.equal(thinkingLine('', 2449), 'Thinking… 2,400 tokens so far');
});

test('Codex is given every ros.ai tool whole: each input schema stays under Codex’s limit, and the canvas tool names its operations and fields', async () => {
  const f = workspace();
  const stubs = { notion: AgentWorkspaceTools.notion, skills: AgentWorkspaceTools.skills, posts: AgentWorkspaceTools.posts, browser: AgentWorkspaceTools.browser, apps: AgentWorkspaceTools.apps, appFrames: AgentWorkspaceTools.appFrames };
  try {
    // Every tool a turn can offer: Notion, skills, posts and the browser on.
    AgentWorkspaceTools.notion = { configured: true } as never; AgentWorkspaceTools.skills = { any: () => true } as never;
    AgentWorkspaceTools.posts = {} as never; AgentWorkspaceTools.browser = { offered: () => true, engine: () => 'chromium' } as never;
    const drive = { connected: () => ['google-drive'], agentApps: () => [{ name: 'google-drive', label: 'Google Drive', app: 'google-drive' }] };
    // The canvas tool has four forms: with and without Google Drive connected, with and without Apps on for agents.
    for (const [name, apps, appsOn] of [['plain', undefined, false], ['Google Drive', drive, false], ['Apps', undefined, true], ['Google Drive and Apps', drive, true]] as const) {
      AgentWorkspaceTools.apps = apps as never; AgentWorkspaceTools.appFrames = { agentsOn: () => appsOn } as never;
      const definitions = f.tools().definitions;
      assert.ok(definitions.length >= 20, name);
      for (const tool of definitions) assert.ok(bytes(codexToolSchema(tool.inputSchema)) <= CODEX_SCHEMA_LIMIT, `${tool.name} (${name}) is ${bytes(codexToolSchema(tool.inputSchema))} bytes`);
      const canvas = definitions.find(tool => tool.name === 'ros_propose_canvas')!, shown = JSON.stringify(codexToolSchema(canvas.inputSchema));
      // As ros.ai writes it the schema is over the limit, where Codex emptied every operation.
      assert.ok(bytes(canvas.inputSchema) > CODEX_SCHEMA_LIMIT, name);
      for (const word of ['addNode', 'updateNode', 'removeNode', 'addConnection', 'removeConnection', '"title"', '"description"', '"blockType"', '"parentId"', '"rationale"']) assert.ok(shown.includes(word), `${word} (${name})`);
      // An update's patch repeats a new block's fields, so it names them instead of spelling them out again.
      assert.match(shown, /Any of the fields \\"node\\" takes, with the same types/u, name);
    }
    // A schema is only cut down to what Codex keeps: a small one keeps its fields and their descriptions.
    assert.deepEqual(codexToolSchema({ type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 400, description: 'What to look for.' }, kind: { const: 'page' } }, required: ['query'], additionalProperties: false, $schema: 'x' }),
      { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' }, kind: { enum: ['page'] } }, required: ['query'], additionalProperties: false });
  } finally { Object.assign(AgentWorkspaceTools, stubs); await f.close(); }
});

test('an agent whose change is refused is told why, and goes on after the person edits the canvas mid-turn', async () => {
  const f = workspace();
  try {
    const tools = f.tools(), note = (id: string) => ({ summary: 'Add a note', rationale: 'The researcher asked.', operations: [{ type: 'addNode', node: { id, title: 'Halls compared', description: 'Zuid has 12 courts.', kind: 'topic', blockType: 'note', x: 400, y: 0 } }] });
    // Arguments that do not pass: which ones and why, rather than a bare refusal.
    const bad = toolFailure(await tools.call('ros_propose_canvas', { summary: 'x' }).catch((error: unknown) => error));
    assert.match(bad, /^The arguments did not pass ros\.ai's checks; nothing was changed\./u);
    assert.match(bad, /rationale/u); assert.match(bad, /operations/u);
    // ros.ai's own reason is passed on as it is; anything else stays private.
    assert.match(toolFailure(await tools.call('ros_propose_canvas', { summary: 'x', rationale: 'y', operations: [{ type: 'updateNode', id: 'no-such-block', patch: { title: 'Renamed' } }] }).catch((error: unknown) => error)), /no block no-such-block/u);
    assert.equal(toolFailure(new Error('/Users/someone/private/path')), 'ros.ai could not complete this call; nothing was changed.');

    await tools.call('ros_read_canvas', {});
    f.store.mutate(f.project.id, [{ type: 'updateNode', id: 'note-1', patch: { title: 'Halls (edited by the person)' } }], 'The person edits');
    // The change was made against a canvas that has moved on: refused, with the way out.
    await assert.rejects(tools.call('ros_propose_canvas', note('note-2')), /canvas changed while you were working.*Read it again with ros_read_canvas/u);
    await assert.rejects(tools.call('ros_propose_canvas', note('note-2')), /canvas changed/u, 'and refused until the agent has read it again');
    await tools.call('ros_read_canvas', {});
    await tools.call('ros_propose_canvas', note('note-2'));
    assert.deepEqual(f.store.getProject(f.project.id).canvas.nodes.map(node => node.title), ['Halls (edited by the person)', 'Halls compared']);
  } finally { await f.close(); }
});

test('Codex listing its own empty resources or having a command declined does not end the turn; a real outside tool does', () => {
  assert.equal(codexOutside({ type: 'mcpToolCall', server: 'codex', tool: 'list_mcp_resources', status: 'completed' }), false);
  assert.equal(codexOutside({ type: 'mcpToolCall', server: 'github', tool: 'create_issue', status: 'completed' }), true);
  assert.equal(codexOutside({ type: 'commandExecution', status: 'declined' }), false);
  assert.equal(codexOutside({ type: 'fileChange', status: 'declined' }), false);
  for (const status of ['inProgress', 'completed', 'failed']) { assert.equal(codexOutside({ type: 'commandExecution', status }), true, status); assert.equal(codexOutside({ type: 'fileChange', status }), true, status); }
  assert.equal(codexOutside({ type: 'imageGeneration' }), true);
  assert.equal(codexOutside({ type: 'collabAgentToolCall' }), true);
  for (const type of ['webSearch', 'reasoning', 'agentMessage', 'dynamicToolCall', 'contextCompaction']) assert.equal(codexOutside({ type }), false, type);

  // What Codex's own web search did, in the person's words.
  assert.equal(codexWebStep({ type: 'webSearch', query: 'badminton halls', action: { type: 'search', query: 'badminton halls', queries: ['badminton halls', 'sporthal amsterdam', 'courts'] } }), 'Codex searched the web for “badminton halls” and 2 more.');
  assert.equal(codexWebStep({ type: 'webSearch', action: { type: 'openPage', url: 'https://example.org/halls' } }), 'Codex read https://example.org/halls.');
  assert.equal(codexWebStep({ type: 'webSearch', action: { type: 'findInPage', pattern: 'courts', url: 'https://example.org/halls' } }), 'Codex looked for “courts” in https://example.org/halls.');
  assert.equal(codexWebStep({ type: 'webSearch', query: '', action: { type: 'other' } }), 'Codex searched the web.');
});

test('what an agent is doing shows with its running turn and is never kept with its steps, and a new session is handed the earlier conversation once', async () => {
  const f = workspace();
  const requests: AgentExecuteRequest[] = [], handed: (string | undefined)[] = [];
  let gate: (() => void) | undefined;
  const hold = () => new Promise<void>(resolve => { gate = resolve; });
  const at = () => new Date().toISOString(), say = (request: AgentExecuteRequest, type: AgentEvent['type'], message: string) => request.onEvent({ at: at(), type, message });
  const agent: AgentRuntime = { status: async () => { throw new Error('unused'); }, async shutdown() {}, async execute(request) {
    requests.push(request);
    // The agent's own session does not hold the conversation: it asks for it, and asking again gives nothing.
    handed.push(request.earlier?.(), request.earlier?.());
    say(request, 'status', 'Thinking: comparing the halls'); await hold();
    say(request, 'progress', 'Read the map.'); await hold();
    say(request, 'status', 'Writing…');
    return { reply: `Answer ${requests.length}.`, sessionId: 's', actions: [], requestId: `r${requests.length}` };
  } };
  const assistant = new AssistantService(f.store, f.execution, f.experiments, agent);
  const last = () => assistant.state(f.project.id).turns.at(-1)!;
  const until = async (check: () => boolean) => { for (let i = 0; i < 2000; i++) { if (check()) return; await delay(5); } throw new Error('The turn did not get there.'); };
  try {
    assistant.setBackend(f.project.id, { backend: 'codex' });
    assistant.start(f.project.id, { message: 'Which hall is larger?' });
    await until(() => last().doing === 'Thinking: comparing the halls');
    assert.ok(last().events.every(event => !event.message.startsWith('Thinking')), 'the status line is not a step');
    assert.equal(assistant.state(f.project.id).threads.find(thread => thread.id === last().threadId)!.step, 'Thinking: comparing the halls');
    assert.equal(f.store.record<{ doing?: string }>('assistant-turn', last().id)!.doing, undefined, 'and is not saved with the turn');
    // The next recorded step shows instead.
    gate!(); await until(() => last().events.at(-1)!.message === 'Read the map.');
    assert.equal(last().doing, undefined);
    gate!(); await until(() => last().status === 'completed');
    assert.equal(last().doing, undefined, 'a finished turn has no status line');
    assert.equal(last().reply, 'Answer 1.');
    assert.deepEqual(handed, [undefined, undefined], 'a thread’s first turn has nothing earlier');

    assistant.start(f.project.id, { message: 'And which is nearer?', threadId: last().threadId });
    await until(() => requests.length === 2 && Boolean(gate));
    gate!(); await until(() => last().events.at(-1)!.message === 'Read the map.'); gate!();
    await until(() => last().status === 'completed');
    assert.match(handed[2]!, /Which hall is larger\?[\s\S]*Answer 1\./u);
    assert.equal(handed[3], undefined, 'written out once');
    assert.equal(last().events.filter(event => event.message === 'Gave the agent the earlier conversation of this thread.').length, 1);
  } finally { await assistant.shutdown(); await f.close(); }
});
