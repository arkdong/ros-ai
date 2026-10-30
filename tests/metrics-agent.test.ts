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

const SITE = '11111111-2222-3333-4444-555555555555', OTHER = '99999999-2222-3333-4444-555555555555';
const PROJECT = '22222222-2222-3333-4444-555555555555', PERSONAL = '33333333-2222-3333-4444-555555555555', SERVICE = '44444444-2222-3333-4444-555555555555';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A stand-in GitHub, Umami Cloud and Railway: two Umami websites, a personal Railway project and one in a workspace.
function services() {
  const state = { sites: [{ id: SITE, name: 'ros.ai', domain: 'ros-ai.io' }, { id: OTHER, name: 'AISO', domain: 'aiso.nl' }] as unknown, personal: [{ node: { id: PERSONAL, name: 'Side project' } }], workspaces: { data: { me: { workspaces: [{ id: 'ws-1' }] } } } as unknown };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/arkdong/ros-ai')) {
      if (url.includes('/releases')) return json([{ assets: [{ download_count: 15 }, { download_count: 23 }] }]);
      if (url.includes('/traffic/')) return json({}, 403);
      return json({ full_name: 'arkdong/ros-ai', html_url: 'https://github.com/arkdong/ros-ai', stargazers_count: 12, forks_count: 1, subscribers_count: 2 });
    }
    if (url.startsWith('https://api.umami.is/v1/')) {
      assert.equal((init?.headers as Record<string, string>)['x-umami-api-key'], 'umami-key');
      if (url.includes('/websites?')) return json(state.sites);
      if (url.endsWith(`/websites/${SITE}`)) return json({ name: 'ros.ai', domain: 'ros-ai.io' });
      if (url.includes('/stats?')) return json({ visitors: { value: 80 }, pageviews: 300, visits: 99 });
      if (url.endsWith('/active')) return json({ visitors: 2 });
      if (url.includes('type=event')) return json([{ x: 'get_click', y: 9 }, { x: 'download', y: 7 }]);
    }
    if (url.startsWith('https://backboard.railway.com/')) {
      const { query, variables } = JSON.parse(String(init!.body)) as { query: string; variables: Record<string, string> };
      if (query.startsWith('query { projects')) return json({ data: { projects: { edges: state.personal } } });
      if (query.includes('me { workspaces')) return json(state.workspaces);
      if (query.includes('projects(workspaceId')) return json({ data: { projects: { edges: variables.w === 'ws-1' ? [{ node: { id: PROJECT, name: 'ros-ai cloud' } }] : [] } } });
      if (query.includes('project(id')) return json({ data: { project: variables.id === PROJECT ? { name: 'ros-ai cloud', services: { edges: [{ node: { id: SERVICE, name: 'cloud' } }] } } : null } });
      if (query.includes('deployments')) return json({ data: { s0: { edges: [{ node: { status: 'SUCCESS', createdAt: new Date().toISOString() } }] } } });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { state, views: new MetricViews(undefined, { fetch: fetcher, umamiKey: () => 'umami-key', railwayToken: () => 'railway-token' }) };
}
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-metrics', 'claude');
const problem = async (views: MetricViews, given: Record<string, unknown>) => { try { await views.find(given); return 'found'; } catch (error) { return (error as Error).message; } };

test('An Umami website is found by its domain, link, name or ID, and a Railway project by its name in any workspace, or as the only one', async () => {
  const { state, views } = services();
  for (const website of ['ros-ai.io', 'https://www.ros-ai.io/download', 'ROS-AI.IO', 'ros.ai', SITE.toUpperCase(), `https://cloud.umami.is/websites/${SITE}/overview`]) assert.deepEqual(await views.find({ source: 'umami', website }), { source: 'umami', website: SITE }, website);
  assert.match(await problem(views, { source: 'umami' }), /reaches 2 websites: ros-ai\.io \(1111.*aiso\.nl/u);
  assert.match(await problem(views, { source: 'umami', website: 'example.com' }), /^No website matches "example\.com"/u);
  state.sites = { data: [{ id: SITE, name: 'ros.ai', domain: 'ros-ai.io' }] };
  assert.deepEqual(await views.find({ source: 'umami' }), { source: 'umami', website: SITE });

  assert.deepEqual(await views.find({ source: 'railway', project: 'ros-ai cloud' }), { source: 'railway', project: PROJECT });
  assert.deepEqual(await views.find({ source: 'railway', project: `https://railway.com/project/${PROJECT}/service/x` }), { source: 'railway', project: PROJECT });
  assert.match(await problem(views, { source: 'railway' }), /reaches 2 projects/u);
  // A Railway that cannot list workspaces still lists the account's own projects.
  state.workspaces = { errors: [{ message: 'Cannot query field "workspaces" on type "User".' }] };
  assert.deepEqual(await views.find({ source: 'railway' }), { source: 'railway', project: PERSONAL });

  const bare = new MetricViews(undefined, { fetch: (async () => json({}, 500)) as typeof fetch });
  assert.match(await problem(bare, { source: 'umami', website: 'ros-ai.io' }), /Connect Umami on the Plugins page/u);
  assert.match(await problem(bare, { source: 'railway' }), /Connect Railway on the Plugins page/u);
});

test('Agents add a Metrics block per source that answers; one that cannot be read or is already on the canvas is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-metrics-')), store = new Store(join(dir, 'store')), { views } = services();
  const before = AgentWorkspaceTools.metrics;
  AgentWorkspaceTools.metrics = views;
  try {
    const project = store.createProject('Launch stats');
    assert(toolkit(store, project.id).definitions.some(tool => tool.name === 'ros_add_metrics'));
    type Added = { action: { proposalId: string }; committed: boolean; added: { nodeId: string; title: string; metric: { values: { key: string; value?: number | null; state?: string }[] } }[]; alreadyOnCanvas?: { title: string }[]; notAdded?: { source: string; asked?: string; problem: string }[] };
    const first = await toolkit(store, project.id).call('ros_add_metrics', { summary: 'Launch numbers', rationale: 'The person asked for downloads and usage.', blocks: [
      { source: 'github', repo: 'https://github.com/arkdong/ros-ai' }, { source: 'github', repo: 'arkdong/ros-ai' },
      { source: 'umami', website: 'ros-ai.io' }, { source: 'railway', project: 'ros-ai cloud' }, { source: 'umami' }, { source: 'cloud' },
    ] }) as Added;
    assert.equal(first.committed, false);
    assert.deepEqual(first.added.map(block => block.title), ['arkdong/ros-ai', 'ros-ai.io', 'ros-ai cloud']);
    assert.equal(first.added[0].metric.values.find(value => value.key === 'downloads')?.value, 38);
    assert.equal(first.added[1].metric.values.find(value => value.key === 'event:download')?.value, 7);
    assert.match(first.added[2].metric.values.find(value => value.key === `service:${SERVICE}`)?.state ?? '', /^Online/u);
    // The Umami website left out is ambiguous, and ros.ai cloud is off here: both come back with what to do.
    assert.deepEqual(first.notAdded?.map(item => item.source), ['Umami', 'ros.ai cloud']);
    assert.match(first.notAdded![0].problem, /Name one by its domain or ID/u);

    store.acceptProposal(project.id, first.action.proposalId);
    const blocks = store.getProject(project.id).canvas.nodes.filter(node => node.blockType === 'metric');
    assert.deepEqual(blocks.map(node => node.metric), [{ source: 'github', repo: 'arkdong/ros-ai' }, { source: 'umami', website: SITE }, { source: 'railway', project: PROJECT }]);
    assert.equal(new Set(blocks.map(node => `${node.x}:${node.y}`)).size, 3);

    // Asking again adds nothing twice, and proposes nothing when every source is there.
    const again = await toolkit(store, project.id).call('ros_add_metrics', { summary: 'Again', rationale: 'Asked twice.', blocks: [{ source: 'github', repo: 'ARKDONG/ros-ai' }, { source: 'railway', project: PROJECT }] }) as Added;
    assert.equal(again.committed, false);
    assert.equal(again.action, undefined);
    assert.deepEqual(again.alreadyOnCanvas?.map(block => block.title), ['arkdong/ros-ai', 'ros-ai cloud']);
    assert.equal(store.detail(project.id).proposals.filter(item => item.status === 'pending').length, 0);
  } finally {
    AgentWorkspaceTools.metrics = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
