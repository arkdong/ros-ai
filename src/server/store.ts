import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { LAYOUT_GAP } from '../shared/layout.js';
import { CARD_MIN_WIDTH, CARD_MAX_WIDTH, CARD_MAX_HEIGHT, cardWidth } from '../shared/card-size.js';
import type { Artifact, Canvas, CanvasNode, Change, Message, Mutation, Project, ProjectDetail, Proposal, Run, SelectedInput, UsageRecord } from '../shared/types.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const nodeFields = { title: z.string().trim().min(1).max(200), description: z.string().max(20_000), x: coordinate, y: coordinate, width: z.number().int().min(CARD_MIN_WIDTH).max(CARD_MAX_WIDTH).optional(), kind: z.enum(['topic', 'activity', 'unspecified']).optional(), parentId: identifier.nullable().optional() };
const nodeSchema = z.object({ id: identifier, ...nodeFields }).strict();
const connectionSchema = z.object({ id: identifier, source: identifier, target: identifier, label: z.string().max(200),sourceHandle:z.enum(['top','right','bottom','left']).optional(),targetHandle:z.enum(['top','right','bottom','left']).optional() }).strict();
export const mutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addNode'), node: nodeSchema }).strict(),
  z.object({ type: z.literal('updateNode'), id: identifier, patch: z.object(nodeFields).partial().strict().refine(value => Object.keys(value).length > 0, 'An update must contain a change') }).strict(),
  z.object({ type: z.literal('removeNode'), id: identifier }).strict(),
  z.object({ type: z.literal('addConnection'), connection: connectionSchema }).strict(),
  z.object({ type: z.literal('removeConnection'), id: identifier }).strict(),
]);
const operationsSchema = z.array(mutationSchema).min(1).max(500);
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const GRID = 24;
// Placement runs before the browser measures outcome content. Reserve the
// bounded maximum height; explicit Arrange uses actual measured footprints.
const CARD_HEIGHT = CARD_MAX_HEIGHT;
const MAX_NODES = 500;
const MAX_CONNECTIONS = 2_000;
const snap = (value: number) => Math.round(value / GRID) * GRID;

export class StoreError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'StoreError'; }
}

type JsonRow = { data: string };
type NodePresentation = Pick<CanvasNode, 'x' | 'y' | 'width'>;
type HistoryState = { stack: Canvas[]; cursor: number; presentation?: Record<string, NodePresentation> };

// Layout is a current preference, not research content. Compare canonical content
// so old position-only entries can be skipped without rewriting their snapshots.
function canvasContent(canvas: Canvas): string {
  const orderedFields = (value: object) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({
    nodes: [...canvas.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(({ x: _x, y: _y, width: _width, ...content }) => orderedFields(content)),
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
  for (const node of canvas.nodes) history.presentation[presentationKey(node)] = { x: node.x, y: node.y, ...(node.width === undefined ? {} : { width: node.width }) };
}
function restoreContent(history: HistoryState, target: Canvas, current: Canvas): Canvas {
  const currentNodes = new Map(current.nodes.map(node => [node.id, node]));
  return { ...clone(target), nodes: target.nodes.map(node => {
    const live = currentNodes.get(node.id);
    const saved = history.presentation?.[presentationKey(node)];
    const position = live && (live.parentId ?? null) === (node.parentId ?? null) ? live : saved ?? node;
    const width = live ? live.width : saved ? saved.width : node.width;
    const restored = { ...node, x: position.x, y: position.y };
    if (width === undefined) delete restored.width;
    else restored.width = width;
    return restored;
  }) };
}

/** The only structural write boundary. Runs and captured evidence never own canvas mutation. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly artifactDir: string;
  private transactionDepth=0;

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

  record<T>(namespace:string,id:string):T|undefined {
    const row=this.db.prepare('SELECT data FROM workspace_records WHERE namespace = ? AND id = ?').get(namespace,id) as JsonRow|undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  records<T>(namespace:string,projectId:string):T[] { this.getProject(projectId); return this.all<T>('SELECT data FROM workspace_records WHERE namespace = ? AND project_id = ? ORDER BY rowid',namespace,projectId); }
  saveRecord<T>(namespace:string,id:string,projectId:string,value:T):T {
    this.getProject(projectId);
    this.db.prepare('INSERT INTO workspace_records(namespace,id,project_id,data) VALUES (?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data').run(namespace,id,projectId,JSON.stringify(value));
    return clone(value);
  }
  removeRecord(namespace:string,id:string,projectId:string) { this.db.prepare('DELETE FROM workspace_records WHERE namespace=? AND id=? AND project_id=?').run(namespace,id,projectId); }
  atomic<T>(fn:()=>T):T { return this.transaction(fn); }

  private transaction<T>(fn: () => T): T {
    const depth=this.transactionDepth++,savepoint=`ros_transaction_${depth}`;
    try{
      this.db.exec(depth===0?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
      try { const result = fn(); this.db.exec(depth===0?'COMMIT':`RELEASE ${savepoint}`); return result; }
      catch (error) { this.db.exec(depth===0?'ROLLBACK':`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
    }finally{this.transactionDepth--;}
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
    if(this.listRuns(id).some(run=>['queued','running'].includes(run.status))||this.records<{status:string}>('assistant-turn',id).some(turn=>turn.status==='running')||this.records<{status:string}>('research',id).some(session=>session.status==='running'))throw new StoreError('Stop active research and pending experiments before moving this project to Trash.',409);
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
    return this.one<Project>('SELECT data FROM projects WHERE id = ?', id, 'Project');
  }

  detail(id: string): ProjectDetail {
    const project = this.getProject(id);
    const history = this.getHistory(id);
    return { project, messages: this.all<Message>('SELECT data FROM messages WHERE project_id = ? ORDER BY rowid', id), proposals: this.all<Proposal>('SELECT data FROM proposals WHERE project_id = ? ORDER BY rowid', id), changes: this.listChanges(id), runs: this.listRuns(id), artifacts: this.listArtifacts(id), inputs: this.all<SelectedInput>('SELECT data FROM inputs WHERE project_id = ? ORDER BY rowid', id), canUndo: contentCursor(history, project.canvas, -1) !== undefined, canRedo: contentCursor(history, project.canvas, 1) !== undefined, highlights:this.records('highlight',id) };
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

  private placeNode(node: CanvasNode, others: CanvasNode[]): CanvasNode {
    const placed = { ...node, x: snap(node.x), y: snap(node.y) };
    const overlaps = () => others.some(other => (other.parentId ?? null) === (placed.parentId ?? null)
      && placed.x < other.x + cardWidth(other) + LAYOUT_GAP && other.x < placed.x + cardWidth(placed) + LAYOUT_GAP
      && Math.abs(other.y - placed.y) < CARD_HEIGHT + LAYOUT_GAP);
    const originX = placed.x;
    const stepX = Math.ceil((cardWidth(placed) + LAYOUT_GAP) / GRID) * GRID;
    const stepY = Math.ceil((CARD_HEIGHT + LAYOUT_GAP) / GRID) * GRID;
    // Deterministic placement makes the proposal preview match the accepted mutation.
    for (let attempt = 0; overlaps(); attempt++) {
      if (attempt >= MAX_NODES * 4) throw new StoreError('No free placement found near the requested position');
      placed.x = originX + ((attempt + 1) % 5) * stepX;
      placed.y = snap(node.y) + Math.floor((attempt + 1) / 5) * stepY;
    }
    coordinate.parse(placed.x); coordinate.parse(placed.y);
    return placed;
  }

  private applyOperations(project: Project, supplied: Mutation[], proposal: boolean): { canvas: Canvas; operations: Mutation[] } {
    const operations = operationsSchema.parse(supplied) as Mutation[];
    const canvas = clone(project.canvas);
    const activeNode = (id: string) => {
      const node = canvas.nodes.find(item => item.id === id);
      if (!node) throw new StoreError(`Node ${id} is not active in this project`);
      return node;
    };
    const normalized: Mutation[] = [];
    for (const operation of operations) {
      if (operation.type === 'addNode') {
        if (canvas.nodes.some(item => item.id === operation.node.id) || this.db.prepare('SELECT 1 FROM node_identities WHERE project_id = ? AND node_id = ?').get(project.id, operation.node.id)) throw new StoreError(`Node id ${operation.node.id} already exists or belongs to a removed node`);
        if (canvas.nodes.length >= MAX_NODES) throw new StoreError(`A project supports at most ${MAX_NODES} nodes`);
        const node = this.placeNode(operation.node, canvas.nodes);
        canvas.nodes.push(node); normalized.push({ type: 'addNode', node });
      } else if (operation.type === 'updateNode') {
        const node = activeNode(operation.id);
        let updated = { ...node, ...operation.patch };
        if ('x' in operation.patch || 'y' in operation.patch) {
          updated.x = snap(updated.x); updated.y = snap(updated.y);
          if (proposal) updated = this.placeNode(updated, canvas.nodes.filter(item => item.id !== node.id));
        }
        coordinate.parse(updated.x); coordinate.parse(updated.y);
        canvas.nodes = canvas.nodes.map(item => item.id === node.id ? updated : item);
        normalized.push({ type: 'updateNode', id: node.id, patch: { ...operation.patch, ...('x' in operation.patch || 'y' in operation.patch ? { x: updated.x, y: updated.y } : {}) } });
      } else if (operation.type === 'removeNode') {
        activeNode(operation.id);
        // Removing a workspace removes its children in the same undoable edit;
        // durable identities, runs, messages and artifacts remain untouched.
        const removed = new Set([operation.id, ...canvas.nodes.filter(item => item.parentId === operation.id).map(item => item.id)]);
        for(let previous=-1; previous!==removed.size;) { previous=removed.size; for(const item of canvas.nodes) if(item.parentId && removed.has(item.parentId)) removed.add(item.id); }
        canvas.nodes = canvas.nodes.filter(item => !removed.has(item.id));
        canvas.connections = canvas.connections.filter(item => !removed.has(item.source) && !removed.has(item.target));
        normalized.push(operation);
      } else if (operation.type === 'addConnection') {
        const connection = operation.connection;
        activeNode(connection.source); activeNode(connection.target);
        if (connection.source === connection.target) throw new StoreError('Connect two different nodes');
        if (canvas.connections.some(item => item.id === connection.id)) throw new StoreError('Connection id already exists');
        if (canvas.connections.some(item => item.source === connection.source && item.target === connection.target)) throw new StoreError('These nodes are already connected');
        if (canvas.connections.length >= MAX_CONNECTIONS) throw new StoreError(`A project supports at most ${MAX_CONNECTIONS} connections`);
        canvas.connections.push(connection); normalized.push(operation);
      } else {
        if (!canvas.connections.some(item => item.id === operation.id)) throw new StoreError('Connection is not active in this project');
        canvas.connections = canvas.connections.filter(item => item.id !== operation.id); normalized.push(operation);
      }
    }
    // Validate the final transaction, allowing a proposal to add parent and
    // child together. Deeper nesting is allowed; missing parents and cycles are not.
    for (const node of canvas.nodes) {
      if (!node.parentId) continue;
      const seen=new Set([node.id]); let parentId:string|null|undefined=node.parentId;
      while(parentId) { if(seen.has(parentId)) throw new StoreError('A workspace cannot contain itself or a parent cycle'); seen.add(parentId); parentId=activeNode(parentId).parentId; }
    }
    // Relationships can span branches; they never move notes or import artifacts.
    return { canvas, operations: normalized };
  }

  private commitCanvas(project: Project, canvas: Canvas, label: string, history: HistoryState): Project {
    const updated = { ...project, canvas, revision: project.revision + 1, updatedAt: now() };
    this.db.prepare('UPDATE projects SET data = ?, history = ? WHERE id = ?').run(JSON.stringify(updated), JSON.stringify(history), project.id);
    for (const node of canvas.nodes) this.db.prepare('INSERT OR IGNORE INTO node_identities(project_id, node_id) VALUES (?, ?)').run(project.id, node.id);
    this.recordChange(updated, label);
    return updated;
  }

  private mutateWithinTransaction(id: string, operations: Mutation[], label: string, expectedRevision?: number): Project {
    const project = this.getProject(id);
    if (expectedRevision !== undefined && expectedRevision !== project.revision) throw new StoreError('The canvas has changed. Refresh and review the latest version.', 409);
    const { canvas } = this.applyOperations(project, operations, false);
    const checkedLabel = z.string().min(1).max(500).parse(label);
    if (JSON.stringify(canvas) === JSON.stringify(project.canvas)) return project;
    const history = this.getHistory(id);
    rememberPresentation(history, project.canvas);
    rememberPresentation(history, canvas);
    if (canvasContent(canvas) === canvasContent(project.canvas)) {
      // Do not advance content revision, append a snapshot, or discard redo.
      // Captured evidence and approvals keep their original immutable inputs.
      const updated = { ...project, canvas, updatedAt: now() };
      this.db.prepare('UPDATE projects SET data = ?, history = ? WHERE id = ?').run(JSON.stringify(updated), JSON.stringify(history), id);
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

  createProposal(projectId: string, baseRevision: number, summary: string, supplied: Mutation[]): Proposal {
    return this.transaction(() => {
      const project = this.getProject(projectId);
      if (project.revision !== baseRevision) throw new StoreError('The canvas changed while this proposal was generated. Request an updated preview.', 409);
      const { operations } = this.applyOperations(project, supplied, true);
      const proposal: Proposal = { id: randomUUID(), projectId, baseRevision, summary: z.string().trim().min(1).max(5_000).parse(summary), operations, status: 'pending', createdAt: now() };
      this.db.prepare('INSERT INTO proposals(id, project_id, data) VALUES (?, ?, ?)').run(proposal.id, projectId, JSON.stringify(proposal));
      return proposal;
    });
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
      const project = this.mutateWithinTransaction(projectId, proposal.operations, `Accepted proposal: ${proposal.summary}`.slice(0, 500), proposal.baseRevision);
      proposal.status = 'accepted';
      this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(proposal), proposalId);
      return project;
    });
  }

  dismissProposal(projectId: string, proposalId: string): Proposal {
    return this.transaction(() => {
      const proposal = this.getProposal(projectId, proposalId);
      proposal.status = 'dismissed';
      this.db.prepare('UPDATE proposals SET data = ? WHERE id = ?').run(JSON.stringify(proposal), proposalId);
      return proposal;
    });
  }

  private requireNode(projectId: string, nodeId: string, includeRemoved = false): void {
    const project = this.getProject(projectId);
    if (includeRemoved ? !this.db.prepare('SELECT 1 FROM node_identities WHERE project_id = ? AND node_id = ?').get(projectId, nodeId) : !project.canvas.nodes.some(node => node.id === nodeId)) throw new StoreError('Node not found in this project', 404);
  }

  addMessage(projectId: string, nodeId: string | null, role: Message['role'], content: string, runId?: string): Message {
    this.getProject(projectId);
    if (nodeId !== null) this.requireNode(projectId, nodeId, true);
    if (runId) {
      const run = this.getRun(runId);
      if (run.projectId !== projectId || run.nodeId !== nodeId) throw new StoreError('Run does not belong to this conversation');
    }
    const message: Message = { id: randomUUID(), projectId, nodeId, role: z.enum(['user', 'assistant', 'system']).parse(role), content: z.string().min(1).max(1_000_000).parse(content), createdAt: now(), ...(runId ? { runId } : {}) };
    this.db.prepare('INSERT INTO messages(id, project_id, node_id, data) VALUES (?, ?, ?, ?)').run(message.id, projectId, nodeId, JSON.stringify(message));
    return message;
  }

  listMessages(projectId: string, nodeId: string | null): Message[] {
    this.getProject(projectId);
    if (nodeId !== null) this.requireNode(projectId, nodeId, true);
    return this.all<Message>('SELECT data FROM messages WHERE project_id = ? AND node_id IS ? ORDER BY rowid', projectId, nodeId);
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
    const immutable = ['id', 'projectId', 'nodeId', 'request', 'useSearch', 'retryOf', 'createdAt', 'projectRevision', 'node', 'inputs', 'provider', 'model', 'modelVersion'] as const;
    for (const key of immutable) if (key in patch && JSON.stringify(patch[key]) !== JSON.stringify(run[key])) throw new StoreError(`Run ${key} is immutable`);
    if (!['queued', 'running'].includes(run.status)) throw new StoreError('Finished runs are immutable', 409);
    if (patch.status) z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).parse(patch.status);
    const updated = { ...run, ...clone(patch) };
    for (const artifactId of updated.artifactIds) {
      const artifact = this.getArtifact(artifactId);
      if (artifact.runId !== id) throw new StoreError('Run output does not belong to this run');
    }
    this.db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(this.serializeRun(updated), id);
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
    z.enum(['result', 'source', 'dataset', 'code', 'table', 'metric', 'plot', 'log']).parse(input.kind);
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
    z.enum(['nebius', 'tavily', 'openai']).parse(record.provider);
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
