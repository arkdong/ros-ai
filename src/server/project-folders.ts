import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import express, { type Express } from 'express';
import { z } from 'zod';
import { isOutputArtifact, nodeBlockType } from '../shared/blocks.js';
import { CARD_DEFAULT_HEIGHT, cardWidth, setCardHeight } from '../shared/card-size.js';
import { artifactTable, parseCsv, tableCsv } from '../shared/data-view.js';
import { FILE_BYTES, fileMediaType, isPdfType } from '../shared/files.js';
import { GROUP_FOOTER, GROUP_INSET } from '../shared/layout.js';
import { APP_SOURCE_LIMIT, MAX_APP_INPUTS } from '../shared/apps.js';
import { FOLDER_DIRECTORIES, type FolderChoice, type OpenApp, type FolderFileKind, type FolderProblem, type FolderSuggestion, type ProjectFolderStatus, type UnplacedFile } from '../shared/project-folders.js';
import type { Artifact, CanvasNode, Mutation, NotionView, Project, Run } from '../shared/types.js';
import { ArtifactEditingService } from './artifact-editing.js';
import type { KernelFolder } from './notebook-kernel.js';
import type { NotebookFolders, NotebookService } from './notebooks.js';
import { paperSchema, Store, StoreError, trainingViewSchema } from './store.js';

const RECORD = 'project-folder';
const MANIFEST = '.ros-ai/project.json';
const TRASH = '.ros-ai/trash';
// Largest file read back per kind. Text limits in characters are checked after decoding.
const READ_BYTES: Record<FolderFileKind, number> = { note: 100_000, code: 500_000, report: 1_000_000, dataset: 5_000_000, notebook: 20_000_000, figure: 10_000_000, file: FILE_BYTES, app: 500_000 };
/** The most of a PDF's text kept as a File block's saved version. */
const FILE_TEXT = 2_000_000;
const TWO_WAY = new Set<FolderFileKind>(['note', 'code', 'report', 'dataset', 'notebook', 'app']);
const CODE_TYPES: [language: string, extension: string][] = [['python', '.py'], ['r', '.R'], ['julia', '.jl'], ['c', '.c'], ['haskell', '.hs'], ['sql', '.sql'], ['bash', '.sh']];
const NOTE_EXTENSIONS = ['.md', '.markdown', '.txt'];
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__', 'venv', 'site-packages']);
const SYSTEM_FOLDERS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/run', '/sbin', '/srv', '/sys', '/usr', '/var', '/System', '/Library', '/Applications', '/private', '/cores'];
// Apps offered in "Open in". Only these fixed, known apps are launched, never a command from the browser.
const OPEN_APPS: { id: string; label: string; kind: OpenApp['kind']; mac: string[]; command?: string }[] = [
  { id: 'vscode', label: 'VS Code', kind: 'editor', mac: ['Visual Studio Code.app'], command: 'code' },
  { id: 'cursor', label: 'Cursor', kind: 'editor', mac: ['Cursor.app'], command: 'cursor' },
  { id: 'zed', label: 'Zed', kind: 'editor', mac: ['Zed.app'], command: 'zed' },
  { id: 'pycharm', label: 'PyCharm', kind: 'editor', mac: ['PyCharm.app', 'PyCharm CE.app', 'PyCharm Community Edition.app', 'PyCharm Professional Edition.app'], command: 'pycharm' },
  { id: 'sublime', label: 'Sublime Text', kind: 'editor', mac: ['Sublime Text.app'], command: 'subl' },
  { id: 'jupyterlab', label: 'JupyterLab', kind: 'editor', mac: ['JupyterLab.app'], command: 'jlab' },
  { id: 'terminal', label: 'Terminal', kind: 'terminal', mac: ['Utilities/Terminal.app'] },
  { id: 'iterm', label: 'iTerm', kind: 'terminal', mac: ['iTerm.app'] },
];
function installedApps(): (OpenApp & { path: string })[] {
  const roots = ['/Applications', join(homedir(), 'Applications'), '/System/Applications'];
  const onPath = (name: string) => (process.env.PATH ?? '').split(delimiter).map(folder => join(folder, name)).find(path => existsSync(path));
  return OPEN_APPS.flatMap(({ id, label, kind, mac, command }) => {
    const path = process.platform === 'darwin' ? roots.flatMap(root => mac.map(name => join(root, name))).find(path => existsSync(path))
      : process.platform === 'linux' && command ? onPath(command) : undefined;
    return path ? [{ id, label, kind, path }] : [];
  });
}
const HOME_FOLDERS = ['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public', 'Applications'];

type Observed = { hash: string; mtimeMs: number; size: number };
type FileEntry = { path: string; kind: FolderFileKind; hash: string; disk?: Observed; artifactId?: string; missing?: boolean; removed?: boolean; trashPath?: string; problem?: string };
type OutputEntry = { path: string; hash: string; artifactId: string };
/** ros.ai's side of the sync. `hash` is the content ros.ai and the file last agreed on. */
type FolderRecord = { projectId: string; path: string; device: number; inode: number; attachedAt: string; files: Record<string, FileEntry>; outputs: Record<string, OutputEntry[]>; board?: string };
type Listed = { path: string; size: number };
/** `keep` is a file already on disk that matches, though ros.ai would write it differently. */
type Rendered = { bytes: Buffer; extension: string; artifactId?: string; keep?: string };

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const now = () => new Date().toISOString();
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const extensionOf = (path: string) => { const name = posix.basename(path), dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot) : ''; };
const stemOf = (path: string) => { const name = posix.basename(path), extension = extensionOf(name); return extension ? name.slice(0, -extension.length) : name; };
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export const codeExtension = (language: string) => { const name = language.trim().toLowerCase(); return CODE_TYPES.find(([value]) => value === name)?.[1] ?? (['sh', 'shell'].includes(name) ? '.sh' : '.txt'); };
const codeLanguage = (extension: string) => CODE_TYPES.find(([, value]) => value.toLowerCase() === extension.toLowerCase())?.[0];

/** A file name other apps accept, made from a block title. Obsidian links also break on # ^ [ ] |. */
export function safeFileBase(title: string): string {
  let name = title.normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/[*?"<>#^[\]]/gu, '').replace(/\s*[\\/:|]+\s*/gu, ' - ').replace(/\s+/gu, ' ').trim()
    .replace(/^[.\s-]+/u, '').replace(/[.\s-]+$/u, '');
  if (Array.from(name).length > 80) name = Array.from(name).slice(0, 80).join('').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/iu.test(name)) name = `${name}-`;
  return name || 'Untitled';
}
/** Starts an app opener and lets it run on its own. */
const launch = (command: string, args: string[]) => new Promise<void>((done, fail) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', error => fail(new StoreError(errorCode(error) === 'ENOENT' ? 'This computer has no app opener ros.ai can use. Open the folder yourself.' : 'The file could not be opened.', 501)));
  child.once('spawn', () => { child.unref(); done(); });
});
const titleFromPath = (path: string) => stemOf(path).trim().slice(0, 200) || 'Untitled';
function unplacedKind(path: string): UnplacedFile['kind'] | null {
  const extension = extensionOf(path).toLowerCase(), media = fileMediaType(path);
  if (NOTE_EXTENSIONS.includes(extension)) return 'note';
  if (extension === '.csv') return 'dataset';
  if (extension === '.ipynb') return 'notebook';
  if (extension === '.html' || extension === '.htm') return 'app';
  if (media) return isPdfType(media) ? 'pdf' : 'image';
  return codeLanguage(extension) ? 'code' : null;
}
function fileKind(node: CanvasNode, artifacts: ReadonlyMap<string, Artifact>): FolderFileKind | null {
  if (node.kind === 'group') return null;
  const type = nodeBlockType(node), artifact = node.artifactId ? artifacts.get(node.artifactId) : undefined;
  if (type === 'code' || type === 'notebook' || type === 'report') return type;
  if (type === 'dataset') return artifact && ['dataset', 'table'].includes(artifact.kind) ? 'dataset' : null;
  if (type === 'figure') return artifact?.kind === 'plot' ? 'figure' : null;
  if (type === 'file') return node.file ? 'file' : null;
  if (type === 'app') return 'app';
  return 'note';
}
function decodeText(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new StoreError('is not UTF-8 text, so ros.ai kept its own copy.'); }
  if (text.includes('\0')) throw new StoreError('contains binary data, so ros.ai kept its own copy.');
  return text;
}
function outputFile(artifact: Artifact): { bytes: Buffer; extension: string } {
  if (artifact.mediaType === 'image/png') return { bytes: Buffer.from(artifact.content, artifact.metadata?.contentEncoding === 'base64' ? 'base64' : 'utf8'), extension: '.png' };
  // Tables go out as CSV, which spreadsheets and pandas open directly.
  if (artifact.kind === 'table' && artifact.mediaType === 'application/json') try { return { bytes: Buffer.from(tableCsv(artifactTable(artifact.content, false)), 'utf8'), extension: '.csv' }; } catch { /* kept as its exact JSON */ }
  const extension = artifact.mediaType === 'image/svg+xml' ? '.svg' : artifact.mediaType === 'text/csv' ? '.csv' : artifact.mediaType === 'application/json' ? '.json'
    : artifact.mediaType === 'text/markdown' || artifact.kind === 'result' ? '.md' : '.txt';
  return { bytes: Buffer.from(artifact.content, 'utf8'), extension };
}
const markdownLink = /(!?\[[^\]]*\])\(([^)\s]+)\)/gu;
/** Saved report links name exact artifact versions. In the folder they point at the exported files, so images show in Obsidian and VS Code. */
function reportForFolder(text: string, folder: string, files: ReadonlyMap<string, string>): string {
  return text.replace(markdownLink, (match, label: string, target: string) => {
    const path = target.startsWith('artifact:') ? files.get(target.slice(9)) : undefined;
    return path ? `${label}(${posix.relative(folder, path).split('/').map(encodeURIComponent).join('/')})` : match;
  });
}
function reportFromFolder(text: string, folder: string, artifacts: ReadonlyMap<string, string>, evidence: Set<string>): string {
  return text.replace(markdownLink, (match, label: string, target: string) => {
    if (target.startsWith('artifact:')) { evidence.add(target.slice(9)); return match; }
    let decoded: string;
    try { decoded = decodeURIComponent(target); } catch { return match; }
    const id = artifacts.get(posix.normalize(posix.join(folder, decoded)).toLowerCase());
    if (!id) return match;
    evidence.add(id);
    return `${label}(artifact:${id})`;
  });
}

/** File access confined to one project folder. Links are never followed and other apps never see a half-written file. */
class FolderFiles {
  constructor(readonly root: string) {}
  private parts(rel: string): string[] {
    const parts = rel.split('/');
    if (!rel || rel.length > 1000 || isAbsolute(rel) || /[\\\0]/u.test(rel) || parts.some(part => !part || part === '.' || part === '..')) throw new StoreError('Choose a file inside the project folder.');
    return parts;
  }
  resolve(rel: string, create = false): string {
    const parts = this.parts(rel);
    let current = this.root;
    parts.forEach((part, index) => {
      current = join(current, part);
      let info: Stats | undefined;
      try { info = lstatSync(current); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      if (!info) { if (create && index < parts.length - 1) mkdirSync(current); return; }
      if (info.isSymbolicLink()) throw new StoreError(`${rel} goes through a link, so ros.ai left it alone.`);
      if (index < parts.length - 1 && !info.isDirectory()) throw new StoreError(`${rel} is not inside a normal folder.`);
    });
    return current;
  }
  stat(rel: string): Stats | null {
    try { return lstatSync(this.resolve(rel)); } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
  }
  exists(rel: string): boolean { return this.stat(rel) !== null; }
  read(rel: string, limit: number): { bytes: Buffer; observed: Observed } {
    const descriptor = openSync(this.resolve(rel), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile()) throw new StoreError(`${rel} is not a normal file.`);
      if (info.size > limit) throw new StoreError(`is larger than ${limit.toLocaleString('en-US')} bytes, so ros.ai kept its own copy.`);
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) { const read = readSync(descriptor, bytes, length, bytes.length - length, null); if (!read) break; length += read; }
      if (length > limit) throw new StoreError(`is larger than ${limit.toLocaleString('en-US')} bytes, so ros.ai kept its own copy.`);
      const content = bytes.subarray(0, length);
      return { bytes: content, observed: { hash: sha(content), mtimeMs: info.mtimeMs, size: length } };
    } finally { closeSync(descriptor); }
  }
  write(rel: string, bytes: Buffer): Observed {
    const target = this.resolve(rel, true), temporary = join(dirname(target), `.ros-ai-${randomUUID()}.tmp`);
    writeFileSync(temporary, bytes, { flag: 'wx' });
    try { renameSync(temporary, target); } catch (error) { try { unlinkSync(temporary); } catch { /* already gone */ } throw error; }
    const info = lstatSync(target);
    return { hash: sha(bytes), mtimeMs: info.mtimeMs, size: info.size };
  }
  move(from: string, to: string): void { renameSync(this.resolve(from), this.resolve(to, true)); }
  remove(rel: string): void { unlinkSync(this.resolve(rel)); }
  /** Removes rel's folder and empty parents, stopping at `stop`. */
  prune(rel: string, stop: string): void {
    for (let folder = posix.dirname(rel); folder !== stop && folder !== '.' && folder.startsWith(`${stop}/`); folder = posix.dirname(folder))
      try { rmdirSync(this.resolve(folder)); } catch { return; }
  }
  /** Files other apps made or changed, skipping hidden and package folders. Notebook cells can write tables into outputs/. */
  list(limit = 5000, depth = 4): Listed[] {
    const found: Listed[] = [];
    let visited = 0;
    const walk = (folder: string, rel: string, level: number) => {
      let entries;
      try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (visited++ >= limit) return;
        if (entry.name.startsWith('.')) continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (level < depth && !SKIPPED_FOLDERS.has(entry.name)) walk(join(folder, entry.name), child, level + 1); }
        else if (entry.isFile()) { try { found.push({ path: child, size: lstatSync(join(folder, entry.name)).size }); } catch { /* removed while listing */ } }
      }
    };
    walk(this.root, '', 0);
    return found;
  }
}

const manifestSchema = z.object({
  app: z.literal('ros.ai'), format: z.literal(1), projectId: z.string().min(1).max(200), title: z.string().max(200),
  blocks: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u), title: z.string().trim().min(1).max(200), kind: z.enum(['topic', 'activity', 'unspecified', 'group']), blockType: z.enum(['note', 'action', 'dataset', 'figure', 'code', 'notebook', 'report', 'agent', 'search', 'finding', 'notion', 'file', 'google', 'app', 'training', 'web']).optional(), label: z.string().max(40).optional(), notion: z.object({ url: z.string().max(500), filter: z.string().max(1000).optional(), columns: z.array(z.string().max(100)).max(30).optional(), kind: z.enum(['database', 'page']).optional() }).strict().optional(), google: z.object({ fileId: z.string().max(200), kind: z.enum(['sheet', 'doc']), sheet: z.string().max(200).optional() }).strict().optional(), training: trainingViewSchema.optional().catch(undefined),
    // Where a paper's PDF came from; an entry ros.ai cannot read is left out rather than failing the manifest.
    paper: paperSchema.optional().catch(undefined),
    parentId: z.string().nullable(), x: z.number().finite(), y: z.number().finite(), width: z.number().int().optional(), height: z.number().int().optional(), file: z.string().max(1000).optional(),
    // The blocks an App reads; an entry ros.ai cannot read is left out rather than failing the manifest.
    inputs: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u)).max(MAX_APP_INPUTS).optional().catch(undefined) })).max(500),
  connections: z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), label: z.string().max(200), sourceHandle: z.enum(['top', 'right', 'bottom', 'left']).optional(), targetHandle: z.enum(['top', 'right', 'bottom', 'left']).optional() })).max(2000),
});
type Manifest = z.infer<typeof manifestSchema>;
/** A Notion block as the folder keeps it: without the account it reads with, which names a sign-in on this computer only. */
const shareable = ({ account: _account, ...view }: NotionView) => view;

/**
 * Keeps each project's blocks as ordinary files in a folder the person chose. ros.ai writes a file after every saved
 * change; a file changed in another app comes back as an undoable canvas change. Run history stays in ros.ai's database.
 */
/** The project's folder on disk, or null when it has none or it moved. */
export function projectFolderRoot(store: Store, projectId: string): string | null {
  const record = store.record<FolderRecord>(RECORD, projectId);
  if (!record) return null;
  try {
    const real = realpathSync(record.path), info = statSync(real);
    return real === record.path && info.isDirectory() && info.dev === record.device && info.ino === record.inode ? real : null;
  } catch { return null; }
}

export class ProjectFolders implements NotebookFolders {
  private readonly active = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly exportDue = new Set<string>();
  private readonly checked = new Map<string, { available: boolean; reason?: string; unplaced: UnplacedFile[]; problems: FolderProblem[]; checkedAt: string }>();
  /** File blocks whose PDF text is still to be read, per project; reading runs after the folder pass that found them. */
  private readonly pendingText = new Map<string, Set<string>>();
  private readingText = new Set<string>();
  private readonly editing: ArtifactEditingService;
  private readonly reserved: string[];
  private readonly stopListening: () => void;
  private interval?: NodeJS.Timeout;
  private picking = false;
  private closed = false;

  constructor(private readonly store: Store, options: { reserved: string[]; notebooks?: NotebookService }) {
    this.editing = new ArtifactEditingService(store);
    this.notebooks = options.notebooks;
    this.notebooks?.useFolders(this);
    this.reserved = options.reserved.map(path => { try { return realpathSync(path); } catch { return resolve(path); } });
    this.stopListening = store.onCommit(projectId => this.schedule(projectId, true));
  }
  private readonly notebooks?: NotebookService;

  start(): void {
    for (const project of this.store.listProjects()) if (this.load(project.id)) this.activate(project.id);
    // Watching can miss events on some file systems, so every folder is also checked every few seconds.
    this.interval = setInterval(() => { for (const id of this.active) this.schedule(id, false); }, 3000);
    this.interval.unref();
  }
  shutdown(): void {
    this.closed = true;
    this.stopListening();
    if (this.interval) clearInterval(this.interval);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.timers.clear(); this.watchers.clear(); this.active.clear();
  }

  private load(projectId: string): FolderRecord | undefined { return this.store.record<FolderRecord>(RECORD, projectId); }
  private save(record: FolderRecord): void { this.store.saveRecord(RECORD, record.projectId, record.projectId, record); }
  private require(projectId: string): { record: FolderRecord; files: FolderFiles } {
    this.store.getProject(projectId);
    const record = this.load(projectId);
    if (!record) throw new StoreError('Choose a folder for this project first.', 404);
    const root = this.verify(record);
    if (typeof root !== 'string') throw new StoreError(root.reason, 409);
    return { record, files: new FolderFiles(root) };
  }
  private verify(record: FolderRecord): string | { reason: string } {
    try {
      const real = realpathSync(record.path), info = statSync(real);
      if (real === record.path && info.isDirectory() && info.dev === record.device && info.ino === record.inode) return real;
      return { reason: 'The project folder was moved or replaced. Reconnect it from its new place.' };
    } catch { return { reason: 'The project folder is missing. Put it back, or reconnect it from its new place.' }; }
  }
  private mapped(record: FolderRecord): Set<string> {
    return new Set([...Object.values(record.files).filter(entry => !entry.removed).map(entry => entry.path.toLowerCase()),
      ...Object.values(record.outputs).flat().map(entry => entry.path.toLowerCase())]);
  }
  /** Exported artifact versions by path, used to keep report images and tables linked. */
  private exported(record: FolderRecord): Map<string, string> {
    const files = new Map<string, string>();
    for (const entry of Object.values(record.files)) if (!entry.removed && entry.artifactId && ['figure', 'dataset'].includes(entry.kind)) files.set(entry.artifactId, entry.path);
    for (const entry of Object.values(record.outputs).flat()) files.set(entry.artifactId, entry.path);
    return files;
  }

  status(projectId: string): ProjectFolderStatus {
    const project = this.store.getProject(projectId), record = this.load(projectId);
    if (!record) return { attached: false, revision: project.revision, files: [], unplaced: [], problems: [] };
    const checked = this.checked.get(projectId), live = new Set(project.canvas.nodes.map(node => node.id));
    const entries = Object.entries(record.files).filter(([nodeId, entry]) => !entry.removed && live.has(nodeId));
    return { attached: true, path: record.path, available: checked?.available ?? true, ...(checked?.reason ? { reason: checked.reason } : {}), revision: project.revision,
      files: entries.map(([nodeId, entry]) => ({ nodeId, path: entry.path, kind: entry.kind, ...(entry.missing ? { missing: true } : {}), ...(entry.kind === 'file' && entry.disk ? { bytes: entry.disk.size, version: entry.hash.slice(0, 12) } : {}) })),
      unplaced: checked?.unplaced ?? [],
      problems: [...entries.filter(([, entry]) => entry.problem).map(([, entry]) => ({ path: entry.path, message: entry.problem! })), ...(checked?.problems ?? [])],
      ...(checked ? { checkedAt: checked.checkedAt } : {}) };
  }

  /** The block's .ipynb, relative to the project folder. */
  notebookFile(projectId: string, nodeId: string): string | null {
    const entry = this.load(projectId)?.files[nodeId];
    return entry && !entry.removed && entry.kind === 'notebook' ? entry.path : null;
  }
  /** Mounted for the notebook's Python: the folder read-only, and outputs/<notebook>/, made here, writable. */
  notebookFolder(projectId: string, nodeId: string): KernelFolder | null {
    if (!this.load(projectId)) return null;
    const { files } = this.require(projectId), file = this.notebookFile(projectId, nodeId);
    const title = this.store.getProject(projectId).canvas.nodes.find(node => node.id === nodeId)?.title ?? 'Notebook';
    const outputs = posix.join('outputs', file ? stemOf(file) : safeFileBase(title)), place = files.resolve(posix.join(outputs, 'file'), true);
    return { root: files.root, notebookDir: file ? posix.dirname(file) : '.', outputs, outputsPath: dirname(place) };
  }
  /** An outputs folder the notebook left empty is removed again. */
  releaseNotebookFolder(_projectId: string, folder: KernelFolder): void {
    new FolderFiles(folder.root).prune(posix.join(folder.outputs, 'file'), 'outputs');
  }
  notebookChanged(projectId: string): void { this.schedule(projectId, true); }

  suggest(name: string): FolderSuggestion {
    const home = homedir(), documents = existsSync(join(home, 'Documents')) ? join(home, 'Documents') : home, stem = safeFileBase(name || 'Untitled');
    const overlaps = (folder: string) => this.reserved.some(other => folder === other || folder.startsWith(other + sep) || other.startsWith(folder + sep));
    const parent = [join(documents, 'ros.ai'), join(documents, 'ros.ai projects'), join(home, 'ros.ai projects')].find(folder => !overlaps(folder)) ?? join(home, 'ros.ai projects');
    let path = join(parent, stem);
    for (let index = 2; index < 100 && existsSync(path) && readdirSync(path).length; index++) path = join(parent, `${stem} ${index}`);
    return { path, exists: existsSync(path), picker: Boolean(this.picker()) };
  }

  /** Checks a folder the person typed or picked, without creating it. Returns its real absolute path. */
  prepare(supplied: string, projectId?: string): string {
    let path = supplied.trim();
    if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
    if (!isAbsolute(path)) throw new StoreError('Enter the full folder path, such as ~/Documents/ros.ai/My project.');
    path = resolve(path);
    const missing: string[] = [];
    let existing = path;
    while (!existsSync(existing)) { missing.unshift(basename(existing)); const parent = dirname(existing); if (parent === existing) break; existing = parent; }
    const real = join(realpathSync(existing), ...missing), home = realpathSync(homedir());
    const within = (folder: string, other: string) => folder === other || folder.startsWith(other.endsWith(sep) ? other : other + sep);
    if (real.split(sep).filter(Boolean).length < 2 || within(home, real) || SYSTEM_FOLDERS.some(folder => within(real, folder)) || (dirname(real) === home && HOME_FOLDERS.includes(basename(real))))
      throw new StoreError('Choose a folder of its own for this project, such as one inside Documents, not a whole home or system folder.');
    if (this.reserved.some(folder => within(real, folder) || within(folder, real))) throw new StoreError('Choose a folder outside ros.ai\'s own files.');
    if (existsSync(real) && !statSync(real).isDirectory()) throw new StoreError('That path is a file. Choose a folder.');
    for (const project of [...this.store.listProjects(), ...this.store.listTrashedProjects()]) {
      if (project.id === projectId) continue;
      const other = this.load(project.id);
      if (other && (within(real, other.path) || within(other.path, real))) throw new StoreError(`This folder overlaps the folder of “${project.title}”. Choose a separate folder.`, 409);
    }
    if (existsSync(real)) {
      const manifest = this.manifest(real);
      if (manifest && manifest.projectId !== projectId) throw new StoreError(`This folder already holds the ros.ai project “${manifest.title}”. Open it with New project, then Open a folder.`, 409);
    }
    return real;
  }

  /** Gives a project its folder, creating the folder if needed, and writes every block into it. */
  attach(projectId: string, supplied: string): ProjectFolderStatus {
    this.store.getProject(projectId);
    if (this.load(projectId)) throw new StoreError('This project already has a folder. If you moved it, reconnect it from its new place.', 409);
    const real = this.prepare(supplied, projectId);
    mkdirSync(real, { recursive: true });
    this.connect(projectId, realpathSync(real));
    return this.status(projectId);
  }

  /** Opens a folder as a project: a folder ros.ai made reconnects to its history; any other folder becomes a new project. */
  openFolder(supplied: string): Project {
    let path = supplied.trim();
    if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw new StoreError('Choose an existing folder.');
    const manifest = this.manifest(realpathSync(path));
    const owner = manifest && [...this.store.listProjects(), ...this.store.listTrashedProjects()].find(project => project.id === manifest.projectId);
    if (owner && this.store.listTrashedProjects().some(project => project.id === owner.id)) throw new StoreError(`This folder belongs to “${owner.title}”, which is in Trash. Restore that project first.`, 409);
    if (owner) {
      const real = this.prepare(path, owner.id);
      this.connect(owner.id, real, manifest);
      return this.store.getProject(owner.id);
    }
    const real = this.prepare(path, manifest?.projectId);
    const project = this.store.createProject((manifest?.title || basename(real)).trim().slice(0, 160) || 'Untitled project');
    try { this.connect(project.id, real, manifest, true); }
    catch (error) { this.store.trashProject(project.id); throw error; }
    return this.store.getProject(project.id);
  }

  private manifest(root: string): Manifest | undefined {
    try {
      const files = new FolderFiles(root);
      if (!files.exists(MANIFEST)) return undefined;
      const parsed = manifestSchema.safeParse(JSON.parse(decodeText(files.read(MANIFEST, 2_000_000).bytes)));
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  }

  private connect(projectId: string, root: string, manifest?: Manifest, rebuild = false): void {
    const info = statSync(root), previous = this.load(projectId);
    const record: FolderRecord = { projectId, path: root, device: info.dev, inode: info.ino, attachedAt: now(), files: previous?.files ?? {}, outputs: previous?.outputs ?? {}, ...(previous?.board ? { board: previous.board } : {}) };
    for (const entry of Object.values(record.files)) delete entry.disk;
    const files = new FolderFiles(root);
    if (rebuild && manifest) this.rebuild(record, files, manifest);
    else if (manifest) {
      // The folder decides where each block's file is. A file that differs from ros.ai is read in as an outside edit.
      const project = this.store.getProject(projectId), artifacts = new Map(this.store.listArtifacts(projectId).map(artifact => [artifact.id, artifact]));
      for (const block of manifest.blocks) {
        const node = project.canvas.nodes.find(item => item.id === block.id), kind = node && fileKind(node, artifacts);
        if (!node || !kind || !block.file || !files.exists(block.file)) continue;
        const rendered = this.render(projectId, node, kind, artifacts, this.exported(record), posix.dirname(block.file));
        if (rendered) record.files[node.id] = { path: block.file, kind, hash: sha(rendered.bytes), ...(rendered.artifactId ? { artifactId: rendered.artifactId } : {}) };
      }
    }
    this.save(record);
    this.activate(projectId);
    this.syncNow(projectId, true);
  }

  /** A folder ros.ai made on another computer: its blocks come back from project.json and their files. */
  private rebuild(record: FolderRecord, files: FolderFiles, manifest: Manifest): void {
    const projectId = record.projectId, ids = new Set(manifest.blocks.map(block => block.id));
    const depth = (id: string | null, seen = new Set<string>()): number => { const block = manifest.blocks.find(item => item.id === id); return !block?.parentId || seen.has(block.id) ? 0 : 1 + depth(block.parentId, seen.add(block.id)); };
    const groups = manifest.blocks.filter(block => block.kind === 'group').sort((a, b) => depth(a.id) - depth(b.id));
    const parentOf = (block: Manifest['blocks'][number]) => block.parentId && ids.has(block.parentId) && groups.some(group => group.id === block.parentId) ? block.parentId : null;
    if (groups.length) this.store.mutate(projectId, groups.map(group => ({ type: 'addNode', node: { id: group.id, title: group.title, description: '', kind: 'group', parentId: parentOf(group), x: group.x, y: group.y } })), 'Groups from the project folder');
    const order: Record<string, number> = { figure: 0, dataset: 0, file: 0, note: 1, code: 1, notebook: 1, report: 2, app: 3 };
    const placed: string[] = [];
    for (const block of manifest.blocks.filter(item => item.kind !== 'group' && item.file).sort((a, b) => (order[kindForFile(a.file!, a.blockType)] ?? 1) - (order[kindForFile(b.file!, b.blockType)] ?? 1))) {
      const kind = kindForFile(block.file!, block.blockType);
      try {
        if (!files.exists(block.file!)) continue;
        this.blockFromFile(record, files, block.file!, kind, { id: block.id, title: block.title, kind: block.kind, blockType: block.blockType, label: block.label, paper: block.paper, parentId: parentOf(block), x: block.x, y: block.y, width: block.width, height: block.height });
        placed.push(block.id);
      } catch { /* listed as an unplaced file instead */ }
    }
    // Adding a block finds it a free spot; the saved arrangement is put back afterwards.
    const positions: Mutation[] = manifest.blocks.filter(block => placed.includes(block.id)).map(block => ({ type: 'updateNode', id: block.id, patch: { x: block.x, y: block.y } }));
    if (positions.length) try { this.store.mutate(projectId, positions, 'Arrange blocks from the project folder'); } catch { /* blocks stay where ros.ai placed them */ }
    const live = new Set([...groups.map(group => group.id), ...placed]);
    // An App reads the blocks the manifest names, once they are all back.
    for (const block of manifest.blocks.filter(item => item.inputs?.length && placed.includes(item.id)))
      try { this.store.mutate(projectId, [{ type: 'updateNode', id: block.id, patch: { app: { source: this.store.getProject(projectId).canvas.nodes.find(node => node.id === block.id)?.app?.source ?? '', inputs: block.inputs!.filter(input => live.has(input) && input !== block.id) } } }], 'App inputs from the project folder'); } catch { /* the App reads nothing until inputs are added */ }
    for (const connection of manifest.connections.filter(item => live.has(item.source) && live.has(item.target) && item.source !== item.target))
      try { this.store.mutate(projectId, [{ type: 'addConnection', connection }], 'Connections from the project folder'); } catch { /* a connection ros.ai cannot keep is left out */ }
  }

  /** Adds a file that is already in the folder to the canvas as a block. */
  add(projectId: string, rel: string, placement: Partial<Pick<CanvasNode, 'parentId' | 'x' | 'y'>> = {}): { nodeId: string } {
    const { record, files } = this.require(projectId), kind = unplacedKind(rel);
    if (!kind) throw new StoreError('ros.ai can add Markdown, code, CSV, notebook, HTML (an App), PDF, PNG and JPEG files.');
    if (this.mapped(record).has(rel.toLowerCase())) throw new StoreError('This file is already a block on the canvas.', 409);
    // A PDF or image becomes a File block that shows it; a PDF's text is read into the block's saved version afterwards.
    const node = this.blockFromFile(record, files, rel, kind === 'pdf' || kind === 'image' ? 'file' : kind, placement);
    return { nodeId: node.id };
  }
  /** Any file the folder lists as new. */
  async addFile(projectId: string, rel: string): Promise<{ nodeId: string }> { return this.add(projectId, rel); }

  /** Saves a file the person dropped on the canvas into files/ in the project folder, so a File block can show it. */
  saveFile(projectId: string, name: string, bytes: Buffer): { path: string } {
    const { record, files } = this.require(projectId), extension = extensionOf(name);
    if (!fileMediaType(name)) throw new StoreError('ros.ai shows PDF, PNG and JPEG files.');
    if (!bytes.length) throw new StoreError(`${name} is empty.`);
    if (bytes.length > FILE_BYTES) throw new StoreError(`${name} is larger than ${Math.round(FILE_BYTES / 1_000_000)} MB, the most a File block shows.`);
    const path = this.freePath(files, FOLDER_DIRECTORIES.file, safeFileBase(stemOf(name)), extension.toLowerCase() === '.jpeg' ? '.jpeg' : extension.toLowerCase(), this.mapped(record));
    files.write(path, bytes);
    return { path };
  }
  /** The file a File block shows, for the server to send to the browser. The block's path is checked against the folder on every read. */
  fileOf(projectId: string, nodeId: string): { absolute: string; name: string; mediaType: string; size: number; hash?: string } {
    const { files } = this.require(projectId), node = this.store.getProject(projectId).canvas.nodes.find(item => item.id === nodeId);
    if (!node?.file) throw new StoreError('This block shows no file.', 404);
    const mediaType = fileMediaType(node.file.path);
    if (!mediaType) throw new StoreError('ros.ai shows PDF, PNG and JPEG files.', 415);
    const info = files.stat(node.file.path);
    if (!info) throw new StoreError(`${node.file.path} is missing from the project folder.`, 404);
    if (!info.isFile()) throw new StoreError(`${node.file.path} is not a normal file.`, 404);
    if (info.size > FILE_BYTES) throw new StoreError(`${node.file.path} is larger than ${Math.round(FILE_BYTES / 1_000_000)} MB, the most a File block shows.`, 413);
    const entry = this.load(projectId)?.files[nodeId];
    return { absolute: files.resolve(node.file.path), name: posix.basename(node.file.path), mediaType, size: info.size, ...(entry && !entry.removed && entry.disk?.mtimeMs === info.mtimeMs && entry.disk.size === info.size ? { hash: entry.hash } : {}) };
  }
  /** Checks a path an agent wants to show as a File block: a PDF or image in the folder that is not a block yet. */
  placeable(projectId: string, rel: string): void {
    const record = this.load(projectId);
    if (!record) throw new StoreError('This project has no folder, so there is no file to show. Ask the person to choose a project folder first.');
    const files = new FolderFiles(record.path);
    if (!fileMediaType(rel)) throw new StoreError(`${rel} is not a PDF, PNG or JPEG. A File block shows only those.`);
    if (!files.stat(rel)?.isFile()) throw new StoreError(`${rel} is not in the project folder. ros_read_canvas lists the files that can be shown.`, 404);
    if (this.mapped(record).has(rel.toLowerCase())) throw new StoreError(`${rel} is already a block on the canvas.`, 409);
  }
  /** PDFs and images in the folder that are not on the canvas yet, for agents choosing what to show. */
  placeableFiles(projectId: string): UnplacedFile[] {
    return (this.checked.get(projectId)?.unplaced ?? []).filter(file => file.kind === 'pdf' || file.kind === 'image');
  }

  private blockFromFile(record: FolderRecord, files: FolderFiles, rel: string, kind: FolderFileKind, placement: Partial<Pick<CanvasNode, 'id' | 'title' | 'kind' | 'blockType' | 'label' | 'paper' | 'parentId' | 'x' | 'y' | 'width' | 'height'>>): CanvasNode {
    const projectId = record.projectId, read = files.read(rel, READ_BYTES[kind]);
    if (kind === 'figure') throw new StoreError('Figures are written by ros.ai and cannot be added from the folder yet.');
    if (kind === 'file' && !fileMediaType(rel)) throw new StoreError('ros.ai shows PDF, PNG and JPEG files.');
    const text = kind === 'file' ? '' : decodeText(read.bytes), id = placement.id ?? randomUUID();
    const base: CanvasNode = { id, title: placement.title ?? titleFromPath(rel), description: '', x: placement.x ?? 0, y: placement.y ?? 0, kind: placement.kind && placement.kind !== 'group' ? placement.kind : 'topic',
      ...(placement.parentId ? { parentId: placement.parentId } : {}), ...(placement.width ? { width: placement.width } : {}), ...(placement.height ? { height: placement.height } : {}), ...(placement.label ? { label: placement.label } : {}), ...(placement.paper ? { paper: placement.paper } : {}) };
    let node: CanvasNode;
    if (kind === 'note') {
      if (text.length > 20_000) throw new StoreError(`${rel} is longer than 20,000 characters, the most a note holds.`);
      node = { ...base, blockType: placement.blockType === 'action' || placement.blockType === 'agent' || placement.blockType === 'search' || placement.blockType === 'finding' ? placement.blockType : 'note', description: text };
    } else if (kind === 'code') {
      if (text.length > 100_000) throw new StoreError(`${rel} is longer than 100,000 characters, the most a Code block holds.`);
      node = { ...base, blockType: 'code', code: { language: codeLanguage(extensionOf(rel)) ?? 'python', source: text, parameters: {}, inputArtifactId: null } };
    } else if (kind === 'app') {
      if (text.length > APP_SOURCE_LIMIT) throw new StoreError(`${rel} is longer than ${APP_SOURCE_LIMIT.toLocaleString('en')} characters, the most an App's page holds.`);
      // The page alone: an App read from a file reads nothing until inputs are added in ros.ai.
      node = { ...base, blockType: 'app', app: { source: text, inputs: [] } };
    } else if (kind === 'dataset') { parseCsv(text, true); node = { ...base, blockType: 'dataset' }; }
    else if (kind === 'file') node = { ...base, blockType: 'file', file: { path: rel } };
    else if (kind === 'notebook') node = { ...base, blockType: 'notebook' };
    else node = { ...base, blockType: 'report' };
    // The file is recorded with the block in one transaction, so the folder pass that follows never writes a second copy.
    return this.store.atomic(() => {
      record.files[id] = { path: rel, kind, hash: read.observed.hash, disk: read.observed };
      this.save(record);
      this.store.mutate(projectId, [{ type: 'addNode', node }], `Added ${rel} from the project folder`);
      const added = this.store.getProject(projectId).canvas.nodes.find(item => item.id === id)!;
      if (kind === 'dataset') record.files[id].artifactId = this.capture(projectId, added, { kind: 'dataset', title: added.title, content: text, mediaType: 'text/csv', path: rel }).id;
      if (kind === 'file') this.queueText(projectId, id);
      if (kind === 'notebook') { if (!this.notebooks) throw new StoreError('Notebooks are unavailable.'); this.notebooks.fromFile(projectId, id, rel, text, read.observed.hash); }
      if (kind === 'report') {
        const evidence = new Set<string>(), canonical = reportFromFolder(text, posix.dirname(rel), new Map([...this.exported(record)].map(([artifactId, path]) => [path.toLowerCase(), artifactId])), evidence);
        this.editing.saveReport(projectId, { nodeId: id, title: added.title, text: canonical, evidenceIds: [...evidence].filter(artifactId => this.ownArtifact(projectId, artifactId)) });
      }
      this.save(record);
      return added;
    });
  }
  private ownArtifact(projectId: string, artifactId: string): boolean { try { return this.store.getArtifact(artifactId).projectId === projectId; } catch { return false; } }

  /** A file read from the folder becomes a new saved version of the block, with its own record. */
  private capture(projectId: string, node: CanvasNode, input: { kind: 'dataset' | 'source'; title: string; content: string; mediaType: string; path: string; metadata?: Record<string, unknown>; label?: string }): Artifact {
    return this.store.atomic(() => {
      const project = this.store.getProject(projectId), at = now();
      const run: Run = { id: randomUUID(), projectId, nodeId: node.id, request: input.label ?? `Read ${input.path} from the project folder`, useSearch: false, status: 'running', createdAt: at, startedAt: at, projectRevision: project.revision,
        node: structuredClone(node), inputs: [], messages: [], provider: 'local', model: 'project-folder-v1', modelVersion: null, configuration: { kind: 'file-import', origin: 'project-folder', path: input.path },
        tools: [], events: [{ at, type: 'file-import', message: 'Read a file from the project folder. No model or code ran.' }], artifactIds: [] };
      this.store.createRun(run);
      const artifact = this.store.addArtifact({ projectId, nodeId: node.id, runId: run.id, kind: input.kind, title: input.title, content: input.content, mediaType: input.mediaType, capture: 'full-content', metadata: { origin: 'project-folder', path: input.path, ...input.metadata } });
      this.store.updateRun(run.id, { status: 'completed', endedAt: at, artifactIds: [artifact.id] });
      this.store.mutate(projectId, [{ type: 'updateNode', id: node.id, patch: { artifactId: artifact.id } }], input.label ?? `Edited outside ros.ai: ${input.path}`);
      return artifact;
    });
  }

  /** Writes a missing file back from ros.ai's copy. */
  restore(projectId: string, nodeId: string): ProjectFolderStatus {
    const { record, files } = this.require(projectId), entry = record.files[nodeId];
    const node = this.store.getProject(projectId).canvas.nodes.find(item => item.id === nodeId);
    if (!node || !entry || entry.removed) throw new StoreError('This block has no file in the project folder.', 404);
    if (!files.exists(entry.path)) {
      const rendered = this.render(projectId, node, entry.kind, new Map(this.store.listArtifacts(projectId).map(artifact => [artifact.id, artifact])), this.exported(record), posix.dirname(entry.path));
      if (!rendered) throw new StoreError('ros.ai has nothing to write for this block yet.');
      entry.disk = files.write(entry.path, rendered.bytes);
      entry.hash = entry.disk.hash;
    }
    entry.missing = false;
    this.save(record);
    return this.status(projectId);
  }

  /** Apps found on this computer that can open a block's file or the project folder. */
  apps(): OpenApp[] { return installedApps().map(({ id, label, kind }) => ({ id, label, kind })); }

  /** Opens a block's file (or the project folder) in the default app, a named installed app, or the file manager. */
  async open(projectId: string, nodeId: string | undefined, how: 'default' | 'reveal' | string): Promise<{ path: string }> {
    const { record, files } = this.require(projectId), entry = nodeId ? record.files[nodeId] : undefined;
    if (nodeId && (!entry || entry.removed)) throw new StoreError('This block has no file in the project folder yet.', 404);
    if (entry && !files.exists(entry.path)) throw new StoreError(`${entry.path} is missing from the project folder.`, 404);
    const target = entry ? files.resolve(entry.path) : files.root, reveal = how === 'reveal';
    const app = how === 'default' || reveal ? undefined : installedApps().find(item => item.id === how);
    if (how !== 'default' && !reveal && !app) throw new StoreError('That app is not available on this computer.', 404);
    // Terminals open in the file's folder.
    const place = app?.kind === 'terminal' && entry ? dirname(target) : target;
    // Code opens in a text editor: the default app for .py or .sh files can run them instead. The project folder itself opens rather than being selected in its parent.
    const [command, args] = app ? (process.platform === 'darwin' ? ['/usr/bin/open', ['-a', app.path, place]] : [app.path, [place]])
      : process.platform === 'darwin' ? ['/usr/bin/open', reveal && entry ? ['-R', target] : entry?.kind === 'code' || entry?.kind === 'app' ? ['-t', target] : [target]]
      : process.platform === 'win32' ? ['explorer.exe', [(reveal || entry?.kind === 'app') && entry ? `/select,${target}` : target]] : ['xdg-open', [(reveal || entry?.kind === 'app') && entry ? dirname(target) : target]];
    await launch(command, args);
    return { path: entry?.path ?? '.' };
  }

  private picker(): { command: string; args: (start: string, prompt: string) => string[] } | null {
    // System Events shows the window in front; osascript's own window can open behind the browser and seem slow.
    // Without permission to control System Events, osascript shows it itself.
    if (process.platform === 'darwin' && existsSync('/usr/bin/osascript')) return { command: '/usr/bin/osascript', args: (start, prompt) => ['-e', 'on run argv', '-e', 'try',
      '-e', 'tell application "System Events"', '-e', 'activate',
      '-e', 'return POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))', '-e', 'end tell',
      '-e', 'on error errorText number errorNumber', '-e', 'if errorNumber is -128 then error number -128', '-e', 'activate',
      '-e', 'return POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))', '-e', 'end try', '-e', 'end run', prompt, start] };
    if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
      const find = (name: string) => (process.env.PATH ?? '').split(delimiter).map(folder => join(folder, name)).find(path => existsSync(path));
      const zenity = find('zenity'), kdialog = find('kdialog');
      if (zenity) return { command: zenity, args: (start, prompt) => ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${start}/`] };
      if (kdialog) return { command: kdialog, args: (start, prompt) => ['--getexistingdirectory', start, '--title', prompt] };
    }
    return null;
  }
  /** Shows the computer's own folder window, where the person can also make a new folder. */
  async choose(start?: string): Promise<FolderChoice> {
    const picker = this.picker();
    if (!picker) throw new StoreError('ros.ai cannot open a folder window on this computer. Type the folder path instead.', 501);
    if (this.picking) throw new StoreError('A folder window is already open. Choose a folder there first.', 409);
    let initial = start?.trim() ? start.trim().replace(/^~(?=$|\/)/u, homedir()) : dirname(this.suggest('').path);
    while (!existsSync(initial) && dirname(initial) !== initial) initial = dirname(initial);
    this.picking = true;
    try {
      const { code, output } = await new Promise<{ code: number | null; output: string }>((done, fail) => {
        const child = spawn(picker.command, picker.args(initial, 'Choose or create a folder for this ros.ai project'), { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        const timer = setTimeout(() => child.kill(), 10 * 60_000);
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (output.length < 8192) output += chunk; });
        child.once('error', error => { clearTimeout(timer); fail(error); });
        child.once('close', code => { clearTimeout(timer); done({ code, output }); });
      });
      const path = output.trim().replace(/(.)\/$/u, '$1');
      return code === 0 && path ? { path } : { cancelled: true };
    } finally { this.picking = false; }
  }

  private activate(projectId: string): void {
    this.active.add(projectId);
    this.rewatch(projectId);
    this.schedule(projectId, true);
  }
  private rewatch(projectId: string): void {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    const record = this.load(projectId), root = record && this.verify(record);
    if (typeof root !== 'string' || this.closed) return;
    try {
      const watcher = watch(root, { recursive: true }, (_event, name) => { if (!name || !/(^|[\\/])\.ros-ai/u.test(String(name))) this.schedule(projectId, false); });
      watcher.on('error', () => { watcher.close(); if (this.watchers.get(projectId) === watcher) this.watchers.delete(projectId); });
      this.watchers.set(projectId, watcher);
    } catch { /* the regular check still runs */ }
  }
  private schedule(projectId: string, write: boolean): void {
    if (this.closed || !this.active.has(projectId)) return;
    if (write) this.exportDue.add(projectId);
    if (this.timers.has(projectId)) return;
    this.timers.set(projectId, setTimeout(() => {
      this.timers.delete(projectId);
      this.syncNow(projectId, this.exportDue.delete(projectId));
    }, write ? 50 : 150));
  }
  /** A failed pass is shown with the folder and tried again on the next change. */
  private syncNow(projectId: string, write: boolean): void {
    try { this.sync(projectId, write); void this.readPendingText(projectId); }
    catch (error) {
      if (write) this.exportDue.add(projectId);
      this.checked.set(projectId, { available: true, unplaced: this.checked.get(projectId)?.unplaced ?? [], problems: [{ path: '.', message: `Folder sync stopped: ${message(error)}` }], checkedAt: now() });
    }
  }

  private sync(projectId: string, write: boolean): void {
    const record = this.load(projectId);
    if (!record) { this.active.delete(projectId); this.watchers.get(projectId)?.close(); this.watchers.delete(projectId); return; }
    let project: Project;
    try { project = this.store.getProject(projectId); }
    catch (error) { this.checked.set(projectId, { available: false, reason: message(error), unplaced: [], problems: [], checkedAt: now() }); return; }
    const root = this.verify(record);
    if (typeof root !== 'string') { this.checked.set(projectId, { available: false, reason: root.reason, unplaced: [], problems: [], checkedAt: now() }); return; }
    if (!this.watchers.has(projectId)) this.rewatch(projectId);
    const files = new FolderFiles(root), problems: FolderProblem[] = [], before = JSON.stringify(record);
    let listing: Listed[] = [];
    try {
      listing = files.list();
      this.adoptFileBlocks(record, files, project);
      this.readOutsideEdits(record, files, project, listing);
      if (write) { this.writeAll(record, files, problems); listing = files.list(); }
    } finally {
      if (JSON.stringify(record) !== before) this.save(record);
      const mapped = this.mapped(record), board = record.board?.toLowerCase();
      const unplaced = listing.filter(file => !mapped.has(file.path.toLowerCase()) && file.path.toLowerCase() !== board)
        .flatMap(file => { const kind = unplacedKind(file.path); return kind ? [{ path: file.path, kind, bytes: file.size }] : []; }).slice(0, 200);
      this.checked.set(projectId, { available: true, unplaced, problems, checkedAt: now() });
    }
  }

  /** A File block that arrived without the folder (an agent's proposal, a drop, Undo) is recorded with its file, and its text read. */
  private adoptFileBlocks(record: FolderRecord, files: FolderFiles, project: Project): void {
    for (const node of project.canvas.nodes) {
      const entry = record.files[node.id];
      if (node.kind === 'group' || nodeBlockType(node) !== 'file' || !node.file?.path || (entry && !entry.removed)) continue;
      let read: ReturnType<FolderFiles['read']> | undefined, problem: string | undefined;
      try { if (!fileMediaType(node.file.path)) throw new StoreError('is not a PDF, PNG or JPEG, so ros.ai cannot show it.'); if (files.stat(node.file.path)) read = files.read(node.file.path, READ_BYTES.file); }
      catch (error) { problem = message(error); }
      record.files[node.id] = { path: node.file.path, kind: 'file', hash: read?.observed.hash ?? '', ...(read ? { disk: read.observed } : { missing: true }), ...(problem ? { problem } : {}) };
      if (read) this.queueText(record.projectId, node.id);
    }
  }
  private queueText(projectId: string, nodeId: string): void {
    const pending = this.pendingText.get(projectId) ?? new Set<string>();
    pending.add(nodeId);
    this.pendingText.set(projectId, pending);
  }
  /** Reads the text of each waiting PDF into its File block as a saved version. Images have no text to read. */
  private async readPendingText(projectId: string): Promise<void> {
    if (this.readingText.has(projectId)) return;
    this.readingText.add(projectId);
    try {
      for (let pending = this.pendingText.get(projectId); pending?.size; pending = this.pendingText.get(projectId)) {
        const [nodeId] = pending;
        pending.delete(nodeId);
        try { await this.readFileText(projectId, nodeId); }
        catch (error) { const entry = this.load(projectId)?.files[nodeId]; if (entry) { entry.problem = message(error); this.save(this.load(projectId)!); } }
      }
    } finally { this.readingText.delete(projectId); }
  }
  private async readFileText(projectId: string, nodeId: string): Promise<void> {
    const record = this.load(projectId);
    const entry = record?.files[nodeId], node = this.store.getProject(projectId).canvas.nodes.find(item => item.id === nodeId);
    if (!record || !entry || entry.removed || entry.kind !== 'file' || !node) return;
    const files = new FolderFiles(record.path), read = files.read(entry.path, READ_BYTES.file);
    const previous = node.artifactId ? this.store.listArtifacts(projectId).find(artifact => artifact.id === node.artifactId) : undefined;
    if (previous?.metadata?.fileHash === read.observed.hash) return;
    if (!isPdfType(fileMediaType(entry.path))) return;
    let text = '', pages = 0;
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const document = await getDocumentProxy(new Uint8Array(read.bytes));
      pages = document.numPages;
      const result = await extractText(document, { mergePages: false });
      text = (result.text as string[]).map(page => page.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()).filter(Boolean).join('\n\n');
    } catch { throw new StoreError('could not be read as a PDF, so its text is not available to agents.'); }
    if (this.closed) return;
    const current = this.store.getProject(projectId).canvas.nodes.find(item => item.id === nodeId);
    if (!current || current.file?.path !== entry.path) return;
    const name = posix.basename(entry.path);
    const content = text.trim() ? text.slice(0, FILE_TEXT) : `${name} has no text layer (it may be a scan), so there is no text to read.`;
    this.capture(projectId, current, { kind: 'source', title: `Text of ${name}`, content, mediaType: 'text/plain', path: entry.path, metadata: { fileHash: read.observed.hash, pages, mediaType: 'application/pdf', ...(text.trim() ? {} : { noTextLayer: true }), ...(text.length > FILE_TEXT ? { truncated: true } : {}) }, label: `Read the text of ${name}` });
  }

  private observe(files: FolderFiles, entry: FileEntry): { observed: Observed; bytes?: Buffer } | null {
    const info = files.stat(entry.path);
    if (!info) return null;
    if (!info.isFile()) throw new StoreError(`${entry.path} is no longer a normal file.`);
    if (entry.disk && entry.disk.mtimeMs === info.mtimeMs && entry.disk.size === info.size) return { observed: entry.disk };
    const read = files.read(entry.path, READ_BYTES[entry.kind]);
    entry.disk = read.observed;
    return read;
  }

  /** Files changed in other apps become canvas changes that Undo can reverse. */
  private readOutsideEdits(record: FolderRecord, files: FolderFiles, project: Project, listing: Listed[]): void {
    const nodes = new Map(project.canvas.nodes.map(node => [node.id, node]));
    const operations: Mutation[] = [], edited: string[] = [], renamed: string[] = [], agreed: [FileEntry, Observed][] = [];
    for (const [nodeId, entry] of Object.entries(record.files)) {
      const node = nodes.get(nodeId);
      if (entry.removed || !node) continue;
      let seen: ReturnType<ProjectFolders['observe']>;
      try { seen = this.observe(files, entry); } catch (error) { entry.problem = `${message(error)}`; continue; }
      if (!seen) {
        const moved = this.findMoved(record, files, entry, listing);
        if (!moved) { entry.missing = true; continue; }
        renamed.push(`${entry.path} → ${moved.path}`);
        entry.path = moved.path; entry.disk = moved.observed; entry.missing = false;
        const title = titleFromPath(moved.path);
        if (!new RegExp(`^${escapeRegExp(safeFileBase(node.title))}( \\d+)?$`, 'u').test(title)) operations.push({ type: 'updateNode', id: nodeId, patch: { title } });
        if (entry.kind === 'file') operations.push({ type: 'updateNode', id: nodeId, patch: { file: { path: moved.path } } });
        continue;
      }
      entry.missing = false;
      if (seen.observed.hash === entry.hash) { delete entry.problem; continue; }
      // A PDF or image replaced on disk: the card shows the new file, and a PDF's text is read again.
      if (entry.kind === 'file') { entry.hash = seen.observed.hash; delete entry.problem; this.queueText(record.projectId, nodeId); continue; }
      // A version already seen and refused keeps its problem until the file changes again.
      if (!seen.bytes || !TWO_WAY.has(entry.kind)) continue;
      try {
        const text = decodeText(seen.bytes);
        if (entry.kind === 'note') {
          if (text.length > 20_000) throw new StoreError('is longer than 20,000 characters, so ros.ai kept its own copy.');
          operations.push({ type: 'updateNode', id: nodeId, patch: { description: text } });
        } else if (entry.kind === 'code') {
          if (text.length > 100_000) throw new StoreError('is longer than 100,000 characters, so ros.ai kept its own copy.');
          operations.push({ type: 'updateNode', id: nodeId, patch: { code: { ...(node.code ?? { language: codeLanguage(extensionOf(entry.path)) ?? 'python', parameters: {}, inputArtifactId: null }), source: text } } });
        } else if (entry.kind === 'app') {
          if (text.length > APP_SOURCE_LIMIT) throw new StoreError(`is longer than ${APP_SOURCE_LIMIT.toLocaleString('en')} characters, so ros.ai kept its own copy.`);
          // Only the page: what the App reads is set in ros.ai, so a file edit cannot widen it.
          operations.push({ type: 'updateNode', id: nodeId, patch: { app: { source: text, inputs: node.app?.inputs ?? [] } } });
        } else { this.readArtifactFile(record, project.id, node, entry, text, seen.observed.hash); entry.hash = seen.observed.hash; delete entry.problem; continue; }
        agreed.push([entry, seen.observed]);
        edited.push(entry.path);
      } catch (error) { entry.problem = `${entry.path} ${message(error)}`; }
    }
    if (!operations.length) return;
    const label = edited.length ? `Edited outside ros.ai: ${[...edited, ...renamed].length === 1 ? edited[0] : `${edited.length + renamed.length} files`}` : `Renamed outside ros.ai: ${renamed.join(', ')}`;
    try {
      this.store.mutate(project.id, operations, label.slice(0, 500));
      for (const [entry, observed] of agreed) { entry.hash = observed.hash; delete entry.problem; }
    } catch (error) { for (const [entry] of agreed) entry.problem = `${entry.path} could not be read back: ${message(error)}`; }
  }

  /** A file renamed or moved in another app is found again by its content. */
  private findMoved(record: FolderRecord, files: FolderFiles, entry: FileEntry, listing: Listed[]): { path: string; observed: Observed } | null {
    if (!entry.hash) return null;
    const mapped = this.mapped(record), extension = extensionOf(entry.path).toLowerCase();
    for (const file of listing) {
      if (mapped.has(file.path.toLowerCase()) || extensionOf(file.path).toLowerCase() !== extension || (entry.disk && file.size !== entry.disk.size)) continue;
      try { const read = files.read(file.path, READ_BYTES[entry.kind]); if (read.observed.hash === entry.hash) return { path: file.path, observed: read.observed }; } catch { /* unreadable files are not matches */ }
    }
    return null;
  }

  private readArtifactFile(record: FolderRecord, projectId: string, node: CanvasNode, entry: FileEntry, text: string, hash: string): void {
    if (entry.kind === 'dataset') { parseCsv(text, true); this.capture(projectId, node, { kind: 'dataset', title: node.title, content: text, mediaType: 'text/csv', path: entry.path }); return; }
    if (entry.kind === 'notebook') {
      if (!this.notebooks) throw new StoreError('could not be read because notebooks are unavailable.');
      this.notebooks.fromFile(projectId, node.id, entry.path, text, hash);
      return;
    }
    if (entry.kind !== 'report') return;
    if (text.length > 200_000) throw new StoreError('is longer than 200,000 characters, so ros.ai kept its own copy.');
    const previous = node.artifactId ? this.store.getArtifact(node.artifactId) : undefined;
    const evidence = new Set<string>(Array.isArray(previous?.metadata?.evidence) ? (previous.metadata.evidence as { artifactId?: unknown }[]).flatMap(item => typeof item?.artifactId === 'string' ? [item.artifactId] : []) : []);
    const byPath = new Map([...this.exported(record)].map(([artifactId, path]) => [path.toLowerCase(), artifactId]));
    const canonical = reportFromFolder(text, posix.dirname(entry.path), byPath, evidence);
    this.editing.saveReport(projectId, { nodeId: node.id, ...(previous ? { sourceArtifactId: previous.id } : {}), title: node.title, text: canonical, evidenceIds: [...evidence].filter(id => this.ownArtifact(projectId, id)).slice(0, 100) });
  }

  private render(projectId: string, node: CanvasNode, kind: FolderFileKind, artifacts: ReadonlyMap<string, Artifact>, exported: ReadonlyMap<string, string>, folder: string): Rendered | null {
    const artifact = node.artifactId ? artifacts.get(node.artifactId) : undefined;
    if (kind === 'file') return null; // the person's own PDF or image: shown, never written
    if (kind === 'note') return { bytes: Buffer.from(node.description, 'utf8'), extension: '.md' };
    if (kind === 'code') {
      const code = node.code ?? { language: 'python', source: [...artifacts.values()].find(item => item.id === node.artifactId && item.kind === 'code')?.content ?? '' };
      return { bytes: Buffer.from(code.source, 'utf8'), extension: codeExtension(code.language) };
    }
    if (kind === 'report') return { bytes: Buffer.from(artifact ? reportForFolder(artifact.content, folder, exported) : '', 'utf8'), extension: '.md', ...(artifact ? { artifactId: artifact.id } : {}) };
    if (kind === 'app') return { bytes: Buffer.from(node.app?.source ?? '', 'utf8'), extension: '.html' };
    if (kind === 'notebook') {
      if (!this.notebooks) return null;
      const file = this.notebooks.file(projectId, node.id);
      return { bytes: file.bytes, extension: '.ipynb', ...(file.keep ? { keep: file.keep } : {}) };
    }
    if (!artifact) return null;
    if (kind === 'dataset') return { bytes: Buffer.from(artifact.mediaType === 'text/csv' ? artifact.content : tableCsv(artifactTable(artifact.content, false)), 'utf8'), extension: '.csv', artifactId: artifact.id };
    const figure = outputFile(artifact);
    return { ...figure, artifactId: artifact.id };
  }

  /** Writes ros.ai's current state to the folder. Files changed in other apps are never overwritten here. */
  private writeAll(record: FolderRecord, files: FolderFiles, problems: FolderProblem[]): void {
    const project = this.store.getProject(record.projectId), live = new Set(project.canvas.nodes.map(node => node.id));
    const artifacts = new Map(this.store.listArtifacts(project.id).map(artifact => [artifact.id, artifact]));
    // A removed block's file moves to .ros-ai/trash; Undo brings it back.
    for (const [nodeId, entry] of Object.entries(record.files)) {
      if (entry.removed || live.has(nodeId)) continue;
      // A removed File block leaves the person's file where it is; Undo finds it again.
      if (entry.kind === 'file') { entry.removed = true; delete entry.missing; delete entry.problem; continue; }
      try { const trashed = this.retire(files, entry.path, entry.hash, true); entry.removed = true; delete entry.missing; delete entry.problem; if (trashed) entry.trashPath = trashed; }
      catch (error) { problems.push({ path: entry.path, message: message(error) }); }
    }
    this.writeOutputs(record, files, project, artifacts, problems);
    const taken = this.mapped(record), exported = this.exported(record);
    for (const node of project.canvas.nodes) {
      const kind = fileKind(node, artifacts);
      if (!kind) continue;
      try { this.writeBlock(record, files, node, kind, artifacts, exported, taken); }
      catch (error) { problems.push({ path: record.files[node.id]?.path ?? `${FOLDER_DIRECTORIES[kind]}/${safeFileBase(node.title)}`, message: message(error) }); }
    }
    try { this.writeManifest(record, files, project); this.writeBoard(record, files, project); }
    catch (error) { problems.push({ path: MANIFEST, message: message(error) }); }
  }

  private writeBlock(record: FolderRecord, files: FolderFiles, node: CanvasNode, kind: FolderFileKind, artifacts: ReadonlyMap<string, Artifact>, exported: ReadonlyMap<string, string>, taken: Set<string>): void {
    let entry: FileEntry | undefined = record.files[node.id];
    if (entry && !entry.removed && entry.kind !== kind) {
      // The block changed type, for example a Knowledge note that became a Group.
      this.retire(files, entry.path, entry.hash, true);
      taken.delete(entry.path.toLowerCase());
      entry = undefined;
    }
    const current = entry && !entry.removed ? entry : undefined;
    const rendered = this.render(record.projectId, node, kind, artifacts, exported, current ? posix.dirname(current.path) : FOLDER_DIRECTORIES[kind]);
    if (!rendered) return;
    const hash = sha(rendered.bytes), base = safeFileBase(node.title);
    if (!current) {
      const previous = entry?.removed && entry.kind === kind ? entry : undefined;
      const back = previous && !taken.has(previous.path.toLowerCase()) && !files.exists(previous.path) ? previous.path : this.freePath(files, FOLDER_DIRECTORIES[kind], base, rendered.extension, taken);
      let observed: Observed | undefined;
      if (previous?.trashPath && files.exists(previous.trashPath)) {
        try { if (files.read(previous.trashPath, READ_BYTES[kind]).observed.hash === hash) { files.move(previous.trashPath, back); observed = { hash, ...pick(files.stat(back)!) }; } } catch { /* written fresh below */ }
      }
      record.files[node.id] = { path: back, kind, hash, disk: observed ?? files.write(back, rendered.bytes), ...(rendered.artifactId ? { artifactId: rendered.artifactId } : {}) };
      taken.add(back.toLowerCase());
      return;
    }
    const info = files.stat(current.path);
    if (!info) {
      // Missing: shown as File missing until ros.ai's copy changes or the person restores it.
      if (hash !== current.hash) { current.disk = files.write(current.path, rendered.bytes); current.hash = hash; delete current.missing; }
      else current.missing = true;
      if (rendered.artifactId) current.artifactId = rendered.artifactId;
      return;
    }
    const onDisk = current.disk && current.disk.mtimeMs === info.mtimeMs && current.disk.size === info.size ? current.disk.hash : (current.disk = files.read(current.path, READ_BYTES[kind]).observed).hash;
    // A notebook read from this exact file stays byte for byte as the other app wrote it.
    const kept = rendered.keep !== undefined && onDisk === rendered.keep;
    if (kept) current.hash = onDisk;
    const changedElsewhere = onDisk !== current.hash;
    if (changedElsewhere && TWO_WAY.has(kind)) return;
    let path = current.path;
    const extension = extensionOf(path);
    if (extension.toLowerCase() !== rendered.extension.toLowerCase() || !new RegExp(`^${escapeRegExp(base)}( \\d+)?$`, 'u').test(stemOf(path)))
      path = this.freePath(files, posix.dirname(path), base, rendered.extension, taken, current.path);
    if (changedElsewhere) this.retire(files, current.path, current.hash, true); // another app's figure stays in .ros-ai/trash
    else if (path !== current.path) files.move(current.path, path);
    if (path !== current.path) { taken.delete(current.path.toLowerCase()); taken.add(path.toLowerCase()); current.path = path; }
    if (!kept && (hash !== current.hash || changedElsewhere)) { current.disk = files.write(path, rendered.bytes); current.hash = hash; }
    delete current.missing;
    if (rendered.artifactId) current.artifactId = rendered.artifactId; else delete current.artifactId;
  }

  /** The newest finished Code run's figures and tables, in outputs/<block>/. Earlier runs stay in ros.ai's history. */
  private writeOutputs(record: FolderRecord, files: FolderFiles, project: Project, artifacts: ReadonlyMap<string, Artifact>, problems: FolderProblem[]): void {
    const runs = this.store.listRuns(project.id), codeBlocks = project.canvas.nodes.filter(node => node.kind !== 'group' && nodeBlockType(node) === 'code');
    for (const nodeId of Object.keys(record.outputs)) if (!codeBlocks.some(node => node.id === nodeId)) {
      for (const output of record.outputs[nodeId]) try { this.retire(files, output.path, output.hash, false); files.prune(output.path, 'outputs'); } catch (error) { problems.push({ path: output.path, message: message(error) }); }
      delete record.outputs[nodeId];
    }
    for (const node of codeBlocks) {
      const run = runs.find(item => item.nodeId === node.id && item.status === 'completed' && item.configuration.kind === 'local-experiment');
      const outputs = (run?.artifactIds ?? []).map(id => artifacts.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact && isOutputArtifact(artifact)));
      const previous = record.outputs[node.id] ?? [], folder = posix.join('outputs', safeFileBase(node.title)), names = new Set<string>();
      const wanted = outputs.map(artifact => {
        const file = outputFile(artifact), stem = safeFileBase(artifact.title);
        let path = posix.join(folder, `${stem}${file.extension}`);
        for (let index = 2; names.has(path.toLowerCase()); index++) path = posix.join(folder, `${stem} ${index}${file.extension}`);
        names.add(path.toLowerCase());
        return { path, bytes: file.bytes, artifactId: artifact.id, hash: sha(file.bytes) };
      });
      for (const old of previous) if (!wanted.some(item => item.path === old.path && item.hash === old.hash)) {
        try { this.retire(files, old.path, old.hash, false); files.prune(old.path, 'outputs'); } catch (error) { problems.push({ path: old.path, message: message(error) }); }
      }
      const next: OutputEntry[] = [];
      for (const item of wanted) {
        try {
          const kept = previous.find(old => old.path === item.path && old.hash === item.hash);
          if (!kept || !files.exists(item.path)) files.write(item.path, item.bytes);
          next.push({ path: item.path, hash: item.hash, artifactId: item.artifactId });
        } catch (error) { problems.push({ path: item.path, message: message(error) }); }
      }
      if (next.length) record.outputs[node.id] = next; else delete record.outputs[node.id];
    }
  }

  private writeIfChanged(files: FolderFiles, rel: string, bytes: Buffer): void {
    try { if (files.read(rel, 20_000_000).bytes.equals(bytes)) return; } catch { /* missing or unreadable: written below */ }
    files.write(rel, bytes);
  }
  private writeManifest(record: FolderRecord, files: FolderFiles, project: Project): void {
    const manifest: Manifest = { app: 'ros.ai', format: 1, projectId: project.id, title: project.title,
      blocks: project.canvas.nodes.map(node => { const entry = record.files[node.id]; return { id: node.id, title: node.title, kind: node.kind ?? 'unspecified', ...(node.blockType ? { blockType: node.blockType } : {}), ...(node.notion ? { notion: shareable(node.notion) } : {}), ...(node.google ? { google: node.google } : {}), ...(node.training ? { training: node.training } : {}), ...(node.paper ? { paper: node.paper } : {}), ...(node.label ? { label: node.label } : {}),
        parentId: node.parentId ?? null, x: node.x, y: node.y, ...(node.width === undefined ? {} : { width: node.width }), ...(node.height == null ? {} : { height: node.height }), ...(entry && !entry.removed ? { file: entry.path } : {}), ...(node.app ? { inputs: node.app.inputs } : {}) }; }),
      connections: project.canvas.connections };
    this.writeIfChanged(files, MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  }
  /** The board as JSON Canvas, which Obsidian opens. ros.ai rewrites it; moves made in Obsidian are not read back. */
  private writeBoard(record: FolderRecord, files: FolderFiles, project: Project): void {
    const nodes = project.canvas.nodes, byId = new Map(nodes.map(node => [node.id, node])), sizes = new Map<string, { width: number; height: number }>();
    const size = (node: CanvasNode, seen = new Set<string>()): { width: number; height: number } => {
      const known = sizes.get(node.id);
      if (known) return known;
      if (node.kind !== 'group' || seen.has(node.id)) return { width: cardWidth(node), height: setCardHeight(node) ?? CARD_DEFAULT_HEIGHT };
      seen.add(node.id);
      const children = nodes.filter(child => child.parentId === node.id).map(child => ({ child, box: size(child, seen) }));
      const right = Math.max(0, ...children.map(({ child, box }) => child.x + box.width)), bottom = Math.max(0, ...children.map(({ child, box }) => child.y + box.height));
      const result = { width: Math.max(768, right + GROUP_INSET.x * 2), height: Math.max(408, bottom + GROUP_INSET.y + GROUP_FOOTER) };
      sizes.set(node.id, result);
      return result;
    };
    const place = (node: CanvasNode) => {
      let x = node.x, y = node.y, depth = 0, parent = node.parentId ? byId.get(node.parentId) : undefined;
      for (const seen = new Set<string>(); parent && !seen.has(parent.id); parent = parent.parentId ? byId.get(parent.parentId) : undefined) { seen.add(parent.id); x += parent.x + GROUP_INSET.x; y += parent.y + GROUP_INSET.y; depth++; }
      return { x: Math.round(x), y: Math.round(y), depth };
    };
    const placed = nodes.map(node => ({ node, ...place(node), ...size(node) }));
    const board = {
      // Groups first and outermost first, so Obsidian draws them behind their blocks.
      nodes: placed.sort((a, b) => Number(b.node.kind === 'group') - Number(a.node.kind === 'group') || a.depth - b.depth).map(({ node, x, y, width, height }) => {
        const entry = record.files[node.id];
        if (node.kind === 'group') return { id: node.id, type: 'group', label: node.title, x, y, width, height };
        if (entry && !entry.removed) return { id: node.id, type: 'file', file: entry.path, x, y, width, height };
        return { id: node.id, type: 'text', text: `**${node.title}**${node.description ? `\n\n${node.description}` : ''}`, x, y, width, height };
      }),
      edges: project.canvas.connections.map(connection => ({ id: connection.id, fromNode: connection.source, toNode: connection.target, ...(connection.sourceHandle ? { fromSide: connection.sourceHandle } : {}),
        ...(connection.targetHandle ? { toSide: connection.targetHandle } : {}), ...(connection.label ? { label: connection.label } : {}) })),
    };
    const name = `${safeFileBase(project.title)}.canvas`;
    this.writeIfChanged(files, name, Buffer.from(`${JSON.stringify(board, null, 1)}\n`, 'utf8'));
    record.board = name;
  }

  /** Moves a file out of the way. Changed files and block files go to .ros-ai/trash; unchanged outputs ros.ai can write again are deleted. */
  private retire(files: FolderFiles, rel: string, agreed: string, keep: boolean): string | null {
    const info = files.stat(rel);
    if (!info) return null;
    if (!info.isFile()) throw new StoreError(`${rel} is no longer a normal file, so ros.ai left it alone.`);
    if (!keep) {
      try { if (files.read(rel, READ_BYTES.figure).observed.hash === agreed) { files.remove(rel); return null; } } catch { /* kept in the trash below */ }
    }
    const target = this.freePath(files, posix.join(TRASH, now().slice(0, 10), posix.dirname(rel)), stemOf(rel), extensionOf(rel), new Set());
    files.move(rel, target);
    return target;
  }
  private freePath(files: FolderFiles, folder: string, base: string, extension: string, taken: ReadonlySet<string>, self?: string): string {
    for (let index = 1; index < 1000; index++) {
      const candidate = posix.join(folder, `${index === 1 ? base : `${base} ${index}`}${extension}`);
      if (self && candidate.toLowerCase() === self.toLowerCase()) return candidate;
      if (!taken.has(candidate.toLowerCase()) && !files.exists(candidate)) return candidate;
    }
    throw new StoreError(`Too many files in ${folder} are named ${base}.`);
  }
}

function kindForFile(path: string, blockType?: string): FolderFileKind {
  if (blockType === 'report') return 'report';
  if (blockType === 'figure') return 'figure';
  const kind = unplacedKind(path);
  return kind === 'pdf' || kind === 'image' || blockType === 'file' ? 'file' : kind ?? 'note';
}
const pick = (info: Stats) => ({ mtimeMs: info.mtimeMs, size: info.size });

export function attachProjectFolderRoutes(app: Express, folders: ProjectFolders): void {
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u), path = z.string().trim().min(1).max(4000);
  app.get('/api/folders/suggest', (req, res) => res.json(folders.suggest(z.string().max(200).default('').parse(req.query.name))));
  app.post('/api/folders/choose', async (req, res) => res.json(await folders.choose(z.object({ path: z.string().max(4000).optional() }).strict().parse(req.body ?? {}).path)));
  app.post('/api/folders/open', (req, res) => res.status(201).json(folders.openFolder(z.object({ path }).strict().parse(req.body).path)));
  app.get('/api/projects/:id/folder', (req, res) => res.json(folders.status(id.parse(req.params.id))));
  app.post('/api/projects/:id/folder', (req, res) => res.json(folders.attach(id.parse(req.params.id), z.object({ path }).strict().parse(req.body).path)));
  app.post('/api/projects/:id/folder/open', async (req, res) => {
    const body = z.object({ nodeId: id.optional(), with: z.string().max(40).default('default') }).strict().parse(req.body ?? {});
    res.json(await folders.open(id.parse(req.params.id), body.nodeId, body.with));
  });
  app.get('/api/open-apps', (_req, res) => res.json(folders.apps()));
  app.post('/api/projects/:id/folder/restore', (req, res) => res.json(folders.restore(id.parse(req.params.id), z.object({ nodeId: id }).strict().parse(req.body).nodeId)));
  app.post('/api/projects/:id/folder/add', async (req, res) => res.status(201).json(await folders.addFile(id.parse(req.params.id), z.object({ path: z.string().min(1).max(1000) }).strict().parse(req.body).path)));
  // A dropped or chosen PDF or image, saved into files/ so a File block can show it. The body is the file itself.
  app.post('/api/projects/:id/folder/files', express.raw({ type: () => true, limit: FILE_BYTES }), (req, res) => {
    const name = z.string().trim().min(1).max(255).parse(req.query.name);
    if (!Buffer.isBuffer(req.body)) throw new StoreError('Send the file as the request body.');
    res.status(201).json(folders.saveFile(id.parse(req.params.id), name, req.body));
  });
  // The file a File block shows, read from the project folder on every request. Browsers cache it by its content hash.
  app.get('/api/projects/:id/nodes/:nodeId/file', (req, res) => {
    const file = folders.fileOf(id.parse(req.params.id), id.parse(req.params.nodeId));
    const tag = file.hash ? `"${file.hash.slice(0, 32)}"` : undefined;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (tag) { res.setHeader('ETag', tag); if (req.headers['if-none-match'] === tag) { res.status(304).end(); return; } }
    res.setHeader('Content-Type', file.mediaType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    const stream = createReadStream(file.absolute);
    stream.on('error', () => { if (!res.headersSent) res.status(404); res.end(); });
    stream.pipe(res);
  });
}
