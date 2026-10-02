import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlineHierarchy } from '../src/shared/outline-hierarchy.js';
import type { OutlineEntry, AssistantReference } from '../src/shared/assistant.js';
import type { Artifact, ProjectDetail, Run } from '../src/shared/types.js';

const direction = (id: string): OutlineEntry => ({ id: `direction-${id}`, nodeId: id, kind: 'direction', title: id, summary: 'Saved purpose', references: [] });
const finding = (id: string, references: AssistantReference[] = [], nodeId?: string): OutlineEntry => ({ id, kind: 'finding', title: 'Saved finding', summary: 'Saved observation', references, ...(nodeId ? { nodeId } : {}) });
const ref = (kind: AssistantReference['kind'], id: string, nodeId?: string): AssistantReference => ({ kind, id, label: id, ...(nodeId ? { nodeId } : {}) });
function context(): Pick<ProjectDetail, 'project' | 'artifacts' | 'runs' | 'messages'> {
  const nodes = ['a', 'b', 'nested'].map(id => ({ id, title: id, description: '', x: 0, y: 0, ...(id === 'nested' ? { parentId: 'a' } : {}) }));
  const run: Run = { id: 'run-b', projectId: 'project', nodeId: 'b', node: nodes[1], request: 'Saved request', useSearch: false, status: 'completed', createdAt: '2026-09-23T00:00:00Z', projectRevision: 0, inputs: [], messages: [], provider: 'fixture', model: 'fixture', modelVersion: null, configuration: {}, tools: [], events: [], artifactIds: [] };
  const artifact: Artifact = { id: 'artifact-a', projectId: 'project', nodeId: 'a', runId: 'run-a', kind: 'result', title: 'Saved output', content: 'Saved observation', hash: 'hash', createdAt: '2026-09-23T00:00:00Z' };
  return { project: { id: 'project', title: 'Fixture', canvas: { nodes, connections: [{ id: 'connection', source: 'a', target: 'b', label: 'uses data from' }] }, revision: 0, createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' }, artifacts: [artifact], runs: [run], messages: [{ id: 'message-b', projectId: 'project', nodeId: 'b', role: 'assistant', content: 'Saved node discussion', createdAt: '2026-09-23T00:00:00Z' }] };
}

test('nests directions only by actual parent ownership and keeps stable sibling order', () => {
  const hierarchy = buildOutlineHierarchy([direction('b'), direction('nested'), direction('a')], context());
  assert.deepEqual(hierarchy.directions.map(branch => branch.entry.nodeId), ['b', 'a']);
  assert.deepEqual(hierarchy.directions[1].children.map(branch => branch.entry.nodeId), ['nested']);
  assert.equal(hierarchy.directionCount, 3);
  assert.equal(hierarchy.directions[0].children.length, 0);
});

test('maps findings from actual node, artifact, run and message ownership without trusting stale reference hints', () => {
  const entries = [direction('a'), direction('b'), finding('node', [ref('node', 'a')]), finding('artifact', [ref('artifact', 'artifact-a', 'b')]), finding('run', [ref('run', 'run-b', 'a')]), finding('message', [ref('message', 'message-b')])];
  const hierarchy = buildOutlineHierarchy(entries, context());
  assert.deepEqual(hierarchy.directions[0].findings.map(entry => entry.id), ['node', 'artifact']);
  assert.deepEqual(hierarchy.directions[1].findings.map(entry => entry.id), ['run', 'message']);
  assert.equal(hierarchy.findingCount, 4);
});

test('explicit direction ownership keeps a finding with its note even when it cites another direction', () => {
  const hierarchy = buildOutlineHierarchy([direction('a'), direction('b'), finding('owned', [ref('artifact', 'artifact-a')], 'b')], context());
  assert.equal(hierarchy.directions[0].findings.length, 0);
  assert.deepEqual(hierarchy.directions[1].findings.map(entry => entry.id), ['owned']);
});

test('shared findings are shown once across directions and unassigned findings stay separate', () => {
  const entries = [direction('a'), direction('b'), finding('shared', [ref('node', 'a'), ref('run', 'run-b')]), finding('unassigned'), finding('stale', [ref('artifact', 'missing-artifact', 'a')]), finding('missing-node', [ref('node', 'deleted')])];
  const hierarchy = buildOutlineHierarchy(entries, context());
  assert.deepEqual(hierarchy.sharedFindings.map(entry => entry.id), ['shared']);
  assert.deepEqual(hierarchy.unassignedFindings.map(entry => entry.id), ['unassigned', 'stale', 'missing-node']);
  assert(hierarchy.directions.every(branch => !branch.findings.length));
});

test('repeated references to one direction do not turn a finding into a cross-direction claim', () => {
  const hierarchy = buildOutlineHierarchy([direction('a'), finding('single', [ref('node', 'a'), ref('artifact', 'artifact-a'), ref('node', 'a')])], context());
  assert.deepEqual(hierarchy.directions[0].findings.map(entry => entry.id), ['single']);
  assert.equal(hierarchy.sharedFindings.length, 0);
});

test('foreign or missing evidence never invents an association and inputs remain unchanged', () => {
  const detail = context();
  detail.artifacts.push({ ...detail.artifacts[0], id: 'foreign', projectId: 'other-project' });
  const entries = [direction('a'), finding('foreign', [ref('artifact', 'foreign', 'a')])];
  const before = structuredClone({ entries, detail });
  const hierarchy = buildOutlineHierarchy(entries, detail);
  assert.deepEqual(hierarchy.unassignedFindings.map(entry => entry.id), ['foreign']);
  assert.deepEqual({ entries, detail }, before);
});

test('malformed cyclic parents remain visible instead of hiding directions or recursing forever', () => {
  const detail = context();
  detail.project.canvas.nodes[0].parentId = 'b';
  detail.project.canvas.nodes[1].parentId = 'a';
  const hierarchy = buildOutlineHierarchy([direction('a'), direction('b')], detail);
  assert.equal(hierarchy.directions.length, 2);
  assert(hierarchy.directions.every(branch => !branch.children.length));
});
