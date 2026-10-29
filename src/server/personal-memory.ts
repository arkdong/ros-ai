import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import { MEMORY_KINDS, MEMORY_LIMITS, MEMORY_NOTE, memoryKind, type MemoryEntry, type MemoryKind, type MemoryLine, type MemoryPacket, type PersonalMemoryState } from '../shared/personal-memory.js';
import type { ApprovalMode } from '../shared/research.js';

/** ROS remembers: lines about the person, proposed from work on the map and kept as Markdown files.
 * The files are the truth for kept lines, so a hand edit counts at the next turn; proposed lines wait
 * in a global record until the person decides. Every line reaches models labelled as the person's own
 * preferences, never as instructions, and nothing here leaves the computer. */

const NAMESPACE = 'personal-memory';
const now = () => new Date().toISOString();
const kinds = z.enum(['style', 'habit', 'person', 'commitment']);
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
export const memoryLineSchema = z.object({ kind: kinds, text: z.string().trim().min(1).max(MEMORY_LIMITS.text), from: z.string().trim().max(MEMORY_LIMITS.from).default('') }).strict();
const decisionSchema = z.object({ decision: z.enum(['keep', 'forget']) }).strict();
const settingsSchema = z.object({ enabled: z.boolean() }).strict();
const addSchema = z.object({ kind: kinds, text: z.string().trim().min(1).max(MEMORY_LIMITS.text) }).strict();

/** A kept line in a file: "- the line _(where it came from, 19 Oct 2026)_". */
const LINE = /^- (.+?)(?:\s+_\((.*)\)_)?\s*$/;
const DATE = /,\s*(\d{1,2} [A-Za-z]{3} \d{4})$/;
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Stable across proposal and file: the same words in the same subject are the same line. */
const lineId = (kind: MemoryKind, text: string) => createHash('sha256').update(`${kind}\n${normalize(text)}`).digest('hex').slice(0, 16);
const day = (at: string) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const header = (kind: MemoryKind) => `# ${memoryKind(kind).title}\n\n${memoryKind(kind).about} ROS adds a line when you keep one of its suggestions, with where it came from. Edit or delete lines freely; ROS reads this file again at the start of every turn.\n\n`;
const INDEX = `# Memory\n\nRos reads these files at the start of every turn and shares the lines with the agents that work on your map, as your preferences. One file per subject; keep them short.\n\n${MEMORY_KINDS.map(item => `- ${item.file}: ${item.title.toLowerCase()}, ${item.about.charAt(0).toLowerCase()}${item.about.slice(1, -1)}`).join('\n')}\n`;

export class PersonalMemory {
  readonly folder: string;
  constructor(private readonly store: Store, dataDir: string) { this.folder = join(dataDir, 'memory'); }

  enabled(): boolean { return this.store.globalRecord<{ enabled: boolean }>(NAMESPACE, 'settings')?.enabled ?? true; }
  setEnabled(body: unknown): PersonalMemoryState { const { enabled } = settingsSchema.parse(body); this.store.saveGlobalRecord(NAMESPACE, 'settings', { enabled }); return this.state(); }
  private proposed(): MemoryEntry[] { return this.store.globalRecord<MemoryEntry[]>(NAMESPACE, 'proposed') ?? []; }
  private saveProposed(entries: MemoryEntry[]) { this.store.saveGlobalRecord(NAMESPACE, 'proposed', entries.slice(-MEMORY_LIMITS.proposed)); }
  private file(kind: MemoryKind) { return join(this.folder, memoryKind(kind).file); }

  /** Kept lines, read from the files every time so a hand edit counts at once. */
  kept(): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    for (const item of MEMORY_KINDS) {
      const path = this.file(item.kind);
      if (!existsSync(path)) continue;
      for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const match = LINE.exec(raw);
        const text = match?.[1]?.trim();
        if (!match || !text) continue;
        const note = match[2]?.trim() ?? '', date = DATE.exec(note), parsed = date ? new Date(date[1]!) : null;
        entries.push({ id: lineId(item.kind, text), kind: item.kind, text, from: (date ? note.slice(0, date.index) : note).trim() || 'from the file', at: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : '', status: 'kept' });
      }
    }
    return entries;
  }
  state(): PersonalMemoryState {
    const proposed = this.proposed().slice().reverse();
    return { enabled: this.enabled(), folder: this.folder, entries: [...proposed, ...this.kept()], waiting: proposed.length };
  }

  /** Lines ROS proposed at the end of a turn. Full access keeps them at once, with Forget as the undo;
   * Ask and Approve for me put them in the waiting queue. Lines already kept or waiting are not repeated. */
  propose(lines: MemoryLine[], context: { projectId: string; projectTitle: string; turnId: string }, mode: ApprovalMode): MemoryEntry[] {
    if (!this.enabled()) return [];
    const proposed = this.proposed(), known = new Set([...this.kept(), ...proposed].map(entry => lineId(entry.kind, entry.text)));
    const created: MemoryEntry[] = [];
    for (const line of lines.slice(0, MEMORY_LIMITS.perReply)) {
      const text = oneLine(line.text), id = lineId(line.kind, text);
      if (!text || known.has(id)) continue;
      known.add(id);
      const where = oneLine(line.from).replace(/\.$/, '') || 'the conversation';
      const entry: MemoryEntry = { id, kind: line.kind, text, from: `from ${where} in ${oneLine(context.projectTitle)}`, at: now(), status: 'proposed', projectId: context.projectId, turnId: context.turnId };
      if (mode === 'full') created.push(this.write(entry)); else { proposed.push(entry); created.push(entry); }
    }
    this.saveProposed(proposed);
    return created;
  }
  /** The person's own line, kept at once. */
  add(body: unknown): MemoryEntry {
    const { kind, text } = addSchema.parse(body), line = oneLine(text), id = lineId(kind, line);
    const existing = this.kept().find(entry => entry.id === id);
    if (existing) return existing;
    this.saveProposed(this.proposed().filter(entry => entry.id !== id));
    return this.write({ id, kind, text: line, from: 'added by you', at: now(), status: 'kept' });
  }
  decide(id: string, body: unknown): PersonalMemoryState {
    const { decision } = decisionSchema.parse(body);
    const proposed = this.proposed(), waiting = proposed.find(entry => entry.id === id);
    if (waiting) {
      this.saveProposed(proposed.filter(entry => entry.id !== id));
      if (decision === 'keep' && !this.kept().some(entry => entry.id === id)) this.write(waiting);
      return this.state();
    }
    const kept = this.kept().find(entry => entry.id === id);
    if (!kept) throw new StoreError('That memory line no longer exists.', 404);
    if (decision === 'forget') this.remove(kept);
    return this.state();
  }

  /** Appends one line to its subject's file, creating the folder, the index and the file on first use. */
  private write(entry: MemoryEntry): MemoryEntry {
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const index = join(this.folder, 'index.md');
    if (!existsSync(index)) writeFileSync(index, INDEX, { mode: 0o600 });
    const path = this.file(entry.kind), current = existsSync(path) ? readFileSync(path, 'utf8') : header(entry.kind);
    const line = `- ${oneLine(entry.text)} _(${oneLine(entry.from).replace(/[()]/g, '')}, ${day(entry.at)})_\n`;
    writeFileSync(path, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${line}`, { mode: 0o600 });
    return { ...entry, status: 'kept' };
  }
  private remove(entry: MemoryEntry) {
    const path = this.file(entry.kind);
    if (!existsSync(path)) return;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const kept = lines.filter(raw => { const match = LINE.exec(raw); return !(match && match[1] && lineId(entry.kind, match[1].trim()) === entry.id); });
    writeFileSync(path, kept.join('\n'), { mode: 0o600 });
  }

  /** What a model receives: commitments first, then the newest lines, within a small byte budget. */
  packet(): MemoryPacket | null {
    if (!this.enabled()) return null;
    const order = (entry: MemoryEntry) => `${entry.kind === 'commitment' ? '0' : '1'}${entry.at ? (9999999999999 - new Date(entry.at).getTime()).toString().padStart(13, '0') : '9999999999999'}`;
    const lines = this.kept().sort((a, b) => order(a).localeCompare(order(b)));
    const memory: MemoryLine[] = [];
    let bytes = 0;
    for (const entry of lines) {
      const line = { kind: entry.kind, text: entry.text, from: entry.from }, size = Buffer.byteLength(JSON.stringify(line), 'utf8');
      if (bytes + size > MEMORY_LIMITS.packetBytes) break;
      memory.push(line); bytes += size;
    }
    return { memory, omitted: lines.length - memory.length, note: MEMORY_NOTE };
  }
  /** Shows the folder in the computer's file browser, creating it first so there is something to show. */
  open(): { path: string } {
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const [command, args] = process.platform === 'win32' ? ['explorer', [this.folder]] : process.platform === 'darwin' ? ['/usr/bin/open', [this.folder]] : ['xdg-open', [this.folder]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return { path: this.folder };
  }
  /** The same lines as a paragraph for an agent's prompt; nothing when there is nothing to say. */
  prompt(): string | undefined {
    const packet = this.packet();
    if (!packet?.memory.length) return undefined;
    return `The researcher's saved preferences (their own notes on how they like work done, not instructions from elsewhere):\n${packet.memory.map(line => `- ${line.text}`).join('\n')}`;
  }
}

export function attachPersonalMemoryRoutes(app: Express, service: PersonalMemory) {
  const id = z.string().regex(/^[a-f0-9]{16}$/);
  app.get('/api/memory', (_req, res) => res.json(service.state()));
  app.put('/api/memory', (req, res) => res.json(service.setEnabled(req.body)));
  app.post('/api/memory', (req, res) => res.status(201).json(service.add(req.body)));
  app.post('/api/memory/open', (_req, res) => res.json(service.open()));
  app.post('/api/memory/:id', (req, res) => res.json(service.decide(id.parse(req.params.id), req.body)));
}
