import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ModelSettings } from '../src/server/model-settings.js';
import { ExecutionService } from '../src/server/execution.js';
import { AssistantService } from '../src/server/assistant.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { DEFAULT_NEBIUS_MODEL } from '../src/shared/model-settings.js';

test('ROS starts a project that has not chosen with the last model chosen anywhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-last-choice-'));
  const store = new Store(dir), models = new ModelSettings(store);
  try {
    const first = store.createProject('First'), second = store.createProject('Second');
    assert.equal(models.read(first.id).project.model, DEFAULT_NEBIUS_MODEL);
    const nano = { provider:'nebius', model:'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B' };
    models.update(first.id, { nodeId:null, selection:nano });
    // A project that never chose follows the last choice, and so does a new one.
    assert.deepEqual(models.read(second.id).project, nano);
    assert.deepEqual(models.read(store.createProject('Third').id).project, nano);
    // A project that chose keeps its own choice after another project picks something else.
    const kimi = { provider:'nebius', model:'moonshotai/Kimi-K2.7-Code' };
    models.update(second.id, { nodeId:null, selection:kimi });
    assert.deepEqual(models.read(first.id).project, nano);
    // A remembered model that is no longer offered is passed over.
    store.rememberRosChoice({ model:{ provider:'custom-00000000-0000-0000-0000-000000000000', model:'gone' } });
    assert.equal(models.read(store.createProject('Fourth').id).project.model, DEFAULT_NEBIUS_MODEL);
    store.rememberRosChoice({ backend:'claude-plan' });
    assert.equal(store.lastRosChoice().backend, 'claude-plan');
    assert.equal(store.lastRosChoice().model?.model, 'gone');
  } finally { store.close(); rmSync(dir, { recursive:true, force:true }); }
});

test('ROS runs a project that has not chosen with the last agent or model way chosen anywhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-last-backend-'));
  const store = new Store(dir), execution = new ExecutionService(store, { includeSetupUsage: false });
  const assistant = new AssistantService(store, execution, { authority: { policy: () => ({ stopped: false, mode: 'review' }) } } as unknown as ExperimentService);
  try {
    const first = store.createProject('First'), second = store.createProject('Second');
    assert.equal(assistant.state(first.id).backend, 'provider');
    assistant.setBackend(first.id, { backend:'codex' });
    assert.equal(assistant.state(second.id).backend, 'codex');
    assert.equal(assistant.state(store.createProject('Third').id).backend, 'codex');
    assistant.setBackend(second.id, { backend:'provider' });
    assert.equal(assistant.state(first.id).backend, 'codex');
    assert.equal(assistant.state(second.id).backend, 'provider');
  } finally { store.close(); rmSync(dir, { recursive:true, force:true }); }
});
