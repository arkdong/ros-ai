/** One task, run through ros.ai's real agent loop in a throwaway workspace: the same Store, tool
 * validation, scope checks, approvals and message clipping the app uses, so every tool result in
 * a sample is one ros.ai really produced. Only the model and the web are swapped in. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { Authority } from '../../src/server/authority.js';
import { ExecutionService } from '../../src/server/execution.js';
import { ExperimentService } from '../../src/server/experiments.js';
import { SandboxBudget } from '../../src/server/sandbox-budget.js';
import type { ExecutionBackend, SandboxCapabilities } from '../../src/server/sandbox.js';
import { ToolLoopAgentService } from '../../src/server/tool-loop-agent.js';
import { AgentWorkspaceTools } from '../../src/server/agent-tools.js';
import { NotionApi } from '../../src/server/notion.js';
import { seedDemo } from '../../src/server/demo.js';
import type { ChatMessage, ModelAdapter, ModelRequest, ModelResponse, SearchAdapter } from '../../src/server/providers.js';
import type { AgentEvent } from '../../src/shared/agent-runtime.js';
import type { BlockType, CanvasNode, Mutation, Run } from '../../src/shared/types.js';

/** A project as the teacher writes it: readable slugs that become UUIDs, like ids in the app. */
export type Fixture = {
  id: string; title: string; domain: string;
  blocks: { slug: string; title: string; text: string; blockType?: BlockType; group?: string; csv?: { fileName: string; content: string } }[];
  groups?: { slug: string; title: string }[];
  links?: { from: string; to: string; label: string }[];
  /** 'demo' builds the bundled KNMI weather project instead (the 19 October comparison's tasks). */
  seed?: 'demo';
};
export type Family = 'overview' | 'read-answer' | 'dataset' | 'add-notes' | 'edit-existing' | 'analysis' | 'research' | 'research-declined' | 'report' | 'cannot-do';
export type Task = {
  id: string; fixtureId: string; family: Family; message: string;
  /** Block slugs (or titles, for the demo project) the researcher has selected; empty means nothing selected. */
  selection: string[];
  mode: 'ask' | 'review' | 'full';
  /** How the simulated researcher answers a search plan that waits for approval. */
  researcher?: 'accept' | 'decline';
  preferences?: string;
  /** The Notion tools are offered (nothing shared yet), so the sample carries that tool list too. */
  notion?: boolean;
  /** What a good turn must do; the checks read these. */
  expect?: { tools?: string[]; avoid?: string[]; mentions?: string[] };
};
export type Turn = { request: ChatMessage[]; tools?: ModelRequest['tools']; response: ModelResponse };
export type Trajectory = {
  taskId: string; fixtureId: string; family: Family; mode: Task['mode']; model: string; at: string;
  status: 'completed' | 'failed'; error?: string; seconds: number;
  /** Exactly what the model saw in its last request, plus its final answer: the training sample. */
  messages: ChatMessage[]; reply: string;
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  calls: { name: string; failed: boolean; message: string }[];
  proposals: { status: string; operations: string[] }[];
  findings: number; quotesRefused: number; requests: number;
  ids: string[];
};

const now = () => new Date().toISOString();
/** Python as the app offers it, except that nothing runs: analysis tasks wait for approval, so no sample needs a real run. */
const python: SandboxCapabilities = { available: true, backend: 'docker-python', policy: 'training-fixture', runtime: 'Python 3.12 with pandas, NumPy, matplotlib and SciPy', workerHash: 'training-worker', imageId: 'training-image', libraries: { pandas: '2.2.3', numpy: '2.2.6', matplotlib: '3.10.3', scipy: '1.15.3' }, enforcement: ['No network', 'Read-only input copy'], limitations: ['Training fixture: approval is never given'], timeoutMs: 60000, maxMemoryMb: 1024, maxOutputBytes: 2000000 };
const sandbox: ExecutionBackend = { capabilities: () => structuredClone(python), start() { throw new Error('Training runs never execute code.'); } };
const notionStub = () => new NotionApi(() => 'training-stub', async () => new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

function build(store: Store, fixture: Fixture) {
  const project = store.createProject(fixture.title);
  if (fixture.seed === 'demo') { seedDemo(store, project.id); return { projectId: project.id, ids: new Map(store.getProject(project.id).canvas.nodes.map(node => [node.title, node.id])) }; }
  const ids = new Map<string, string>();
  for (const item of [...fixture.groups ?? [], ...fixture.blocks]) ids.set(item.slug, randomUUID());
  const operations: Mutation[] = [];
  (fixture.groups ?? []).forEach((group, index) => operations.push({ type: 'addNode', node: { id: ids.get(group.slug)!, title: group.title, description: '', kind: 'group', x: index * 900, y: 600 } }));
  fixture.blocks.forEach((block, index) => {
    const node: CanvasNode = { id: ids.get(block.slug)!, title: block.title, description: block.text, kind: block.blockType === 'action' ? 'activity' : 'topic', blockType: block.csv ? 'dataset' : block.blockType ?? 'note', parentId: block.group ? ids.get(block.group) ?? null : null, x: (index % 4) * 480, y: Math.floor(index / 4) * 360 };
    operations.push({ type: 'addNode', node });
  });
  for (const link of fixture.links ?? []) if (ids.has(link.from) && ids.has(link.to)) operations.push({ type: 'addConnection', connection: { id: randomUUID(), source: ids.get(link.from)!, target: ids.get(link.to)!, label: link.label } });
  store.mutate(project.id, operations, 'Training fixture');
  for (const block of fixture.blocks) if (block.csv) {
    const nodeId = ids.get(block.slug)!, node = store.getProject(project.id).canvas.nodes.find(item => item.id === nodeId)!;
    // The same shape as a CSV the researcher adds from their computer (connections.ts capture).
    const run: Run = { id: randomUUID(), projectId: project.id, nodeId, request: `Import selected CSV: ${block.csv.fileName}`, useSearch: false, status: 'running', createdAt: now(), startedAt: now(), projectRevision: store.getProject(project.id).revision, node, inputs: [], messages: [], provider: 'local', model: 'local-file-connector-v1', modelVersion: null, configuration: { kind: 'file-import', fileName: block.csv.fileName }, tools: [], events: [], artifactIds: [] };
    store.createRun(run);
    const artifact = store.addArtifact({ projectId: project.id, nodeId, runId: run.id, kind: 'dataset', title: block.csv.fileName, content: block.csv.content, mediaType: 'text/csv', capture: 'full-content', metadata: { fileName: block.csv.fileName, origin: 'browser-upload' } });
    store.updateRun(run.id, { status: 'completed', endedAt: now(), artifactIds: [artifact.id] });
    store.mutate(project.id, [{ type: 'updateNode', id: nodeId, patch: { artifactId: artifact.id } }], 'Attach dataset');
  }
  return { projectId: project.id, ids };
}

/** Records every request the loop sends, so the last one is the whole conversation. */
class Recording implements ModelAdapter {
  readonly turns: Turn[] = [];
  constructor(private readonly inner: ModelAdapter) {}
  get provider() { return this.inner.provider; }
  get model() { return this.inner.model; }
  get configured() { return this.inner.configured; }
  prepare(signal: AbortSignal) { return this.inner.prepare(signal); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    const response = await this.inner.complete(request, signal);
    this.turns.push({ request: structuredClone(request.messages), tools: request.tools, response });
    return response;
  }
}

export async function rollout(task: Task, fixture: Fixture, model: ModelAdapter, web: SearchAdapter): Promise<Trajectory> {
  const directory = mkdtempSync(join(tmpdir(), 'ros-nemotron-')), store = new Store(directory), started = Date.now();
  const recording = new Recording(model);
  const execution = new ExecutionService(store, { model: recording, search: web, limits: { nebius: 1000, tavily: 1000 }, includeSetupUsage: false, maxConcurrent: 4, timeoutMs: 300_000 });
  const experiments = new ExperimentService(store, { sandbox, nebiusSandbox: sandbox, sandboxBudget: new SandboxBudget(store, {}) }), loop = new ToolLoopAgentService(store, execution, experiments);
  const { projectId, ids } = build(store, fixture);
  new Authority(store).configure(projectId, { mode: task.mode });
  const nodeIds = task.selection.map(slug => ids.get(slug)).filter((value): value is string => Boolean(value));
  const nodes = store.getProject(projectId).canvas.nodes;
  const artifactIds = nodeIds.flatMap(id => nodes.find(node => node.id === id)?.artifactId ?? []);
  // The simulated researcher: answers a waiting search plan the way the task says.
  const researcher = setInterval(() => {
    for (const proposal of store.detail(projectId).proposals ?? []) if (proposal.status === 'pending' && proposal.operations.some(op => op.type === 'addNode' && op.node.blockType === 'agent')) {
      if (task.researcher === 'decline') store.dismissProposal(projectId, proposal.id); else execution.acceptGovernedProposal(projectId, proposal.id);
    }
  }, 300);
  const events: AgentEvent[] = [];
  AgentWorkspaceTools.notion = task.notion ? notionStub() : undefined;
  AgentWorkspaceTools.apps = undefined;
  let reply = '', error: string | undefined;
  try {
    const result = await loop.execute({ projectId, nodeIds, artifactIds, turnId: randomUUID(), message: task.message, preferences: task.preferences, signal: AbortSignal.timeout(900_000), onEvent: event => events.push(event), selection: { provider: model.provider, model: model.model } } as Parameters<ToolLoopAgentService['execute']>[0]);
    reply = result.reply;
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  finally { clearInterval(researcher); }
  const last = recording.turns.at(-1);
  const detail = store.detail(projectId);
  // One entry per tool call (by its number), marked failed when ros.ai refused it.
  const byCall = new Map<number, Trajectory['calls'][number]>();
  for (const event of events) if (event.type === 'tool' && event.step) {
    const entry = byCall.get(event.step.call) ?? { name: event.step.tool, failed: false, message: event.message };
    if (event.step.outcome === 'failed') Object.assign(entry, { failed: true, message: event.message });
    byCall.set(event.step.call, entry);
  }
  const calls = [...byCall.values()];
  const trajectory: Trajectory = {
    taskId: task.id, fixtureId: task.fixtureId, family: task.family, mode: task.mode, model: model.model, at: now(),
    status: error ? 'failed' : 'completed', ...(error ? { error } : {}), seconds: Math.round((Date.now() - started) / 1000),
    messages: last ? [...last.request, ...(error ? [] : [{ role: 'assistant' as const, content: reply }])] : [], reply,
    tools: recording.turns[0]?.tools ?? [],
    calls,
    proposals: (detail.proposals ?? []).map(proposal => ({ status: proposal.status, operations: proposal.operations.map(op => op.type === 'addNode' ? `addNode:${op.node.blockType ?? op.node.kind ?? 'note'}` : op.type) })),
    findings: detail.project.canvas.nodes.filter(node => node.blockType === 'finding').length,
    // ros_write_findings saves the findings it can verify and lists the rest as rejected.
    quotesRefused: (last?.request ?? []).reduce((sum, message) => { if (message.role !== 'tool' || !message.content.includes('"rejected":[{')) return sum; try { return sum + ((JSON.parse(message.content) as { rejected?: unknown[] }).rejected?.length ?? 0); } catch { return sum; } }, 0),
    requests: recording.turns.length,
    ids: [...ids.values(), ...detail.artifacts.map(artifact => artifact.id)],
  };
  AgentWorkspaceTools.notion = undefined;
  await execution.shutdown(); await loop.shutdown(); store.close();
  rmSync(directory, { recursive: true, force: true });
  return trajectory;
}
