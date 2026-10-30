import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { AssistantService } from '../src/server/assistant.js';
import type { ExperimentService } from '../src/server/experiments.js';
import type { AssistantThread } from '../src/shared/assistant.js';

test('a thread puts back the agent and model it last ran with when it is opened again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-thread-choice-'));
  const store = new Store(dir), execution = new ExecutionService(store, { includeSetupUsage: false });
  const assistant = new AssistantService(store, execution, { authority: { policy: () => ({ stopped: false, mode: 'review' }) } } as unknown as ExperimentService);
  try {
    const project = store.createProject('Threads'), at = new Date().toISOString();
    for (const id of ['thread-a', 'thread-b']) store.saveRecord('assistant-thread', id, project.id, { id, projectId: project.id, title: id, createdAt: at, updatedAt: at } satisfies AssistantThread);
    const nano = { provider: 'nebius' as const, model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B' };
    // Thread A runs on Codex with GPT-5.5 at high effort.
    assistant.setBackend(project.id, { backend: 'codex' });
    execution.models.update(project.id, { nodeId: null, selection: nano });
    store.saveGlobalRecord('codex-agent-settings', 'settings', { planModel: 'gpt-5.5', planEffort: 'high' });
    assistant.rememberChoice(project.id, 'thread-a');
    // Thread B moves to Claude Code and another model, and Codex to another effort.
    assistant.setBackend(project.id, { backend: 'claude-plan' });
    execution.models.update(project.id, { nodeId: null, selection: { provider: 'nebius', model: 'moonshotai/Kimi-K2.7-Code' } });
    store.saveGlobalRecord('codex-agent-settings', 'settings', { planModel: 'gpt-5.5', planEffort: 'low' });
    const remembered = assistant.rememberChoice(project.id, 'thread-b').threads.find(thread => thread.id === 'thread-a');
    assert.deepEqual(remembered?.choice, { backend: 'codex', model: nano, agentModel: { model: 'gpt-5.5', effort: 'high' } });
    // Opening A again puts its choice back.
    const state = assistant.restoreChoice(project.id, 'thread-a');
    assert.equal(state.backend, 'codex');
    assert.deepEqual(execution.modelSelection(project.id), nano);
    assert.deepEqual(store.globalRecord('codex-agent-settings', 'settings'), { planModel: 'gpt-5.5', planEffort: 'high' });
    // And B's.
    assert.equal(assistant.restoreChoice(project.id, 'thread-b').backend, 'claude-plan');
    assert.equal(execution.modelSelection(project.id).model, 'moonshotai/Kimi-K2.7-Code');
    // A thread that never ran keeps what the project has.
    store.saveRecord('assistant-thread', 'thread-c', project.id, { id: 'thread-c', projectId: project.id, title: 'c', createdAt: at, updatedAt: at } satisfies AssistantThread);
    assert.equal(assistant.restoreChoice(project.id, 'thread-c').backend, 'claude-plan');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
