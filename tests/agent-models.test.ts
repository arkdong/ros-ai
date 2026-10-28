import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { Authority } from '../src/server/authority.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { ClaudeAgentService, claudeModels } from '../src/server/claude-agent.js';
import { CodexAgentService } from '../src/server/codex-agent.js';
import { parseCodexModels } from '../src/server/codex-app-server.js';
import { CLAUDE_MODELS } from '../src/shared/claude-agent.js';
import { effortFor, modelEffortLabel, type AgentModel } from '../src/shared/agent-models.js';

// Claude Code and Codex each run on a model at an effort the person picks, once for all projects, per agent.
// Nothing here starts Claude Code or Codex: their model lists are given to the services as they would report them.

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'ros-agent-models-')), store = new Store(directory), execution = new ExecutionService(store, { includeSetupUsage: false });
  const experiments = { authority: new Authority(store) } as unknown as ExperimentService;
  return { directory, store, execution, experiments, close: async () => { await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const refused = (status: number) => (error: unknown) => (error as { status?: number }).status === status;

test('a model runs a wanted effort at the highest level it takes at or below it, as Claude Code does', () => {
  const model: AgentModel = { id: 'gpt-5.4', label: 'GPT-5.4', detail: '', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
  assert.deepEqual([effortFor(model, 'max'), effortFor(model, 'low'), effortFor(model, null)], ['high', 'low', 'medium']);
  assert.equal(effortFor({ ...model, efforts: [], defaultEffort: null }, 'high'), null);
  assert.equal(modelEffortLabel({ model: 'gpt-5.4', effort: 'high', models: [model] }), 'GPT-5.4 · High');
  assert.equal(modelEffortLabel({ model: 'gpt-5.4', effort: null, models: [model] }), 'GPT-5.4');
});

test('Claude Code’s own list names ros.ai’s four models and gives each Claude Code’s starting effort', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const listed: ModelInfo[] = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 5.5 · Efficient for routine tasks' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Opus 5.5 · Best for everyday, complex tasks · $5/$25 per Mtok', supportsEffort: true, supportedEffortLevels: [...all] },
    { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: [...all] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Fast', supportsEffort: false },
  ];
  assert.deepEqual(claudeModels(listed), [
    { id: 'opus', label: 'Opus 5.5', detail: 'Best for everyday, complex tasks', efforts: [...all], defaultEffort: 'medium' },
    { id: 'fable', label: 'Fable 5.1', detail: 'Most capable for your hardest and longest-running tasks', efforts: [...all], defaultEffort: 'high' },
    { id: 'haiku', label: 'Haiku', detail: 'Fast', efforts: [], defaultEffort: null },
  ]);
});

test('each Claude Code agent saves its own model and effort, and a new model starts on its own default effort', async () => {
  const f = workspace(), claude = new ClaudeAgentService(f.store, f.execution, f.experiments, f.directory);
  // As Claude Code would list them, without asking it.
  (claude as unknown as { catalog: unknown }).catalog = { models: Promise.resolve(CLAUDE_MODELS) };
  f.store.saveGlobalRecord('claude-agent-settings', 'settings', { model: 'sonnet', webSearch: 'ros' });
  try {
    assert.deepEqual((({ model, effort }) => ({ model, effort }))(await claude.modelChoice('plan')), { model: 'sonnet', effort: 'medium' });
    assert.equal((await claude.chooseModel('plan', { effort: 'max' })).effort, 'max');
    // The other agent keeps its own.
    assert.equal((await claude.modelChoice('api-key')).effort, 'medium');
    const opus = await claude.chooseModel('plan', { model: 'opus' });
    assert.deepEqual([opus.model, opus.effort], ['opus', 'medium']);
    const fable = await claude.chooseModel('plan', { model: 'fable', effort: 'xhigh' });
    assert.deepEqual([fable.model, fable.effort], ['fable', 'xhigh']);
    assert.deepEqual(f.store.globalRecord('claude-agent-settings', 'settings'), { model: 'sonnet', planModel: 'fable', planEffort: 'xhigh', webSearch: 'ros' });
    assert.equal(claude.model('plan'), 'fable');
    await assert.rejects(claude.chooseModel('plan', { model: 'gpt-5.4' }), refused(400));
    await assert.rejects(claude.chooseModel('api-key', { effort: 'ultra' }));
    await assert.rejects(claude.chooseModel('api-key', { model: 'opus', billing: 'plan' }));
  } finally { await claude.shutdown(); await f.close(); }
});

test('Codex lists its own models on the subscription, starts where the person’s Codex settings point, and keeps its key on priced models', async () => {
  const f = workspace(), saved = process.env.ROS_CODEX_BINARY;
  process.env.ROS_CODEX_BINARY = join(f.directory, 'no-codex');
  const codex = new CodexAgentService(f.store, f.execution, f.experiments, f.directory);
  const listed = parseCodexModels({ data: [
    { model: 'gpt-a', displayName: 'GPT-A', description: 'The default one.', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] },
    { model: 'gpt-b', displayName: 'GPT-B', description: 'Thinks longer', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] },
    { model: 'gpt-hidden', displayName: 'Hidden', hidden: true },
  ] });
  assert.deepEqual(listed, { defaultModel: 'gpt-a', models: [
    { id: 'gpt-a', label: 'GPT-A', detail: 'The default one', efforts: ['low', 'high'], defaultEffort: 'low' },
    { id: 'gpt-b', label: 'GPT-B', detail: 'Thinks longer', efforts: ['medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  ] });
  // A connection check as Codex would answer it: signed in, with gpt-b at high effort in the person's own settings.
  const checked = (rpc: unknown) => (codex as unknown as { checked: Map<string, unknown> }).checked.set('plan', { at: Date.now(), cli: {}, protocol: {}, rpc });
  checked({ signedIn: true, authMethod: 'chatgpt', disabledMcp: [], toolRestrictionsConfigured: true, rateLimits: null, ...listed, configured: { model: 'gpt-b', effort: 'high' } });
  try {
    assert.deepEqual((({ model, effort }) => ({ model, effort }))(await codex.modelChoice('plan')), { model: 'gpt-b', effort: 'high' });
    const picked = await codex.chooseModel('plan', { model: 'gpt-a' });
    assert.deepEqual([picked.model, picked.effort], ['gpt-a', 'low']);
    await assert.rejects(codex.chooseModel('plan', { effort: 'xhigh' }), refused(400));
    assert.equal((await codex.chooseModel('plan', { effort: 'high' })).effort, 'high');

    // On the key: the two models ros.ai prices, at the three levels they take.
    const key = await codex.modelChoice('api-key');
    assert.deepEqual([key.model, key.effort, key.models.map(item => item.id)], ['gpt-5.4', 'medium', ['gpt-5.4', 'gpt-5.4-mini']]);
    await assert.rejects(codex.chooseModel('api-key', { model: 'gpt-a' }), refused(400));
    await assert.rejects(codex.chooseModel('api-key', { effort: 'xhigh' }), refused(400));
    const mini = await codex.chooseModel('api-key', { model: 'gpt-5.4-mini', effort: 'low' });
    assert.deepEqual([mini.model, mini.effort], ['gpt-5.4-mini', 'low']);
    assert.deepEqual(f.store.globalRecord('codex-agent-settings', 'settings'), { model: 'gpt-5.4-mini', effort: 'low', planModel: 'gpt-a', planEffort: 'high' });

    // Without Codex's list there is nothing to pick from.
    checked(null);
    assert.deepEqual(await codex.modelChoice('plan'), { model: null, effort: null, models: [] });
    await assert.rejects(codex.chooseModel('plan', { model: 'gpt-a' }), refused(400));
  } finally {
    if (saved === undefined) delete process.env.ROS_CODEX_BINARY; else process.env.ROS_CODEX_BINARY = saved;
    await codex.shutdown(); await f.close();
  }
});
