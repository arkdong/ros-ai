import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import type { Authority } from './authority.js';
import { forgetNotebookNames, reviewNotebookCell, type NotebookNames } from './review-code.js';
import type { Confine, PythonRuntime } from './local-python.js';
import { kernelImage, NotebookKernelProcess, removeLeftoverKernels, type KernelExit, type KernelFolder, type KernelMessage } from './notebook-kernel.js';
import { NOTEBOOK_LIMITS, type NotebookCell, type NotebookContent, type NotebookEvent, type NotebookKernel, type NotebookOutput,
  type NotebookRunResult, type NotebookState, type NotebookSummary } from '../shared/notebooks.js';
import type { ApprovalMode } from '../shared/research.js';
import type { Artifact, CanvasNode, Run } from '../shared/types.js';

export const NOTEBOOK_ROUTE = '/api/projects/:id/nodes/:nodeId/notebook';
const DOCUMENT = 'notebook-document', PREVIOUS = 'notebook-previous', EXECUTION = 'notebook-execution', SUMMARY = 'notebook-summary';
const IDLE_MS = NOTEBOOK_LIMITS.idleStopMinutes * 60_000, START_MS = 90_000;
const METADATA = { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } };
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const now = () => new Date().toISOString();
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('') : null;
const isJson = (mime: string) => mime === 'application/json' || mime.endsWith('+json');
const newCellId = () => randomUUID().replaceAll('-', '').slice(0, 12);
/** A plain number, also as NumPy 2 shows scalars, for example np.float64(4.0). */
/** A Markdown cell as plain words for the canvas card: headings, emphasis, links and pictures lose their marks. */
const plainMarkdown = (text: string) => text.replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
  .replace(/^ {0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gmu, '').replace(/\*\*|__|~~|`|\*/gu, '').trim();
const numberText = (plain: string): string | null => { const value = plain.trim().replace(/^np\.(?:float|int|uint)\d*\((.+)\)$/u, '$1'); return /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/iu.test(value) && Number.isFinite(Number(value)) ? value : null; };
const cellIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);

/** The document as kept in ros.ai. `fileHash` is the exact file it was read from, until ros.ai changes it. */
type Stored = NotebookContent & { fileHash?: string };
type Previous = { content: Stored; reason: string; at: string };
/** `names` are what the automatic reviewer knows after this cell, if it and every cell before it finish. */
type Pending = { execution: string; cellId: string; source: string; reviewable: string; names?: NotebookNames; queuedAt: string; approval: { mode: ApprovalMode; outcome: 'allow' | 'approved'; reason: string } };
type Running = Pending & { count: number; session: string; startedAt: string; outputs: NotebookOutput[] };
type Live = { key: string; projectId: string; nodeId: string; kernel?: NotebookKernelProcess; status: NotebookKernel['status']; count: number;
  queue: Pending[]; running?: Running; info?: { python: string; libraries: Record<string, string>; cwd: string }; message?: string; stopMessage?: string;
  settled?: NotebookNames; idle?: NodeJS.Timeout; startup?: NodeJS.Timeout; usedAt: number; folder?: KernelFolder };
type Execution = { id: string; projectId: string; nodeId: string; cellId: string; session: string; executionCount: number; source: string; sourceHash: string;
  status: 'ok' | 'error' | 'interrupted'; approval: Pending['approval']; queuedAt: string; startedAt: string; endedAt: string; outputs: { type: string; mimes?: string[]; hash: string }[] };
/** The project folder's side of a notebook: where its .ipynb is, and the one folder its cells may write to. */
export interface NotebookFolders {
  notebookFile(projectId: string, nodeId: string): string | null;
  notebookFolder(projectId: string, nodeId: string): KernelFolder | null;
  releaseNotebookFolder(projectId: string, folder: KernelFolder): void;
  notebookChanged(projectId: string): void;
}

function readOutput(value: unknown): NotebookOutput | null {
  const output = object(value);
  if (output?.output_type === 'stream') {
    const body = text(output.text);
    return body === null ? null : { output_type: 'stream', name: output.name === 'stderr' ? 'stderr' : 'stdout', text: body };
  }
  if (output?.output_type === 'display_data' || output?.output_type === 'execute_result') {
    const data: Record<string, unknown> = {};
    for (const [mime, item] of Object.entries(object(output.data) ?? {})) { const body = isJson(mime) ? item : text(item); if (body !== null && body !== undefined) data[mime] = body; }
    const metadata = object(output.metadata) ?? {};
    return output.output_type === 'display_data' ? { output_type: 'display_data', data, metadata }
      : { output_type: 'execute_result', data, metadata, execution_count: Number.isSafeInteger(output.execution_count) ? output.execution_count as number : null };
  }
  if (output?.output_type === 'error') return { output_type: 'error', ename: String(output.ename ?? 'Error'), evalue: String(output.evalue ?? ''), traceback: Array.isArray(output.traceback) ? output.traceback.map(String) : [] };
  return null;
}

/** Reads nbformat 4 without running anything. Fields Jupyter writes are kept, so an unchanged file writes back the same. */
export function parseIpynb(content: string): Pick<NotebookContent, 'nbformatMinor' | 'metadata' | 'cells'> {
  if (Buffer.byteLength(content, 'utf8') > NOTEBOOK_LIMITS.fileBytes) throw new StoreError(`Notebooks are limited to ${NOTEBOOK_LIMITS.fileBytes / 1_000_000} MB.`, 413);
  let notebook: Record<string, unknown> | null;
  try { notebook = object(JSON.parse(content)); } catch { throw new StoreError('This file is not a notebook: it is not valid JSON.'); }
  if (notebook?.nbformat !== 4 || !Array.isArray(notebook.cells)) throw new StoreError('ros.ai opens Jupyter notebooks in format 4, which Jupyter has written since 2015.');
  if (notebook.cells.length > NOTEBOOK_LIMITS.cells) throw new StoreError(`Notebooks are limited to ${NOTEBOOK_LIMITS.cells} cells.`);
  const seen = new Set<string>();
  const cells = notebook.cells.map((raw, index): NotebookCell => {
    const cell = object(raw), type = cell?.cell_type, source = text(cell?.source);
    if (!cell || (type !== 'code' && type !== 'markdown' && type !== 'raw') || source === null) throw new StoreError(`Cell ${index + 1} is not a notebook cell ros.ai can read.`);
    if (source.length > NOTEBOOK_LIMITS.cellSourceCharacters) throw new StoreError(`Cell ${index + 1} is longer than ${NOTEBOOK_LIMITS.cellSourceCharacters.toLocaleString('en-US')} characters.`);
    const id = typeof cell.id === 'string' && cellIdSchema.safeParse(cell.id).success && !seen.has(cell.id) ? cell.id : newCellId();
    seen.add(id);
    const base = { id, source, metadata: object(cell.metadata) ?? {} };
    if (type !== 'code') return { ...base, cell_type: type, ...(object(cell.attachments) ? { attachments: object(cell.attachments)! } : {}) };
    const outputs = Array.isArray(cell.outputs) ? cell.outputs.flatMap(output => { const value = readOutput(output); return value ? [value] : []; }) : [];
    return { ...base, cell_type: 'code', outputs, execution_count: Number.isSafeInteger(cell.execution_count) ? cell.execution_count as number : null };
  });
  const minor = notebook.nbformat_minor;
  return { nbformatMinor: typeof minor === 'number' && Number.isSafeInteger(minor) && minor >= 0 ? minor : 5, metadata: object(notebook.metadata) ?? {}, cells };
}

// Python's str.splitlines(keepends=True), which Jupyter uses for multi-line fields.
const lines = (value: string) => value.split(/(?<=\r\n|[\n\v\f\x1c-\x1e\x85\u2028\u2029]|\r(?!\n))/u).filter(Boolean);
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : object(value) ? Object.fromEntries(Object.keys(value as object).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;
const outputHash = (output: NotebookOutput) => sha(JSON.stringify(sorted(output)));
/** The notebook as Jupyter itself writes it (sorted keys, one-space indent, multi-line text as lists of lines),
 * so Jupyter, VS Code and Git see ordinary files. Tables ros.ai keeps for saving results stay out of the file. */
export function ipynb(notebook: Pick<NotebookContent, 'nbformatMinor' | 'metadata' | 'cells'>): string {
  const bundle = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([mime]) => mime !== 'text/csv')
    .map(([mime, value]) => [mime, typeof value === 'string' && (mime.startsWith('text/') || mime === 'application/javascript' || mime === 'image/svg+xml') ? lines(value) : value]));
  const output = (item: NotebookOutput) => item.output_type === 'stream' ? { ...item, text: lines(item.text) }
    : item.output_type === 'error' ? item : { ...item, data: bundle(item.data) };
  const cells = notebook.cells.map(cell => cell.cell_type === 'code'
    ? { cell_type: 'code', execution_count: cell.execution_count ?? null, id: cell.id, metadata: cell.metadata, outputs: (cell.outputs ?? []).map(output), source: lines(cell.source) }
    : { ...(cell.attachments ? { attachments: cell.attachments } : {}), cell_type: cell.cell_type, id: cell.id, metadata: cell.metadata, source: lines(cell.source) });
  return `${JSON.stringify(sorted({ cells, metadata: notebook.metadata, nbformat: 4, nbformat_minor: Math.max(5, notebook.nbformatMinor) }), null, 1)}\n`;
}

/** What a cell output becomes when it is saved as a ros.ai result. */
function resultFor(output: NotebookOutput): Pick<Artifact, 'kind' | 'content' | 'mediaType'> & { label: string; metadata?: Record<string, unknown> } {
  if (output.output_type === 'stream') return { kind: 'result', content: output.text, mediaType: 'text/plain', label: 'Printed text' };
  if (output.output_type === 'error') throw new StoreError('Errors are kept with the notebook; they cannot be saved as results.');
  const data = output.data, png = data['image/png'], csv = data['text/csv'], svg = data['image/svg+xml'], plain = data['text/plain'];
  if (typeof png === 'string' && /^[A-Za-z0-9+/\n\r]+={0,2}\s*$/u.test(png)) return { kind: 'plot', content: png.replace(/\s/gu, ''), mediaType: 'image/png', label: 'Figure', metadata: { contentEncoding: 'base64' } };
  if (typeof csv === 'string') return { kind: 'dataset', content: csv, mediaType: 'text/csv', label: 'Table' };
  if (typeof svg === 'string' && /^\s*<svg\b/u.test(svg) && !/<script|\son[a-z]+\s*=|javascript:/iu.test(svg)) return { kind: 'plot', content: svg, mediaType: 'image/svg+xml', label: 'Figure' };
  if (typeof plain === 'string') {
    const value = numberText(plain);
    if (value !== null) return { kind: 'metric', content: JSON.stringify({ value: Number(value) }), mediaType: 'application/json', label: 'Value' };
    return { kind: 'result', content: plain, mediaType: 'text/plain', label: 'Result' };
  }
  throw new StoreError('This output has no form ros.ai can save as a result yet.');
}

/** Notebook blocks: their cells, and one long-running Python per open notebook, in the OS sandbox or Docker. */
export class NotebookService {
  private readonly live = new Map<string, Live>();
  /** Cells deleted in this session, by notebook, so undoing a delete brings their outputs back. */
  private readonly removed = new Map<string, Map<string, NotebookCell>>();
  private readonly listeners = new Map<string, Set<(event: NotebookEvent) => void>>();
  private readonly stopListening: () => void;
  private readonly docker: string;
  private readonly owner: string;
  private folders?: NotebookFolders;
  private runtime?: { at: number; value: { id: string } | { reason: string } };
  private closed = false;

  /** Without Docker: ros.ai's own Python in the operating system's sandbox. */
  private readonly python?: { runtime: PythonRuntime; confine: Confine };

  constructor(private readonly store: Store, private readonly authority: Authority, options: { owner?: string; docker?: string; python?: { runtime: PythonRuntime; confine: Confine } } = {}) {
    this.owner = options.owner ?? 'ros-ai';
    this.docker = options.docker ?? 'docker';
    this.python = options.python;
    if (!this.python) removeLeftoverKernels(this.owner, this.docker);
    // A removed or retyped Notebook block stops its Python.
    this.stopListening = store.onCommit(projectId => this.prune(projectId));
  }
  useFolders(folders: NotebookFolders): void { this.folders = folders; }

  private node(projectId: string, nodeId: string): CanvasNode {
    if (this.closed) throw new StoreError('ros.ai is shutting down.', 503);
    const node = this.store.getProject(projectId).canvas.nodes.find(item => item.id === nodeId);
    if (!node || node.kind === 'group' || node.blockType !== 'notebook') throw new StoreError('Choose a Notebook block in this project.', 404);
    return node;
  }
  private key(projectId: string, nodeId: string) { return `${projectId}:${nodeId}`; }
  private entry(projectId: string, nodeId: string): Live {
    const key = this.key(projectId, nodeId);
    let live = this.live.get(key);
    if (!live) { live = { key, projectId, nodeId, status: 'off', count: 0, queue: [], usedAt: Date.now() }; this.live.set(key, live); }
    return live;
  }

  /** The block's notebook. A new block starts with one empty code cell; an older block's newest snapshot becomes its notebook. */
  private content(projectId: string, nodeId: string): Stored {
    const saved = this.store.record<Stored>(DOCUMENT, this.key(projectId, nodeId));
    if (saved) return saved;
    let parsed: ReturnType<typeof parseIpynb> | undefined;
    const snapshot = this.store.listArtifacts(projectId).filter(item => item.nodeId === nodeId && item.kind === 'notebook').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (snapshot) try { parsed = parseIpynb(snapshot.content); } catch { /* an unreadable snapshot stays in the block's history */ }
    const fresh: Stored = { nodeId, projectId, revision: 1, updatedAt: now(), ...(parsed ?? { nbformatMinor: 5, metadata: structuredClone(METADATA), cells: [{ id: newCellId(), cell_type: 'code', source: '', metadata: {}, outputs: [], execution_count: null }] }) };
    this.persist(fresh, true);
    return fresh;
  }
  /** Saves the notebook. The folder copy follows; the canvas card summary changes only with outputs or cells. */
  private persist(content: Stored, outputsChanged: boolean, lastRun?: NotebookSummary['lastRun']): void {
    this.store.saveRecord(DOCUMENT, this.key(content.projectId, content.nodeId), content.projectId, content);
    const previous = this.store.record<NotebookSummary>(SUMMARY, this.key(content.projectId, content.nodeId));
    const first = content.cells.find(cell => cell.source.trim()), excerpt = first && (first.cell_type === 'code' ? first.source.trim() : plainMarkdown(first.source));
    const summary: NotebookSummary = { nodeId: content.nodeId, cells: content.cells.length, codeCells: content.cells.filter(cell => cell.cell_type === 'code').length,
      ...(lastRun ?? previous?.lastRun ? { lastRun: lastRun ?? previous!.lastRun } : {}), ...(first && excerpt ? { excerpt: { kind: first.cell_type === 'code' ? 'code' : 'text', text: excerpt.slice(0, 400) } } : {}) };
    if (outputsChanged) {
      for (const cell of content.cells) for (const output of cell.outputs ?? []) {
        if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') continue;
        if (typeof output.data['image/png'] === 'string') summary.figure = sha(output.data['image/png']);
        const plain = output.data['text/plain'];
        if (output.output_type === 'execute_result' && typeof plain === 'string' && plain.length <= 60 && !plain.includes('\n') && Object.keys(output.data).length === 1) summary.value = numberText(plain) ?? plain;
      }
    } else { if (previous?.figure) summary.figure = previous.figure; if (previous?.value) summary.value = previous.value; }
    this.store.saveRecord(SUMMARY, this.key(content.projectId, content.nodeId), content.projectId, summary);
    this.folders?.notebookChanged(content.projectId);
  }
  /** Outputs of the running cell are kept in memory until it finishes. */
  private current(projectId: string, nodeId: string): NotebookContent {
    const { fileHash: _, ...content } = this.content(projectId, nodeId), running = this.live.get(this.key(projectId, nodeId))?.running;
    if (running) content.cells = content.cells.map(cell => cell.id === running.cellId && cell.cell_type === 'code' ? { ...cell, outputs: structuredClone(running.outputs), execution_count: null } : cell);
    return content;
  }

  /** The notebook file for the project folder. `keep` names a file on disk that already matches, because ros.ai read it unchanged. */
  file(projectId: string, nodeId: string): { bytes: Buffer; keep?: string } {
    const content = this.content(projectId, nodeId);
    return { bytes: Buffer.from(ipynb(content), 'utf8'), ...(content.fileHash ? { keep: content.fileHash } : {}) };
  }
  /** A notebook file read from the project folder, after the person saved it in Jupyter, VS Code or another app. */
  fromFile(projectId: string, nodeId: string, path: string, content: string, hash: string): void {
    this.node(projectId, nodeId);
    this.replace(projectId, nodeId, parseIpynb(content), `${path} changed in another app`, hash);
  }
  private replace(projectId: string, nodeId: string, parsed: ReturnType<typeof parseIpynb>, reason: string, fileHash?: string): Stored {
    const current = this.content(projectId, nodeId), pristine = current.revision === 1 && current.cells.every(cell => !cell.source.trim() && !cell.outputs?.length);
    if (!pristine) this.store.saveRecord<Previous>(PREVIOUS, this.key(projectId, nodeId), projectId, { content: current, reason, at: now() });
    const next: Stored = { nodeId, projectId, revision: current.revision + 1, updatedAt: now(), ...parsed, ...(fileHash ? { fileHash } : {}) };
    this.persist(next, true);
    this.emit(this.key(projectId, nodeId), { type: 'notebook', revision: next.revision, reason });
    return next;
  }

  private async runtimeStatus(refresh = false): Promise<{ id: string } | { reason: string }> {
    if (this.python) {
      const state = this.python.runtime.state();
      return state.status === 'failed' ? { reason: state.message } : { id: 'local-python' };
    }
    if (!refresh && this.runtime && Date.now() - this.runtime.at < 30_000) return this.runtime.value;
    const value = await kernelImage(this.docker);
    this.runtime = { at: Date.now(), value };
    return value;
  }
  private kernelState(live?: Live): NotebookKernel {
    return { status: live?.status ?? 'off', session: live?.kernel?.id ?? null, executionCount: live?.count ?? 0, ...(live?.message ? { message: live.message } : {}), ...(live?.info ?? {}) };
  }
  /** Notebook blocks in a project with a cell running or waiting to run. */
  running(projectId: string): Set<string> {
    return new Set([...this.live.values()].filter(live => live.projectId === projectId && (live.running || live.queue.length)).map(live => live.nodeId));
  }
  /** `check` asks Docker again (when notebooks use it), for example after the person started Docker Desktop. */
  async state(projectId: string, nodeId: string, check = false): Promise<NotebookState> {
    this.node(projectId, nodeId);
    const live = this.live.get(this.key(projectId, nodeId)), runtime = await this.runtimeStatus(check), previous = this.store.record<Previous>(PREVIOUS, this.key(projectId, nodeId));
    const file = this.folders?.notebookFile(projectId, nodeId) ?? null, notebook = this.current(projectId, nodeId);
    const results = new Map(this.store.listArtifacts(projectId).filter(item => item.nodeId === nodeId && typeof item.metadata?.outputHash === 'string')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(item => [`${item.metadata!.cellId}/${item.metadata!.outputIndex}/${item.metadata!.outputHash}`, item.id]));
    const saved: Record<string, string> = {};
    if (results.size) for (const cell of notebook.cells) (cell.outputs ?? []).forEach((output, index) => {
      const id = results.get(`${cell.id}/${index}/${outputHash(output)}`);
      if (id) saved[`${cell.id}/${index}`] = id;
    });
    return { notebook, kernel: this.kernelState(live), mode: this.authority.mode(projectId, nodeId), saved,
      queue: [...(live?.running ? [{ cellId: live.running.cellId, state: 'running' as const }] : []), ...(live?.queue ?? []).map(item => ({ cellId: item.cellId, state: 'queued' as const }))],
      file, outputs: file ? `outputs/${file.split('/').at(-1)!.replace(/\.ipynb$/iu, '')}` : null,
      runtime: 'id' in runtime ? { available: true } : { available: false, reason: runtime.reason },
      ...(previous ? { previous: { reason: previous.reason, at: previous.at } } : {}) };
  }

  private static readonly saveSchema = z.object({ base: z.number().int().nonnegative(), client: z.string().max(64).optional(), cells: z.array(z.object({ id: cellIdSchema, cell_type: z.enum(['code', 'markdown', 'raw']),
    source: z.string().max(NOTEBOOK_LIMITS.cellSourceCharacters), metadata: z.record(z.string(), z.unknown()).optional() }).strict()).max(NOTEBOOK_LIMITS.cells) }).strict();
  /** Cell edits from the notebook screen. Outputs stay with their cell ids on the server. */
  save(projectId: string, nodeId: string, supplied: unknown): { revision: number } {
    this.node(projectId, nodeId);
    const body = NotebookService.saveSchema.parse(supplied), current = this.content(projectId, nodeId);
    if (body.base !== current.revision) throw new StoreError('This notebook changed in another window or app. Reload it to see the newest version.', 409);
    if (new Set(body.cells.map(cell => cell.id)).size !== body.cells.length) throw new StoreError('Each cell needs its own id.');
    const old = new Map(current.cells.map(cell => [cell.id, cell])), removed = this.removed.get(this.key(projectId, nodeId)) ?? new Map<string, NotebookCell>();
    const cells = body.cells.map((edit): NotebookCell => {
      const before = old.get(edit.id) ?? removed.get(edit.id), metadata = edit.metadata ?? before?.metadata ?? {};
      if (edit.cell_type === 'code') return { id: edit.id, cell_type: 'code', source: edit.source, metadata, outputs: before?.cell_type === 'code' ? before.outputs ?? [] : [], execution_count: before?.cell_type === 'code' ? before.execution_count ?? null : null };
      return { id: edit.id, cell_type: edit.cell_type, source: edit.source, metadata, ...(before?.attachments && before.cell_type === edit.cell_type ? { attachments: before.attachments } : {}) };
    });
    const shape = (list: NotebookCell[]) => JSON.stringify(list.map(cell => [cell.id, cell.cell_type, cell.source, cell.metadata]));
    if (shape(cells) === shape(current.cells)) return { revision: current.revision };
    const kept = new Set(cells.map(cell => cell.id));
    for (const cell of current.cells) if (!kept.has(cell.id)) { removed.delete(cell.id); removed.set(cell.id, cell); }
    for (const id of kept) removed.delete(id);
    for (const id of [...removed.keys()].slice(0, Math.max(0, removed.size - 20))) removed.delete(id);
    if (removed.size) this.removed.set(this.key(projectId, nodeId), removed); else this.removed.delete(this.key(projectId, nodeId));
    const outputsChanged = cells.length !== current.cells.length || cells.some((cell, index) => cell.outputs?.length !== current.cells[index]?.outputs?.length);
    const { fileHash: _, ...rest } = current, next: Stored = { ...rest, cells, revision: current.revision + 1, updatedAt: now() };
    this.persist(next, outputsChanged);
    this.emit(this.key(projectId, nodeId), { type: 'notebook', revision: next.revision, reason: 'Edited in another window', ...(body.client ? { client: body.client } : {}) });
    return { revision: next.revision };
  }

  private static readonly runSchema = z.object({ base: z.number().int().nonnegative().optional(), client: z.string().max(64).optional(), cells: z.array(z.unknown()).optional(),
    run: z.array(cellIdSchema).min(1).max(NOTEBOOK_LIMITS.cells), approve: z.record(cellIdSchema, z.string().regex(/^[a-f0-9]{64}$/u)).optional() }).strict();
  /** Queues cells in order. Each one passes the block's permission choice first; the first that needs approval stops the queue there. */
  run(projectId: string, nodeId: string, supplied: unknown): NotebookRunResult {
    this.node(projectId, nodeId);
    const body = NotebookService.runSchema.parse(supplied);
    if (body.cells) {
      if (body.base === undefined) throw new StoreError('Send the notebook revision with its cells.');
      this.save(projectId, nodeId, { base: body.base, cells: body.cells, ...(body.client ? { client: body.client } : {}) });
    }
    const content = this.content(projectId, nodeId), live = this.entry(projectId, nodeId), mode = this.authority.mode(projectId, nodeId);
    if (this.authority.policy(projectId).stopped) throw new StoreError('Research is stopped in this project. Resume it before running cells.', 409);
    const queued: string[] = [];
    let approval: NotebookRunResult['approval'];
    for (const cellId of body.run) {
      const cell = content.cells.find(item => item.id === cellId && item.cell_type === 'code');
      if (!cell) throw new StoreError('That cell is not a code cell in this notebook.', 404);
      if (!cell.source.trim() || live.queue.some(item => item.cellId === cellId)) continue;
      const fingerprint = sha(JSON.stringify([projectId, nodeId, cellId, sha(cell.source)]));
      // %matplotlib inline and similar setup lines do nothing in ros.ai, so the reviewer reads them as pass.
      const reviewable = cell.source.replace(/^(\s*)%(?:matplotlib|config|load_ext|reload_ext|autoreload)\b.*$/gmu, '$1pass');
      // Each cell is reviewed with the names the cells before it leave, as an error cancels every cell after it.
      const last = live.queue.at(-1) ?? live.running, before = (last ? last.names : live.settled) ?? {};
      const reviewed = mode === 'review' ? reviewNotebookCell(reviewable, before) : undefined;
      const decision = this.authority.review(projectId, { kind: 'experiment', nodeId, fingerprint, code: cell.source, reviewed });
      if (decision.outcome === 'deny') throw new StoreError(decision.reason, 409);
      const approved = decision.outcome === 'escalate' && body.approve?.[cellId] === fingerprint;
      if (decision.outcome === 'escalate' && !approved) { approval = { cellId, fingerprint, reason: decision.reason }; break; }
      // Names carry over only while every cell in the session was reviewed or is known not to change them.
      const names = mode !== 'review' ? undefined : approved ? forgetNotebookNames(reviewable, before) : reviewed!.names;
      live.queue.push({ execution: randomUUID(), cellId, source: cell.source, reviewable, ...(names ? { names } : {}), queuedAt: now(), approval: { mode, outcome: approved ? 'approved' : 'allow', reason: decision.reason } });
      queued.push(cellId);
      this.emit(live.key, { type: 'cell', cellId, state: 'queued' });
    }
    if (queued.length) {
      live.usedAt = Date.now();
      if (!live.kernel && live.status === 'off') void this.launch(live);
      else this.pump(live);
    }
    return { revision: content.revision, queued, ...(approval ? { approval } : {}) };
  }

  private async launch(live: Live): Promise<void> {
    live.status = 'starting'; live.message = undefined; live.stopMessage = undefined;
    this.emitKernel(live);
    const fail = (message: string) => { live.status = 'off'; live.message = message; this.cancelQueue(live); this.emitKernel(live); };
    let local: { python: string; home: string; confine: Confine } | undefined;
    if (this.python) {
      // The first run sets Python up; the notebook shows that while it waits.
      if (this.python.runtime.state().status !== 'ready') { live.message = 'Setting up Python for the first run (about a minute, once)…'; this.emitKernel(live); }
      try { local = { python: await this.python.runtime.ensure(), home: this.python.runtime.home, confine: this.python.confine }; }
      catch (error) { if (live.status === 'starting' && !live.kernel) fail(error instanceof Error ? error.message : String(error)); return; }
      live.message = undefined;
    }
    const image = local ? { id: 'local-python' } : await this.runtimeStatus(true);
    if (this.closed || live.status !== 'starting' || live.kernel) return;
    if ('reason' in image) return fail(image.reason);
    const others = [...this.live.values()].filter(item => item !== live && item.kernel);
    if (others.length >= NOTEBOOK_LIMITS.runningKernels) {
      const spare = others.filter(item => !item.running && !item.queue.length).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!spare) return fail(`${NOTEBOOK_LIMITS.runningKernels} notebooks are already running cells. Wait for one to finish, then run this cell again.`);
      await this.stopKernel(spare, `Python stopped to make room for another notebook (ros.ai keeps up to ${NOTEBOOK_LIMITS.runningKernels} running). Its variables were cleared.`);
      if (this.closed || live.status !== 'starting') return;
    }
    let folder: KernelFolder | undefined;
    try {
      folder = this.folders?.notebookFolder(live.projectId, live.nodeId) ?? undefined;
      // A server running as root runs Python as nobody, which must be able to write the outputs folder.
      if (folder && process.getuid?.() === 0) chmodSync(folder.outputsPath, 0o777);
    } catch (error) { return fail(`The project folder could not be prepared: ${error instanceof Error ? error.message : String(error)}`); }
    const kernel: NotebookKernelProcess = new NotebookKernelProcess({ image: image.id, owner: this.owner, docker: this.docker, folder, ...(local ? { local } : {}),
      onMessage: message => this.message(live, kernel, message), onExit: exit => this.exit(live, kernel, exit) });
    live.kernel = kernel; live.folder = folder; live.count = 0; live.info = undefined;
    kernel.start();
    live.startup = setTimeout(() => { if (live.kernel === kernel && live.status === 'starting') void kernel.stop(local ? 'Python did not start within 90 seconds.' : 'Python did not start within 90 seconds. Check that Docker Desktop is running and has enough memory.'); }, START_MS);
  }

  private message(live: Live, kernel: NotebookKernelProcess, message: KernelMessage): void {
    if (live.kernel !== kernel) return;
    if (message.type === 'ready') {
      clearTimeout(live.startup);
      live.info = { python: message.python, libraries: message.libraries, cwd: message.cwd };
      live.status = 'idle';
      this.emitKernel(live);
      this.pump(live);
      return;
    }
    const running = live.running;
    if (!running || message.id !== running.execution) return;
    if (message.type === 'stream') {
      const last = running.outputs.at(-1);
      if (last?.output_type === 'stream' && last.name === message.name) last.text += message.text;
      else running.outputs.push({ output_type: 'stream', name: message.name, text: message.text });
      this.emit(live.key, { type: 'stream', cellId: running.cellId, name: message.name, text: message.text });
    } else if (message.type === 'display') {
      // Rich output is kept as data. Only images, tables and text are ever shown, never as HTML.
      const data = Object.fromEntries(Object.entries(message.data).filter(([mime, value]) => isJson(mime) || typeof value === 'string'));
      const output: NotebookOutput = message.result ? { output_type: 'execute_result', data, metadata: message.metadata, execution_count: running.count } : { output_type: 'display_data', data, metadata: message.metadata };
      running.outputs.push(output);
      this.emit(live.key, { type: 'output', cellId: running.cellId, output });
    } else if (message.type === 'clear') {
      running.outputs = [];
      this.emit(live.key, { type: 'clear', cellId: running.cellId });
    } else this.finish(live, message.status, message.error);
  }

  private pump(live: Live): void {
    if (!live.kernel || live.status === 'starting' || live.running || this.closed) return;
    const next = live.queue.shift();
    if (!next) { if (live.status !== 'idle') { live.status = 'idle'; this.emitKernel(live); } this.touch(live); return; }
    live.count += 1;
    live.running = { ...next, count: live.count, session: live.kernel.id, startedAt: now(), outputs: [] };
    if (live.status !== 'busy') { live.status = 'busy'; this.emitKernel(live); }
    this.emit(live.key, { type: 'cell', cellId: next.cellId, state: 'running', executionCount: live.count });
    if (!live.kernel.execute({ id: next.execution, code: next.source, count: live.count })) this.finish(live, 'error', { ename: 'Stopped', evalue: 'Python stopped before this cell could run.', traceback: [] });
  }

  /** A finished cell: its outputs are saved into the notebook and its run is recorded. */
  private finish(live: Live, status: Execution['status'], error?: { ename: string; evalue: string; traceback: string[] }): void {
    const run = live.running;
    if (!run) return;
    live.running = undefined;
    // A cell that stopped part-way may have bound some of its names, so the reviewer stops trusting them.
    try { live.settled = status === 'ok' || !run.names ? run.names : forgetNotebookNames(run.reviewable, live.settled ?? {}); } catch { live.settled = undefined; }
    if (error) {
      const output: NotebookOutput = { output_type: 'error', ename: error.ename, evalue: error.evalue, traceback: error.traceback };
      run.outputs.push(output);
      this.emit(live.key, { type: 'output', cellId: run.cellId, output });
    }
    const endedAt = now();
    try {
      const content = this.content(live.projectId, live.nodeId), cell = content.cells.find(item => item.id === run.cellId && item.cell_type === 'code');
      if (cell) { cell.outputs = run.outputs; cell.execution_count = run.count; }
      const { fileHash: _, ...rest } = content;
      this.persist(rest, true, { at: endedAt, status, executionCount: run.count });
      const record: Execution = { id: run.execution, projectId: live.projectId, nodeId: live.nodeId, cellId: run.cellId, session: run.session, executionCount: run.count,
        source: run.source, sourceHash: sha(run.source), status, approval: run.approval, queuedAt: run.queuedAt, startedAt: run.startedAt, endedAt,
        outputs: run.outputs.map(output => ({ type: output.output_type, ...('data' in output ? { mimes: Object.keys(output.data) } : {}), hash: outputHash(output) })) };
      this.store.saveRecord(EXECUTION, record.id, live.projectId, record);
    } catch { /* the project or block is gone; nothing is left to save into */ }
    this.emit(live.key, { type: 'cell', cellId: run.cellId, state: 'done', executionCount: run.count, status });
    // As in Jupyter, an error or Stop cancels the cells queued after it.
    if (status !== 'ok') this.cancelQueue(live);
    this.pump(live);
  }
  private cancelQueue(live: Live): void {
    for (const item of live.queue.splice(0)) this.emit(live.key, { type: 'cell', cellId: item.cellId, state: 'cancelled' });
  }

  private exit(live: Live, kernel: NotebookKernelProcess, exit: KernelExit): void {
    if (live.kernel !== kernel) return;
    clearTimeout(live.startup); clearTimeout(live.idle);
    const starting = live.status === 'starting';
    const reason = exit.stopped ? live.stopMessage : starting ? `Python could not start${this.python ? '' : ' in Docker'}${exit.detail ? `: ${exit.detail}` : '.'}`
      : exit.detail.startsWith('Python stopped because') ? exit.detail
      : exit.code === 137 || exit.signal === 'SIGKILL' ? `Python stopped because it ran out of memory (a notebook can use 2 GB)${this.python ? '' : ', or Docker stopped it'}. Its variables were cleared; run the cells again.`
      : `Python stopped unexpectedly${exit.code === null ? '' : ` (exit code ${exit.code})`}. Its variables were cleared; run the cells again.${exit.detail && !exit.detail.startsWith('Python') ? ` ${exit.detail.slice(-300)}` : ''}`;
    live.kernel = undefined; live.status = 'off'; live.message = reason; live.count = 0; live.info = undefined;
    this.cancelQueue(live);
    if (live.running) this.finish(live, 'error', { ename: 'Stopped', evalue: reason ?? 'Python was restarted before this cell finished.', traceback: [] });
    live.settled = undefined;
    if (live.folder) { try { this.folders?.releaseNotebookFolder(live.projectId, live.folder); } catch { /* an outputs folder in use stays */ } live.folder = undefined; }
    this.emitKernel(live);
  }
  private stopKernel(live: Live, message?: string): Promise<void> {
    clearTimeout(live.idle);
    live.stopMessage = message;
    return live.kernel?.stop() ?? Promise.resolve();
  }
  private touch(live: Live): void {
    clearTimeout(live.idle);
    live.usedAt = Date.now();
    live.idle = setTimeout(() => { if (!live.running && !live.queue.length) void this.stopKernel(live, `Python stopped after ${NOTEBOOK_LIMITS.idleStopMinutes} minutes without use, so its variables were cleared. Run the cells again to continue.`); }, IDLE_MS);
    live.idle.unref();
  }

  interrupt(projectId: string, nodeId: string): NotebookKernel {
    this.node(projectId, nodeId);
    const live = this.live.get(this.key(projectId, nodeId));
    if (live) { this.cancelQueue(live); if (live.running) live.kernel?.interrupt(); }
    return this.kernelState(live);
  }
  async restart(projectId: string, nodeId: string): Promise<NotebookKernel> {
    this.node(projectId, nodeId);
    const live = this.entry(projectId, nodeId);
    this.cancelQueue(live);
    await this.stopKernel(live);
    if (!this.closed && !live.kernel && live.status === 'off') { live.usedAt = Date.now(); await this.launch(live); }
    return this.kernelState(live);
  }
  /** Clears outputs and run numbers, for some cells or all of them. */
  clear(projectId: string, nodeId: string, supplied: unknown): { revision: number } {
    this.node(projectId, nodeId);
    const { cellIds } = z.object({ cellIds: z.array(cellIdSchema).max(NOTEBOOK_LIMITS.cells).optional() }).strict().parse(supplied ?? {});
    const content = this.content(projectId, nodeId), running = this.live.get(this.key(projectId, nodeId))?.running?.cellId;
    for (const cell of content.cells) if (cell.cell_type === 'code' && (!cellIds || cellIds.includes(cell.id)) && cell.id !== running) { cell.outputs = []; cell.execution_count = null; }
    const { fileHash: _, ...rest } = content;
    this.persist(rest, true);
    for (const cell of content.cells) if (cell.cell_type === 'code' && (!cellIds || cellIds.includes(cell.id)) && cell.id !== running) this.emit(this.key(projectId, nodeId), { type: 'clear', cellId: cell.id });
    return { revision: content.revision };
  }
  /** A .ipynb the person chose. The notebook it replaces can be brought back. */
  import(projectId: string, nodeId: string, supplied: unknown): { revision: number } {
    this.node(projectId, nodeId);
    const body = z.object({ name: z.string().min(1).max(300), content: z.string().min(1) }).strict().parse(supplied);
    if (!/\.ipynb$/iu.test(body.name)) throw new StoreError('Choose a Jupyter notebook (.ipynb) file.');
    return { revision: this.replace(projectId, nodeId, parseIpynb(body.content), `Imported ${body.name.split(/[\\/]/u).at(-1)}`).revision };
  }
  restore(projectId: string, nodeId: string): { revision: number } {
    this.node(projectId, nodeId);
    const previous = this.store.record<Previous>(PREVIOUS, this.key(projectId, nodeId));
    if (!previous) throw new StoreError('There is no earlier version to bring back.', 404);
    const current = this.content(projectId, nodeId), { fileHash: _, ...restored } = previous.content;
    const next: Stored = { ...restored, revision: current.revision + 1, updatedAt: now() };
    this.store.removeRecord(PREVIOUS, this.key(projectId, nodeId), projectId);
    this.persist(next, true);
    this.emit(this.key(projectId, nodeId), { type: 'notebook', revision: next.revision, reason: 'Brought back the earlier version' });
    return { revision: next.revision };
  }

  /** Saves one cell output as a ros.ai result, so it can be used as input or in a report. */
  saveOutput(projectId: string, nodeId: string, supplied: unknown): Artifact {
    const node = this.node(projectId, nodeId);
    const body = z.object({ cellId: cellIdSchema, index: z.number().int().nonnegative(), title: z.string().trim().min(1).max(200).optional() }).strict().parse(supplied);
    const content = this.current(projectId, nodeId), cell = content.cells.find(item => item.id === body.cellId && item.cell_type === 'code'), output = cell?.outputs?.[body.index];
    if (!cell || !output) throw new StoreError('That output is no longer in the notebook.', 404);
    if (this.live.get(this.key(projectId, nodeId))?.running?.cellId === cell.id) throw new StoreError('Wait for the cell to finish before saving its output.', 409);
    const saved = resultFor(output), sourceHash = sha(cell.source), path = this.folders?.notebookFile(projectId, nodeId) ?? null;
    const execution = this.store.records<Execution>(EXECUTION, projectId).filter(item => item.nodeId === nodeId && item.cellId === cell.id && item.executionCount === cell.execution_count).at(-1);
    // An output that came with a notebook file, or was changed in another app, is not one ros.ai saw this cell make.
    const ran = Boolean(execution && execution.outputs[body.index]?.hash === outputHash(output));
    const provenance = { notebookPath: path, cellId: cell.id, executionCount: cell.execution_count ?? null, sourceHash, session: ran ? execution!.session : null, executionId: ran ? execution!.id : null,
      outputIndex: body.index, outputHash: outputHash(output), sourceMatchesRun: ran ? execution!.sourceHash === sourceHash : null };
    return this.store.atomic(() => {
      const at = now(), project = this.store.getProject(projectId);
      const run: Run = { id: randomUUID(), projectId, nodeId, request: `Save ${saved.label.toLowerCase()} from ${node.title}, cell [${cell.execution_count ?? ' '}]`, useSearch: false, status: 'running', createdAt: at, startedAt: at,
        projectRevision: project.revision, node: structuredClone(node), inputs: [], messages: [], provider: 'local', model: 'notebook-python', modelVersion: null,
        configuration: { kind: 'notebook-cell', ...provenance }, tools: [{ name: 'notebook_python', sourceHash, session: provenance.session }],
        events: [{ at, type: 'notebook-output', message: ran ? 'Saved a notebook cell output as a result. The cell ran in ros.ai\'s Docker sandbox; no model was called.'
          : 'Saved a notebook cell output as a result. The output came with the notebook file or was changed in another app; ros.ai did not run it.' }], artifactIds: [],
        cost: { estimatedUsd: 0, basis: 'Local execution only; no provider request or cloud charge.' } };
      this.store.createRun(run);
      const artifact = this.store.addArtifact({ projectId, nodeId, runId: run.id, kind: saved.kind, title: body.title ?? `${node.title} · ${typeof cell.execution_count === 'number' ? `cell ${cell.execution_count} · ` : ''}${saved.label}`, content: saved.content, mediaType: saved.mediaType,
        capture: ran ? 'full-content' : 'external', metadata: { ...saved.metadata, origin: ran ? 'notebook-cell-output' : 'external-notebook-output', executionRole: 'output', ...provenance } });
      this.store.updateRun(run.id, { status: 'completed', endedAt: at, artifactIds: [artifact.id] });
      return artifact;
    });
  }
  /** The figure the canvas card shows, by the hash in the notebook summary. */
  figure(projectId: string, nodeId: string, hash: string): Buffer {
    this.node(projectId, nodeId);
    for (const cell of this.content(projectId, nodeId).cells) for (const output of cell.outputs ?? [])
      if ((output.output_type === 'display_data' || output.output_type === 'execute_result') && typeof output.data['image/png'] === 'string' && sha(output.data['image/png']) === hash)
        return Buffer.from(output.data['image/png'].replace(/\s/gu, ''), 'base64');
    throw new StoreError('That figure is no longer in the notebook.', 404);
  }

  subscribe(projectId: string, nodeId: string, listener: (event: NotebookEvent) => void): () => void {
    this.node(projectId, nodeId);
    const key = this.key(projectId, nodeId), set = this.listeners.get(key) ?? new Set();
    set.add(listener); this.listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(key); };
  }
  private emit(key: string, event: NotebookEvent): void {
    for (const listener of this.listeners.get(key) ?? []) try { listener(event); } catch { /* a closed connection is removed on close */ }
  }
  private emitKernel(live: Live): void { this.emit(live.key, { type: 'kernel', kernel: this.kernelState(live) }); }

  private prune(projectId: string): void {
    let nodes: CanvasNode[] = [];
    try { nodes = this.store.getProject(projectId).canvas.nodes; } catch { /* a project in Trash keeps no running notebooks */ }
    for (const live of this.live.values()) {
      if (live.projectId !== projectId || nodes.some(node => node.id === live.nodeId && node.blockType === 'notebook' && node.kind !== 'group')) continue;
      this.cancelQueue(live);
      void this.stopKernel(live);
      this.live.delete(live.key);
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.stopListening();
    for (const set of this.listeners.values()) for (const listener of set) try { listener({ type: 'kernel', kernel: { status: 'off', session: null, executionCount: 0, message: 'ros.ai stopped.' } }); } catch { /* closing */ }
    await Promise.all([...this.live.values()].map(live => { clearTimeout(live.idle); clearTimeout(live.startup); return live.kernel?.stop(); }));
  }
}

export function attachNotebookRoutes(app: Express, store: Store, authority: Authority, options: { owner?: string; python?: { runtime: PythonRuntime; confine: Confine } } = {}): NotebookService {
  const service = new NotebookService(store, authority, options);
  app.locals.notebooks = service;
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u), owned = (req: Request) => [id.parse(req.params.id), id.parse(req.params.nodeId)] as const;
  app.get(NOTEBOOK_ROUTE, async (req, res) => res.json(await service.state(...owned(req), req.query.check === '1')));
  app.put(NOTEBOOK_ROUTE, (req, res) => res.json(service.save(...owned(req), req.body)));
  app.post(`${NOTEBOOK_ROUTE}/run`, (req, res) => res.json(service.run(...owned(req), req.body)));
  app.post(`${NOTEBOOK_ROUTE}/interrupt`, (req, res) => res.json(service.interrupt(...owned(req))));
  app.post(`${NOTEBOOK_ROUTE}/restart`, async (req, res) => res.json(await service.restart(...owned(req))));
  app.post(`${NOTEBOOK_ROUTE}/clear`, (req, res) => res.json(service.clear(...owned(req), req.body)));
  app.post(`${NOTEBOOK_ROUTE}/import`, (req, res) => res.status(201).json(service.import(...owned(req), req.body)));
  app.post(`${NOTEBOOK_ROUTE}/restore`, (req, res) => res.json(service.restore(...owned(req))));
  app.post(`${NOTEBOOK_ROUTE}/outputs`, (req, res) => res.status(201).json(service.saveOutput(...owned(req), req.body)));
  app.get(`${NOTEBOOK_ROUTE}/figure`, (req, res) => {
    const image = service.figure(...owned(req), z.string().regex(/^[a-f0-9]{64}$/u).parse(req.query.h));
    // Addressed by its hash, so the browser may keep it.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type('png').send(image);
  });
  app.get(`${NOTEBOOK_ROUTE}/events`, (req: Request, res: Response) => {
    const unsubscribe = service.subscribe(...owned(req), event => { res.write(`data: ${JSON.stringify(event)}\n\n`); });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
  });
  return service;
}
