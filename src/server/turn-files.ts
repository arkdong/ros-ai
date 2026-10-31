import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Store } from './store.js';
import { StoreError } from './store.js';
import { projectFolderRoot } from './project-folders.js';
import type { TurnFileChange, TurnFiles } from '../shared/turn-files.js';

/** What a turn changed in the project folder: the folder is looked at when the turn starts and again when it ends, and
 * the difference is kept with the turn, with a saved diff for each text file. It sees every change, by the agent, by
 * ros.ai accepting a change, or by anything else at the same time; it is detection, not a lock. */

/** Folders never looked into: hidden ones (.git, .ros-ai) and the usual heavy, generated ones. */
const SKIPPED = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'site-packages', 'dist', 'build', 'target']);
const MAX_FILES = 5000;
/** Larger files count as changed by size and time only. */
const HASH_BYTES = 2_000_000;
/** Text files up to this size keep their text, so a diff can be made. */
const TEXT_BYTES = 512_000;
/** All the text one look keeps, at most. */
const TEXT_TOTAL = 32_000_000;
/** Changes listed on a turn; the rest are counted. */
const LISTED = 200;
/** All saved diffs of one turn, at most. */
const PATCH_TOTAL = 400_000;
const CONTEXT = 3;

type Entry = { size: number; mtimeMs: number; hash: string; text?: string };
type Snapshot = { files: Map<string, Entry>; partial: boolean };
type Saved = { turnId: string; projectId: string; patches: Record<string, string> };

const textOf = (buffer: Buffer) => {
  if (buffer.includes(0)) return undefined;
  const text = buffer.toString('utf8');
  return text.includes('�') ? undefined : text;
};

async function look(root: string, before?: Snapshot): Promise<Snapshot> {
  const files = new Map<string, Entry>();
  let partial = false, kept = 0;
  const walk = async (folder: string): Promise<void> => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.size >= MAX_FILES) { partial = true; return; }
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      const name = relative(root, path).split(sep).join('/');
      let info;
      try { info = await stat(path); } catch { continue; }
      const earlier = before?.files.get(name);
      // Unchanged size and time: the earlier look stands, without reading the file again.
      if (earlier && earlier.size === info.size && earlier.mtimeMs === info.mtimeMs) { files.set(name, earlier); kept += earlier.text?.length ?? 0; continue; }
      if (info.size > HASH_BYTES) { files.set(name, { size: info.size, mtimeMs: info.mtimeMs, hash: `${info.size}:${info.mtimeMs}` }); continue; }
      let buffer: Buffer;
      try { buffer = await readFile(path); } catch { continue; }
      const text = buffer.length <= TEXT_BYTES && kept + buffer.length <= TEXT_TOTAL ? textOf(buffer) : undefined;
      if (text !== undefined) kept += text.length;
      files.set(name, { size: info.size, mtimeMs: info.mtimeMs, hash: createHash('sha1').update(buffer).digest('hex'), ...(text !== undefined ? { text } : {}) });
    }
  };
  await walk(root);
  return { files, partial };
}

const lines = (text: string) => { if (!text) return []; const split = text.split('\n'); if (split.at(-1) === '') split.pop(); return split; };

/** The line edits from a to b (Myers): ' ' kept, '-' removed, '+' added. undefined when the files differ too much to
 * compare quickly. */
export function lineEdits(a: string[], b: string[], limit = 4000): { op: ' ' | '-' | '+'; line: string }[] | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x0 = a.slice(start, endA), y0 = b.slice(start, endB), n = x0.length, m = y0.length, max = n + m;
  const middle: { op: ' ' | '-' | '+'; line: string }[] = [];
  if (n === 0 || m === 0) { for (const line of x0) middle.push({ op: '-', line }); for (const line of y0) middle.push({ op: '+', line }); }
  else {
    const offset = max + 1, v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= Math.min(max, limit); d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && x0[x] === y0[y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
      if (found >= 0) break;
    }
    if (found < 0) return undefined;
    let x = n, y = m;
    for (let d = found; d > 0; d--) {
      const previous = trace[d], k = x - y;
      const down = k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]);
      const prevK = down ? k + 1 : k - 1, prevX = previous[offset + prevK], prevY = prevX - prevK;
      while (x > prevX && y > prevY) { middle.push({ op: ' ', line: x0[x - 1] }); x--; y--; }
      if (down) { middle.push({ op: '+', line: y0[y - 1] }); y--; } else { middle.push({ op: '-', line: x0[x - 1] }); x--; }
    }
    while (x > 0 && y > 0) { middle.push({ op: ' ', line: x0[x - 1] }); x--; y--; }
    middle.reverse();
  }
  return [...a.slice(0, start).map(line => ({ op: ' ' as const, line })), ...middle, ...a.slice(endA).map(line => ({ op: ' ' as const, line }))];
}

/** A unified diff of the edits, three lines of context around each change. */
export function unifiedPatch(path: string, status: TurnFileChange['status'], edits: { op: ' ' | '-' | '+'; line: string }[]) {
  const out = [`--- ${status === 'added' ? '/dev/null' : `a/${path}`}`, `+++ ${status === 'deleted' ? '/dev/null' : `b/${path}`}`];
  const changed = edits.map((edit, index) => edit.op === ' ' ? -1 : index).filter(index => index >= 0);
  let i = 0;
  while (i < changed.length) {
    let from = Math.max(0, changed[i] - CONTEXT), to = Math.min(edits.length, changed[i] + CONTEXT + 1);
    while (i + 1 < changed.length && changed[i + 1] - CONTEXT <= to) { i++; to = Math.min(edits.length, changed[i] + CONTEXT + 1); }
    let oldLine = 1, newLine = 1;
    for (let j = 0; j < from; j++) { if (edits[j].op !== '+') oldLine++; if (edits[j].op !== '-') newLine++; }
    const hunk = edits.slice(from, to), oldCount = hunk.filter(edit => edit.op !== '+').length, newCount = hunk.filter(edit => edit.op !== '-').length;
    out.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`, ...hunk.map(edit => edit.op + edit.line));
    i++; from = to;
  }
  return out.join('\n');
}

export class TurnFileService {
  private readonly baselines = new Map<string, { projectId: string; root: string; snapshot: Snapshot }>();
  constructor(private readonly store: Store) {}

  /** Looks at the project folder as the turn starts. A project with no folder has nothing to compare. */
  async begin(projectId: string, turnId: string) {
    if (this.baselines.has(turnId)) return;
    const root = projectFolderRoot(this.store, projectId);
    if (!root) return;
    try { this.baselines.set(turnId, { projectId, root, snapshot: await look(root) }); } catch { /* Nothing to compare; the turn goes on. */ }
  }
  has(turnId: string) { return this.baselines.has(turnId); }
  forget(turnId: string) { this.baselines.delete(turnId); }

  /** Looks again and keeps the difference with the turn. keep: the turn may change more later (an agent from outside
   * ros.ai), so the start stays the baseline. Returns nothing when the turn had no baseline. */
  async finish(turnId: string, options: { overlap?: boolean; keep?: boolean } = {}): Promise<TurnFiles | undefined> {
    const baseline = this.baselines.get(turnId);
    if (!baseline) return undefined;
    if (!options.keep) this.baselines.delete(turnId);
    const before = baseline.snapshot, after = await look(baseline.root, before);
    const changes: TurnFileChange[] = [], patches: Record<string, string> = {};
    let patchBytes = 0;
    const names = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
    for (const path of names) {
      const old = before.files.get(path), now = after.files.get(path);
      // A file past the limit of the first look and seen only in the second is not new.
      if (!old && before.partial) continue;
      if (old && !now && after.partial) continue;
      if (old && now && old.hash === now.hash) continue;
      const status: TurnFileChange['status'] = !old ? 'added' : !now ? 'deleted' : 'modified';
      const oldText = old ? old.text : '', newText = now ? now.text : '';
      if (oldText === undefined || newText === undefined) { changes.push({ path, status, added: 0, removed: 0, binary: true }); continue; }
      const edits = lineEdits(lines(oldText), lines(newText));
      if (!edits) { changes.push({ path, status, added: lines(newText).length, removed: lines(oldText).length }); continue; }
      const added = edits.filter(edit => edit.op === '+').length, removed = edits.filter(edit => edit.op === '-').length;
      const patch = unifiedPatch(path, status, edits);
      const fits = patchBytes + patch.length <= PATCH_TOTAL;
      if (fits) { patches[path] = patch; patchBytes += patch.length; }
      changes.push({ path, status, added, removed, ...(fits ? { patch: true } : {}) });
    }
    this.store.saveRecord<Saved>('turn-file-diff', turnId, baseline.projectId, { turnId, projectId: baseline.projectId, patches });
    return { changed: changes.slice(0, LISTED), ...(changes.length > LISTED ? { more: changes.length - LISTED } : {}), ...(options.overlap ? { overlap: true } : {}), ...(before.partial || after.partial ? { partial: true } : {}), at: new Date().toISOString() };
  }

  /** The saved diff of one file the turn changed. */
  diff(projectId: string, turnId: string, path: string) {
    const saved = this.store.record<Saved>('turn-file-diff', turnId);
    if (!saved || saved.projectId !== projectId) throw new StoreError('This turn has no saved changes.', 404);
    const patch = Object.hasOwn(saved.patches, path) ? saved.patches[path] : undefined;
    if (patch === undefined) throw new StoreError('No saved diff for this file.', 404);
    return { path, patch };
  }

  /** Shows a file the turn changed in Finder (Explorer, the file manager), or its folder when the file is gone. Only a
   * path the turn recorded, inside the project folder. */
  reveal(projectId: string, turnId: string, path: string, changed: TurnFileChange[]) {
    const root = projectFolderRoot(this.store, projectId);
    if (!root) throw new StoreError('This project has no folder on disk.', 404);
    const entry = changed.find(item => item.path === path);
    if (!entry) throw new StoreError('This turn did not change that file.', 404);
    const target = resolve(root, path);
    if (!target.startsWith(resolve(root) + sep)) throw new StoreError('That file is outside the project folder.', 400);
    const gone = entry.status === 'deleted';
    const [command, args] = process.platform === 'darwin' ? ['/usr/bin/open', gone ? [dirname(target)] : ['-R', target]]
      : process.platform === 'win32' ? ['explorer.exe', [gone ? dirname(target) : `/select,${target}`]] : ['xdg-open', [dirname(target)]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
    return { path: target };
  }
}
