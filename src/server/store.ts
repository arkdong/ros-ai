import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { LAYOUT_GAP, freeSpot, groupContentRight } from '../shared/layout.js';
import { CARD_MIN_WIDTH, CARD_MAX_WIDTH, CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, CARD_MAX_SET_HEIGHT, cardWidth, cardFootprintHeight, estimatedCardHeight } from '../shared/card-size.js';
import { convertLegacyGroups, groupMembers } from '../shared/groups.js';
import { convertDecisionLogs } from '../shared/decisions.js';
import { DEFAULT_NEBIUS_MODEL, resolveModelSetting, type ModelSelection, type ProjectModelSettings } from '../shared/model-settings.js';
import { DOI, PAPER_ID } from '../shared/papers.js';
import { ACP_AGENT_IDS } from '../shared/acp-agents.js';
import { APP_SOURCE_LIMIT, MAX_APP_INPUTS, isHtmlLanguage } from '../shared/apps.js';
import type { Artifact, Canvas, CanvasNode, Change, Message, Mutation, Project, ProjectDetail, Proposal, Run, SelectedInput, UsageRecord } from '../shared/types.js';

/** A project that has not chosen for itself runs ROS with the last choice made anywhere. */
export type RosChoice = { backend?: string; model?: ModelSelection };

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const decisionSchema = z.object({ id: identifier, text: z.string().trim().min(1).max(2000), reason: z.string().trim().min(1).max(4000), at: z.iso.datetime(), basedOn: z.array(z.object({ artifactId: identifier, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(20), withdrawnAt: z.iso.datetime().optional() }).strict();
const nodeFields = { title: z.string().trim().min(1).max(200), description: z.string().max(20_000), x: coordinate, y: coordinate, width: z.number().int().min(CARD_MIN_WIDTH).max(CARD_MAX_WIDTH).optional(), height: z.number().int().min(CARD_MIN_HEIGHT).max(CARD_MAX_SET_HEIGHT).nullable().optional(), kind: z.enum(['topic', 'activity', 'unspecified', 'group']).optional(), parentId: identifier.nullable().optional(), blockType:z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file']).optional(), label:z.string().trim().max(40).optional(), file:z.object({path:z.string().trim().min(1).max(1000)}).strict().optional(), notion:z.object({url:z.string().trim().url().max(500),filter:z.string().trim().max(1000).optional(),columns:z.array(z.string().trim().min(1).max(100)).max(30).optional(),kind:z.enum(['database','page']).optional()}).strict().optional(), agent:z.object({runtime:z.enum(['claude','codex','model']),turnId:identifier}).strict().optional(), artifactId:identifier.optional(), code:z.object({language:z.string().trim().min(1).max(50),source:z.string().max(100_000),parameters:z.record(z.string().max(100),z.union([z.string().max(1000),z.number().finite(),z.boolean()])).refine(value=>Object.keys(value).length<=50),inputArtifactId:identifier.nullable().optional()}).strict().optional(), notebook:z.object({sessionId:identifier.optional(),path:z.string().max(1000)}).strict().optional(), legacyKind:z.enum(['topic','activity','unspecified']).optional(), groupHighlights:z.array(z.object({nodeId:identifier,artifactId:identifier,hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(3).optional() };
const connectionSchema = z.object({ id: identifier, source: identifier, target: identifier, label: z.string().max(200),sourceHandle:z.enum(['top','right','bottom','left']).optional(),targetHandle:z.enum(['top','right','bottom','left']).optional() }).strict();
const linkSide = z.enum(['top','right','bottom','left']);
/** The person's edit of a link on the canvas: its word, or its direction. Not offered to agents, whose canvas tool
 * keeps the shape of the training snapshot; they add and remove links. */
const updateConnectionSchema = z.object({ type: z.literal('updateConnection'), id: identifier, patch: z.object({ label: z.string().max(200).optional(), source: identifier.optional(), target: identifier.optional(), sourceHandle: linkSide.optional(), targetHandle: linkSide.optional() }).strict().refine(value => Object.keys(value).length > 0, 'An update must contain a change') }).strict();
const mutations = <T extends z.ZodRawShape>(fields: T) => z.discriminatedUnion('type', [
  z.object({ type: z.literal('addNode'), node: z.object({ id: identifier, ...fields }).strict() }).strict(),
  z.object({ type: z.literal('updateNode'), id: identifier, patch: z.object(fields).partial().strict().refine(value => Object.keys(value).length > 0, 'An update must contain a change') }).strict(),
  z.object({ type: z.literal('removeNode'), id: identifier }).strict(),
  z.object({ type: z.literal('addConnection'), connection: connectionSchema }).strict(),
  z.object({ type: z.literal('removeConnection'), id: identifier }).strict(),
]);
/** A Google Sheet or Doc shown live (see GoogleView), a Web block and a block's claim marks. Kept apart from nodeFields,
 * so the canvas tool agents see reads as the training snapshot has it while Google Drive is not connected; agents
 * cannot write a Web block or claim marks through it in any case (agent-tools.ts). */
const liveNodeFields = { ...nodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','google','web']).optional(), google: z.object({ fileId: z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/u), kind: z.enum(['sheet','doc']), sheet: z.string().trim().min(1).max(200).optional() }).strict().optional(), check:z.object({checkedAt:z.string().max(40),agentNodeId:identifier,textHash:z.string().regex(/^[a-f0-9]{64}$/),claims:z.array(z.object({text:z.string().max(400),verdict:z.enum(['backed','contradicted','unsupported','open']),note:z.string().max(240).optional(),quote:z.string().max(400).optional(),source:z.object({title:z.string().max(300),url:z.string().max(2000).optional()}).strict().optional()}).strict()).max(12)}).strict().optional(), web:z.object({question:z.string().trim().min(1).max(300),directions:z.array(z.object({id:identifier,title:z.string().trim().min(1).max(80),why:z.string().max(160),queries:z.array(z.string().trim().min(1).max(400)).max(8),links:z.array(z.string().max(2000)).max(5).optional(),summary:z.string().max(12000).optional(),aside:z.string().max(160).optional()}).strict()).min(1).max(12)}).strict().optional() };
/** Where a paper came from: set by ros.ai when the person or an agent adds one (papers.ts), so agents never write it. */
export const paperSchema = z.object({ source: z.enum(['openalex', 'arxiv', 'zotero']), id: z.string().regex(PAPER_ID), doi: z.string().regex(DOI).optional(), link: z.string().url().max(2000) }).strict();
/** The agent whose turn an Agent block stands for, ACP agents (Gemini CLI, Goose, OpenCode) included. Kept apart from nodeFields, so the
 * canvas tool agents see reads as the training snapshot has it. */
const agentLinkSchema = z.object({ runtime: z.enum(['claude', 'codex', 'model', ...ACP_AGENT_IDS]), turnId: identifier }).strict();
/** An App block's page and the blocks it reads (see AppDocument). An update may name only the page or only the inputs;
 * ros.ai keeps the other. Kept apart from nodeFields, so the canvas tool agents see reads as the training snapshot has
 * it until Apps are switched on for agents. */
const appSchema = z.object({ source: z.string().max(APP_SOURCE_LIMIT).optional(), inputs: z.array(identifier).max(MAX_APP_INPUTS).optional() }).strict().refine(value => value.source !== undefined || value.inputs !== undefined, 'Give the page (source), the inputs, or both');
const appNodeFields = { ...liveNodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','google','web','app']).optional(), app: appSchema.optional() };
/** A training run the person adds (see TrainingView). Kept out of what agents may propose, Apps on or off, because it names a
 * folder and an ssh host on this computer, and out of nodeFields, so the canvas tool agents see reads as the training snapshot has it. */
export const trainingViewSchema = z.object({ folder: z.string().trim().min(1).max(1000), host: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,199}$/u).optional(), remote: z.string().regex(/^[~A-Za-z0-9_./-]{1,500}$/u).optional() }).strict();
/** A Notion block with the account the person chose to read it with (see NotionView), by its key in ros.ai. Kept out
 * of what agents may propose and out of nodeFields, so the canvas tool agents see reads as the training snapshot has it. */
/** A Metric block's source (see MetricView). Kept out of what agents may propose and out of nodeFields, like a training run. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
export const metricViewSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('github'), repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u) }).strict(),
  z.object({ source: z.literal('cloud') }).strict(),
  z.object({ source: z.literal('umami'), website: uuid }).strict(),
  z.object({ source: z.literal('railway'), project: uuid }).strict(),
]);
const notionViewSchema = nodeFields.notion.unwrap().extend({ account: z.string().regex(/^[a-z0-9-]{1,40}$/u).optional() }).strict();
const canvasMutationSchema = mutations({ ...appNodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','google','web','app','training','metric']).optional(), notion: notionViewSchema.optional(), training: trainingViewSchema.optional(), metric: metricViewSchema.optional(), agent: agentLinkSchema.optional(), paper: paperSchema.optional(), decisions: z.array(decisionSchema).max(100).optional() });
export const mutationSchema = z.discriminatedUnion('type', [...canvasMutationSchema.options, updateConnectionSchema]);
/** What agents may propose: decisions are recorded only by the researcher. */
export const proposalMutationSchema = mutations(liveNodeFields);
/** The same without Google blocks: the schema agents are shown while Google Drive is not connected. */
export const snapshotProposalMutationSchema = mutations(nodeFields);
/** What agents may propose while Apps are switched on for them, with and without Google blocks. */
export const appProposalMutationSchema = mutations(appNodeFields);
export const snapshotAppProposalMutationSchema = mutations({ ...nodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','app']).optional(), app: appSchema.optional() });
const operationsSchema = z.array(mutationSchema).min(1).max(500);
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const GRID = 24;
// Placement runs before the browser measures outcome content. Existing cards may
// show results, so reserve the bounded maximum height for them; blocks added in
// the same edit have no results yet. Explicit Arrange uses measured footprints.
const MAX_NODES = 500;
const MAX_CONNECTIONS = 2_000;
const snap = (value: number) => Math.round(value / GRID) * GRID;

export class StoreError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'StoreError'; }
}

type JsonRow = { data: string };
type NodePresentation = Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>;
type HistoryState = { stack: Canvas[]; cursor: number; presentation?: Record<string, NodePresentation> };

// Layout is a current preference, not research content. Compare canonical content
// so old position-only entries can be skipped without rewriting their snapshots.
function canvasContent(canvas: Canvas): string {
  const orderedFields = (value: object) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({
    nodes: [...canvas.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(({ x: _x, y: _y, width: _width, height: _height, ...content }) => orderedFields(content)),
    connections: [...canvas.connections].sort((a, b) => a.id.localeCompare(b.id)).map(orderedFields),
  });
}

function contentCursor(history: HistoryState, canvas: Canvas, direction: -1 | 1): number | undefined {
  const content = canvasContent(canvas);
  for (let cursor = history.cursor + direction; cursor >= 0 && cursor < history.stack.length; cursor += direction) {
    if (canvasContent(history.stack[cursor]) !== content) return cursor;
  }
  return undefined;
}

// Coordinates are relative to the owning group, so remember each parent scope
// independently. JSON tuple keys also avoid special object-property identifiers.
const presentationKey = (node: CanvasNode) => JSON.stringify([node.id, node.parentId ?? null]);
function rememberPresentation(history: HistoryState, canvas: Canvas): void {
  history.presentation ??= {};
  for (const node of canvas.nodes) history.presentation[presentationKey(node)] = { x: node.x, y: node.y, ...(node.width === undefined ? {} : { width: node.width }), ...(node.height == null ? {} : { height: node.height }) };
}
function restoreContent(history: HistoryState, target: Canvas, current: Canvas): Canvas {
  const currentNodes = new Map(current.nodes.map(node => [node.id, node]));
  return { ...clone(target), nodes: target.nodes.map(node => {
    const live = currentNodes.get(node.id);
    const saved = history.presentation?.[presentationKey(node)];
    const position = live && (live.parentId ?? null) === (node.parentId ?? null) ? live : saved ?? node;
    const width = live ? live.width : saved ? saved.width : node.width;
    const height = live ? live.height : saved ? saved.height : node.height;
    const restored = { ...node, x: position.x, y: position.y };
    if (width === undefined) delete restored.width;
    else restored.width = width;
    if (height == null) delete restored.height;
    else restored.height = height;
    return restored;
  }) };
}

/** The only structural write boundary. Runs and captured evidence never own canvas mutation. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly artifactDir: string;
  private transactionDepth=0;
  private readonly commitListeners = new Set<(projectId: string) => void>();
  private readonly pendingCommits = new Set<string>();

  constructor(dataDir: string, options: { recoverInterrupted?: boolean } = {}) {
    const directory = resolve(dataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.artifactDir = join(directory, 'artifacts');
    mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'ros-ai.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, history TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_trash (project_id TEXT PRIMARY KEY REFERENCES projects(id), deleted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS node_identities (project_id TEXT NOT NULL REFERENCES projects(id), node_id TEXT NOT NULL, PRIMARY KEY(project_id, node_id));
      CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, revision));
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), node_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), node_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), node_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), node_id TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_records (namespace TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL, PRIMARY KEY(namespace,id));
      CREATE TABLE IF NOT EXISTS global_records (namespace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace,id));
      CREATE INDEX IF NOT EXISTS messages_scope ON messages(project_id, node_id);
      CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id);
      CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id);
      CREATE INDEX IF NOT EXISTS inputs_project ON inputs(project_id);
    `);
    // Preparation/import clients may join a running service. Only the owning
    // service startup should reconcile interrupted work.
    if (options.recoverInterrupted !== false) this.transaction(() => {
      for (const run of this.all<Run>('SELECT data FROM runs ORDER BY rowid')) {
        if (run.status !== 'running' && run.status !== 'queued') continue;
        run.status = 'interrupted';
        run.endedAt = now();
        if (run.configuration.kind === 'local-experiment') {
          run.error = run.configuration.backend==='nebius-sandbox'
            ? 'Application stopped before the remote experiment finished. Known operations will be reconciled and cancellation requested; termination may be uncertain. No code is resubmitted automatically.'
            : 'Application stopped before this local experiment finished. Any orphaned worker is bounded by its CPU/time limits; no work is replayed. Preview and approve a new attempt.';
          const approval = run.configuration.approval as {status?:string} | undefined;
          if (approval?.status === 'pending') run.configuration.approval = { ...approval, status: 'cancelled', decidedAt: run.endedAt, decisionReason: 'Application restarted before an approval decision; a new preview is required.' };
        } else {
          run.error = 'Application stopped before this run finished. The provider outcome may be unknown. Retry explicitly to start a new attempt.';
        }
        run.events.push({ at: run.endedAt, type: 'interrupted', message: run.error });
        this.db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(JSON.stringify(run), run.id);
      }
      for (const usage of this.listUsage()) {
        if (usage.status !== 'reserved') continue;
        usage.status = 'uncertain';
        this.db.prepare('UPDATE usage SET data = ? WHERE id = ?').run(JSON.stringify(usage), usage.id);
      }
    });
  }

  close(): void { this.db.close(); }

  globalRecord<T>(namespace:string,id:string):T|undefined {
    const row=this.db.prepare('SELECT data FROM global_records WHERE namespace = ? AND id = ?').get(namespace,id) as JsonRow|undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  saveGlobalRecord<T>(namespace:string,id:string,value:T):T {
    this.db.prepare('INSERT INTO global_records(namespace,id,data) VALUES (?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data').run(namespace,id,JSON.stringify(value));
    return clone(value);
  }

  /** What ROS ran with last, in any project: the model and the way it runs (a backend such as claude-plan). */
  lastRosChoice():RosChoice { return this.globalRecord<RosChoice>('ros-last-choice','last')??{}; }
  rememberRosChoice(change:RosChoice) { this.saveGlobalRecord('ros-last-choice','last',{...this.lastRosChoice(),...change}); }

  record<T>(namespace:string,id:string):T|undefined {
    const row=this.db.prepare('SELECT data FROM workspace_records WHERE namespace = ? AND id = ?').get(namespace,id) as JsonRow|undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  records<T>(namespace:string,projectId:string):T[] { this.getProject(projectId); return this.all<T>('SELECT data FROM workspace_records WHERE namespace = ? AND project_id = ? ORDER BY rowid',namespace,projectId); }
  /** The project's records of one kind with their ids, for records that do not carry their own id (agent sessions). */
  recordEntries<T>(namespace:string,projectId:string):{id:string;value:T}[] { this.getProject(projectId); return (this.db.prepare('SELECT id, data FROM workspace_records WHERE namespace = ? AND project_id = ? ORDER BY rowid').all(namespace,projectId) as {id:string;data:string}[]).map(row => ({ id: row.id, value: JSON.parse(row.data) as T })); }
  saveRecord<T>(namespace:string,id:string,projectId:string,value:T):T {
    this.getProject(projectId);
    this.db.prepare('INSERT INTO workspace_records(namespace,id,project_id,data) VALUES (?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data').run(namespace,id,projectId,JSON.stringify(value));
    return clone(value);
  }
  removeRecord(namespace:string,id:string,projectId:string) { this.db.prepare('DELETE FROM workspace_records WHERE namespace=? AND id=? AND project_id=?').run(namespace,id,projectId); }
  /** Development only: forget the project conversation (messages, turns, agent sessions, research memory) for a fresh test. Usage and the canvas stay. */
  clearConversation(projectId:string) { this.getProject(projectId); this.atomic(()=>{ this.db.prepare('DELETE FROM messages WHERE project_id=? AND node_id IS NULL').run(projectId); for (const namespace of ['assistant-turn','assistant-thread','assistant-focus','research-memory','claude-session','codex-session','acp-session']) this.db.prepare('DELETE FROM workspace_records WHERE namespace=? AND project_id=?').run(namespace,projectId); }); }
  atomic<T>(fn:()=>T):T { return this.transaction(fn); }

  /** Called with a project id after a canvas change or a finished run is committed. */
  onCommit(listener: (projectId: string) => void): () => void {
    this.commitListeners.add(listener);
    return () => { this.commitListeners.delete(listener); };
  }
  private committed(projectId: string): void {
    if (this.transactionDepth > 0) { this.pendingCommits.add(projectId); return; }
    // A listener failure never undoes or fails a write that is already committed.
    for (const listener of this.commitListeners) try { listener(projectId); } catch { /* reported by the listener */ }
  }

  private transaction<T>(fn: () => T): T {
    const depth=this.transactionDepth++,savepoint=`ros_transaction_${depth}`;
    let committed=false;
    try{
      this.db.exec(depth===0?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
      try { const result = fn(); this.db.exec(depth===0?'COMMIT':`RELEASE ${savepoint}`); committed=depth===0; return result; }
      catch (error) { this.db.exec(depth===0?'ROLLBACK':`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); if(depth===0)this.pendingCommits.clear(); throw error; }
    }finally{
      this.transactionDepth--;
      if(committed){const projects=[...this.pendingCommits];this.pendingCommits.clear();for(const id of projects)this.committed(id);}
    }
  }

  private all<T>(sql: string, ...parameters: (string | number | null)[]): T[] {
    return (this.db.prepare(sql).all(...parameters) as JsonRow[]).map(row => JSON.parse(row.data) as T);
  }

  private one<T>(sql: string, id: string, noun: string): T {
    const row = this.db.prepare(sql).get(id) as JsonRow | undefined;
    if (!row) throw new StoreError(`${noun} not found`, 404);
    return JSON.parse(row.data) as T;
  }

  listProjects(): Project[] { return this.all<Project>('SELECT data FROM projects WHERE id NOT IN (SELECT project_id FROM project_trash) ORDER BY rowid DESC'); }
  listTrashedProjects():Project[] { return this.all<Project>('SELECT data FROM projects WHERE id IN (SELECT project_id FROM project_trash) ORDER BY rowid DESC'); }
  trashProject(id:string):Project {
    const project=this.getProject(id);
    if(this.listRuns(id).some(run=>['queued','running'].includes(run.status))||this.records<{status:string}>('assistant-turn',id).some(turn=>turn.status==='running')||this.records<{status:string}>('research',id).some(session=>session.status==='running')||this.records<{status:string}>('workspace-guide-review',id).some(review=>['queued','running'].includes(review.status)))throw new StoreError('Stop active research and pending experiments before moving this project to Trash.',409);
    this.db.prepare('INSERT INTO project_trash(project_id,deleted_at) VALUES (?,?)').run(id,now());
    return project;
  }
  restoreProject(id:string):Project {
    this.one<Project>('SELECT data FROM projects WHERE id = ?',id,'Project');
    this.db.prepare('DELETE FROM project_trash WHERE project_id = ?').run(id);
    return this.getProject(id);
  }

  createProject(title: string): Project {
    const timestamp = now();
    const project: Project = { id: randomUUID(), title: z.string().trim().min(1).max(200).parse(title), revision: 0, canvas: { nodes: [], connections: [] }, createdAt: timestamp, updatedAt: timestamp };
    return this.transaction(() => {
      this.db.prepare('INSERT INTO projects(id, data, history) VALUES (?, ?, ?)').run(project.id, JSON.stringify(project), JSON.stringify({ stack: [project.canvas], cursor: 0 }));
      this.recordChange(project, 'Project created');
      return project;
    });
  }

  getProject(id: string): Project {
    if(this.db.prepare('SELECT 1 FROM project_trash WHERE project_id = ?').get(id))throw new StoreError('This project is in Trash. Restore it before opening or changing it.',410);
    const project = this.one<Project>('SELECT data FROM projects WHERE id = ?', id, 'Project');
    const titleOf = (artifactId: string) => { const row = this.db.prepare('SELECT data FROM artifacts WHERE id = ?').get(artifactId) as JsonRow | undefined; return row ? (JSON.parse(row.data) as { title?: string }).title : undefined; };
    const convert = (value: Canvas) => convertDecisionLogs(convertLegacyGroups(value), titleOf);
    const grouped = convertLegacyGroups(project.canvas), canvas = convertDecisionLogs(grouped, titleOf);
    if (JSON.stringify(canvas) === JSON.stringify(project.canvas)) return project;
    // A compatibility conversion is persisted, including history, without a new
    // content revision or rewriting immutable runs/evidence/pending approvals.
    return this.transaction(() => {
      const history = this.getHistory(id);
      history.stack = history.stack.map(convert);
      const updated = { ...project, canvas };
      this.db.prepare('UPDATE projects SET data=?, history=? WHERE id=?').run(JSON.stringify(updated), JSON.stringify(history), id);
      if (JSON.stringify(grouped) !== JSON.stringify(project.canvas)) {
        this.preserveModels(project, canvas, true);
        this.saveRecord('group-conversion', id, id, { at:now(), nodes:canvas.nodes.filter(node => node.legacyKind).map(node => ({id:node.id,legacyKind:node.legacyKind})), detail:'Research identity, overview, versions, conversations, execution records and effective models retained.' });
      }
      // A decision log becomes Text blocks labelled decision, each linked to the block it was recorded in.
      if (canvas !== grouped) this.saveRecord('decision-conversion', id, id, { at:now(), blocks:canvas.nodes.filter(node => !grouped.nodes.some(item => item.id === node.id)).map(node => node.id), detail:'Recorded decisions became Text blocks labelled decision, each linked to the block it was recorded in.' });
      return updated;
    });
  }

  private preserveModels(before: Project, after: Canvas, freezeAll = false) {
    const settings = this.record<ProjectModelSettings>('model-settings', before.id) ?? { default:this.lastRosChoice().model ?? {provider:'nebius' as const,model:process.env.ROS_NEBIUS_MODEL ?? DEFAULT_NEBIUS_MODEL}, overrides:{} };
    const changes: {id:string;model:string}[] = [];
    for (const node of before.canvas.nodes) {
      if (!after.nodes.some(item => item.id === node.id)) continue;
      const prior = resolveModelSetting(settings, before.canvas.nodes, node.id).selection;
      const next = resolveModelSetting(settings, after.nodes, node.id).selection;
      if (freezeAll || prior.provider !== next.provider || prior.model !== next.model) {
        settings.overrides[node.id] = { ...prior }; changes.push({id:node.id,model:prior.model});
      }
    }
    if (changes.length) {
      this.saveRecord('model-settings',before.id,before.id,settings);
      this.saveRecord('group-model-preservation',before.id,before.id,{at:now(),nodes:changes,detail:'Organizational changes retained selected models as explicit overrides. Use model settings to deliberately inherit again.'});
    }
  }

  detail(id: string): ProjectDetail {
    const project = this.getProject(id);
    const history = this.getHistory(id);
    return { project, messages: this.all<Message>('SELECT data FROM messages WHERE project_id = ? ORDER BY rowid', id), proposals: this.all<Proposal>('SELECT data FROM proposals WHERE project_id = ? ORDER BY rowid', id), changes: this.listChanges(id), runs: this.listRuns(id), artifacts: this.listArtifacts(id), inputs: this.all<SelectedInput>('SELECT data FROM inputs WHERE project_id = ? ORDER BY rowid', id), canUndo: contentCursor(history, project.canvas, -1) !== undefined, canRedo: contentCursor(history, project.canvas, 1) !== undefined, highlights:this.records('highlight',id), notebooks:this.records('notebook-summary',id) };
  }

  private getHistory(id: string): HistoryState {
    const row = this.db.prepare('SELECT history FROM projects WHERE id = ?').get(id) as { history: string } | undefined;
    if (!row) throw new StoreError('Project not found', 404);
    return JSON.parse(row.history) as HistoryState;
  }

  private recordChange(project: Project, label: string): void {
    const change: Change = { id: randomUUID(), projectId: project.id, revision: project.revision, label, canvas: clone(project.canvas), createdAt: project.updatedAt };
    this.db.prepare('INSERT INTO changes(id, project_id, revision, data) VALUES (?, ?, ?, ?)').run(change.id, project.id, project.revision, JSON.stringify(change));
  }

  private placeNode(node: CanvasNode, others: CanvasNode[], fresh: ReadonlySet<string> = new Set()): CanvasNode {
    const placed = { ...node, x: snap(node.x), y: snap(node.y) };
    const height = (item: CanvasNode) => fresh.has(item.id) ? estimatedCardHeight(item) : cardFootprintHeight(item);
    const overlaps = () => others.some(other => (other.parentId ?? null) === (placed.parentId ?? null)
      && placed.x < other.x + cardWidth(other) + LAYOUT_GAP && other.x < placed.x + cardWidth(placed) + LAYOUT_GAP
      && (other.y <= placed.y ? placed.y < other.y + height(other) + LAYOUT_GAP : other.y < placed.y + height(placed) + LAYOUT_GAP));
    if (placed.parentId && overlaps()) {
      // Inside a Group, the first free spot beside or below its blocks keeps its frame as tight as it is.
      const boxes = others.filter(other => other.parentId === placed.parentId).map(other => ({ x: other.x, y: other.y, width: cardWidth(other), height: height(other) }));
      const spot = freeSpot(boxes, { width: cardWidth(placed), height: height(placed) }, { x: 0, y: 0 }, groupContentRight(boxes));
      if (spot) { coordinate.parse(spot.x); coordinate.parse(spot.y); return { ...placed, ...spot }; }
    }
    const originX = placed.x;
    const stepX = Math.ceil((cardWidth(placed) + LAYOUT_GAP) / GRID) * GRID;
    const stepY = Math.ceil((CARD_MAX_HEIGHT + LAYOUT_GAP) / GRID) * GRID;
    // Deterministic placement makes the proposal preview match the accepted mutation.
    for (let attempt = 0; overlaps(); attempt++) {
      if (attempt >= MAX_NODES * 4) throw new StoreError('No free placement found near the requested position');
      placed.x = originX + ((attempt + 1) % 5) * stepX;
      placed.y = snap(node.y) + Math.floor((attempt + 1) / 5) * stepY;
    }
    coordinate.parse(placed.x); coordinate.parse(placed.y);
    return placed;
  }

  /** A Code block whose language is html is saved as an App: the alias the frozen agent tools of 24 October write.
   * An App keeps its page and inputs in `app`, never in `code`; a Code input artifact becomes the block holding it. */
  private asApp(projectId: string, node: CanvasNode): CanvasNode {
    const alias = isHtmlLanguage(node.code?.language) && (node.blockType === 'code' || node.blockType === undefined);
    if (node.blockType !== 'app' && !alias) return node;
    if (node.kind === 'group') throw new StoreError('A Group cannot be an App.');
    if (node.code && !isHtmlLanguage(node.code.language)) throw new StoreError('An App block holds one HTML page. Send app {source, inputs}, or code with language "html".');
    const { code, ...rest } = node;
    return { ...rest, blockType: 'app', app: { source: node.app?.source ?? code?.source ?? '', inputs: node.app?.inputs ?? this.codeInput(projectId, code?.inputArtifactId) } };
  }
  /** The patch an update makes, with an App's page always whole in `app`. Edits that leave the page alone stay as sent. */
  private appPatch(projectId: string, node: CanvasNode, patch: Partial<CanvasNode>): Partial<CanvasNode> {
    const merged = { ...node, ...patch }, wasApp = node.blockType === 'app';
    const alias = isHtmlLanguage(merged.code?.language) && (merged.blockType === 'code' || merged.blockType === 'app');
    if (!wasApp && merged.blockType !== 'app' && !alias) return patch;
    if (wasApp && merged.blockType !== 'app' && !alias) throw new StoreError(`${node.title} is an App and stays one. Change its page with app {source}.`);
    if (!('app' in patch) && !('code' in patch) && !('blockType' in patch)) return patch;
    if (patch.code && !isHtmlLanguage(patch.code.language)) throw new StoreError('An App block holds one HTML page. Send app {source, inputs}, or code with language "html".');
    const { code, ...rest } = patch;
    const source = patch.app?.source ?? code?.source ?? node.app?.source ?? node.code?.source ?? '';
    const inputs = patch.app?.inputs ?? node.app?.inputs ?? this.codeInput(projectId, (code ?? node.code)?.inputArtifactId);
    return { ...rest, blockType: 'app', app: { source, inputs } };
  }
  private codeInput(projectId: string, artifactId: string | null | undefined): string[] {
    if (!artifactId) return [];
    const artifact = this.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new StoreError('The Code input must belong to this project.');
    return [artifact.nodeId];
  }

  private applyOperations(project: Project, supplied: Mutation[], proposal: boolean, arranged = false): { canvas: Canvas; operations: Mutation[] } {
    const parsed = operationsSchema.parse(supplied) as Mutation[];
    const operations = proposal && !arranged ? batchGrid(parsed, project.canvas.nodes) : parsed;
    const canvas = clone(project.canvas);
    const activeNode = (id: string) => {
      const node = canvas.nodes.find(item => item.id === id);
      if (!node) throw new StoreError(`Node ${id} is not active in this project`);
      return node;
    };
    const normalized: Mutation[] = [];
    const recordedDecisions = new Set<string>();
    const added = new Set<string>();
    for (const operation of operations) {
      const decided = operation.type === 'addNode' ? operation.node.decisions && operation.node.id : operation.type === 'updateNode' && 'decisions' in operation.patch ? operation.id : undefined;
      if (decided) {
        if (proposal) throw new StoreError('Decisions are recorded by the researcher. A proposal cannot add or change them.');
        recordedDecisions.add(decided);
      }
      if (operation.type === 'addNode') {
        if (canvas.nodes.some(item => item.id === operation.node.id) || this.db.prepare('SELECT 1 FROM node_identities WHERE project_id = ? AND node_id = ?').get(project.id, operation.node.id)) throw new StoreError(`Node id ${operation.node.id} already exists or belongs to a removed node`);
        if (canvas.nodes.length >= MAX_NODES) throw new StoreError(`A project supports at most ${MAX_NODES} nodes`);
        added.add(operation.node.id);
        const node = operation.node.kind === 'group' ? { ...operation.node, x:snap(operation.node.x), y:snap(operation.node.y) } : this.placeNode(this.asApp(project.id, operation.node), canvas.nodes, added);
        canvas.nodes.push(node); normalized.push({ type: 'addNode', node });
      } else if (operation.type === 'updateNode') {
        const node = activeNode(operation.id);
        let patch = this.appPatch(project.id, node, operation.patch);
        // An agent that changes a Notion block's filter or columns keeps the account the person chose for it.
        if (proposal && patch.notion && node.notion?.account && !patch.notion.account && patch.notion.url === node.notion.url) patch = { ...patch, notion: { ...patch.notion, account: node.notion.account } };
        let updated = { ...node, ...patch };
        if (updated.blockType === 'app') delete updated.code;
        // A null height gives the card back to its content.
        if (operation.patch.height === null) delete updated.height;
        if ('x' in operation.patch || 'y' in operation.patch) {
          updated.x = snap(updated.x); updated.y = snap(updated.y);
          if (proposal && !arranged) updated = this.placeNode(updated, canvas.nodes.filter(item => item.id !== node.id));
        }
        coordinate.parse(updated.x); coordinate.parse(updated.y);
        canvas.nodes = canvas.nodes.map(item => item.id === node.id ? updated : item);
        normalized.push({ type: 'updateNode', id: node.id, patch: { ...patch, ...('x' in operation.patch || 'y' in operation.patch ? { x: updated.x, y: updated.y } : {}) } });
      } else if (operation.type === 'removeNode') {
        activeNode(operation.id);
        // Removing a workspace removes its children in the same undoable edit;
        // durable identities, runs, messages and artifacts remain untouched.
        const removed = new Set([operation.id, ...canvas.nodes.filter(item => item.parentId === operation.id).map(item => item.id)]);
        for(let previous=-1; previous!==removed.size;) { previous=removed.size; for(const item of canvas.nodes) if(item.parentId && removed.has(item.parentId)) removed.add(item.id); }
        canvas.nodes = canvas.nodes.filter(item => !removed.has(item.id));
        canvas.connections = canvas.connections.filter(item => !removed.has(item.source) && !removed.has(item.target));
        // An App stops reading a removed block, as a link to it goes; Undo brings both back.
        canvas.nodes = canvas.nodes.map(item => item.app?.inputs.some(input => removed.has(input)) ? { ...item, app: { ...item.app, inputs: item.app.inputs.filter(input => !removed.has(input)) } } : item);
        normalized.push(operation);
      } else if (operation.type === 'addConnection') {
        const connection = operation.connection;
        activeNode(connection.source); activeNode(connection.target);
        if (connection.source === connection.target) throw new StoreError('Connect two different nodes');
        if (canvas.connections.some(item => item.id === connection.id)) throw new StoreError('Connection id already exists');
        if (canvas.connections.some(item => item.source === connection.source && item.target === connection.target)) throw new StoreError('These nodes are already connected');
        if (canvas.connections.length >= MAX_CONNECTIONS) throw new StoreError(`A project supports at most ${MAX_CONNECTIONS} connections`);
        canvas.connections.push(connection); normalized.push(operation);
      } else if (operation.type === 'removeConnection') {
        if (!canvas.connections.some(item => item.id === operation.id)) throw new StoreError('Connection is not active in this project');
        canvas.connections = canvas.connections.filter(item => item.id !== operation.id); normalized.push(operation);
      } else {
        const current = canvas.connections.find(item => item.id === operation.id);
        if (!current) throw new StoreError('Connection is not active in this project');
        const updated = { ...current, ...operation.patch };
        activeNode(updated.source); activeNode(updated.target);
        if (updated.source === updated.target) throw new StoreError('Connect two different nodes');
        if (canvas.connections.some(item => item.id !== current.id && item.source === updated.source && item.target === updated.target)) throw new StoreError('These nodes are already connected');
        canvas.connections = canvas.connections.map(item => item.id === current.id ? updated : item); normalized.push(operation);
      }
    }
    // Validate the final transaction, allowing a proposal to add parent and
    // child together. Deeper nesting is allowed; missing parents and cycles are not.
    for (const node of canvas.nodes) {
      if (!node.parentId) continue;
      const seen=new Set([node.id]); let parentId:string|null|undefined=node.parentId;
      while(parentId) {
        if(seen.has(parentId)) throw new StoreError('A workspace cannot contain itself or a parent cycle');
        seen.add(parentId); const parent=activeNode(parentId);
        if(parent.kind!=='group')throw new StoreError('Only an explicit Group can contain blocks. Create a Group or move this block to the canvas root.');
        parentId=parent.parentId;
      }
    }
    for (const node of canvas.nodes) {
      if (recordedDecisions.has(node.id) && node.decisions) {
        // Unknown citations are refused, never dropped. Unchanged entries were checked when recorded.
        const previous = new Map((project.canvas.nodes.find(item => item.id === node.id)?.decisions ?? []).map(decision => [decision.id, JSON.stringify(decision)]));
        if (new Set(node.decisions.map(decision => decision.id)).size !== node.decisions.length) throw new StoreError('Each decision needs its own id.');
        for (const decision of node.decisions) {
          if (previous.get(decision.id) === JSON.stringify(decision)) continue;
          for (const basis of decision.basedOn) {
            const row = this.db.prepare('SELECT data FROM artifacts WHERE id = ?').get(basis.artifactId) as JsonRow | undefined;
            const saved = row ? JSON.parse(row.data) as Omit<Artifact, 'content'> : undefined;
            if (saved?.projectId !== project.id || saved.hash !== basis.hash) throw new StoreError(`A decision can only cite saved versions in this project. ${basis.artifactId} is not one.`);
          }
        }
      }
      if (node.code?.inputArtifactId && this.getArtifact(node.code.inputArtifactId).projectId!==project.id) throw new StoreError('The Code input must belong to this project.');
      if (node.app) {
        if (node.blockType !== 'app') throw new StoreError('Only an App block has a page. Give it blockType "app".');
        if (new Set(node.app.inputs).size !== node.app.inputs.length) throw new StoreError(`Name each input of ${node.title} once.`);
        for (const input of node.app.inputs) {
          if (input === node.id) throw new StoreError(`${node.title} cannot read itself.`);
          if (!canvas.nodes.some(item => item.id === input)) throw new StoreError(`${node.title} reads ${input}, which is not a block on this canvas.`);
        }
      }
      if (node.artifactId) {
        const artifact = this.getArtifact(node.artifactId);
        if (artifact.projectId !== project.id) throw new StoreError('The block artifact must belong to this project.');
      }
      if (node.groupHighlights?.length) {
        if (node.kind !== 'group') throw new StoreError('Only a Group can own group highlights.');
        const descendants = groupMembers(canvas,node.id);
        const members = new Set([node.id,...descendants.map(member=>member.id)]);
        const represented = new Set([node.artifactId,...descendants.map(member=>member.artifactId)].filter(Boolean));
        // Moving an originating block out also removes its visual pin. The
        // immutable evidence/version is retained in its original block.
        if (!operations.some(operation => operation.type==='updateNode' && operation.id===node.id && 'groupHighlights' in operation.patch)) {
          const retained=node.groupHighlights.filter(highlight=>members.has(highlight.nodeId)||represented.has(highlight.artifactId));
          if (retained.length!==node.groupHighlights.length) { node.groupHighlights=retained; normalized.push({type:'updateNode',id:node.id,patch:{groupHighlights:retained}}); }
        }
        const versions = new Set<string>();
        for (const highlight of node.groupHighlights) {
          const artifact = this.getArtifact(highlight.artifactId);
          if (artifact.projectId !== project.id || artifact.nodeId !== highlight.nodeId || artifact.hash !== highlight.hash || !members.has(highlight.nodeId) && !represented.has(highlight.artifactId)) throw new StoreError('Choose an exact saved artifact version from this Group.');
          if (versions.has(artifact.id)) throw new StoreError('Choose each highlighted version once.');
          versions.add(artifact.id);
        }
      }
    }
    // Relationships can span branches; they never move notes or import artifacts.
    return { canvas, operations: normalized };
  }

  private commitCanvas(project: Project, canvas: Canvas, label: string, history: HistoryState): Project {
    const updated = { ...project, canvas, revision: project.revision + 1, updatedAt: now() };
    this.db.prepare('UPDATE projects SET data = ?, history = ? WHERE id = ?').run(JSON.stringify(updated), JSON.stringify(history), project.id);
    for (const node of canvas.nodes) this.db.prepare('INSERT OR IGNORE INTO node_identities(project_id, node_id) VALUES (?, ?)').run(project.id, node.id);
    this.recordChange(updated, label);
    this.committed(project.id);
    return updated;
  }

  private mutateWithinTransaction(id: string, operations: Mutation[], label: string, expectedRevision?: number): Project {
    const project = this.getProject(id);
    if (expectedRevision !== undefined && expectedRevision !== project.revision) throw new StoreError('The canvas has changed. Refresh and review the latest version.', 409);
    const { canvas } = this.applyOperations(project, operations, false);
    const checkedLabel = z.string().min(1).max(500).parse(label);
    if (JSON.stringify(canvas) === JSON.stringify(project.canvas)) return project;
    // Move/Group/Ungroup must not silently inherit a different model. Shared
    // policy scopes, cumulative reservations and approval modes are untouched.
    this.preserveModels(project,canvas);
    const history = this.getHistory(id);
    rememberPresentation(history, project.canvas);
    rememberPresentation(history, canvas);
    if (canvasContent(canvas) === canvasContent(project.canvas)) {
      // Do not advance content revision, append a snapshot, or discard redo.
      // Captured evidence and approvals keep their original immutable inputs.
      const updated = { ...project, canvas, updatedAt: now() };
      this.db.prepare('UPDATE projects SET data = ?, history = ? WHERE id = ?').run(JSON.stringify(updated), JSON.stringify(history), id);
      this.committed(id);
      return updated;
    }
    history.stack = [...history.stack.slice(0, history.cursor + 1), clone(canvas)];
    history.cursor++;
    return this.commitCanvas(project, canvas, checkedLabel, history);
  }

  mutate(id: string, operations: Mutation[], label: string, expectedRevision?: number): Project {
    return this.transaction(() => this.mutateWithinTransaction(id, operations, label, expectedRevision));
  }

  private travelHistory(id: string, direction: -1 | 1): Project {
    return this.transaction(() => {
      const project = this.getProject(id);
      const history = this.getHistory(id);
      const cursor = contentCursor(history, project.canvas, direction);
      if (cursor === undefined) throw new StoreError(direction < 0 ? 'Nothing to undo' : 'Nothing to redo', 409);
      history.cursor = cursor;
      rememberPresentation(history, project.canvas);
      const canvas = restoreContent(history, history.stack[cursor], project.canvas);
      rememberPresentation(history, canvas);
      return this.commitCanvas(project, canvas, direction < 0 ? 'Undo canvas edit' : 'Redo canvas edit', history);
    });
  }

  undo(id: string): Project { return this.travelHistory(id, -1); }
  redo(id: string): Project { return this.travelHistory(id, 1); }
  listChanges(id: string): Change[] {
    this.getProject(id);
    let previous: string | undefined;
    return this.all<Change>('SELECT data FROM changes WHERE project_id = ? ORDER BY revision', id).filter(change => {
      const content = canvasContent(change.canvas), meaningful = previous === undefined || content !== previous;
      previous = content;
      return meaningful;
    });
  }

  /** A model's suggested moves are nudged to a free spot. `arranged` moves were laid out by ros.ai itself,
   * such as an agent's own tree, so they keep their positions and the preview matches the result. */
  createProposal(projectId: string, baseRevision: number, summary: string, supplied: Mutation[], arranged = false, links: { after?: string[]; batch?: string } = {}): Proposal {
    return this.transaction(() => {
      const project = this.getProject(projectId);
      if (project.revision !== baseRevision) throw new StoreError('The canvas changed while this proposal was generated. Request an updated preview.', 409);
      // A proposal that builds on others is checked against the canvas as it would be once they are accepted.
      const after = [...new Set(links.after ?? [])].map(id => this.getProposal(projectId, id));
      const { operations } = this.applyOperations(this.withProposals(project, after), supplied, true, arranged);
      const proposal: Proposal = { id: randomUUID(), projectId, baseRevision, summary: z.string().trim().min(1).max(5_000).parse(summary), operations, status: 'pending', createdAt: now(), ...(after.length ? { after: after.map(p => p.id) } : {}), ...(links.batch ? { batch: links.batch } : {}) };
      this.db.prepare('INSERT INTO proposals(id, project_id, data) VALUES (?, ?, ?)').run(proposal.id, projectId, JSON.stringify(proposal));
      return proposal;
    });
  }

  proposalStatus(projectId: string, proposalId: string): Proposal['status'] {
    const proposal = this.one<Proposal>('SELECT data FROM proposals WHERE id = ?', proposalId, 'Proposal');
    if (proposal.projectId !== projectId) throw new StoreError('Proposal not found in this project', 404);
    return proposal.status;
  }

  private getProposal(projectId: string, proposalId: string): Proposal {
    const proposal = this.one<Proposal>('SELECT data FROM proposals WHERE id = ?', proposalId, 'Proposal');
    if (proposal.projectId !== projectId) throw new StoreError('Proposal not found in this project', 404);
    if (proposal.status !== 'pending') throw new StoreError('This proposal has already been resolved', 409);
    return proposal;
  }

  acceptProposal(projectId: string, proposalId: string): Project {
    return this.transaction(() => {
      const proposal = this.getProposal(projectId, proposalId);
      for (const id of proposal.after ?? []) {
        const before = this.one<Proposal>('SELECT data FROM proposals WHERE id = ?', id, 'Proposal');
        if (before.status !== 'accepted') throw new StoreError(`This change builds on “${before.summary.split('\n')[0]}”, which ${before.status === 'dismissed' ? 'was dismissed' : 'has to be accepted first'}.`, 409);
      }
      const project = this.mutateWithinTransaction(projectId, proposal.operations, `Accepted proposal: ${proposal.summary}`.slice(0, 500), proposal.baseRevision);
      proposal.status = 'accepted';
      this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(proposal), proposalId);
      // The rest of its batch still applies to the new canvas, so it stays acceptable; one that no longer does stays stale.
      if (proposal.batch) for (const other of this.all<Proposal>('SELECT data FROM proposals WHERE project_id = ? ORDER BY rowid', projectId)) {
        if (other.status !== 'pending' || other.batch !== proposal.batch || other.baseRevision !== proposal.baseRevision) continue;
        try {
          const after = (other.after ?? []).flatMap(id => { const before = this.one<Proposal>('SELECT data FROM proposals WHERE id = ?', id, 'Proposal'); return before.status === 'pending' ? [before] : []; });
          this.applyOperations(this.withProposals(project, after), other.operations, true, true);
          other.baseRevision = project.revision;
          this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(other), other.id);
        } catch (error) { if (!(error instanceof StoreError) && !(error instanceof z.ZodError)) throw error; }
      }
      return project;
    });
  }

  /** Dismissing a proposal also dismisses the pending ones that build on it. */
  dismissProposal(projectId: string, proposalId: string): Proposal {
    return this.transaction(() => {
      const proposal = this.getProposal(projectId, proposalId);
      const gone = new Set([proposalId]);
      const all = this.all<Proposal>('SELECT data FROM proposals WHERE project_id = ? ORDER BY rowid', projectId);
      for (let grew = true; grew;) { grew = false; for (const other of all) if (other.status === 'pending' && !gone.has(other.id) && other.after?.some(id => gone.has(id))) { gone.add(other.id); grew = true; } }
      for (const other of all) if (gone.has(other.id) && other.id !== proposalId) { other.status = 'dismissed'; this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(other), other.id); }
      proposal.status = 'dismissed';
      this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(proposal), proposalId);
      return proposal;
    });
  }

  /** The project as it would be with these pending proposals accepted, for checking one that builds on them. */
  private withProposals(project: Project, proposals: Proposal[]): Project {
    let canvas = project.canvas;
    for (const p of proposals) canvas = this.applyOperations({ ...project, canvas }, p.operations, true, true).canvas;
    return { ...project, canvas };
  }

  private requireNode(projectId: string, nodeId: string, includeRemoved = false): void {
    const project = this.getProject(projectId);
    if (includeRemoved ? !this.db.prepare('SELECT 1 FROM node_identities WHERE project_id = ? AND node_id = ?').get(projectId, nodeId) : !project.canvas.nodes.some(node => node.id === nodeId)) throw new StoreError('Node not found in this project', 404);
  }

  /** threadId: the ROS thread a project message belongs to (nodeId null). */
  addMessage(projectId: string, nodeId: string | null, role: Message['role'], content: string, runId?: string, threadId?: string): Message {
    this.getProject(projectId);
    if (nodeId !== null) this.requireNode(projectId, nodeId, true);
    if (runId) {
      const run = this.getRun(runId);
      if (run.projectId !== projectId || run.nodeId !== nodeId) throw new StoreError('Run does not belong to this conversation');
    }
    if (threadId !== undefined && nodeId !== null) throw new StoreError('Only project messages belong to a ROS thread');
    const message: Message = { id: randomUUID(), projectId, nodeId, role: z.enum(['user', 'assistant', 'system']).parse(role), content: z.string().min(1).max(1_000_000).parse(content), createdAt: now(), ...(runId ? { runId } : {}), ...(threadId ? { threadId } : {}) };
    this.db.prepare('INSERT INTO messages(id, project_id, node_id, data) VALUES (?, ?, ?, ?)').run(message.id, projectId, nodeId, JSON.stringify(message));
    return message;
  }

  listMessages(projectId: string, nodeId: string | null): Message[] {
    this.getProject(projectId);
    if (nodeId !== null) this.requireNode(projectId, nodeId, true);
    return this.all<Message>('SELECT data FROM messages WHERE project_id = ? AND node_id IS ? ORDER BY rowid', projectId, nodeId);
  }
  /** Puts project messages into a ROS thread: the conversation from before threads becomes the first thread. */
  assignMessageThread(projectId: string, ids: string[], threadId: string): void {
    this.getProject(projectId);
    this.atomic(() => { for (const message of this.listMessages(projectId, null)) if (ids.includes(message.id)) this.db.prepare('UPDATE messages SET data = ? WHERE id = ? AND project_id = ?').run(JSON.stringify({ ...message, threadId }), message.id, projectId); });
  }
  /** Deletes project messages by id (a deleted ROS thread); block conversations are never touched. */
  removeMessages(projectId: string, ids: string[]): void {
    this.getProject(projectId);
    this.atomic(() => { for (const id of ids) this.db.prepare('DELETE FROM messages WHERE id = ? AND project_id = ? AND node_id IS NULL').run(id, projectId); });
  }

  addInput(projectId: string, nodeId: string, artifactId: string, excerpt?: string): SelectedInput {
    this.requireNode(projectId, nodeId);
    const artifact = this.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new StoreError('The selected artifact is not part of this project');
    const selected = excerpt === undefined ? artifact.content : z.string().min(1).max(2_000_000).parse(excerpt);
    if (!artifact.content.includes(selected)) throw new StoreError('An excerpt must match the captured artifact content exactly');
    const existing = this.all<SelectedInput>('SELECT data FROM inputs WHERE project_id = ? AND node_id = ? AND artifact_id = ?', projectId, nodeId, artifactId).find(input => input.excerpt === selected);
    if (existing) return existing;
    const input: SelectedInput = { id: randomUUID(), projectId, nodeId, artifactId, excerpt: selected, createdAt: now() };
    this.db.prepare('INSERT INTO inputs(id, project_id, node_id, artifact_id, data) VALUES (?, ?, ?, ?, ?)').run(input.id, projectId, nodeId, artifactId, JSON.stringify(input));
    return input;
  }

  removeInput(projectId: string, inputId: string): void {
    this.getProject(projectId);
    const result = this.db.prepare('DELETE FROM inputs WHERE id = ? AND project_id = ?').run(inputId, projectId);
    if (result.changes === 0) throw new StoreError('Selected input not found in this project', 404);
  }

  createRun(run: Run): Run {
    this.requireNode(run.projectId, run.nodeId);
    identifier.parse(run.id);
    if (run.node.id !== run.nodeId) throw new StoreError('Run node snapshot does not match its node');
    if (run.retryOf) {
      const previous = this.getRun(run.retryOf);
      if (previous.projectId !== run.projectId || previous.nodeId !== run.nodeId) throw new StoreError('Retry must refer to a run in this node');
    }
    const duplicate = this.listRuns(run.projectId).find(item => item.nodeId === run.nodeId && (item.status === 'queued' || item.status === 'running'));
    if (duplicate) throw new StoreError('This node already has active work', 409);
    for (const input of run.inputs) {
      const artifact = this.getArtifact(input.artifactId);
      if (input.projectId !== run.projectId || input.nodeId !== run.nodeId || artifact.projectId !== run.projectId || artifact.hash !== input.artifact.hash || artifact.id !== input.artifact.id || artifact.content !== input.artifact.content || !artifact.content.includes(input.excerpt)) throw new StoreError('Invalid captured input version');
    }
    this.db.prepare('INSERT INTO runs(id, project_id, node_id, data) VALUES (?, ?, ?, ?)').run(run.id, run.projectId, run.nodeId, this.serializeRun(run));
    return clone(run);
  }

  updateRun(id: string, patch: Partial<Run>): Run {
    const run = this.getRun(id);
    const immutable = ['id', 'projectId', 'nodeId', 'request', 'useSearch', 'retryOf', 'createdAt', 'projectRevision', 'node', 'inputs', 'provider', 'model'] as const;
    for (const key of immutable) if (key in patch && JSON.stringify(patch[key]) !== JSON.stringify(run[key])) throw new StoreError(`Run ${key} is immutable`);
    if (!['queued', 'running'].includes(run.status)) throw new StoreError('Finished runs are immutable', 409);
    // The requested model is fixed at admission; its provider-reported snapshot
    // is only known after inference. Capture that version once, while running.
    if ('modelVersion' in patch && patch.modelVersion !== run.modelVersion) {
      if (run.status !== 'running' || run.modelVersion !== null || typeof patch.modelVersion !== 'string' || !patch.modelVersion.trim() || patch.modelVersion.length > 500) throw new StoreError('Run modelVersion may only be captured once while running', 409);
    }
    if (patch.status) z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).parse(patch.status);
    const updated = { ...run, ...clone(patch) };
    for (const artifactId of updated.artifactIds) {
      const artifact = this.getArtifact(artifactId);
      if (artifact.runId !== id) throw new StoreError('Run output does not belong to this run');
    }
    this.db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(this.serializeRun(updated), id);
    if (updated.status !== run.status && !['queued', 'running'].includes(updated.status)) this.committed(run.projectId);
    return updated;
  }

  private serializeRun(run: Run): string {
    return JSON.stringify({ ...run, inputs: run.inputs.map(input => ({ ...input, artifact: { id: input.artifact.id, hash: input.artifact.hash } })) });
  }

  private hydrateRun(run: Run): Run {
    return { ...run, inputs: run.inputs.map(input => {
      const artifact = this.getArtifact(input.artifactId);
      if (artifact.id !== input.artifact.id || artifact.hash !== input.artifact.hash) throw new StoreError('Captured input artifact integrity failure', 500);
      return { ...input, artifact };
    }) };
  }

  getRun(id: string): Run { return this.hydrateRun(this.one<Run>('SELECT data FROM runs WHERE id = ?', id, 'Run')); }
  listRuns(projectId: string): Run[] { this.getProject(projectId); return this.all<Run>('SELECT data FROM runs WHERE project_id = ? ORDER BY rowid DESC', projectId).map(run => this.hydrateRun(run)); }

  addArtifact(input: Omit<Artifact, 'id' | 'hash' | 'createdAt'>): Artifact {
    this.requireNode(input.projectId, input.nodeId, true);
    const run = this.getRun(input.runId);
    if (run.projectId !== input.projectId || run.nodeId !== input.nodeId) throw new StoreError('Artifact run does not belong to this node');
    if (run.status !== 'queued' && run.status !== 'running') throw new StoreError('Finished runs cannot receive new artifacts', 409);
    z.enum(['result', 'source', 'dataset', 'code', 'table', 'metric', 'plot', 'log', 'notebook']).parse(input.kind);
    const content = z.string().max(10_000_000).parse(input.content);
    z.string().min(1).max(500).parse(input.title);
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    const artifact: Artifact = { ...clone(input), id: randomUUID(), hash, createdAt: now() };
    const path = join(this.artifactDir, `${hash}.txt`);
    try { writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (readFileSync(path, 'utf8') !== content) throw new StoreError('Artifact storage integrity failure', 500);
    }
    // Content is kept once on disk; metadata and the stable hash remain in SQLite.
    const { content: omitted, ...metadata } = artifact;
    void omitted;
    this.db.prepare('INSERT INTO artifacts(id, project_id, node_id, run_id, data) VALUES (?, ?, ?, ?, ?)').run(artifact.id, artifact.projectId, artifact.nodeId, artifact.runId, JSON.stringify(metadata));
    return artifact;
  }

  private readArtifact(metadata: Omit<Artifact, 'content'>): Artifact {
    if (!/^[a-f0-9]{64}$/.test(metadata.hash)) throw new StoreError('Invalid artifact storage reference', 500);
    const content = readFileSync(join(this.artifactDir, `${metadata.hash}.txt`), 'utf8');
    if (createHash('sha256').update(content, 'utf8').digest('hex') !== metadata.hash) throw new StoreError('Artifact storage integrity failure', 500);
    return { ...metadata, content };
  }

  getArtifact(id: string): Artifact { return this.readArtifact(this.one<Omit<Artifact, 'content'>>('SELECT data FROM artifacts WHERE id = ?', id, 'Artifact')); }
  listArtifacts(projectId: string): Artifact[] { this.getProject(projectId); return this.all<Omit<Artifact, 'content'>>('SELECT data FROM artifacts WHERE project_id = ? ORDER BY rowid DESC', projectId).map(metadata => this.readArtifact(metadata)); }

  addUsage(record: UsageRecord): UsageRecord {
    identifier.parse(record.id);
    z.union([z.enum(['nebius', 'tavily', 'openai', 'claude', 'exa', 'brave']),z.string().regex(/^custom-[0-9a-f-]{36}$/)]).parse(record.provider);
    z.number().finite().nonnegative().parse(record.reservedUsd);
    if (record.estimatedUsd !== null) z.number().finite().nonnegative().parse(record.estimatedUsd);
    z.enum(['reserved', 'settled', 'uncertain']).parse(record.status);
    if (record.runId) this.getRun(record.runId);
    this.db.prepare('INSERT INTO usage(id, data) VALUES (?, ?)').run(record.id, JSON.stringify(record));
    return clone(record);
  }

  updateUsage(id: string, patch: Partial<UsageRecord>): UsageRecord {
    const record = this.one<UsageRecord>('SELECT data FROM usage WHERE id = ?', id, 'Usage record');
    for (const key of ['id', 'provider', 'purpose', 'runId', 'createdAt', 'reservedUsd'] as const) if (key in patch && JSON.stringify(patch[key]) !== JSON.stringify(record[key])) throw new StoreError(`Usage ${key} is immutable`);
    const updated = { ...record, ...clone(patch) };
    if (updated.estimatedUsd !== null) z.number().finite().nonnegative().parse(updated.estimatedUsd);
    z.enum(['reserved', 'settled', 'uncertain']).parse(updated.status);
    this.db.prepare('UPDATE usage SET data = ? WHERE id = ?').run(JSON.stringify(updated), id);
    return updated;
  }

  listUsage(): UsageRecord[] { return this.all<UsageRecord>('SELECT data FROM usage ORDER BY rowid'); }
}

/** A proposal that adds several blocks to one scope is laid out by ros.ai as a
 * compact grid, so the whole batch can be read at once. It starts where the
 * proposal put its first block and moves down past existing blocks it would cover. */
export function batchGrid(operations: Mutation[], existing: readonly CanvasNode[], columns = 4): Mutation[] {
  const scopes = new Map<string | null, number[]>();
  operations.forEach((op, index) => {
    if (op.type !== 'addNode' || op.node.kind === 'group') return;
    const scope = op.node.parentId ?? null;
    scopes.set(scope, [...(scopes.get(scope) ?? []), index]);
  });
  const result = [...operations];
  for (const [scope, indexes] of scopes) {
    if (indexes.length < 3) continue;
    const nodes = indexes.map(index => (result[index] as Extract<Mutation, { type: 'addNode' }>).node);
    const count = Math.min(columns, nodes.length), stepX = Math.ceil((Math.max(...nodes.map(cardWidth)) + LAYOUT_GAP) / GRID) * GRID;
    const rows: number[] = [];
    nodes.forEach((node, index) => { const row = Math.floor(index / count); rows[row] = Math.max(rows[row] ?? 0, estimatedCardHeight(node)); });
    const width = (count - 1) * stepX + Math.max(...nodes.map(cardWidth)), height = rows.reduce((sum, row) => sum + row + LAYOUT_GAP, -LAYOUT_GAP);
    const x = snap(Math.min(...nodes.map(node => node.x))); let y = snap(Math.min(...nodes.map(node => node.y)));
    // Existing blocks in this scope the grid would cover push it down below them.
    const covered = existing.filter(other => (other.parentId ?? null) === scope && x < other.x + cardWidth(other) + LAYOUT_GAP && other.x < x + width + LAYOUT_GAP);
    if (covered.some(other => y < other.y + cardFootprintHeight(other) + LAYOUT_GAP && other.y < y + height + LAYOUT_GAP)) y = snap(Math.max(...covered.map(other => other.y + cardFootprintHeight(other) + LAYOUT_GAP)));
    let top = y;
    nodes.forEach((node, index) => {
      const column = index % count, row = Math.floor(index / count);
      if (column === 0 && row > 0) top += Math.ceil((rows[row - 1] + LAYOUT_GAP) / GRID) * GRID;
      result[indexes[index]] = { type: 'addNode', node: { ...node, x: x + column * stepX, y: top } };
    });
  }
  return result;
}
