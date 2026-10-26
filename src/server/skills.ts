import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import { projectFolderRoot } from './project-folders.js';
import { SKILL_LIMITS, SKILL_NAME, SKILL_SOURCES, normalizeName, skillTitle, type FoundSkill, type SkillCandidate, type SkillChoice, type SkillDetail, type SkillOrigin, type SkillPreview, type SkillSourceListing, type SkillsState, type SkillSummary } from '../shared/skills.js';
import { checkLimits, describeFiles, fileKind, groupSkills, ignoredFile, isText, parseSkillMd, readZip, safeRelative, skillDigest, splitFrontmatter, updateSkillMd, writeSkillMd, type ParsedSkill } from './skill-format.js';

/** The person's skill library: one folder per skill under the app data folder, the same SKILL.md format
 * Claude Code and Codex use, and a record of where each came from and whether it is on. Every agent in
 * ros.ai reads skills through here, so they all see the same ones, and every skill added from elsewhere
 * is shown in full before it is kept. Skill scripts are stored as files: nothing here runs them. */

type Files = { path: string; data: Buffer }[];
type SkillRecord = { enabled: boolean; origin: SkillOrigin; addedAt: string };
type Entry = { name: string; dir: string; parsed: ParsedSkill | null; error?: string; files: { path: string; bytes: number }[]; updatedAt: string };
type Collected = { items?: { candidate: SkillCandidate; files: Files }[]; choices?: SkillChoice[]; note?: string };
type Tree = { commit: string; blobs: { path: string; size: number }[] };

const NAMESPACE = 'skills';
const now = () => new Date().toISOString();
const DRAFT_MS = 30 * 60_000, SOURCE_MS = 6 * 3600_000, PAGE = 12_000, CALLED = 30_000, CATALOGUE = 8_000;
/** Other tools' personal skill folders, where the Agent Skills tools keep them. */
const TOOL_FOLDERS: { tool: string; label: string; path: string }[] = [
  { tool: 'claude-code', label: 'Claude Code', path: '.claude/skills' },
  { tool: 'codex', label: 'Codex', path: '.codex/skills' },
  { tool: 'agents', label: 'Codex and other agents', path: '.agents/skills' },
  { tool: 'opencode', label: 'OpenCode', path: '.config/opencode/skills' },
  { tool: 'gemini', label: 'Gemini CLI', path: '.gemini/skills' },
  { tool: 'cursor', label: 'Cursor', path: '.cursor/skills' },
  { tool: 'copilot', label: 'GitHub Copilot', path: '.copilot/skills' },
  { tool: 'goose', label: 'Goose', path: '.config/goose/skills' },
  { tool: 'windsurf', label: 'Windsurf', path: '.codeium/windsurf/skills' },
];
/** A project's own skills, in the folders agents read inside a repository. */
const PROJECT_FOLDERS = ['.claude/skills', '.agents/skills', '.opencode/skills', '.gemini/skills'];
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1?\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/iu;

const nameSchema = z.string().regex(SKILL_NAME).max(SKILL_LIMITS.name);
const createSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(SKILL_LIMITS.description), body: z.string().max(SKILL_LIMITS.skillMd) }).strict();
const updateSchema = z.object({ enabled: z.boolean().optional(), description: z.string().trim().min(1).max(SKILL_LIMITS.description).optional(), body: z.string().max(SKILL_LIMITS.skillMd).optional() }).strict();
const previewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(SKILL_LIMITS.skillMd), name: z.string().trim().max(200).optional(), description: z.string().trim().max(SKILL_LIMITS.description).optional() }).strict(),
  z.object({ kind: z.literal('link'), url: z.string().trim().min(3).max(2000), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u).optional() }).strict(),
  z.object({ kind: z.literal('github'), repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u), ref: z.string().trim().min(1).max(200).optional(), path: z.string().max(1000).optional() }).strict(),
  z.object({ kind: z.literal('file'), filename: z.string().trim().min(1).max(300), data: z.string().max(Math.ceil(SKILL_LIMITS.archive * 4 / 3) + 8) }).strict(),
  z.object({ kind: z.literal('found'), key: z.string().regex(/^[a-f0-9]{16}$/u) }).strict(),
]);
const installSchema = z.object({ draftId: z.string().uuid(), names: z.array(nameSchema).max(50).optional(), replace: z.boolean().default(false) }).strict();
const openSchema = z.object({ name: nameSchema.optional() }).strict();
const useSchema = z.object({ name: z.string().trim().max(200).optional(), file: z.string().trim().max(500).optional(), offset: z.number().int().min(0).default(0) }).strict();
export type SkillUse = z.infer<typeof useSchema>;
export const skillUseSchema = useSchema;

const inside = (root: string, target: string) => { const rel = relative(root, target); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const escape = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const raw = (repo: string, commit: string, path: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const at = next++; out[at] = await work(items[at]!); } }));
  return out;
}
/** Leading "/name" words of a message: the skills the person called by name. */
export function calledSkills(message: string): string[] {
  const lead = /^\s*((?:\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\s+|$))+)/u.exec(message)?.[1] ?? '';
  return [...new Set(lead.split(/\s+/u).filter(Boolean).map(word => word.slice(1)))];
}

export class SkillLibrary {
  readonly folder: string;
  private readonly drafts = new Map<string, { at: number; items: { candidate: SkillCandidate; files: Files }[] }>();
  private readonly trees = new Map<string, Tree>();
  private found = new Map<string, { dir: string; tool: string; label: string }>();
  private readonly fetcher: typeof fetch;
  constructor(private readonly store: Store, dataDir: string, private readonly options: { home?: string; fetch?: typeof fetch; githubToken?: () => string | undefined } = {}) {
    this.folder = join(dataDir, 'skills');
    this.fetcher = options.fetch ?? fetch;
  }

  private records(): Record<string, SkillRecord> { return this.store.globalRecord<Record<string, SkillRecord>>(NAMESPACE, 'state') ?? {}; }
  private saveRecords(records: Record<string, SkillRecord>) { this.store.saveGlobalRecord(NAMESPACE, 'state', records); }

  /** A folder's files, without following links out of it or reading hidden and system files. */
  private walk(dir: string): { path: string; real: string; bytes: number }[] {
    const root = realpathSync(dir), out: { path: string; real: string; bytes: number }[] = [];
    const visit = (folder: string, depth: number) => {
      for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || ignoredFile(entry.name)) continue;
        const path = join(folder, entry.name);
        let real: string;
        try { real = realpathSync(path); } catch { continue; }
        if (!inside(root, real)) continue;
        const info = statSync(real);
        if (info.isDirectory()) { if (depth < 8) visit(path, depth + 1); continue; }
        if (!info.isFile()) continue;
        if (out.length >= SKILL_LIMITS.files * 2) throw new StoreError(`This skill holds more than ${SKILL_LIMITS.files} files.`);
        out.push({ path: relative(dir, path).split(sep).join('/'), real, bytes: info.size });
      }
    };
    visit(dir, 0);
    return out;
  }
  private files(dir: string): Files {
    const listed = this.walk(dir);
    if (listed.length > SKILL_LIMITS.files) throw new StoreError(`This skill holds more than ${SKILL_LIMITS.files} files.`);
    const big = listed.find(file => file.bytes > SKILL_LIMITS.fileBytes);
    if (big) throw new StoreError(`${big.path} is larger than 2 MB.`);
    if (listed.reduce((sum, file) => sum + file.bytes, 0) > SKILL_LIMITS.bytes) throw new StoreError('This skill is larger than 10 MB.');
    return listed.map(file => ({ path: file.path, data: readFileSync(file.real) }));
  }

  /** Every skill folder in the library, read from disk each time so a hand edit counts at once. */
  private entries(): Entry[] {
    if (!existsSync(this.folder)) return [];
    const out: Entry[] = [];
    for (const item of readdirSync(this.folder, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.') || !SKILL_NAME.test(item.name)) continue;
      const dir = join(this.folder, item.name), path = join(dir, 'SKILL.md');
      if (!existsSync(path)) continue;
      try {
        const files = this.walk(dir).map(file => ({ path: file.path, bytes: file.bytes })), updatedAt = statSync(path).mtime.toISOString();
        const parsed = parseSkillMd(readFileSync(path, 'utf8'), item.name);
        out.push('error' in parsed ? { name: item.name, dir, parsed: null, error: parsed.error, files, updatedAt } : { name: item.name, dir, parsed, files, updatedAt });
      } catch (error) { out.push({ name: item.name, dir, parsed: null, error: error instanceof Error ? error.message : 'This skill could not be read.', files: [], updatedAt: now() }); }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  private summary(entry: Entry, record = this.records()[entry.name]): SkillSummary {
    const parsed = entry.parsed;
    return {
      name: entry.name, title: skillTitle(entry.name), description: parsed?.description ?? 'This SKILL.md could not be read.', enabled: Boolean(parsed) && (record?.enabled ?? true),
      automatic: parsed?.automatic ?? false, menu: parsed?.menu ?? false, origin: record?.origin ?? { kind: 'found' }, ...(parsed?.license ? { license: parsed.license } : {}),
      files: entry.files.length, scripts: entry.files.filter(file => fileKind(file.path) === 'script').length, bytes: entry.files.reduce((sum, file) => sum + file.bytes, 0),
      addedAt: record?.addedAt ?? entry.updatedAt, updatedAt: entry.updatedAt, warnings: entry.error ? [entry.error] : parsed?.warnings ?? [],
    };
  }
  private entry(name: string): Entry {
    const found = this.entries().find(item => item.name === nameSchema.parse(name));
    if (!found) throw new StoreError(`There is no skill called ${name}.`, 404);
    return found;
  }

  state(): SkillsState { const records = this.records(); return { skills: this.entries().map(entry => this.summary(entry, records[entry.name])), folder: this.folder }; }
  get(name: string): SkillDetail {
    const entry = this.entry(name), files = this.files(entry.dir);
    return { ...this.summary(entry), body: entry.parsed?.body ?? '', ...(entry.parsed?.compatibility ? { compatibility: entry.parsed.compatibility } : {}), fileList: describeFiles(files), folder: entry.dir };
  }
  /** One file of a skill as text, for its page; on or off. */
  file(name: string, path: unknown): { path: string; bytes: number; text?: string } {
    const entry = this.entry(name), wanted = z.string().max(500).parse(path), clean = safeRelative(wanted);
    const listed = clean ? this.walk(entry.dir).find(file => file.path === clean) : undefined;
    if (!listed) throw new StoreError(`The skill ${entry.name} has no file called ${wanted.slice(0, 200)}.`, 404);
    const data = readFileSync(listed.real);
    return { path: listed.path, bytes: data.length, ...(isText(data) ? { text: data.toString('utf8') } : {}) };
  }
  create(body: unknown): SkillDetail {
    const value = createSchema.parse(body), name = normalizeName(value.name);
    if (existsSync(join(this.folder, name))) throw new StoreError(`A skill called ${name} already exists.`, 409);
    this.write(name, [{ path: 'SKILL.md', data: Buffer.from(writeSkillMd({ name, description: value.description }, value.body)) }], { kind: 'written' }, false);
    return this.get(name);
  }
  update(name: string, body: unknown): SkillDetail {
    const value = updateSchema.parse(body), entry = this.entry(name), records = this.records();
    if (value.description !== undefined || value.body !== undefined) {
      const path = join(entry.dir, 'SKILL.md');
      writeFileSync(path, updateSkillMd(readFileSync(path, 'utf8'), { description: value.description, body: value.body }));
    }
    if (value.enabled !== undefined) { records[entry.name] = { ...(records[entry.name] ?? { origin: { kind: 'found' }, addedAt: entry.updatedAt }), enabled: value.enabled }; this.saveRecords(records); }
    return this.get(entry.name);
  }
  remove(name: string): SkillsState {
    const entry = this.entry(name), records = this.records();
    rmSync(entry.dir, { recursive: true, force: true });
    delete records[entry.name]; this.saveRecords(records);
    return this.state();
  }
  /** Shows the library, or one skill's folder, in the computer's file browser. */
  open(body: unknown): { path: string } {
    const { name } = openSchema.parse(body ?? {});
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const path = name ? this.entry(name).dir : this.folder;
    const [command, args] = process.platform === 'win32' ? ['explorer', [path]] : process.platform === 'darwin' ? ['/usr/bin/open', [path]] : ['xdg-open', [path]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return { path };
  }

  /** Writes a skill's files beside the library and then moves them in, so a failed write leaves nothing half done. */
  private write(name: string, files: Files, origin: SkillOrigin, replace: boolean) {
    nameSchema.parse(name);
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const target = join(this.folder, name), staging = join(this.folder, `.adding-${randomUUID()}`);
    try {
      for (const file of files) {
        const path = safeRelative(file.path);
        if (!path) throw new StoreError(`${file.path} is not a path inside the skill.`);
        mkdirSync(dirname(join(staging, ...path.split('/'))), { recursive: true });
        writeFileSync(join(staging, ...path.split('/')), file.data, { mode: 0o600 });
      }
      if (existsSync(target)) {
        if (!replace) throw new StoreError(`A skill called ${name} already exists.`, 409);
        const old = join(this.folder, `.removing-${randomUUID()}`);
        renameSync(target, old); renameSync(staging, target); rmSync(old, { recursive: true, force: true });
      } else renameSync(staging, target);
    } finally { rmSync(staging, { recursive: true, force: true }); }
    const records = this.records();
    records[name] = { enabled: records[name]?.enabled ?? true, origin, addedAt: now() };
    this.saveRecords(records);
  }

  /** Whether the library holds this skill already, and whether it has the same files. */
  private existing(name: string, files: Files): SkillCandidate['existing'] {
    const dir = join(this.folder, name);
    if (!existsSync(join(dir, 'SKILL.md'))) return null;
    try { return skillDigest(this.files(dir)) === skillDigest(files) ? 'same' : 'different'; } catch { return 'different'; }
  }
  private candidate(all: Files, origin: SkillOrigin, folder?: string): { candidate: SkillCandidate; files: Files } {
    // Hidden files (.git, .env, .DS_Store) are left out, as the library never reads them.
    const files = all.filter(file => !file.path.split('/').some(part => part.startsWith('.')));
    const skill = files.find(file => file.path === 'SKILL.md');
    if (!skill) throw new StoreError('There is no SKILL.md here, so this is not a skill.');
    if (skill.data.length > SKILL_LIMITS.skillMd) throw new StoreError('This SKILL.md is larger than 256 KB.');
    try { checkLimits(files); } catch (error) { throw new StoreError(error instanceof Error ? error.message : 'This skill is too large.'); }
    const source = skill.data.toString('utf8'), parsed = parseSkillMd(source, folder);
    if ('error' in parsed) throw new StoreError(parsed.error);
    const listed = describeFiles(files), scripts = listed.filter(file => file.kind === 'script').length, warnings = [...parsed.warnings];
    if (scripts) warnings.push(`It has ${scripts === 1 ? 'a script' : `${scripts} scripts`}. Agents in ros.ai can read ${scripts === 1 ? 'it' : 'them'} but cannot run ${scripts === 1 ? 'it' : 'them'}.`);
    if (parsed.license && /proprietar|all rights reserved|not open/iu.test(parsed.license)) warnings.push('Its licence is not open source; keep it for your own use.');
    return { files, candidate: {
      name: parsed.name, title: skillTitle(parsed.name), description: parsed.description, ...(parsed.license ? { license: parsed.license } : {}), ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
      files: listed, bytes: files.reduce((sum, file) => sum + file.data.length, 0), scripts, skillMd: source, warnings, existing: this.existing(parsed.name, files), origin,
    } };
  }

  /** Reads a skill from text, a link, a file or another tool's folder and keeps it for review; nothing is added yet. */
  async preview(body: unknown): Promise<SkillPreview> {
    const request = previewSchema.parse(body);
    let collected: Collected;
    if (request.kind === 'text') collected = { items: [this.fromText(request.text, { kind: 'pasted' }, request.name, request.description)] };
    else if (request.kind === 'file') collected = this.fromFile(request.filename, Buffer.from(request.data, 'base64'));
    else if (request.kind === 'found') collected = this.fromFound(request.key);
    else if (request.kind === 'github') collected = await this.fromGithub(request.repo, request.ref, request.path);
    else collected = await this.fromLink(request.url, request.digest);
    const items = collected.items ?? [];
    if (!items.length) return { draftId: null, candidates: [], choices: collected.choices ?? [], ...(collected.note ? { note: collected.note } : {}) };
    for (const [id, draft] of this.drafts) if (Date.now() - draft.at > DRAFT_MS) this.drafts.delete(id);
    while (this.drafts.size >= 20) this.drafts.delete(this.drafts.keys().next().value!);
    const draftId = randomUUID();
    this.drafts.set(draftId, { at: Date.now(), items });
    return { draftId, candidates: items.map(item => item.candidate), choices: [], ...(collected.note ? { note: collected.note } : {}) };
  }
  /** Adds what the person reviewed: exactly the files they saw. */
  install(body: unknown): SkillsState & { added: string[] } {
    const value = installSchema.parse(body), draft = this.drafts.get(value.draftId);
    if (!draft || Date.now() - draft.at > DRAFT_MS) throw new StoreError('This review has expired. Look the skill up again.', 410);
    const chosen = draft.items.filter(item => !value.names || value.names.includes(item.candidate.name));
    if (!chosen.length) throw new StoreError('Choose at least one skill to add.');
    const added: string[] = [];
    for (const item of chosen) {
      const existing = this.existing(item.candidate.name, item.files);
      if (existing === 'same') { added.push(item.candidate.name); continue; }
      if (existing === 'different' && !value.replace) throw new StoreError(`You already have a skill called ${item.candidate.name}. Replace it to use this version.`, 409);
      this.write(item.candidate.name, item.files, item.candidate.origin, value.replace);
      added.push(item.candidate.name);
    }
    this.drafts.delete(value.draftId);
    return { ...this.state(), added };
  }

  private fromText(text: string, origin: SkillOrigin, name?: string, description?: string) {
    const source = text.replace(/\r\n?/gu, '\n');
    if (splitFrontmatter(source).yaml !== null) return this.candidate([{ path: 'SKILL.md', data: Buffer.from(source) }], origin);
    if (!name?.trim() || !description?.trim()) throw new StoreError('This text has no name and description at the top. Give the skill a name and say when agents should use it.');
    return this.candidate([{ path: 'SKILL.md', data: Buffer.from(writeSkillMd({ name: normalizeName(name), description }, source)) }], origin);
  }
  private fromArchive(archive: Buffer, origin: SkillOrigin, stem: string): Collected {
    let files: Files;
    try { files = readZip(archive); } catch (error) { throw new StoreError(error instanceof Error ? error.message : 'This archive could not be read.'); }
    const groups = groupSkills(files);
    if (!groups.length) throw new StoreError('There is no SKILL.md in this archive, so it holds no skill.');
    if (groups.length > 50) throw new StoreError('This archive holds more than 50 skills. Add them in smaller sets.');
    return { items: groups.map(group => this.candidate(group.files, origin, group.root ? group.root.split('/').at(-1) : normalizeName(stem))) };
  }
  private fromFile(filename: string, data: Buffer): Collected {
    const stem = filename.replace(/\.[^.]+$/u, '');
    if (/\.(zip|skill)$/iu.test(filename)) return this.fromArchive(data, { kind: 'file', filename }, stem);
    if (/\.(md|markdown)$/iu.test(filename)) {
      if (!isText(data)) throw new StoreError('This file is not text.');
      return { items: [this.fromText(data.toString('utf8'), { kind: 'file', filename })] };
    }
    throw new StoreError('Choose a SKILL.md, a .zip or a .skill file.');
  }

  /** Skills in other tools' folders on this computer and in project folders, which can be copied in. */
  scan(): FoundSkill[] {
    const home = this.options.home ?? homedir(), roots = TOOL_FOLDERS.map(item => ({ dir: join(home, item.path), tool: item.tool, label: item.label }));
    for (const project of this.store.listProjects()) {
      const root = projectFolderRoot(this.store, project.id);
      if (root) for (const path of PROJECT_FOLDERS) roots.push({ dir: join(root, path), tool: 'project', label: project.title });
    }
    const library = existsSync(this.folder) ? realpathSync(this.folder) : this.folder;
    const seen = new Set<string>(), found = new Map<string, { dir: string; tool: string; label: string }>(), out: FoundSkill[] = [];
    for (const root of roots) {
      let names: string[];
      try { names = readdirSync(root.dir).filter(name => !name.startsWith('.')).sort(); } catch { continue; }
      const dirs: string[] = [];
      for (const name of names) {
        const dir = join(root.dir, name);
        if (existsSync(join(dir, 'SKILL.md'))) { dirs.push(dir); continue; }
        // One level of grouping, as Claude Code's synced/ folder has.
        try { if (statSync(dir).isDirectory()) for (const inner of readdirSync(dir).filter(item => !item.startsWith('.')).sort()) if (existsSync(join(dir, inner, 'SKILL.md'))) dirs.push(join(dir, inner)); } catch { /* unreadable: skip */ }
      }
      for (const dir of dirs) {
        let real: string;
        try { real = realpathSync(dir); } catch { continue; }
        if (seen.has(real) || inside(library, real) || out.length >= 300) continue;
        seen.add(real);
        let parsed: ReturnType<typeof parseSkillMd>;
        try { const source = readFileSync(join(dir, 'SKILL.md')); if (source.length > SKILL_LIMITS.skillMd) continue; parsed = parseSkillMd(source.toString('utf8'), basename(dir)); } catch { continue; }
        if ('error' in parsed) continue;
        const key = createHash('sha256').update(real).digest('hex').slice(0, 16);
        found.set(key, { dir, tool: root.tool, label: root.label });
        let added: FoundSkill['added'] = null;
        if (existsSync(join(this.folder, parsed.name, 'SKILL.md'))) { try { added = this.existing(parsed.name, this.files(dir)); } catch { added = 'different'; } }
        out.push({ key, tool: root.tool, toolLabel: root.label, folder: dir, name: parsed.name, title: skillTitle(parsed.name), description: parsed.description, added });
      }
    }
    this.found = found;
    return out;
  }
  private fromFound(key: string): Collected {
    if (!this.found.has(key)) this.scan();
    const found = this.found.get(key);
    if (!found) throw new StoreError('That skill is no longer in its folder.', 404);
    const home = this.options.home ?? homedir();
    // A folder in the home folder is shown the way people write it: ~/.claude/skills/name.
    const path = found.dir.startsWith(`${home}${sep}`) ? `~${found.dir.slice(home.length)}` : found.dir;
    return { items: [this.candidate(this.files(found.dir), { kind: 'folder', tool: found.label, path }, basename(found.dir))] };
  }

  /** Reads an https address, following redirects only to other public https addresses. */
  private async download(address: string, max: number, headers: Record<string, string> = {}): Promise<{ data: Buffer; type: string; url: string }> {
    let url: URL;
    try { url = new URL(address); } catch { throw new StoreError('That is not a link ros.ai can read.'); }
    // Headers (a GitHub token) go only to the host they were meant for, never along a redirect elsewhere.
    const host = url.host;
    for (let hop = 0; hop < 5; hop++) {
      if (url.protocol !== 'https:') throw new StoreError('ros.ai reads skills only from https links.');
      if (PRIVATE_HOST.test(url.hostname) || /\.(local|internal|localhost)$/iu.test(url.hostname)) throw new StoreError('ros.ai does not read skills from this computer or a private network.');
      const response = await this.fetcher(url.href, { redirect: 'manual', headers: { 'User-Agent': 'ros.ai', ...(url.host === host ? headers : {}) }, signal: AbortSignal.timeout(30_000) })
        .catch(() => { throw new StoreError(`ros.ai could not reach ${url.hostname}. Check the link and the connection.`, 502); });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) { url = new URL(location, url); continue; }
      if (!response.ok) {
        if (url.hostname === 'api.github.com' && (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'))) throw new StoreError('GitHub allows 60 lookups an hour without an account, and they are used up. Connect GitHub on the Plugins page to raise the limit, or try again within the hour.', 429);
        if (response.status === 404) throw new StoreError(url.hostname === 'api.github.com' ? 'GitHub has no public repository or folder at that link.' : `Nothing was found at ${url.href.slice(0, 200)}.`, 404);
        throw new StoreError(`${url.hostname} answered ${response.status}.`, 502);
      }
      if (Number(response.headers.get('content-length') ?? 0) > max) throw new StoreError(`The file at ${url.hostname} is larger than ros.ai reads for a skill.`);
      const chunks: Buffer[] = [], reader = response.body?.getReader();
      let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { await reader.cancel().catch(() => undefined); throw new StoreError(`The file at ${url.hostname} is larger than ros.ai reads for a skill.`); }
        chunks.push(Buffer.from(value));
      }
      return { data: Buffer.concat(chunks), type: response.headers.get('content-type') ?? '', url: url.href };
    }
    throw new StoreError('The link redirects too many times.');
  }
  private async github<T>(path: string): Promise<T> {
    const token = this.options.githubToken?.();
    const { data } = await this.download(`https://api.github.com${path}`, 40 * 1024 * 1024, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
    return JSON.parse(data.toString('utf8')) as T;
  }
  /** A repository's files at one commit, so everything read for a review comes from the same version. */
  private async tree(repo: string, ref = 'HEAD'): Promise<Tree> {
    const commit = /^[0-9a-f]{40}$/u.test(ref) ? ref : (await this.github<{ sha?: string }>(`/repos/${repo}/commits/${encodeURIComponent(ref)}`)).sha;
    if (!commit) throw new StoreError(`GitHub did not name a commit for ${repo}.`, 502);
    const key = `${repo}@${commit}`, cached = this.trees.get(key);
    if (cached) return cached;
    const value = await this.github<{ tree?: { path: string; type: string; size?: number }[] }>(`/repos/${repo}/git/trees/${commit}?recursive=1`);
    const tree = { commit, blobs: (value.tree ?? []).filter(item => item.type === 'blob' && !ignoredFile(item.path)).map(item => ({ path: item.path, size: item.size ?? 0 })) };
    if (this.trees.size >= 8) this.trees.delete(this.trees.keys().next().value!);
    this.trees.set(key, tree);
    return tree;
  }
  /** Every skill folder under a path of a repository, read from its SKILL.md. */
  private async choices(repo: string, tree: Tree, under: string): Promise<SkillChoice[]> {
    const prefix = under ? `${under}/` : '';
    const paths = tree.blobs.filter(blob => blob.path.startsWith(prefix) && (blob.path === `${prefix}SKILL.md` || blob.path.endsWith('/SKILL.md')) && blob.size <= SKILL_LIMITS.skillMd).map(blob => blob.path).slice(0, 400);
    const found = await pool(paths, 10, async (path): Promise<SkillChoice | null> => {
      const dir = path.slice(0, -'SKILL.md'.length).replace(/\/$/u, '');
      try {
        const { data } = await this.download(raw(repo, tree.commit, path), SKILL_LIMITS.skillMd), parsed = parseSkillMd(data.toString('utf8'), dir.split('/').at(-1) || undefined);
        return 'error' in parsed ? null : { name: parsed.name, title: skillTitle(parsed.name), description: parsed.description, request: { kind: 'github', repo, ref: tree.commit, path: dir } };
      } catch { return null; }
    });
    return found.filter((item): item is SkillChoice => Boolean(item)).sort((a, b) => a.title.localeCompare(b.title));
  }
  private async fromGithub(repo: string, ref: string | undefined, path: string | undefined): Promise<Collected> {
    const tree = await this.tree(repo, ref);
    let dir = (path ?? '').replace(/^\/+|\/+$/gu, '');
    if (dir === 'SKILL.md' || dir.endsWith('/SKILL.md')) dir = dir.slice(0, -'SKILL.md'.length).replace(/\/$/u, '');
    if (dir && !safeRelative(dir)) throw new StoreError('That is not a folder in the repository.');
    if (tree.blobs.some(blob => blob.path === (dir ? `${dir}/SKILL.md` : 'SKILL.md'))) {
      const blobs = tree.blobs.filter(blob => !dir || blob.path.startsWith(`${dir}/`));
      if (blobs.length > SKILL_LIMITS.files) throw new StoreError(`This skill holds more than ${SKILL_LIMITS.files} files.`);
      if (blobs.some(blob => blob.size > SKILL_LIMITS.fileBytes)) throw new StoreError('A file in this skill is larger than 2 MB.');
      if (blobs.reduce((sum, blob) => sum + blob.size, 0) > SKILL_LIMITS.bytes) throw new StoreError('This skill is larger than 10 MB.');
      const files = await pool(blobs, 8, async blob => ({ path: dir ? blob.path.slice(dir.length + 1) : blob.path, data: (await this.download(raw(repo, tree.commit, blob.path), SKILL_LIMITS.fileBytes)).data }));
      return { items: [this.candidate(files, { kind: 'github', repo, ref: ref ?? 'HEAD', commit: tree.commit, path: dir }, dir.split('/').at(-1) || repo.split('/')[1])] };
    }
    const choices = await this.choices(repo, tree, dir);
    if (!choices.length) throw new StoreError(`There are no skills (folders with a SKILL.md) in ${repo}${dir ? `/${dir}` : ''}.`, 404);
    if (choices.length === 1) { const only = choices[0]!.request as { path?: string }; return this.fromGithub(repo, tree.commit, only.path); }
    return { choices, note: `${choices.length} skills in ${repo}${dir ? `/${dir}` : ''}.` };
  }
  private verify(data: Buffer, digest?: string) {
    if (digest && `sha256:${sha256(data)}` !== digest) throw new StoreError('This file does not match the digest its site publishes, so ros.ai did not use it.');
  }
  /** A site's list of skills at /.well-known/agent-skills/index.json (the Agent Skills discovery draft). */
  private async fromIndex(address: string): Promise<Collected> {
    const { data, url } = await this.download(address, 2 * 1024 * 1024);
    let index: { skills?: unknown };
    try { index = JSON.parse(data.toString('utf8')) as { skills?: unknown }; } catch { throw new StoreError('This site\'s skills list is not valid JSON.'); }
    const entries = Array.isArray(index.skills) ? index.skills.slice(0, 400) : [];
    const choices = entries.flatMap((item): SkillChoice[] => {
      const entry = (item && typeof item === 'object' ? item : {}) as { name?: unknown; description?: unknown; url?: unknown; digest?: unknown; files?: unknown };
      if (typeof entry.name !== 'string') return [];
      const name = normalizeName(entry.name);
      const target = typeof entry.url === 'string' ? entry.url : Array.isArray(entry.files) && entry.files.includes('SKILL.md') ? `${name}/SKILL.md` : null;
      if (!target) return [];
      const digest = typeof entry.digest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(entry.digest) ? entry.digest : undefined;
      return [{ name, title: skillTitle(name), description: typeof entry.description === 'string' ? entry.description.slice(0, SKILL_LIMITS.description) : '', request: { kind: 'link', url: new URL(target, url).href, ...(digest ? { digest } : {}) } }];
    });
    if (!choices.length) throw new StoreError('This site lists no skills.', 404);
    if (choices.length === 1) { const only = choices[0]!.request as { url: string; digest?: string }; return this.fromLink(only.url, only.digest); }
    return { choices, note: `${choices.length} skills at ${new URL(url).hostname}.` };
  }
  private async fromLink(text: string, digest?: string): Promise<Collected> {
    const value = text.trim();
    // owner/repo or owner/repo/folder, as the skills CLI takes it.
    const short = /^([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(.+))?$/u.exec(value);
    if (short && !short[1]!.includes('.') && !value.includes(':')) return this.fromGithub(`${short[1]}/${short[2]}`, undefined, short[3]);
    let url: URL;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`); } catch { throw new StoreError('That is not a link ros.ai can read.'); }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (/^(www\.)?github\.com$/iu.test(url.hostname)) {
      const [owner, name, kind, ref, ...rest] = parts;
      if (!owner || !name) throw new StoreError('Link to a GitHub repository, or to a folder in one.');
      const repo = `${owner}/${name.replace(/\.git$/u, '')}`;
      return kind === 'tree' || kind === 'blob' ? this.fromGithub(repo, ref, rest.join('/')) : this.fromGithub(repo, undefined, undefined);
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      const [owner, name, ref, ...rest] = parts;
      if (!owner || !name || !ref) throw new StoreError('Link to a SKILL.md on GitHub.');
      return this.fromGithub(`${owner}/${name}`, ref, rest.join('/'));
    }
    const path = url.pathname.toLowerCase();
    if (/\.(tar\.gz|tgz)$/u.test(path)) throw new StoreError('ros.ai reads skill archives as .zip; this one is .tar.gz.');
    if (/\.(zip|skill)$/u.test(path)) {
      const { data } = await this.download(url.href, SKILL_LIMITS.archive);
      this.verify(data, digest);
      return this.fromArchive(data, { kind: 'link', url: url.href }, basename(url.pathname));
    }
    if (/\.(md|markdown)$/u.test(path)) {
      const { data } = await this.download(url.href, SKILL_LIMITS.skillMd);
      this.verify(data, digest);
      if (!isText(data)) throw new StoreError('That link is not a text file.');
      const folder = parts.at(-1)?.toLowerCase() === 'skill.md' ? parts.at(-2) : undefined;
      return { items: [this.candidate([{ path: 'SKILL.md', data }], { kind: 'link', url: url.href }, folder)] };
    }
    if (path.endsWith('.json')) return this.fromIndex(url.href);
    try { return await this.fromIndex(new URL('/.well-known/agent-skills/index.json', url.origin).href); }
    catch (error) {
      if (error instanceof StoreError && error.status === 404) throw new StoreError('No skill was found there. Link to a SKILL.md, a .zip, a GitHub folder, or a site that lists skills at /.well-known/agent-skills/index.json.', 404);
      throw error;
    }
  }

  /** The skills in one curated source, read at its latest commit and kept for six hours. */
  async source(id: string, refresh = false): Promise<SkillSourceListing> {
    const source = SKILL_SOURCES.find(item => item.id === id);
    if (!source) throw new StoreError('There is no such skill source.', 404);
    const cached = this.store.globalRecord<SkillSourceListing>(NAMESPACE, `source-${id}`);
    if (cached && !refresh && Date.now() - Date.parse(cached.checkedAt) < SOURCE_MS) return cached;
    const tree = await this.tree(source.repo);
    const listing: SkillSourceListing = { source, commit: tree.commit, checkedAt: now(), entries: await this.choices(source.repo, tree, '') };
    this.store.saveGlobalRecord(NAMESPACE, `source-${id}`, listing);
    return listing;
  }

  /** Skills agents may use: on and readable. */
  private usable() { const records = this.records(); return this.entries().filter(entry => entry.parsed && (records[entry.name]?.enabled ?? true)) as (Entry & { parsed: ParsedSkill })[]; }
  /** Whether any skill is on, so the skill tool is offered only when it can do something. */
  any(): boolean { return this.usable().length > 0; }
  /** Names for the / menu of the Ros bar. */
  menu(): { name: string; title: string; description: string }[] { return this.usable().filter(entry => entry.parsed.menu).map(entry => ({ name: entry.name, title: skillTitle(entry.name), description: entry.parsed.description })); }

  /** A skill's instructions as an agent reads them, a page at a time. tool: whether the agent can call
   * ros_use_skill to read on and to open the skill's files. */
  private content(entry: Entry & { parsed: ParsedSkill }, offset = 0, limit = PAGE, tool = true) {
    const body = entry.parsed.body, page = body.slice(offset, offset + limit), others = entry.files.map(file => file.path).filter(path => path !== 'SKILL.md');
    const more = offset + limit < body.length;
    const rest = more ? `\n\n[${tool ? `The instructions continue: call ros_use_skill with name "${entry.name}" and offset ${offset + limit}.` : 'The rest of this skill is too long to show here.'}]` : '';
    const notes = offset > 0 ? '' : `${entry.parsed.compatibility ? `\nCompatibility: ${entry.parsed.compatibility}\n` : ''}${tool && others.length ? `\nFiles in this skill (read one with ros_use_skill and file; scripts cannot run here):\n${others.slice(0, 60).map(path => `- ${path}`).join('\n')}${others.length > 60 ? `\n- and ${others.length - 60} more` : ''}\n` : ''}`;
    return { text: `<skill_content name="${entry.name}">\n${page}${rest}\n${notes}</skill_content>`, more, total: body.length };
  }
  /** The skills the person called with /name at the start of their message, in full, within limit characters
   * in all. tool: whether the agent has ros_use_skill to read the rest and the skill's files. */
  called(message: string, limit = CALLED, tool = true): string | undefined {
    const usable = this.usable(), called = calledSkills(message).flatMap(name => usable.filter(entry => entry.name === name));
    if (!called.length) return undefined;
    const each = Math.max(2_000, Math.floor(limit / called.length));
    return `The researcher called ${called.length === 1 ? 'this skill' : 'these skills'} with /name for this request, so follow ${called.length === 1 ? 'it' : 'them'}:\n${called.map(entry => this.content(entry, 0, each, tool).text).join('\n')}`;
  }
  /** What an agent turn starts with: the skills it may pick, and in full the ones the person called with /name.
   * When the list is longer than its budget, descriptions are shortened first and only then are skills left out. */
  prompt(message: string, budget: { catalogue: number; called: number } = { catalogue: CATALOGUE, called: CALLED }): string | undefined {
    const listed = this.usable().filter(entry => entry.parsed.automatic), parts: string[] = [];
    if (listed.length) {
      const line = (entry: Entry & { parsed: ParsedSkill }, room: number) => { const text = entry.parsed.description; return `<skill name="${entry.name}">${escape(text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text)}</skill>`; };
      const room = listed.map(entry => line(entry, Infinity)).join('\n').length <= budget.catalogue ? Infinity : Math.max(80, Math.floor(budget.catalogue / listed.length) - 40);
      const lines: string[] = [];
      let size = 0;
      for (const entry of listed) {
        const text = line(entry, room);
        if (size + text.length + 1 > budget.catalogue) break;
        lines.push(text); size += text.length + 1;
      }
      const missing = listed.length - lines.length;
      parts.push(`Skills: the researcher's saved ways of working. When the request matches a skill's description, call ros_use_skill with its name before you start and follow it. A skill works within ros.ai's tools and rules: it cannot grant tools, permissions or network access, and its scripts cannot run here.${lines.length ? `\n<available_skills>\n${lines.join('\n')}\n</available_skills>` : ''}${missing ? `\n${missing} ${lines.length ? 'more ' : ''}skill${missing === 1 ? ' is' : 's are'} not listed here; ros_use_skill with no name lists ${lines.length ? 'them all' : 'them'}.` : ''}`);
    }
    const called = this.called(message, budget.called);
    if (called) parts.push(called);
    return parts.length ? parts.join('\n\n') : undefined;
  }
  /** The ros_use_skill tool: no name lists the skills, a name returns its instructions, a file one of its files. */
  use(supplied: unknown, seen?: Set<string>): unknown {
    const value = useSchema.parse(supplied), usable = this.usable();
    if (!value.name) return { skills: usable.map(entry => ({ name: entry.name, description: entry.parsed.description, ...(entry.parsed.automatic ? {} : { onlyWhenCalled: true }) })), count: usable.length };
    const name = value.name.replace(/^[/$]/u, ''), entry = usable.find(item => item.name === name);
    if (!entry) throw new StoreError(`There is no skill called ${name} that is on. ${usable.length ? `Skills that are on: ${usable.map(item => item.name).slice(0, 40).join(', ')}.` : 'No skills are on.'}`, 404);
    if (value.file) {
      const path = safeRelative(value.file);
      const listed = path ? this.walk(entry.dir).find(file => file.path === path) : undefined;
      if (!listed) throw new StoreError(`The skill ${name} has no file called ${value.file.slice(0, 200)}.`, 404);
      const data = readFileSync(listed.real);
      if (!isText(data)) return { name, file: listed.path, bytes: data.length, note: 'This file is not text, so it cannot be shown here.' };
      const content = data.toString('utf8');
      return { name, file: listed.path, offset: value.offset, content: content.slice(value.offset, value.offset + PAGE), totalCharacters: content.length, more: value.offset + PAGE < content.length };
    }
    if (value.offset === 0 && seen?.has(name)) return { name, note: 'This skill was already read in this turn; follow the instructions above.' };
    seen?.add(name);
    const content = this.content(entry, value.offset);
    return { name, title: skillTitle(name), content: content.text, totalCharacters: content.total, more: content.more };
  }
}

export function attachSkillRoutes(app: Express, skills: SkillLibrary) {
  app.get('/api/skills', (_req, res) => res.json(skills.state()));
  app.post('/api/skills', (req, res) => res.status(201).json(skills.create(req.body)));
  app.get('/api/skills/menu', (_req, res) => res.json({ skills: skills.menu() }));
  app.get('/api/skills/found', (_req, res) => res.json({ found: skills.scan() }));
  app.get('/api/skills/sources/:id', async (req, res) => res.json(await skills.source(z.string().max(40).parse(req.params.id), req.query.refresh === '1')));
  app.post('/api/skills/preview', async (req, res) => res.json(await skills.preview(req.body)));
  app.post('/api/skills/install', (req, res) => res.status(201).json(skills.install(req.body)));
  app.post('/api/skills/open', (req, res) => res.json(skills.open(req.body)));
  app.get('/api/skills/skill/:name', (req, res) => res.json(skills.get(req.params.name)));
  app.get('/api/skills/skill/:name/file', (req, res) => res.json(skills.file(req.params.name, req.query.path)));
  app.put('/api/skills/skill/:name', (req, res) => res.json(skills.update(req.params.name, req.body)));
  app.delete('/api/skills/skill/:name', (req, res) => res.json(skills.remove(req.params.name)));
}
