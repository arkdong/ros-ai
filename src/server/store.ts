import type { UsageCounts, UsageKey } from '../shared/usage-counts.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { cardScale } from '../shared/card-size.js';
import { convertLegacyGroups } from '../shared/groups.js';
import { convertDecisionLogs } from '../shared/decisions.js';
import { DEFAULT_NEBIUS_MODEL, resolveModelSetting, type ModelSelection, type ProjectModelSettings } from '../shared/model-settings.js';
import type { Artifact, Canvas, CanvasNode, Change, ChangeSummary, Message, Mutation, Project, ProjectDetail, Proposal, Run, SelectedInput, UsageRecord } from '../shared/types.js';
import { currentTurn } from './turn-context.js';
import { CanvasRuleError, applyOperations, identifier } from '../shared/canvas-ops.js';

// The canvas rules live in shared/canvas-ops.ts; the modules that took them from here still do.
export { DESCRIPTION_LIMIT, RESERVED_IDS, appProposalMutationSchema, batchGrid, dashboardViewSchema, mapPinSchema, metricViewSchema, mutationSchema, paperSchema, postViewSchema, proposalMutationSchema, snapshotAppProposalMutationSchema, snapshotProposalMutationSchema, trainingViewSchema } from '../shared/canvas-ops.js';

/** A project that has not chosen for itself runs ROS with the last choice made anywhere. */
export type RosChoice = { backend?: string; model?: ModelSelection };

const now = () => new Date().toISOString();
/** Blocks that bring something in, counted as sources in the usage counts. */
const SOURCE_BLOCKS = new Set<string>(['dataset', 'file', 'notion', 'google', 'web', 'post']);
const clone = <T>(value: T): T => structuredClone(value);

export class StoreError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'StoreError'; }
}

type JsonRow = { data: string };
type NodePresentation = Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>;
type LayoutFields = { x?: number; y?: number; width?: number | null; height?: number | null };
/** A layout change the person made by hand (a resize), kept as its own undo step: per block, the fields it changed. */
type LayoutStep = Record<string, { parentId: string | null; before: LayoutFields; after: LayoutFields }>;
/** `layouts[i]`, when set, marks stack entry i as a layout step rather than a content change. */
type HistoryState = { stack: Canvas[]; cursor: number; presentation?: Record<string, NodePresentation>; layouts?: (LayoutStep | null)[] };
export type MutateOptions = { /** Keep a layout-only change (a resize) as its own undo step. */ undoableLayout?: boolean; /** Finish the undo step just made instead of adding one, so one Undo takes both away. */ sameStep?: boolean };

// Layout is a current preference, not research content. Compare canonical content
// so old position-only entries can be skipped without rewriting their snapshots.
function canvasContent(canvas: Canvas): string {
  const orderedFields = (value: object) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({
    nodes: [...canvas.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(({ x: _x, y: _y, width: _width, height: _height, ...content }) => orderedFields(content)),
    connections: [...canvas.connections].sort((a, b) => a.id.localeCompare(b.id)).map(orderedFields),
  });
}

/** Where undo or redo lands: the nearest entry with other content, or a layout step crossed on the way, whose
 * fields are then set back (undo) or again (redo). */
function historyStop(history: HistoryState, canvas: Canvas, direction: -1 | 1): { cursor: number; layout?: { step: LayoutStep; side: 'before' | 'after' } } | undefined {
  const content = canvasContent(canvas);
  for (let cursor = history.cursor + direction; cursor >= 0 && cursor < history.stack.length; cursor += direction) {
    const step = history.layouts?.[direction < 0 ? cursor + 1 : cursor];
    if (step) return { cursor, layout: { step, side: direction < 0 ? 'before' : 'after' } };
    if (canvasContent(history.stack[cursor]) !== content) return { cursor };
  }
  return undefined;
}
/** How far back Undo goes. Every step keeps the whole canvas and each edit reads and writes all of them, so without a
 * limit every project slowed down with each edit, typing included, until it was unusable. */
export const HISTORY_STEPS = 100;
function trimHistory(history: HistoryState): void {
  const extra = history.stack.length - HISTORY_STEPS;
  if (extra <= 0) return;
  history.stack = history.stack.slice(extra);
  if (history.layouts) history.layouts = history.layouts.slice(extra);
  history.cursor = Math.max(0, history.cursor - extra);
}
/** A short key for a canvas's content, kept beside each saved change so listing the changes never reads the canvases. */
const contentKey = (canvas: Canvas) => createHash('sha256').update(canvasContent(canvas)).digest('base64url');
const asObject = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The trace fields that budgets, totals and the Usage page read. */
const LEDGER_TRACE = ['authorizationId', 'projectId', 'assistantTurnId', 'nodeId', 'model', 'credits'] as const;
/** A request record as budgets, totals and the Usage page read it: its amounts, status and those trace fields, without
 * the request, prompts and reply it saved, which run to 50 to 200 KB a request. */
function ledgerEntry(usage: UsageRecord): UsageRecord {
  const trace = asObject(usage.reportedUsage);
  if (!trace) return { ...usage, reportedUsage: usage.reportedUsage ?? null };
  const kept: Record<string, unknown> = {}, response = asObject(trace.response), tokens = asObject(response?.usage);
  for (const key of LEDGER_TRACE) if (trace[key] !== undefined && (trace[key] === null || typeof trace[key] !== 'object')) kept[key] = trace[key];
  if (response) kept.response = { ...(tokens ? { usage: { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens } } : {}), ...(response.credits !== undefined ? { credits: response.credits } : {}) };
  return { ...usage, reportedUsage: kept };
}
const LAYOUT_FIELDS = ['x', 'y', 'width', 'height'] as const;
/** The layout fields each block changed between two canvases with the same content. */
function layoutStep(before: Canvas, after: Canvas): LayoutStep {
  const previous = new Map(before.nodes.map(node => [node.id, node]));
  const step: LayoutStep = {};
  for (const node of after.nodes) {
    const old = previous.get(node.id);
    if (!old || (old.parentId ?? null) !== (node.parentId ?? null)) continue;
    const from: LayoutFields = {}, to: LayoutFields = {};
    for (const field of LAYOUT_FIELDS) {
      if ((old[field] ?? null) === (node[field] ?? null)) continue;
      (from as Record<string, number | null>)[field] = old[field] ?? null;
      (to as Record<string, number | null>)[field] = node[field] ?? null;
    }
    if (Object.keys(from).length) step[node.id] = { parentId: node.parentId ?? null, before: from, after: to };
  }
  return step;
}
function applyLayout(canvas: Canvas, step: LayoutStep, side: 'before' | 'after'): Canvas {
  return { ...canvas, nodes: canvas.nodes.map(node => {
    const change = step[node.id];
    if (!change || change.parentId !== (node.parentId ?? null)) return node;
    const next = { ...node };
    for (const [field, value] of Object.entries(change[side]) as [keyof LayoutFields, number | null][]) {
      if (value === null) delete next[field];
      else (next as Record<string, unknown>)[field] = value;
    }
    return next;
  }) };
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
  // Shrinking blocks also draws them together. Undo and redo keep positions as they are now, so a block whose size
  // comes back is spread out again from the same corner, by as much as its size changes.
  const rescaled = target.nodes.flatMap(node => { const live = currentNodes.get(node.id); return live && (live.parentId ?? null) === (node.parentId ?? null) && Math.abs(cardScale(node) / cardScale(live) - 1) > 0.001 ? [live] : []; });
  const corners = new Map<string, { x: number; y: number }>();
  for (const live of rescaled) { const key = live.parentId ?? '', at = corners.get(key); corners.set(key, at ? { x: Math.min(at.x, live.x), y: Math.min(at.y, live.y) } : { x: live.x, y: live.y }); }
  return { ...clone(target), nodes: target.nodes.map(node => {
    const live = currentNodes.get(node.id);
    const saved = history.presentation?.[presentationKey(node)];
    const corner = live && rescaled.includes(live) ? corners.get(live.parentId ?? '') : undefined, ratio = live ? cardScale(node) / cardScale(live) : 1;
    const position = live && corner ? { x: Math.round(corner.x + (live.x - corner.x) * ratio), y: Math.round(corner.y + (live.y - corner.y) * ratio) }
      : live && (live.parentId ?? null) === (node.parentId ?? null) ? live : saved ?? node;
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
      CREATE TABLE IF NOT EXISTS usage_ledger (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      -- A request record changed by anything, an earlier ros.ai on the same data included, loses its slim copy until
      -- usageLedger makes it again, so the copy is never out of date.
      CREATE TRIGGER IF NOT EXISTS usage_ledger_changed AFTER UPDATE ON usage BEGIN DELETE FROM usage_ledger WHERE id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS usage_ledger_removed AFTER DELETE ON usage BEGIN DELETE FROM usage_ledger WHERE id = OLD.id; END;
      CREATE TABLE IF NOT EXISTS workspace_records (namespace TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL, PRIMARY KEY(namespace,id));
      CREATE TABLE IF NOT EXISTS global_records (namespace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace,id));
      CREATE INDEX IF NOT EXISTS messages_scope ON messages(project_id, node_id);
      CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id);
      CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id);
      CREATE INDEX IF NOT EXISTS inputs_project ON inputs(project_id);
    `);
    // Each saved change also keeps its label, time and a key for its content beside the canvas, so the project page lists
    // changes without reading every canvas. Changes saved before these columns get them the first time they are listed.
    const changeColumns = new Set((this.db.prepare('PRAGMA table_info(changes)').all() as { name: string }[]).map(column => column.name));
    for (const column of ['label', 'created_at', 'content']) if (!changeColumns.has(column)) this.db.exec(`ALTER TABLE changes ADD COLUMN ${column} TEXT`);
    // The list is read from this index alone: the canvases sit in the same rows, and reading past them is most of the cost.
    this.db.exec('CREATE INDEX IF NOT EXISTS changes_list ON changes(project_id, revision, id, label, created_at, content)');
    // Preparation/import clients may join a running service. Only the owning
    // service startup should reconcile interrupted work.
    if (options.recoverInterrupted !== false) this.transaction(() => {
      for (const run of this.all<Run>('SELECT data FROM runs ORDER BY rowid')) {
        if (run.status !== 'running' && run.status !== 'queued') continue;
        run.status = 'interrupted';
        run.endedAt = now();
        if (run.configuration.kind === 'local-experiment') {
          run.error = 'Application stopped before this local experiment finished. Any orphaned worker is bounded by its CPU/time limits; no work is replayed. Preview and approve a new attempt.';
          const approval = run.configuration.approval as {status?:string} | undefined;
          if (approval?.status === 'pending') run.configuration.approval = { ...approval, status: 'cancelled', decidedAt: run.endedAt, decisionReason: 'Application restarted before an approval decision; a new preview is required.' };
        } else {
          run.error = 'Application stopped before this run finished. The provider outcome may be unknown. Retry explicitly to start a new attempt.';
        }
        run.events.push({ at: run.endedAt, type: 'interrupted', message: run.error });
        this.db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(JSON.stringify(run), run.id);
      }
      for (const usage of this.usageLedger()) if (usage.status === 'reserved') this.updateUsage(usage.id, { status: 'uncertain' });
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
  /** Today's usage counts (UTC day) go up by one: numbers only, which UsageCounts sends to ros.ai cloud while that is on. */
  countUsage(key:UsageKey,by=1) { if(by<=0)return; const day=now().slice(0,10), counts=this.globalRecord<UsageCounts>('usage-counts',day)??{}; this.saveGlobalRecord('usage-counts',day,{...counts,[key]:(counts[key]??0)+by}); }
  /** Each day's usage counts, oldest first. */
  usageDays():{day:string;counts:UsageCounts}[] { return (this.db.prepare("SELECT id, data FROM global_records WHERE namespace='usage-counts' ORDER BY id").all() as {id:string;data:string}[]).map(row=>({day:row.id,counts:JSON.parse(row.data) as UsageCounts})); }

  record<T>(namespace:string,id:string):T|undefined {
    const row=this.db.prepare('SELECT data FROM workspace_records WHERE namespace = ? AND id = ?').get(namespace,id) as JsonRow|undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  records<T>(namespace:string,projectId:string):T[] { this.getProject(projectId); return this.all<T>('SELECT data FROM workspace_records WHERE namespace = ? AND project_id = ? ORDER BY rowid',namespace,projectId); }
  /** Whether a project is in Trash, read without the project itself. */
  inTrash(projectId:string):boolean { return Boolean(this.db.prepare('SELECT 1 FROM project_trash WHERE project_id = ?').get(projectId)); }
  /** Every record of one kind, in every project, Trash included, without reading the projects. */
  recordsOfKind<T>(namespace:string):T[] { return this.all<T>('SELECT data FROM workspace_records WHERE namespace = ? ORDER BY rowid',namespace); }
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
    if(this.listRuns(id).some(run=>['queued','running'].includes(run.status))||this.records<{status:string}>('assistant-turn',id).some(turn=>turn.status==='running'))throw new StoreError('Stop running work before moving this project to Trash.',409);
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
      this.countUsage('workspaces');
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
      this.undoable.delete(id);
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
    const { canUndo, canRedo } = this.undoState(project);
    return { project, messages: this.all<Message>('SELECT data FROM messages WHERE project_id = ? ORDER BY rowid', id), proposals: this.all<Proposal>('SELECT data FROM proposals WHERE project_id = ? ORDER BY rowid', id), changes: this.listChanges(id), runs: this.listRuns(id), artifacts: this.listArtifacts(id), inputs: this.all<SelectedInput>('SELECT data FROM inputs WHERE project_id = ? ORDER BY rowid', id), canUndo, canRedo, highlights:this.records('highlight',id), notebooks:this.records('notebook-summary',id) };
  }

  /** Whether Undo and Redo have somewhere to go. The page asks on every reload, so the answer is kept until the canvas
   * changes: every edit, undo and redo gives the project a new revision or time. */
  private readonly undoable = new Map<string, { at: string; canUndo: boolean; canRedo: boolean }>();
  private undoState(project: Project): { canUndo: boolean; canRedo: boolean } {
    const at = `${project.revision}:${project.updatedAt}`, known = this.undoable.get(project.id);
    if (known?.at === at) return known;
    const history = this.getHistory(project.id);
    const state = { at, canUndo: historyStop(history, project.canvas, -1) !== undefined, canRedo: historyStop(history, project.canvas, 1) !== undefined };
    // Inside a transaction the state may still be rolled back.
    if (this.transactionDepth === 0) this.undoable.set(project.id, state);
    return state;
  }

  private getHistory(id: string): HistoryState {
    const row = this.db.prepare('SELECT history FROM projects WHERE id = ?').get(id) as { history: string } | undefined;
    if (!row) throw new StoreError('Project not found', 404);
    return JSON.parse(row.history) as HistoryState;
  }

  private recordChange(project: Project, label: string): void {
    const change: Change = { id: randomUUID(), projectId: project.id, revision: project.revision, label, canvas: clone(project.canvas), createdAt: project.updatedAt };
    this.db.prepare('INSERT INTO changes(id, project_id, revision, data, label, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?)').run(change.id, project.id, project.revision, JSON.stringify(change), label, change.createdAt, contentKey(change.canvas));
  }


  /** The canvas rules (shared/canvas-ops.ts) with what they look up in this store: ids already used, and saved versions. */
  private applyOperations(project: Project, supplied: Mutation[], proposal: boolean, arranged = false): { canvas: Canvas; operations: Mutation[] } {
    try {
      return applyOperations(project, supplied, {
        retired: nodeId => Boolean(this.db.prepare('SELECT 1 FROM node_identities WHERE project_id = ? AND node_id = ?').get(project.id, nodeId)),
        artifact: id => this.getArtifact(id),
        savedArtifact: id => { const row = this.db.prepare('SELECT data FROM artifacts WHERE id = ?').get(id) as JsonRow | undefined; return row ? JSON.parse(row.data) as Omit<Artifact, 'content'> : undefined; },
      }, proposal, arranged);
    } catch (error) {
      if (error instanceof CanvasRuleError) throw new StoreError(error.message);
      throw error;
    }
  }

  private commitCanvas(project: Project, canvas: Canvas, label: string, history: HistoryState): Project {
    const updated = { ...project, canvas, revision: project.revision + 1, updatedAt: now() };
    this.db.prepare('UPDATE projects SET data = ?, history = ? WHERE id = ?').run(JSON.stringify(updated), JSON.stringify(history), project.id);
    for (const node of canvas.nodes) this.db.prepare('INSERT OR IGNORE INTO node_identities(project_id, node_id) VALUES (?, ?)').run(project.id, node.id);
    this.recordChange(updated, label);
    // A turn's own writes (a search's sources, saved findings, a browser log) keep its waiting changes acceptable.
    const turn = currentTurn();
    if (turn) this.keepCurrent(updated, turn, project.revision);
    this.committed(project.id);
    return updated;
  }

  /** The waiting changes of one batch (one turn's) that were current at revision `from`, checked again on the canvas as
   * it is now: each that still applies stays acceptable, and one that no longer does stays out of date. */
  private keepCurrent(project: Project, batch: string, from: number): void {
    const waiting = this.all<Proposal>("SELECT data FROM proposals WHERE project_id = ? AND json_extract(data, '$.status') = 'pending' AND json_extract(data, '$.batch') = ? ORDER BY rowid", project.id, batch);
    for (const other of waiting) {
      if (other.baseRevision !== from) continue;
      try {
        const after = (other.after ?? []).flatMap(id => { const before = this.one<Proposal>('SELECT data FROM proposals WHERE id = ?', id, 'Proposal'); return before.status === 'pending' ? [before] : []; });
        this.applyOperations(this.withProposals(project, after), other.operations, true, true);
        other.baseRevision = project.revision;
        this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(other), other.id);
      } catch (error) { if (!(error instanceof StoreError) && !(error instanceof z.ZodError)) throw error; }
    }
  }

  private mutateWithinTransaction(id: string, operations: Mutation[], label: string, expectedRevision?: number, options: MutateOptions = {}): Project {
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
    if (canvasContent(canvas) === canvasContent(project.canvas) && options.undoableLayout) {
      // A resize by hand is its own undo step, so Cmd+Z puts the block back; other layout stays out of undo.
      const step = layoutStep(project.canvas, canvas);
      if (Object.keys(step).length) {
        const layouts = (history.layouts ?? []).slice(0, history.cursor + 1);
        layouts[history.cursor + 1] = step;
        history.stack = [...history.stack.slice(0, history.cursor + 1), clone(canvas)];
        history.cursor++;
        history.layouts = Array.from(layouts, entry => entry ?? null);
        trimHistory(history);
        return this.commitCanvas(project, canvas, checkedLabel, history);
      }
    }
    if (canvasContent(canvas) === canvasContent(project.canvas)) {
      // Do not advance content revision, append a snapshot, or discard redo.
      // Captured evidence and approvals keep their original immutable inputs.
      const updated = { ...project, canvas, updatedAt: now() };
      this.db.prepare('UPDATE projects SET data = ?, history = ? WHERE id = ?').run(JSON.stringify(updated), JSON.stringify(history), id);
      this.committed(id);
      return updated;
    }
    const at = options.sameStep && history.cursor > 0 ? history.cursor : history.cursor + 1;
    history.stack = [...history.stack.slice(0, at), clone(canvas)];
    if (history.layouts) history.layouts = history.layouts.slice(0, at);
    history.cursor = at;
    trimHistory(history);
    // Blocks restored from the project folder were counted when they were first added.
    if (!checkedLabel.endsWith(' from the project folder')) {
      const added = operations.flatMap(operation => operation.type === 'addNode' ? [operation.node as Partial<CanvasNode>] : []);
      this.countUsage('sources', added.filter(node => (node.blockType && SOURCE_BLOCKS.has(node.blockType)) || node.paper).length);
      this.countUsage('reports', added.filter(node => node.blockType === 'report').length);
    }
    return this.commitCanvas(project, canvas, checkedLabel, history);
  }

  mutate(id: string, operations: Mutation[], label: string, expectedRevision?: number, options?: MutateOptions): Project {
    return this.transaction(() => this.mutateWithinTransaction(id, operations, label, expectedRevision, options));
  }

  /**
   * Pasted blocks, as one step for Undo. A block pasted from another project gets its own copy of the original's saved
   * version (`copies`), recorded as a run that says where it came from; no model or code runs.
   */
  pasteBlocks(id: string, operations: Mutation[], label: string, expectedRevision: number | undefined, copies: { nodeId: string; artifactId: string }[]): Project {
    return this.transaction(() => {
      const revision = this.getProject(id).revision;
      const pasted = this.mutateWithinTransaction(id, operations, label, expectedRevision), patches: Mutation[] = [];
      for (const { nodeId, artifactId } of copies) {
        const node = pasted.canvas.nodes.find(item => item.id === nodeId), source = this.getArtifact(artifactId), at = now();
        if (!node) continue;
        const run: Run = { id: randomUUID(), projectId: id, nodeId, request: `Paste ${source.title}`, useSearch: false, status: 'running', createdAt: at, startedAt: at, projectRevision: pasted.revision,
          node: clone(node), inputs: [], messages: [], provider: 'local', model: 'paste-v1', modelVersion: null, configuration: { kind: 'paste', fromProjectId: source.projectId, fromArtifactId: source.id },
          tools: [], events: [{ at, type: 'paste', message: 'Copied from another project. No model or code ran.' }], artifactIds: [] };
        this.createRun(run);
        const { id: _id, hash: _hash, createdAt: _createdAt, sourceId: _sourceId, projectId: _projectId, nodeId: _nodeId, runId: _runId, content, ...kept } = source;
        const copy = this.addArtifact({ ...kept, content, projectId: id, nodeId, runId: run.id, metadata: { ...kept.metadata, copiedFrom: { projectId: source.projectId, artifactId: source.id } } });
        this.updateRun(run.id, { status: 'completed', endedAt: at, artifactIds: [copy.id] });
        patches.push({ type: 'updateNode', id: nodeId, patch: { artifactId: copy.id } });
      }
      if (!patches.length) return pasted;
      // The blocks and their saved versions arrive together, so one Undo takes both away.
      return this.mutateWithinTransaction(id, patches, label, undefined, { sameStep: pasted.revision > revision });
    });
  }

  private travelHistory(id: string, direction: -1 | 1): Project {
    return this.transaction(() => {
      const project = this.getProject(id);
      const history = this.getHistory(id);
      const stop = historyStop(history, project.canvas, direction);
      if (stop === undefined) throw new StoreError(direction < 0 ? 'Nothing to undo' : 'Nothing to redo', 409);
      history.cursor = stop.cursor;
      rememberPresentation(history, project.canvas);
      const restored = restoreContent(history, history.stack[stop.cursor], project.canvas);
      const canvas = stop.layout ? applyLayout(restored, stop.layout.step, stop.layout.side) : restored;
      rememberPresentation(history, canvas);
      return this.commitCanvas(project, canvas, direction < 0 ? 'Undo canvas edit' : 'Redo canvas edit', history);
    });
  }

  undo(id: string): Project { return this.travelHistory(id, -1); }
  redo(id: string): Project { return this.travelHistory(id, 1); }
  /** The project's content changes, each without its canvas (getChange has it). A change that left the content as it was,
   * such as moving blocks, is left out. */
  listChanges(id: string): ChangeSummary[] {
    this.getProject(id);
    const rows = this.db.prepare('SELECT id, revision, label, created_at, content FROM changes WHERE project_id = ? ORDER BY revision').all(id) as { id: string; revision: number; label: string | null; created_at: string | null; content: string | null }[];
    // Changes saved before the label, time and content columns existed get them once. Their saved data stays as it was.
    const missing = rows.filter(row => row.content === null);
    if (missing.length) this.transaction(() => {
      for (const row of missing) {
        const change = JSON.parse((this.db.prepare('SELECT data FROM changes WHERE id = ?').get(row.id) as JsonRow).data) as Change;
        Object.assign(row, { label: change.label, created_at: change.createdAt, content: contentKey(change.canvas) });
        this.db.prepare('UPDATE changes SET label = ?, created_at = ?, content = ? WHERE id = ?').run(row.label, row.created_at, row.content, row.id);
      }
    });
    let previous: string | null = null;
    return rows.filter(row => {
      const meaningful = previous === null || row.content !== previous;
      previous = row.content;
      return meaningful;
    }).map(row => ({ id: row.id, projectId: id, revision: row.revision, label: row.label ?? '', createdAt: row.created_at ?? '' }));
  }
  /** One saved change with its canvas, for looking at the canvas as it was then. */
  getChange(projectId: string, changeId: string): Change {
    this.getProject(projectId);
    const row = this.db.prepare('SELECT data FROM changes WHERE project_id = ? AND id = ?').get(projectId, changeId) as JsonRow | undefined;
    if (!row) throw new StoreError('Change not found', 404);
    return JSON.parse(row.data) as Change;
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
      // Changes proposed in one turn form one batch, so accepting one, or the turn's own writes, leave the rest acceptable.
      const batch = links.batch ?? currentTurn();
      const proposal: Proposal = { id: randomUUID(), projectId, baseRevision, summary: z.string().trim().min(1).max(5_000).parse(summary), operations, status: 'pending', createdAt: now(), ...(after.length ? { after: after.map(p => p.id) } : {}), ...(batch ? { batch } : {}) };
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
      // Marked first, so the rest of its batch is checked without it; a failed accept rolls this back with the canvas.
      proposal.status = 'accepted';
      this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(proposal), proposalId);
      const project = this.mutateWithinTransaction(projectId, proposal.operations, `Accepted proposal: ${proposal.summary}`.slice(0, 500), proposal.baseRevision);
      // The rest of its batch still applies to the new canvas, so it stays acceptable; one that no longer does stays stale.
      if (proposal.batch && project.revision !== proposal.baseRevision) this.keepCurrent(project, proposal.batch, proposal.baseRevision);
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
  /** counted: false for a copy of a message already sent (a branched thread), which is not a new message to an agent. */
  addMessage(projectId: string, nodeId: string | null, role: Message['role'], content: string, runId?: string, threadId?: string, counted = true): Message {
    this.getProject(projectId);
    if (nodeId !== null) this.requireNode(projectId, nodeId, true);
    if (runId) {
      const run = this.getRun(runId);
      if (run.projectId !== projectId || run.nodeId !== nodeId) throw new StoreError('Run does not belong to this conversation');
    }
    if (threadId !== undefined && nodeId !== null) throw new StoreError('Only project messages belong to a ROS thread');
    const message: Message = { id: randomUUID(), projectId, nodeId, role: z.enum(['user', 'assistant', 'system']).parse(role), content: z.string().min(1).max(1_000_000).parse(content), createdAt: now(), ...(runId ? { runId } : {}), ...(threadId ? { threadId } : {}) };
    this.db.prepare('INSERT INTO messages(id, project_id, node_id, data) VALUES (?, ?, ?, ?)').run(message.id, projectId, nodeId, JSON.stringify(message));
    if (message.role === 'user' && counted) this.countUsage('conversations');
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
    if (run.configuration.kind === 'local-experiment') this.countUsage('python_runs');
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
    this.transaction(() => {
      this.db.prepare('INSERT INTO usage(id, data) VALUES (?, ?)').run(record.id, JSON.stringify(record));
      this.writeLedger(record);
    });
    return clone(record);
  }

  updateUsage(id: string, patch: Partial<UsageRecord>): UsageRecord {
    const record = this.one<UsageRecord>('SELECT data FROM usage WHERE id = ?', id, 'Usage record');
    for (const key of ['id', 'provider', 'purpose', 'runId', 'createdAt', 'reservedUsd'] as const) if (key in patch && JSON.stringify(patch[key]) !== JSON.stringify(record[key])) throw new StoreError(`Usage ${key} is immutable`);
    const updated = { ...record, ...clone(patch) };
    if (updated.estimatedUsd !== null) z.number().finite().nonnegative().parse(updated.estimatedUsd);
    z.enum(['reserved', 'settled', 'uncertain']).parse(updated.status);
    this.transaction(() => {
      this.db.prepare('UPDATE usage SET data = ? WHERE id = ?').run(JSON.stringify(updated), id);
      this.writeLedger(updated);
    });
    return updated;
  }
  private writeLedger(usage: UsageRecord): void {
    this.db.prepare('INSERT INTO usage_ledger(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(usage.id, JSON.stringify(ledgerEntry(usage)));
  }

  /** Every request record in full, with the request, prompts and reply it saved. Budgets and totals use usageLedger. */
  listUsage(): UsageRecord[] { return this.all<UsageRecord>('SELECT data FROM usage ORDER BY rowid'); }
  /** Every request record, in the order listUsage gives, with only what budgets, totals and the Usage page read (see
   * ledgerEntry). Checked on every paid request, so it reads the saved requests and replies only of records that have no
   * slim copy yet: those saved before the copy existed, or changed since by an earlier ros.ai. */
  usageLedger(): UsageRecord[] {
    const unlisted = this.db.prepare('SELECT id FROM usage WHERE id NOT IN (SELECT id FROM usage_ledger)').all() as { id: string }[];
    if (unlisted.length) this.transaction(() => {
      const read = this.db.prepare('SELECT data FROM usage WHERE id = ?');
      for (const { id } of unlisted) { const row = read.get(id) as JsonRow | undefined; if (row) this.writeLedger(JSON.parse(row.data) as UsageRecord); }
    });
    return this.all<UsageRecord>('SELECT usage_ledger.data FROM usage_ledger JOIN usage ON usage.id = usage_ledger.id ORDER BY usage.rowid');
  }
  /** One request record in full. */
  getUsage(id: string): UsageRecord | undefined {
    const row = this.db.prepare('SELECT data FROM usage WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as UsageRecord : undefined;
  }
  /** The project a run belongs to, read without the run itself. */
  runProjectId(runId: string): string | undefined {
    return (this.db.prepare('SELECT project_id FROM runs WHERE id = ?').get(runId) as { project_id: string } | undefined)?.project_id;
  }
}
