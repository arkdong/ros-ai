import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { Authority } from '../src/server/authority.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AssistantService } from '../src/server/assistant.js';
import { RosLayer, type LandInput, type LayerChoice } from '../src/server/ros-layer.js';
import { layerSummary, replyHasContent, requestTitle, splitReply } from '../src/shared/ros-layer.js';
import type { AgentRuntime } from '../src/shared/agent-runtime.js';
import type { AssistantAction } from '../src/shared/assistant.js';
import type { Mutation, Proposal } from '../src/shared/types.js';

// ROS as the layer on top of any agent: after a turn it groups and links what the agent left loose and puts an answer
// given only in chat on the map, as one row the person can undo. The agent's words and placed blocks never change.

const ANSWER = `# Remote work and productivity

Studies disagree, and most measure different things.

## What the field studies found
A Chinese travel agency's call centre saw output rise 13% when staff worked from home, mostly from more minutes worked.

## What the surveys found
Self-reported productivity is higher at home, but managers rate it lower; neither is measured output.

## Where it is still unknown
Long-run effects on promotion, mentoring and innovation have few clean studies.

Want me to put these on the map as blocks?`;

test('an answer is cut at its own headings, its top heading becomes the title and a closing question stays in chat', () => {
  const split = splitReply(ANSWER);
  assert.equal(split.title, 'Remote work and productivity');
  assert.deepEqual(split.blocks.map(block => block.title), ['What the field studies found', 'What the surveys found', 'Where it is still unknown']);
  // A short overview goes on top of the first section; nothing of the agent's words is rewritten.
  assert.match(split.blocks[0].text, /^Studies disagree, and most measure different things\.\n\nA Chinese travel agency/u);
  assert(!split.blocks.some(block => block.text.includes('Want me to')));
});

test('without headings, bold lead-ins start the sections; plain prose stays one block; code fences are not headings', () => {
  const leads = splitReply('Three options:\n\n**Cost:** the cheapest is the survey.\n\n**Speed:** the panel is quickest.\nIt needs a week.\n\n**Quality:** the trial is best.');
  assert.deepEqual(leads.blocks.map(block => block.title), ['Cost', 'Speed', 'Quality']);
  assert.equal(leads.blocks[1].text, 'the panel is quickest.\nIt needs a week.');
  assert.equal(leads.blocks[0].text, 'Three options:\n\nthe cheapest is the survey.');
  const prose = splitReply('Just one paragraph of answer.\n\nAnd a second one.');
  assert.deepEqual(prose, { title: null, blocks: [{ title: '', text: 'Just one paragraph of answer.\n\nAnd a second one.' }] });
  const code = splitReply('## Setup\n```python\n# not a heading\nprint(1)\n```\n\n## Run\nPress Run.');
  assert.deepEqual(code.blocks.map(block => block.title), ['Setup', 'Run']);
  assert.match(code.blocks[0].text, /# not a heading/u);
  const many = splitReply(Array.from({ length: 15 }, (_, index) => `## Part ${index + 1}\nText ${index + 1}.`).join('\n\n'));
  assert.equal(many.blocks.length, 12);
  assert.match(many.blocks[11].text, /Text 12\.[\s\S]*\*\*Part 15\*\*\n\nText 15\./u);
});

test('only answers with content go on the map by themselves; titles and row words read plainly', () => {
  assert.equal(replyHasContent('Done: I added three notes to the map.'), false);
  assert.equal(replyHasContent(ANSWER), true);
  assert.equal(replyHasContent('x'.repeat(1600)), true);
  assert.equal(requestTitle('what does the literature say about remote work? Keep it short.'), 'Remote work');
  assert.equal(requestTitle('What do we know about it?'), 'What do we know about it');
  assert.equal(requestTitle('/research   compare the three survey designs'), 'Compare the three survey designs');
  assert.equal(requestTitle('Add five blocks with the main methods for measuring sleep quality'), 'Main methods for measuring sleep quality');
  assert.equal(requestTitle('Add a block'), 'Add a block');
  assert.equal(layerSummary({ blocks: 4, into: ['Methods'], links: 2 }), 'Arranged by ROS: 4 blocks into Methods, 2 links');
  assert.equal(layerSummary({ blocks: 0, into: [], links: 1, rescued: { blocks: 3, title: 'Remote work' } }), 'Put the answer on the map: 3 blocks in “Remote work”, 1 link');
});

/** A project with a Methods group holding one block, a lone Background block, and a turn that added three loose notes. */
function fixture(options: { accept?: boolean; choice?: LayerChoice; model?: (request: unknown) => string | Promise<string> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-layer-')), store = new Store(directory);
  const project = store.createProject('Remote work');
  store.mutate(project.id, [
    { type: 'addNode', node: { id: 'methods', title: 'Methods', description: '', kind: 'group', parentId: null, x: 0, y: 0 } },
    { type: 'addNode', node: { id: 'survey', title: 'Survey design', description: 'How the survey samples workers.', kind: 'topic', blockType: 'note', parentId: 'methods', x: 0, y: 0 } },
    { type: 'addNode', node: { id: 'background', title: 'Background reading', description: 'Earlier reviews.', kind: 'topic', blockType: 'note', parentId: null, x: 0, y: 960 } },
  ], 'Start');
  const calls: unknown[] = [];
  const execution = {
    assistantProposal: (projectId: string, summary: string, operations: Mutation[], arranged = false, links: { after?: string[]; batch?: string } = {}): Proposal => {
      const proposal = store.createProposal(projectId, store.getProject(projectId).revision, summary, operations, arranged, links);
      if (options.accept === false || proposal.after?.length) return proposal;
      store.acceptProposal(projectId, proposal.id);
      return store.detail(projectId).proposals.find(item => item.id === proposal.id)!;
    },
    acceptGovernedProposal: () => false,
    layerComplete: async (_projectId: string, request: unknown) => { calls.push(request); const content = await options.model!(request); return { response: { content, model: 'ros-local', modelVersion: null, usage: null, metadata: {} } }; },
  } as unknown as ExecutionService;
  const layer = new RosLayer(store, execution, () => options.choice ?? { engine: 'layout' });
  const turnId = randomUUID();
  /** The agent's own change: three notes left on the map, outside any group. */
  const agentChange = (accept = true) => {
    const proposal = store.createProposal(project.id, store.getProject(project.id).revision, 'Add three notes', [
      { type: 'addNode', node: { id: 'field', title: 'Field studies', description: 'Call centre output rose 13%.', kind: 'topic', blockType: 'note', parentId: null, x: 600, y: 0 } },
      { type: 'addNode', node: { id: 'surveys', title: 'Surveys', description: 'Self-reports are higher at home.', kind: 'topic', blockType: 'note', parentId: null, x: 1080, y: 0 } },
      { type: 'addNode', node: { id: 'unknowns', title: 'Open questions', description: 'Promotion and mentoring effects.', kind: 'topic', blockType: 'note', parentId: null, x: 1560, y: 0 } },
    ], false, { batch: turnId });
    if (accept) store.acceptProposal(project.id, proposal.id);
    return { id: randomUUID(), type: 'proposal', title: 'Add three notes', proposalId: proposal.id, status: accept ? 'completed' : 'pending' } satisfies AssistantAction;
  };
  const input = (actions: AssistantAction[], extra: Partial<LandInput> = {}): LandInput => ({ projectId: project.id, turnId, request: 'What do we know about remote work and productivity?', reply: 'I added three notes.', actions, source: 'claude-agent', ...extra });
  const node = (id: string) => store.getProject(project.id).canvas.nodes.find(item => item.id === id);
  return { store, project, layer, calls, turnId, agentChange, input, node, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('with neither ROS on the computer nor a sign-in, ros.ai’s own rules group the loose blocks under the request, and Undo puts them back', async () => {
  const f = fixture();
  try {
    const action = f.agentChange();
    const result = await f.layer.land(f.input([action]), new AbortController().signal);
    assert.equal(result?.layer.state, 'done');
    assert.equal(result?.layer.engine, 'layout');
    assert.equal(result?.action?.by, 'ros');
    assert.equal(result?.action?.title, 'Arranged by ROS: 3 blocks into Remote work and productivity');
    const group = f.store.getProject(f.project.id).canvas.nodes.find(item => item.kind === 'group' && item.id !== 'methods')!;
    assert.equal(group.title, 'Remote work and productivity');
    // The group sits where the agent put its blocks, which keep their words and go inside in reading order.
    assert.deepEqual([group.x, group.y], [600, 0]);
    assert.deepEqual(['field', 'surveys', 'unknowns'].map(id => f.node(id)!.parentId), [group.id, group.id, group.id]);
    assert.deepEqual([f.node('field')!.x, f.node('field')!.y, f.node('surveys')!.x], [0, 0, 480]);
    assert.equal(f.node('field')!.description, 'Call centre output rose 13%.');
    // Counted for Settings: one turn, three blocks added, all loose.
    const status = f.layer.status();
    assert.deepEqual([status.stats.turns, status.stats.blocks, status.stats.loose, status.stats.rows, status.stats.accepted], [1, 3, 3, 1, 1]);

    f.layer.undo(f.project.id, result!.action!.proposalId!);
    assert.equal(f.node(group.id), undefined);
    assert.deepEqual(['field', 'surveys', 'unknowns'].map(id => [f.node(id)!.parentId, f.node(id)!.x, f.node(id)!.y]), [[null, 600, 0], [null, 1080, 0], [null, 1560, 0]]);
    assert.equal(f.layer.status().stats.undone, 1);
    assert.throws(() => f.layer.undo(f.project.id, result!.action!.proposalId!), /already undone/u);
  } finally { f.close(); }
});

test('a request that names a block puts the loose blocks into its group and links the block to them', async () => {
  const f = fixture();
  try {
    const result = await f.layer.land(f.input([f.agentChange()], { request: 'Add what we know next to the Survey design block' }), new AbortController().signal);
    assert.match(result!.action!.title, /^Arranged by ROS: 3 blocks into Methods, 1 link$/u);
    assert.deepEqual(['field', 'surveys', 'unknowns'].map(id => f.node(id)!.parentId), ['methods', 'methods', 'methods']);
    // Each finds a free spot beside the block already in the group.
    const spots = ['survey', 'field', 'surveys', 'unknowns'].map(id => `${f.node(id)!.x},${f.node(id)!.y}`);
    assert.equal(new Set(spots).size, 4);
    const link = f.store.getProject(f.project.id).canvas.connections.find(edge => edge.source === 'survey');
    assert.deepEqual([link?.target, link?.label], ['field', 'informs']);
  } finally { f.close(); }
});

test('ROS decides themes and links under its contract; refs it was not given are ignored', async () => {
  const f = fixture({ choice: { engine: 'local', selection: { provider: 'local-ros', model: 'ros-local' } }, model: () => JSON.stringify({
    place: [{ block: 'n1', group: 'g1' }, { block: 'n9', group: 'g1' }],
    newGroups: [{ title: '**Evidence from surveys**', blocks: ['n2', 'n3', 'n1'] }],
    links: [{ from: 'b1', to: 'n2', label: 'Informs' }, { from: 'b1', to: 'b1', label: 'loops' }, { from: 'g1', to: 'b1', label: 'not the turn’s work' }],
    toMap: null,
  }) });
  try {
    const result = await f.layer.land(f.input([f.agentChange()], { hint: 'Where the researcher was on the map.' }), new AbortController().signal);
    assert.equal(result?.layer.engine, 'local');
    assert.equal(f.node('field')!.parentId, 'methods');
    const group = f.node(f.node('surveys')!.parentId!)!;
    assert.equal(group.title, 'Evidence from surveys');
    assert.equal(f.node('unknowns')!.parentId, group.id);
    const links = f.store.getProject(f.project.id).canvas.connections;
    assert.deepEqual(links.map(edge => [edge.source, edge.target, edge.label]), [['background', 'surveys', 'informs']]);
    // ROS read the packet: refs for the loose blocks, the groups and the other blocks, with the hint.
    const packet = JSON.parse((f.calls[0] as { messages: { content: string }[] }).messages[1].content);
    assert.deepEqual(packet.loose.map((item: { ref: string; title: string }) => `${item.ref} ${item.title}`), ['n1 Field studies', 'n2 Surveys', 'n3 Open questions']);
    assert.deepEqual(packet.groups, [{ ref: 'g1', title: 'Methods', holds: ['Survey design'] }]);
    assert.equal(packet.hint, 'Where the researcher was on the map.');
  } finally { f.close(); }
});

test('when ROS answers with something that is not JSON, ros.ai’s rules arrange instead and say so', async () => {
  const f = fixture({ choice: { engine: 'hosted', selection: { provider: 'cloud', model: 'ros-deep' } }, model: () => 'Sure! Here is how I would group them.' });
  try {
    const result = await f.layer.land(f.input([f.agentChange()]), new AbortController().signal);
    assert.equal(result?.layer.engine, 'layout');
    assert.match(result!.action!.title, /^Arranged by ROS: 3 blocks into /u);
    assert.equal(f.layer.status().stats.fallback, 1);
  } finally { f.close(); }
});

test('the step says which engine arranged, how long it took, and how long ROS waited for another thread', async () => {
  const f = fixture({ choice: { engine: 'hosted', selection: { provider: 'cloud', model: 'ros-deep' } }, model: () => 'Sure! Here is how I would group them.' });
  try {
    let checks = 0, told = 0;
    const result = await f.layer.land(f.input([f.agentChange()]), new AbortController().signal, () => ++checks < 2, undefined, () => told++);
    assert.equal(told, 1);
    assert.match(result!.event!, /^ROS arranged what the turn left loose \(ros\.ai’s own rules after hosted ROS did not answer, \d+ s; waited \d+ s for another thread\)\.$/u);
  } finally { f.close(); }
});

test('while the agent’s change still waits, ROS’s row waits on it and is accepted after it', async () => {
  const f = fixture({ accept: false });
  try {
    const action = f.agentChange(false);
    const result = await f.layer.land(f.input([action]), new AbortController().signal);
    const proposal = f.store.detail(f.project.id).proposals.find(item => item.id === result!.action!.proposalId)!;
    assert.deepEqual([proposal.status, proposal.after, proposal.batch], ['pending', [action.proposalId], f.turnId]);
    assert.throws(() => f.store.acceptProposal(f.project.id, proposal.id), /has to be accepted first/u);
    f.store.acceptProposal(f.project.id, action.proposalId!);
    f.store.acceptProposal(f.project.id, proposal.id);
    assert.equal(f.node('field')!.parentId, f.store.getProject(f.project.id).canvas.nodes.find(item => item.kind === 'group' && item.id !== 'methods')!.id);
  } finally { f.close(); }
});

test('an answer given only in chat goes on the map as a group of its sections beside what it is about', async () => {
  const f = fixture();
  try {
    const result = await f.layer.land(f.input([], { reply: ANSWER, request: 'Summarise what we know, starting from Background reading' }), new AbortController().signal);
    assert.equal(result!.action!.title, 'Put the answer on the map: 3 blocks in “Remote work and productivity”, 1 link');
    const canvas = f.store.getProject(f.project.id).canvas, group = canvas.nodes.find(item => item.title === 'Remote work and productivity')!;
    assert.equal(group.kind, 'group');
    const sections = canvas.nodes.filter(item => item.parentId === group.id);
    assert.deepEqual(sections.map(item => item.title), ['What the field studies found', 'What the surveys found', 'Where it is still unknown']);
    // Beside Background reading, clear of it.
    const background = f.node('background')!;
    assert(group.x > background.x && group.y >= background.y);
    assert(canvas.connections.some(edge => edge.source === 'background' && edge.target === group.id));
    // A short reply is conversation and stays in chat.
    const second = await f.layer.land(f.input([], { turnId: randomUUID(), reply: 'Done.' }), new AbortController().signal);
    assert.equal(second?.layer.state, 'skipped');
  } finally { f.close(); }
});

test('"Put this on the map" lands at once even where changes wait for review, and the switch turns the pass off', async () => {
  const f = fixture({ accept: false });
  try {
    const action = f.layer.toMap(f.input([], { reply: 'A short answer, but the person asked for it on the map.' }));
    assert.equal(action.status, 'completed');
    assert.equal(f.store.detail(f.project.id).proposals.find(item => item.id === action.proposalId)!.status, 'accepted');
    assert(f.store.getProject(f.project.id).canvas.nodes.some(item => item.description === 'A short answer, but the person asked for it on the map.'));
    f.layer.save({ on: false });
    assert.equal(await f.layer.land(f.input([f.agentChange()]), new AbortController().signal), null);
    assert.equal(f.layer.status().on, false);
    // Counted even while off, so the numbers say what agents leave without help.
    assert.equal(f.layer.status().stats.turns, 1);
  } finally { f.close(); }
});

test('after an agent turn the assistant runs the pass beside the conversation and adds ROS’s row to the turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-layer-turn-')), store = new Store(directory), execution = new ExecutionService(store, { includeSetupUsage: false });
  const experiments = { authority: new Authority(store) } as unknown as ExperimentService;
  const project = store.createProject('Turns');
  store.saveRecord('assistant-backend', project.id, project.id, { backend: 'codex' });
  // Approve for me: additions and arranging land at once, ROS's as the agent's.
  new Authority(store).configure(project.id, { mode: 'review' });
  const codex = {
    status: async () => ({ available: true }),
    shutdown: async () => {},
    execute: async (request: { projectId: string; turnId: string }) => {
      const proposal = store.createProposal(request.projectId, store.getProject(request.projectId).revision, 'Add notes', ['A', 'B', 'C'].map((title, index) => ({ type: 'addNode' as const, node: { id: randomUUID(), title: `Note ${title}`, description: `About ${title}.`, kind: 'topic' as const, blockType: 'note' as const, parentId: null, x: index * 480, y: 0 } })), false, { batch: request.turnId });
      store.acceptProposal(request.projectId, proposal.id);
      return { reply: 'Added three notes.', sessionId: 's', requestId: 'r', actions: [{ id: randomUUID(), type: 'proposal', title: 'Add notes', proposalId: proposal.id, status: 'completed' }] };
    },
  } as unknown as AgentRuntime;
  const layer = new RosLayer(store, execution);
  const assistant = new AssistantService(store, execution, experiments, codex, undefined, undefined, undefined, undefined, undefined, layer);
  try {
    const started = assistant.start(project.id, { message: 'Note the three options' });
    let turn = assistant.state(project.id).turns.find(item => item.id === started.activeTurnId)!;
    for (let tries = 0; (turn.status === 'running' || turn.layer?.state !== 'done') && tries < 200; tries++) { await new Promise(resolve => setTimeout(resolve, 25)); turn = assistant.state(project.id).turns.find(item => item.id === turn.id)!; }
    assert.equal(turn.status, 'completed');
    assert.equal(turn.layer?.state, 'done');
    const row = turn.actions.find(action => action.by === 'ros')!;
    assert.equal(row.title, 'Arranged by ROS: 3 blocks into Note the three options');
    assert.equal(row.status, 'completed');
    assert(turn.events.some(event => /^ROS arranged what the turn left loose \(ros\.ai’s own rules, \d+ s\)\.$/u.test(event.message)));
    // Undo from the card marks the row and puts the blocks back on the map's top level.
    const after = assistant.undoLayer(project.id, row.id).turns.find(item => item.id === turn.id)!;
    assert.equal(after.actions.find(action => action.id === row.id)?.undone, true);
    assert(store.getProject(project.id).canvas.nodes.every(node => node.kind !== 'group' && !node.parentId));
  } finally { await assistant.shutdown(); await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
