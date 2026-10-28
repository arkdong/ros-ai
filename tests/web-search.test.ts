import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { ExecutionService } from '../src/server/execution.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { BRAVE_SEARCH_SCHEMA, BRAVE_SEARCH_USD, BraveAdapter, CHECK_SEARCH_SCHEMA, EXA_CONTENTS_SCHEMA, EXA_PAGE_USD, EXA_SEARCH_SCHEMA, EXA_SEARCH_USD, ExaAdapter, SWEEP_SEARCH_SCHEMA, TAVILY_CREDIT_USD, type ModelAdapter, type ModelInfo, type ModelRequest, type ModelResponse, type SearchAdapter, type SearchDepth, type SearchResponse, type SweepResponse } from '../src/server/providers.js';

// Offline doubles of Exa's and Brave Search's own APIs on loopback ports. Nothing here reaches either service.
const EXA_KEY = 'exa-fixture-key-0123456789', BRAVE_KEY = 'brave-fixture-key-0123456789';
const ENVIRONMENT = ['TAVILY_API_KEY', 'EXA_API_KEY', 'BRAVE_API_KEY', 'EXA_BASE_URL', 'BRAVE_BASE_URL', 'ROS_SPENDING_LIMITS', 'ROS_PUBLIC_DEMO'] as const;
type Seen = { method: string; url: URL; headers: IncomingMessage['headers']; input: Record<string, unknown> };
const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>(resolve => { let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => resolve(text ? JSON.parse(text) as Record<string, unknown> : {})); });
const send = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
async function listen(handle: (seen: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const request = { method: req.method!, url: new URL(req.url!, 'http://127.0.0.1'), headers: req.headers, input: req.method === 'POST' ? await body(req) : {} };
    seen.push(request); handle(request, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise(resolve => server.close(resolve)) };
}
/** Exa: /search returns each page's matching passages and the request's cost; /contents returns whole pages. */
const fakeExa = () => listen(({ url, headers, input }, res) => {
  if (headers['x-api-key'] !== EXA_KEY) return send(res, { requestId: 'denied', error: `Invalid API key ${String(headers['x-api-key'])}` }, 401);
  if (url.pathname === '/search') return send(res, { requestId: 'exa-search-1', costDollars: { total: 0.007, search: { neural: 0.007 } }, results: [
    { title: 'Exa page', url: 'https://example.org/exa', highlights: ['First passage.', ' Second passage. '] },
    { title: 'Nothing matched', url: 'https://example.org/blank', highlights: [] },
    { url: 'https://example.org/text-only', text: 'Text when a page has no highlights.' },
    { title: 'Fourth', url: 'https://example.org/fourth', highlights: ['Only three results are asked for.'] },
  ] });
  if (url.pathname === '/contents') return send(res, { requestId: 'exa-contents-1', costDollars: { total: 0.001 },
    results: (input.urls as string[]).filter(page => !page.includes('missing')).map(page => ({ url: page.replace('https://', 'https://www.'), title: 'Whole page', text: `The whole text of ${page}.` })) });
  res.writeHead(404).end();
});
/** Brave Search: the LLM context endpoint returns grounding passages per page and no cost. */
const fakeBrave = () => listen(({ url, headers }, res) => {
  if (headers['x-subscription-token'] !== BRAVE_KEY) return send(res, { type: 'ErrorResponse', error: { status: 422, code: 'SUBSCRIPTION_TOKEN_INVALID', detail: `The provided subscription token ${String(headers['x-subscription-token'])} is invalid.` } }, 422);
  if (url.pathname === '/res/v1/llm/context') return send(res, {
    grounding: { generic: [
      { url: 'https://example.org/brave', title: 'Brave page', snippets: ['Brave passage one.', 'Brave passage two.'] },
      { url: 'https://example.org/brave-untitled', snippets: ['A passage whose title is in sources.'] },
      { url: 'https://example.org/brave-empty', title: 'Empty', snippets: [] },
    ] },
    sources: { 'https://example.org/brave-untitled': { title: 'Title from sources', hostname: 'example.org' } },
  });
  res.writeHead(404).end();
});
/** Sets exactly these variables for one test (the rest unset) and puts the originals back after it. */
function environment(t: TestContext, values: Partial<Record<typeof ENVIRONMENT[number], string>>) {
  const saved = ENVIRONMENT.map(name => [name, process.env[name]] as const);
  for (const name of ENVIRONMENT) { if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name]; }
  t.after(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}
const info: ModelInfo = { id: 'offline-web-search-model', contextTokens: 100000, inputUsdPerToken: .0000001, outputUsdPerToken: .0000003, capabilities: { structuredOutput: true, cancellation: 'abort-request', toolCalling: false, modelVersion: false }, metadata: { fixture: true } };
class AnsweringModel implements ModelAdapter {
  readonly configured = true; readonly provider = 'nebius'; readonly model = info.id;
  requests: ModelRequest[] = [];
  async prepare() { return info; }
  async complete(request: ModelRequest): Promise<ModelResponse> { this.requests.push(request); return { content: 'It changed in October [S1].', model: info.id, modelVersion: null, usage: { inputTokens: 10, outputTokens: 5 }, metadata: { fixture: true } }; }
}
function workspace(t: TestContext, model?: ModelAdapter, search?: SearchAdapter) {
  const directory = mkdtempSync(join(tmpdir(), 'ros-web-search-')), store = new Store(directory), project = store.createProject('Web search');
  store.mutate(project.id, [{ type: 'addNode', node: { id: 'a', title: 'Question', description: 'What changed?', x: 0, y: 0 } }], 'Fixture note');
  new Authority(store).configure(project.id, { mode: 'ask' });
  const execution = new ExecutionService(store, { model, search, includeSetupUsage: false });
  t.after(async () => { await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project, execution };
}
const signal = () => new AbortController().signal;
/** Tavily as the Web block and the claim check use it: each search's depth, and a sweep's relevance and site icon. */
class TavilyDouble implements SearchAdapter {
  readonly configured = true;
  depths: (SearchDepth | undefined)[] = [];
  async search(query: string, _signal: AbortSignal, depth?: SearchDepth): Promise<SearchResponse> {
    this.depths.push(depth);
    return { results: [{ title: 'Tavily page', url: `https://example.org/tavily/${encodeURIComponent(query)}`, content: 'A passage.', locator: 'Tavily search result 1' }], credits: depth === 'advanced' ? 2 : 1, requestId: 'tavily-search' };
  }
  async sweep(query: string): Promise<SweepResponse> {
    return { results: [{ title: 'Swept page', url: `https://example.org/swept/${encodeURIComponent(query)}`, content: 'A swept passage.', locator: 'Tavily search result 1', score: 0.8, favicon: 'https://example.org/favicon.ico' }], credits: 1, requestId: 'tavily-sweep' };
  }
}
const webBlock = { id: 'w', title: 'What changed?', description: '', x: 400, y: 0, blockType: 'web' as const, web: { question: 'What changed?', directions: [{ id: 'd1', title: 'Rules', why: 'Where it starts', queries: ['first', 'second'] }] } };
const sweep = [{ direction: 'd1', query: 'first' }, { direction: 'd1', query: 'second' }];
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Fixture did not settle'); }

test('Exa finds pages by meaning: matching passages become source excerpts, its cost is the one it reports, and it reads whole pages', async t => {
  const exa = await fakeExa(); t.after(exa.close);
  environment(t, { EXA_BASE_URL: `${exa.base}/` });
  const adapter = new ExaAdapter(EXA_KEY);
  const found = await adapter.search('What changed?', signal());
  assert.deepEqual(exa.seen[0].input, { query: 'What changed?', type: 'auto', numResults: 3, contents: { highlights: { maxCharacters: 4000 } } });
  assert.equal(exa.seen[0].url.pathname, '/search');
  // A page with no matching passage is left out, and only the first three results are read.
  assert.deepEqual(found.results, [
    { title: 'Exa page', url: 'https://example.org/exa', content: 'First passage.\n…\nSecond passage.', locator: 'Exa search result 1; passages characters 0–32' },
    { title: 'example.org', url: 'https://example.org/text-only', content: 'Text when a page has no highlights.', locator: 'Exa search result 3; passages characters 0–35' },
  ]);
  assert.deepEqual({ credits: found.credits, costUsd: found.costUsd, requestId: found.requestId }, { credits: null, costUsd: 0.007, requestId: 'exa-search-1' });
  const read = await adapter.extract!(['https://example.org/exa', 'https://example.org/missing'], signal());
  assert.deepEqual(exa.seen[1].input, { urls: ['https://example.org/exa', 'https://example.org/missing'], text: { maxCharacters: 50000 } });
  assert.deepEqual(read.pages, [{ url: 'https://example.org/exa', content: 'The whole text of https://example.org/exa.', locator: 'Exa contents; page text characters 0–42' }]);
  assert.deepEqual(read.failed, ['https://example.org/missing']);
  assert.equal(read.costUsd, 0.001);
});

test('Brave Search answers from its own index at its flat price, sends at most 50 words, and cannot read whole pages', async t => {
  const brave = await fakeBrave(); t.after(brave.close);
  environment(t, { BRAVE_BASE_URL: brave.base });
  const adapter = new BraveAdapter(BRAVE_KEY);
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
  const found = await adapter.search(words, signal());
  const asked = brave.seen[0];
  assert.equal(asked.method, 'GET');
  assert.equal(asked.url.searchParams.get('q')!.split(' ').length, 50);
  assert.deepEqual(Object.fromEntries([...asked.url.searchParams].filter(([name]) => name !== 'q')), { count: '8', maximum_number_of_urls: '3', maximum_number_of_tokens: '4096', maximum_number_of_tokens_per_url: '1536' });
  assert.deepEqual(found.results.map(result => [result.title, result.url, result.content, result.locator]), [
    ['Brave page', 'https://example.org/brave', 'Brave passage one.\n…\nBrave passage two.', 'Brave search result 1; passages characters 0–39'],
    ['Title from sources', 'https://example.org/brave-untitled', 'A passage whose title is in sources.', 'Brave search result 2; passages characters 0–36'],
  ]);
  assert.deepEqual({ credits: found.credits, costUsd: found.costUsd, requestId: found.requestId }, { credits: null, costUsd: BRAVE_SEARCH_USD, requestId: null });
  assert.equal('extract' in adapter, false);
});

test('An error from Exa or Brave Search keeps its reason and never repeats the key', async t => {
  const exa = await fakeExa(), brave = await fakeBrave(); t.after(exa.close); t.after(brave.close);
  environment(t, { EXA_BASE_URL: exa.base, BRAVE_BASE_URL: brave.base });
  const wrongExa = 'exa-wrong-key-0123456789', wrongBrave = 'brave-wrong-key-0123456789';
  await assert.rejects(new ExaAdapter(wrongExa).search('What changed?', signal()), (error: Error) => {
    assert.match(error.message, /HTTP 401: Invalid API key \[redacted\]/u); assert.doesNotMatch(error.message, new RegExp(wrongExa, 'u')); return true;
  });
  await assert.rejects(new BraveAdapter(wrongBrave).search('What changed?', signal()), (error: Error) => {
    assert.match(error.message, /HTTP 422: The provided subscription token \[redacted\] is invalid\./u); assert.doesNotMatch(error.message, new RegExp(wrongBrave, 'u')); return true;
  });
  await assert.rejects(new ExaAdapter().search('What changed?', signal()), /Add an Exa key on the Plugins page/u);
});

test('Searches use the chosen service while it has a key, else the first with a key, and choosing one needs its key first', async t => {
  environment(t, {});
  const { execution } = workspace(t);
  assert.deepEqual(execution.searchStatus(), { active: null, chosen: null, services: [
    { id: 'tavily', label: 'Tavily', configured: false, readsPages: true },
    { id: 'exa', label: 'Exa', configured: false, readsPages: true },
    { id: 'brave', label: 'Brave Search', configured: false, readsPages: false },
  ] });
  assert.equal(execution.agentSearchBlocker(), 'Web search is not connected. Add a Tavily, Exa or Brave Search key on the Plugins page.');
  assert.throws(() => execution.chooseSearch({ provider: 'exa' }), (error: unknown) => error instanceof StoreError && error.status === 409 && error.message === 'Add an Exa key first.');
  assert.throws(() => execution.chooseSearch({ provider: 'google' }));
  assert.throws(() => execution.chooseSearch({ provider: 'brave', depth: 'advanced' }));
  process.env.BRAVE_API_KEY = BRAVE_KEY;
  assert.equal(execution.searchStatus().active, 'brave');
  process.env.EXA_API_KEY = EXA_KEY;
  assert.equal(execution.searchStatus().active, 'exa', 'Exa comes before Brave Search when nothing is chosen');
  assert.deepEqual([execution.searchStatus().active, execution.chooseSearch({ provider: 'brave' }).active, execution.searchStatus().chosen], ['exa', 'brave', 'brave']);
  assert.equal(execution.agentSearchBlocker(), null);
  delete process.env.BRAVE_API_KEY;
  assert.deepEqual([execution.searchStatus().active, execution.searchStatus().chosen], ['exa', 'brave'], 'A chosen service without its key gives way and stays chosen');
  process.env.TAVILY_API_KEY = 'tavily-fixture-key-0123456789';
  assert.equal(execution.searchStatus().active, 'tavily');
});

test('An assistant search through Exa saves its passages as sources and settles at the cost Exa reports', async t => {
  const exa = await fakeExa(); t.after(exa.close);
  environment(t, { EXA_API_KEY: EXA_KEY, EXA_BASE_URL: exa.base });
  const { store, project, execution } = workspace(t);
  assert.equal(execution.assistantCapabilities(project.id).searchAvailable, true);
  const run = await execution.assistantSearch(project.id, 'a', 'What changed?', signal(), 'turn-exa');
  assert.deepEqual([run.status, run.provider, run.model, run.tools[0]], ['completed', 'exa', 'auto-search', EXA_SEARCH_SCHEMA]);
  const sources = store.listArtifacts(project.id).sort((a, b) => a.sourceId!.localeCompare(b.sourceId!));
  assert.deepEqual(sources.map(source => [source.sourceId, source.capture, source.url]), [['S1', 'search-snippet', 'https://example.org/exa'], ['S2', 'search-snippet', 'https://example.org/text-only']]);
  const usage = store.listUsage();
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].provider, usage[0].status, usage[0].reservedUsd, usage[0].estimatedUsd], ['exa', 'settled', EXA_SEARCH_USD, 0.007]);
  assert.match(usage[0].basis, /^Exa search with page passages/u);
});

test('An agent reads whole pages through Exa at its price per page, and Brave Search says why it cannot', async t => {
  const exa = await fakeExa(); t.after(exa.close);
  environment(t, { EXA_API_KEY: EXA_KEY, EXA_BASE_URL: exa.base });
  const { store, project, execution } = workspace(t);
  assert.equal(execution.pageReadingBlocker(), null);
  const { run, failed } = await execution.agentRead(project.id, 'a', [{ url: 'https://example.org/exa', title: 'Exa page' }, { url: 'https://example.org/missing', title: 'Missing page' }], signal(), 'turn-read');
  assert.deepEqual([run.status, run.provider, run.model, run.tools[0]], ['completed', 'exa', 'contents', EXA_CONTENTS_SCHEMA]);
  assert.deepEqual(failed, ['https://example.org/missing']);
  assert.deepEqual(run.artifactIds.map(id => [store.getArtifact(id).capture, store.getArtifact(id).title, store.getArtifact(id).url]), [['full-content', 'Exa page', 'https://example.org/exa']]);
  const usage = store.listUsage()[0];
  assert.deepEqual([usage.provider, usage.status, usage.reservedUsd, usage.estimatedUsd], ['exa', 'settled', 2 * EXA_PAGE_USD, 0.001]);
  delete process.env.EXA_API_KEY; process.env.BRAVE_API_KEY = BRAVE_KEY;
  assert.equal(execution.pageReadingBlocker(), 'Brave Search cannot read whole pages. Quote the page\'s search excerpt instead, or leave it out.');
  assert.throws(() => execution.agentRead(project.id, 'a', [{ url: 'https://example.org/brave', title: 'Brave page' }], signal(), 'turn-brave'), /Brave Search cannot read whole pages/u);
  assert.equal(store.listUsage().length, 1, 'Nothing was reserved for pages Brave Search cannot read');
});

test('A block\'s web search runs with the service it started with and names it in the run', async t => {
  const exa = await fakeExa(); t.after(exa.close);
  environment(t, { EXA_API_KEY: EXA_KEY, EXA_BASE_URL: exa.base });
  const model = new AnsweringModel(), { store, project, execution } = workspace(t, model);
  const started = execution.startRun(project.id, 'a', { request: 'What changed?', useSearch: true });
  assert.equal(started.configuration.searchService, 'exa');
  assert.equal(started.configuration.toolPolicy, 'At most one Exa search then one model call; no automatic retries or executable code.');
  // Choosing another service while the run waits does not change the service it searches with.
  process.env.BRAVE_API_KEY = BRAVE_KEY; execution.chooseSearch({ provider: 'brave' });
  await until(() => store.getRun(started.id).status === 'completed');
  const run = store.getRun(started.id);
  assert.equal(exa.seen.length, 1);
  assert.ok(run.events.some(event => event.message === 'Searching the web with Exa'));
  assert.deepEqual((run.tools[1] as { name: string }).name, 'exa_search');
  assert.match(model.requests[0].messages[0].content, /\[S1\] Exa page\nhttps:\/\/example\.org\/exa\nExa search result 1/u);
  assert.deepEqual(store.listUsage().filter(row => row.provider === 'exa').map(row => [row.status, row.estimatedUsd]), [['settled', 0.007]]);
});

test('Agents keep the tool descriptions they were trained on with Tavily, and another service names itself and its price', async t => {
  environment(t, {});
  const { store, project, execution } = workspace(t);
  const describe = () => {
    const tools = new AgentWorkspaceTools(store, execution, undefined as unknown as ExperimentService, { projectId: project.id, nodeIds: [], artifactIds: [] }, 'turn-tools', 'model', 'Test model');
    const text = (name: string) => tools.definitions.find(item => item.name === name)!.description;
    return { fanOut: text('ros_fan_out_search'), read: text('ros_read_pages'), check: text('ros_check_claims') };
  };
  const tavily = describe();
  assert.match(tavily.fanOut, /plan 1-7 search directions \(0-5 Tavily queries each, at most 30 in total;/u);
  assert.match(tavily.check, /one or two Tavily searches that would confirm or refute it \(at most 16 searches; advanced searches, which return passages of each page\)\. Skip/u);
  assert.match(tavily.read, /at most 15 pages in a turn \(Tavily charges 1 credit, US\$0\.008, for each 5 pages read together\)\. Returns/u);
  process.env.EXA_API_KEY = EXA_KEY;
  const exa = describe();
  assert.match(exa.fanOut, /\(0-5 Exa queries each, at most 30 in total;/u);
  assert.match(exa.check, /one or two Exa searches that would confirm or refute it \(at most 16 searches, which return passages of each page\)\. Skip/u);
  assert.match(exa.read, /\(Exa charges US\$0\.001 for each page\)/u);
  delete process.env.EXA_API_KEY; process.env.BRAVE_API_KEY = BRAVE_KEY;
  const brave = describe();
  assert.match(brave.fanOut, /\(0-5 Brave Search queries each, at most 30 in total;/u);
  assert.match(brave.read, /\(Brave Search cannot read whole pages, so each comes back unread: quote its search excerpt instead\)/u);
  assert.deepEqual([BRAVE_SEARCH_SCHEMA.name, EXA_SEARCH_SCHEMA.name], ['brave_llm_context', 'exa_search']);
});

test('A Web block sweeps with the search service in use: Tavily keeps relevance and site icons, Exa runs its usual search at its price', async t => {
  environment(t, {});
  const tavily = new TavilyDouble(), first = workspace(t, undefined, tavily);
  first.store.mutate(first.project.id, [{ type: 'addNode', node: webBlock }], 'Web block');
  const swept = await first.execution.webSweep(first.project.id, 'w', sweep, signal(), 'turn-sweep');
  assert.deepEqual([swept.status, swept.provider, swept.model, swept.configuration.search, swept.usage], ['completed', 'tavily', 'web-sweep', SWEEP_SEARCH_SCHEMA.configuration, { searches: 2, found: 2, credits: 2 }]);
  assert.deepEqual(swept.cost, { reservedUsd: 2 * TAVILY_CREDIT_USD, estimatedUsd: 2 * TAVILY_CREDIT_USD });
  assert.deepEqual(swept.artifactIds.map(id => first.store.getArtifact(id).metadata), [1, 2].map(search => ({ direction: 'd1', query: search === 1 ? 'first' : 'second', search, rank: 1, score: 0.8, favicon: 'https://example.org/favicon.ico' })));
  assert.deepEqual(tavily.depths, [], 'A sweep never runs a plain search on Tavily');

  const exa = await fakeExa(); t.after(exa.close);
  process.env.EXA_API_KEY = EXA_KEY; process.env.EXA_BASE_URL = exa.base;
  const { store, project, execution } = workspace(t);
  store.mutate(project.id, [{ type: 'addNode', node: webBlock }], 'Web block');
  const run = await execution.webSweep(project.id, 'w', sweep, signal(), 'turn-sweep');
  assert.deepEqual([run.status, run.provider, run.model, run.tools[0]], ['completed', 'exa', 'web-sweep', EXA_SEARCH_SCHEMA]);
  assert.deepEqual(exa.seen.map(request => [request.url.pathname, request.input.query]).sort(), [['/search', 'first'], ['/search', 'second']]);
  const sources = run.artifactIds.map(id => store.getArtifact(id));
  assert.equal(sources.length, 4);
  assert.ok(sources.every(source => source.metadata?.direction === 'd1' && !('score' in source.metadata) && !('favicon' in source.metadata)), 'Exa gives no relevance score or site icon');
  assert.deepEqual(run.cost, { reservedUsd: 2 * EXA_SEARCH_USD, estimatedUsd: 2 * EXA_SEARCH_USD });
  assert.deepEqual(store.listUsage().map(row => [row.provider, row.purpose, row.status, row.estimatedUsd]), [['exa', 'Web block sweep', 'settled', EXA_SEARCH_USD], ['exa', 'Web block sweep', 'settled', EXA_SEARCH_USD]]);
});

test('A claim check searches Tavily in depth, and Exa with its usual search at its own price', async t => {
  environment(t, {});
  const tavily = new TavilyDouble(), first = workspace(t, undefined, tavily);
  const checked = await first.execution.agentSearch(first.project.id, 'a', 'Is it true?', signal(), 'turn-check', 'advanced');
  assert.deepEqual([checked.status, checked.provider, checked.model, checked.configuration.purpose, checked.tools[0]], ['completed', 'tavily', 'advanced-search', 'agent-claim-check', CHECK_SEARCH_SCHEMA]);
  assert.deepEqual(tavily.depths, ['advanced']);
  assert.deepEqual(first.store.listUsage().map(row => [row.provider, row.purpose, row.status, row.reservedUsd, row.estimatedUsd]), [['tavily', 'Agent claim check', 'settled', 2 * TAVILY_CREDIT_USD, 2 * TAVILY_CREDIT_USD]]);
  assert.match(first.store.listUsage()[0].basis, /one advanced search, 2 credits/u);

  const exa = await fakeExa(); t.after(exa.close);
  process.env.EXA_API_KEY = EXA_KEY; process.env.EXA_BASE_URL = exa.base;
  const { store, project, execution } = workspace(t);
  const run = await execution.agentSearch(project.id, 'a', 'Is it true?', signal(), 'turn-check', 'advanced');
  assert.deepEqual([run.status, run.provider, run.model, run.configuration.purpose, run.tools[0]], ['completed', 'exa', 'auto-search', 'agent-claim-check', EXA_SEARCH_SCHEMA]);
  assert.deepEqual(exa.seen.map(request => request.input.type), ['auto']);
  assert.deepEqual(store.listUsage().map(row => [row.provider, row.purpose, row.status, row.reservedUsd, row.estimatedUsd]), [['exa', 'Agent claim check', 'settled', EXA_SEARCH_USD, 0.007]]);
});

test('An agent\'s search plan fills a Web block through the search service in use', async t => {
  const exa = await fakeExa(); t.after(exa.close);
  environment(t, { EXA_API_KEY: EXA_KEY, EXA_BASE_URL: exa.base });
  const { store, project, execution } = workspace(t);
  const authority = new Authority(store);
  authority.configure(project.id, { mode: 'full' });
  const tools = new AgentWorkspaceTools(store, execution, { authority } as unknown as ExperimentService, { projectId: project.id, nodeIds: ['a'], artifactIds: [] }, 'turn-plan', 'model', 'Test model');
  const plan = await tools.call('ros_fan_out_search', { goal: 'What changed?', rationale: 'To see what changed.', directions: [{ title: 'Rules', why: 'Where it starts', queries: ['first', 'second'] }, { title: 'News', why: 'What people noticed', queries: ['third'] }] }) as { status: string; action: { title: string }; webNodeId: string; directions: { found: number; sources: { n: number; url?: string }[] }[] };
  assert.equal(plan.status, 'accepted');
  assert.match(plan.action.title, /^Search the web in 2 directions \(3 Exa searches\) for: What changed\?\. The searches run together in a Web block/u);
  const web = store.getProject(project.id).canvas.nodes.find(node => node.id === plan.webNodeId)!;
  assert.deepEqual([web.blockType, web.web?.directions.map(direction => direction.queries)], ['web', [['first', 'second'], ['third']]]);
  assert.deepEqual(plan.directions.map(direction => direction.found), [2, 2], 'Each direction keeps its sources once, by page');
  const sweep = store.listRuns(project.id).find(run => run.model === 'web-sweep')!;
  assert.deepEqual([sweep.status, sweep.provider, sweep.nodeId], ['completed', 'exa', plan.webNodeId]);
  assert.equal(exa.seen.filter(request => request.url.pathname === '/search').length, 3);
});
