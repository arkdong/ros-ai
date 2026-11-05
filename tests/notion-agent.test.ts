import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { NotionApi, notionId } from '../src/server/notion.js';

// A stand-in for Notion's API: one page whose blocks are given, pages of 100 blocks, and cursors that are block IDs.
const PAGE = '0123456789abcdef0123456789abcdef', PAGE_ID = notionId(PAGE);
const blockId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function notion(blocks: string[]) {
  const appended: unknown[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === `/v1/pages/${PAGE_ID}`) return reply({ object: 'page', id: PAGE_ID, url: `https://www.notion.so/Plan-${PAGE}`, parent: { type: 'workspace' }, properties: { Name: { type: 'title', title: [{ plain_text: 'Plan' }] } } });
    if (url.pathname === `/v1/blocks/${PAGE_ID}/children` && init?.method === 'PATCH') { appended.push(JSON.parse(String(init.body))); return reply({ results: [] }); }
    if (url.pathname === `/v1/blocks/${PAGE_ID}/children`) {
      const cursor = url.searchParams.get('start_cursor'), from = cursor ? blocks.findIndex((_, index) => blockId(index) === cursor) : 0;
      assert.ok(from >= 0, 'a cursor Notion gave or a block ID');
      const page = blocks.slice(from, from + 100).map((text, index) => ({ object: 'block', id: blockId(from + index), type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: text }] } }));
      const more = from + 100 < blocks.length;
      return reply({ results: page, has_more: more, next_cursor: more ? blockId(from + 100) : null });
    }
    return reply({ object: 'error', message: 'Could not find it.' }, 404);
  }) as typeof fetch;
  return { api: new NotionApi(() => 'secret_test', fetcher), appended };
}
function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-notion-agent-')), store = new Store(directory);
  t.after(() => { AgentWorkspaceTools.notion = undefined; store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project: store.createProject('Notion') };
}
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-notion', 'model', 'Test model');
const waiting = async (tools: AgentWorkspaceTools) => {
  for (let i = 0; i < 100 && !tools.actions.some(item => item.proposalId); i++) await delay(20);
  return tools.actions.find(item => item.proposalId)!.proposalId!;
};

test('Notion links from the address bar name their page or database, not the view or the block', () => {
  const database = 'fedcba9876543210fedcba9876543210', view = '11111111111111111111111111111111', row = '22222222222222222222222222222222', block = '33333333333333333333333333333333';
  assert.equal(notionId(`https://www.notion.so/team/Tasks-${database}?v=${view}`), notionId(database));
  assert.equal(notionId(`notion.so/team/${database}?v=${view}&pvs=4`), notionId(database));
  assert.equal(notionId(`https://www.notion.so/Plan-${PAGE}#${block}`), PAGE_ID);
  // A row opened beside its database: the link shows the row's page.
  assert.equal(notionId(`https://www.notion.so/team/${database}?v=${view}&p=${row}&pm=s`), notionId(row));
  assert.equal(notionId(PAGE_ID), PAGE_ID);
  assert.throws(() => notionId(`https://www.notion.so/team?v=${view}`), /Give a Notion page or database ID or link/u);
});

test('Agents read a long Notion page to its end, each block once, and a block too long for one read is marked as cut', async () => {
  const lines = Array.from({ length: 150 }, (_, index) => `Line ${index + 1} `.padEnd(100, '.'));
  const { api } = notion(lines);
  const seen: string[] = [];
  let cursor: string | undefined, reads = 0;
  do {
    const read = await api.read(`https://www.notion.so/Plan-${PAGE}`, cursor) as { content: string; nextCursor?: string };
    assert.ok(read.content.length <= 12_000);
    seen.push(...read.content.split('\n'));
    cursor = read.nextCursor;
    reads++;
  } while (cursor && reads < 5);
  assert.deepEqual(seen, lines);
  assert.equal(reads, 2);

  const long = notion(['x'.repeat(30_000), 'After the long block']);
  const first = await long.api.read(PAGE, undefined) as { content: string; nextCursor?: string };
  assert.match(first.content, /this block is cut here: 18000 more characters\]$/u);
  assert.equal((await long.api.read(PAGE, first.nextCursor) as { content: string }).content, 'After the long block');
});

test('A Notion write shows all of itself on its approval note, one too long to show is refused, and an unanswered one is taken down', async t => {
  const { store, project } = workspace(t), { api, appended } = notion(['Intro']);
  AgentWorkspaceTools.notion = api;
  const append = (content: string) => ({ summary: 'Add the findings', rationale: 'The person asked to keep the findings in the plan.', operation: { type: 'append', pageId: `https://www.notion.so/Plan-${PAGE}`, content } });
  const content = Array.from({ length: 30 }, (_, index) => `Finding ${index + 1}: `.padEnd(300, 'x')).join('\n');

  // Longer than the 4,000 characters the note used to show: the note holds every line, and Accept writes them.
  const agent = toolkit(store, project.id), pending = agent.call('ros_notion_write', append(content));
  const proposalId = await waiting(agent);
  const note = store.detail(project.id).proposals.find(item => item.id === proposalId)!.operations.find(op => op.type === 'addNode');
  assert.ok(note?.type === 'addNode' && note.node.description.includes(content));
  store.acceptProposal(project.id, proposalId);
  assert.equal((await pending as { status: string }).status, 'written');
  assert.equal((appended[0] as { children: unknown[] }).children.length, 30);

  // Too long for a note: refused before anyone is asked, and nothing is written.
  const tooLong = Array.from({ length: 65 }, (_, index) => `Finding ${index + 1}: `.padEnd(300, 'x')).join('\n');
  await assert.rejects(toolkit(store, project.id).call('ros_notion_write', append(tooLong)), /too long to show in full on its approval note/u);
  assert.equal(store.detail(project.id).proposals.filter(item => item.status === 'pending').length, 0);

  // The turn stops waiting (here the person pressed Stop): the note is taken down, so a late Accept cannot look written.
  const stopped = toolkit(store, project.id), stop = new AbortController();
  stopped.signal = stop.signal;
  const unanswered = stopped.call('ros_notion_write', append('One more line'));
  const left = await waiting(stopped);
  stop.abort();
  const result = await unanswered as { status: string; instruction: string };
  assert.equal(result.status, 'unanswered');
  assert.match(result.instruction, /took the note down/u);
  assert.equal(store.proposalStatus(project.id, left), 'dismissed');
  assert.equal(appended.length, 1);
});
