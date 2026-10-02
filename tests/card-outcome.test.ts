import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCardOutcome } from '../src/shared/card-outcome.js';
import type { Artifact, CanvasNode, Run } from '../src/shared/types.js';

const node: CanvasNode = { id: 'note', title: 'Research question', description: 'Compare monthly observations. Preserve all original assumptions.', x: 0, y: 0 };
const run = (id: string, patch: Partial<Run> = {}): Run => ({ id, projectId: 'project', nodeId: node.id, request: 'Investigate', useSearch: false, status: 'completed', createdAt: '2026-09-23T10:00:00Z', projectRevision: 1, node, inputs: [], messages: [], provider: 'local', model: 'python', modelVersion: null, configuration: { kind: 'local-experiment', backend: 'docker-python' }, tools: [], events: [], artifactIds: [], ...patch });
const artifact = (id: string, runId: string, patch: Partial<Artifact> = {}): Artifact => ({ id, projectId: 'project', nodeId: node.id, runId, kind: 'result', title: 'Conclusion', content: 'Monthly aggregates computed from daily observations. Means use days without missing hours. This is a third sentence.', hash: id, createdAt: '2026-09-23T10:01:00Z', mediaType: 'text/plain', ...patch });

test('uses saved conclusion sentences instead of the generic purpose without mutating records', () => {
  const inputs = { node, runs: [run('done')], artifacts: [artifact('result', 'done')] };
  const before = structuredClone(inputs);
  const outcome = deriveCardOutcome(inputs.node, inputs.runs, inputs.artifacts);
  assert.equal(outcome.text, 'Monthly aggregates computed from daily observations. Means use days without missing hours.');
  assert.equal(outcome.hasResult, true);
  assert.equal(outcome.label, 'Saved outcome');
  assert.deepEqual(outcome.artifactIds, ['result']);
  assert.deepEqual(inputs, before);
});

test('uses the newest successful outcome independently of incoming array order and excludes unrelated records', () => {
  const runs = [run('old'), run('new', { createdAt: '2026-09-23T11:00:00Z' }), run('other', { projectId: 'other', createdAt: '2026-09-23T12:00:00Z' })];
  const artifacts = [artifact('old-result', 'old'), artifact('new-result', 'new', { content: 'Updated observations are saved.' }), artifact('other-result', 'other', { projectId: 'other', content: 'Unrelated result.' }), artifact('orphan', 'absent', { content: 'No known run.' })];
  const outcome = deriveCardOutcome(node, runs, artifacts, { projectId: 'project' });
  assert.equal(outcome.text, 'Updated observations are saved.');
  assert.deepEqual(outcome.artifactIds, ['new-result']);
});

test('keeps failure visible and distinguishes the previous successful result', () => {
  const outcome = deriveCardOutcome(node, [run('done'), run('failed', { status: 'failed', createdAt: '2026-09-23T11:00:00Z', error: 'Required input column was missing.' })], [artifact('result', 'done'), artifact('partial', 'failed', { content: 'Do not promote partial output.' })]);
  assert.equal(outcome.label, 'Attempt failed');
  assert.equal(outcome.tone, 'danger');
  assert.equal(outcome.text, 'The latest attempt failed: Required input column was missing. Earlier result: Monthly aggregates computed from daily observations.');
  assert.deepEqual(outcome.artifactIds, ['result']);
  assert.equal(outcome.runId, 'failed');
});

test('reports active work and pending approval without claiming that it finished', () => {
  const done = run('done');
  const running = run('active', { status: 'running', createdAt: '2026-09-23T11:00:00Z' });
  assert.match(deriveCardOutcome(node, [done, running], [artifact('result', 'done')]).text, /running.*Earlier result/u);
  const pending = run('pending', { status: 'queued', configuration: { kind: 'local-experiment', approval: { status: 'pending' } } });
  const outcome = deriveCardOutcome(node, [pending], [artifact('input', 'pending', { kind: 'dataset' })]);
  assert.equal(outcome.label, 'Approval needed');
  assert.equal(outcome.hasResult, false);
  assert.equal(outcome.artifactIds.length, 0);
});

test('uses explicit captured/current runtime gates rather than names or descriptions', () => {
  const remote = run('remote', { status: 'interrupted', configuration: { kind: 'local-experiment', backend: 'nebius-sandbox', capabilities: { nebiusSandbox: { available: true, costGate: { ready: false, reason: 'Sandbox pricing has not been verified.' } } } } });
  assert.equal(deriveCardOutcome(node, [remote], []).label, 'Blocked');
  assert.equal(deriveCardOutcome(node, [remote], []).text, 'Sandbox pricing has not been verified.');
  assert.equal(deriveCardOutcome(node, [remote], [], { blockers: { 'nebius-sandbox': 'The current sandbox allowance is exhausted.' } }).text, 'The current sandbox allowance is exhausted.');
  assert.equal(deriveCardOutcome(node, [remote], [], { blockers: { 'nebius-sandbox': '' } }).label, 'Interrupted');
  assert.equal(deriveCardOutcome({ ...node, title: 'Nebius blocked', description: 'Pricing blocked.' }, [], []).label, 'Purpose');
  assert.equal(deriveCardOutcome(node, [{ ...remote, status: 'completed' }], [artifact('result', 'remote')]).label, 'Saved outcome');
});

test('does not turn uncertain remote execution into a pricing-only blocker or success', () => {
  const remote = run('remote', { status: 'interrupted', configuration: { kind: 'local-experiment', backend: 'nebius-sandbox', remote: { phase: 'uncertain' } } });
  assert.equal(deriveCardOutcome(node, [remote], [], { blockers: { 'nebius-sandbox': 'No allowance.' } }).label, 'Outcome uncertain');
});

test('describes imported datasets and source excerpts as saved evidence, not execution', () => {
  const imported = run('imported', { configuration: { kind: 'file-import' } });
  const searched = run('searched', { configuration: { purpose: 'assistant-search' }, createdAt: '2026-09-23T11:00:00Z' });
  const outcome = deriveCardOutcome(node, [imported, searched], [artifact('csv', 'imported', { kind: 'dataset' }), artifact('source', 'searched', { kind: 'source', capture: 'search-snippet' })]);
  assert.equal(outcome.label, 'Evidence saved');
  assert.equal(outcome.text, 'Available for inspection: 1 captured dataset and 1 saved source (including search excerpts).');
  assert.equal(outcome.hasResult, true);
  assert.deepEqual(outcome.artifactIds, ['csv', 'source']);
  assert.doesNotMatch(outcome.text, /execut|verified/u);
});

test('presents only supported scalar metrics when prose is absent', () => {
  const outcome = deriveCardOutcome(node, [run('done')], [artifact('bad', 'done', { kind: 'metric', content: '{broken' }), artifact('object', 'done', { kind: 'metric', content: '{"value":{"x":1}}' }), artifact('mean', 'done', { kind: 'metric', title: 'Mean temperature (°C)', content: '{"value":11.97}' }), artifact('rain', 'done', { kind: 'metric', title: 'Precipitation (mm)', content: '{"value":1047}' })]);
  assert.equal(outcome.text, 'Mean temperature (°C) was 11.97; Precipitation (mm) was 1047.');
  assert.deepEqual(outcome.artifactIds, ['mean', 'rain']);
});

test('distinguishes a plan from execution and shows a short purpose before any work', () => {
  assert.equal(deriveCardOutcome(node, [], []).text, 'Compare monthly observations.');
  const planned = run('plan', { configuration: { purpose: 'experiment-plan' } });
  assert.equal(deriveCardOutcome(node, [planned], []).label, 'Plan ready');
  assert.equal(deriveCardOutcome(node, [planned], []).hasResult, false);
});

test('removes display markup and reference-only UUID parentheticals while bounding long text', () => {
  const content = '# Summary\nRobustness check reusing monthly summary CSV (artifact bed64ad7-ff2c-4c1d-a4b8-3fdae3450a28). Equal-month and day-weighted means differ slightly. More detail stays saved.';
  const outcome = deriveCardOutcome(node, [run('done')], [artifact('result', 'done', { content })]);
  assert.doesNotMatch(outcome.text, /bed64ad7/u);
  assert.match(outcome.text, /means differ slightly/u);
  assert.deepEqual(outcome.artifactIds, ['result']);
  const long = deriveCardOutcome(node, [run('done'), run('failed', { status: 'failed', createdAt: '2026-09-23T12:00:00Z', error: 'Long failure message '.repeat(60) })], [artifact('result', 'done', { content: 'Long saved finding '.repeat(60) })]);
  assert(Array.from(long.text).length <= 320);
});
