import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { ExperimentService } from '../src/server/experiments.js';
import { AssistantService, attachAssistantRoutes } from '../src/server/assistant.js';
import { SandboxBudget } from '../src/server/sandbox-budget.js';
import { apiErrorHandler } from '../src/server/app.js';
import { attachSuggestionRoutes, pluginReadiness, PluginSuggestions, type ReadinessSources } from '../src/server/plugin-suggestions.js';
import type { ModelAdapter } from '../src/server/providers.js';
import type { ExecutionBackend } from '../src/server/sandbox.js';
import type { AssistantState } from '../src/shared/assistant.js';
import type { SuggestionStatus } from '../src/shared/plugin-hints.js';

// No model, search or execution is reached: the model is unconfigured, so each turn ends from saved records.
const DAY = 24 * 60 * 60 * 1000;
function fixture(clock: () => number = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-suggestions-')), store = new Store(dir), project = store.createProject('Plugin suggestions fixture');
  const model: ModelAdapter = { provider: 'nebius', model: 'offline-fixture', configured: false, async prepare() { throw new Error('No model in this fixture.'); }, async complete() { throw new Error('No model in this fixture.'); } };
  const runtime: ExecutionBackend = { capabilities: () => ({ available: false, backend: 'docker-python', policy: 'offline-fixture', runtime: 'offline fixture', workerHash: 'offline-fixture', imageId: null, libraries: {}, enforcement: [], limitations: ['No execution in this fixture'], timeoutMs: 30000, maxMemoryMb: 512, maxOutputBytes: 1000000 }), start() { throw new Error('No execution in this fixture.'); } };
  const execution = new ExecutionService(store, { model, limits: { nebius: 1, tavily: 1 }, includeSetupUsage: false });
  const experiments = new ExperimentService(store, { sandbox: runtime, nebiusSandbox: runtime, sandboxBudget: new SandboxBudget(store, {}) });
  const assistant = new AssistantService(store, execution, experiments);
  experiments.authority.configure(project.id, { mode: 'ask' });
  const suggestions = new PluginSuggestions(dir, clock);
  const app = express(); app.use(express.json());
  attachAssistantRoutes(app, assistant);
  attachSuggestionRoutes(app, suggestions, { store, assistant, readiness: () => ({ linear: 'missing', notion: 'missing', github: 'ready', arxiv: 'off' }) });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  const call = async <T>(path: string, init: RequestInit = {}) => {
    await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
    return { status: response.status, body: await response.json() as T };
  };
  const send = async (message: string, suggest?: string[]) => {
    const sent = await call<AssistantState>(`/api/projects/${project.id}/assistant/messages`, { method: 'POST', body: JSON.stringify({ message, ...(suggest ? { suggest } : {}) }) });
    assert.equal(sent.status, 202);
    for (let i = 0; i < 400 && assistant.state(project.id).turns.some(turn => turn.status === 'running'); i++) await delay(5);
    return assistant.state(project.id).turns.at(-1)!;
  };
  const decide = (body: Record<string, unknown>) => call<SuggestionStatus>('/api/suggestions/decide', { method: 'POST', body: JSON.stringify({ projectId: project.id, ...body }) });
  return { dir, store, project, assistant, suggestions, call, send, decide, async close() { server.close(); await assistant.shutdown(); await execution.shutdown(); await experiments.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a reply carries a card only for plugins its message really names, and a newer request takes the card over', async () => {
  const f = fixture();
  try {
    const plain = await f.send('Summarise the Linear issue https://linear.app/acme/issue/ENG-12');
    assert.equal(plain.suggested, undefined, 'without suggest from the app there is no card');
    // github is not in the message, so the server drops it whatever the app sent.
    const first = await f.send('Compare https://linear.app/acme/issue/ENG-12 with the spec on notion.so/acme/Spec-123', ['linear', 'notion', 'github']);
    assert.deepEqual(first.suggested, { by: 'ros.ai', plugins: [{ id: 'linear', signal: 'linked' }, { id: 'notion', signal: 'linked' }], status: 'open' });
    const before = f.assistant.state(f.project.id).turns.find(turn => turn.id === first.id)!;
    const second = await f.send('Now file it in Linear please', ['linear']);
    assert.deepEqual(second.suggested?.plugins, [{ id: 'linear', signal: 'named' }]);
    const moved = f.assistant.state(f.project.id).turns.find(turn => turn.id === first.id)!;
    assert.equal(moved.suggested?.status, 'moved');
    assert.equal(moved.updatedAt, before.updatedAt, 'closing a card does not count as new work on the old reply');
    const refused = await f.call(`/api/projects/${f.project.id}/assistant/messages`, { method: 'POST', body: JSON.stringify({ message: 'hello', suggest: ['not-a-plugin'] }) });
    assert.equal(refused.status, 400);
  } finally { await f.close(); }
});

test('Not now silences the card’s plugins in this project for a week; Don’t suggest again silences one everywhere until Undo', async () => {
  let now = Date.parse('2026-10-27T12:00:00.000Z');
  const f = fixture(() => now);
  try {
    const turn = await f.send('Compare https://linear.app/acme/issue/ENG-12 with notion.so/acme/Spec-123', ['linear', 'notion']);
    const later = await f.decide({ decision: 'later', turnId: turn.id });
    assert.equal(later.status, 200);
    assert.deepEqual(later.body.silenced.map(item => [item.pluginId, item.projectId, item.projectTitle, item.until]), [['linear', f.project.id, 'Plugin suggestions fixture', '2026-11-03T12:00:00.000Z'], ['notion', f.project.id, 'Plugin suggestions fixture', '2026-11-03T12:00:00.000Z']]);
    assert.equal(f.assistant.state(f.project.id).turns.find(item => item.id === turn.id)!.suggested?.status, 'later');
    // A second answer to a closed card changes nothing on it.
    assert.equal((await f.decide({ decision: 'done', turnId: turn.id })).status, 200);
    assert.equal(f.assistant.state(f.project.id).turns.find(item => item.id === turn.id)!.suggested?.status, 'later');
    now += 7 * DAY + 1;
    assert.deepEqual((await f.call<SuggestionStatus>('/api/suggestions')).body.silenced, [], 'Not now ends by itself after a week');

    const both = await f.send('Read https://linear.app/acme/issue/ENG-9 and notion.so/acme/Plan-456', ['linear', 'notion']);
    const never = await f.decide({ decision: 'never', turnId: both.id, pluginId: 'linear' });
    assert.deepEqual(never.body.silenced.map(item => [item.pluginId, item.projectId, item.until]), [['linear', null, null]]);
    assert.equal(f.assistant.state(f.project.id).turns.find(item => item.id === both.id)!.suggested?.status, 'open', 'the card stays while it still offers Notion');
    await f.decide({ decision: 'never', turnId: both.id, pluginId: 'notion' });
    assert.equal(f.assistant.state(f.project.id).turns.find(item => item.id === both.id)!.suggested?.status, 'never');
    assert.ok(f.suggestions.silenced('linear', 'any-other-project'));

    const undo = await f.call<SuggestionStatus>('/api/suggestions/silenced/linear', { method: 'DELETE' });
    assert.deepEqual(undo.body.silenced.map(item => item.pluginId), ['notion']);
    assert.equal((await f.decide({ decision: 'never' })).status, 400, 'never says which plugin');
    assert.equal((await f.decide({ decision: 'done', turnId: 'missing-turn' })).status, 404);
  } finally { await f.close(); }
});

test('carrying on closes the card, and the switch turns suggestions off in a file only the owner can read', async () => {
  const f = fixture();
  try {
    const turn = await f.send('What changed in https://linear.app/acme/issue/ENG-12?', ['linear']);
    await f.decide({ decision: 'done', turnId: turn.id });
    assert.equal(f.assistant.state(f.project.id).turns.find(item => item.id === turn.id)!.suggested?.status, 'done');
    const status = await f.call<SuggestionStatus>('/api/suggestions');
    assert.equal(status.body.enabled, true);
    assert.deepEqual(status.body.plugins, { linear: 'missing', notion: 'missing', github: 'ready', arxiv: 'off' });
    const off = await f.call<SuggestionStatus>('/api/suggestions', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    assert.equal(off.body.enabled, false);
    assert.equal(statSync(join(f.dir, 'suggestions.json')).mode & 0o777, 0o600);
    assert.equal(new PluginSuggestions(f.dir).enabled, false, 'the choice survives a restart');
    assert.equal((await f.call('/api/suggestions', { method: 'PUT', body: JSON.stringify({ enabled: 'no' }) })).status, 400);
  } finally { await f.close(); }
  const dir = mkdtempSync(join(tmpdir(), 'ros-suggestions-open-'));
  try {
    writeFileSync(join(dir, 'suggestions.json'), JSON.stringify({ version: 1, enabled: true, silenced: [] }), { mode: 0o644 });
    assert.throws(() => new PluginSuggestions(dir), /readable only by its owner/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readiness reads each plugin the way the Plugins page does', () => {
  const sources = {
    credentials: { status: (id: string) => id === 'tavily' ? { configured: true, verified: true } : id === 'exa' ? { configured: true, verified: false } : { configured: false } },
    googleDrive: { status: () => ({ connected: false, state: 'reconnect-required' }) },
    papers: { status: () => ({ sources: [{ id: 'openalex', agents: true }, { id: 'arxiv', agents: false }] }) },
    browser: { status: () => ({ agents: true, engine: null }) },
    apps: { status: (id: string) => ({ connected: id === 'linear' }) },
    plugins: { status: (id: string) => id === 'github' ? { configured: true, verified: false } : { configured: false } },
  } as unknown as ReadinessSources;
  const readiness = pluginReadiness(sources);
  assert.equal(readiness.tavily, 'ready');
  assert.equal(readiness.exa, 'failed');
  assert.equal(readiness.brave, 'missing');
  assert.equal(readiness['google-sheets'], 'failed');
  assert.equal(readiness.openalex, 'ready');
  assert.equal(readiness.arxiv, 'off');
  assert.equal(readiness.browser, 'off', 'agents cannot browse until a browser is installed');
  assert.equal(readiness.linear, 'ready');
  assert.equal(readiness.notion, 'missing');
  assert.equal(readiness.github, 'failed');
  assert.equal(readiness.overleaf, undefined, 'never suggested');
});
