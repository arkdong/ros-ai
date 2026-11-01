import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { MetricViews } from '../src/server/metric-view.js';
import { dailyValues, dashboardSections, tilesFor } from '../src/shared/dashboards.js';
import { kindName } from '../src/shared/vocabulary.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A stand-in GitHub that answers for arkdong/ros-ai.
const views = () => new MetricViews(undefined, { fetch: (async (input: string | URL) => {
  const url = String(input);
  if (url.includes('/releases')) return json([{ assets: [{ download_count: 15 }, { download_count: 23 }] }]);
  if (url.includes('/traffic/')) return json({ uniques: 4, count: 9 });
  if (url.startsWith('https://api.github.com/repos/arkdong/ros-ai')) return json({ full_name: 'arkdong/ros-ai', html_url: 'https://github.com/arkdong/ros-ai', stargazers_count: 12, forks_count: 1, subscribers_count: 2 });
  return json({}, 404);
}) as typeof fetch });
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-dashboard', 'claude');

test('Tiles: one per number, a funnel over several; sections keep their order; bars keep the last read of each day', () => {
  let n = 0; const id = () => `t${++n}`;
  assert.deepEqual(tilesFor('m', ['stars', 'forks'], 'line', ' Acquisition ', id), [{ id: 't1', block: 'm', keys: ['stars'], show: 'line', section: 'Acquisition' }, { id: 't2', block: 'm', keys: ['forks'], show: 'line', section: 'Acquisition' }]);
  assert.deepEqual(tilesFor('m', ['a', 'b', 'c'], 'funnel', undefined, id), [{ id: 't3', block: 'm', keys: ['a', 'b', 'c'], show: 'funnel' }]);
  const tiles = [{ id: '1', block: 'm', keys: ['a'], show: 'number' as const, section: 'Engagement' }, { id: '2', block: 'm', keys: ['b'], show: 'number' as const }, { id: '3', block: 'm', keys: ['c'], show: 'number' as const, section: 'Acquisition' }, { id: '4', block: 'm', keys: ['d'], show: 'number' as const, section: 'Engagement' }];
  assert.deepEqual(dashboardSections(tiles).map(item => [item.section, item.tiles.map(tile => tile.id)]), [['', ['2']], ['Engagement', ['1', '4']], ['Acquisition', ['3']]]);
  const history = [{ at: '2026-10-30T08:00:00Z', values: { a: 1 } }, { at: '2026-10-30T20:00:00Z', values: { a: 3 } }, { at: '2026-10-31T09:00:00Z', values: { a: 5 } }];
  assert.deepEqual(dailyValues(history, 'a'), [{ day: '2026-10-30', value: 3 }, { day: '2026-10-31', value: 5 }]);
  assert.equal(kindName({ blockType: 'dashboard' }), 'Dashboard');
});

test('A Dashboard block keeps only well-formed tiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-dashboard-')), store = new Store(join(dir, 'store'));
  try {
    const project = store.createProject('Launch');
    const add = (tiles: unknown) => store.mutate(project.id, [{ type: 'addNode', node: { id: `d${Math.random().toString(36).slice(2, 8)}`, title: 'Dashboard', description: '', kind: 'topic', blockType: 'dashboard', dashboard: { tiles }, x: 0, y: 0 } } as never], 'Add');
    add([{ id: 't1', block: 'm', keys: ['stars'], show: 'number' }, { id: 't2', block: 'm', keys: ['a', 'b'], show: 'funnel', section: 'Activation' }]);
    assert.throws(() => add([{ id: 't3', block: 'm', keys: ['a'], show: 'funnel' }]), /funnel tile names two or more/u);
    assert.throws(() => add([{ id: 't4', block: 'm', keys: ['a', 'b'], show: 'number' }]), /funnel tile names two or more/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Agents pin numbers from Metrics blocks onto a new or an existing dashboard; bad keys and blocks are reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-dashboard-')), store = new Store(join(dir, 'store'));
  const before = AgentWorkspaceTools.metrics;
  AgentWorkspaceTools.metrics = views();
  try {
    const project = store.createProject('Launch');
    store.mutate(project.id, [
      { type: 'addNode', node: { id: 'gh', title: 'arkdong/ros-ai', description: '', kind: 'topic', blockType: 'metric', metric: { source: 'github', repo: 'arkdong/ros-ai' }, x: 0, y: 0 } },
      { type: 'addNode', node: { id: 'note', title: 'Plan', description: 'Launch plan', kind: 'topic', x: 500, y: 0 } },
    ], 'Fixture');
    assert(toolkit(store, project.id).definitions.some(tool => tool.name === 'ros_pin_to_dashboard'));
    const first = await toolkit(store, project.id).call('ros_pin_to_dashboard', { summary: 'Launch dashboard', rationale: 'Asked for one place with the numbers.', title: 'Launch', tiles: [
      { block: 'gh', keys: ['stars', 'downloads'], show: 'line', section: 'Acquisition' },
      { block: 'gh', keys: ['visitors', 'cloners'], show: 'funnel', section: 'Activation' },
      { block: 'gh', keys: ['nope'], show: 'number' },
      { block: 'note', keys: ['x'], show: 'number' },
    ] }) as { action: { proposalId: string }; committed: boolean; dashboard: { nodeId: string; new: boolean }; pinned: { numbers: { key: string; value: number | null }[] }[]; notPinned: { problem: string; keysItHas?: { key: string }[] }[] };
    assert.equal(first.committed, false);
    store.acceptProposal(project.id, first.action.proposalId);
    assert.equal(first.dashboard.new, true);
    assert.deepEqual(first.pinned.map(tile => tile.numbers.map(item => [item.key, item.value])), [[['stars', 12]], [['downloads', 38]], [['visitors', 4], ['cloners', 4]]]);
    assert.equal(first.notPinned.length, 2);
    assert.match(first.notPinned[0].problem, /gives no number with this key/u);
    assert(first.notPinned[0].keysItHas!.some(item => item.key === 'forks'));
    assert.match(first.notPinned[1].problem, /not a Metrics block/u);
    const dashboard = store.getProject(project.id).canvas.nodes.find(node => node.id === first.dashboard.nodeId)!;
    assert.equal(dashboard.blockType, 'dashboard');
    assert.equal(dashboard.title, 'Launch');
    assert.deepEqual(dashboard.dashboard!.tiles.map(tile => [tile.show, tile.keys, tile.section]), [['line', ['stars'], 'Acquisition'], ['line', ['downloads'], 'Acquisition'], ['funnel', ['visitors', 'cloners'], 'Activation']]);

    const again = await toolkit(store, project.id).call('ros_pin_to_dashboard', { summary: 'Forks too', rationale: 'Asked.', dashboard: dashboard.id, tiles: [{ block: 'gh', keys: ['forks'], show: 'number', label: 'Forks so far' }] }) as { action: { proposalId: string }; dashboard: { new: boolean } };
    assert.equal(again.dashboard.new, false);
    store.acceptProposal(project.id, again.action.proposalId);
    const tiles = store.getProject(project.id).canvas.nodes.find(node => node.id === dashboard.id)!.dashboard!.tiles;
    assert.equal(tiles.length, 4);
    assert.equal(tiles[3].label, 'Forks so far');
    await assert.rejects(toolkit(store, project.id).call('ros_pin_to_dashboard', { summary: 'x', rationale: 'y', dashboard: 'note', tiles: [{ block: 'gh', keys: ['forks'], show: 'number' }] }), /No Dashboard block has the nodeId note/u);
    const read = await toolkit(store, project.id).call('ros_read_canvas', {}) as { nodes?: { id: string; dashboard?: { tiles: unknown[] } }[] };
    const shown = JSON.stringify(read);
    assert(shown.includes('ros_pin_to_dashboard and this nodeId') || shown.includes('"dashboard"'), 'ros_read_canvas names the dashboard');
  } finally { AgentWorkspaceTools.metrics = before; rmSync(dir, { recursive: true, force: true }); }
});
