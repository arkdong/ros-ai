import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { Authority } from '../src/server/authority.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AssistantService } from '../src/server/assistant.js';
import { ClaudeAgentService } from '../src/server/claude-agent.js';
import { CodexAgentService, codexStatusRecord } from '../src/server/codex-agent.js';

// Claude Code and Codex are two agents each inside ros.ai: one on the person's subscription, one on an API key.
// Each project picks one in the Ros bar, so picking one never moves another project onto the other way of paying.

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'ros-claude-codex-')), store = new Store(directory), execution = new ExecutionService(store, { includeSetupUsage: false });
  const experiments = { authority: new Authority(store) } as unknown as ExperimentService;
  return { directory, store, execution, experiments, close: async () => { await execution.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const backendOf = (store: Store, projectId: string) => store.record<{ backend: string }>('assistant-backend', projectId)?.backend;

test('projects on the one Claude subscription setting keep Claude Code on the subscription, and the setting goes', async () => {
  const f = workspace();
  const onClaude = f.store.createProject('Claude Code'), onModel = f.store.createProject('A model');
  f.store.saveRecord('assistant-backend', onClaude.id, onClaude.id, { backend: 'claude' });
  f.store.saveRecord('assistant-backend', onModel.id, onModel.id, { backend: 'provider' });
  f.store.saveGlobalRecord('claude-agent-settings', 'settings', { model: 'opus', billing: 'plan', webSearch: 'ros' });
  const claude = new ClaudeAgentService(f.store, f.execution, f.experiments, f.directory);
  try {
    assert.equal(backendOf(f.store, onClaude.id), 'claude-plan');
    assert.equal(backendOf(f.store, onModel.id), 'provider');
    assert.deepEqual(f.store.globalRecord('claude-agent-settings', 'settings'), { model: 'opus', webSearch: 'ros' });
    // Both agents start from the model chosen before they split.
    assert.deepEqual([claude.model('plan'), claude.model('api-key')], ['opus', 'opus']);
  } finally { await claude.shutdown(); await f.close(); }
});

test('on the old default, the API key, projects keep Claude Code (API key), and each of the two agents keeps its own model', async () => {
  const f = workspace();
  const project = f.store.createProject('Claude Code');
  f.store.saveRecord('assistant-backend', project.id, project.id, { backend: 'claude' });
  f.store.saveGlobalRecord('claude-agent-settings', 'settings', { model: 'haiku', billing: 'api-key' });
  const claude = new ClaudeAgentService(f.store, f.execution, f.experiments, f.directory);
  try {
    assert.equal(backendOf(f.store, project.id), 'claude');
    f.store.saveGlobalRecord('claude-agent-settings', 'settings', { model: 'haiku', planModel: 'opus' });
    assert.deepEqual([claude.model('plan'), claude.model('api-key')], ['opus', 'haiku']);
    assert.deepEqual([claude.settings().planModel, claude.settings().model], ['opus', 'haiku']);
  } finally { await claude.shutdown(); await f.close(); }
});

test('each project picks one of the four agents, and the Ros bar and the turn follow that pick', async () => {
  const f = workspace();
  const saved = { ROS_CODEX_BINARY: process.env.ROS_CODEX_BINARY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  // No Codex on this computer and no keys: nothing outside the test is read or started.
  process.env.ROS_CODEX_BINARY = join(f.directory, 'no-codex');
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const claude = new ClaudeAgentService(f.store, f.execution, f.experiments, f.directory), codex = new CodexAgentService(f.store, f.execution, f.experiments, f.directory);
  const assistant = new AssistantService(f.store, f.execution, f.experiments, codex, claude);
  try {
    const first = f.store.createProject('First'), second = f.store.createProject('Second');
    assert.match(assistant.setBackend(first.id, { backend: 'claude' }).modelBlocker!, /Connect a Claude API key/u);
    assert.throws(() => assistant.setBackend(first.id, { backend: 'claude-key' }));

    // Codex's two agents are checked apart and saved apart.
    const plan = await codex.status(second.id, true), key = await codex.status(second.id, true, 'api-key');
    assert.match(plan.detail, /sign in through your own Codex CLI/u);
    assert.match(key.detail, /ros\.ai runs it with your OpenAI API key/u);
    assert.match(key.detail, /Connect an OpenAI API key/u);
    assert.equal(f.store.record<{ detail: string }>('agent-connection-status', codexStatusRecord(second.id, 'api-key'))?.detail, key.detail);
    assert.equal(f.store.record<{ detail: string }>('agent-connection-status', codexStatusRecord(second.id, 'plan'))?.detail, plan.detail);
    assert.equal(assistant.setBackend(second.id, { backend: 'codex' }).modelBlocker, plan.detail);
    assert.equal(assistant.setBackend(second.id, { backend: 'codex-key' }).modelBlocker, key.detail);
    // Picking in one project leaves the other where it was.
    assert.equal(assistant.state(first.id).backend, 'claude');

    const started = assistant.start(second.id, { message: 'What is on the map?' });
    const turn = started.turns.find(item => item.id === started.activeTurnId)! as typeof started.turns[number] & { billing?: string };
    assert.deepEqual([turn.source, turn.billing], ['codex-agent', 'api-key']);
    let current = assistant.state(second.id).turns.find(item => item.id === turn.id)!;
    for (let tries = 0; current.status === 'running' && tries < 200; tries++) { await new Promise(resolve => setTimeout(resolve, 25)); current = assistant.state(second.id).turns.find(item => item.id === turn.id)!; }
    // It ran as Codex (API key): the key check stopped it before anything was sent.
    assert.equal(current.status, 'failed');
    assert.match(current.error!, /Connect an OpenAI API key/u);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await assistant.shutdown(); await codex.shutdown(); await claude.shutdown(); await f.close();
  }
});
